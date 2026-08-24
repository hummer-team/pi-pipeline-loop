import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { maybeHandlePlanHumanGate } from "../../core/verify-advance";
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
 * This is required for the gate to trigger (gate only activates when verify rules
 * reference the generic plan doc glob `docs/design/*_plan.md`).
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
    expect(result).toBe("no-gate");
  });

  it("returns 'no-gate' when plan doc path cannot be resolved", async () => {
    const config = await makeConfigWithPlanGate(TMP);
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: undefined });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta);

    // No plan doc exists, requirementDoc is undefined, glob won't match
    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result).toBe("no-gate");
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
    expect(result).toBe("no-gate");
  });

  it("returns 'no-gate' when verify rules don't reference plan doc glob", async () => {
    // Config with plan verify but no plan doc glob in rules
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
    await fs.writeFile(path.join(TMP, "docs", "design", "req_plan.md"), "# Plan\n");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/req.md" });
    const pipelineUI = createPipelineUI(config);
    const ctx = createMockCtx(meta);

    const result = await maybeHandlePlanHumanGate(config, ctx as any, meta, pipelineUI);
    expect(result).toBe("no-gate");
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
    expect(result).toBe("handled");

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
    expect(result).toBe("handled");

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
    expect(result).toBe("handled");

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
    expect(result).toBe("handled");

    // Audit contains plan_confirm_pending
    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_pending");
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
    expect(result).toBe("handled");

    const logPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await fs.readFile(logPath, "utf-8");
    expect(logContent).toContain("plan_confirm_cancelled");
  });
});
