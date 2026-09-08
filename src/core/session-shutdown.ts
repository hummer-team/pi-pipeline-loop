/**
 * @module session-shutdown
 * Factory for the `session_shutdown` hook.
 * Logs an audit entry and cleans up temporary resources on session teardown.
 *
 * Phase 1 (171): Role-aware shutdown.
 * - Child/subagent sessions: audit session_shutdown_skipped{isSubagent:true}, return.
 *   Subagent panel close/view detach must NOT abort the parent pipeline.
 * - Owner session: maintains 170 semantics (quit/new → markPipelineAborted).
 * - Detection degradation (no sessionManager/header): conservative owner path (no worse).
 *
 * Terminal guard: when the pipeline is already completed, markPipelineAborted
 * (called internally) skips the flowState/terminateReason overwrite — completed
 * is a terminal state that must not be degraded to aborted on shutdown.
 *
 * On reason "resume", "fork", or "reload": does NOT reset (in-process session switch
 * or extension reload — user may continue).
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { clearAllDecisionTimers } from "./flow-state";
import type { RuntimeCtx } from "./runtime-ctx";
import { writeAuditLog, safeWriteAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "./pipeline-ui";
import { markPipelineAborted } from "./flow-state";
import { detectSessionRole } from "./session-role";

/**
 * Creates the `session_shutdown` hook that handles session teardown.
 *
 * Writes a JSON-lines audit entry with:
 * - timestamp, pipelineId, action: "session_shutdown", finalStage
 * - sessionFile, isSubagent (Phase 0 / 171: session identity for traceability)
 *
 * Phase 1 (171): Child/subagent quit → skip abort, audit skipped.
 * Owner quit/new → markPipelineAborted with trigger fields (C14-C15).
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "session_shutdown" event
 */
export function createSessionShutdown(config: PipelineConfig): Hook<"session_shutdown"> {
  const ui = createPipelineUI(config);
  return {
    event: "session_shutdown",
    handler: async (ctx: RuntimeCtx): Promise<void> => {
      const meta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 2a (173) C6: no-meta guard — identity audit line only (no pipelineId field)
      // Phase 6 (172) G5: clear all decision retry timers on shutdown (prevent leaks)
      clearAllDecisionTimers();
      if (!meta?.pipelineId) {
        // No meta at all — write minimal identity audit and return
        const { isChild, sessionFile } = detectSessionRole(ctx);
        await writeAuditLog("session_shutdown", {
          pipelineId: "unknown",
          finalStage: "unknown",
          ...(sessionFile ? { sessionFile } : {}),
          ...(isChild ? { isSubagent: "true" } : {}),
        });
        return;
      }

      // Phase 0 (171): session identity fields for traceability
      const { isChild, sessionFile, parentSession } = detectSessionRole(ctx);

      // Phase 3 (170) ①: attach shutdown reason (quit/new/resume/fork/reload)
      const reason = (ctx.event as Record<string, unknown> | undefined)?.reason;
      await writeAuditLog("session_shutdown", {
        pipelineId: meta.pipelineId,
        finalStage: meta.currentStage,
        ...(reason ? { reason: String(reason) } : {}),
        ...(sessionFile ? { sessionFile: sessionFile } : {}),
        ...(isChild ? { isSubagent: "true" } : {}),
      });

      // Phase 1 (171): Child/subagent quit must NOT abort the parent pipeline.
      // Subagent panel close / view detach / completed-recycle trigger session_shutdown(quit)
      // but should not freeze the shared pipeline meta.json.
      if ((reason === "quit" || reason === "new") && isChild) {
        await safeWriteAuditLog("session_shutdown_skipped", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          isSubagent: "true",
          reason: String(reason),
          ...(sessionFile ? { sessionFile } : {}),
          ...(parentSession ? { parentSession } : {}),
        });
        // Do NOT call markPipelineAborted or clearStage for child sessions
        return;
      }

      // Owner session: reset flowState on quit/new — resume/fork/reload preserve user intent
      if (reason === "quit" || reason === "new") {
        // Phase 1 (171): pass trigger identity + config for enriched audit (C14-C15)
        await markPipelineAborted(ctx, "session_quit", {
          trigger: {
            sessionFile: sessionFile || undefined,
            isSubagent: false,
            eventReason: String(reason),
          },
          config,
        });
      }

      // Clear status bar on session shutdown (owner only — child returned above)
      ui.clearStage(ctx);
    },
  };
}
