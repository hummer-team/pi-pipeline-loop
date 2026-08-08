/**
 * @module session-ender
 * Factory for the `session_end` hook.
 * Writes a final audit log entry when the session ends.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { writeAuditLog } from "../utils/auditLog";

/**
 * Creates the `session_end` hook that logs session termination.
 *
 * Writes a JSON-lines audit entry with:
 * - timestamp, pipelineId, action: "session_end", finalStage
 *
 * This ensures audit completeness — every session end is recorded
 * alongside the other 4 audited events (loop_break, file_modified,
 * summary_validated, handoff).
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "session_end" event
 */
export function createSessionEnder(config: PipelineConfig): Hook {
  return {
    event: "session_end",
    handler: async (ctx: any): Promise<void> => {
      const meta = ctx.session.getMetadata() as SessionMeta;

      await writeAuditLog("session_end", {
        pipelineId: meta.pipelineId,
        finalStage: meta.currentStage,
      });
    },
  };
}
