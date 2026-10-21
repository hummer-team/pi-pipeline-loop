/**
 * @module stage-watchdog
 * 210 Phase 2 — opt-in dual stage watchdog (requirement 5.4, Q13=A / Q14=A).
 *
 * Two independent clocks protect ONE stage visit:
 * - `wall`: absolute ceiling `stageStartTime + stageTimeoutMs`. The basis is the
 *   PERSISTED stage start, so the ceiling survives a process restart.
 * - `idle`: no whitelisted progress event within `stageIdleTimeoutMs`
 *   (renewed lazily by {@link touchStageProgress}).
 *
 * Either clock converges the same way (Q14=A): one `stage_watchdog_timeout`
 * audit line, then `freezeAndPrompt(ctx, meta, "stage_timeout", config)`, which
 * hands the pipeline to the 5.3 decision-provider chain (human → policy →
 * abort). No new state, no new terminal path, no new menu shape.
 *
 * Timer ownership: the clocks live in the SHARED runtime table of
 * `decision-menu-runtime` (`armWatchdogTimers`), so shutdown / single-flight /
 * `disposed` semantics apply unchanged and there is no second timer registry.
 *
 * Dependency direction (plan Phase 2 task 2): this module MUST NOT import
 * `flow-state` as a VALUE — `flow-state` imports this module for the arm /
 * clear / touch hooks, so the freeze hand-off uses the established
 * dynamic-import cycle escape (`stage-advancer.ts:401` pattern). The
 * `flow-state` reference below is a TYPE-ONLY import (erased at compile time,
 * zero runtime edge); it exists so `WatchdogCtx` matches the freeze signature
 * exactly — `RuntimeCtx.session` is the rich `SessionState`, which the minimal
 * ctxs of the renewal points (FlowStateCtx / VerifyAdvanceCtx) cannot satisfy.
 */

import type { FlowStateCtx } from "./flow-state";
import type {
  PipelineConfig,
  SessionMeta,
  StageProgressSource,
  StageWatchdogKind,
} from "../types";
import type { StageWatchdogTimeoutInfo } from "./decision-menu-runtime";
import { DEFAULT_STAGE_IDLE_TIMEOUT_MS, DEFAULT_STAGE_TIMEOUT_MS } from "../constants";
import { isDormant, isFrozenMeta } from "./dormancy";
import { armWatchdogTimers, clearWatchdogTimers, touchWatchdogProgress } from "./decision-menu-runtime";
import { safeWriteAuditLog } from "../utils/auditLog";

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Minimal context the watchdog needs: the shared session (every guard re-reads
 * live meta from it) plus the optional notify surface the freeze hand-off uses.
 * `RuntimeCtx`, `FlowStateCtx` and `VerifyAdvanceCtx` are all assignable.
 */
export type WatchdogCtx = Pick<FlowStateCtx, "session" | "ui">;

/** Progress-event whitelist source (requirement 5.4), re-exported for callers. */
export type { StageProgressSource as ProgressSource } from "../types";

// ─── Config resolution ──────────────────────────────────────────────────────

/**
 * Resolves the two effective thresholds, or `undefined` when the watchdog is
 * off. `enabled` must be exactly `true` (requirement 5.2: unlike
 * `decisionPolicy`, a mere block presence does NOT arm the clocks).
 *
 * The loader already guarantees `stageIdleTimeoutMs < stageTimeoutMs` for a
 * configured pair (210 Phase 2 task 5); the `Math.min` clamp here keeps a
 * directly-constructed config (tests, embedders) from arming an idle clock that
 * is longer than its own absolute ceiling.
 *
 * `config` may legitimately be absent at RUNTIME even though callers type it as
 * required (hand-constructed or test-double ctxs, e.g. `applyVerifyPass` fed a
 * ctx cast through `as any`). An absent config means "nothing configured", so it
 * behaves exactly like the disabled case — arming nothing is always safe, while
 * throwing here would break the stage advance path that called us.
 */
function resolveWatchdogThresholds(
  config: PipelineConfig | undefined,
): { wallMs: number; idleMs: number } | undefined {
  const watchdog = config?.watchdog;
  if (watchdog?.enabled !== true) return undefined;
  const wallMs = watchdog.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const idleMs = watchdog.stageIdleTimeoutMs ?? DEFAULT_STAGE_IDLE_TIMEOUT_MS;
  return { wallMs, idleMs: Math.min(idleMs, wallMs) };
}

// ─── Timeout handler ────────────────────────────────────────────────────────

/**
 * Converges one fired clock (fire-and-forget from the timer callback).
 *
 * The pair is cleared FIRST (before any guard), then LIVE meta — never the
 * arm-time snapshot — is re-read and checked:
 * 1. meta exists and carries the SAME `pipelineId` (a rebound / restarted
 *    pipeline is foreign to this clock),
 * 2. the pipeline is still an ACTIVE running visit — dormant (never started,
 *    aborted, completed) or frozen pipelines belong to other consumers
 *    (acceptance: 「冻结中（`blocked`）不再触发看门狗」, so a clock can never
 *    double-action against the decision chain it already woke),
 * 3. the clock's `stageKey` still matches the live `stageStartTime` (the visit
 *    it was armed for has not been replaced).
 */
async function handleStageWatchdogTimeout(
  ctx: WatchdogCtx,
  config: PipelineConfig,
  pipelineId: string,
  kind: StageWatchdogKind,
  info: StageWatchdogTimeoutInfo,
): Promise<void> {
  const meta = ctx.session.getMeta() as SessionMeta | undefined;
  // A fired clock ends this visit's pair NO MATTER what happens next. Even when
  // the guards below drop the action (dormant / frozen / foreign pipeline), the
  // surviving clock would otherwise stay live only to fire again against the
  // same conditions, and the half-consumed pair would suppress re-arming when
  // the human unfreezes the stage (`stageKey` unchanged → early return).
  clearWatchdogTimers(pipelineId);
  if (!meta || meta.pipelineId !== pipelineId) return;
  if (isDormant(meta) || isFrozenMeta(meta)) return;
  // Stale-visit guard: `stageKey` carries the `stageStartTime` the clock was
  // armed under. Any transition path that rewrote it (including ones without a
  // dedicated re-arm hook) means this clock belongs to a FINISHED visit, so it
  // must not freeze the new one — that is what keeps the watchdog free of false
  // positives, and the next arm owns the new visit's pair.
  if (`${pipelineId}:${meta.stageStartTime || "unset"}` !== info.stageKey) return;

  const stageAgeMs = Date.now() - (meta.stageStartTime || Date.now());
  // `elapsedMs` is the elapsed value of the clock that actually fired (5.4).
  const elapsedMs = kind === "wall" ? stageAgeMs : info.progressAgeMs;

  await safeWriteAuditLog("stage_watchdog_timeout", {
    pipelineId,
    stage: meta.currentStage,
    kind,
    elapsedMs: String(elapsedMs),
    stageAgeMs: String(stageAgeMs),
    lastProgressSource: info.lastProgressSource ?? "none",
  }, "warn");

  try {
    // Cycle escape (plan Phase 2 task 2): flow-state statically imports this
    // module for the arm/clear hooks, so the freeze hand-off must be dynamic.
    const { freezeAndPrompt } = await import("./flow-state");
    await freezeAndPrompt(ctx, meta, "stage_timeout", config);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Fail-open with an error audit: a fired clock that cannot freeze must at
    // least be visible, never silently swallowed.
    await safeWriteAuditLog("stage_watchdog_freeze_error", {
      pipelineId,
      stage: meta.currentStage,
      kind,
      error: errMsg,
    }, "error");
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Arms — or idempotently keeps — the two stage clocks of the CURRENT visit.
 *
 * Clears instead of arming (and returns) when: there is no meta / no
 * pipelineId (never started), `watchdog.enabled !== true` (opt-in switch,
 * constraint 4: zero timers for unconfigured projects), or the pipeline is
 * dormant / frozen (the decision chain owns it).
 *
 * Safe to call on every settle, advance and decision: `stageKey`
 * (`pipelineId:stageStartTime`) makes the arm idempotent per visit, and a stage
 * change (which always rewrites `stageStartTime`) replaces the previous pair —
 * acceptance 「阶段推进后旧计时器被清理、新阶段重新武装」.
 *
 * @param opts.progressSource - Whitelisted source to attribute to the armed idle
 *   clock. A stage advance re-arms with `stageStartTime = Date.now()`, which
 *   replaces the pair and resets the progress bookkeeping; passing the source
 *   keeps `stage_watchdog_timeout.lastProgressSource` meaningful instead of
 *   `"none"` for a visit that has produced no other event yet.
 */
export function armStageWatchdog(
  ctx: WatchdogCtx,
  config: PipelineConfig,
  opts?: { progressSource?: StageProgressSource },
): void {
  const meta = ctx.session.getMeta() as SessionMeta | undefined;
  const pipelineId = meta?.pipelineId;
  if (!pipelineId) return;

  const thresholds = resolveWatchdogThresholds(config);
  if (!thresholds || isDormant(meta) || isFrozenMeta(meta)) {
    clearWatchdogTimers(pipelineId);
    return;
  }

  const now = Date.now();
  const stageStartMs = meta.stageStartTime || now;
  const stageKey = `${pipelineId}:${meta.stageStartTime || "unset"}`;
  const remainingMs = thresholds.wallMs - (now - stageStartMs);
  // A ceiling that is ALREADY spent at arm time gets a fresh full window
  // instead of firing on the next tick. That happens when a frozen pipeline is
  // resumed (the waiting time elapsed against the same stage visit) or when a
  // clock is re-armed after having fired once — in both cases an instant
  // re-freeze would make the human's "continue this stage" impossible to honour.
  const wallDelayMs = remainingMs > 0 ? remainingMs : thresholds.wallMs;

  armWatchdogTimers(pipelineId, {
    stageKey,
    wallDelayMs,
    idleDelayMs: thresholds.idleMs,
    ...(opts?.progressSource ? { progressSource: opts.progressSource } : {}),
    onTimeout: (kind, info) => {
      void handleStageWatchdogTimeout(ctx, config, pipelineId, kind, info);
    },
  });
}

/**
 * Records stage progress from the 5.4 whitelist. Renews the IDLE clock only —
 * the wall clock is an absolute ceiling by design (Q13=A). No-op when no clock
 * is armed, so while the feature is disabled every renewal point costs one
 * missed map lookup and nothing else (constraint 4).
 */
export function touchStageProgress(
  pipelineId: string | undefined,
  source: StageProgressSource,
): void {
  if (!pipelineId) return;
  touchWatchdogProgress(pipelineId, source);
}

/**
 * Clears both stage clocks (terminal transition: abort / restart / shutdown
 * helper / stale recovery). Idempotent, and it never touches the decision
 * deadline or the menu backoff timer (independent registry fields).
 */
export function clearStageWatchdog(pipelineId: string | undefined): void {
  if (!pipelineId) return;
  clearWatchdogTimers(pipelineId);
}
