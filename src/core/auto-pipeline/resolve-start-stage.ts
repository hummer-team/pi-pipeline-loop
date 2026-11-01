/**
 * @module auto-pipeline/resolve-start-stage
 * 220 Phase 5 (D5): resolve the configured start stage to a CONCRETE stage.
 *
 * Facts:
 * - `"auto"` is derived from the on-disk plan evidence ONLY (never from globs):
 *   a confirmed plan ⇒ `develop`, a plan without the confirmation marker ⇒
 *   `plan`, no plan ⇒ `clarify`.
 * - An explicit value is passed through unchanged: the job file is the operator's
 *   decision, and the evidence gate (`checkStartStageEvidence`) still has to
 *   confirm that the requested stage is actually startable.
 * - `derivePlanDocPath` (exact `{dir}/{base}_Plan.md`) is the caller's source of
 *   `planPath`; this module never touches the filesystem.
 */

import type { PipelineStage } from "../../types";

/** On-disk facts the derivation needs (computed by the caller, exact paths only). */
export interface StartStageFacts {
  /** Exact plan path of the requirement document (never a glob result). */
  planPath: string | null;
  /** TRUE when the plan carries the user-confirmation marker. */
  planConfirmed: boolean;
}

/** Chosen stage plus how it was obtained (audited in the sidecar). */
export interface ResolvedStartStage {
  stage: PipelineStage;
  derivation: "explicit" | "auto";
}

/** Resolve `requested` (job `defaults.startStage` / doc `startStage`) to a stage. */
export function resolveStartStage(
  requested: PipelineStage | "auto",
  facts: StartStageFacts,
): ResolvedStartStage {
  if (requested !== "auto") return { stage: requested, derivation: "explicit" };
  if (facts.planPath !== null && facts.planConfirmed) return { stage: "develop", derivation: "auto" };
  if (facts.planPath !== null) return { stage: "plan", derivation: "auto" };
  return { stage: "clarify", derivation: "auto" };
}
