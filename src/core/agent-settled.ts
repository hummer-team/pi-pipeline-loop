/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta } from "../types";

/**
 * Creates the `agent_settled` hook that logs when the agent stabilizes.
 *
 * Writes a JSON-lines audit entry with:
 * - timestamp, pipelineId, action: "agent_settled", stage
 *
 * Optionally notifies via `ctx.ui.notify` if available.
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "agent_settled" event
 */
export function createAgentSettled(config: PipelineConfig): Hook {
  return {
    event: "agent_settled",
    handler: async (ctx: any): Promise<void> => {
      const meta = ctx.session.getMetadata() as SessionMeta;
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";

      const auditLog = {
        timestamp: new Date().toISOString(),
        pipelineId: meta.pipelineId,
        action: "agent_settled",
        stage: meta.currentStage,
      };

      const auditLogPath = path.join(projectRoot, auditDir, "audit.log");
      await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
      await fs.appendFile(auditLogPath, JSON.stringify(auditLog) + "\n");

      // Optional UI notification if available
      if (ctx.ui?.notify) {
        ctx.ui.notify(`Agent settled in "${meta.currentStage}" stage`);
      }
    },
  };
}
