/**
 * @module auto-pipeline/clarify-round-budget
 * 220 Phase 1 (D1/D6): the clarify round stamp and its budget predicate.
 *
 * Facts:
 * - This is an INDEPENDENT budget from the design-review one
 *   (`round-budget.ts`): sharing a counter would let one stage's retries
 *   consume the other's allowance.
 * - Counting is monotonic: dispatching the same round again (or a rewound
 *   round after the document was rolled back) never refunds nor consumes a
 *   round. Only a strictly greater round number increments `usedRounds`.
 * - The predicate is `>=`, matching "maxRounds is the TOTAL number of rounds"
 *   (D6): `maxRounds: 1` still allows exactly one dispatch.
 */

/** Per-document clarify round accounting persisted in the sidecar. */
export interface ClarifyRoundStamp {
  /** Rounds actually dispatched so far (monotonic). */
  usedRounds: number;
  /** Highest dispatched round number (dedupe + rewind protection). */
  lastRound: number | undefined;
  /** Unix ms of the last dispatch (30s coalescing window). */
  lastDispatchedAt: number | undefined;
}

/** The sidecar fields one dispatch stamp writes (a subset of the doc progress). */
export interface ClarifyRoundAccount {
  clarifyRounds?: number;
  clarifyLastRound?: number;
  clarifyDispatchedAt?: number;
}

/**
 * TRUE when the document already consumed its whole clarify allowance.
 * `maxRounds <= 0` means "no budget configured" ⇒ never exhausted.
 */
export function isClarifyRoundBudgetExhausted(usedRounds: number, maxRounds: number): boolean {
  if (maxRounds <= 0) return false;
  return usedRounds >= maxRounds;
}

/**
 * Record one dispatch. Same or lower round ⇒ no-op (returns the input object
 * unchanged so callers can detect "nothing to persist" by identity).
 */
export function noteClarifyRoundDispatch(
  prev: ClarifyRoundStamp,
  round: number,
  now: number,
): ClarifyRoundStamp {
  if (!Number.isFinite(round)) return prev;
  if (prev.lastRound !== undefined && round <= prev.lastRound) return prev;
  return {
    usedRounds: prev.usedRounds + 1,
    lastRound: round,
    lastDispatchedAt: now,
  };
}

/**
 * Stamp ONE dispatched round onto the per-doc account (single write rule).
 *
 * Used by every dispatch path — the settle-side round
 * (`clarify-round-dispatch.ts`) and the startup round of `/pipeline-start`
 * (`clarify-entry.ts`) — so "which dispatch counts" can never diverge.
 */
export function stampClarifyRoundDispatch(account: ClarifyRoundAccount, round: number, now: number): void {
  const stamp = noteClarifyRoundDispatch(
    {
      usedRounds: account.clarifyRounds ?? 0,
      lastRound: account.clarifyLastRound,
      lastDispatchedAt: account.clarifyDispatchedAt,
    },
    round,
    now,
  );
  account.clarifyRounds = stamp.usedRounds;
  account.clarifyLastRound = stamp.lastRound;
  account.clarifyDispatchedAt = now;
}
