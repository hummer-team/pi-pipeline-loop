/**
 * 217 review round 4 (issue 1, High): the declared-capability FORWARDING chain
 * must stay closed on EVERY production entry that reconstructs a
 * `FlowStateCtx`-shaped literal — not only the four `requestDecision` entries
 * (regression: request-decision-hasui-forwarding-217.test.ts) but also the
 * free-thaw entries:
 *
 *   freezeAndPrompt literals:
 *   - agent-settled.ts        (design-review budget freeze / confirm-gate   ↯  confirm_awaiting_human)
 *   - pipeline-start.ts       (resume-time design-review budget freeze)
 *   - stage-advancer.ts       (advance-time design-review budget freeze)
 *   recordStageExitRefusal literals:
 *   - agent-settled.ts / verify-advance.ts (bound_run_owner_mismatch defer)
 *     whose `toFlowCtx` boundary hands freezeAndPrompt the FlowStateCtx.
 *   consume-literals that APPLY verify fails → freezeAndPrompt(ctx):
 *   - DesignReviewConsumeCtx mirrors in pipeline-start / pipeline-resume /
 *     session-starter / agent-settled / stage-advancer
 *     (VerifyAdvanceCtx contract: applyVerifyFail → freezeAndPrompt(ctx)).
 *
 * These tests rebuild the chain END TO END: a host ctx (with a `ui.select`
 * control AND a declared `hasUI=false`) is normalized by the real
 * `buildRuntimeCtx`, and the EXACT literal shape produced by the fixed
 * production entries (session / ui / pi / _ctx / hasUI) drives the real
 * gates. Declared `false` wins over a present `select`:
 * - T2.2 presenter gate: ZERO select calls, `decision_menu_suppressed_declared_no_ui`
 *   audit, one visible hint;
 * - T2.3 (policy enabled): the decision goes through the POLICY channel —
 *   the human menu slot is never entered.
 * A tripwire case keeps the field load-bearing: dropping `hasUI` from the
 * literal re-opens the menu (select IS called) — so reverting any of the
 * production fixes turns these tests red.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildRuntimeCtx } from "../../core/runtime-ctx";
import { freezeAndPrompt, clearAllDecisionTimers } from "../../core/flow-state";
import { recordStageExitRefusal } from "../../core/stage-exit/stage-exit-refusal";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";

type CapturedAudit = {
  event: string;
  message: Record<string, string | boolean> | undefined;
  level: string | undefined;
};

const audits: CapturedAudit[] = [];
let notifies: string[] = [];

beforeEach(() => {
  audits.length = 0;
  notifies = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
});

/** Minimal pi/host mock — mirrors request-decision-hasui-forwarding-217.test.ts. */
function makeHostMocks() {
  const pi = {
    appendEntry: (_type: string, _data: unknown) => { /* not exercised here */ },
  } as any;

  const selectCalls: string[][] = [];
  const select = async (_message: string, options: string[]) => {
    selectCalls.push(options);
    return "Resume";
  };
  const ctx = {
    ui: {
      select,
      notify: (msg: string) => { notifies.push(msg); },
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
    },
  } as any;

  return { pi, ctx, selectCalls };
}

/**
 * RUNNING fixture (the freeze itself is performed by freezeAndPrompt /
 * recordStageExitRefusal and the menu pops right after — unlike the
 * requestDecision regression, whose meta is already frozen).
 */
function runningMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    requirementDoc: "docs/req.md",
    ...overrides,
  });
}

/**
 * Build the runtime ctx from a REAL host declaration, then hand the EXACT
 * production-entry literal shape (session / ui / pi / _ctx / hasUI — the
 * shape fixed in round 4) to the runtime gates. The session slot is a stub
 * backed by the fixture meta — the forwarding of the capability field is
 * what this regression guards.
 */
function makeForwardedEntry(
  pi: ReturnType<typeof makeHostMocks>["pi"],
  hostCtx: ReturnType<typeof makeHostMocks>["ctx"],
  meta: SessionMeta,
  opts?: { omitHasUI?: boolean },
) {
  const rctx = buildRuntimeCtx(pi, hostCtx);
  const session = {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      Object.assign(meta, patch);
      return meta;
    },
  };
  // Production-entry literal as fixed in round 4:
  // { session, ui, pi, _ctx, hasUI } — freezeAndPrompt / recordStageExitRefusal
  // (via toFlowCtx) are handed exactly this shape.
  const entry = opts?.omitHasUI
    ? { session, ui: rctx.ui, pi: rctx.pi, _ctx: rctx._ctx }
    : { session, ui: rctx.ui, pi: rctx.pi, _ctx: rctx._ctx, hasUI: rctx.hasUI };
  return { rctx, entry };
}

const SUPPRESSED_AUDIT = "decision_menu_suppressed_declared_no_ui";

describe("217 review round 4: freeze-entry hasUI forwarding (freezeAndPrompt literals)", () => {
  it("declared false × select present × budget-freeze shape (opts.ui) → ZERO select, suppression audit, ONE hint", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    const hostCtx = Object.assign(ctx, { hasUI: false });
    const meta = runningMeta();
    const { rctx, entry } = makeForwardedEntry(pi, hostCtx, meta);

    // The declaration survived normalization into the runtime ctx...
    expect(rctx.hasUI).toBe(false);

    const config: PipelineConfig = makeTestConfig();
    // opts.ui mirrors agent-settled.ts / stage-advancer.ts / pipeline-start.ts
    // freezeAndPrompt(..., { ui }) budget-freeze entries.
    await freezeAndPrompt(
      { session: entry.session, ui: entry.ui, pi: entry.pi, _ctx: entry._ctx, hasUI: entry.hasUI },
      meta,
      "max_loop_cycles",
      config,
      { ui: entry.ui },
    );

    // ...and the forwarded entry keeps it load-bearing at the T2.2 gate.
    expect(selectCalls).toHaveLength(0); // declared false WINS over ui.select
    expect(meta.flowState).toBe("blocked"); // the freeze itself still executed
    expect(audits.some((a) => a.event === SUPPRESSED_AUDIT)).toBe(true);
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(false);
    expect(audits.some((a) => a.event === "pipeline_decision_interrupted")).toBe(false);
    // The suppression is VISIBLE, not silent.
    expect(notifies.some((n) => n.includes("Pipeline frozen"))).toBe(true);
  });

  it("declared false × select present × no opts (confirm_awaiting_human shape) → same suppression", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    const hostCtx = Object.assign(ctx, { hasUI: false });
    const meta = runningMeta();
    const { entry } = makeForwardedEntry(pi, hostCtx, meta);

    const config: PipelineConfig = makeTestConfig();
    // No opts mirrors agent-settled.ts confirm-gate re-ask exhaustion
    // (freezeAndPrompt(..., "confirm_awaiting_human", config)).
    await freezeAndPrompt(entry, meta, "confirm_awaiting_human", config);

    expect(selectCalls).toHaveLength(0);
    expect(meta.flowState).toBe("blocked");
    expect(audits.some((a) => a.event === SUPPRESSED_AUDIT)).toBe(true);
  });

  it("method-form declaration resolved against the HOST ctx → forwarded value false → same suppression", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    // Runner-style host: hasUI is a method reading its own context fields
    // (212_Bug.md:154). buildRuntimeCtx resolves it ONCE against the host.
    const hostCtx = Object.assign(ctx, {
      interactive: false,
      hasUI(this: { interactive: boolean }) {
        return this.interactive;
      },
    });
    const meta = runningMeta();
    const { rctx, entry } = makeForwardedEntry(pi, hostCtx, meta);

    expect(rctx.hasUI).toBe(false); // true this-interaction resolved at build time

    const config: PipelineConfig = makeTestConfig();
    await freezeAndPrompt(entry, meta, "max_loop_cycles", config, { ui: entry.ui });

    expect(selectCalls).toHaveLength(0);
    expect(audits.some((a) => a.event === SUPPRESSED_AUDIT)).toBe(true);
  });

  it("declared false × policy enabled (T2.3) → decision via POLICY channel, human menu slot NEVER entered", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    const hostCtx = Object.assign(ctx, { hasUI: false });
    const meta = runningMeta();
    const originalId = meta.pipelineId;
    const { entry } = makeForwardedEntry(pi, hostCtx, meta);

    const config = makeTestConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decisionPolicy: { enabled: true, byReason: { violation_overflow: { decision: "restart" } } } as any,
    });

    await freezeAndPrompt(entry, meta, "violation_overflow", config);

    expect(selectCalls).toHaveLength(0); // declared false never enters the human slot
    expect(meta.pipelineId).not.toBe(originalId); // the restart decision executed
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(false);
    expect(audits.some((a) => a.event === SUPPRESSED_AUDIT)).toBe(false); // policy channel, not menu suppression
  });

  it("TRIPWIRE: hasUI dropped from the literal × select present → menu re-opens (select IS called)", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    // No declared capability — the legacy reverse-inference fallback applies.
    const meta = runningMeta();
    const { entry } = makeForwardedEntry(pi, ctx, meta, { omitHasUI: true });

    const config: PipelineConfig = makeTestConfig();
    await freezeAndPrompt(entry, meta, "max_loop_cycles", config, { ui: entry.ui });

    expect(selectCalls).toHaveLength(1); // undeclared falls back to select presence
    expect(audits.some((a) => a.event === SUPPRESSED_AUDIT)).toBe(false);
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(true);
  });
});

describe("217 review round 4: freeze-entry hasUI forwarding (recordStageExitRefusal → toFlowCtx boundary)", () => {
  /** Overflow fixture: ONE prior same-cause refusal (count 1) → this call makes it 2 → freeze. */
  function refusalFixture(meta: SessionMeta) {
    const prev = {
      stage: meta.currentStage,
      fromStage: meta.currentStage,
      toStage: "review" as const,
      reason: "bound_run_owner_mismatch",
      count: 1,
      frozenCount: 0,
      lastAt: Date.now(),
    };
    meta.stageExitRefusal = prev;
    return {
      stage: meta.currentStage,
      fromStage: meta.currentStage,
      toStage: "review" as const,
      reason: "bound_run_owner_mismatch",
      source: "hook_settle" as const,
    };
  }

  it("declared false × select present × owner overflow freeze → ZERO select, suppression audit (T2.2 reached through toFlowCtx)", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    const hostCtx = Object.assign(ctx, { hasUI: false });
    const meta = runningMeta();
    const { rctx, entry } = makeForwardedEntry(pi, hostCtx, meta);

    expect(rctx.hasUI).toBe(false);
    const input = refusalFixture(meta);
    // consumeDesignReviewResult ctx shape: the entry handed to
    // recordStageExitRefusal by agent-settled.ts / verify-advance.ts must
    // carry hasUI — toFlowCtx forwards it into freezeAndPrompt.
    const outcome = await recordStageExitRefusal(
      { session: entry.session, ui: entry.ui, pi: entry.pi, _ctx: entry._ctx, hasUI: entry.hasUI },
      makeTestConfig(),
      input,
    );

    expect(outcome).toBe("frozen"); // refusal overflow (count 2) froze the pipeline
    expect(meta.flowState).toBe("blocked");
    expect(audits.some((a) => a.event === "stage_exit_refusal_overflow")).toBe(true);
    expect(selectCalls).toHaveLength(0); // the frozen menu did NOT re-present to a declared-no-UI host
    expect(audits.some((a) => a.event === SUPPRESSED_AUDIT)).toBe(true);
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(false);
  });

  it("TRIPWIRE: hasUI dropped at the refusal boundary × select present → menu re-opens after the overflow freeze", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    const meta = runningMeta();
    const { entry } = makeForwardedEntry(pi, ctx, meta, { omitHasUI: true });

    const input = refusalFixture(meta);
    const outcome = await recordStageExitRefusal(
      { session: entry.session, ui: entry.ui, pi: entry.pi, _ctx: entry._ctx },
      makeTestConfig(),
      input,
    );

    expect(outcome).toBe("frozen");
    expect(selectCalls).toHaveLength(1); // dropping the capability re-opens the menu
    expect(audits.some((a) => a.event === SUPPRESSED_AUDIT)).toBe(false);
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(true);
  });
});
