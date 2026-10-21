/**
 * 210 Phase 2 — opt-in dual stage watchdog (requirement 5.4, Q13=A / Q14=A).
 *
 * Coverage (plan Phase 2 「单元测试目标」 + acceptance list):
 * - `watchdog` unconfigured / `enabled !== true` → not a single clock is armed
 * - the two clock kinds fire (`wall` / `idle`) and report the whitelisted source
 * - idle renewal by progress vs. the wall ceiling that progress cannot postpone
 * - idempotent per-visit arming, `stageStartTime` change → pair replacement,
 *   and the stale-arm guard (a clock never freezes a visit it was not armed for)
 * - dormant / frozen / foreign pipelines neither arm nor fire
 * - shutdown cleanup through the shared timer registry
 * - freeze converges with BASELINE semantics while `decisionPolicy` is unset
 *   (blocked + menu path, no provider chain, no abort)
 * - loader normalization of the threshold pair (plan Phase 2 task 5)
 *
 * Timing: Bun's `setSystemTime` fakes `Date` but NOT the `setTimeout` clock, so
 * these cases use real short timers and poll for the observable outcome (same
 * approach as `decision-policy.test.ts`). Every case owns a unique pipelineId:
 * `menuRuntime` is a process-global table shared with the other test files, so
 * only per-pipeline state is asserted — never an absolute global count.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { performance } from "node:perf_hooks";
import type { PipelineConfig, SessionMeta, StageProgressSource, WatchdogConfig } from "../../types";
import type { FlowStateCtx } from "../../core/flow-state";
import { makeTestConfig, makeTestMeta } from "../helpers";
import {
  armStageWatchdog,
  clearStageWatchdog,
  touchStageProgress,
} from "../../core/stage-watchdog";
import {
  __hasStageWatchdog,
  __stageWatchdogCount,
  __stageWatchdogState,
  clearAllDecisionTimers,
} from "../../core/decision-menu-runtime";
import { executeDecision, freezeAndPrompt, markPipelineAborted } from "../../core/flow-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { DEFAULT_STAGE_IDLE_TIMEOUT_MS, DEFAULT_STAGE_TIMEOUT_MS } from "../../constants";

// ─── Harness ────────────────────────────────────────────────────────────────

/** One captured audit record (in-memory override — no file/routing dependency). */
interface CapturedAudit {
  event: string;
  fields: Record<string, string | boolean>;
  level?: string;
}

let audits: CapturedAudit[] = [];

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, fields: (message ?? {}) as Record<string, string | boolean>, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
});

/** Monotonic counter → unique pipelineId per case (shared global timer table). */
let idCounter = 0;
function uniquePipelineId(): string {
  idCounter++;
  return `pipe-wd-test-${idCounter}`;
}

/** Config with a watchdog block; `enabled` is opt-in, so the helper sets it. */
function watchdogConfig(watchdog: WatchdogConfig): PipelineConfig {
  return makeTestConfig({ watchdog });
}

/**
 * Flow ctx WITHOUT a ui surface. The watchdog must never depend on the menu:
 * a freeze it triggers has to converge even headless (requirement 5.4 / R6).
 */
function makeWatchdogCtx(
  meta: SessionMeta,
): FlowStateCtx & { updates: Partial<SessionMeta>[] } {
  const updates: Partial<SessionMeta>[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        updates.push(patch);
        Object.assign(meta, patch);
        return meta;
      },
    },
    // Registry writes of the restart/abort paths are skipped when absent.
    _ctx: {
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
      },
    } as unknown as FlowStateCtx["_ctx"],
    updates,
  };
}

/** Running-state meta with a fresh stage visit and its own pipelineId. */
function runningMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    pipelineId: uniquePipelineId(),
    currentStage: "develop",
    flowState: "running",
    stageStartTime: Date.now(),
    ...overrides,
  });
}

/** Polls an observable outcome instead of sleeping a fixed budget (CI-safe). */
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

/** Sleep helper for the "did NOT happen" assertions. */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** All watchdog timeout records of one pipeline. */
function timeoutRecords(pipelineId: string): CapturedAudit[] {
  return audits.filter(
    (a) => a.event === "stage_watchdog_timeout" && a.fields["pipelineId"] === pipelineId,
  );
}

/** The `kind` field of a timeout record must be one of the two clock names. */
function isWatchdogKind(kind: string | boolean | undefined): boolean {
  return kind === "wall" || kind === "idle";
}

// ─── Opt-in switch (acceptance: 未配置零计时器) ────────────────────────────────

describe("stage watchdog — opt-in switch (T2.1)", () => {
  it("arms nothing when the watchdog block is absent", () => {
    const baseline = __stageWatchdogCount();
    const meta = runningMeta();
    const ctx = makeWatchdogCtx(meta);

    armStageWatchdog(ctx, makeTestConfig());

    expect(__hasStageWatchdog(meta.pipelineId!)).toBe(false);
    expect(__stageWatchdogState(meta.pipelineId!).armed).toBe(false);
    expect(__stageWatchdogCount()).toBe(baseline);
  });

  it("arms nothing for a block presence without enabled=true (requirement 5.2)", () => {
    // Unlike `decisionPolicy` ("configured = effective"), the watchdog needs the
    // explicit switch — a half-written block must not start timers.
    const cases: WatchdogConfig[] = [
      {},
      { stageTimeoutMs: 40, stageIdleTimeoutMs: 20 },
      { enabled: false, stageTimeoutMs: 40, stageIdleTimeoutMs: 20 },
    ];
    for (const watchdog of cases) {
      const meta = runningMeta();
      const ctx = makeWatchdogCtx(meta);
      armStageWatchdog(ctx, watchdogConfig(watchdog));
      expect(__hasStageWatchdog(meta.pipelineId!)).toBe(false);
    }
  });

  it("arms a pair once enabled, and disarming later clears the live pair", () => {
    const meta = runningMeta();
    const ctx = makeWatchdogCtx(meta);

    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 }));
    expect(__hasStageWatchdog(meta.pipelineId!)).toBe(true);

    // A config that turns the feature off must not leave an orphan clock behind.
    armStageWatchdog(ctx, makeTestConfig());
    expect(__hasStageWatchdog(meta.pipelineId!)).toBe(false);
  });

  it("ignores a pipeline that has no pipelineId yet (never started)", () => {
    const baseline = __stageWatchdogCount();
    const meta = makeTestMeta({ pipelineId: undefined, currentStage: "plan" });
    const ctx = makeWatchdogCtx(meta);

    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 40, stageIdleTimeoutMs: 20 }));

    expect(__stageWatchdogCount()).toBe(baseline);
    expect(() => touchStageProgress(undefined, "tool")).not.toThrow();
    expect(() => clearStageWatchdog(undefined)).not.toThrow();
  });

  it("costs nothing at the renewal points while disabled", () => {
    const meta = runningMeta();
    // No arm happened (feature off) → every whitelisted source is a missed lookup.
    for (const source of ["verify", "spawn", "settle", "stage_advance", "tool", "menu"] as StageProgressSource[]) {
      expect(() => touchStageProgress(meta.pipelineId, source)).not.toThrow();
    }
    expect(__hasStageWatchdog(meta.pipelineId!)).toBe(false);
  });
});

// ─── Firing and the two renewal rules (Q13=A) ─────────────────────────────────

describe("stage watchdog — firing and renewal (T2.2)", () => {
  it("idle clock fires on silence and audits kind=idle with the last source", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 40 }));
    touchStageProgress(id, "tool");

    await waitUntil(() => timeoutRecords(id).length > 0);
    const record = timeoutRecords(id)[0];
    expect(record.level).toBe("warn");
    expect(record.fields["kind"]).toBe("idle");
    expect(record.fields["stage"]).toBe("develop");
    expect(record.fields["lastProgressSource"]).toBe("tool");
    expect(Number(record.fields["elapsedMs"])).toBeGreaterThanOrEqual(0);
    // Freeze hand-off (Q14=A): baseline blocked state with the watchdog reason.
    await waitUntil(() => meta.flowState === "blocked");
    expect(meta.blockedReason).toBe("stage_timeout");
  });

  it("reports lastProgressSource=none when nothing ever renewed the clock", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 40 }));

    await waitUntil(() => timeoutRecords(id).length > 0);
    expect(timeoutRecords(id)[0].fields["lastProgressSource"]).toBe("none");
  });

  it("wall clock fires although progress kept arriving (Q13=A: progress cannot postpone the ceiling)", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    // Idle window is longer than the wall ceiling would allow to matter: progress
    // renews only the idle clock, so the wall clock must be the one that fires.
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 80, stageIdleTimeoutMs: 60 }));

    for (let i = 0; i < 5; i++) {
      await sleep(15);
      touchStageProgress(id, "settle");
    }

    await waitUntil(() => timeoutRecords(id).length > 0);
    const record = timeoutRecords(id)[0];
    expect(record.fields["kind"]).toBe("wall");
    expect(record.fields["lastProgressSource"]).toBe("settle");
    expect(Number(record.fields["elapsedMs"])).toBeGreaterThanOrEqual(0);
    expect(Number(record.fields["stageAgeMs"])).toBeGreaterThanOrEqual(0);
  });

  it("idle clock renews while progress keeps up — no fire, clock stays armed", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 50 }));

    for (let i = 0; i < 6; i++) {
      await sleep(20);
      touchStageProgress(id, "verify");
    }

    expect(timeoutRecords(id)).toHaveLength(0);
    expect(__hasStageWatchdog(id)).toBe(true);
  });

  it("a fired clock consumes the WHOLE pair so a later visit can re-arm", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    // The idle clock fires first; the long wall clock must go with it, otherwise
    // the surviving half would suppress the re-arm of the next visit.
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 40 }));

    await waitUntil(() => timeoutRecords(id).length > 0);
    expect(__hasStageWatchdog(id)).toBe(false);
    expect(__stageWatchdogState(id).armed).toBe(false);
  });

  it("clearStageWatchdog consumes the windows so nothing fires afterwards", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 40, stageIdleTimeoutMs: 40 }));
    expect(__hasStageWatchdog(id)).toBe(true);

    clearStageWatchdog(id);

    expect(__hasStageWatchdog(id)).toBe(false);
    await sleep(90);
    expect(timeoutRecords(id)).toHaveLength(0);
    expect(meta.flowState).toBe("running");
  });
});

// ─── Idempotent arming, stage boundaries, stale arms ─────────────────────────

describe("stage watchdog — re-arm semantics (T2.3)", () => {
  it("re-arming the same stage visit is a no-op (a settle burst cannot extend the ceiling)", () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    const config = watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 });

    armStageWatchdog(ctx, config, { progressSource: "settle" });
    const first = __stageWatchdogState(id);
    expect(first.armed).toBe(true);
    expect(first.lastProgressSource).toBe("settle");

    // A duplicate arm of the SAME visit (extra hook, repeated settle) must not
    // move the idle basis nor re-attribute the source.
    armStageWatchdog(ctx, config, { progressSource: "verify" });
    const second = __stageWatchdogState(id);
    expect(second.stageKey).toBe(first.stageKey);
    expect(second.lastProgressAt).toBe(first.lastProgressAt);
    expect(second.lastProgressSource).toBe("settle");
  });

  it("attributes the arm to the whitelisted source of the triggering event", () => {
    const meta = runningMeta();
    const ctx = makeWatchdogCtx(meta);
    // A stage advance re-arms before any other progress event exists, so the
    // arm itself carries the attribution (otherwise the audit would say "none").
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 }), {
      progressSource: "stage_advance",
    });
    expect(__stageWatchdogState(meta.pipelineId!).lastProgressSource).toBe("stage_advance");
  });

  it("a stage change (new stageStartTime) replaces the pair", () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    const config = watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 });

    armStageWatchdog(ctx, config);
    const firstKey = __stageWatchdogState(id).stageKey;
    expect(firstKey).toBe(`${id}:${meta.stageStartTime}`);

    meta.stageStartTime = Date.now() + 5000;
    meta.currentStage = "review";
    armStageWatchdog(ctx, config);

    const second = __stageWatchdogState(id);
    expect(second.stageKey).toBe(`${id}:${meta.stageStartTime}`);
    expect(second.stageKey).not.toBe(firstKey);
    expect(second.armed).toBe(true);
  });

  it("a stale clock never freezes the visit that replaced it (no false positive)", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 40, stageIdleTimeoutMs: 40 }));

    // Transition WITHOUT a watchdog hook (e.g. pipeline-start / handoff): the
    // stage identity moved on, the clocks are still live for the old visit.
    meta.currentStage = "review";
    meta.stageStartTime = Date.now() + 60000;

    await waitUntil(() => __hasStageWatchdog(id) === false);
    expect(timeoutRecords(id)).toHaveLength(0);
    expect(meta.flowState).toBe("running");
    // And the new visit can be armed normally afterwards.
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 }));
    expect(__stageWatchdogState(id).stageKey).toBe(`${id}:${meta.stageStartTime}`);
  });

  it("gives a spent ceiling a fresh full window instead of firing on the next tick", async () => {
    // A frozen stage resumed by the human (Q14=A) — and any re-arm after a fire
    // — would otherwise re-freeze instantly, making "continue this stage" useless.
    const meta = runningMeta({ stageStartTime: Date.now() - 20000 });
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 60, stageIdleTimeoutMs: 60 }));

    await sleep(30);
    expect(timeoutRecords(id)).toHaveLength(0);
    await waitUntil(() => timeoutRecords(id).length > 0);
    // The audit still reports the TRUE stage age (it never pretends to be fresh).
    expect(Number(timeoutRecords(id)[0].fields["stageAgeMs"])).toBeGreaterThanOrEqual(20000);
  });

  it("tolerates a missing stageStartTime (treated as now, key 'unset')", () => {
    const meta = makeTestMeta({
      pipelineId: uniquePipelineId(),
      currentStage: "develop",
      flowState: "running",
      stageStartTime: undefined as unknown as number,
    });
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 }));
    expect(__stageWatchdogState(meta.pipelineId!).stageKey).toBe(`${meta.pipelineId}:unset`);
  });
});

// ─── Dormancy / freeze guards (acceptance: 冻结中不再触发) ────────────────────

describe("stage watchdog — dormancy and freeze guards (T2.4)", () => {
  it("arms nothing for a dormant pipeline (completed, aborted, or never started)", () => {
    const config = watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 });
    const cases: Partial<SessionMeta>[] = [
      { currentStage: "completed" },
      { flowState: "aborted" },
      { pipelineId: undefined },
    ];
    for (const override of cases) {
      const meta = runningMeta(override);
      const ctx = makeWatchdogCtx(meta);
      armStageWatchdog(ctx, config);
      expect(__hasStageWatchdog(meta.pipelineId ?? "none")).toBe(false);
    }
  });

  it("arms nothing for every frozen shape (blocked, aborted, legacy terminated, awaiting_human)", () => {
    const config = watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 });
    const frozenCases: Partial<SessionMeta>[] = [
      { flowState: "blocked", blockedReason: "loop_overflow" },
      { flowState: "aborted" },
      { flowState: undefined, terminated: true },
      { currentStage: "awaiting_human" },
    ];
    for (const override of frozenCases) {
      const meta = runningMeta(override);
      const ctx = makeWatchdogCtx(meta);
      armStageWatchdog(ctx, config);
      expect(__hasStageWatchdog(meta.pipelineId!)).toBe(false);
    }
  });

  it("a fired clock while the pipeline is frozen writes no audit and keeps the existing reason", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 40 }));

    // An existing decision point takes over the pipeline; the clocks of the
    // previous arm are still live, so the fire-time guard must drop the action.
    await freezeAndPrompt(ctx, meta, "loop_overflow", watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 40 }));
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("loop_overflow");

    await sleep(120);
    expect(timeoutRecords(id)).toHaveLength(0);
    expect(meta.blockedReason).toBe("loop_overflow");
    expect(__hasStageWatchdog(id)).toBe(false);
  });

  it("never overwrites a pipeline the decision chain already converged to abort", async () => {
    const meta = runningMeta({ flowState: "aborted", terminated: true });
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 40, stageIdleTimeoutMs: 40 }));

    await sleep(90);
    expect(timeoutRecords(meta.pipelineId!)).toHaveLength(0);
    expect(meta.flowState).toBe("aborted");
  });

  it("drops the action when the pipelineId moved on (restart rebind races the clock)", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 40, stageIdleTimeoutMs: 40 }));

    // Same session object, foreign pipeline (the arm-time id no longer matches).
    meta.pipelineId = uniquePipelineId();

    await waitUntil(() => __hasStageWatchdog(id) === false);
    expect(timeoutRecords(id)).toHaveLength(0);
    expect(meta.flowState).toBe("running");
  });
});

// ─── Shutdown cleanup (acceptance: session_shutdown 后计数为 0) ───────────────

describe("stage watchdog — shared registry teardown (T2.5)", () => {
  it("clearAllDecisionTimers consumes watchdog clocks and they never fire", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 40, stageIdleTimeoutMs: 40 }));
    expect(__hasStageWatchdog(id)).toBe(true);

    clearAllDecisionTimers();

    expect(__hasStageWatchdog(id)).toBe(false);
    await sleep(90);
    expect(timeoutRecords(id)).toHaveLength(0);
    expect(meta.flowState).toBe("running");
  });

  it("returns the global watchdog count to its baseline after teardown", () => {
    const baseline = __stageWatchdogCount();
    const ids = [uniquePipelineId(), uniquePipelineId()];
    for (const id of ids) {
      const meta = runningMeta({ pipelineId: id });
      armStageWatchdog(makeWatchdogCtx(meta), watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 }));
    }
    expect(__stageWatchdogCount()).toBe(baseline + 2);

    clearAllDecisionTimers();
    expect(__stageWatchdogCount()).toBe(baseline);
  });

  it("an abort transition clears the stage clocks", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 }));
    expect(__hasStageWatchdog(id)).toBe(true);

    await markPipelineAborted(ctx, "user_abort");

    expect(__hasStageWatchdog(id)).toBe(false);
  });

  it("a late progress report after teardown does not resurrect the clocks", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 40, stageIdleTimeoutMs: 40 }));
    clearAllDecisionTimers();
    expect(__hasStageWatchdog(id)).toBe(false);

    // A late progress report must not resurrect anything.
    touchStageProgress(id, "tool");
    await sleep(80);
    expect(__hasStageWatchdog(id)).toBe(false);
    expect(timeoutRecords(id)).toHaveLength(0);
  });

  it("accepts a fresh arm after teardown (a resumed pipeline must be protected again)", () => {
    // Boundary of the rule above: teardown drops the whole registry entry, so the
    // NEXT arm legitimately creates one — that is how a pipeline resumed after a
    // shutdown/restart cycle gets its clocks back.
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    const config = watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 });

    armStageWatchdog(ctx, config);
    clearAllDecisionTimers();
    expect(__hasStageWatchdog(id)).toBe(false);

    armStageWatchdog(ctx, config);
    expect(__stageWatchdogState(id).armed).toBe(true);
    expect(__stageWatchdogState(id).stageKey).toBe(`${id}:${meta.stageStartTime}`);
  });
});

// ─── Freeze converges with baseline semantics when no policy is configured ────

describe("stage watchdog — freeze path without decisionPolicy (acceptance 2)", () => {
  it("ends in flowState=blocked with no provider chain and no abort", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    const config = watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 40 });
    expect(config.decisionPolicy).toBeUndefined();

    armStageWatchdog(ctx, config);
    await waitUntil(() => meta.flowState === "blocked");

    expect(meta.blockedReason).toBe("stage_timeout");
    expect(meta.flowState).not.toBe("aborted");
    // Timeout audit precedes the baseline freeze audit.
    expect(timeoutRecords(id)[0].fields["kind"]).toBe("idle");
    expect(audits.some((a) => a.event === "pipeline_blocked")).toBe(true);
    // The 5.3 chain is NOT entered: no policy application, no rejection, and the
    // baseline no-UI menu exit is what carries the freeze instead.
    expect(audits.some((a) => a.event === "policy_decision_rejected")).toBe(false);
    expect(audits.some((a) => a.event === "decision_not_applied")).toBe(false);
    expect(audits.some((a) => a.event === "pipeline_decision")).toBe(false);
    expect(audits.some((a) => a.event === "pipeline_session_aborted")).toBe(false);
    // Baseline audits carry no decision-policy fields (unconfigured → verbatim).
    const blocked = audits.find((a) => a.event === "pipeline_blocked")!;
    expect(blocked.fields["decisionWaitMs"]).toBeUndefined();
    expect(blocked.fields["policyEnabled"]).toBeUndefined();
  });

  it("times out only once per stage visit (no repeat against the frozen pipeline)", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 25, stageIdleTimeoutMs: 25 }));

    await waitUntil(() => timeoutRecords(id).length > 0);
    await sleep(120);
    expect(timeoutRecords(id)).toHaveLength(1);
    expect(meta.flowState).toBe("blocked");
  });

  it("resume of a watchdog-frozen stage re-arms the clocks for the continued visit", async () => {
    const now = Date.now();
    // Q14=A: resume keeps stageStartTime (the visit continues), yet the fired
    // clock consumed the pair, so the arm hook must give it a fresh window.
    const meta = runningMeta({
      flowState: "blocked",
      blockedReason: "stage_timeout",
      stageStartTime: now,
    });
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    expect(__hasStageWatchdog(id)).toBe(false);

    const result = await executeDecision(ctx, meta, "resume", watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 5000 }));

    expect(result.success).toBe(true);
    expect(meta.flowState).toBe("running");
    expect(meta.blockedReason).toBeUndefined();
    expect(meta.stageStartTime).toBe(now);
    expect(__stageWatchdogState(id).stageKey).toBe(`${id}:${now}`);
  });

  it("a stage advance re-arms and the audit of the next fire names the new stage", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    const config = watchdogConfig({ enabled: true, stageTimeoutMs: 5000, stageIdleTimeoutMs: 40 });
    armStageWatchdog(ctx, config, { progressSource: "stage_advance" });

    // Advance to the next stage and re-arm, as stage-advancer does.
    meta.currentStage = "review";
    meta.stageStartTime = Date.now();
    clearStageWatchdog(id);
    armStageWatchdog(ctx, config, { progressSource: "stage_advance" });

    await waitUntil(() => timeoutRecords(id).length > 0);
    expect(timeoutRecords(id)[0].fields["stage"]).toBe("review");
    expect(timeoutRecords(id)[0].fields["lastProgressSource"]).toBe("stage_advance");
  });
});

// ─── Loader normalization (plan Phase 2 task 5) ──────────────────────────────

describe("watchdog config — loader threshold normalization (T2.5)", () => {
  /** Captures console.warn while resolving one JSON document. */
  function resolveWithWarnings(json: Record<string, unknown>): { config: PipelineConfig; warnings: string[] } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      return { config: resolvePipelineConfig(json as never), warnings };
    } finally {
      console.warn = original;
    }
  }

  function baseJson(watchdog: Record<string, unknown>): Record<string, unknown> {
    return {
      stages: {
        clarify: { nextStage: "plan" },
        plan: { nextStage: "develop" },
        develop: { nextStage: "review" },
        review: { nextStage: "fix" },
        fix: { nextStage: "completed" },
        completed: { nextStage: null },
      },
      watchdog,
    };
  }

  it("keeps a consistent enabled pair untouched", () => {
    const { config, warnings } = resolveWithWarnings(
      baseJson({ enabled: true, stageTimeoutMs: 1500, stageIdleTimeoutMs: 400 }),
    );
    expect(config.watchdog).toEqual({ enabled: true, stageTimeoutMs: 1500, stageIdleTimeoutMs: 400 });
    expect(warnings).toHaveLength(0);
  });

  it("drops BOTH overrides when the explicit pair contradicts, so the defaults apply", () => {
    const { config, warnings } = resolveWithWarnings(
      baseJson({ enabled: true, stageTimeoutMs: 1000, stageIdleTimeoutMs: 4000 }),
    );
    expect(config.watchdog).toEqual({ enabled: true });
    expect(warnings.some((w) => w.includes("must be < stageTimeoutMs"))).toBe(true);
  });

  // 210 review issue 5 (plan Phase 2 task 5 / requirement 5.2): a contradiction
  // on EITHER side — including a half-specified one whose missing side defaults
  // to a value that makes `idle >= wall` — falls back to the DEFAULT PAIR.
  // Clamping idle onto the wall used to produce `idle === wall`, i.e. two
  // timers firing in the same tick (double `stage_watchdog_timeout` + double
  // freeze), so the ceiling is never used as a clamp target.
  it("falls back to the default pair when a half-specified contradiction arises", () => {
    const { config, warnings } = resolveWithWarnings(
      baseJson({ enabled: true, stageIdleTimeoutMs: DEFAULT_STAGE_TIMEOUT_MS + 1 }),
    );
    // The oversized idle override is dropped; the never-configured wall is not
    // invented either, so both thresholds come from the defaults.
    expect(config.watchdog).toEqual({ enabled: true });
    expect(warnings.some((w) => w.includes("must be < stageTimeoutMs"))).toBe(true);
    expect(warnings.some((w) => w.includes("falling back to the default pair"))).toBe(true);
  });

  it("ignores non-positive / non-integer thresholds with a warning", () => {
    const { config, warnings } = resolveWithWarnings(
      baseJson({ enabled: true, stageTimeoutMs: 0, stageIdleTimeoutMs: 1.5 }),
    );
    expect(config.watchdog).toEqual({ enabled: true });
    expect(warnings.filter((w) => w.includes("expected positive integer"))).toHaveLength(2);
  });

  it("drops a non-object watchdog block with a warning", () => {
    const { config, warnings } = resolveWithWarnings(baseJson(42 as unknown as Record<string, unknown>));
    expect(config.watchdog).toBeUndefined();
    expect(warnings.some((w) => w.includes("expected object"))).toBe(true);
  });

  it("clamps a hand-built contradictory pair at runtime too (defence in depth)", async () => {
    // An embedder-built config never passes the loader, so the runtime clamp is
    // the only thing keeping an idle window longer than its own ceiling from
    // being meaningless. Observable effect: the visit times out at the CEILING,
    // not at the 5000ms idle window. (Which of the two clocks wins the tie is
    // not deterministic once both are clamped to the same delay, so the kind is
    // asserted as a member of the contract instead of a fixed value.)
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const ctx = makeWatchdogCtx(meta);
    armStageWatchdog(ctx, watchdogConfig({ enabled: true, stageTimeoutMs: 40, stageIdleTimeoutMs: 5000 }));

    await waitUntil(() => timeoutRecords(id).length > 0, 300);
    const record = timeoutRecords(id)[0];
    expect(isWatchdogKind(record.fields["kind"])).toBe(true);
    expect(Number(record.fields["elapsedMs"])).toBeLessThan(5000);
    // One fired clock consumes the pair, so the visit times out exactly once.
    await sleep(80);
    expect(timeoutRecords(id)).toHaveLength(1);
  });
});
