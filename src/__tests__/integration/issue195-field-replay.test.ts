/**
 * Issue 195 Phase 10 — Field replay integration test
 *
 * Reproduces the vaultmind-equivalent scenario: develop→review→fix→review loop
 * with maxLoopCycles=5, verifies freeze at review on 6th attempt, and validates
 * set_budget/rewind_last_round decision exits.
 *
 * Test structure:
 * - Uses template chain from pipeline_loop.json (fix→review, maxLoopCycles=5)
 * - Drives 5 rounds of review→fix→review using recordStageVisit
 * - Verifies 6th review→fix attempt freezes at review (currentStage unchanged)
 * - Tests set_budget extends budget and unblocks
 * - Tests rewind_last_round rewinds to review and resets state
 * - All assertions are unconditional (no if-statements with empty bodies)
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { recordStageVisit, deriveReworkLoopGate } from "../../utils/stage-visit";
import { executeDecision, buildDecisionMenu } from "../../core/flow-state";
import { createToolGuard } from "../../core/tool-guard";
import { __setSafeWriteAuditLogOverride, initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionMeta, PipelineConfig, PipelineStage } from "../../types";

describe("issue195 field replay: rework loop freeze and decision exits", () => {
  let config: PipelineConfig;
  let auditEvents: Array<{ stage: string; message?: Record<string, string | boolean> }>;

  beforeEach(() => {
    auditEvents = [];
    __setSafeWriteAuditLogOverride(async (stage, message) => {
      auditEvents.push({ stage, message });
    });

    // Template chain from pipeline_loop.json: fix→review loop, maxLoopCycles=5
    config = {
      projectRoot: "/tmp/test-issue195-replay",
      stages: {
        clarify: { nextStage: "plan" },
        plan: { nextStage: "develop" },
        develop: { nextStage: "review" },
        review: { nextStage: "completed" },
        fix: { nextStage: "review" },
        completed: { nextStage: null },
      } as Record<PipelineStage, any>,
      maxLoopCycles: 5,
    } as PipelineConfig;
  });

  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
  });

  test("5 rounds of review→fix→review, freeze at round 6 review", () => {
    const pipelineId = "pipe-issue195-replay-1";

    // Initial meta at develop stage
    let meta: SessionMeta = {
      currentStage: "develop",
      stageVisitOrder: ["clarify", "plan", "develop"],
      loopCycleCount: 0,
      pipelineId,
      maxLoopCycles: 5,
    } as SessionMeta;

    const maxCycles = config.maxLoopCycles!;

    // Drive develop→review (C0 first visit, not counted)
    let result = recordStageVisit(meta, "review", maxCycles, config);
    expect(result.ok).toBe(true);
    expect(result.edgeKind).toBe("first");
    expect(result.counted).toBe(false);
    expect(result.patch.loopCycleCount).toBe(0);
    meta = { ...meta, currentStage: "review", ...result.patch };

    // Drive 5 rounds of review→fix→review
    for (let round = 1; round <= 5; round++) {
      // review→fix
      result = recordStageVisit(meta, "fix", maxCycles, config);
      expect(result.ok).toBe(true);

      // Round 1: C0 first visit (not counted), Rounds 2+: C3 loop_return (counted)
      if (round === 1) {
        expect(result.edgeKind).toBe("first");
        expect(result.counted).toBe(false);
        expect(result.patch.loopCycleCount).toBe(0);
      } else {
        expect(result.edgeKind).toBe("loop_return");
        expect(result.counted).toBe(true);
        expect(result.patch.loopCycleCount).toBe(round - 1);
      }
      meta = { ...meta, currentStage: "fix", ...result.patch };

      // fix→review (C1 forward, not counted)
      result = recordStageVisit(meta, "review", maxCycles, config);
      expect(result.ok).toBe(true);
      expect(result.edgeKind).toBe("forward");
      expect(result.counted).toBe(false);
      expect(result.patch.loopCycleCount).toBe(meta.loopCycleCount);
      meta = { ...meta, currentStage: "review", ...result.patch };
    }

    // After 5 rounds: loopCycleCount = 4 (4 counted edges: rounds 2,3,4,5 review→fix)
    expect(meta.loopCycleCount).toBe(4);

    // Round 6: review→fix attempt should freeze
    result = recordStageVisit(meta, "fix", maxCycles, config);
    expect(result.ok).toBe(false);

    // Type guard: check ok is false before accessing wouldFreeze
    if (!result.ok) {
      expect(result.wouldFreeze).toBe(true);
      expect(result.edgeKind).toBe("loop_return");
      expect(result.counted).toBe(true);
      expect(result.patch.loopCycleCount).toBe(5);

      // Verify stageVisitOrder after freeze attempt
      const visitOrder = result.patch.stageVisitOrder!;
      expect(visitOrder.length).toBe(15); // initial 3 + develop→review (1) + 5 rounds × 2 (10) + freeze attempt (1)
      expect(visitOrder[0]).toBe("clarify");
      expect(visitOrder[1]).toBe("plan");
      expect(visitOrder[2]).toBe("develop");
      expect(visitOrder[3]).toBe("review");
      expect(visitOrder[4]).toBe("fix");
      expect(visitOrder[14]).toBe("fix"); // last entry is the would-be 6th fix

      // Derive rewind gate: should be "review" (last counted-edge source)
      const frozenMeta = { ...meta, stageVisitOrder: visitOrder, loopCycleCount: 5 };
      const gate = deriveReworkLoopGate(frozenMeta, config);
      expect(gate).toBe("review");
    }

    // Freeze at review (currentStage unchanged)
    expect(meta.currentStage).toBe("review");
  });

  test("set_budget extends max and unblocks", async () => {
    const pipelineId = "pipe-issue195-replay-2";

    // Set up frozen meta at review with loopCycleCount=5
    let meta: SessionMeta = {
      currentStage: "review",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix", "review", "fix", "review", "fix", "review", "fix", "review"],
      loopCycleCount: 5,
      maxLoopCycles: 5,
      pipelineId,
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
    } as SessionMeta;

    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
          return meta;
        },
      },
      ui: {},
      _ctx: {},
    };

    // Call executeDecision with set_budget (signature: ctx, meta, decision, config, opts)
    const result = await executeDecision(ctx as any, meta, "set_budget", config, {
      budgetValue: 10,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("Budget extended to 10");
    expect(meta.maxLoopCycles).toBe(10);
    expect(meta.flowState).toBe("running");
    expect(meta.blockedReason).toBeUndefined();
    expect(meta.loopBudgetExtensionCount).toBe(1);

    // Verify audit event
    const decisionAudit = auditEvents.find(e => e.stage === "pipeline_decision");
    expect(decisionAudit).toBeDefined();
    expect(decisionAudit?.message?.decision).toBe("set_budget");
    expect(decisionAudit?.message?.budgetValue).toBe("10");
  });

  test("rewind_last_round rewinds to review and resets state", async () => {
    const pipelineId = "pipe-issue195-replay-3";

    // Set up frozen meta at review with loopCycleCount=5
    let meta: SessionMeta = {
      currentStage: "review",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix", "review", "fix", "review", "fix", "review", "fix", "review"],
      loopCycleCount: 5,
      maxLoopCycles: 5,
      pipelineId,
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
    } as SessionMeta;

    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
          return meta;
        },
      },
      ui: {},
      _ctx: {},
    };

    // Call executeDecision with rewind_last_round (signature: ctx, meta, decision, config, opts)
    const result = await executeDecision(ctx as any, meta, "rewind_last_round", config);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Rewound");
    expect(meta.currentStage).toBe("review"); // rewind to review
    expect(meta.previousStage).toBe("review"); // previous was review (before rewind)
    expect(meta.loopCycleCount).toBe(0); // reset
    expect(meta.loopRewindCount).toBe(1);
    expect(meta.flowState).toBe("running");
    expect(meta.blockedReason).toBeUndefined();

    // Verify stageVisitOrder: appended with gate stage
    expect(meta.stageVisitOrder!.length).toBe(15); // original 14 + 1 more review
    expect(meta.stageVisitOrder![14]).toBe("review");

    // Verify audit event
    const decisionAudit = auditEvents.find(e => e.stage === "pipeline_decision");
    expect(decisionAudit).toBeDefined();
    expect(decisionAudit?.message?.decision).toBe("rewind_last_round");
    expect(decisionAudit?.message?.fromStage).toBe("review");
    expect(decisionAudit?.message?.toStage).toBe("review");
  });

  test("set_budget rejects when not frozen", async () => {
    const pipelineId = "pipe-issue195-replay-4";

    let meta: SessionMeta = {
      currentStage: "review",
      flowState: "running", // not frozen
      pipelineId,
    } as SessionMeta;

    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
          return meta;
        },
      },
      ui: {},
      _ctx: {},
    };

    const result = await executeDecision(ctx as any, meta, "set_budget", config, {
      budgetValue: 10,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("not frozen");
  });

  test("rewind_last_round rejects when not frozen", async () => {
    const pipelineId = "pipe-issue195-replay-5";

    let meta: SessionMeta = {
      currentStage: "review",
      flowState: "running", // not frozen
      pipelineId,
    } as SessionMeta;

    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
          return meta;
        },
      },
      ui: {},
      _ctx: {},
    };

    const result = await executeDecision(ctx as any, meta, "rewind_last_round", config);

    expect(result.success).toBe(false);
    expect(result.message).toContain("not frozen");
  });

  test("set_budget rejects when budgetValue <= current loopCycleCount", async () => {
    const pipelineId = "pipe-issue195-replay-6";

    let meta: SessionMeta = {
      currentStage: "review",
      flowState: "blocked",
      loopCycleCount: 5,
      pipelineId,
    } as SessionMeta;

    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
          return meta;
        },
      },
      ui: {},
      _ctx: {},
    };

    // Try to set budget to 5 (equal to current loopCycleCount)
    const result = await executeDecision(ctx as any, meta, "set_budget", config, {
      budgetValue: 5,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("must be greater than current loopCycleCount");
  });

  test("rewind_last_round rejects when gate is null", async () => {
    const pipelineId = "pipe-issue195-replay-7";

    // Set up frozen meta with no counted edges in stageVisitOrder
    let meta: SessionMeta = {
      currentStage: "review",
      stageVisitOrder: ["clarify", "plan", "develop", "review"], // no counted edges
      loopCycleCount: 0,
      pipelineId,
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
    } as SessionMeta;

    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...meta, ...patch };
          return meta;
        },
      },
      ui: {},
      _ctx: {},
    };

    const result = await executeDecision(ctx as any, meta, "rewind_last_round", config);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to locate the starting point of previous rework");

    // Verify audit event
    const unresolvedAudit = auditEvents.find(e => e.stage === "rewind_target_unresolved");
    expect(unresolvedAudit).toBeDefined();
  });

  test("deliverable write passthrough under tool-guard in develop stage", async () => {
    const pipelineId = "pipe-issue195-replay-deliverable-write";
    const projectRoot = join(tmpdir(), `pi-issue195-deliverable-${Date.now()}`);
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(projectRoot, "docs", "design"), { recursive: true });

    const testConfig = makeTestConfig({
      projectRoot,
      stages: {
        clarify: { nextStage: "plan", allowedWritePaths: ["docs/"] } as any,
        plan: { nextStage: "develop", allowedWritePaths: ["docs/"] } as any,
        develop: { nextStage: "review", allowedWritePaths: ["**"], allowedReadOnlyPaths: ["docs/design/*_plan.md"] } as any,
        "design-review": { nextStage: "develop", allowedWritePaths: [] } as any,
        review: { nextStage: "completed", allowedWritePaths: [] } as any,
        fix: { nextStage: "review", allowedWritePaths: ["**"] } as any,
        completed: { nextStage: null } as any,
        awaiting_human: { nextStage: null } as any,
      },
    });
    await initAuditLog(testConfig);

    const meta = makeTestMeta({ currentStage: "develop", pipelineId });
    const ctx = createMockCtx(meta);

    const guard = createToolGuard(testConfig);

    // (a) Write deliverable commit file: should pass (not in read-only paths)
    const commitFile = join(projectRoot, "docs", "design", "test_plan_commit.md");
    ctx.toolCall = { name: "write", arguments: { file_path: commitFile } };
    const resultCommit = await guard.handler(ctx as any);
    const commitBlocked = (resultCommit as { block?: boolean })?.block;
    expect(commitBlocked).toBeUndefined();

    // (b) Bash echo to same deliverable: should pass
    ctx.toolCall = { name: "bash", arguments: { command: `echo "content" > ${commitFile}` } };
    const resultBash = await guard.handler(ctx as any);
    const bashBlocked = (resultBash as { block?: boolean })?.block;
    expect(bashBlocked).toBeUndefined();

    // (c) Write to read-only plan file: should block
    const planFile = join(projectRoot, "docs", "design", "test_plan.md");
    ctx.toolCall = { name: "write", arguments: { file_path: planFile } };
    const resultPlan = await guard.handler(ctx as any);
    expect((resultPlan as { block?: boolean })?.block).toBe(true);

    // Verify violation recorded for read-only path
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    const violations = updatedMeta.violations ?? [];
    const readOnlyViolations = violations.filter(v => v.type === "write_protected");
    expect(readOnlyViolations.length).toBe(1);
  });

  test("pruned decision menu after round 6 freeze", () => {
    const pipelineId = "pipe-issue195-replay-pruned-menu";

    // Frozen meta at round 6: loopCycleCount=5, maxLoopCycles=5, budget exhausted
    const frozenMeta: SessionMeta = {
      currentStage: "review",
      stageVisitOrder: [
        "clarify", "plan", "develop", "review",
        "fix", "review", "fix", "review", "fix", "review", "fix", "review", "fix", "review", "fix"
      ],
      loopCycleCount: 5,
      maxLoopCycles: 5,
      pipelineId,
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopBudgetExtensionCount: 0,
      loopRewindCount: 0,
    } as SessionMeta;

    const menu = buildDecisionMenu(frozenMeta, "max_loop_cycles", config);

    // 203_Bug Phase 1: gating removed — service menu always contains all 5 items
    expect(menu).not.toBeNull();
    expect(menu!.length).toBe(5);
    expect(menu).toContain("Set round budget");
    expect(menu).toContain("Rewind last_round");
    expect(menu).toContain("Restart & New");
    expect(menu).toContain("Abort & Exit");
    expect(menu).toContain("Resume");

    // First item must be set_budget (Set round budget)
    expect(menu![0]).toBe("Set round budget");
  });
});
