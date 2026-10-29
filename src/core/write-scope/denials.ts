/**
 * @module write-scope/denials
 * 218 Phase 2 (T2.2/T2.7, Q15-B/F.3-3): the explicit-Deny breaker for
 * whitelist-miss write decisions.
 *
 * Storage: `meta.whitelistMissDenials` — ONE record for the CURRENT stage:
 * `{ stage, counts: Record<pathClass, number>, updatedAt }`.
 *
 * Self-invalidating by design: `readDenialCount` returns 0 whenever the
 * stored stage differs from the requested one, so a stage transition resets
 * the counter WITHOUT patching the three stage-migration sites
 * (stage-advancer). `clearDenials` runs on ANY Allow (session-scoped grants
 * replace the deny pressure entirely).
 *
 * The WhitelistMissMode value domain lives in src/types.ts — never redeclare it.
 */

import type { PipelineStage, SessionMeta } from "../../types";

/** Minimal shared-meta session surface the helpers need (same shape as owner-approval). */
export interface DenialSession {
  getMeta: () => SessionMeta | undefined;
  updateMeta: (patch: Partial<SessionMeta>) => unknown;
}

/** Read the current deny count for `stage:pathClass`; 0 for a different stage. */
export function readDenialCount(
  meta: SessionMeta,
  stage: PipelineStage,
  pathClass: string,
): number {
  const stored = meta.whitelistMissDenials;
  if (!stored || stored.stage !== stage) return 0; // self-invalidated on stage change
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
  // A different (or absent) stage starts a fresh count table — never merge
  // another stage's pressure into this one (Q15-B "recount across stages").
  const counts = stored && stored.stage === stage ? { ...stored.counts } : {};
  const next = (counts[pathClass] ?? 0) + 1;
  counts[pathClass] = next;
  session.updateMeta({
    whitelistMissDenials: { stage, counts, updatedAt: Date.now() },
  });
  return next;
}

/** Drop all deny pressure (called on any Allow outcome). */
export function clearDenials(
  session: { updateMeta: (patch: Partial<SessionMeta>) => unknown },
): void {
  session.updateMeta({ whitelistMissDenials: undefined });
}
