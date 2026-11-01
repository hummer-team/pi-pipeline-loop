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
 *   action): `not-auto` → `confirmed` → `budget-exhausted` → `stalled` →
 *   `requirement-unclear` → forwarding state.
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

/** What the settle seam must do with the current clarify document. */
export type ClarifyDispatchAction =
  | "not-auto"
  | "fresh"
  | "await-answer"
  | "confirmed"
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
  if (input.maxRounds > 0 && input.usedRounds >= input.maxRounds) {
    return dispatchDecision(input, "budget-exhausted", derivedRound, "clarify_round_budget_exhausted");
  }
  if (input.stallLimit > 0 && input.stalls >= input.stallLimit) {
    return dispatchDecision(input, "stalled", derivedRound, "clarify_stalled");
  }
  if (input.needsClarifyLimit > 0 && input.needsClarifyStreak >= input.needsClarifyLimit) {
    return dispatchDecision(input, "requirement-unclear", derivedRound, "clarify_requirement_unclear");
  }

  if (derived.kind === "fresh") {
    return dispatchDecision(input, "fresh", derivedRound, "clarify_fresh_round", " 1");
  }
  if (derived.kind === "await-answer") {
    return dispatchDecision(
      input,
      "await-answer",
      derived.round,
      "clarify_await_answer",
      ` ${derived.round} 答`,
    );
  }
  return dispatchDecision(input, "spawn-full-und", derived.round, "clarify_full_und", " full-und?");
}
