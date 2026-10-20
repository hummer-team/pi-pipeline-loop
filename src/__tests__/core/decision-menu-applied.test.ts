/**
 * 208 Phase 0 — decision result propagation (`applied`), budget collection
 * via `ui.input`, and menu capability degradation.
 *
 * Covered acceptance items (plan §Phase 0 unit tests):
 * 1.  set_budget + ui.input "8" → applied=true, maxLoopCycles=8, no
 *     decision_not_applied audit
 * 2.  ui.input undefined → cancelled, no decision_not_applied (J1: no retry)
 * 3a. ui.input "abc" → interrupted + notify "positive number" (no audit)
 * 3b. ui.input "2" → interrupted + notify "must be greater than" (no audit)
 * 4.  ui.input throws → decided+applied=false, decision_not_applied
 *     reason="input_error", capability dropped
 * 5.  buildDecisionMenu capability filter ({input:false}) with/without rework
 *     back-edge
 * 6.  guard-rejected decision → applied=false + decision_not_applied
 *     reason="guard_rejected"; promptDecisionMenu still returns "decided"
 * 7.  unknown menu label → failureReason "unknown_option"
 * 8.  choose_stage secondary menu interrupt → interruptedStage="secondary";
 *     target miss → "stage_not_found"
 * 9.  validateBudgetValue boundaries
 * 12. decision_menu_presented on the secondary path (menuKind="secondary"),
 *     incl. directStageSelect first-call presentation
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import {
  buildDecisionMenu,
  promptDecisionMenu,
  promptDecisionMenuDetailed,
  validateBudgetValue,
  clearAllDecisionTimers,
} from "../../core/flow-state";
import type { FlowStateCtx } from "../../core/flow-state";
import {
  clearInputCapabilityOverrides,
  isInputUnavailable,
} from "../../core/decision-menu-runtime";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";

type CapturedAudit = {
  event: string;
  message: Record<string, string | boolean> | undefined;
  level: string | undefined;
};

function captureAudits(): CapturedAudit[] {
  const captured: CapturedAudit[] = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    captured.push({ event, message, level });
  });
  return captured;
}

/** Max-loop-cycles frozen fixture with a rework back-edge (review → develop). */
function maxLoopMeta(overrides?: Partial<SessionMeta>): SessionMeta {
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

function makeCtx(
  initMeta: SessionMeta,
  ui?: {
    select?: (msg: string, opts: string[]) => Promise<string | undefined>;
    input?: (msg: string) => Promise<string | undefined>;
    notify?: (msg: string) => void;
  },
): FlowStateCtx {
  return {
    session: {
      getMeta: () => initMeta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(initMeta, patch);
        return initMeta;
      },
    },
    ui: ui as FlowStateCtx["ui"],
  };
}

// State shared between beforeEach cleanup helpers
const audits: CapturedAudit[] = [];
let notifyCalls: string[] = [];

beforeEach(() => {
  audits.length = 0;
  notifyCalls = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
  clearInputCapabilityOverrides();
});

// ─── 1–4: set_budget through the menu ───────────────────────────────────────

describe("208 Phase 0: set_budget via ui.input", () => {
  it("test 1: ui.input '8' → applied=true, maxLoopCycles=8, no decision_not_applied", async () => {
    const meta = maxLoopMeta();
    const notify = (msg: string) => notifyCalls.push(msg);
    const ctx = makeCtx(meta, {
      select: async () => "Set round budget",
      input: async () => "8",
      notify,
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config, { source: "freeze" });
    expect(detail.outcome).toBe("decided");
    expect(detail.applied).toBe(true);
    expect(meta.maxLoopCycles).toBe(8);
    expect(meta.flowState).toBe("running");
    expect(audits.some((a) => a.event === "decision_not_applied")).toBe(false);
  });

  it("test 2: ui.input undefined → cancelled, no decision_not_applied (J1: empty/cancel never retried)", async () => {
    const meta = maxLoopMeta();
    const ctx = makeCtx(meta, {
      select: async () => "Set round budget",
      input: async () => undefined,
      notify: (msg: string) => notifyCalls.push(msg),
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(detail.outcome).toBe("cancelled");
    expect(detail.applied).toBe(false);
    expect(meta.flowState).toBe("blocked");
    expect(audits.some((a) => a.event === "decision_not_applied")).toBe(false);
  });

  it("test 3a: ui.input 'abc' (cycle 3) → interrupted, notify 'positive number', not audited", async () => {
    const meta = maxLoopMeta({ loopCycleCount: 3 });
    const ctx = makeCtx(meta, {
      select: async () => "Set round budget",
      input: async () => "abc",
      notify: (msg: string) => notifyCalls.push(msg),
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(detail.outcome).toBe("interrupted");
    expect(detail.applied).toBe(false);
    expect(notifyCalls.some((n) => n.includes("positive number"))).toBe(true);
    expect(audits.some((a) => a.event === "decision_not_applied")).toBe(false);
  });

  it("test 3b: ui.input '2' (cycle 3) → interrupted, notify 'must be greater than', not audited", async () => {
    const meta = maxLoopMeta({ loopCycleCount: 3 });
    const ctx = makeCtx(meta, {
      select: async () => "Set round budget",
      input: async () => "2",
      notify: (msg: string) => notifyCalls.push(msg),
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(detail.outcome).toBe("interrupted");
    expect(detail.applied).toBe(false);
    expect(notifyCalls.some((n) => n.includes("must be greater than"))).toBe(true);
    expect(audits.some((a) => a.event === "decision_not_applied")).toBe(false);
  });

  it("test 4: ui.input throws → decided+applied=false, audited input_error, capability dropped", async () => {
    const meta = maxLoopMeta();
    const ctx = makeCtx(meta, {
      select: async () => "Set round budget",
      input: async () => {
        throw new Error("dialog exploded");
      },
      notify: (msg: string) => notifyCalls.push(msg),
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(detail.outcome).toBe("decided");
    expect(detail.applied).toBe(false);
    expect(detail.failureReason).toBe("input_error");
    expect(detail.message).toContain("dialog exploded");
    expect(detail.retryable).toBe(false);

    const audit = audits.find((a) => a.event === "decision_not_applied");
    expect(audit).toBeDefined();
    expect(audit?.message?.["reason"]).toBe("input_error");
    expect(String(audit?.message?.["message"])).toContain("dialog exploded");
    expect(isInputUnavailable(meta.pipelineId)).toBe(true);
  });
});

// ─── 5: menu capability degradation ─────────────────────────────────────────

describe("208 Phase 0: buildDecisionMenu capability filter (J1)", () => {
  it("test 5a: with rework back-edge + input:false → 4 items, no Set round budget", () => {
    const meta = maxLoopMeta();
    const config = makeTestConfig();
    const menu = buildDecisionMenu(meta, "max_loop_cycles", config, { input: false });
    expect(menu).toEqual(["Rewind last_round", "Restart & New", "Abort & Exit", "Resume"]);
  });

  it("test 5b: without rework back-edge + input:false → 3 items", () => {
    const meta = maxLoopMeta({ stageVisitOrder: ["clarify", "plan", "develop"] });
    const config = makeTestConfig();
    const menu = buildDecisionMenu(meta, "max_loop_cycles", config, { input: false });
    expect(menu).toEqual(["Restart & New", "Abort & Exit", "Resume"]);
  });

  it("default capabilities keep the historical 3-arg call shape (set_budget present)", () => {
    const meta = maxLoopMeta();
    const config = makeTestConfig();
    const menu = buildDecisionMenu(meta, "max_loop_cycles", config);
    expect(menu).toContain("Set round budget");
    expect(menu).toContain("Rewind last_round");
  });
});

// ─── 6–8: decided-but-failed paths ──────────────────────────────────────────

describe("208 Phase 0: decided but not applied", () => {
  it("test 6: guard-rejected skip → applied=false + guard_rejected audit; promptDecisionMenu stays 'decided'", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      currentStage: "design-review",
      designReview: {
        schemaVersion: 1,
        planDoc: "/tmp/plan.md",
        planHash: "abc123",
        round: 1,
        authorizationId: "auth-1",
        authorizationSource: "menu",
        phase: "review_ready",
        authorizedAt: Date.now(),
        updatedAt: Date.now(),
      } as SessionMeta["designReview"],
    });
    const ctx = makeCtx(meta, {
      select: async () => "Skip",
      notify: (msg: string) => notifyCalls.push(msg),
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config, { source: "freeze" });
    expect(detail.outcome).toBe("decided");
    expect(detail.applied).toBe(false);
    expect(detail.failureReason).toBe("guard_rejected");
    expect(meta.flowState).toBe("blocked");

    const audit = audits.find((a) => a.event === "decision_not_applied");
    expect(audit).toBeDefined();
    expect(audit?.message?.["reason"]).toBe("guard_rejected");
    expect(audit?.message?.["decision"]).toBe("skip");

    // Legacy compat: promptDecisionMenu still returns the bare outcome.
    const outcome = await promptDecisionMenu(ctx, meta, config, { source: "freeze" });
    expect(outcome).toBe("decided");
  });

  it("test 7: unknown menu label → applied=false, failureReason='unknown_option', audited", async () => {
    const meta = maxLoopMeta({ blockedReason: "loop_overflow" });
    const ctx = makeCtx(meta, {
      select: async () => "Not an option",
      notify: (msg: string) => notifyCalls.push(msg),
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(detail.outcome).toBe("decided");
    expect(detail.applied).toBe(false);
    expect(detail.failureReason).toBe("unknown_option");
    expect(detail.message).toContain("Not an option");

    const audit = audits.find((a) => a.event === "decision_not_applied");
    expect(audit?.message?.["reason"]).toBe("unknown_option");
  });

  it("test 8a: choose_stage secondary menu fast undefined → interruptedStage='secondary'", async () => {
    const meta = maxLoopMeta({ blockedReason: "loop_overflow", stageVisitOrder: ["clarify", "plan", "develop"] });
    const ctx = makeCtx(meta, {
      select: async (msg) => {
        if (msg.startsWith("Choose stage")) {
          return undefined; // fast dismiss in secondary menu
        }
        return "Choose stage…";
      },
      notify: (msg: string) => notifyCalls.push(msg),
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(detail.outcome).toBe("interrupted");
    expect(detail.interruptedStage).toBe("secondary");
    expect(detail.applied).toBe(false);
  });

  it("test 8b: choose_stage target label not matching a stage → stage_not_found", async () => {
    const meta = maxLoopMeta({ blockedReason: "loop_overflow", stageVisitOrder: ["clarify", "plan", "develop"] });
    const ctx = makeCtx(meta, {
      select: async (msg) => {
        if (msg.startsWith("Choose stage")) {
          return "bogus-stage";
        }
        return "Choose stage…";
      },
      notify: (msg: string) => notifyCalls.push(msg),
    });
    const config = makeTestConfig();

    const detail = await promptDecisionMenuDetailed(ctx, meta, config);
    expect(detail.outcome).toBe("decided");
    expect(detail.applied).toBe(false);
    expect(detail.failureReason).toBe("stage_not_found");
    expect(detail.message).toContain("bogus-stage");

    const audit = audits.find((a) => a.event === "decision_not_applied");
    expect(audit?.message?.["reason"]).toBe("stage_not_found");
    expect(audit?.message?.["decision"]).toBe("choose_stage");
  });
});

// ─── 9: validateBudgetValue boundaries ──────────────────────────────────────

describe("208 Phase 0: validateBudgetValue boundaries", () => {
  it.each([
    [0, "positive number"],
    [-1, "positive number"],
    [Number.NaN, "positive number"],
    [Infinity, "positive number"],
  ])("test 9: %s is rejected (positive-number message)", (value, fragment) => {
    const verdict = validateBudgetValue(value, 3);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain(fragment);
  });

  it("test 9: value == current cycle count is rejected with the > current message", () => {
    const verdict = validateBudgetValue(3, 3);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain("must be greater than current loopCycleCount (3)");
  });

  it("test 9: current+1 is accepted", () => {
    expect(validateBudgetValue(4, 3)).toEqual({ ok: true });
  });
});

// ─── 12: decision_menu_presented semantics (G5) ─────────────────────────────

describe("208 Phase 0: decision_menu_presented audit", () => {
  it("test 12a: primary presentation audited before ui.select", async () => {
    const meta = maxLoopMeta({ blockedReason: "loop_overflow" });
    const openState = { kinds: [] as (string | undefined)[] };
    const ctx = makeCtx(meta, {
      select: async (_msg, options) => {
        // Audit must already exist when the dialog opens (written BEFORE select).
        openState.kinds = audits
          .filter((a) => a.event === "decision_menu_presented")
          .map((a) => a.message?.["menuKind"] as string | undefined);
        return options[0];
      },
    });
    const config = makeTestConfig();

    await promptDecisionMenuDetailed(ctx, meta, config, { source: "freeze" });
    expect(openState.kinds.join(",")).toBe("primary");
    const audit = audits.find((a) => a.event === "decision_menu_presented");
    expect(audit?.message?.["attempt"]).toBe("1");
    expect(audit?.message?.["source"]).toBe("freeze");
  });

  it("test 12b: secondary presentation audited with menuKind='secondary'", async () => {
    const meta = maxLoopMeta({ blockedReason: "loop_overflow", stageVisitOrder: ["clarify", "plan", "develop"] });
    const ctx = makeCtx(meta, {
      select: async (msg) => {
        if (msg.startsWith("Choose stage")) return "plan";
        return "Choose stage…";
      },
    });
    const config = makeTestConfig();

    await promptDecisionMenuDetailed(ctx, meta, config);
    const kinds = audits
      .filter((a) => a.event === "decision_menu_presented")
      .map((a) => a.message?.["menuKind"]);
    expect(kinds).toEqual(["primary", "secondary"]);
  });

  it("test 12c: directStageSelect first call presents the secondary menu directly", async () => {
    const meta = maxLoopMeta({ blockedReason: "loop_overflow", stageVisitOrder: ["clarify", "plan", "develop"] });
    const ctx = makeCtx(meta, {
      select: async (_msg, options) => options[0],
    });
    const config = makeTestConfig();

    await promptDecisionMenuDetailed(ctx, meta, config, { directStageSelect: true });
    const kinds = audits
      .filter((a) => a.event === "decision_menu_presented")
      .map((a) => a.message?.["menuKind"]);
    expect(kinds).toEqual(["secondary"]);
  });
});

// ─── no-UI degradation (notifyOnUnavailable plumbing) ───────────────────────

describe("208 Phase 0: no-UI branch", () => {
  it("default: no-UI notifies the freeze reason once and reports unavailable no_ui", async () => {
    const meta = maxLoopMeta({ blockedReason: "loop_overflow" });
    const config = makeTestConfig({ output: { pipelineStage: true } } as Partial<PipelineConfig>);
    const ctx = makeCtx(meta, { notify: (msg: string) => notifyCalls.push(msg) });

    const detail = await promptDecisionMenuDetailed(ctx, meta, config, { source: "freeze" });
    expect(detail.outcome).toBe("no-menu");
    expect(detail.unavailableReason).toBe("no_ui");
    expect(notifyCalls.length).toBe(1);
  });

  it("notifyOnUnavailable:false → zero notify (command owns the message)", async () => {
    const meta = maxLoopMeta({ blockedReason: "loop_overflow" });
    const config = makeTestConfig({ output: { pipelineStage: true } } as Partial<PipelineConfig>);
    const ctx = makeCtx(meta, { notify: (msg: string) => notifyCalls.push(msg) });

    const detail = await promptDecisionMenuDetailed(ctx, meta, config, { notifyOnUnavailable: false });
    expect(detail.outcome).toBe("no-menu");
    expect(notifyCalls.length).toBe(0);
  });
});
