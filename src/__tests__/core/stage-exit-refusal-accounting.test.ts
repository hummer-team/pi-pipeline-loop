/**
 * 216 Phase 2 (P3): refusal / defer ACCOUNTING for the auto advance chain.
 *
 * `recordStageExitRefusal` is the SINGLE counting/escalation/fuse entry:
 *   - first same-cause refusal from a CHILD origin → wake the owner ONCE
 *     (running-state arm: `escalatedAt` credential + one broadcast + one
 *     `stage_exit_refusal_escalated` audit, NO freeze);
 *   - first refusal from an OWNER caller → `counted` only (R6-4: the owner
 *     already sees the refusal in its own turn — self-wake is a model-turn
 *     cost, not a handoff);
 *   - second same-cause refusal → freeze + decision menu (`frozen`);
 *   - SAME STAGE VISIT already burned its freeze budget (`frozenCount>=1`)
 *     → abort instead of a second menu (`aborted`, R5-Q5-A menu ping-pong);
 *   - a different cause resets `count` but INHERITS the visit-scoped
 *     `frozenCount` (a new reason must not buy a second menu in one visit);
 *   - frozen writers / stale-stage writers are zero-side-effect `skipped`
 *     (R4-Q4-A / F4).
 *
 * ⑦ additionally proves the NEGATIVE space: `recheck_blocked` / `budget_exceeded`
 * are healthy stalls with their own convergence — two consecutive stalls create
 * NO counter, NO escalation, NO freeze (R6-4) and the truthfulness outcomes
 * stay byte-exact (no `refusalOutcome` key is added on those paths).
 *
 * Audits are captured in-memory via `__setSafeWriteAuditLogOverride` (the only
 * writer `recordStageExitRefusal` / flow-state use); the bus is a structural
 * `pi.events` mock so escalations are observable without a real pi runtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordStageExitRefusal,
  STAGE_EXIT_REFUSED_FREEZE_THRESHOLD,
  MAX_STAGE_EXIT_REFUSAL_FREEZES_PER_VISIT,
  type StageExitRefusalOutcome,
} from "../../core/stage-exit/stage-exit-refusal";
import { autoAdvanceAfterVerify, type StageAdvanceOutcome } from "../../core/verify-advance";
import { createPipelineUI } from "../../core/pipeline-ui";
import { clearAllDecisionTimers, getFlowState } from "../../core/flow-state";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { PIPELINE_ESCALATION_EVENT } from "../../utils/escalation-bus";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";
import { STAGE_EXIT_REFUSED_ESCALATION_REASON, STAGE_EXIT_REFUSED_OVERFLOW_REASON } from "../../constants";
import type { PipelineConfig, PipelineStage, SessionMeta, StageExecutorBinding, StageExecutorRun } from "../../types";

// ─── In-memory audit / bus capture ───────────────────────────────────────────

interface CapturedAudit {
  event: string;
  message?: Record<string, string | boolean>;
  level?: string;
}
let audits: CapturedAudit[] = [];

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message: message as Record<string, string | boolean> | undefined, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
});

function eventsFor(event: string): CapturedAudit[] {
  return audits.filter((a) => a.event === event);
}
function refusalEvents(): CapturedAudit[] {
  return audits.filter((a) => a.event.startsWith("stage_exit_refusal_"));
}

// ─── Direct-call harness ──────────────────────────────────────────────────────

const OWNER_FILE = "/sessions/owner.jsonl";
const CHILD_FILE = "/sessions/child.jsonl";
const CAUSE = "bound_exit_refused:owner_unproven:child_caller";

let seq = 0;
const nextPid = () => `pipe-216-acct-${Date.now()}-${++seq}`;

interface AcctCase {
  config: PipelineConfig;
  meta: SessionMeta;
  ctx: {
    session: { getMeta: () => SessionMeta | undefined; updateMeta: (patch: Partial<SessionMeta>) => SessionMeta };
    ui: { select: (m: string, o: string[]) => Promise<string | undefined>; notify: (m: string) => void };
    pi: unknown;
    _ctx: { sessionManager: Record<string, unknown> };
  };
  /** Broadcasts captured on the structural pi event bus. */
  bus: { name: string; payload: Record<string, unknown> }[];
  /** ui.select invocations — proof NO menu was raised in this session (R6-7). */
  selectCalls: string[];
}

/**
 * Role evidence is PART OF THE CONTRACT (R6-7): the ctx carries the same
 * `_ctx.sessionManager` shape `detectSessionRole` consumes at runtime —
 * "child" = parent header + subagent name; "owner" = own session file, no
 * header. Without it detectHostRole degrades to owner and a child freeze would
 * pop in the wrong TUI.
 */
function makeAcct(opts: { role: "child" | "owner"; meta?: Partial<SessionMeta> }): AcctCase {
  const pid = nextPid();
  const meta = makeTestMeta({
    pipelineId: pid,
    currentStage: "develop",
    previousStage: "plan",
    flowState: "running",
    ...(opts.meta ?? {}),
  });
  const config = makeTestConfig();

  const sessionManager: Record<string, unknown> = {
    getBranch: () => [],
    getEntries: () => [],
  };
  if (opts.role === "child") {
    sessionManager.getSessionFile = () => CHILD_FILE;
    sessionManager.getSessionName = () => "develop-executor#a1b2c3d4";
    sessionManager.getHeader = () => ({ parentSession: OWNER_FILE });
  } else {
    sessionManager.getSessionFile = () => OWNER_FILE;
    sessionManager.getSessionName = () => "owner-session";
    sessionManager.getHeader = () => undefined;
  }

  const bus: AcctCase["bus"] = [];
  const selectCalls: string[] = [];
  const ctx = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: {
      select: async (m: string, _o: string[]) => {
        selectCalls.push(m);
        return undefined;
      },
      notify: (_m: string) => {},
    },
    // hasEventBus() requires BOTH emit and on to be functions.
    pi: {
      events: {
        emit: (name: string, payload: Record<string, unknown>) => { bus.push({ name, payload }); },
        on: () => () => {},
      },
    },
    _ctx: { sessionManager },
  };
  return { config, meta, ctx, bus, selectCalls };
}

const INPUT = {
  stage: "develop" as PipelineStage,
  fromStage: "develop" as PipelineStage,
  toStage: "review" as PipelineStage,
  reason: CAUSE,
  source: "auto_advance" as const,
};

// ─── ①/①b first refusal: child escalates ONCE, owner only counts ─────────────

describe("216 P3: first refusal — child escalates once, owner never self-wakes", () => {
  it("① child-origin first refusal → escalated: credential + ONE broadcast + ONE audit, no freeze", async () => {
    const c = makeAcct({ role: "child" });

    const outcome = await recordStageExitRefusal(c.ctx, c.config, INPUT);

    expect(outcome).toBe<StageExitRefusalOutcome>("escalated");
    expect(STAGE_EXIT_REFUSED_FREEZE_THRESHOLD).toBe(2);

    // The arm credential written to meta IS the broadcast payload `at`.
    const refusal = c.meta.stageExitRefusal!;
    expect(refusal).toMatchObject({
      stage: "develop", fromStage: "develop", toStage: "review",
      reason: CAUSE, count: 1, frozenCount: 0,
    });
    expect(typeof refusal.lastAt).toBe("number");
    expect(typeof refusal.escalatedAt).toBe("number");

    // Exactly one broadcast on the owner-wake channel — running state kept.
    expect(c.bus).toHaveLength(1);
    expect(c.bus[0]!.name).toBe(PIPELINE_ESCALATION_EVENT);
    expect(c.bus[0]!.payload).toMatchObject({
      pipelineId: c.meta.pipelineId,
      stage: "develop",
      reason: STAGE_EXIT_REFUSED_ESCALATION_REASON,
      at: refusal.escalatedAt,
    });

    // One warn audit; NO freeze family on the first occurrence.
    expect(refusalEvents()).toHaveLength(1);
    const escalated = eventsFor("stage_exit_refusal_escalated")[0]!;
    expect(escalated.level).toBe("warn");
    expect(escalated.message).toMatchObject({
      stage: "develop", fromStage: "develop", toStage: "review",
      reason: CAUSE, count: "1", source: "auto_advance",
    });
    expect(eventsFor("stage_exit_refusal_overflow")).toHaveLength(0);
    expect(eventsFor("pipeline_blocked")).toHaveLength(0);
    expect(getFlowState(c.meta)).toBe("running");
    expect(c.selectCalls).toHaveLength(0);
  });

  it("①b owner-caller first refusal → counted: no broadcast, no credential, no audit (R6-4)", async () => {
    const c = makeAcct({ role: "owner" });

    const outcome = await recordStageExitRefusal(c.ctx, c.config, INPUT);

    expect(outcome).toBe<StageExitRefusalOutcome>("counted");
    // The owner already sees the refusal in its own turn — waking itself would
    // cost an extra model turn and is NOT a cross-session handoff.
    expect(c.bus).toHaveLength(0);
    expect(refusalEvents()).toHaveLength(0);
    const refusal = c.meta.stageExitRefusal!;
    expect(refusal.count).toBe(1);
    expect(refusal.escalatedAt).toBeUndefined();
    expect(getFlowState(c.meta)).toBe("running");
    expect(eventsFor("pipeline_blocked")).toHaveLength(0);
  });
});

// ─── ② second same-cause refusal freezes and raises the menu path ────────────

describe("216 P3: second same-cause refusal freezes the stage", () => {
  it("② same cause #2 → frozen: pipeline_blocked once, count=2, frozenCount=1, no menu in the child TUI", async () => {
    const c = makeAcct({ role: "child" });

    // First refusal arms the owner (① semantics), NOT a freeze.
    expect(await recordStageExitRefusal(c.ctx, c.config, INPUT)).toBe("escalated");
    c.bus.length = 0;
    audits = [];

    // Second SAME-cause refusal → threshold (2) → freeze + menu handoff.
    const outcome = await recordStageExitRefusal(c.ctx, c.config, INPUT);
    expect(outcome).toBe<StageExitRefusalOutcome>("frozen");

    expect(eventsFor("stage_exit_refusal_overflow")).toHaveLength(1);
    expect(eventsFor("pipeline_blocked")).toHaveLength(1);
    const refusal = c.meta.stageExitRefusal!;
    expect(refusal.count).toBe(2);
    expect(refusal.frozenCount).toBe(1); // visit-scoped budget burned exactly once
    expect(refusal.escalatedAt).toBeUndefined(); // a new cause/frozen fact owns the next arm
    expect(getFlowState(c.meta)).toBe("blocked");
    expect(c.meta.blockedReason).toBe(STAGE_EXIT_REFUSED_OVERFLOW_REASON);

    // R6-7: a CHILD freeze is a cross-session handoff — the menu belongs to
    // the OWNER TUI. The child only arms + broadcasts (frozen 203 channel).
    expect(c.selectCalls).toHaveLength(0);
    expect(eventsFor("menu_escalation_armed")).toHaveLength(1);
    expect(eventsFor("menu_escalation_broadcast")).toHaveLength(1);
    expect(c.meta.menuEscalationPending).toBe(true);
    expect(c.bus.map((b) => b.payload.reason)).toEqual([STAGE_EXIT_REFUSED_OVERFLOW_REASON]);
    expect(MAX_STAGE_EXIT_REFUSAL_FREEZES_PER_VISIT).toBe(1);
  });
});

// ─── ③/③b cause switch: count resets, the VISIT freeze budget does NOT ───────

describe("216 P3: reason changes reset count but inherit frozenCount (R5-Q5-A)", () => {
  const burnedVisit = {
    stage: "develop" as PipelineStage,
    fromStage: "develop" as PipelineStage,
    toStage: "review" as PipelineStage,
    reason: "bound_run_owner_mismatch",
    count: 1,
    lastAt: 1_700_000_000_000,
    frozenCount: 1, // the visit already burned its ONE menu
    escalatedAt: 1_700_000_000_500,
  };

  it("③ a different cause restarts count at 1 but INHERITS frozenCount", async () => {
    const c = makeAcct({ role: "child", meta: { stageExitRefusal: burnedVisit } });

    const outcome = await recordStageExitRefusal(c.ctx, c.config, { ...INPUT, reason: CAUSE });

    // Different cause → count resets to 1 (below the threshold) → escalate.
    expect(outcome).toBe<StageExitRefusalOutcome>("escalated");
    const refusal = c.meta.stageExitRefusal!;
    expect(refusal.reason).toBe(CAUSE);
    expect(refusal.count).toBe(1);
    // … but the visit-scoped freeze budget does NOT reset with the cause —
    // a new reason must not buy a second menu inside the same stage visit.
    expect(refusal.frozenCount).toBe(1);
  });

  it("③b same visit already frozen once → the NEW cause reaching the threshold ABORTS (no second menu)", async () => {
    const c = makeAcct({ role: "child", meta: { stageExitRefusal: burnedVisit } });

    // 1st occurrence of the new cause: escalated (frozenCount inherited).
    await recordStageExitRefusal(c.ctx, c.config, { ...INPUT, reason: CAUSE });
    // 2nd occurrence of the new cause: count=2, inherited frozenCount>=1 →
    // the menu would only repeat the same dead end → abort.
    audits = [];
    c.bus.length = 0;
    const outcome = await recordStageExitRefusal(c.ctx, c.config, { ...INPUT, reason: CAUSE });
    expect(outcome).toBe<StageExitRefusalOutcome>("aborted");

    expect(getFlowState(c.meta)).toBe("aborted");
    expect(c.meta.terminateReason).toBe(STAGE_EXIT_REFUSED_OVERFLOW_REASON);
    // ABORT — NOT a second freeze: no `pipeline_blocked`, no new menu arm.
    expect(eventsFor("pipeline_blocked")).toHaveLength(0);
    expect(eventsFor("menu_escalation_armed")).toHaveLength(0);
    expect(eventsFor("stage_exit_refusal_overflow")).toHaveLength(1);
    expect(c.meta.stageExitRefusal!.count).toBe(2);
    expect(c.meta.stageExitRefusal!.frozenCount).toBe(1);
  });
});

// ─── ④/⑤ zero-side-effect guards: frozen writers and stale-stage writes ───────

describe("216 P3: frozen and stale writers are zero-side-effect skips", () => {
  it("④ frozen pipeline (blocked by ANY cause) → skipped: zero writes, zero audits (R4-Q4-A/R6-3)", async () => {
    const preset = { ...INPUT, count: 1, lastAt: 1_700_000_000_000, frozenCount: 0 };
    const c = makeAcct({
      role: "child",
      meta: {
        flowState: "blocked",
        blockedReason: "verify_attempt_overflow", // a FOREIGN freeze must also silence the counter
        stageExitRefusal: { ...preset, stage: "develop", fromStage: "develop", toStage: "review", escalatedAt: undefined },
      },
    });

    const outcome = await recordStageExitRefusal(c.ctx, c.config, INPUT);

    expect(outcome).toBe<StageExitRefusalOutcome>("skipped");
    // A frozen pipeline NEVER grows the counter (that was the audit-noise loop
    // this guard closes — R4-Q4-A absorbs R3-Q6-A).
    expect(refusalEvents()).toHaveLength(0);
    expect(c.bus).toHaveLength(0);
    expect(c.meta.stageExitRefusal!.count).toBe(1); // untouched
    expect(getFlowState(c.meta)).toBe("blocked");
    expect(eventsFor("pipeline_block_reason_changed")).toHaveLength(0);
  });

  it("⑤ stale writer (stage mismatch) → skipped: a cleared counter is not resurrected (F4)", async () => {
    const c = makeAcct({ role: "child", meta: { currentStage: "plan" } });
    expect(c.meta.stageExitRefusal).toBeUndefined();

    // input.stage develop ≠ currentStage plan — a late child write landing after
    // the transition must NOT re-open a fresh counter for the NEW visit.
    const outcome = await recordStageExitRefusal(c.ctx, c.config, INPUT);

    expect(outcome).toBe<StageExitRefusalOutcome>("skipped");
    expect(c.meta.stageExitRefusal).toBeUndefined(); // NOT resurrected
    expect(refusalEvents()).toHaveLength(0);
    expect(c.bus).toHaveLength(0);
  });
});

// ─── ⑥ same-visit fuse: second overflow of one visit aborts ──────────────────

describe("216 P3: the per-visit fuse budget", () => {
  it("⑥ frozenCount>=1 with the SAME cause reaching the threshold → aborted (no second freeze)", async () => {
    const c = makeAcct({
      role: "child",
      meta: {
        stageExitRefusal: {
          stage: "develop", fromStage: "develop", toStage: "review",
          reason: CAUSE, count: 1, lastAt: 1_700_000_000_000,
          frozenCount: MAX_STAGE_EXIT_REFUSAL_FREEZES_PER_VISIT,
        },
      },
    });

    const outcome = await recordStageExitRefusal(c.ctx, c.config, INPUT);
    expect(outcome).toBe<StageExitRefusalOutcome>("aborted");

    expect(getFlowState(c.meta)).toBe("aborted");
    expect(c.meta.terminateReason).toBe(STAGE_EXIT_REFUSED_OVERFLOW_REASON);
    expect(eventsFor("pipeline_blocked")).toHaveLength(0); // abort, NOT re-freeze
    expect(eventsFor("stage_exit_refusal_overflow")).toHaveLength(1);
    expect(eventsFor("menu_escalation_armed")).toHaveLength(0);
  });
});

// ─── ⑦ the negative space: recheck / budget NEVER count ───────────────────────

/**
 * Budget/recheck setups mirrored from the Phase 0 truthfulness harness — the
 * stalls below must keep their Phase 1 zero-side-effect exit EXACTLY: no
 * counter, no credential, no broadcast, no counting audit.
 */
async function makeAdvanceCase(opts: {
  label: string;
  /** Role evidence for the bound-commit site (child → refusal; owner/none → stall paths). */
  role?: "owner" | "child";
  meta: (pid: string) => Partial<SessionMeta>;
}): Promise<{
  root: string;
  config: PipelineConfig;
  session: ReturnType<typeof makeStrictSession>;
  ctx: any;
  bus: { name: string; payload: Record<string, unknown> }[];
  pid: string;
}> {
  const root = join(tmpdir(), `pi-216-acct7-${opts.label}-${Date.now()}-${++seq}`);
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);
  const pid = nextPid();
  const meta = makeTestMeta({ pipelineId: pid, ...(opts.meta(pid) ?? {}) });
  const session = makeStrictSession(meta);
  const bus: { name: string; payload: Record<string, unknown> }[] = [];
  const ctx = {
    session,
    ui: { notify: () => {}, setStatus: () => {}, select: async () => undefined },
    pi: {
      sendUserMessage: () => {},
      events: { emit: (name: string, payload: Record<string, unknown>) => { bus.push({ name, payload }); }, on: () => () => {} },
    },
    config,
    // Child evidence mirrors Phase 0 ① (refusal cause `owner_unproven:child_caller`);
    // owner evidence keeps the budget/recheck stall cases role-agnostic (they stall
    // long before the bound-commit site is reached).
    _ctx: { sessionManager: opts.role === "child"
      ? { getBranch: () => [], getEntries: () => [], getHeader: () => ({ parentSession: OWNER_FILE }), getSessionFile: () => CHILD_FILE, getSessionName: () => "develop-executor#a1b2c3d4" }
      : { getBranch: () => [], getEntries: () => [], getHeader: () => undefined, getSessionFile: () => OWNER_FILE, getSessionName: () => "owner-session" } },
  };
  return { root, config, session, ctx, bus, pid };
}

const PASS_RESULT = {
  structuredResult: { failures: [] },
  ruleMissing: [],
  verifyResult: { structured: { passed: true }, llm: null as unknown, overallPassed: true },
};

function boundRun(pipelineId: string): StageExecutorRun {
  const binding: StageExecutorBinding = {
    runId: "run-216-7",
    pipelineId,
    ownerSessionFile: OWNER_FILE,
    stage: "develop",
    stageVisitId: 1_700_000_000_000,
    operationId: "op-216-7",
    agentId: "01a11bbb-c3b4-72bc-9397-4f5b9881be41",
    executorSessionFile: CHILD_FILE,
  };
  return { binding, status: "running", recovery: "none", consecutiveFailures: 0, terminalConsumed: false };
}

describe("216 P3: healthy stalls keep their zero-side-effect exit (R6-4)", () => {
  it("⑦ budget stall ×2 AND recheck stall ×2 → zero counting, byte-exact outcomes", async () => {
    // ── budget: counted backward edge develop→clarify at the last round ──
    const budget = await makeAdvanceCase({
      label: "budget-x2",
      meta: () => ({ maxLoopCycles: 2, loopCycleCount: 1, stageVisitOrder: ["clarify", "plan", "develop"] }),
    });
    const runBudget = (): Promise<StageAdvanceOutcome> =>
      autoAdvanceAfterVerify(
        budget.config, budget.ctx, budget.session.getMeta()!, "develop", "clarify" as PipelineStage,
        PASS_RESULT, createPipelineUI(budget.config), { caller: "auto_advance" },
      );

    expect(await runBudget()).toEqual({ advanced: false, blockReason: "budget_exceeded" });
    expect(await runBudget()).toEqual({ advanced: false, blockReason: "budget_exceeded" });
    // Exact toEqual above already PROVES no `refusalOutcome` key is added on
    // the non-bound paths. The counter itself must not exist at all:
    expect(budget.session.getMeta()!.stageExitRefusal).toBeUndefined();
    expect(refusalEvents()).toHaveLength(0);
    expect(budget.bus).toHaveLength(0);
    // … and its own convergence is untouched (Phase 1 baseline): the stall
    // persisted NOTHING (counter NOT incremented, loop-breaker stays in charge).
    expect(budget.session.getMeta()!.loopCycleCount).toBe(1);

    // ── recheck: the 193 barrier on a forward release ──
    audits = [];
    const recheck = await makeAdvanceCase({
      label: "recheck-x2",
      meta: (pid) => ({
        designReviewRecheck: { pipelineId: pid, planDoc: "docs/design/216_plan.md" },
      }),
    });
    // The barrier ONLY blocks forward releases to develop/review/fix/
    // awaiting_human/completed — `design-review` itself is the sanctioned
    // re-authorization EXIT of the barrier (193), so the stall must ride a
    // genuinely blocked target: develop → review.
    const runRecheck = (): Promise<StageAdvanceOutcome> =>
      autoAdvanceAfterVerify(
        recheck.config, recheck.ctx, recheck.session.getMeta()!, "develop", "review" as PipelineStage,
        PASS_RESULT, createPipelineUI(recheck.config), { caller: "auto_advance" },
      );

    expect(await runRecheck()).toEqual({ advanced: false, blockReason: "recheck_blocked" });
    expect(await runRecheck()).toEqual({ advanced: false, blockReason: "recheck_blocked" });
    expect(recheck.session.getMeta()!.stageExitRefusal).toBeUndefined();
    expect(refusalEvents()).toHaveLength(0);
    expect(recheck.bus).toHaveLength(0);
    // The barrier keeps its OWN convergence: develop stays put, no counter.
    expect(recheck.session.getMeta()!.currentStage).toBe("develop");
  });

  it("⑦-control positive: a bound refusal on the same harness DOES count (the guard is reason-selective, not path-dead)", async () => {
    const c = await makeAdvanceCase({
      label: "bound-counts",
      // 216 §4 mirror of Phase 0 ①: CHILD evidence against an owner-bound run —
      // the strict commit refuses it (`owner_unproven:child_caller`) and ONLY
      // that refusal family enters the counter.
      role: "child",
      meta: (pid) => ({ stageExecutorRun: boundRun(pid) }),
    });
    const outcome = await autoAdvanceAfterVerify(
      c.config, c.ctx, c.session.getMeta()!, "develop", "review" as PipelineStage,
      PASS_RESULT, createPipelineUI(c.config), { caller: "auto_advance" },
    );
    // Byte-exact positive shape: the counting path ADDS `refusalOutcome` and
    // nothing else (first child-origin refusal → escalated owner arm).
    expect(outcome).toEqual({
      advanced: false,
      blockReason: "bound_exit_refused:owner_unproven:child_caller",
      refusalOutcome: "escalated",
    });
    const refusal = c.session.getMeta()!.stageExitRefusal!;
    // blockReason is proven by the exact toEqual above.
    expect(refusal.reason).toBe(outcome.blockReason!);
    expect(refusal.count).toBe(1);
    expect(refusal.stage).toBe("develop");
    expect(typeof refusal.escalatedAt).toBe("number");
    // Child origin → exactly ONE owner-wake broadcast + ONE counting audit.
    expect(c.bus).toHaveLength(1);
    expect(c.bus[0]!.name).toBe(PIPELINE_ESCALATION_EVENT);
    expect(c.bus[0]!.payload.reason).toBe(STAGE_EXIT_REFUSED_ESCALATION_REASON);
    expect(refusalEvents()).toHaveLength(1);
    expect(eventsFor("stage_exit_refusal_escalated")[0]?.message?.source).toBe("auto_advance");
  });
});
