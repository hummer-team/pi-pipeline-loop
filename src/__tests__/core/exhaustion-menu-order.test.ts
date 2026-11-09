/**
 * `max_loop_cycles` decision menu: item order and the loop-exhaustion doors
 * (195 behaviour + 229 Phase 5 additions).
 *
 * Relocated from `src/__tests__/core/flow-state.test.ts` (which is already
 * well past the 1000-line ceiling) so the file stops growing; the 229
 * additions — `Degraded pass (advance)` and `Reset loop budget (raises the
 * cap)` — are asserted here. The legacy 195 expectations are preserved
 * verbatim except for the two inserted doors.
 */
import { describe, it, expect } from "bun:test";
import { buildDecisionMenu } from "../../core/flow-state";
import type { SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";

/** The canonical product chain (review → fix → review is the rework edge). */
const chainConfig = makeTestConfig({
  stages: {
    clarify: { nextStage: "plan" } as never,
    plan: { nextStage: "develop" } as never,
    "design-review": { nextStage: "develop" } as never,
    develop: { nextStage: "review" } as never,
    review: { nextStage: "fix" } as never,
    fix: { nextStage: "review" } as never,
    awaiting_human: { nextStage: null } as never,
    completed: { nextStage: null } as never,
  },
});

/** A frozen `max_loop_cycles` meta; `visitOrder` decides the rework gate. */
function maxLoopMeta(
  visitOrder: SessionMeta["stageVisitOrder"],
  overrides: Partial<SessionMeta> = {},
): SessionMeta {
  return makeTestMeta({
    flowState: "blocked",
    blockedReason: "max_loop_cycles",
    loopCycleCount: 5,
    maxLoopCycles: 5,
    loopBudgetExtensionCount: 0,
    loopRewindCount: 0,
    stageVisitOrder: visitOrder,
    ...overrides,
  });
}

const BACK_EDGE: SessionMeta["stageVisitOrder"] = ["clarify", "plan", "develop", "review", "develop"];
const FORWARD_ONLY: SessionMeta["stageVisitOrder"] = ["clarify", "plan", "develop"];

const LEGACY_SIX = ["Resume", "Skip", "Rollback", "Restart & New", "Abort & Exit", "Choose stage…"];

describe("Phase 6 (195): max_loop_cycles dynamic menu (+ 229 exhaustion doors)", () => {
  it("max_loop_cycles with full budget remaining shows every item", () => {
    // The backward edge (review → develop) makes `deriveReworkLoopGate` return
    // `review`, so `Rewind last_round` is offered.
    const menu = buildDecisionMenu(
      maxLoopMeta(BACK_EDGE, { loopCycleCount: 2 }),
      "max_loop_cycles",
      chainConfig,
    );
    // Plan order: Set round budget first, then the 229 doors, then rewind,
    // restart/abort, and finally Resume.
    expect(menu).toEqual([
      "Set round budget",
      "Degraded pass (advance)",
      "Reset loop budget (raises the cap)",
      "Rewind last_round",
      "Restart & New",
      "Abort & Exit",
      "Resume",
    ]);
  });

  // 203_Bug Phase 1: menu gating removed — set_budget/rewind/resume are
  // always offered; only the structural rework-gate condition remains.
  it("max_loop_cycles with no budget remaining still shows resume (gates removed)", () => {
    const menu = buildDecisionMenu(maxLoopMeta(BACK_EDGE), "max_loop_cycles", chainConfig);
    expect(menu).toEqual([
      "Set round budget",
      "Degraded pass (advance)",
      "Reset loop budget (raises the cap)",
      "Rewind last_round",
      "Restart & New",
      "Abort & Exit",
      "Resume",
    ]);
  });

  it("max_loop_cycles with loopBudgetExtensionCount >= 1 still shows set_budget (gates removed)", () => {
    const menu = buildDecisionMenu(
      maxLoopMeta(BACK_EDGE, { loopBudgetExtensionCount: 1 }),
      "max_loop_cycles",
      chainConfig,
    );
    expect(menu).toEqual([
      "Set round budget",
      "Degraded pass (advance)",
      "Reset loop budget (raises the cap)",
      "Rewind last_round",
      "Restart & New",
      "Abort & Exit",
      "Resume",
    ]);
  });

  it("max_loop_cycles with loopRewindCount >= 1 still shows rewind_last_round (gates removed)", () => {
    const menu = buildDecisionMenu(
      maxLoopMeta(BACK_EDGE, { loopRewindCount: 1 }),
      "max_loop_cycles",
      chainConfig,
    );
    expect(menu).toEqual([
      "Set round budget",
      "Degraded pass (advance)",
      "Reset loop budget (raises the cap)",
      "Rewind last_round",
      "Restart & New",
      "Abort & Exit",
      "Resume",
    ]);
  });

  it("max_loop_cycles with no rework gate (null) hides rewind_last_round", () => {
    const menu = buildDecisionMenu(maxLoopMeta(FORWARD_ONLY), "max_loop_cycles", chainConfig);
    expect(menu).toEqual([
      "Set round budget",
      "Degraded pass (advance)",
      "Reset loop budget (raises the cap)",
      "Restart & New",
      "Abort & Exit",
      "Resume",
    ]);
    expect(menu).not.toContain("Rewind last_round");
  });

  it("max_loop_cycles with all limits reached shows every item (gates removed)", () => {
    const menu = buildDecisionMenu(
      maxLoopMeta(BACK_EDGE, { loopBudgetExtensionCount: 1, loopRewindCount: 1 }),
      "max_loop_cycles",
      chainConfig,
    );
    expect(menu).toEqual([
      "Set round budget",
      "Degraded pass (advance)",
      "Reset loop budget (raises the cap)",
      "Rewind last_round",
      "Restart & New",
      "Abort & Exit",
      "Resume",
    ]);
  });

  it("non-max_loop_cycles blockedReason returns the standard 6-item menu", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
    expect(buildDecisionMenu(meta, "loop_overflow", chainConfig)).toEqual(LEGACY_SIX);
  });

  it("undefined blockedReason returns the standard 6-item menu", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: undefined });
    expect(buildDecisionMenu(meta, undefined, chainConfig)).toEqual(LEGACY_SIX);
  });
});

describe("229 Phase 5: input capability hides the numeric doors only", () => {
  it("input:false keeps the degraded pass but drops both numeric doors", () => {
    const menu = buildDecisionMenu(maxLoopMeta(BACK_EDGE), "max_loop_cycles", chainConfig, { input: false });
    expect(menu).toEqual([
      "Degraded pass (advance)",
      "Rewind last_round",
      "Restart & New",
      "Abort & Exit",
      "Resume",
    ]);
  });

  it("input:false without a rework gate drops the numeric doors and rewind", () => {
    const menu = buildDecisionMenu(maxLoopMeta(FORWARD_ONLY), "max_loop_cycles", chainConfig, { input: false });
    expect(menu).toEqual(["Degraded pass (advance)", "Restart & New", "Abort & Exit", "Resume"]);
  });
});

describe("229 Phase 5: generic menu grows the exhaustion doors", () => {
  it("appends advance + reset_loop_budget after the legacy six items", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "no_progress_detected" });
    expect(buildDecisionMenu(meta, "no_progress_detected", chainConfig)).toEqual([
      ...LEGACY_SIX,
      "Degraded pass (advance)",
      "Reset loop budget (raises the cap)",
    ]);
  });

  it("every production exhaustion reason offers the doors (problem 17)", () => {
    for (const reason of [
      "no_progress_detected",
      "design_review_budget_exhausted",
      "review_loop_budget_exhausted",
      "max_loop_cycles",
    ]) {
      const meta = makeTestMeta({ flowState: "blocked", blockedReason: reason });
      const menu = buildDecisionMenu(meta, reason, chainConfig) ?? [];
      expect(menu).toContain("Degraded pass (advance)");
      expect(menu).toContain("Reset loop budget (raises the cap)");
    }
  });
});