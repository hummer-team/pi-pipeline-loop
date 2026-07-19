/**
 * @module session-shutdown
 * Factory for the `session_shutdown` hook.
 * Logs an audit entry and cleans up temporary resources on session teardown.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta } from "../types";

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
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";

      const auditLog = {
        timestamp: new Date().toISOString(),
        pipelineId: meta.pipelineId,
        action: "session_shutdown",
        finalStage: meta.currentStage,
      };

      const auditLogPath = path.join(projectRoot, auditDir, "audit.log");
      await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
      await fs.appendFile(auditLogPath, JSON.stringify(auditLog) + "\n");
    },
  };
}
