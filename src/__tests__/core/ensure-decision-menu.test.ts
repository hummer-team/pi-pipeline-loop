/**
 * 208 Phase 1 — ensureDecisionMenu unified scheduler.
 *
 * Covered acceptance items (plan §Phase 1 unit tests 1–20):
 * single-flight join, timer mutex, in-flight skip, backoff chain (5s→10s),
 * F3 option forwarding (source/budgetValue/directStageSelect), J2 callback
 * adoption, J6 reason re-read during retries, no-UI/child/select_error
 * attribution, restart re-binding and input capability isolation.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import {
  ensureDecisionMenu,
  scheduleDecisionRetry,
  clearDecisionTimer,
  clearAllDecisionTimers,
  __decisionTimerCount,
  __hasDecisionTimer,
} from "../../core/flow-state";
import { scheduleMenuRetry, runDecisionMenu } from "../../core/decision-menu-runtime";
import type { EnsureDecisionMenuOpts } from "../../core/decision-menu-runtime";
import type { FlowStateCtx } from "../../core/flow-state";
import {
  clearInputCapabilityOverrides,
  isInputUnavailable,
  markInputUnavailable,
} from "../../core/decision-menu-runtime";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import type { SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";

type SelectCall = { message: string; options: string[] };
type CapturedAudit = { event: string; message: Record<string, string | boolean> | undefined; level: string | undefined };

// Shared, reset per test
let audits: CapturedAudit[] = [];
let notifyCalls: string[] = [];
let selectCalls: SelectCall[];
let selectQueue: Array<string | undefined>;
let meta: SessionMeta;
let ctx: FlowStateCtx;
let config: ReturnType<typeof makeTestConfig>;

function begin(overrides?: Partial<SessionMeta>): void {
  audits = [];
  notifyCalls = [];
  selectCalls = [];
  selectQueue = [];
  meta = makeTestMeta({
    flowState: "blocked",
    blockedReason: "loop_overflow",
    ...overrides,
  });
  ctx = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: {
      select: async (message: string, options: string[]) => {
        selectCalls.push({ message, options });
        return selectQueue.shift();
      },
      input: async () => undefined,
      notify: (msg: string) => notifyCalls.push(msg),
    } as FlowStateCtx["ui"],
  };
  config = makeTestConfig();
}

/** Queue a raw select response (undefined = dismiss). */
function q(...responses: Array<string | undefined>): void {
  selectQueue = [...selectQueue, ...responses];
}

/**
 * Drain pending microtasks without touching timers — the whole attempt chain
 * resolves on microtasks (select returns queued values, audits are overridden),
 * so this flushes a fired timer's async work even under jest fake timers.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve().then(() => {});
  }
}

beforeEach(() => {
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message, level });
  });
});

afterEach(() => {
  jest.useRealTimers();
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
  clearInputCapabilityOverrides();
});

// ─── 1–4: happy chain, backoff, cancel ──────────────────────────────────────

describe("208 Phase 1: ensureDecisionMenu chain", () => {
  it("test 1: decided on first select → retryArmed=false, no timer", async () => {
    begin();
    q("Resume");
    const r = await ensureDecisionMenu(ctx, meta, config, { source: "freeze" });
    expect(r.outcome).toBe("decided");
    expect(r.applied).toBe(true);
    expect(r.retryArmed).toBe(false);
    expect(r.joined).toBe(false);
    expect(selectCalls.length).toBe(1);
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 2+3: interrupted → timer armed (5s) → next select; decided → timers 0", async () => {
    begin();
    jest.useFakeTimers();
    q(undefined, "Resume");
    const r1 = await ensureDecisionMenu(ctx, meta, config, { source: "freeze" });
    expect(r1.outcome).toBe("interrupted");
    expect(r1.retryArmed).toBe(true);
    expect(r1.retryDelayMs).toBe(5000);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);

    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(2);
    // The second attempt finished asynchronously with "Resume" → chain stops.
    expect(__decisionTimerCount()).toBe(0);
    expect(meta.flowState).toBe("running");
  });

  it("test 3b: backoff grows 5s→10s (cap constants fixed)", async () => {
    begin();
    jest.useFakeTimers();
    q(undefined, undefined);
    const r1 = await ensureDecisionMenu(ctx, meta, config, {});
    expect(r1.retryDelayMs).toBe(5000);

    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(2);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);

    jest.advanceTimersByTime(10000);
    await drain();
    expect(selectCalls.length).toBe(3);
    // Third attempt got undefined → interrupted → next delay = 20s (cap 60s).
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);
  });

  it("test 4: slow undefined (≥1500ms) → cancelled, no timer", async () => {
    begin();
    jest.useRealTimers();
    ctx.ui!.select = async () => {
      await new Promise((res) => setTimeout(res, 2000));
      return undefined;
    };
    const r = await ensureDecisionMenu(ctx, meta, config, {});
    expect(r.outcome).toBe("cancelled");
    expect(r.retryArmed).toBe(false);
    expect(__decisionTimerCount()).toBe(0);
  });
});

// ─── 5–7: single-flight, timer mutex, skip-in-flight ────────────────────────

describe("208 Phase 1: single-flight and timer mutex", () => {
  it("test 5: concurrent call joins the in-flight presentation (1 select, audited)", async () => {
    begin();
    let release!: (v: string | undefined) => void;
    const held = new Promise<string | undefined>((res) => { release = res; });
    ctx.ui!.select = async (message: string, options: string[]) => {
      selectCalls.push({ message, options });
      return held;
    };

    const p1 = ensureDecisionMenu(ctx, meta, config, { source: "freeze" });
    // Let attempt 1 reach the select dialog.
    await drain();
    const p2 = ensureDecisionMenu(ctx, meta, config, {});
    await drain();
    expect(selectCalls.length).toBe(1);

    release(undefined); // fast dismiss → interrupted → retry armed
    const r1 = await p1;
    const r2 = await p2;
    expect(r2.outcome).toBe("interrupted");
    expect(r2.joined).toBe(true);
    expect(r2.retryArmed).toBe(true);
    expect(audits.some((a) => a.event === "decision_menu_joined_inflight")).toBe(true);
  });

  it("test 6: timer armed then direct call → timer cleared, no stacked select", async () => {
    begin();
    jest.useFakeTimers();
    q(undefined, "Resume");
    const r1 = await ensureDecisionMenu(ctx, meta, config, {});
    expect(r1.retryArmed).toBe(true);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);

    const r2 = await ensureDecisionMenu(ctx, meta, config, {});
    expect(r2.outcome).toBe("decided");
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(false);
    expect(selectCalls.length).toBe(2); // direct select replaced the pending retry
    expect(audits.some((a) => a.event === "decision_menu_retry_superseded")).toBe(true);
  });

  it("test 7: timer fires while a presentation is in-flight → skipped (audited), no extra select", async () => {
    begin();
    jest.useFakeTimers();
    // Gate every dialog: attempt 1 resolves instantly (fast dismiss → interrupted),
    // attempt 2 stays OPEN (in-flight) while the armed retry timer fires.
    let release2!: (v: string | undefined) => void;
    const held = new Promise<string | undefined>((res) => { release2 = res; });
    const gates: Promise<string | undefined>[] = [Promise.resolve(undefined), held];
    let gateIdx = 0;
    ctx.ui!.select = async (message: string, options: string[]) => {
      selectCalls.push({ message, options });
      return gates[gateIdx++]!;
    };

    const p1 = await ensureDecisionMenu(ctx, meta, config, {}); // attempt1: interrupted, timer armed
    void p1;

    // Direct ensure: clears timer#1 (G2 mutex) and starts attempt2, which
    // blocks on the held dialog (single in-flight select).
    const p2 = ensureDecisionMenu(ctx, meta, config, {});
    await drain();
    expect(selectCalls.length).toBe(2);

    // Arm a retry timer while attempt2 is still open (what agent_settled-side
    // callers do through the legacy wrapper). Index 2 → 10s computeRetryDelay.
    scheduleDecisionRetry(ctx, meta, config, 2);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);

    jest.advanceTimersByTime(10000);
    await drain();
    expect(selectCalls.length).toBe(2); // skip — no third dialog
    expect(audits.some((a) => a.event === "decision_menu_retry_skipped_inflight")).toBe(true);

    release2(undefined); // let attempt2 finish; afterEach clears its retry timer
    await p2;
  });
});

// ─── 8–11: attribution ──────────────────────────────────────────────────────

describe("208 Phase 1: availability attribution", () => {
  it("test 8: no select dialog → no-menu(no_ui) + notify + no timer", async () => {
    begin();
    delete (ctx.ui as { select?: unknown }).select;
    const r = await ensureDecisionMenu(ctx, meta, config, { source: "command" });
    expect(r.outcome).toBe("no-menu");
    expect(r.unavailableReason).toBe("no_ui");
    expect(notifyCalls.length).toBe(1);
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 9: child session → suppressed + no-menu(child_session) + no timer", async () => {
    begin();
    // Child gate needs sessionManager signals; use the same trick as
    // phase1-owner-gate: a session name with "#<8hex>" branch suffix on entries.
    const parentEntries: unknown[] = [];
    ctx._ctx = {
      sessionManager: {
        getEntries: () => parentEntries,
        getBranch: () => [],
        getSessionFile: () => "child#12345678",
        getSessionName: () => "child#12345678",
      },
    } as never;
    const r = await ensureDecisionMenu(ctx, meta, config, {});
    expect(r.outcome).toBe("no-menu");
    expect(r.unavailableReason).toBe("child_session");
    expect(audits.some((a) => a.event === "pipeline_menu_suppressed_child")).toBe(true);
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 10: select throws → no-menu(select_error) + no timer", async () => {
    begin();
    ctx.ui!.select = async () => {
      throw new Error("dialog boom");
    };
    const r = await ensureDecisionMenu(ctx, meta, config, {});
    expect(r.outcome).toBe("no-menu");
    expect(r.unavailableReason).toBe("select_error");
    expect(audits.some((a) => a.event === "pipeline_decision_error")).toBe(true);
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 11: decided && !applied (guard) → retried; second attempt succeeds → stop", async () => {
    begin();
    jest.useFakeTimers();
    // design-review loop active → skip refused by the executor-level guard.
    meta.currentStage = "design-review";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (meta as any).designReview = {
      schemaVersion: 1, planDoc: "/tmp/plan.md", planHash: "abc", round: 1,
      authorizationId: "a", authorizationSource: "menu", phase: "review_ready",
      authorizedAt: Date.now(), updatedAt: Date.now(),
    };
    q("Skip", "Resume");
    // Second attempt must be "Resume" AFTER the design-review loop is dropped,
    // so the select override only snapshots the queue (no early deactivation).
    const r1 = await ensureDecisionMenu(ctx, meta, config, { source: "freeze" });
    expect(r1.outcome).toBe("decided");
    expect(r1.applied).toBe(false);
    expect(r1.failureReason).toBe("guard_rejected");
    expect(r1.retryArmed).toBe(true); // F2: decided-but-failed retries

    // Deactivate the design-review loop between attempts so "Resume" passes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (meta as any).designReview;

    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(2);
    expect(meta.flowState).toBe("running");
    expect(__decisionTimerCount()).toBe(0);
  });
});

// ─── 12–14: option forwarding, re-reads, stale ──────────────────────────────

describe("208 Phase 1: option forwarding and meta freshness", () => {
  it("test 12: secondary-menu interrupt → next attempt goes straight to the stage list", async () => {
    begin();
    jest.useFakeTimers();
    meta.stageVisitOrder = ["clarify", "plan", "develop"];
    q("Choose stage…", undefined, "develop");
    const r1 = await ensureDecisionMenu(ctx, meta, config, {});
    void r1;
    expect(selectCalls.length).toBe(2); // primary + secondary

    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(3);
    // The retry select is the SECONDARY stage list, not the primary menu.
    expect(selectCalls[2].message.startsWith("Choose stage")).toBe(true);
  });

  it("test 13: budgetValue preserved across retry (F3)", async () => {
    // F3 is a SCHEDULER contract: the retry must receive the first caller's
    // source/budgetValue/directStageSelect. The flow-state presentation
    // collects the budget through `ui.input`, so the observable seam here is
    // the injected `present` implementation (test 13b covers the end-to-end
    // set_budget effect). Clearing `budgetValue` from the stored retry options
    // makes `seen[1].budgetValue` undefined and fails this test.
    begin();
    jest.useFakeTimers();
    const seen: Array<{
      budgetValue: number | undefined;
      source: string | undefined;
      attempt: number;
      directStageSelect: boolean | undefined;
    }> = [];
    const deps = {
      readMeta: () => meta,
      isFrozen: (m: SessionMeta) => m.flowState === "blocked",
      present: async (_live: SessionMeta, opts: EnsureDecisionMenuOpts, attempt: number) => {
        seen.push({
          budgetValue: opts.budgetValue,
          source: opts.source,
          attempt,
          directStageSelect: opts.directStageSelect,
        });
        return { outcome: "interrupted" as const, applied: false };
      },
    };

    const r1 = await runDecisionMenu(deps, meta.pipelineId, {
      budgetValue: 9,
      source: "freeze",
      directStageSelect: true,
    });
    expect(r1.retryArmed).toBe(true);
    expect(r1.retryDelayMs).toBe(5000);

    jest.advanceTimersByTime(5000);
    await drain();
    expect(seen.length).toBe(2);
    expect(seen[1]).toEqual({
      budgetValue: 9,
      source: "freeze",
      attempt: 2,
      directStageSelect: true,
    });
    clearDecisionTimer(meta.pipelineId);
  });

  it("test 13b: set_budget typed in a retry applies the dialog value", async () => {
    begin();
    jest.useFakeTimers();
    meta.blockedReason = "max_loop_cycles";
    meta.loopCycleCount = 2;
    q(undefined, "Set round budget");
    (ctx.ui as NonNullable<FlowStateCtx["ui"]>).input = async () => "9";

    const r1 = await ensureDecisionMenu(ctx, meta, config, { source: "freeze" });
    expect(r1.outcome).toBe("interrupted");

    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(2);
    // The retry re-opened set_budget and applied the value typed in ui.input.
    expect(meta.maxLoopCycles).toBe(9);
  });

  it("test 14: stale pipeline (pid mismatch) → no-menu(stale_pipeline), no select, no timer", async () => {
    begin();
    meta.pipelineId = "pipe-live";
    const staleMeta = { ...meta, pipelineId: "pipe-old" } as SessionMeta;
    const r = await ensureDecisionMenu(ctx, staleMeta, config, {});
    expect(r.outcome).toBe("no-menu");
    expect(r.unavailableReason).toBe("stale_pipeline");
    expect(selectCalls.length).toBe(0);
    expect(r.retryArmed).toBe(false);
  });
});

// ─── 15: joiner callback adoption (J2) ──────────────────────────────────────

describe("208 Phase 1: join callback adoption (J2)", () => {
  it("test 15: first caller without callback + joiner with callback → adopted (called once)", async () => {
    begin();
    let release1!: (v: string | undefined) => void;
    let release2!: (v: string | undefined) => void;
    const gate1 = new Promise<string | undefined>((res) => { release1 = res; });
    const gate2 = new Promise<string | undefined>((res) => { release2 = res; });
    const gates = [gate1, gate2];
    let gateIdx = 0;
    ctx.ui!.select = async (message: string, options: string[]) => {
      selectCalls.push({ message, options });
      return gates[gateIdx++]!;
    };

    let callbackCalls = 0;
    const onStageChanged = async (): Promise<void> => { callbackCalls++; };

    const p1 = ensureDecisionMenu(ctx, meta, config, { source: "settle" }); // no callback
    await drain();
    const p2 = ensureDecisionMenu(ctx, meta, config, { source: "replay", onStageChanged });
    await drain();
    expect(selectCalls.length).toBe(1);

    release1("Choose stage…"); // primary → opens secondary menu while p1/p2 still joined
    await drain();

    expect(audits.some((a) => a.event === "decision_menu_join_callback_adopted")).toBe(true);
    // Pick the LAST secondary option (the explicit "develop" entry — the
    // inferred default is labelled "develop (default)").
    release2(selectCalls[1].options[selectCalls[1].options.length - 1]);
    const r1 = await p1;
    const r2 = await p2;
    void r1; void r2;
    expect(callbackCalls).toBe(1);
  });
});

// ─── 16–17: restart binding and capability reset ─────────────────────────────

describe("208 Phase 1: restart re-binding", () => {
  it("test 16: old pid timer self-destructs; new pid presents, set_budget returns", async () => {
    begin();
    jest.useFakeTimers();
    q(undefined, "Set round budget");
    (ctx.ui as NonNullable<FlowStateCtx["ui"]>).input = async () => "8";
    markInputUnavailable("pipe-old");

    const r1 = await ensureDecisionMenu(ctx, meta, config, {}); // interrupted → old pid timer armed
    expect(r1.retryArmed).toBe(true);

    // Simulate a restart swap: the session now belongs to a NEW pipeline which
    // is frozen because of max_loop_cycles.
    Object.assign(meta, {
      pipelineId: "pipe-new",
      flowState: "blocked" as const,
      blockedReason: "max_loop_cycles",
      loopCycleCount: 2,
      maxLoopCycles: 5,
      stageVisitOrder: ["clarify", "plan", "develop"],
    });

    jest.advanceTimersByTime(5000);
    await drain();
    // The old timer must not have re-presented with the NEW flow.
    expect(selectCalls.length).toBe(1);

    const r2 = await ensureDecisionMenu(ctx, meta, config, { source: "command" });
    expect(r2.outcome).toBe("decided");
    expect(r2.applied).toBe(true);
    expect(meta.maxLoopCycles).toBe(8);
    // Old pipeline's dropped input capability must not leak into the new flow.
    expect(isInputUnavailable("pipe-new")).toBe(false);
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 17: clearAllDecisionTimers resets timers AND input capability", () => {
    begin();
    markInputUnavailable("pipe-x");
    expect(isInputUnavailable("pipe-x")).toBe(true);
    clearAllDecisionTimers();
    expect(__decisionTimerCount()).toBe(0);
    expect(isInputUnavailable("pipe-x")).toBe(false);
  });
});

// ─── 18: input_error non-recoverable ────────────────────────────────────────

describe("208 Phase 1: input error handling (J3/D2)", () => {
  it("test 18: ui.input throws → retryable=false, no timer armed", async () => {
    begin();
    meta.blockedReason = "max_loop_cycles";
    q("Set round budget");
    (ctx.ui as NonNullable<FlowStateCtx["ui"]>).input = async () => {
      throw new Error("input dialog exploded");
    };
    const r = await ensureDecisionMenu(ctx, meta, config, {});
    expect(r.outcome).toBe("decided");
    expect(r.applied).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.retryArmed).toBe(false);
    expect(r.failureReason).toBe("input_error");
    expect(__decisionTimerCount()).toBe(0);
    expect(audits.some((a) => a.event === "decision_not_applied")).toBe(true);
  });
});

// ─── 19: retry re-reads meta (J6 reason drift) ──────────────────────────────

describe("208 Phase 1: retry reflects fresh blocked reason (J6)", () => {
  it("test 19: reason changedbetween attempts → next dialog shows the new reason, audited", async () => {
    begin();
    jest.useFakeTimers();
    q(undefined);
    const r1 = await ensureDecisionMenu(ctx, meta, config, {});
    void r1;
    expect(selectCalls[0].message).toContain("loop_overflow");

    // The freeze reason drifts while blocked (J6 scenario).
    meta.blockedReason = "verify_failure_loop_overflow";

    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(2);
    // The retry MUST have re-read meta — the prompt carries the new reason.
    expect(selectCalls[1].message).toContain("verify_failure_loop_overflow");
    const changed = audits.find((a) => a.event === "pipeline_block_reason_changed");
    expect(changed?.message?.["previousReason"]).toBe("loop_overflow");
    expect(changed?.message?.["reason"]).toBe("verify_failure_loop_overflow");
  });
});

// ─── 20: no-UI notify ownership ─────────────────────────────────────────────

describe("208 Phase 1: no-UI notify ownership", () => {
  it("test 20: notifyOnUnavailable:false → 0 notify; default → exactly 1", async () => {
    begin();
    delete (ctx.ui as { select?: unknown }).select;

    const r1 = await ensureDecisionMenu(ctx, meta, config, { notifyOnUnavailable: false });
    expect(r1.unavailableReason).toBe("no_ui");
    expect(notifyCalls.length).toBe(0);

    const r2 = await ensureDecisionMenu(ctx, meta, config, {});
    expect(r2.unavailableReason).toBe("no_ui");
    expect(notifyCalls.length).toBe(1);
  });
});

// ─── table ownership across clearAllDecisionTimers (review round 1 fix) ─────

describe("208 Phase 1: scheduler table ownership after a shutdown clear", () => {
  it("in-flight chain cleared mid-dialog cannot arm an untracked second timer", async () => {
    begin();
    jest.useFakeTimers();
    let release!: (v: string | undefined) => void;
    const held = new Promise<string | undefined>((res) => { release = res; });
    ctx.ui!.select = async (message: string, options: string[]) => {
      selectCalls.push({ message, options });
      return held;
    };

    const p1 = ensureDecisionMenu(ctx, meta, config, { source: "freeze" });
    await drain();
    expect(selectCalls.length).toBe(1);

    // Session shutdown fires while the dialog is still open.
    clearAllDecisionTimers();
    release(undefined); // streaming dismiss → the stale chain would retry
    const r1 = await p1;
    expect(r1.outcome).toBe("interrupted");
    expect(r1.retryArmed).toBe(false);
    expect(audits.filter((a) => a.event === "decision_menu_retry_armed").length).toBe(0);

    // A replacement chain (post-shutdown) owns exactly one tracked timer.
    const p2 = ensureDecisionMenu(ctx, meta, config, { source: "command" });
    const r2 = await p2;
    expect(r2.retryArmed).toBe(true);
    expect(__decisionTimerCount()).toBe(1);

    // Only the replacement chain retries — the stale chain is inert.
    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(3); // stale #1, replacement #2, its retry #3
  });

  it("stale chain finishing later cannot prune the replacement runtime entry", async () => {
    begin();
    jest.useFakeTimers();
    meta.blockedReason = "max_loop_cycles";
    meta.loopCycleCount = 2;
    let release1!: (v: string | undefined) => void;
    let release2!: (v: string | undefined) => void;
    const gates = [
      new Promise<string | undefined>((res) => { release1 = res; }),
      new Promise<string | undefined>((res) => { release2 = res; }),
    ];
    let gateIdx = 0;
    ctx.ui!.select = async (message: string, options: string[]) => {
      selectCalls.push({ message, options });
      return gates[gateIdx++]!;
    };
    // The stale chain picks set_budget and the dialog throws → non-retryable
    // `decided && !applied`, so it runs its `finally` prune right away.
    (ctx.ui as NonNullable<FlowStateCtx["ui"]>).input = async () => {
      throw new Error("input dialog exploded");
    };

    const p1 = ensureDecisionMenu(ctx, meta, config, { source: "freeze" });
    await drain();
    clearAllDecisionTimers();
    const p2 = ensureDecisionMenu(ctx, meta, config, { source: "command" });
    await drain();
    expect(selectCalls.length).toBe(2);

    release1("Set round budget");
    const r1 = await p1;
    expect(r1.retryArmed).toBe(false);

    release2(undefined); // replacement chain dismisses fast → arms its retry
    const r2 = await p2;
    expect(r2.retryArmed).toBe(true);
    // The stale chain must NOT have deleted the replacement's table entry.
    expect(__decisionTimerCount()).toBe(1);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);

    // The surviving timer is reachable by the normal cleanup surface.
    clearDecisionTimer(meta.pipelineId);
    expect(__decisionTimerCount()).toBe(0);
  });
});

// ─── scheduleMenuRetry legacy surface ───────────────────────────────────────

describe("208 Phase 1: scheduleMenuRetry (legacy wrapper target)", () => {
  it("arms a pending retry without an immediate presentation", async () => {
    begin();
    jest.useFakeTimers();
    q("Resume");
    scheduleDecisionRetry(ctx, meta, config, 3);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);
    expect(selectCalls.length).toBe(0);
    jest.advanceTimersByTime(20000); // index 3 → 20s
    await drain();
    expect(selectCalls.length).toBe(1);
  });

  it("prevents stacking (one timer per pipeline)", async () => {
    begin();
    jest.useFakeTimers();
    let presentCalls = 0;
    // The first legacy arm is superseded; the second wins with delay 10s.
    scheduleDecisionRetry(ctx, meta, config, 1);
    scheduleMenuRetry(
      {
        readMeta: () => meta,
        isFrozen: (m) => m.flowState === "blocked" || m.currentStage === "awaiting_human",
        present: async () => {
          presentCalls++;
          return { outcome: "no-menu", applied: false };
        },
      },
      meta.pipelineId,
      2,
    );
    jest.advanceTimersByTime(5000);
    await drain();
    expect(presentCalls).toBe(0); // first timer was cleared; nothing fired at 5s
    jest.advanceTimersByTime(5000); // 10s reached
    await drain();
    expect(presentCalls).toBe(1); // only the surviving timer fired
  });

  it("clearDecisionTimer stops the specific pipeline only", async () => {
    begin();
    jest.useFakeTimers();
    q("Resume");
    scheduleDecisionRetry(ctx, meta, config, 1);
    clearDecisionTimer(meta.pipelineId);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(false);
    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(0);
    expect(__decisionTimerCount()).toBe(0);
  });
});
