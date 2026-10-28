/**
 * 217 Phase 2 (T2.1–T2.3): frozen-menu capability unification.
 *
 * The "may this session open a menu" judgment reads the HOST-DECLARED
 * capability first (`hasUI`), with the legacy `typeof ui.select` reverse-
 * inference kept ONLY as the undeclared fallback. Boundary matrix from the
 * plan:
 * - declared false × select present → select NEVER called, ONE suppression
 *   audit (`decision_menu_suppressed_declared_no_ui`) + ONE visible hint,
 *   `unavailableReason` stays the `no_ui` literal;
 * - declared false × no select → same (suppression, not the legacy event);
 * - undeclared × no select → legacy branch verbatim
 *   (`pipeline_decision_interrupted context=no_ui`, NO suppression audit);
 * - undeclared × select → menu presented;
 * - declared TRUE × no select → legacy no-ui treatment (213 D18: a declared
 *   host without a real select cannot open a menu);
 * - declared TRUE × select → menu presented;
 * - function-form declaration (runner-style host) normalizes the same way;
 * - `notifyOnUnavailable: false` → zero notify (command entries own the copy);
 * - `requestDecision` (T2.3): declared false + policy enabled → the decision
 *   goes through the POLICY channel even though a `select` is technically
 *   present (R2-Q3=A: declared false never enters the human menu slot).
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import {
  promptDecisionMenuDetailed,
  requestDecision,
  clearAllDecisionTimers,
} from "../../core/flow-state";
import type { FlowStateCtx } from "../../core/flow-state";
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

/** Max-loop frozen fixture (decision menu pops for `max_loop_cycles`). */
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

interface CtxOptions {
  select?: (msg: string, options: string[]) => Promise<string | undefined>;
  hasUI?: boolean | (() => boolean);
}

function makeCtx(meta: SessionMeta, opts: CtxOptions = {}): FlowStateCtx {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: {
      select: opts.select,
      notify: (msg: string) => { notifies.push(msg); },
    } as FlowStateCtx["ui"],
    // 217 T2.1: the declared capability rides on the runtime ctx.
    ...(opts.hasUI !== undefined ? { hasUI: opts.hasUI as boolean | (() => boolean) } : {}),
  };

}

const selectCalls = (select?: (msg: string, options: string[]) => Promise<string | undefined>): string[] => {
  if (!select) return [];
  return (select as unknown as { calls?: string[] }).calls ?? (select as any)._calls ?? [];
};

/** Counting select that records every menu it was offered. */
function countingSelect(returnValue: string | undefined = undefined) {
  const seen: string[] = [];
  const fn = async (_msg: string, ...rest: unknown[]) => {
    seen.push(String(rest[0]?.toString().slice(0, 30) ?? ""));
    return returnValue;
  };
  return Object.assign(fn, { calls: seen }) as unknown as ((msg: string, options: string[]) => Promise<string | undefined>) & { calls: string[] };
}

describe("217 T2.2: presenter gate reads the declared capability first", () => {
  it("declared false × select present → no select, suppression audit, ONE hint", async () => {
    const meta = blockedMeta();
    const select = countingSelect("Resume");
    const ctx = makeCtx(meta, { select, hasUI: false });
    const config: PipelineConfig = makeTestConfig({ output: { pipelineStage: true } });

    const detail = await promptDecisionMenuDetailed(ctx, meta, config, { source: "freeze" });

    expect(select.calls).toHaveLength(0); // declared false WINS over ui.select
    expect(detail.outcome).toBe("no-menu");
    expect(detail.unavailableReason).toBe("no_ui"); // literal kept per plan
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(true);
    // The suppression is VISIBLE, not silent.
    expect(notifies.some((n) => n.includes("Pipeline frozen"))).toBe(true);
    // ...and NOT a legacy no-UI event.
    expect(audits.some((a) => a.event === "pipeline_decision_interrupted")).toBe(false);
  });

  it("declared false × no select → suppression (not the legacy no_ui event)", async () => {
    const meta = blockedMeta();
    const ctx = makeCtx(meta, { hasUI: false });
    const config: PipelineConfig = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);

    expect(detail.unavailableReason).toBe("no_ui");
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(true);
    expect(audits.some((a) => a.event === "pipeline_decision_interrupted")).toBe(false);
  });

  it("undeclared × no select → legacy branch verbatim (no suppression audit)", async () => {
    const meta = blockedMeta();
    const ctx = makeCtx(meta);
    const config: PipelineConfig = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);

    expect(detail.unavailableReason).toBe("no_ui");
    const legacy = audits.filter((a) => a.event === "pipeline_decision_interrupted");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.message?.context).toBe("no_ui");
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(false);
  });

  it("undeclared × select → menu presented (legacy behavior byte-for-byte)", async () => {
    const meta = blockedMeta();
    const select = countingSelect(undefined); // user Esc (undefined) → cancelled
    const ctx = makeCtx(meta, { select });
    const config: PipelineConfig = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(select.calls).toHaveLength(1);
    // An INSTANT undefined resolution is the 173 interrupt path (resolved
    // faster than DECISION_DISMISS_INTERRUPT_MS); either way the menu ran.
    expect(detail.outcome).toBe("interrupted");
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(true);
  });

  it("declared true × no select → legacy no-ui treatment (213 D18)", async () => {
    const meta = blockedMeta();
    const select = countingSelect();
    const ctx = makeCtx(meta, { select: undefined, hasUI: true });
    const config: PipelineConfig = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(select.calls).toHaveLength(0);
    expect(detail.unavailableReason).toBe("no_ui");
    // NOT the declared-false suppression — the host declared a UI, it just has
    // no select control; the legacy no-UI branch owns this shape.
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(false);
    expect(audits.some((a) => a.event === "pipeline_decision_interrupted")).toBe(true);
  });

  it("declared true × select → menu presented", async () => {
    const meta = blockedMeta();
    const select = countingSelect(undefined);
    const ctx = makeCtx(meta, { select, hasUI: true });
    const config: PipelineConfig = makeTestConfig();

    await promptDecisionMenuDetailed(ctx, meta, config);
    expect(select.calls).toHaveLength(1);
  });

  it("function-form declaration false (runner host) → suppressed the same way", async () => {
    const meta = blockedMeta();
    const select = countingSelect("Resume");
    const ctx = makeCtx(meta, { select, hasUI: () => false });
    const config: PipelineConfig = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(select.calls).toHaveLength(0);
    expect(detail.unavailableReason).toBe("no_ui");
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(true);
  });

  it("method form with a `this`-dependent body (host binding survived upstream) → declared false still WINS", async () => {
    // 217 review issue 3: runner-style hosts declare hasUI as a METHOD that
    // reads its own context fields. The declaration is normalized against the
    // host ctx upstream (runtime-ctx), so what reaches flow-state is a bound
    // function — resolution here must invoke it and honor the false verdict
    // instead of degrading it to "undeclared" (which would lose the
    // "declared false WINS" ruling against a present `select`).
    const host = {
      interactive: false,
      hasUI(this: { interactive: boolean }) {
        return this.interactive;
      },
    };
    const meta = blockedMeta();
    const select = countingSelect("Resume");
    const ctx = makeCtx(meta, { select, hasUI: host.hasUI.bind(host) });
    const config: PipelineConfig = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);

    expect(select.calls).toHaveLength(0); // declared false beats the present select
    expect(detail.unavailableReason).toBe("no_ui");
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(true);
  });

  it("method form bound to a context-declaring-true host × select → menu presented", async () => {
    const host = {
      interactive: true,
      hasUI(this: { interactive: boolean }) {
        return this.interactive;
      },
    };
    const meta = blockedMeta();
    const select = countingSelect(undefined);
    const ctx = makeCtx(meta, { select, hasUI: host.hasUI.bind(host) });
    const config: PipelineConfig = makeTestConfig();

    await promptDecisionMenuDetailed(ctx, meta, config);
    expect(select.calls).toHaveLength(1);
  });

  it("notifyOnUnavailable: false → suppression audit but ZERO notify", async () => {
    const meta = blockedMeta();
    const select = countingSelect("Resume");
    const ctx = makeCtx(meta, { select, hasUI: false });
    const config: PipelineConfig = makeTestConfig();

    await promptDecisionMenuDetailed(ctx, meta, config, { notifyOnUnavailable: false });
    expect(notifies).toHaveLength(0);
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(true);
  });
});

describe("217 T2.3: requestDecision keeps declared-false in the policy channel", () => {
  it("declared false × select present × policy enabled → policy applies, menu NEVER opens", async () => {
    const meta = blockedMeta({ blockedReason: "violation_overflow" });
    const select = countingSelect("Resume");
    const ctx = makeCtx(meta, { select, hasUI: false });
    const config = makeTestConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decisionPolicy: { enabled: true, byReason: { violation_overflow: { decision: "restart" } } } as any,
    });

    const originalId = meta.pipelineId;
    const result = await requestDecision(ctx, meta, config, "violation_overflow");

    expect(result).toBeNull(); // no waiting object — the policy resolved it
    expect(meta.pipelineId).not.toBe(originalId); // restart decision executed
    expect(select.calls).toHaveLength(0); // declared false never enters the slot
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(false);
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(false);
  });

  it("undeclared × no select × policy enabled → legacy provider_absent abort (untouched)", async () => {
    const meta = blockedMeta({ blockedReason: "violation_overflow" });
    const select = countingSelect("Resume");
    const ctx = makeCtx(meta, { select: undefined });
    const config = makeTestConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decisionPolicy: { enabled: true, byReason: {} } as any,
    });

    await requestDecision(ctx, meta, config, "violation_overflow");
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("decision_provider_absent");
    expect(select.calls).toHaveLength(0);
  });

  it("policy disabled × declared false → presenter suppression still applies", async () => {
    const meta = blockedMeta();
    const select = countingSelect("Resume");
    const ctx = makeCtx(meta, { select, hasUI: false });
    const config = makeTestConfig({ decisionPolicy: { enabled: false } as never });

    await requestDecision(ctx, meta, config, "max_loop_cycles");
    expect(select.calls).toHaveLength(0);
    expect(audits.some((a) => a.event === "decision_menu_suppressed_declared_no_ui")).toBe(true);
  });
});
