/**
 * 217 review round 4 (issue 1, High): the declared-capability FORWARDING chain
 * `buildRuntimeCtx → requestDecision entry literal` must stay closed.
 *
 * The four production entries (`agent-settled` settle re-popup,
 * `session-starter` replay, `/pipeline-resume`, `/pipeline-start`) used to
 * hand requestDecision a hand-built object literal that carried only
 * `session / ui / _ctx` — silently dropping `hasUI`. Because `FlowStateCtx.hasUI`
 * is optional, `tsc` could not flag the drift, and the T2.2/T2.3 declared
 * gates read `undefined` on every real path while the unit tests (which
 * inject `hasUI` straight into a FlowStateCtx) kept passing.
 *
 * These tests rebuild the chain END TO END: a host ctx (with a `ui.select`
 * control AND a declared `hasUI=false`) is normalized by the real
 * `buildRuntimeCtx`, and the EXACT literal shape the production entries pass
 * to `requestDecision` is forwarded into the real runtime gates:
 * - policy disabled → presenter gate: ZERO select calls,
 *   `decision_menu_suppressed_declared_no_ui` audit, one visible hint;
 * - policy enabled (T2.3) → the decision goes through the POLICY channel, the
 *   human menu slot is never entered.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildRuntimeCtx } from "../../core/runtime-ctx";
import { requestDecision, clearAllDecisionTimers } from "../../core/flow-state";
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

/** Minimal pi/host mock — mirrors src/__tests__/core/runtime-ctx.test.ts. */
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

/** Max-loop frozen fixture (the decision menu pops for `max_loop_cycles`). */
function blockedMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    flowState: "blocked",
    blockedReason: "max_loop_cycles",
    loopCycleCount: 2,
    maxLoopCycles: 5,
    loopBudgetExtensionCount: 0,
    loopRewindCount: 0,
    stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"],
    ...overrides,
  });
}

/**
 * Build the runtime ctx from a REAL host declaration, then hand the EXACT
 * production-entry literal shape (session / ui / _ctx / hasUI) to the runtime.
 * The session slot is a stub backed by the fixture meta — the redirect of the
 * capability field is what this regression guards; the ctx-session shape is
 * covered by the runtime-ctx unit tests.
 */
function makeForwardedEntry(
  pi: ReturnType<typeof makeHostMocks>["pi"],
  hostCtx: ReturnType<typeof makeHostMocks>["ctx"],
  meta: SessionMeta,
) {
  const rctx = buildRuntimeCtx(pi, hostCtx);
  const session = {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      Object.assign(meta, patch);
      return meta;
    },
  };
  return {
    rctx,
    // Production-entry literal (flow: session / ui / _ctx / hasUI all ride on it).
    entry: { session, ui: rctx.ui, _ctx: rctx._ctx, hasUI: rctx.hasUI },
  };
}

describe("217 review issue 1: buildRuntimeCtx → requestDecision forwarding (real entry shape)", () => {
  it("declared false × select present × policy disabled → ZERO select, suppression audit, ONE hint", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    Object.assign(ctx.ui, { select: ctx.ui.select });
    const hostCtx = Object.assign(ctx, { hasUI: false });
    const meta = blockedMeta();
    const { rctx, entry } = makeForwardedEntry(pi, hostCtx, meta);

    // The declaration survived normalization into the runtime ctx...
    expect(rctx.hasUI).toBe(false);

    const config: PipelineConfig = makeTestConfig({ output: { pipelineStage: true } });
    const detail = await requestDecision(entry, meta, config, "max_loop_cycles", { source: "settle" });

    // ...and the forwarded entry keeps it load-bearing at the T2.2 gate.
    expect(selectCalls).toHaveLength(0); // declared false WINS over ui.select
    expect(detail?.outcome).toBe("no-menu");
    expect(detail?.unavailableReason).toBe("no_ui"); // literal kept per plan
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(true);
    expect(audits.some((a) => a.event === "pipeline_decision_interrupted")).toBe(false);
    // The suppression is VISIBLE, not silent.
    expect(notifies.some((n) => n.includes("Pipeline frozen"))).toBe(true);
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
    const meta = blockedMeta();
    const { rctx, entry } = makeForwardedEntry(pi, hostCtx, meta);

    expect(rctx.hasUI).toBe(false); // true this-interaction resolved at build time

    const config: PipelineConfig = makeTestConfig();
    const detail = await requestDecision(entry, meta, config, "max_loop_cycles", { source: "replay" });

    expect(selectCalls).toHaveLength(0);
    expect(detail?.unavailableReason).toBe("no_ui");
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(true);
  });

  it("declared false × select present × policy enabled (T2.3) → policy channel, human menu slot NEVER entered", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    const hostCtx = Object.assign(ctx, { hasUI: false });
    const meta = blockedMeta({ blockedReason: "violation_overflow" });
    const originalId = meta.pipelineId;
    const { entry } = makeForwardedEntry(pi, hostCtx, meta);

    const config = makeTestConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decisionPolicy: { enabled: true, byReason: { violation_overflow: { decision: "restart" } } } as any,
    });

    const result = await requestDecision(entry, meta, config, "violation_overflow", { source: "settle" });

    expect(result).toBeNull(); // the chain resolved WITHOUT presenting a menu
    expect(meta.pipelineId).not.toBe(originalId); // the restart decision executed
    expect(selectCalls).toHaveLength(0); // declared false never enters the slot
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(false);
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(false);
  });

  it("declared true × select present → menu still presented (no over-suppression)", async () => {
    const { pi, ctx, selectCalls } = makeHostMocks();
    const hostCtx = Object.assign(ctx, { hasUI: true });
    const meta = blockedMeta();
    const { rctx, entry } = makeForwardedEntry(pi, hostCtx, meta);

    expect(rctx.hasUI).toBe(true);

    const config: PipelineConfig = makeTestConfig();
    await requestDecision(entry, meta, config, "max_loop_cycles", { source: "settle" });

    // A declared-true host WITH a real select opens the menu as before.
    expect(selectCalls).toHaveLength(1);
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(true);
  });
});
