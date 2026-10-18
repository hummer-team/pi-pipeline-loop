/**
 * @module pipeline-status
 * Factory for the `/pipeline-status` command.
 * Returns a formatted overview of the current pipeline state.
 */

import type { PipelineConfig, Command, SessionMeta, PipelineStage } from "../types";
import { checkTemplateDrift } from "../utils/template-drift";
import { resolvePiWorkDir } from "../utils/work-dir";
import { buildProtectedPaths } from "../utils/protect";
import { isDormant, DORMANT_NO_PIPELINE_MESSAGE } from "../core/dormancy";
// 193 Phase 3 (task 8): read-only pending-decision display (shared view).
import {
  buildDesignReviewPendingDecisionView,
  formatDesignReviewPendingDecision,
  DESIGN_REVIEW_PENDING_READONLY_NOTICE,
  DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION,
} from "../core/design-review/decision-display";

/**
 * Creates the `/pipeline-status` command.
 *
 * Displays a comprehensive status overview including:
 * - Pipeline ID, current stage, model, domain
 * - Summary validation status
 * - Loop iteration count and step index
 * - Protected paths list
 *
 * @param config - The pipeline configuration
 * @returns A Command object for the "pipeline-status" slash command
 */
export function createPipelineStatusCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-status",
    description: "Show current pipeline status",
    execute: async (_args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const rawMeta: SessionMeta | undefined = ctx.session.getMeta();
      // Phase 2b (173) C3: dormant guard — dormant output
      if (!rawMeta || isDormant(rawMeta)) {
        return { success: true, content: DORMANT_NO_PIPELINE_MESSAGE };
      }
      const meta: SessionMeta = rawMeta;
      const stageConfig = config.stages[meta.currentStage as PipelineStage];
      const currentSummary = meta.summaries[meta.currentStage as PipelineStage];

      // Phase 6 (170) + Phase 5 (173) C14: Check template drift and append to status output
      let driftLine = "- Template drift: 0 file(s)";
      try {
        const drifts = await checkTemplateDrift(config.projectRoot, resolvePiWorkDir(config));
        if (drifts.length > 0) {
          const names = drifts.map(d => d.asset).join(", ");
          driftLine = `- Template drift: ${drifts.length} file(s) [${names}]`;
          // Phase 5 (173) C14: guide.md drift gets a specific hint
          if (drifts.some(d => d.asset === "guide.md")) {
            driftLine += " — re-run /pipeline-init to overwrite";
          }
        }
      } catch {
        // Fail-open: drift check failure should not break status display
      }

      const pendingDecision = buildDesignReviewPendingDecisionView(meta);

      const content =
        `# Pipeline Status\n` +
        `- ID: ${meta.pipelineId}\n` +
        `- Stage: ${meta.currentStage}\n` +
        `- Model: ${meta.currentModel?.modelId || "default"}\n` +
        `- Domain: ${meta.domain.id}@${meta.domain.version}\n` +
        `- Summary Status: ${currentSummary?.status || "Missing"} (Path: ${currentSummary?.path || "N/A"})\n` +
        `- Loop: ${meta.loopCount}/${meta.maxLoops} (Step: ${meta.currentStepIndex})\n` +
        `- Protected: ${buildProtectedPaths(config).join(", ")}\n` +
        driftLine +
        // Phase 4-4 (191): Display design-review state if active
        (meta.designReview ? `\n\n## Design Review\n` +
          `- Phase: ${meta.designReview.phase}\n` +
          `- Round: ${meta.designReview.round}\n` +
          `- Operation: ${meta.designReview.operation?.kind || "N/A"}\n` +
          `- Plan: ${meta.designReview.planDoc}\n` +
          (meta.designReview.reportDoc ? `- Report: ${meta.designReview.reportDoc}\n` : "") +
          (meta.designReview.pauseReason ? `- Pause Reason: ${meta.designReview.pauseReason}\n` : "") +
          // 193 Phase 3 (task 8): pending human decision shows ONLY the
          // pending/mode/report/resume guidance — never an automatic next step.
          (pendingDecision !== null
            ? `- Status: ${DESIGN_REVIEW_PENDING_READONLY_NOTICE}\n` +
              `- Decision: ${formatDesignReviewPendingDecision(pendingDecision)}\n` +
              `- Resume: ${DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION}\n`
            : "")
          : "");

      return { success: true, content };
    },
  };
}
