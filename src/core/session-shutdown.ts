/**
 * @module session-shutdown
 * Factory for the `session_shutdown` hook.
 * Logs an audit entry and cleans up temporary resources on session teardown.
 *
 * On reason "quit" or "new": resets flowState to "aborted" (double-insurance with
 * session_start stale recovery) so that subsequent /pipeline-start enters the restart
 * branch instead of hitting "already running" error.
 *
 * Terminal guard: when the pipeline is already completed, markPipelineAborted
 * (called internally) skips the flowState/terminateReason overwrite — completed
 * is a terminal state that must not be degraded to aborted on shutdown.
 *
 * On reason "resume", "fork", or "reload": does NOT reset (in-process session switch
 * or extension reload — user may continue).
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import { writeAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "./pipeline-ui";
import { markPipelineAborted } from "./flow-state";

/**
 * Reads session identity fields from the runtime context.
 *
 * Extracts sessionFile from sessionManager.getSessionFile() and detects
 * whether the session is a subagent via header.parentSession (primary signal),
 * session name pattern, or fork reason (secondary signals).
 *
 * Detection退化 (no sessionManager/header) → isSubagent=false (conservative).
 *
 * @param ctx - Runtime context with session manager access
 * @returns Session identity fields for audit enrichment
 */
function readSessionIdentity(ctx: RuntimeCtx): {
  sessionFile: string;
  isSubagent: boolean;
} {
  const sm = ((ctx._ctx as unknown) as Record<string, unknown>)?.sessionManager as
    | { getHeader?: () => Record<string, unknown> | undefined; getSessionName?: () => string; getSessionFile?: () => string }
    | undefined;

  const sessionFile = sm?.getSessionFile?.() ?? "";
  const parentSession = (sm?.getHeader?.() as Record<string, unknown> | undefined)?.parentSession as string | undefined;
  const sessionName = sm?.getSessionName?.() ?? "";
  const eventReason = (ctx.event as Record<string, unknown> | undefined)?.reason;

  // Subagent pattern: lowercase name + # + 8 hex chars (e.g., "code-review-agent#a1b2c3d4")
  const SUBAGENT_NAME_PATTERN = /^[a-z0-9-]+#[0-9a-f]{8}$/;
  const isSubagent = !!parentSession || SUBAGENT_NAME_PATTERN.test(sessionName) || eventReason === "fork";

  return { sessionFile, isSubagent };
}

/**
 * Creates the `session_shutdown` hook that handles session teardown.
 *
 * Writes a JSON-lines audit entry with:
 * - timestamp, pipelineId, action: "session_shutdown", finalStage
 * - sessionFile, isSubagent (Phase 0 / 171: session identity for traceability)
 *
 * When event.reason is "quit" or "new", resets flowState to "aborted" via
 * markPipelineAborted so that the next startup does not see stale "running".
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "session_shutdown" event
 */
export function createSessionShutdown(config: PipelineConfig): Hook<"session_shutdown"> {
  const ui = createPipelineUI(config);
  return {
    event: "session_shutdown",
    handler: async (ctx: RuntimeCtx): Promise<void> => {
      const meta = ctx.session.getMeta() as SessionMeta;

      // Phase 0 (171): session identity fields for traceability.
      // Distinguishes main session vs subagent shutdown in post-mortem analysis.
      const { sessionFile, isSubagent } = readSessionIdentity(ctx);

      // Phase 3 (170) ①: attach shutdown reason (quit/new/resume/fork/reload)
      // for traceability — distinguishes trigger sources in post-mortem analysis.
      const reason = (ctx.event as Record<string, unknown> | undefined)?.reason;
      await writeAuditLog("session_shutdown", {
        pipelineId: meta.pipelineId,
        finalStage: meta.currentStage,
        ...(reason ? { reason: String(reason) } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(isSubagent ? { isSubagent: "true" } : {}),
      });

      // Reset flowState only on quit/new — resume/fork/reload preserve user intent
      if (reason === "quit" || reason === "new") {
        await markPipelineAborted(ctx, "session_quit");
      }

      // Clear status bar on session shutdown
      ui.clearStage(ctx);
    },
  };
}
