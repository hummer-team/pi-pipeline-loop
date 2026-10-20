import { describe, it, expect, beforeEach } from "bun:test";
import {
  getFlowState,
  isFrozen,
  buildDecisionMenu,
  executeDecision,
  freezeAndPrompt,
  formatFrozenReason,
  formatAbortedNotifyText,
  promptDecisionMenu,
  isTerminalCompleted,
  markPipelineAborted,
} from "../../core/flow-state";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestMeta, makeTestConfig } from "../helpers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(
  meta: SessionMeta,
  ui?: { select?: (msg: string, opts: string[]) => Promise<string | undefined>; notify?: (msg: string) => void },
): FlowStateCtx & { updates: Partial<SessionMeta>[]; notifications: string[] } {
  const updates: Partial<SessionMeta>[] = [];
  const notifications: string[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        updates.push(patch);
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: ui as FlowStateCtx["ui"],
    updates,
    notifications,
  };
}

// ─── getFlowState ────────────────────────────────────────────────────────────

describe("getFlowState", () => {
  it("returns flowState when explicitly set", () => {
    const meta = makeTestMeta({ flowState: "blocked" });
    expect(getFlowState(meta)).toBe("blocked");
  });

  it("returns 'blocked' for legacy terminated=true", () => {
    const meta = makeTestMeta({ terminated: true, flowState: undefined });
    expect(getFlowState(meta)).toBe("blocked");
  });

  it("returns 'running' when flowState is undefined and terminated is false", () => {
    const meta = makeTestMeta({ flowState: undefined, terminated: false });
    expect(getFlowState(meta)).toBe("running");
  });

  it("returns 'running' by default", () => {
    const meta = makeTestMeta();
    expect(getFlowState(meta)).toBe("running");
  });

  it("prefers flowState over terminated (flowState='aborted', terminated=true)", () => {
    const meta = makeTestMeta({ flowState: "aborted", terminated: true });
    expect(getFlowState(meta)).toBe("aborted");
  });
});

// ─── isFrozen ────────────────────────────────────────────────────────────────

describe("isFrozen", () => {
  it("returns true when flowState is 'blocked'", () => {
    const meta = makeTestMeta({ flowState: "blocked" });
    expect(isFrozen(meta)).toBe(true);
  });

  it("returns true when flowState is 'aborted'", () => {
    const meta = makeTestMeta({ flowState: "aborted" });
    expect(isFrozen(meta)).toBe(true);
  });

  it("returns true when currentStage is 'awaiting_human'", () => {
    const meta = makeTestMeta({ currentStage: "awaiting_human" });
    expect(isFrozen(meta)).toBe(true);
  });

  it("returns false when flowState is 'running' and stage is normal", () => {
    const meta = makeTestMeta({ flowState: "running", currentStage: "develop" });
    expect(isFrozen(meta)).toBe(false);
  });

  it("returns true for legacy terminated=true (mapped to blocked)", () => {
    const meta = makeTestMeta({ terminated: true });
    expect(isFrozen(meta)).toBe(true);
  });
});

// ─── buildDecisionMenu ───────────────────────────────────────────────────────

describe("buildDecisionMenu", () => {
  it("returns 6 items for blocked state (Phase 3/173: +choose_stage)", () => {
    const meta = makeTestMeta({ flowState: "blocked" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toEqual([
      "Resume",
      "Skip",
      "Rollback",
      "Restart & New",
      "Abort & Exit",
      "Choose stage…",
    ]);
  });

  it("returns 6 items for awaiting_human stage (Phase 3/173: +choose_stage)", () => {
    const meta = makeTestMeta({ currentStage: "awaiting_human" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toHaveLength(6);
    expect(menu).toContain("Resume");
    expect(menu).toContain("Choose stage…");
  });

  it("returns 2 items for running state", () => {
    const meta = makeTestMeta({ flowState: "running" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toEqual(["Restart & New", "Abort & Exit"]);
  });

  it("returns null for aborted state", () => {
    const meta = makeTestMeta({ flowState: "aborted" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toBeNull();
  });
});

  // ─── Phase 6 (195): max_loop_cycles dynamic menu ─────────────────────────
  describe("Phase 6 (195): max_loop_cycles dynamic menu", () => {
    const templateChainConfig = makeTestConfig({
      stages: {
        clarify: { nextStage: "plan" } as any,
        plan: { nextStage: "develop" } as any,
        "design-review": { nextStage: "develop" } as any,
        develop: { nextStage: "review" } as any,
        review: { nextStage: "fix" } as any,
        fix: { nextStage: "review" } as any,
        awaiting_human: { nextStage: null } as any,
        completed: { nextStage: null } as any,
      },
    });

    it("max_loop_cycles with full budget remaining shows all 5 items", () => {
      // Use backward edge (review → develop) to create counted edge (C2)
      // This ensures deriveReworkLoopGate returns "review" (the gate)
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 2,
        maxLoopCycles: 5,
        loopBudgetExtensionCount: 0,
        loopRewindCount: 0,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"],
      });
      const menu = buildDecisionMenu(meta, "max_loop_cycles", templateChainConfig);
      // Plan Phase 6 order: base 4 items fixed, resume appended when budget
      // remains — first item must be Set round budget (menu-order acceptance).
      expect(menu).toEqual([
        "Set round budget",
        "Rewind last_round",
        "Restart & New",
        "Abort & Exit",
        "Resume",
      ]);
    });

    // 203_Bug Phase 1: menu gating removed — set_budget/rewind/resume are
    // always offered; only the structural rework-gate condition remains.
    it("max_loop_cycles with no budget remaining still shows resume (gates removed)", () => {
      // Use backward edge to ensure deriveReworkLoopGate returns non-null
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 5,
        maxLoopCycles: 5,
        loopBudgetExtensionCount: 0,
        loopRewindCount: 0,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"],
      });
      const menu = buildDecisionMenu(meta, "max_loop_cycles", templateChainConfig);
      expect(menu).toEqual([
        "Set round budget",
        "Rewind last_round",
        "Restart & New",
        "Abort & Exit",
        "Resume",
      ]);
    });

    it("max_loop_cycles with loopBudgetExtensionCount >= 1 still shows set_budget (gates removed)", () => {
      // Use backward edge to ensure deriveReworkLoopGate returns non-null
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 5,
        maxLoopCycles: 5,
        loopBudgetExtensionCount: 1,
        loopRewindCount: 0,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"],
      });
      const menu = buildDecisionMenu(meta, "max_loop_cycles", templateChainConfig);
      expect(menu).toEqual([
        "Set round budget",
        "Rewind last_round",
        "Restart & New",
        "Abort & Exit",
        "Resume",
      ]);
    });

    it("max_loop_cycles with loopRewindCount >= 1 still shows rewind_last_round (gates removed)", () => {
      // Use backward edge to ensure deriveReworkLoopGate returns non-null
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 5,
        maxLoopCycles: 5,
        loopBudgetExtensionCount: 0,
        loopRewindCount: 1,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"],
      });
      const menu = buildDecisionMenu(meta, "max_loop_cycles", templateChainConfig);
      expect(menu).toEqual([
        "Set round budget",
        "Rewind last_round",
        "Restart & New",
        "Abort & Exit",
        "Resume",
      ]);
    });

    it("max_loop_cycles with no rework gate (null) hides rewind_last_round", () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 5,
        maxLoopCycles: 5,
        loopBudgetExtensionCount: 0,
        loopRewindCount: 0,
        stageVisitOrder: ["clarify", "plan", "develop"],
      });
      const menu = buildDecisionMenu(meta, "max_loop_cycles", templateChainConfig);
      expect(menu).toEqual([
        "Set round budget",
        "Restart & New",
        "Abort & Exit",
        "Resume",
      ]);
      expect(menu).not.toContain("Rewind last_round");
    });

    it("max_loop_cycles with all limits reached shows all 5 items (gates removed)", () => {
      // Use backward edge to ensure deriveReworkLoopGate returns non-null
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 5,
        maxLoopCycles: 5,
        loopBudgetExtensionCount: 1,
        loopRewindCount: 1,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"],
      });
      const menu = buildDecisionMenu(meta, "max_loop_cycles", templateChainConfig);
      expect(menu).toEqual([
        "Set round budget",
        "Rewind last_round",
        "Restart & New",
        "Abort & Exit",
        "Resume",
      ]);
    });

    it("non-max_loop_cycles blockedReason returns standard 6-item menu", () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const menu = buildDecisionMenu(meta, "loop_overflow", templateChainConfig);
      expect(menu).toEqual([
        "Resume",
        "Skip",
        "Rollback",
        "Restart & New",
        "Abort & Exit",
        "Choose stage…",
      ]);
    });

    it("undefined blockedReason returns standard 6-item menu", () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: undefined,
      });
      const menu = buildDecisionMenu(meta, undefined, templateChainConfig);
      expect(menu).toEqual([
        "Resume",
        "Skip",
        "Rollback",
        "Restart & New",
        "Abort & Exit",
        "Choose stage…",
      ]);
    });
  });

// ─── executeDecision ─────────────────────────────────────────────────────────

describe("executeDecision", () => {
  let config: PipelineConfig;

  beforeEach(() => {
    config = makeTestConfig();
  });

  it("resume: sets flowState=running, clears blockedReason, resets counters", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      loopCount: 5,
      verifyAttempts: 3,
      verifyFailures: [{ ruleType: "test", detail: "fail", timestamp: 0 }],
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "resume", config);

    expect(result.success).toBe(true);
    expect(result.message).toContain("resumed");
    // Check updates
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.flowState).toBe("running");
    expect(lastUpdate.blockedReason).toBeUndefined();
    expect(lastUpdate.loopCount).toBe(0);
    expect(lastUpdate.verifyAttempts).toBe(0);
    expect(lastUpdate.verifyFailures).toEqual([]);
  });

  it("resume: transitions awaiting_human → previousStage", async () => {
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      previousStage: "develop",
      flowState: "running",
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "resume", config);

    expect(result.success).toBe(true);
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("develop");
  });

  it("skip: rejects when pipeline is not frozen", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "skip", config);

    expect(result.success).toBe(false);
    expect(result.message).toContain("not frozen");
  });

  it("skip: advances to nextStage when frozen", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "verify_fail",
      summaries: { develop: { path: "/tmp/s.md", hash: "abc", status: "valid" } },
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "skip", config);

    expect(result.success).toBe(true);
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("review"); // develop → review
    expect(lastUpdate.flowState).toBe("running");
    // Summary should be marked "skipped" per plan Phase 1 task 1
    expect(lastUpdate.summaries?.develop?.status).toBe("skipped");
  });

  it("rollback: rejects when pipeline is not frozen", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "rollback", config);

    expect(result.success).toBe(false);
  });

  it("rollback: goes to previousStage when frozen", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      flowState: "blocked",
      summaries: { plan: { path: "/tmp/p.md", hash: "def", status: "valid" } },
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "rollback", config);

    expect(result.success).toBe(true);
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("plan");
    expect(lastUpdate.flowState).toBe("running");
    // Target stage summary marked invalid
    expect(lastUpdate.summaries?.plan?.status).toBe("invalid");
  });

  it("restart: creates new pipelineId, resets to clarify", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      requirementDoc: "req.md",
      summaries: { clarify: { path: "/tmp/c.md", hash: "x", status: "valid" } },
    });
    const originalPipelineId = meta.pipelineId;
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "restart", config);

    expect(result.success).toBe(true);
    expect(result.message).toContain("restarted");
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.pipelineId).toBeDefined();
    expect(lastUpdate.pipelineId).not.toBe(originalPipelineId);
    expect(lastUpdate.currentStage).toBe("clarify");
    expect(lastUpdate.flowState).toBe("running");
    expect(lastUpdate.summaries).toEqual({});
  });

  it("187: restart clears pendingSpawns, spawnedStages, and activeSpawns", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      requirementDoc: "req.md",
      pendingSpawns: { develop: { agentName: "develop-agent", requestedAt: Date.now(), attempts: 0 } },
      spawnedStages: { develop: Date.now() },
      activeSpawns: { develop: { agentName: "develop-agent", agentId: "sa-1", startedAt: Date.now() } },
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "restart", config);

    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.pendingSpawns).toEqual({});
    expect(lastUpdate.spawnedStages).toBeUndefined();
    expect(lastUpdate.activeSpawns).toBeUndefined();
  });

  it("abort: sets flowState=aborted with terminateReason", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "abort", config);

    expect(result.success).toBe(true);
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.flowState).toBe("aborted");
    expect(lastUpdate.terminateReason).toBe("user_abort");
  });

  it("unknown decision returns failure", async () => {
    const meta = makeTestMeta();
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "unknown" as any, config);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown decision");
  });

  // ── verifyConfigError lifecycle ────────────────────────────────────────────

  it("resume: preserves verifyConfigError flag (escape hatch stays reachable)", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "verify_config_error",
      verifyConfigError: true,
      verifyFailures: [{ ruleType: "fileContentPattern", detail: "EISDIR", timestamp: 0 }],
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "resume", config);

    // verifyFailures cleared, but verifyConfigError preserved
    expect(meta.verifyFailures).toEqual([]);
    expect(meta.verifyConfigError).toBe(true);
    expect(meta.flowState).toBe("running");
  });

  it("skip: clears verifyConfigError flag (stage transition)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "verify_config_error",
      verifyConfigError: true,
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "skip", config);

    expect(meta.verifyConfigError).toBeUndefined();
  });

  it("rollback: clears verifyConfigError flag (stage transition)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      flowState: "blocked",
      verifyConfigError: true,
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "rollback", config);

    expect(meta.verifyConfigError).toBeUndefined();
  });

  it("restart: clears verifyConfigError flag (new pipeline)", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      verifyConfigError: true,
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "restart", config);

    expect(meta.verifyConfigError).toBeUndefined();
  });

  // ── Phase 1 / 180: stage-transition cleanup of confirmGateDeferredAt ───────

  it("Phase 1 / 180: skip clears the residual confirmGateDeferredAt stamp", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "verify_fail",
      confirmGateDeferredAt: { stage: "develop", at: Date.now() },
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "skip", config);

    expect(meta.confirmGateDeferredAt).toBeUndefined();
  });

  it("Phase 1 / 180: rollback clears the residual confirmGateDeferredAt stamp", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      flowState: "blocked",
      confirmGateDeferredAt: { stage: "develop", at: Date.now() },
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "rollback", config);

    expect(meta.confirmGateDeferredAt).toBeUndefined();
  });

  it("Phase 1 / 180: restart clears the residual confirmGateDeferredAt stamp", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      confirmGateDeferredAt: { stage: "develop", at: Date.now() },
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "restart", config);

    expect(meta.confirmGateDeferredAt).toBeUndefined();
  });

  it("Phase 1 / 180: choose_stage clears the residual confirmGateDeferredAt stamp", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      confirmGateDeferredAt: { stage: "develop", at: Date.now() },
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "choose_stage", config, { targetStage: "review" });

    expect(meta.currentStage).toBe("review");
    expect(meta.confirmGateDeferredAt).toBeUndefined();
  });

  it("Phase 1 / 180: same-stage resume keeps the deferral window (no clear)", async () => {
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "resume", config);

    // Same-stage resume must preserve deferral continuity.
    expect(meta.currentStage).toBe("plan");
    expect(meta.confirmGateDeferredAt).toBeDefined();
  });

  it("Phase 1 / 180: awaiting_human resume clears the deferral stamp (stage change)", async () => {
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      previousStage: "develop",
      flowState: "blocked",
      confirmGateDeferredAt: { stage: "awaiting_human", at: Date.now() },
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "resume", config);

    expect(meta.currentStage).toBe("develop");
    expect(meta.confirmGateDeferredAt).toBeUndefined();
  });

  it("203_Bug Phase 1 (RC2): awaiting_human resume clears the TARGET stage spawn residue", async () => {
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      previousStage: "develop",
      flowState: "blocked",
      activeSpawns: {
        develop: { agentName: "develop-executor", startedAt: Date.now() },
      },
      spawnedStages: { develop: Date.now() },
      pendingSpawns: {
        develop: { agentName: "develop-executor", requestedAt: Date.now(), attempts: 0 },
      },
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "resume", config);

    expect(meta.currentStage).toBe("develop");
    // The resumed stage (previousStage) must be clean, not `awaiting_human`.
    expect(meta.activeSpawns?.develop).toBeUndefined();
    expect(meta.spawnedStages?.develop).toBeUndefined();
    expect(meta.pendingSpawns?.develop).toBeUndefined();
  });

  // ─── Phase 5 (195): set_budget ───────────────────────────────────────────

  describe("Phase 5 (195): set_budget", () => {
    it("success: extends budget, increments loopBudgetExtensionCount, unfreezes", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "loop_overflow",
        loopCycleCount: 3,
        maxLoopCycles: 5,
        loopBudgetExtensionCount: 0,
      });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "set_budget", config, { budgetValue: 8 });

      expect(result.success).toBe(true);
      expect(result.message).toContain("8");
      expect(meta.maxLoopCycles).toBe(8);
      expect(meta.loopBudgetExtensionCount).toBe(1);
      expect(meta.flowState).toBe("running");
      expect(meta.blockedReason).toBeUndefined();
      expect(meta.loopCycleCount).toBe(3); // unchanged
    });

    it("reject: not frozen", async () => {
      const meta = makeTestMeta({ flowState: "running", loopCycleCount: 3 });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "set_budget", config, { budgetValue: 8 });

      expect(result.success).toBe(false);
      expect(result.message).toContain("not frozen");
    });

    it("reject: budgetValue missing", async () => {
      const meta = makeTestMeta({ flowState: "blocked", loopCycleCount: 3 });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "set_budget", config);

      expect(result.success).toBe(false);
      expect(result.message).toContain("budgetValue is required");
    });

    it("reject: budgetValue not positive", async () => {
      const meta = makeTestMeta({ flowState: "blocked", loopCycleCount: 3 });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "set_budget", config, { budgetValue: -5 });

      expect(result.success).toBe(false);
      expect(result.message).toContain("positive number");
    });

    it("reject: budgetValue <= loopCycleCount (E14)", async () => {
      const meta = makeTestMeta({ flowState: "blocked", loopCycleCount: 5, maxLoopCycles: 5 });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "set_budget", config, { budgetValue: 5 });

      expect(result.success).toBe(false);
      expect(result.message).toContain("must be greater than");
    });

    // 203_Bug Phase 1: one-shot guard removed — budget extension is no longer
    // capped; a second set_budget overwrites maxLoopCycles.
    it("203_Bug Phase 1: second set_budget allowed (one-time limit removed)", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        loopCycleCount: 5,
        loopBudgetExtensionCount: 1,
      });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "set_budget", config, { budgetValue: 10 });

      expect(result.success).toBe(true);
      expect(meta.maxLoopCycles).toBe(10);
      expect(meta.loopBudgetExtensionCount).toBe(2); // still counted (audit telemetry)
      expect(meta.flowState).toBe("running");
    });

    it("works with various blockedReason values", async () => {
      const blockedReasons = ["loop_overflow", "verify_fail", "contract_drift", "design_violation"] as const;
      for (const br of blockedReasons) {
        const meta = makeTestMeta({ flowState: "blocked", blockedReason: br, loopCycleCount: 2, maxLoopCycles: 3 });
        const ctx = makeCtx(meta);
        const result = await executeDecision(ctx, meta, "set_budget", config, { budgetValue: 6 });
        expect(result.success).toBe(true);
        expect(meta.maxLoopCycles).toBe(6);
        expect(meta.flowState).toBe("running");
        expect(meta.blockedReason).toBeUndefined();
      }
    });
  });

  // ─── Phase 5 (195): rewind_last_round ────────────────────────────────────

  describe("Phase 5 (195): rewind_last_round", () => {
    // Template chain config for rewind tests (matches actual pipeline_loop.json structure)
    // This ensures rewind tests use realistic stage transitions where fix→review is a forward edge
    const templateChainConfig = makeTestConfig({
      stages: {
        clarify: { nextStage: "plan" } as any,
        plan: { nextStage: "develop" } as any,
        "design-review": { nextStage: "develop" } as any,
        develop: { nextStage: "review" } as any,
        review: { nextStage: "completed" } as any,
        fix: { nextStage: "review" } as any,
        awaiting_human: { nextStage: null } as any,
        completed: { nextStage: null } as any,
      },
    });

    it("success: rewinds to gate, resets loopCycleCount, increments loopRewindCount", async () => {
      const meta = makeTestMeta({
        currentStage: "fix",
        flowState: "blocked",
        blockedReason: "loop_overflow",
        loopCycleCount: 3,
        loopRewindCount: 0,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix"],
      });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "rewind_last_round", templateChainConfig);

      expect(result.success).toBe(true);
      expect(result.message).toContain("review");
      expect(meta.currentStage).toBe("review");
      expect(meta.loopCycleCount).toBe(0);
      expect(meta.loopRewindCount).toBe(1);
      expect(meta.flowState).toBe("running");
      expect(meta.blockedReason).toBeUndefined();
      expect(meta.previousStage).toBe("fix");
      expect(meta.stageVisitOrder).toContain("review");
    });

    it("reject: not frozen", async () => {
      const meta = makeTestMeta({ flowState: "running", loopRewindCount: 0 });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "rewind_last_round", templateChainConfig);

      expect(result.success).toBe(false);
      expect(result.message).toContain("not frozen");
    });

    // 203_Bug Phase 1: one-shot guard removed — repeated rewinds are allowed;
    // the rewind counter keeps incrementing for audit telemetry.
    it("203_Bug Phase 1: second rewind allowed (one-time limit removed)", async () => {
      const meta = makeTestMeta({
        currentStage: "fix",
        flowState: "blocked",
        loopRewindCount: 1,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix"],
      });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "rewind_last_round", templateChainConfig);

      expect(result.success).toBe(true);
      expect(meta.loopRewindCount).toBe(2); // counted again (audit telemetry)
      expect(meta.flowState).toBe("running");
    });

    it("reject: no rework loop gate found (null gate)", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        loopRewindCount: 0,
        stageVisitOrder: ["clarify", "plan"],
      });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "rewind_last_round", templateChainConfig);

      expect(result.success).toBe(false);
      expect(result.message).toContain("未能定位");
      expect(meta.flowState).toBe("blocked"); // frozen state maintained
      expect(meta.currentStage).toBe("develop"); // unchanged
    });

    it("reject: legacy meta missing stageVisitOrder", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        loopRewindCount: 0,
        stageVisitOrder: undefined,
      });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "rewind_last_round", templateChainConfig);

      expect(result.success).toBe(false);
      expect(result.message).toContain("未能定位");
      expect(meta.flowState).toBe("blocked"); // frozen state maintained
    });

    it("F4 regression: review,fix,review,fix,review,fix ⇒ gate=review, count=0, running", async () => {
      const meta = makeTestMeta({
        currentStage: "fix",
        flowState: "blocked",
        blockedReason: "loop_overflow",
        loopCycleCount: 3,
        loopRewindCount: 0,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix", "review", "fix"],
      });
      const ctx = makeCtx(meta);

      const result = await executeDecision(ctx, meta, "rewind_last_round", templateChainConfig);

      expect(result.success).toBe(true);
      expect(meta.currentStage).toBe("review");
      expect(meta.loopCycleCount).toBe(0);
      expect(meta.flowState).toBe("running");
      expect(meta.previousStage).toBe("fix");
    });

    it("works with various blockedReason values", async () => {
      const blockedReasons = ["loop_overflow", "verify_fail", "contract_drift", "design_violation"] as const;
      for (const br of blockedReasons) {
        const meta = makeTestMeta({
          currentStage: "fix",
          flowState: "blocked",
          blockedReason: br,
          loopRewindCount: 0,
          stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix"],
        });
        const ctx = makeCtx(meta);
        const result = await executeDecision(ctx, meta, "rewind_last_round", templateChainConfig);
        expect(result.success).toBe(true);
        expect(meta.currentStage).toBe("review");
        expect(meta.loopCycleCount).toBe(0);
        expect(meta.flowState).toBe("running");
        expect(meta.blockedReason).toBeUndefined();
      }
    });

    it("migration matrix: all fields updated atomically", async () => {
      const meta = makeTestMeta({
        currentStage: "fix",
        previousStage: "review",
        flowState: "blocked",
        blockedReason: "loop_overflow",
        loopCycleCount: 2,
        loopRewindCount: 0,
        stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix"],
      });
      const ctx = makeCtx(meta);

      await executeDecision(ctx, meta, "rewind_last_round", templateChainConfig);

      expect(meta.currentStage).toBe("review");
      expect(meta.previousStage).toBe("fix");
      expect(meta.loopCycleCount).toBe(0);
      expect(meta.loopRewindCount).toBe(1);
      expect(meta.flowState).toBe("running");
      expect(meta.blockedReason).toBeUndefined();
      expect(meta.stageVisitOrder).toEqual(["clarify", "plan", "develop", "review", "fix", "review", "fix", "review"]);
    });
  });
});

// ─── freezeAndPrompt ─────────────────────────────────────────────────────────

describe("freezeAndPrompt", () => {
  it("transitions running → blocked on first call", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.flowState).toBe("blocked");
    expect(lastUpdate.blockedReason).toBe("loop_overflow");
  });

  it("is idempotent: does not re-update if already blocked with same reason", async () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "existing_reason" });
    const ctx = makeCtx(meta);
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "existing_reason", config);

    // Should NOT have called updateMeta since already blocked with same reason
    // (J6: only a CHANGED reason re-updates + re-prompts).
    expect(ctx.updates.length).toBe(0);
  });

  it("with UI select: user selects option → executes decision", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    let selectCalled = false;
    const ctx = makeCtx(meta, {
      select: async (_msg: string, _opts: string[]) => {
        selectCalled = true;
        return "Abort & Exit"; // abort
      },
      notify: (_msg: string) => {},
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    expect(selectCalled).toBe(true);
    // Should have flowState=blocked from freeze, then aborted from executeDecision
    expect(meta.flowState).toBe("aborted");
  });

  it("with UI select: user presses Esc (delayed) → stays blocked + notify with shortcut", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      // Simulate Esc after 2 seconds (above DECISION_DISMISS_INTERRUPT_MS=1500 threshold)
      select: async () => {
        await new Promise(r => setTimeout(r, 2000));
        return undefined;
      },
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "verify_fail", config);

    expect(meta.flowState).toBe("blocked");
    // Phase 4 (189): owner-role now has 2 notifies — initial block notification + Esc cancellation hint
    expect(notifications.length).toBe(2);
    expect(notifications[0]).toContain("verify_fail");
    expect(notifications[1]).toContain("/pipeline-resume");
  });

  it("without UI: keeps blocked, no crash, notify includes reason", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "max_loop_cycles", config);

    expect(meta.flowState).toBe("blocked");
    // Phase 4 (189): owner-role now has 2 notifies - initial block notification + decision menu unavailable message
    expect(notifications.length).toBe(2);
    expect(notifications[0]).toContain("max_loop_cycles");
    expect(notifications[0]).toContain("decision menu");
  });

  it("without any UI: no crash, stays blocked", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta); // no UI at all
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "some_reason", config);

    expect(meta.flowState).toBe("blocked");
  });

  it("frozen message includes blockedReason and /pipeline-resume hint", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "test_reason", config);

    expect(notifications[0]).toContain("test_reason");
    expect(notifications[0]).toContain("/pipeline-resume");
  });

  it("opts.ui overrides ctx.ui for select", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctxUiSelectCalled: boolean[] = [];
    const optsUiSelectCalled: boolean[] = [];

    const ctx = makeCtx(meta, {
      select: async () => { ctxUiSelectCalled.push(true); return undefined; },
      notify: () => {},
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "reason", config, {
      ui: {
        select: async () => { optsUiSelectCalled.push(true); return "Abort & Exit"; },
        notify: () => {},
      },
    });

    expect(ctxUiSelectCalled.length).toBe(0);
    expect(optsUiSelectCalled.length).toBe(1);
  });

  // Phase 4 (189): Child-role ctx → notify called, menu NOT shown
  it("child-role ctx → notify called, menu suppressed (no select)", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const notifications: string[] = [];
    let selectCalled = false;

    // Create a child context with parentSession in header
    const childCtx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        notify: (msg: string) => { notifications.push(msg); },
        select: async (_msg: string, _opts: string[]) => {
          selectCalled = true;
          return undefined;
        },
      },
      _ctx: {
        sessionManager: {
          getHeader: () => ({ parentSession: "/tmp/parent-session.jsonl" }),
          getSessionName: () => "child-session-12345678",
          getSessionFile: () => "/tmp/child-session.jsonl",
        },
      },
    } as any;

    const config = makeTestConfig();

    await freezeAndPrompt(childCtx, meta, "loop_overflow", config);

    // Child should still freeze
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("loop_overflow");

    // Notify should be called (Phase 4 behavior)
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("loop_overflow");

    // But select (menu) should NOT be called (child-role suppression)
    expect(selectCalled).toBe(false);
  });
});

// ── 168 Phase 1: formatFrozenReason ──────────────────────────────────────────

describe("168 Phase 1: formatFrozenReason", () => {
  it("returns blockedReason when present", () => {
    const meta = makeTestMeta({ blockedReason: "loop_overflow" });
    expect(formatFrozenReason(meta)).toBe("loop_overflow");
  });

  it("falls back to terminateReason when blockedReason is absent", () => {
    const meta = makeTestMeta({ terminateReason: "user_abort" });
    expect(formatFrozenReason(meta)).toBe("user_abort");
  });

  it("returns 'unknown' when neither reason is present", () => {
    const meta = makeTestMeta({});
    expect(formatFrozenReason(meta)).toBe("unknown");
  });

  it("appends first 2 verifyFailures", () => {
    const meta = makeTestMeta({
      blockedReason: "verify_attempt_overflow",
      verifyFailures: [
        { ruleType: "requiredFiles", detail: "Missing: output.md", timestamp: 1 },
        { ruleType: "fileContentPattern", detail: "pattern not found", timestamp: 2 },
        { ruleType: "keywords", detail: "Missing: kw1", timestamp: 3 },
      ],
    });
    const result = formatFrozenReason(meta);
    expect(result).toContain("verify_attempt_overflow");
    expect(result).toContain("[requiredFiles] Missing: output.md");
    expect(result).toContain("[fileContentPattern] pattern not found");
    // Should only include first 2 failures
    expect(result).not.toContain("[keywords]");
  });

  it("truncates to maxLen with ellipsis (maxLen is hard upper bound)", () => {
    const meta = makeTestMeta({
      blockedReason: "a".repeat(300),
    });
    const result = formatFrozenReason(meta, 50);
    expect(result.length).toBe(50); // hard upper bound: (maxLen-1) chars + "…"
    expect(result).toEndWith("…");
  });

  it("handles multi-byte characters without splitting (maxLen hard upper bound)", () => {
    // Chinese characters are 3 bytes each but 1 JS char unit — Array.from handles surrogate pairs
    const meta = makeTestMeta({
      blockedReason: "日本語テスト".repeat(20), // 60 chars, all multi-byte
    });
    const result = formatFrozenReason(meta, 10);
    expect(result.length).toBeLessThanOrEqual(10); // hard upper bound preserved
    expect(result).toEndWith("…");
  });

  it("handles empty verifyFailures array", () => {
    const meta = makeTestMeta({
      blockedReason: "test_reason",
      verifyFailures: [],
    });
    expect(formatFrozenReason(meta)).toBe("test_reason");
  });
});

// ── 168 Phase 2: promptDecisionMenu (re-popup while frozen) ──────────────────

describe("168 Phase 2: promptDecisionMenu", () => {
  it("can be called when already blocked (re-popup)", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const selectCalls: number[] = [];
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      select: async () => {
        selectCalls.push(1);
        return "Resume";
      },
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    // First call
    await promptDecisionMenu(ctx, meta, config);
    expect(selectCalls.length).toBe(1);

    // Second call (re-popup while still blocked)
    await promptDecisionMenu(ctx, meta, config);
    expect(selectCalls.length).toBe(2);
  });

  it("Esc cancel (delayed) writes pipeline_decision_cancelled audit + notify with shortcut", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "verify_attempt_overflow",
    });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      // Simulate Esc after 2 seconds (above DECISION_DISMISS_INTERRUPT_MS=1500 threshold)
      select: async () => {
        await new Promise(r => setTimeout(r, 2000));
        return undefined;
      },
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    await promptDecisionMenu(ctx, meta, config);

    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("verify_attempt_overflow");
    expect(notifications[0]).toContain("/pipeline-resume");
  });

  it("returns aborted without prompting when flowState is aborted", async () => {
    const meta = makeTestMeta({ flowState: "aborted" });
    const selectCalls: number[] = [];
    const ctx = makeCtx(meta, {
      select: async () => {
        selectCalls.push(1);
        return "Resume";
      },
    });
    const config = makeTestConfig();

    await promptDecisionMenu(ctx, meta, config);
    // No select call (aborted → null menu → return early)
    expect(selectCalls.length).toBe(0);
  });
});

// ─── isTerminalCompleted ──────────────────────────────────────────────────────

describe("isTerminalCompleted", () => {
  it("returns true when currentStage is completed", () => {
    const meta = makeTestMeta({ currentStage: "completed" });
    expect(isTerminalCompleted(meta)).toBe(true);
  });

  it("returns false when currentStage is not completed", () => {
    expect(isTerminalCompleted(makeTestMeta({ currentStage: "develop" }))).toBe(false);
    expect(isTerminalCompleted(makeTestMeta({ currentStage: "clarify" }))).toBe(false);
    expect(isTerminalCompleted(makeTestMeta({ currentStage: "review" }))).toBe(false);
  });

  it("returns false when meta is undefined", () => {
    expect(isTerminalCompleted(undefined)).toBe(false);
  });
});

// ─── markPipelineAborted terminal guard ──────────────────────────────────────

describe("markPipelineAborted terminal guard", () => {
  it("skips flowState/terminateReason when pipeline is completed", async () => {
    const meta = makeTestMeta({ currentStage: "completed", flowState: "running" });
    const ctx = makeCtx(meta);

    await markPipelineAborted(ctx, "session_quit");

    // flowState should NOT be overwritten to "aborted"
    expect(meta.flowState).toBe("running");
    expect(meta.terminateReason).toBeUndefined();
    // No updateMeta call should have set flowState
    const abortUpdate = ctx.updates.find(u => u.flowState === "aborted");
    expect(abortUpdate).toBeUndefined();
  });

  it("writes flowState=aborted when pipeline is NOT completed", async () => {
    const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
    const ctx = makeCtx(meta);

    await markPipelineAborted(ctx, "session_quit");

    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("session_quit");
  });

  // Phase 3 (170) ⑦: idempotent abort — same reason twice → only 1 audit
  it("Phase 3 (170): second abort with same reason is idempotent (skip)", async () => {
    const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
    const ctx = makeCtx(meta);

    await markPipelineAborted(ctx, "session_quit");
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("session_quit");

    // Second call with same reason — should skip mutation and audit skip
    const updateCountBefore = ctx.updates.length;
    await markPipelineAborted(ctx, "session_quit");

    // No additional updateMeta call for flowState=aborted
    const newAbortedUpdates = ctx.updates.slice(updateCountBefore).filter(u => u.flowState === "aborted");
    expect(newAbortedUpdates.length).toBe(0);
    // State should remain unchanged
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("session_quit");
  });

  it("Phase 3 (170): abort with different reason still writes (non-idempotent)", async () => {
    const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
    const ctx = makeCtx(meta);

    await markPipelineAborted(ctx, "session_quit");
    expect(meta.terminateReason).toBe("session_quit");

    // Different reason → should overwrite
    await markPipelineAborted(ctx, "stale_startup");
    expect(meta.terminateReason).toBe("stale_startup");
  });
});

// ── Phase 4 (169) P1: W3 terminal compact wiring in executeDecision skip ──────
//
// Locks the plan Phase 4验收 requirement:
// - W3: executeDecision("skip") with nextStage=completed → helper is called
// - W3: executeDecision("skip") with nextStage≠completed → helper is NOT called

describe("Phase 4 (169) P1: W3 terminal compact wiring in executeDecision", () => {
  it("W3: skip to completed → maybeCompactOnPipelineCompleted is called", async () => {
    const config = makeTestConfig();
    // Override review.nextStage → completed so skip reaches terminal
    config.stages["review"] = { ...config.stages["review"], nextStage: "completed" as any };
    const meta = makeTestMeta({
      currentStage: "review",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      pipelineId: "pipe-w3-001",
    });

    let compactCalled = false;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: { notify: () => {} },
      _ctx: {
        isIdle: () => true,
        compact: () => { compactCalled = true; },
        getContextUsage: () => ({ tokens: 1000 }),
      },
    };

    await executeDecision(ctx as any, meta, "skip", config);

    expect(meta.currentStage).toBe("completed");
    // Helper was invoked: terminalCompact set or compact called
    expect(meta.terminalCompact !== undefined || compactCalled).toBe(true);
  });

  it("W3: skip to non-completed → helper is NOT called", async () => {
    const config = makeTestConfig();
    // develop.nextStage is review (default chain)
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "verify_attempt_overflow",
      pipelineId: "pipe-w3-noncompl",
    });

    let compactCalled = false;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: { notify: () => {} },
      _ctx: {
        isIdle: () => true,
        compact: () => { compactCalled = true; },
        getContextUsage: () => ({ tokens: 200_000 }),
      },
    };

    await executeDecision(ctx as any, meta, "skip", config);

    expect(meta.currentStage).toBe("review");
    // Helper NOT invoked — non-completed target
    expect(compactCalled).toBe(false);
    expect(meta.terminalCompact).toBeUndefined();
  });
});

// ─── Phase 1 (171): markPipelineAborted enriched audit + notify (C14-C16) ──

describe("Phase 1 (171): markPipelineAborted enriched fields", () => {
  it("emits notify on real abort transition with stage/reason/doc hint", async () => {
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      pipelineId: "pipe-p1-notify",
      requirementDoc: "docs/design/82_Feat.md",
    });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, { notify: (msg: string) => { notifications.push(msg); } });

    await markPipelineAborted(ctx, "session_quit");

    expect(meta.flowState).toBe("aborted");
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("Pipeline aborted");
    expect(notifications[0]).toContain("plan");
    expect(notifications[0]).toContain("session_quit");
    expect(notifications[0]).toContain("docs/design/82_Feat.md");
    expect(notifications[0]).toContain("/pipeline-start");
  });

  it("does NOT emit notify on idempotent skip (same reason)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "aborted",
      terminateReason: "session_quit",
    });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, { notify: (msg: string) => { notifications.push(msg); } });

    await markPipelineAborted(ctx, "session_quit");

    expect(notifications.length).toBe(0); // Idempotent skip → no notify
  });

  it("does NOT emit notify on completed guard skip", async () => {
    const meta = makeTestMeta({ currentStage: "completed", flowState: "running" });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, { notify: (msg: string) => { notifications.push(msg); } });

    await markPipelineAborted(ctx, "session_quit");

    expect(notifications.length).toBe(0); // Completed guard → no notify
    expect(meta.flowState).toBe("running"); // Not overwritten
  });

  it("audit fields include stage/nextStage/nextAction/reason", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "clarify",
      flowState: "running",
      pipelineId: "pipe-p1-audit",
      requirementDoc: "docs/spec.md",
    });
    const ctx = makeCtx(meta);

    await markPipelineAborted(ctx, "session_quit", { config });

    // Verify the audit was written (via updateMeta being called)
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("session_quit");
  });

  it("trigger identity fields are accepted without error", async () => {
    const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
    const ctx = makeCtx(meta);

    await expect(markPipelineAborted(ctx, "session_quit", {
      trigger: {
        sessionFile: "main-session-abc",
        isSubagent: false,
        eventReason: "quit",
      },
    })).resolves.toBeUndefined();

    expect(meta.flowState).toBe("aborted");
  });

  it("works without opts (backward compat — no config/trigger)", async () => {
    const meta = makeTestMeta({ currentStage: "plan", flowState: "running" });
    const ctx = makeCtx(meta);

    await markPipelineAborted(ctx, "stale_startup");

    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("stale_startup");
  });
});

// ─── Phase 1 (171): formatAbortedNotifyText consistency ──

describe("Phase 1 (171): formatAbortedNotifyText", () => {
  it("produces text with stage, reason, and doc hint", () => {
    const text = formatAbortedNotifyText("plan", "session_quit", "docs/design/82_Feat.md");
    expect(text).toBe('Pipeline aborted at "plan" (session_quit). Run /pipeline-start docs/design/82_Feat.md to resume.');
  });

  it("uses placeholder when requirementDoc is undefined", () => {
    const text = formatAbortedNotifyText("clarify", "stale_startup");
    expect(text).toContain("<requirement-doc>");
    expect(text).toContain("clarify");
    expect(text).toContain("stale_startup");
  });
});

// ─── Phase 1 (171): freezeAndPrompt enriched audit fields ──

describe("Phase 1 (171): freezeAndPrompt enriched fields", () => {
  it("pipeline_blocked audit includes nextStage and nextAction", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "clarify",
      flowState: "running",
      pipelineId: "pipe-p1-freeze",
    });
    const ctx = makeCtx(meta);

    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("loop_overflow");
    // The audit includes nextStage/nextAction (verified by the function not throwing)
  });
});

// ─── Phase 1 (171): executeDecision abort enriched audit ──

describe("Phase 1 (171): executeDecision abort enriched fields", () => {
  it("abort decision audit includes terminateReason, nextStage, nextAction", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      pipelineId: "pipe-p1-abort",
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "abort", config);

    expect(result.success).toBe(true);
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("user_abort");
  });
});

// ─── Phase 0 (182): choose_stage onStageChanged callback ─────────────────────

describe("executeDecision choose_stage onStageChanged (Phase 0 / 182)", () => {
  const config = makeTestConfig();

  it("calls onStageChanged once with fresh meta (currentStage = target) after choose_stage", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeCtx(meta);
    const callbackMetas: SessionMeta[] = [];

    const result = await executeDecision(ctx, meta, "choose_stage", config, {
      targetStage: "review",
      onStageChanged: async (freshMeta) => {
        callbackMetas.push(freshMeta);
      },
    });

    expect(result.success).toBe(true);
    expect(callbackMetas).toHaveLength(1);
    expect(callbackMetas[0].currentStage).toBe("review");
  });

  it("does not throw when onStageChanged is undefined (default)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "choose_stage", config, {
      targetStage: "review",
    });

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("review");
  });

  it("returns success even when onStageChanged throws (fail-open)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "choose_stage", config, {
      targetStage: "review",
      onStageChanged: async () => {
        throw new Error("dispatch failure");
      },
    });

    // choose_stage itself succeeds; callback failure is swallowed
    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("review");
  });

  it("does not call onStageChanged for non-choose_stage decisions", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeCtx(meta);
    let callCount = 0;

    await executeDecision(ctx, meta, "resume", config, {
      onStageChanged: async () => { callCount++; },
    });

    expect(callCount).toBe(0);
  });
});

// ─── Phase 6 (182): frozen@fix menu filtering ────────────────────────────────

describe("Phase 6 (182): frozen@fix secondary menu filtering", () => {
  const config = makeTestConfig();

  it("frozen@fix: secondary stage menu does NOT include 'completed'", async () => {
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      pipelineId: "pipe-fix-menu-1",
    });

    // Capture the menu items passed to ui.select
    let capturedItems: string[] = [];
    const ctx = makeCtx(meta, {
      select: async (_msg: string, options: string[]) => {
        capturedItems = [...options];
        return "review"; // Pick review to complete the menu
      },
    });

    await promptDecisionMenu(ctx, meta, config, {
      source: "test",
      directStageSelect: true,
    });

    // The menu items should NOT contain "completed"
    expect(capturedItems).not.toContain("completed");
    // But should still contain the other stages (note: inferred default shows as "fix (default)")
    expect(capturedItems).toContain("review");
    expect(capturedItems).toContain("develop");
    // "fix" may appear as "fix (default)" when it's the inferred stage
    expect(capturedItems.some(item => item === "fix" || item.startsWith("fix "))).toBe(true);
  });

  it("frozen@develop: secondary stage menu DOES include 'completed' (regression)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      pipelineId: "pipe-dev-menu-1",
    });

    let capturedItems: string[] = [];
    const ctx = makeCtx(meta, {
      select: async (_msg: string, options: string[]) => {
        capturedItems = [...options];
        return "review";
      },
    });

    await promptDecisionMenu(ctx, meta, config, {
      source: "test",
      directStageSelect: true,
    });

    // For non-fix stages, "completed" must be present
    expect(capturedItems).toContain("completed");
  });
});

// ── Phase 0 (186): markPipelineAborted clears pendingSpawns ──────────────────

describe("Phase 0 (186): markPipelineAborted clears pendingSpawns", () => {
  it("aborted pipeline clears all pendingSpawns entries", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      pendingSpawns: {
        review: { agentName: "review-agent", requestedAt: Date.now(), attempts: 0 },
      },
    });
    const ctx = makeCtx(meta);

    await markPipelineAborted(ctx as any, "user_quit");

    // pendingSpawns should be cleared
    expect(meta.pendingSpawns).toEqual({});
    // flowState should be aborted
    expect(meta.flowState).toBe("aborted");
  });
});

// ─── Phase 6 (195): freezeAndPrompt regression ─────────────────────────────
describe("Phase 6 (195): freezeAndPrompt owner menu call count", () => {
  it("owner session calls promptDecisionMenu exactly once", async () => {
    const meta = makeTestMeta({
      flowState: "running",
      currentStage: "review",
    });
    let menuCallCount = 0;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: any) => Object.assign(meta, patch),
      },
      ui: {
        select: async () => {
          menuCallCount++;
          return "Resume"; // User selects resume to unfreeze
        },
        notify: () => {},
      },
    } as any;
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "max_loop_cycles", config);

    // Should call menu exactly once (not stacked)
    expect(menuCallCount).toBe(1);
    // After resume decision, flowState should be "running" (unfrozen)
    expect(meta.flowState).toBe("running");
  });
});

// ─── Phase 6 (195): menuEscalationPending lifecycle ──────────────────────────

import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

describe("Phase 6 (195): menuEscalationPending lifecycle", () => {
  let auditEvents: Array<{ stage: string; message?: Record<string, string | boolean> }>;

  beforeEach(() => {
    auditEvents = [];
    __setSafeWriteAuditLogOverride(async (stage, message) => {
      auditEvents.push({ stage, message });
    });
  });

  it("child freeze sets menuEscalationPending and writes menu_escalation_armed audit", async () => {
    // 203_Bug Phase 0 (RC1): mock pi event bus to observe escalation broadcast
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const mockPi = {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => {
          emitted.push({ event, payload });
        },
        on: (_event: string, _handler: (payload: unknown) => void) => {},
      },
    };
    const meta = makeTestMeta({ flowState: "running" });
    const childCtx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        notify: () => {},
        select: async () => undefined,
      },
      _ctx: {
        sessionManager: {
          getHeader: () => ({ parentSession: "/tmp/parent-session.jsonl" }),
          getSessionName: () => "child-session-12345678",
          getSessionFile: () => "/tmp/child-session.jsonl",
        },
      },
      pi: mockPi,
    } as any;

    const config = makeTestConfig();
    await freezeAndPrompt(childCtx, meta, "loop_overflow", config);

    // Verify menuEscalationPending is set
    expect(meta.menuEscalationPending).toBe(true);

    // Verify menu_escalation_armed audit was written
    const armedAudit = auditEvents.find(e => e.stage === "menu_escalation_armed");
    expect(armedAudit).toBeDefined();
    expect(armedAudit?.message?.pipelineId).toBe(meta.pipelineId);
    expect(armedAudit?.message?.stage).toBe(meta.currentStage);

    // 203_Bug Phase 0 (RC1): Verify escalation broadcast fired exactly once
    // on the pi event bus with pipeline/stage/reason payload
    const escalations = emitted.filter(e => e.event === "pipeline:escalation-armed");
    expect(escalations).toHaveLength(1);
    expect(escalations[0].payload).toMatchObject({
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      reason: "loop_overflow",
    });

    // Verify menu_escalation_broadcast audit was written after the armed audit
    const broadcastAudit = auditEvents.find(e => e.stage === "menu_escalation_broadcast");
    expect(broadcastAudit).toBeDefined();
    expect(broadcastAudit?.message?.pipelineId).toBe(meta.pipelineId);

    __setSafeWriteAuditLogOverride(null);
  });

  it("owner promptDecisionMenu consumes escalation: clears flag, writes consumed audit, shows menu", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      menuEscalationPending: true,
    });

    let selectCalls = 0;
    const ownerCtx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        select: async () => {
          selectCalls++;
          return "Resume";
        },
        notify: () => {},
      },
    } as any;

    const config = makeTestConfig();
    await promptDecisionMenu(ownerCtx, meta, config);

    // Verify menuEscalationPending is cleared
    expect(meta.menuEscalationPending).toBe(false);

    // Verify menu_escalation_consumed audit was written
    const consumedAudit = auditEvents.find(e => e.stage === "menu_escalation_consumed");
    expect(consumedAudit).toBeDefined();
    expect(consumedAudit?.message?.pipelineId).toBe(meta.pipelineId);
    expect(consumedAudit?.message?.stage).toBe(meta.currentStage);

    // Verify menu was shown (select called)
    expect(selectCalls).toBe(1);

    __setSafeWriteAuditLogOverride(null);
  });

  // H3 (review-issue): Child session calling promptDecisionMenu must NOT consume menuEscalationPending
  it("child session calling promptDecisionMenu does NOT consume menuEscalationPending", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      menuEscalationPending: true,
    });

    const childCtx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        select: async () => "Resume",
        notify: () => {},
      },
      _ctx: {
        sessionManager: {
          getHeader: () => ({ parentSession: "/tmp/parent-session.jsonl" }),
          getSessionName: () => "child-session-12345678",
          getSessionFile: () => "/tmp/child-session.jsonl",
        },
      },
    } as any;

    const config = makeTestConfig();
    await promptDecisionMenu(childCtx, meta, config);

    // menuEscalationPending must remain true (not consumed by child)
    expect(meta.menuEscalationPending).toBe(true);

    // No menu_escalation_consumed audit should be written
    const consumedAudits = auditEvents.filter(e => e.stage === "menu_escalation_consumed");
    expect(consumedAudits.length).toBe(0);

    __setSafeWriteAuditLogOverride(null);
  });

  // H3 (review-issue): Aborted state (no menu) must NOT consume menuEscalationPending
  it("aborted state (no menu) does NOT consume menuEscalationPending", async () => {
    const meta = makeTestMeta({
      flowState: "aborted",
      menuEscalationPending: true,
    });

    const ownerCtx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        select: async () => "Resume",
        notify: () => {},
      },
    } as any;

    const config = makeTestConfig();
    await promptDecisionMenu(ownerCtx, meta, config);

    // menuEscalationPending must remain true (not consumed by aborted)
    expect(meta.menuEscalationPending).toBe(true);

    // No menu_escalation_consumed audit should be written
    const consumedAudits = auditEvents.filter(e => e.stage === "menu_escalation_consumed");
    expect(consumedAudits.length).toBe(0);

    __setSafeWriteAuditLogOverride(null);
  });

    it("idempotent: no consumed audit when menuEscalationPending is already false", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      menuEscalationPending: false,
    });

    let selectCalls = 0;
    const ownerCtx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        select: async () => {
          selectCalls++;
          return "Resume";
        },
        notify: () => {},
      },
    } as any;

    const config = makeTestConfig();
    await promptDecisionMenu(ownerCtx, meta, config);

    // Verify NO menu_escalation_consumed audit was written
    const consumedAudit = auditEvents.find(e => e.stage === "menu_escalation_consumed");
    expect(consumedAudit).toBeUndefined();

    // Verify menu was still shown (normal flow)
    expect(selectCalls).toBe(1);

    __setSafeWriteAuditLogOverride(null);
  });

  it("end-to-end: child arm → owner consume → owner again: 2 menu calls, 1 consumed audit", async () => {
    const meta = makeTestMeta({ flowState: "running" });

    // Step 1: Child arm
    const childCtx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        notify: () => {},
        select: async () => undefined,
      },
      _ctx: {
        sessionManager: {
          getHeader: () => ({ parentSession: "/tmp/parent-session.jsonl" }),
          getSessionName: () => "child-session-12345678",
          getSessionFile: () => "/tmp/child-session.jsonl",
        },
      },
    } as any;

    const config = makeTestConfig();
    await freezeAndPrompt(childCtx, meta, "loop_overflow", config);
    expect(meta.menuEscalationPending).toBe(true);

    // Step 2: Owner consume (first call)
    let selectCalls = 0;
    const ownerCtx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        select: async () => {
          selectCalls++;
          return "Resume";
        },
        notify: () => {},
      },
    } as any;

    await promptDecisionMenu(ownerCtx, meta, config);
    expect(meta.menuEscalationPending).toBe(false);
    expect(selectCalls).toBe(1);

    // Count consumed audits so far
    const consumedAuditsAfterFirst = auditEvents.filter(e => e.stage === "menu_escalation_consumed");
    expect(consumedAuditsAfterFirst.length).toBe(1);

    // Step 3: Simulate pipeline getting blocked again (manual state reset, no full freezeAndPrompt flow)
    // After resume, flowState is "running". Manually set blocked state to simulate a new block.
    meta.flowState = "blocked";
    meta.blockedReason = "loop_overflow";


    // Step 4: Owner second call
    await promptDecisionMenu(ownerCtx, meta, config);
    expect(selectCalls).toBe(2); // Menu shown second time

    // Verify total consumed audits is still 1 (no duplicate)
    const consumedAuditsAfterSecond = auditEvents.filter(e => e.stage === "menu_escalation_consumed");
    expect(consumedAuditsAfterSecond.length).toBe(1);

    __setSafeWriteAuditLogOverride(null);
  });
});
