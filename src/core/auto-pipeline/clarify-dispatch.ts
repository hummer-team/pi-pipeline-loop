/**
 * @module auto-pipeline/clarify-dispatch
 * 220 Phase 1 (D1/D2): pure decision layer for unattended clarify rounds.
 *
 * Facts:
 * - The settle seam only ASKS this function what to do; the dispatch itself
 *   (guard clearing, sidecar counters, spawn) belongs to `clarify-entry.ts`.
 * - The derivation of the document state is the EXISTING
 *   `deriveClarifyForwardArgs` (`src/utils/clarify-args.ts`) — no second
 *   round/answer/marker parser lives here.
 * - Decision order is fixed and total (every branch returns exactly one
 *   action): `not-auto` → `confirmed` → `await-finalisation` →
 *   `budget-exhausted` → `stalled` → `requirement-unclear` → forwarding state
 *   (`continue` / `spawn-full-und` split by the `ready` convergence criterion,
 *   226 Phase 1).
 * - `fresh` dispatches `" 1"` (the same literal the human path uses), never
 *   `"1"` without the leading space: `subagent-rpc` concatenates
 *   `prompt += extraArgs`, so the separator is part of the contract.
 * - The 30s dedupe window protects against several settles inside one visit;
 *   it is NOT a substitute for the `spawnedStages` guard or for the monotonic
 *   round stamp (see the three-layer contract in `clarify-entry.ts`).
 */

import { deriveClarifyForwardArgs } from "../../utils/clarify-args";
import type { VerifyContractAnchors } from "../../utils/contract-loader";
import type { RequirementAssessment } from "./clarify-protocol";
import { isClarifyRoundBudgetExhausted } from "./clarify-round-budget";
import { isClarifyStalled } from "./clarify-stall";

/** What the settle seam must do with the current clarify document. */
export type ClarifyDispatchAction =
  | "not-auto"
  | "fresh"
  | "await-answer"
  | "confirmed"
  | "continue"
  | "await-finalisation"
  | "spawn-full-und"
  | "budget-exhausted"
  | "stalled"
  | "requirement-unclear";

/** Everything the decision depends on (all of it already known by the seam). */
export interface ClarifyDispatchInput {
  /** TRUE only while an auto job owns this process. */
  autoActive: boolean;
  /** Project-relative requirement document of the running doc (may be unbound). */
  requirementDoc: string | null;
  /** Requirement document text; `null` when it cannot be read. */
  docText: string | null;
  /** Runtime contract anchors of the clarify stage (missing anchor ⇒ fresh). */
  anchors?: VerifyContractAnchors;
  /** Rounds already dispatched for THIS document (sidecar, monotonic). */
  usedRounds: number;
  /** Total round allowance of the job (`clarify.maxRounds`). */
  maxRounds: number;
  /** Consecutive no-progress observations for THIS document. */
  stalls: number;
  /** Stall limit above which clarify is frozen. */
  stallLimit: number;
  /** Consecutive rounds that still assessed as `needs-clarify`. */
  needsClarifyStreak: number;
  /** Limit of that streak. */
  needsClarifyLimit: number;
  /**
   * 226 Phase 1: TRUE when the finalisation round (`full-und?`) was already
   * dispatched for THIS document (sidecar fact). Decision order:
   * `confirmed` → `await-finalisation` → budget → stall → unclear → forward.
   */
  finalisationDispatched: boolean;
  /** Last requirement assessment (null = not parsed yet). */
  assessment: RequirementAssessment | null;
  /** Last dispatched round (dedupe source). */
  lastDispatchedRound?: number;
  /** Unix ms of the last dispatch (dedupe source). */
  lastDispatchedAt?: number;
  /** Evaluation time (injected so the decision stays pure). */
  now: number;
}

/** The single action plus the evidence that produced it. */
export interface ClarifyDispatchDecision {
  action: ClarifyDispatchAction;
  /** Round the action refers to (next round for `fresh`). */
  round: number;
  /** Forward args for the clarify subagent (`" 1"` / `" {round} 答"` / `" full-und?"`). */
  extraArgs?: string;
  /** TRUE when the same round was dispatched inside the dedupe window. */
  coalesced: boolean;
  /** Stable machine-readable reason (audit/diagnostics). */
  reason: string;
}

/** Window in which a repeated identical dispatch is coalesced. */
export const CLARIFY_DISPATCH_DEDUPE_MS = 30_000;

/** TRUE when `round` was already dispatched inside the dedupe window. */
function isCoalesced(input: ClarifyDispatchInput, round: number): boolean {
  if (input.lastDispatchedRound === undefined || input.lastDispatchedAt === undefined) return false;
  if (input.lastDispatchedRound !== round) return false;
  return input.now - input.lastDispatchedAt < CLARIFY_DISPATCH_DEDUPE_MS;
}

/** Actions that really dispatch a subagent (only those can be coalesced). */
const DISPATCH_ACTIONS: ReadonlySet<ClarifyDispatchAction> = new Set<ClarifyDispatchAction>([
  "fresh",
  "await-answer",
  "continue",
  "spawn-full-und",
]);

/** Build one decision, keeping the round/coalescing rule in a single place. */
function dispatchDecision(
  input: ClarifyDispatchInput,
  action: ClarifyDispatchAction,
  round: number,
  reason: string,
  extraArgs?: string,
): ClarifyDispatchDecision {
  return {
    action,
    round,
    ...(extraArgs !== undefined ? { extraArgs } : {}),
    coalesced: DISPATCH_ACTIONS.has(action) ? isCoalesced(input, round) : false,
    reason,
  };
}

/**
 * Clarify converged ⟺ the document declares the requirement ready.
 * `unknown` is NOT convergence (226 D: a declared criterion, not a guess).
 */
function isClarifyConverged(assessment: RequirementAssessment | null): boolean {
  return assessment?.verdict === "ready";
}

/**
 * Decide the clarify action for the current document.
 *
 * Pure: no fs, no clock, no side effects — the seam supplies every fact.
 */
export function decideClarifyDispatch(input: ClarifyDispatchInput): ClarifyDispatchDecision {
  const fallbackRound = input.lastDispatchedRound ?? input.usedRounds;
  if (!input.autoActive) {
    return dispatchDecision(input, "not-auto", fallbackRound, "no_active_auto_job");
  }

  const derived = deriveClarifyForwardArgs(input.docText ?? "", input.anchors);
  const derivedRound = derived.kind === "fresh" ? input.usedRounds + 1 : derived.round;

  if (derived.kind === "confirmed") {
    return dispatchDecision(input, "confirmed", derived.round, "clarify_confirmed");
  }

  // ① 226 Phase 1: the finalisation round was already dispatched but the
  //    completion marker is still missing ⇒ dispatch NOTHING and hand the
  //    settle back to the marker gate. It sits BEFORE the budget gate on
  //    purpose: the finalisation round consumed the last budgeted round, so
  //    the marker must still be verifiable without a second dispatch.
  //    `derived.kind === "fresh"` has no round property — `derivedRound` is
  //    the already-computed replacement (226 review B-#2).
  if (input.finalisationDispatched) {
    return dispatchDecision(input, "await-finalisation", derivedRound, "clarify_finalisation_pending");
  }

  // The two gate rules live in their owning modules: a second inline copy would
  // drift the moment either module changes (e.g. the `maxRounds <= 0` bound).
  if (isClarifyRoundBudgetExhausted(input.usedRounds, input.maxRounds)) {
    return dispatchDecision(input, "budget-exhausted", derivedRound, "clarify_round_budget_exhausted");
  }
  if (isClarifyStalled({ stalls: input.stalls }, input.stallLimit)) {
    return dispatchDecision(input, "stalled", derivedRound, "clarify_stalled");
  }
  if (input.needsClarifyLimit > 0 && input.needsClarifyStreak >= input.needsClarifyLimit) {
    return dispatchDecision(input, "requirement-unclear", derivedRound, "clarify_requirement_unclear");
  }

  // ② 226 Phase 1: the latest round HAS an answer. Converged (`ready`) ⇒
  //    dispatch the finalisation round; NOT converged (`needs-clarify` or
  //    `unknown`) ⇒ keep looping with the next ordinary round (`<n> 答`).
  if (derived.kind === "full-und?") {
    return isClarifyConverged(input.assessment)
      ? dispatchDecision(input, "spawn-full-und", derived.round, "clarify_full_und", " full-und?")
      : dispatchDecision(input, "continue", derived.round, "clarify_continue_round", ` ${derived.round} 答`);
  }
  // ③ 226 Phase 1: the latest round has NO answer — awaiting the answer takes
  //    priority over convergence (a finalisation must never run without one).
  if (derived.kind === "await-answer") {
    return dispatchDecision(
      input,
      "await-answer",
      derived.round,
      "clarify_await_answer",
      ` ${derived.round} 答`,
    );
  }
  return dispatchDecision(input, "fresh", derivedRound, "clarify_fresh_round", " 1");
}
