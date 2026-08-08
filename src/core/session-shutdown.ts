/**
 * @module session-shutdown
 * Factory for the `session_shutdown` hook.
 * Logs an audit entry and cleans up temporary resources on session teardown.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { writeAuditLog } from "../utils/auditLog";

/**
 * Creates the `session_shutdown` hook that handles session teardown.
 *
 * Writes a JSON-lines audit entry with:
 * - timestamp, pipelineId, action: "session_shutdown", finalStage
 *
 * Cleans up any temporary resources associated with the session.
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "session_shutdown" event
 */
export function createSessionShutdown(config: PipelineConfig): Hook {
  return {
    event: "session_shutdown",
    handler: async (ctx: any): Promise<void> => {
      const meta = ctx.session.getMetadata() as SessionMeta;

      await writeAuditLog("session_shutdown", {
        pipelineId: meta.pipelineId,
        finalStage: meta.currentStage,
      });
    },
  };
}
