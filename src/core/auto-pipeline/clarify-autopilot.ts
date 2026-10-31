/**
 * @module auto-pipeline/clarify-autopilot
 * 219 Phase 3 G1: clarify self-answer without a human.
 *
 * Facts (219_Feat.md 6.5 decision 4 + plan Phase 3 §1):
 * - v1 has exactly TWO paths: `self-answer` and `orchestrated` (`prefilled` and
 *   the removed `fallback` / `answerStrategy` keys are rejected at parse time,
 *   so no third branch can exist here).
 * - The instruction rides the EXISTING `extraArgs` channel
 *   (`prompt += extraArgs` in `subagent-rpc`), appended after the mention —
 *   no new dispatch parameter and no new subagent API.
 * - A missing `## 模型确认` marker degrades the doc ONCE to `orchestrated`
 *   (recorded as `docs[i].clarifyFallbackUsed`); a second miss is a doc
 *   failure owned by Phase 5's `handleDocFailure`.
 */

import type { PipelineConfig } from "../../types";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobState } from "./job-state";
import { readActiveJobContext } from "./config-overlay";
import { auditAutoDecision } from "./auto-audit";

/** The clarify plan for the currently executing doc. */
export interface ClarifyAutoPlan {
  /** Args appended to the clarify mention (`<doc> <args>`). */
  args: string;
  /** Instruction appended after the mention (the `extraArgs` channel). */
  instruction: string;
  /** Which v1 path produced this plan. */
  mode: "self-answer" | "orchestrated";
  /** Job-level round cap (`clarify.maxRounds`). */
  maxRounds: number;
}

/** Marker the clarify agent must write (mirrors template completionMarker). */
export const CLARIFY_COMPLETION_MARKER = "## 模型确认";

/**
 * Build the instruction text for one clarify mode.
 *
 * v1 accepts only the two implemented modes; the default follows
 * `self-answer` so an unexpected value can never silently disable the job.
 */
export function buildClarifyInstruction(
  job: AutoJobConfig,
  mode: AutoJobConfig["clarify"]["mode"] = job.clarify.mode,
): string {
  const maxRounds = job.clarify.maxRounds;
  const common =
    `[auto-pipeline] This run is unattended — no human will answer. ` +
    `Work through the clarification rounds yourself (at most ${maxRounds}). `;
  if (mode === "orchestrated") {
    return (
      common +
      "Write each answer into the requirement document as `答：<answer>` (with a one-line reason), " +
      `run the full-und? flow, and finish by writing the completion marker \`${CLARIFY_COMPLETION_MARKER}\`.`
    );
  }
  return (
    common +
    "For every open question pick the recommended option, write it into the requirement document as " +
    "`答：<answer>` (with a one-line reason), then run the full-und? flow and finish by writing the " +
    `completion marker \`${CLARIFY_COMPLETION_MARKER}\`.`
  );
}

/**
 * Build the clarify plan for the active auto job, or `null` when this process
 * is not an auto runner (human mode keeps its unchanged derivation).
 *
 * `self-answer` starts the first round ("1"); `orchestrated` jumps straight to
 * the finalisation flow ("full-und?").
 */
export function buildClarifyAutoPlan(projectRoot: string): ClarifyAutoPlan | null {
  const active = readActiveJobContext(projectRoot);
  if (!active || active.state.status !== "running") return null;
  const mode = active.job.clarify.mode;
  return {
    args: mode === "orchestrated" ? "full-und?" : "1",
    instruction: buildClarifyInstruction(active.job, mode),
    mode,
    maxRounds: active.job.clarify.maxRounds,
  };
}

/** Outcome of registering a missing clarify completion marker. */
export type ClarifyMarkerMissAction = "degrade" | "exhausted";

/**
 * Record a missing `## 模型确认` marker for one doc.
 *
 * First miss → degrade to `orchestrated` (sets `clarifyFallbackUsed`).
 * Second miss → `exhausted` (the caller routes through `handleDocFailure`
 * with `reason: "clarify_marker_missing"`).
 *
 * Pure state mutation: the caller persists the sidecar (single write point).
 */
export function noteClarifyMarkerMiss(input: {
  state: AutoJobState;
  docIndex: number;
  now?: number;
}): ClarifyMarkerMissAction {
  const doc = input.state.docs[input.docIndex];
  if (!doc) return "exhausted";
  if (doc.clarifyFallbackUsed) return "exhausted";
  doc.clarifyFallbackUsed = true;
  doc.updatedAt = input.now ?? Date.now();
  input.state.updatedAt = doc.updatedAt;
  return "degrade";
}

/**
 * Audit one clarify-marker auto decision (`pipeline_auto_decision`, gated by
 * `audit.autoDecisions` — lifecycle audits are separate and always written).
 */
export async function auditClarifyMarkerMiss(
  config: PipelineConfig,
  action: ClarifyMarkerMissAction,
): Promise<void> {
  await auditAutoDecision(config, {
    gate: "clarify_completion_marker",
    decision: action === "degrade" ? "degrade" : "fail",
    reason: action === "degrade" ? "marker_missing_degrade_orchestrated" : "marker_missing_after_degrade",
  });
}
