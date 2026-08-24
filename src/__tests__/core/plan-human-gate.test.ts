import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { maybeHandlePlanHumanGate } from "../../core/verify-advance";
import { createAgentSettled } from "../../core/agent-settled";
import { createStageAdvancer } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { createPipelineUI } from "../../core/pipeline-ui";
import type { PipelineConfig, SessionMeta } from "../../types";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-gate-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  __resetAuditDirPath();
});

/**
 * Creates a config with plan stage verify rules that include the plan doc glob pattern.
 * The gate triggers based on preconditions (stage=plan, doc resolvable+exists, no marker)
 * regardless of whether verify rules reference the plan doc glob.
 */
async function makeConfigWithPlanGate(projectRoot: string): Promise<PipelineConfig> {
  // Create verify.md for plan stage with the plan doc glob pattern
  const verifyDir = path.join(projectRoot, ".pi", "references", "plan_spec");
  await fs.mkdir(verifyDir, { recursive: true });
  await fs.writeFile(
    path.join(verifyDir, "verify.md"),
    "---\nrules:\n  requiredFiles:\n    - \"docs/design/*_plan.md\"\n  fileContentPattern:\n    - path: \"docs/design/*_plan.md\"\n      pattern: \"^## 用户确认\"\n---\nPlan verification\n",
    "utf-8",
  );

  const base = makeTestConfig({ projectRoot });
  return {
    ...base,
    stages: {
      ...base.stages,
      plan: {
        ...base.stages["plan"],
        nextStage: "develop",
        allowedWritePaths: ["docs/"],
        verify: {
          require: true,
          verifyFile: ".pi/references/plan_spec/verify.md",
        },
      },
    },
  } as PipelineConfig;
}

describe("maybeHandlePlanHumanGate", () => {
  it("returns 'no-gate' when currentStage is not plan", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta);

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("no-gate");
    expect(result.action).toBe("none");
  });

  it("returns 'no-gate' when plan doc path cannot be resolved", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: undefined });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta);

    // No plan doc exists, requirementDoc is undefined, glob won't match
    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("no-gate");
    expect(result.action).toBe("none");
  });

  it("returns 'no-gate' when plan doc path is resolvable but file does not exist on disk", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    // requirementDoc points to docs/design/req.md → resolves to docs/design/req_plan.md
    // but the file is NOT created on disk
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta, { selectReturn: "已确认（写入标记并推进）" });

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    // File doesn't exist → gate skips, returns no-gate (normal verify flow handles it)
    expect(result.result).toBe("no-gate");

    // Stage should NOT have advanced
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("plan");
  });

  it("returns 'no-gate' when plan doc already has confirm marker", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const planDocPath = path.join(TMP, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\n\n## 用户确认\n已确认\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta);

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("no-gate");
  });

  it("triggers gate even when verify rules use concrete path (not glob)", async () => {
    // Config with plan verify using a concrete path instead of the generic glob
    // Gate should still trigger based on marker absence, not rule content
    const verifyDir = path.join(TMP, ".pi", "references", "plan_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"docs/design/specific_plan.md\"\n---\nPlan verification\n",
      "utf-8",
    );
    const config = makeTestConfig({ projectRoot: TMP });
    (config.stages as any).plan = {
      ...config.stages["plan"],
      nextStage: "develop",
      allowedWritePaths: ["docs/"],
      verify: { require: true, verifyFile: ".pi/references/plan_spec/verify.md" },
    };
    await initAuditLog(config);
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const planDocPath = path.join(TMP, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    // selectReturn undefined simulates Esc
    const ctx = createMockCtx(meta, { selectReturn: undefined });

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    // Gate triggers because preconditions are met (stage=plan, doc exists, no marker)
    expect(result.result).toBe("handled");
    expect(result.action).toBe("cancelled");

    // Audit should contain plan_confirm_cancelled (Esc)
    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_cancelled");
  });

  it("'approved': appends marker, advances to develop, writes plan_confirm_approved audit", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const planDocPath = path.join(TMP, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta, { selectReturn: "已确认（写入标记并推进）" });

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("handled");
    expect(result.action).toBe("advanced");

    // Marker should have been appended
    const content = await fs.readFile(planDocPath, "utf-8");
    expect(content).toContain("## 用户确认：确认无误");
    expect(content).toContain("> 确认时间：");

    // Stage should have advanced to develop
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("develop");

    // Audit should contain plan_confirm_approved
    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_approved");

    // verifyAttempts should NOT have been incremented
    expect(updatedMeta.verifyAttempts).toBeUndefined();
  });

  it("'adjust': stays in plan, no marker, writes plan_confirm_adjust audit", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const planDocPath = path.join(TMP, "docs", "design", "req_plan.md");
    const originalContent = "# Plan\nNo confirmation yet\n";
    await fs.writeFile(planDocPath, originalContent);

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta, { selectReturn: "有问题需调整（在 plan 补充调整意见）" });

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("handled");
    expect(result.action).toBe("adjust");

    // No marker appended
    const content = await fs.readFile(planDocPath, "utf-8");
    expect(content).toBe(originalContent);

    // Stage stays in plan
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("plan");

    // verifyAttempts NOT incremented
    expect(updatedMeta.verifyAttempts).toBeUndefined();

    // Audit contains plan_confirm_adjust
    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_adjust");
  });

  it("'cancel': stays in plan, writes plan_confirm_cancelled audit", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const planDocPath = path.join(TMP, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta, { selectReturn: "取消" });

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("handled");
    expect(result.action).toBe("cancelled");

    // Stage stays in plan
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("plan");

    // Audit contains plan_confirm_cancelled
    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_cancelled");
  });

  it("no ui.select: writes plan_confirm_pending audit, returns handled", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const planDocPath = path.join(TMP, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);

    // Create ctx without ui.select
    const ctx = createMockCtx(meta);
    delete (ctx as any).ui.select;

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("handled");
    expect(result.action).toBe("pending");

    // Audit contains plan_confirm_pending
    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_pending");
  });

  it("'approved' with EISDIR: writes plan_confirm_approved_failed audit, does not advance", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    // Create req_plan.md as a DIRECTORY to trigger EISDIR on appendFile
    const planDocDir = path.join(TMP, "docs", "design", "req_plan.md");
    await fs.mkdir(planDocDir);

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta, { selectReturn: "已确认（写入标记并推进）" });

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("handled");
    expect(result.action).toBe("cancelled");

    // Stage should NOT have advanced (appendFile failed)
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("plan");

    // Audit should contain plan_confirm_approved_failed
    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_approved_failed");
    // Should NOT contain plan_confirm_approved as a standalone event (only _failed variant)
    const lines = logContent.split("\n");
    const approvedLines = lines.filter(l => l.includes("plan_confirm_approved") && !l.includes("plan_confirm_approved_failed"));
    expect(approvedLines.length).toBe(0);
  });

  it("Esc (select returns undefined): writes plan_confirm_cancelled audit", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    const planDocPath = path.join(TMP, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    // selectReturn undefined simulates Esc
    const ctx = createMockCtx(meta, { selectReturn: undefined });

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result.result).toBe("handled");
    expect(result.action).toBe("cancelled");

    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_cancelled");
  });
});

// ─── Phase 2 (141): dual-entry integration tests ──────────────────────────────────
describe("Phase 2 (141): plan human-gate integration", () => {
  let integTmp: string;

  beforeEach(async () => {
    integTmp = path.join(tmpdir(), "pi-gate-integ-" + Date.now());
    await fs.mkdir(integTmp, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(integTmp, { recursive: true, force: true });
    __resetAuditDirPath();
  });

  /** Helper: create a config with plan verify + plan doc on disk (no marker) */
  async function makeIntegConfig(projectRoot: string): Promise<PipelineConfig> {
    const verifyDir = path.join(projectRoot, ".pi", "references", "plan_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"docs/design/*_plan.md\"\n  fileContentPattern:\n    - path: \"docs/design/*_plan.md\"\n      pattern: \"^## 用户确认\"\n---\nPlan verification\n",
      "utf-8",
    );

    const base = makeTestConfig({ projectRoot });
    return {
      ...base,
      stages: {
        ...base.stages,
        plan: {
          ...base.stages["plan"],
          nextStage: "develop",
          allowedWritePaths: ["docs/"],
          verify: {
            require: true,
            verifyFile: ".pi/references/plan_spec/verify.md",
          },
        },
      },
    } as PipelineConfig;
  }

  it("agent-settled: gate hit with 'approved' → no auto_verify_fail, stage advances to develop", async () => {
    const config = await makeIntegConfig(integTmp);
    await initAuditLog(config);
    await fs.mkdir(path.join(integTmp, "docs", "design"), { recursive: true });
    const planDocPath = path.join(integTmp, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const ctx = createMockCtx(meta, { selectReturn: "已确认（写入标记并推进）" });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Stage should have advanced to develop
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("develop");

    // Audit should contain plan_confirm_approved, NOT auto_verify_fail
    const logPath = path.join(integTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_approved");
    expect(logContent).not.toContain("auto_verify_fail");

    // Marker should have been appended
    const content = await fs.readFile(planDocPath, "utf-8");
    expect(content).toContain("## 用户确认：确认无误");
  });

  it("stage-advancer: gate hit with 'approved' → tool returns success:true, stage advances", async () => {
    const config = await makeIntegConfig(integTmp);
    await initAuditLog(config);
    await fs.mkdir(path.join(integTmp, "docs", "design"), { recursive: true });
    const planDocPath = path.join(integTmp, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const ctx = createMockCtx(meta, { selectReturn: "已确认（写入标记并推进）" });

    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    // Tool should return success (stage actually advanced)
    expect((result as any).success).toBe(true);
    expect((result as any).message).toContain("approved");
    expect((result as any).currentStage).toBe("develop");

    // Stage should have advanced to develop (via autoAdvanceAfterVerify inside gate)
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("develop");

    // Audit should contain plan_confirm_approved
    const logPath = path.join(integTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_approved");
  });

  it("stage-advancer: gate hit with no ui.select (pending) → tool returns success:false, pending:true", async () => {
    const config = await makeIntegConfig(integTmp);
    await initAuditLog(config);
    await fs.mkdir(path.join(integTmp, "docs", "design"), { recursive: true });
    const planDocPath = path.join(integTmp, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    // Create ctx without ui.select to simulate headless / no-UI environment
    const ctx = createMockCtx(meta);
    delete (ctx as any).ui.select;

    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    // Tool should return success:false + pending:true (stage did NOT advance)
    expect((result as any).success).toBe(false);
    expect((result as any).pending).toBe(true);
    expect((result as any).message).toContain("awaiting");
    expect((result as any).currentStage).toBe("plan");

    // Stage stays in plan
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("plan");

    // Audit should contain plan_confirm_pending
    const logPath = path.join(integTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_pending");
  });

  it("stage-advancer: gate hit with 'cancelled' → tool returns success:false, pending:true", async () => {
    const config = await makeIntegConfig(integTmp);
    await initAuditLog(config);
    await fs.mkdir(path.join(integTmp, "docs", "design"), { recursive: true });
    const planDocPath = path.join(integTmp, "docs", "design", "req_plan.md");
    await fs.writeFile(planDocPath, "# Plan\nNo confirmation yet\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    // User presses Esc (select returns undefined)
    const ctx = createMockCtx(meta, { selectReturn: undefined });

    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    // Tool should return success:false + pending:true (stage did NOT advance)
    expect((result as any).success).toBe(false);
    expect((result as any).pending).toBe(true);
    expect((result as any).currentStage).toBe("plan");

    // Stage stays in plan
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.currentStage).toBe("plan");
  });
});
