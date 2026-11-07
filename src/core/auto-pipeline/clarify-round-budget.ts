/**
 * @module auto-pipeline/clarify-round-budget
 * 220 Phase 1 (D1/D6): the clarify round stamp and its budget predicate.
 *
 * Facts:
 * - This is an INDEPENDENT budget from the design-review one
 *   (`round-budget.ts`): sharing a counter would let one stage's retries
 *   consume the other's allowance.
 * - 226 Phase 2: EVERY real dispatch counts. A re-dispatched (rewound) round
 *   after a document rollback consumes ONE more round, and only a failed
 *   dispatch is refunded (`clarify_round_refund`) — `maxRounds` is a budget
 *   over dispatched rounds, not over round NUMBERS.
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
 * Record one dispatch. 226 Phase 2: EVERY finite round counts — `maxRounds`
 * is a budget over REAL dispatches, so a re-dispatched (rewound) round also
 * consumes a round; the dedupe window (`CLARIFY_DISPATCH_DEDUPE_MS`) absorbs
 * same-visit settle bursts, not this counter.
 */
export function noteClarifyRoundDispatch(
  prev: ClarifyRoundStamp,
  round: number,
  now: number,
): ClarifyRoundStamp {
  if (!Number.isFinite(round)) return prev;
  return {
    usedRounds: prev.usedRounds + 1,
    lastRound: Math.max(prev.lastRound ?? 0, round),
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
