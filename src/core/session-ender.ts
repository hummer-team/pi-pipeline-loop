/**
 * @module session-ender
 * Factory for the `session_end` hook.
 * Writes a final audit log entry when the session ends.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta } from "../types";

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
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";

      const auditLog = {
        timestamp: new Date().toISOString(),
        pipelineId: meta.pipelineId,
        action: "session_end",
        finalStage: meta.currentStage,
      };

      const auditLogPath = path.join(projectRoot, auditDir, "audit.log");
      await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
      await fs.appendFile(auditLogPath, JSON.stringify(auditLog) + "\n");
    },
  };
}
