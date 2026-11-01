/**
 * @module auto-pipeline/clarify-stall
 * 220 Phase 1 (D2): the clarify "no progress" counter.
 *
 * Facts:
 * - A stall is "the document did not grow while its state signature stayed
 *   the same". Growth is the only proof of progress, so it always resets the
 *   counter — a model that keeps writing new answers is never frozen.
 * - The signature is supplied by the caller (derived from the clarify
 *   derivation + assessment), so this module stays free of document parsing.
 * - NOT related to `pending-spawn-stall.ts` (217: a queue that was never
 *   consumed). No constant, timer or state is shared with that watchdog.
 */

/** Per-document clarify stall accounting persisted in the sidecar. */
export interface ClarifyStallState {
  /** Consecutive no-progress observations. */
  stalls: number;
  /** Signature of the last observation (derivation state + assessment). */
  signature: string;
  /** Document length of the last observation. */
  docLength: number;
}

/** Observations allowed before clarify is frozen. */
export const DEFAULT_CLARIFY_STALL_LIMIT = 3;

/**
 * Fold one observation into the stall state.
 *
 * - first observation → `stalls: 0` (nothing has stalled yet),
 * - same signature and no growth → `stalls + 1`,
 * - document grew, or the signature changed → `stalls: 0`.
 */
export function nextClarifyStallState(
  prev: ClarifyStallState | undefined,
  input: { signature: string; docLength: number },
): ClarifyStallState {
  if (!prev) return { stalls: 0, signature: input.signature, docLength: input.docLength };
  const grew = input.docLength > prev.docLength;
  const sameSignature = input.signature === prev.signature;
  const stalls = sameSignature && !grew ? prev.stalls + 1 : 0;
  return { stalls, signature: input.signature, docLength: input.docLength };
}

/** TRUE when the stall count reached the configured limit (`0` = disabled). */
export function isClarifyStalled(state: ClarifyStallState, limit: number): boolean {
  if (limit <= 0) return false;
  return state.stalls >= limit;
}
