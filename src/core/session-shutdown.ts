/**
 * @module session-shutdown
 * Factory for the `session_shutdown` hook.
 * Logs an audit entry and cleans up temporary resources on session teardown.
 *
 * On reason "quit" or "new": resets flowState to "aborted" (double-insurance with
 * session_start stale recovery) so that subsequent /pipeline-start enters the restart
 * branch instead of hitting "already running" error.
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
 * Creates the `session_shutdown` hook that handles session teardown.
 *
 * Writes a JSON-lines audit entry with:
 * - timestamp, pipelineId, action: "session_shutdown", finalStage
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

      await writeAuditLog("session_shutdown", {
        pipelineId: meta.pipelineId,
        finalStage: meta.currentStage,
      });

      // Reset flowState only on quit/new — resume/fork/reload preserve user intent
      const reason = (ctx.event as Record<string, unknown> | undefined)?.reason;
      if (reason === "quit" || reason === "new") {
        await markPipelineAborted(ctx, "session_quit");
      }

      // Clear status bar on session shutdown
      ui.clearStage(ctx);
    },
  };
}
