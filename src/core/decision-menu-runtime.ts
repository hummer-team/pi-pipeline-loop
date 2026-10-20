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

// ─── Phase 1: scheduler runtime state ───────────────────────────────────────

import { safeWriteAuditLog } from "../utils/auditLog";

/** Base delay for the first retry (ms). Subsequent retries use exponential backoff. */
const RETRY_BASE_DELAY_MS = 5000;
/** Maximum delay cap for exponential backoff (ms). */
const RETRY_MAX_DELAY_MS = 60000;
/** Backoff multiplier for each retry. */
const RETRY_BACKOFF_FACTOR = 2;

/** Per-pipeline scheduler state (single-flight core + timer mutex). */
interface PipelineMenuRuntime {
  /** Shared promise of the in-flight presentation (single-flight core). */
  inflight?: { promise: Promise<EnsureDecisionMenuResult>; source: string };
  /** Pending backoff timer (never coexists with a second timer). */
  timer?: ReturnType<typeof setTimeout>;
  /** Options used by the retry loop (source/budgetValue/directStageSelect). */
  storedOpts?: EnsureDecisionMenuOpts;
  /** First non-empty aftermath callback among all joined callers (J2). */
  onStageChanged?: (freshMeta: SessionMeta) => Promise<void>;
  /** blockedReason snapshot of the most recent presentation (J6 change audit). */
  lastPresentedReason?: string;
  /**
   * Set by {@link clearAllDecisionTimers} (session shutdown). An in-flight
   * chain keeps its `rt` reference after the table entry is dropped, so this
   * flag is the only way to stop it from re-arming a timer OUTSIDE the table
   * (which would escape `clearDecisionTimer`/shutdown and double-fire).
   */
  disposed?: boolean;
}

const menuRuntime = new Map<string, PipelineMenuRuntime>();

/** 1-based retry index → 5s, 10s, 20s, 40s, 60s, 60s… */
function computeRetryDelayMs(
  retryIndex: number,
  policy?: EnsureDecisionMenuOpts["retryPolicy"],
): number {
  const base = policy?.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const cap = policy?.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  return Math.min(base * Math.pow(RETRY_BACKOFF_FACTOR, Math.max(0, retryIndex - 1)), cap);
}

function getOrCreateRuntime(pipelineId: string): PipelineMenuRuntime {
  let rt = menuRuntime.get(pipelineId);
  if (!rt) {
    rt = {};
    menuRuntime.set(pipelineId, rt);
  }
  return rt;
}

/**
 * Removes the table entry only when it is still THIS runtime object and
 * nothing is running for the pipeline. The identity check prevents a stale
 * chain that finishes later from pruning the newer runtime that replaced it
 * (e.g. a chain created after a shutdown clear); otherwise a live timer would
 * become unreachable from `clearDecisionTimer`/shutdown cleanup.
 */
function pruneRuntime(pipelineId: string, rt: PipelineMenuRuntime): void {
  if (menuRuntime.get(pipelineId) !== rt) return;
  if (!rt.timer && !rt.inflight) {
    menuRuntime.delete(pipelineId);
  }
}

/**
 * First-writer adoption for the choose_stage aftermath callback (J2): the
 * FIRST non-empty callback among all callers of one presentation chain wins.
 * Joiners' callbacks are adopted only when the chain has none yet (audited).
 */
function adoptCallback(
  pipelineId: string,
  rt: PipelineMenuRuntime,
  cb: ((freshMeta: SessionMeta) => Promise<void>) | undefined,
  source: string,
  auditOnAdopt: boolean,
): void {
  if (!cb || rt.onStageChanged) return;
  rt.onStageChanged = cb;
  if (auditOnAdopt) {
    void safeWriteAuditLog("decision_menu_join_callback_adopted", {
      pipelineId,
      source,
    });
  }
}

/**
 * Arms a pending backoff retry timer for the pipeline (208 G2/F3).
 * When the timer fires it re-reads the live meta, self-destructs on
 * ownership mismatch / resolution, skips while a presentation is already
 * in-flight, and otherwise re-enters the attempt loop with the STORED options
 * (source/budgetValue/directStageSelect preserved — F3 fix).
 */
function armRetry(
  deps: DecisionMenuRuntimeDeps,
  pipelineId: string,
  rt: PipelineMenuRuntime,
  retryIndex: number,
  opts: EnsureDecisionMenuOpts,
): number {
  // A cleared chain (shutdown) must never arm an untracked timer again.
  if (rt.disposed) return 0;
  const delay = computeRetryDelayMs(retryIndex, opts.retryPolicy);
  // Never orphan an already-armed timer (prevents double-fire races).
  if (rt.timer) {
    clearTimeout(rt.timer);
    rt.timer = undefined;
  }
  void safeWriteAuditLog("decision_menu_retry_armed", {
    pipelineId,
    attempt: String(retryIndex),
    delayMs: String(delay),
    source: opts.source ?? "menu",
  });
  rt.timer = setTimeout(() => {
    rt.timer = undefined;
    // The chain may have been invalidated while the timer was pending.
    if (rt.disposed) {
      pruneRuntime(pipelineId, rt);
      return;
    }
    // Re-read on fire: self-destruct on missing meta / unfrozen / pid mismatch
    // (same three guards as the legacy scheduler, C7 self-destruct semantics).
    const fresh = deps.readMeta();
    if (!fresh || fresh.pipelineId !== pipelineId || !deps.isFrozen(fresh)) {
      pruneRuntime(pipelineId, rt);
      return;
    }
    if (rt.inflight) {
      void safeWriteAuditLog("decision_menu_retry_skipped_inflight", {
        pipelineId,
        attempt: String(retryIndex),
      });
      return;
    }
    const retryOpts = rt.storedOpts ?? opts;
    const promise = attemptAndMaybeRetry(deps, pipelineId, rt, retryOpts, retryIndex + 1);
    rt.inflight = { promise, source: retryOpts.source ?? "menu" };
    void promise.finally(() => {
      if (rt.inflight?.promise === promise) rt.inflight = undefined;
      pruneRuntime(pipelineId, rt);
    });
  }, delay);
  return delay;
}

/**
 * One presentation attempt, plus (conditionally) one armed backoff retry.
 * The live meta is re-read on EVERY attempt so J6 reason changes (and any
 * other meta mutation) are always reflected in the next dialog.
 */
async function attemptAndMaybeRetry(
  deps: DecisionMenuRuntimeDeps,
  pipelineId: string,
  rt: PipelineMenuRuntime,
  opts: EnsureDecisionMenuOpts,
  attempt: number,
): Promise<EnsureDecisionMenuResult> {
  // Re-read on EVERY attempt (including timer-driven ones): J6 may have changed
  // blockedReason since the previous presentation, and a stale snapshot would
  // re-show the old reason.
  const live = deps.readMeta();
  if (!live || live.pipelineId !== pipelineId) {
    return {
      outcome: "no-menu",
      applied: false,
      unavailableReason: live ? "stale_pipeline" : "no_meta",
      retryArmed: false,
      joined: false,
    };
  }
  const detail = await deps.present(live, opts, attempt);
  // 208 Phase 1 fix: a shutdown clear may have invalidated this chain while the
  // dialog was open. Its retry must NOT be armed — the table entry is gone, so
  // the timer would be untracked and could double-fire alongside the
  // replacement chain (violates "at most one ui.select per pipelineId").
  if (rt.disposed) {
    return { ...detail, retryArmed: false, joined: false };
  }
  // J6 (as seen by the scheduler): a presentation against a DIFFERENT
  // freeze reason than the previous one is audited so reason drift is
  // observable even without a freeze call (the freeze site itself audited
  // the change too — duplicated entries are intentional noise reduction).
  if (
    rt.lastPresentedReason !== undefined
    && live.blockedReason !== undefined
    && live.blockedReason !== rt.lastPresentedReason
    && deps.isFrozen(live)
  ) {
    await safeWriteAuditLog("pipeline_block_reason_changed", {
      pipelineId,
      stage: live.currentStage,
      previousReason: rt.lastPresentedReason,
      reason: live.blockedReason,
    }, "warn");
  }
  rt.lastPresentedReason = live.blockedReason;
  const retryable = detail.retryable
    ?? (detail.outcome === "interrupted"
      || (detail.outcome === "decided" && !detail.applied)); // F2; input_error sets retryable:false explicitly (J3)
  if (!retryable || opts.retryOnInterrupt === false) {
    pruneRuntime(pipelineId, rt);
    return { ...detail, retryArmed: false, joined: false };
  }
  const post = deps.readMeta();
  if (!post || post.pipelineId !== pipelineId || !deps.isFrozen(post)) {
    pruneRuntime(pipelineId, rt);
    return { ...detail, retryArmed: false, joined: false };
  }
  // G5: a secondary-menu interrupt means the next attempt must go straight
  // to the stage list, skipping the interrupted primary menu.
  const nextOpts: EnsureDecisionMenuOpts = {
    ...opts,
    directStageSelect: detail.interruptedStage === "secondary" ? true : opts.directStageSelect,
  };
  rt.storedOpts = nextOpts;
  const delayMs = armRetry(deps, pipelineId, rt, attempt, nextOpts);
  return { ...detail, retryArmed: true, retryDelayMs: delayMs, joined: false };
}

/**
 * 208: single-flight scheduler for the decision menu (J4).
 * - one and only one live `ui.select` per pipelineId at any time (joiners
 *   await the same promise);
 * - at most one pending backoff timer, cleared before a direct call (G2);
 * - retries carry the first caller's source/budgetValue/directStageSelect (F3).
 */
export async function runDecisionMenu(
  deps: DecisionMenuRuntimeDeps,
  pipelineId: string,
  opts: EnsureDecisionMenuOpts = {},
): Promise<EnsureDecisionMenuResult> {
  const live = deps.readMeta();
  if (!live || live.pipelineId !== pipelineId) {
    // D4: a stale/orphaned call presents nothing and arms nothing.
    return {
      outcome: "no-menu",
      applied: false,
      unavailableReason: live ? "stale_pipeline" : "no_meta",
      retryArmed: false,
      joined: false,
    };
  }

  const rt = getOrCreateRuntime(pipelineId);
  const source = opts.source ?? "menu";

  if (rt.inflight) {
    // Single-flight join: share the in-flight presentation, adopt the joiner's
    // aftermath callback only when the chain has none yet (J2).
    adoptCallback(pipelineId, rt, opts.onStageChanged, source, true);
    void safeWriteAuditLog("decision_menu_joined_inflight", {
      pipelineId,
      source,
      joinedSource: rt.inflight.source,
    });
    return { ...(await rt.inflight.promise), joined: true };
  }

  // G2 timer mutex: a pending backoff timer never coexists with a direct call.
  if (rt.timer) {
    clearTimeout(rt.timer);
    rt.timer = undefined;
    void safeWriteAuditLog("decision_menu_retry_superseded", {
      pipelineId,
      source,
    });
  }

  adoptCallback(pipelineId, rt, opts.onStageChanged, source, false);
  // NOTE: `onStageChanged` is a live getter — a joiner adopting the FIRST
  // non-empty callback (J2) must be visible to the already-running attempt.
  rt.storedOpts = { ...opts, get onStageChanged() { return rt.onStageChanged; } };

  const promise = attemptAndMaybeRetry(deps, pipelineId, rt, rt.storedOpts, 1);
  rt.inflight = { promise, source };
  try {
    return await promise;
  } finally {
    if (rt.inflight?.promise === promise) rt.inflight = undefined;
    pruneRuntime(pipelineId, rt);
  }
}

/**
 * Legacy wrapper target: arms a direct backoff retry (no immediate
 * presentation), preserving the 172-G5 scheduler contract (attempts resume
 * with attemptIndex + 1 and stop on resolution).
 */
export function scheduleMenuRetry(
  deps: DecisionMenuRuntimeDeps,
  pipelineId: string,
  retryIndex: number,
  opts: EnsureDecisionMenuOpts = {},
): void {
  const rt = getOrCreateRuntime(pipelineId);
  // Prevent stacking (one timer per pipeline at a time).
  if (rt.timer) {
    clearTimeout(rt.timer);
    rt.timer = undefined;
  }
  adoptCallback(pipelineId, rt, opts.onStageChanged, opts.source ?? "menu", false);
  rt.storedOpts = { ...opts, get onStageChanged() { return rt.onStageChanged; } };
  armRetry(deps, pipelineId, rt, retryIndex, rt.storedOpts);
}

/**
 * Clears the pending decision retry timer for a specific pipeline (only the
 * timer — in-flight presentations are unaffected).
 */
export function clearDecisionTimer(pipelineId: string): void {
  const rt = menuRuntime.get(pipelineId);
  if (rt?.timer) {
    clearTimeout(rt.timer);
    rt.timer = undefined;
    pruneRuntime(pipelineId, rt);
  }
}

/**
 * Clears all decision retry timers, scheduler table entries and the input
 * capability registry. Called on session shutdown to prevent leaks.
 * In-flight chains are marked `disposed`: when their dialog finally resolves
 * they neither re-arm a retry nor prune a replacement runtime entry.
 */
export function clearAllDecisionTimers(): void {
  for (const rt of menuRuntime.values()) {
    // Invalidate in-flight chains BEFORE dropping the table: once their dialog
    // resolves they must not re-arm an untracked retry timer (see `disposed`).
    rt.disposed = true;
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = undefined;
    }
  }
  menuRuntime.clear();
  clearInputCapabilityOverrides();
}

/**
 * Test-only helper: number of pending decision retry timers.
 * @internal
 */
export function __decisionTimerCount(): number {
  let count = 0;
  for (const rt of menuRuntime.values()) {
    if (rt.timer) count++;
  }
  return count;
}

/**
 * Test-only helper: whether a timer exists for the given pipelineId.
 * @internal
 */
export function __hasDecisionTimer(pipelineId: string): boolean {
  return menuRuntime.get(pipelineId)?.timer !== undefined;
}
