/**
 * @module auto-pipeline/continuity
 * 219 Phase 6 (H4 round 2): the "continue or restart" hard judgement.
 *
 * Facts:
 * - PURE: never reads process state or writes disk; the prompt only states the
 *   conclusion (219_Feat.md 6.5 decision 10).
 * - Rule order IS the priority. Rule 2 must run before rule 3, otherwise the
 *   main scenario (a NEW session with no meta) would always be `none`.
 * - `stage` has a fallback chain: `meta.currentStage` → the sidecar's
 *   `docs[docIndex].lastStage`. Only when BOTH are absent is it undefined —
 *   the "任务连续性" section would otherwise have no stage at all after a crash.
 * - A clock skew (`lastSettleAt > sessionStartedAt`) does NOT satisfy `<`, so it
 *   falls through to the later rules instead of claiming an interruption.
 */

import type { PipelineStage, SessionMeta } from "../../types";
import type { AutoJobState } from "./job-state";

export type ContinuityDecision = "resume" | "restart-stage" | "none";

export interface ContinuityResult {
  decision: ContinuityDecision;
  reason: string;
  doc?: string;
  stage?: PipelineStage;
}

export function decideContinuity(input: {
  /** `null` = NO meta at all (new session). Distinct from `currentStage === undefined`. */
  meta: SessionMeta | null;
  state: AutoJobState | null;
  /** Unix ms when THIS session started. */
  sessionStartedAt: number;
  /** TRUE when the requirement doc's commit-proof document exists. */
  hasCommitDoc: boolean;
}): ContinuityResult {
  const { meta, state, sessionStartedAt, hasCommitDoc } = input;

  // Rule 1: a frozen pipeline resumes (human and auto alike).
  if (meta !== null && meta.flowState === "blocked") {
    const stage = meta.currentStage ?? lastStageOf(state);
    return {
      decision: "resume",
      reason: "frozen",
      ...(meta.requirementDoc ? { doc: meta.requirementDoc } : {}),
      ...(stage ? { stage } : {}),
    };
  }

  // Rule 2: a running job that has not settled in THIS session is interrupted.
  // Must precede rule 3 (a brand-new session has no currentStage at all).
  if (state !== null && state.status === "running" && (state.lastSettleAt ?? 0) < sessionStartedAt) {
    const progress = state.docs[state.docIndex];
    const stage = meta?.currentStage ?? progress?.lastStage;
    return {
      decision: "resume",
      reason: meta === null ? "unsettled_new_session" : "unsettled",
      ...(progress?.doc ? { doc: progress.doc } : {}),
      ...(stage ? { stage } : {}),
    };
  }

  // Rule 3: meta without a stage — the document is the better signal.
  if (meta !== null && meta.currentStage === undefined) {
    return { decision: "none", reason: "stage_unknown_in_meta" };
  }

  // Rule 4: a finished job whose doc already shipped → nothing to resume.
  if (state !== null && state.status === "completed" && hasCommitDoc) {
    const doc = state.docs[state.docIndex]?.doc;
    return { decision: "none", reason: "job_completed_with_commit_doc", ...(doc ? { doc } : {}) };
  }

  return { decision: "none", reason: "no_interruption" };
}

function lastStageOf(state: AutoJobState | null): PipelineStage | undefined {
  if (!state) return undefined;
  return state.docs[state.docIndex]?.lastStage;
}
