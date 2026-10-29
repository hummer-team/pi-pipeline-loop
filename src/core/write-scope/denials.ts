/**
 * @module write-scope/denials
 * 218 Phase 2 (T2.2/T2.7, Q15-B/F.3-3): the explicit-Deny breaker for
 * whitelist-miss write decisions.
 *
 * Storage: `meta.whitelistMissDenials` — ONE record for the CURRENT stage:
 * `{ stage, counts: Record<pathClass, number>, updatedAt }`.
 *
 * Self-invalidating by design on two axes (218 review #2):
 * - STAGE: `readDenialCount` returns 0 whenever the stored stage differs from
 *   the requested one, so a stage transition resets the counter WITHOUT
 *   patching the three stage-migration sites in stage-advancer. Stage
 *   equality alone is NOT enough: re-entering the same stage in a NEW period
 *   would otherwise resurrect the old strikes.
 * - PERIOD: the stored `pipelineId` must match the current one, so any
 *   record from a superseded run (or a legacy record without the stamp)
 *   reads as 0. A `/pipeline-start` resume keeps BOTH stage and pipelineId,
 *   so its deny pressure intentionally survives.
 * The restart / rollback / rewind_last_round decision sites additionally
 * clear the record explicitly (guide.md promise). `clearDenials` runs on ANY
 * Allow (session-scoped grants replace the deny pressure entirely).
 *
 * The WhitelistMissMode value domain lives in src/types.ts — never redeclare it.
 */

import type { PipelineStage, SessionMeta } from "../../types";

/** Minimal shared-meta session surface the helpers need (same shape as owner-approval). */
export interface DenialSession {
  getMeta: () => SessionMeta | undefined;
  updateMeta: (patch: Partial<SessionMeta>) => unknown;
}

/**
 * Read the current deny count for `stage:pathClass`; 0 for a different stage,
 * a different pipeline period, or a legacy record without the pipelineId
 * stamp (fail closed — 218 review #2). Same-pipeline resumes keep their
 * pressure on purpose.
 */
export function readDenialCount(
  meta: SessionMeta,
  stage: PipelineStage,
  pathClass: string,
): number {
  const stored = meta.whitelistMissDenials;
  if (!stored || stored.stage !== stage) return 0; // self-invalidated on stage change
  if (stored.pipelineId !== meta.pipelineId) return 0; // self-invalidated on a new period
  return stored.counts[pathClass] ?? 0;
}

/**
 * Record one explicit human Deny and return the NEW per-class count.
 * Re-reads the latest meta before writing (shared-store discipline): a
 * concurrent enqueue/authorization write must never be clobbered.
 */
export function recordDenial(
  session: DenialSession,
  meta: SessionMeta,
  stage: PipelineStage,
  pathClass: string,
): number {
  const fresh = session.getMeta() ?? meta;
  const stored = fresh.whitelistMissDenials;
  // A different (or absent) stage, or a record from another pipeline period,
  // starts a fresh count table — never merge another stage's or another
  // period's pressure into this one (Q15-B "recount across stages",
  // review #2 period scoping).
  const sameScope =
    !!stored && stored.stage === stage && stored.pipelineId === meta.pipelineId;
  const counts = sameScope ? { ...stored!.counts } : {};
  const next = (counts[pathClass] ?? 0) + 1;
  counts[pathClass] = next;
  session.updateMeta({
    // 218 review #2: stamp the collecting period so a later new-pipelineId
    // transition invalidates the strikes even when the stage was re-entered.
    whitelistMissDenials: { stage, pipelineId: meta.pipelineId, counts, updatedAt: Date.now() },
  });
  return next;
}

/** Drop all deny pressure (called on any Allow outcome). */
export function clearDenials(
  session: { updateMeta: (patch: Partial<SessionMeta>) => unknown },
): void {
  session.updateMeta({ whitelistMissDenials: undefined });
}
