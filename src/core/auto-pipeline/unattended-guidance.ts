/**
 * @module auto-pipeline/unattended-guidance
 * 227 Phase 4 (D-3): the UNATTENDED contract injected into every auto-job
 * prompt (owner AND child).
 *
 * No text parsing: the section states the CONTRACT the model must follow so the
 * settle seam can rely on structural facts (advance / stop-and-report). The
 * bounded owner re-prompt (`ask-reprompt.ts`) is the enforcement backstop.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { buildStageSequence } from "../../utils/stage-sequence";

/**
 * Render the unattended section, or `null` on the human track (zero change to
 * the existing prompt assembly).
 */
export function buildUnattendedSection(
  config: PipelineConfig,
  meta: SessionMeta,
): string | null {
  if (!meta.autoJob) return null;
  const seq = buildStageSequence(config, meta.currentStage);
  return [
    "# UNATTENDED AUTO JOB",
    `- Job: ${meta.autoJob.jobId} (doc ${meta.autoJob.docIndex + 1}/${meta.autoJob.totalDocs})`,
    `- Stage sequence from here: ${seq.join(" → ")}`,
    "- Do NOT ask the user and do NOT wait for confirmation; nobody will answer.",
    "- Finish the work, then call stage_advance with the configured next stage.",
    "- If the evidence is insufficient or contradictory, do not ask the user:",
    "  write the reason and stop — the plugin treats it as stop-and-report.",
  ].join("\n");
}
