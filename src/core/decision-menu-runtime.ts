/**
 * @module decision-menu-runtime
 * 208 Phase 0: Shared types + input-capability registry for the decision menu.
 *
 * Phase 1 adds the runtime state machine (single-flight scheduling, backoff
 * timers, retry attribution). This module MUST NOT import `flow-state` — the
 * presentation implementation is injected via {@link DecisionMenuRuntimeDeps},
 * keeping the dependency arrow pointing from flow-state into this module.
 */

import type { SessionMeta } from "../types";

// ─── Outcome types ──────────────────────────────────────────────────────────

/** Result of one menu presentation attempt. */
export type PromptDecisionOutcome = "cancelled" | "interrupted" | "decided" | "no-menu";

/** Canonical call sites. `shortcut` is intentionally absent (208 scope). */
export type DecisionMenuSource = "freeze" | "settle" | "replay" | "command";

/** Why the menu could not be shown — replaces `typeof ui.select` inference. */
export type DecisionMenuUnavailableReason =
  | "aborted" | "child_session" | "no_ui" | "select_error" | "stale_pipeline" | "no_meta";

/** Menu capabilities that shape the offered options. */
export interface DecisionMenuCapabilities {
  /** `ui.input` usable for numeric prompts → controls `set_budget` availability. */
  input: boolean;
}

/** Machine-readable failure class for decision application (audit aggregation). */
export type DecisionMenuFailureReason =
  | "input_error"        // ui.input threw
  | "input_invalid"      // ui.input value rejected by validateBudgetValue (retryable, not audited)
  | "unknown_option"     // select returned a label that is not in the menu
  | "stage_not_found"    // choose_stage target label did not match a stage
  | "guard_rejected";    // executeDecision returned success:false

/** Result detail of a single menu presentation attempt (208 F1/F2). */
export interface MenuAttemptDetail {
  outcome: PromptDecisionOutcome;
  /** `decided` means "user picked"; `applied` means "state actually changed". */
  applied: boolean;
  /** Human-readable text (notify + command message). Never used as an audit code. */
  message?: string;
  /** Classification; written to `decision_not_applied.reason` when `decided && !applied`. */
  failureReason?: DecisionMenuFailureReason;
  unavailableReason?: DecisionMenuUnavailableReason;
  /** Interrupt happened in the choose_stage secondary menu (retry must go direct). */
  interruptedStage?: "primary" | "secondary";
  /**
   * Picked decision key (`set_budget`, `choose_stage`, …) when a label mapped
   * successfully. Used as the `decision` field of the `decision_not_applied`
   * audit; undefined for `unknown_option`.
   */
  decision?: string;
  /**
   * Overrides the default retry rule for this attempt (default:
   * `interrupted`, or `decided && !applied`). `false` suppresses retries for
   * non-recoverable failures such as a thrown `ui.input` dialog.
   */
  retryable?: boolean;
}

/** Options for a decision-menu presentation / scheduling call. */
export interface EnsureDecisionMenuOpts {
  /** Canonical values listed in {@link DecisionMenuSource}; legacy callers may omit. */
  source?: string;
  onStageChanged?: (freshMeta: SessionMeta) => Promise<void>;
  budgetValue?: number;
  directStageSelect?: boolean;
  /** Default true; tests/special entries may disable retries. */
  retryOnInterrupt?: boolean;
  retryPolicy?: { baseDelayMs?: number; maxDelayMs?: number };
  /**
   * Default true. The no-UI branch notifies the freeze reason itself. Command
   * entries pass `false` and own the single user-facing message (avoids the
   * double/contradictory notify described in Design_Review_1 #3).
   */
  notifyOnUnavailable?: boolean;
}

/** Result of an ensureDecisionMenu call (added by the Phase 1 scheduler). */
export interface EnsureDecisionMenuResult extends MenuAttemptDetail {
  /** A backoff retry has been armed for this pipeline. */
  retryArmed: boolean;
  /** Delay of the armed retry in ms (0/undefined when `retryArmed === false`). */
  retryDelayMs?: number;
  /** This call shared an in-flight presentation (no extra `ui.select`). */
  joined: boolean;
}

/** Injected by `flow-state` to keep the runtime module dependency-free. */
export interface DecisionMenuRuntimeDeps {
  readMeta: () => SessionMeta | undefined;
  isFrozen: (meta: SessionMeta) => boolean;
  present: (meta: SessionMeta, opts: EnsureDecisionMenuOpts, attempt: number) => Promise<MenuAttemptDetail>;
}

// ─── Input capability registry (Phase 0 task 1) ─────────────────────────────

/**
 * Pipelines where `ui.input` threw a dialog error. In-memory only (process
 * lifetime); keyed by `pipelineId`. A `restart` decision changes the
 * `pipelineId`, so stale entries naturally never affect new flows. Cleared
 * only by session shutdown (`session-shutdown.ts` → clearAllDecisionTimers)
 * and test resets — no proactive expiry.
 */
const inputUnavailablePipelines = new Set<string>();

/** Marks `ui.input` unusable for this pipeline after a thrown dialog. */
export function markInputUnavailable(pipelineId: string): void {
  inputUnavailablePipelines.add(pipelineId);
}

/** Whether `ui.input` is currently unusable for this pipeline. */
export function isInputUnavailable(pipelineId: string): boolean {
  return inputUnavailablePipelines.has(pipelineId);
}

/** Test/shutdown reset. */
export function clearInputCapabilityOverrides(): void {
  inputUnavailablePipelines.clear();
}
