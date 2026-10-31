/**
 * @module auto-pipeline/stop-policy
 * 219 Phase 5 §3 (H3 round 2): the two stop judgements are SEPARATE functions
 * with separate seams — a single `evaluateStop` reused in both places silently
 * turned a soft loop brake into a hard stop (and vice versa).
 *
 * - `evaluateHardStop` — evaluated wherever a settle/freeze happens (inside or
 *   outside a loop). Covers wall clock, blocked reasons, consecutive verify
 *   failures, unresolvable freezes and the historical freeze budget.
 * - `evaluateLoopBrake` — evaluated ONLY where a NEW develop/fix loop is about
 *   to be initiated. Grants `finalLoopGrace` (per doc) before it stops.
 * - `recordAutoAwareStageVisit` — the ±3-line wrapper the five loop-initiating
 *   `recordStageVisit` call sites use. Non-auto contexts pass through verbatim
 *   and `visit.ok` is NEVER rewritten (the max-loop-cycle semantics stay owned
 *   by `recordStageVisit`).
 *
 * `recordStageVisit` stays a pure utility — all sidecar writes happen here.
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import type { StageVisitResult } from "../../utils/stage-visit";
import { recordStageVisit } from "../../utils/stage-visit";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobState, AutoJobStopReason } from "./job-state";
import { writeJobState } from "./job-state";
import { readActiveJobContext } from "./config-overlay";
import { isUnresolvableFreeze } from "./freeze-autopilot";

export type HardStopVerdict =
  | { kind: "continue" }
  | { kind: "hard"; stopReason: AutoJobStopReason };

export type LoopBrakeVerdict =
  | { kind: "continue"; reason: "within_budget" }
  | { kind: "grace"; reason: "grace_granted" }
  | { kind: "soft"; stopReason: AutoJobStopReason };

/**
 * Hard stop — callable from settle AND from freeze handling. Order matters:
 * the concrete/现场 cause (unresolvable freeze) is reported before the
 * historical budget (`maxTotalFreezes`).
 */
export function evaluateHardStop(input: {
  state: AutoJobState;
  meta: SessionMeta;
  job: AutoJobConfig;
  now: number;
}): HardStopVerdict {
  const { state, meta, job, now } = input;
  const stop = job.stopConditions;

  if (stop.wallClockMs > 0 && now - state.startedAt > stop.wallClockMs) {
    return { kind: "hard", stopReason: "wall_clock" };
  }
  const blockedReason = meta.blockedReason;
  if (blockedReason && stop.stopOnBlockedReasons.includes(blockedReason)) {
    return { kind: "hard", stopReason: "blocked_reason" };
  }
  if (state.counters.consecutiveVerifyFailures >= stop.maxConsecutiveVerifyFailures) {
    return { kind: "hard", stopReason: "verify_failures" };
  }
  if (
    meta.flowState === "blocked" &&
    blockedReason &&
    isUnresolvableFreeze({ meta, job, state, reason: blockedReason })
  ) {
    return { kind: "hard", stopReason: "freeze_unresolvable" };
  }
  // 0 / unset = unlimited (same convention as wallClockMs).
  if (stop.maxTotalFreezes > 0 && state.counters.totalFreezes >= stop.maxTotalFreezes) {
    return { kind: "hard", stopReason: "freeze_budget_exhausted" };
  }
  return { kind: "continue" };
}

/**
 * Loop brake — only at a NEW develop/fix loop. Once `totalLoops` reaches the
 * budget the CURRENT doc gets `finalLoopGrace` extra loops (default 1) so it
 * can still reach completion; afterwards the loop stops (soft).
 */
export function evaluateLoopBrake(input: {
  state: AutoJobState;
  meta: SessionMeta;
  job: AutoJobConfig;
  docKey: string;
  now: number;
}): LoopBrakeVerdict {
  const { state, job, docKey } = input;
  const maxTotalLoops = job.stopConditions.maxTotalLoops;
  if (state.counters.totalLoops < maxTotalLoops) {
    return { kind: "continue", reason: "within_budget" };
  }
  const docCompleted = state.docs.some((d) => d.doc === docKey && d.status === "completed");
  const graceUsed = state.counters.finalGraceUsed[docKey] ?? 0;
  if (!docCompleted && graceUsed < job.stopConditions.finalLoopGrace) {
    state.counters.finalGraceUsed[docKey] = graceUsed + 1;
    return { kind: "grace", reason: "grace_granted" };
  }
  return { kind: "soft", stopReason: "budget_exhausted" };
}

export type AutoAwareVisitResult =
  | { kind: "visit"; visit: StageVisitResult }
  | { kind: "soft-stop"; verdict: LoopBrakeVerdict };

/**
 * Apply a soft stop at a loop-initiating call site: the doc is finalized
 * through the ONE transaction (release + audit + notify; no overlay rollback,
 * no lock release — the job continues with the next doc).
 */
export async function finalizeOnSoftStop(
  ctx: unknown,
  config: PipelineConfig,
  verdict: LoopBrakeVerdict,
): Promise<void> {
  const { finalizeCurrentDoc } = await import("./finalize");
  await finalizeCurrentDoc(ctx as never, config, { outcome: "failed", verdict });
}

/**
 * Persist a sidecar change made by a synchronous seam. Fire-and-forget with an
 * error log: the loop-brake decision must not become async (every call site is
 * a synchronous transition helper), and a failed write is surfaced, never
 * swallowed.
 */
function persistStateAsync(projectRoot: string, state: AutoJobState): void {
  void writeJobState(projectRoot, state).catch((err: unknown) => {
    console.error(`[auto-pipeline] stop-policy: failed persisting sidecar: ${String(err)}`);
  });
}

/**
 * Auto-aware wrapper for the five LOOP-INITIATING `recordStageVisit` sites.
 *
 * Properties:
 * 1. Non-auto (`resolveContext()` → null) → verbatim passthrough.
 * 2. Only a COUNTED edge into develop/fix evaluates the loop brake.
 * 3. `visit.ok` is never rewritten — max-loop-cycle freezing stays owned by
 *    `recordStageVisit`; a soft stop is a distinct `soft-stop` result.
 */
export function recordAutoAwareStageVisit(input: {
  meta: SessionMeta;
  nextStage: PipelineStage;
  maxCycles: number;
  /** Undefined in legacy/partial test contexts → treated as "not auto". */
  config: PipelineConfig | undefined;
  /** Test seam; defaults to the process-level lock + sidecar. */
  resolveContext?: () => { state: AutoJobState; job: AutoJobConfig } | null;
}): AutoAwareVisitResult {
  const visit = recordStageVisit(input.meta, input.nextStage, input.maxCycles, input.config);
  if (!input.config) return { kind: "visit", visit };
  const config = input.config;
  const context = input.resolveContext ? input.resolveContext() : readActiveJobContext(config.projectRoot);
  if (!context) return { kind: "visit", visit };

  const isLoopTarget = input.nextStage === "develop" || input.nextStage === "fix";
  if (!visit.counted || !isLoopTarget) return { kind: "visit", visit };

  const docKey =
    context.state.docs[context.state.docIndex]?.doc ?? String(context.state.docIndex);
  const verdict = evaluateLoopBrake({
    state: context.state,
    meta: input.meta,
    job: context.job,
    docKey,
    now: Date.now(),
  });
  // A grace grant mutates `finalGraceUsed`; a soft stop also mutates nothing
  // but the state is written once for both (single write point).
  if (verdict.kind === "grace") {
    persistStateAsync(config.projectRoot, context.state);
    return { kind: "visit", visit };
  }
  if (verdict.kind === "soft") {
    persistStateAsync(config.projectRoot, context.state);
    return { kind: "soft-stop", verdict };
  }
  return { kind: "visit", visit };
}
