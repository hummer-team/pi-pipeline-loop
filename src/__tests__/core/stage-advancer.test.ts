import { describe, it, expect, beforeEach } from "bun:test";
import { createStageAdvancer } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, STAGE_LIST } from "../helpers";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import type { PipelineStage } from "../../types";

/** Minimal mock ctx with session + _ctx for extractAssistantMessages */
function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (m: any) => {
        // Merge with current meta to match real session-state behavior
        const merged = { ...meta, ...m };
        updates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
    },
    updates,
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
  };
}

describe("createStageAdvancer", () => {
  it("creates a tool named 'stage_advance'", () => {
    const tool = createStageAdvancer(makeTestConfig());
    expect(tool.name).toBe("stage_advance");
    expect(typeof tool.execute).toBe("function");
  });

  it("has nextStage in parameters schema", () => {
    const tool = createStageAdvancer(makeTestConfig());
    expect(tool.parameters).toBeDefined();
    const params = tool.parameters as Record<string, any>;
    expect(params.properties?.nextStage).toBeDefined();
    expect(params.properties.nextStage.type).toBe("string");
    expect(params.required).toEqual([]);
  });

  it("returns error when no session context", async () => {
    const tool = createStageAdvancer(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("advances from current stage to next stage", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    config.stages["clarify"] = { ...config.stages["clarify"], nextStage: "plan" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(true);
    expect((result as any).currentStage).toBe("plan");
    expect(meta.currentStage).toBe("plan");
    expect(meta.previousStage).toBe("clarify");
    expect(meta.loopCount).toBe(0);
    expect(meta.currentStepIndex).toBe(0);
  });

  it("marks pipeline as completed when already completed", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "completed" });

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(false);
    expect((result as any).message).toContain("already completed");
  });

  it("advances last non-null stage to completed", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "review" });
    config.stages["review"] = { ...config.stages["review"], nextStage: null };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(true);
    expect((result as any).message).toContain("Pipeline completed");
    expect(meta.currentStage).toBe("completed");
  });

  it("clearStage when resolvedTarget is explicitly 'completed'", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "review" });
    // review → completed (explicit, not null)
    config.stages["review"] = { ...config.stages["review"], nextStage: "completed" as any };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(true);
    expect(meta.currentStage).toBe("completed");
    // clearStage path: message contains "Advanced" (not "Pipeline completed — no further stages")
    expect((result as any).message).toContain("Advanced");
    expect((result as any).message).toContain("completed");
  });

  it("resets loopCount and currentStepIndex on advance", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      loopCount: 5,
      currentStepIndex: 3,
    });
    config.stages["plan"] = { ...config.stages["plan"], nextStage: "develop" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    await tool.execute({}, ctx as any);

    expect(meta.loopCount).toBe(0);
    expect(meta.currentStepIndex).toBe(0);
    expect(meta.currentStage).toBe("develop");
  });

  it("resets verifyFailures on advance", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      verifyFailures: [{ ruleType: "requiredFiles", detail: "missing", timestamp: Date.now() }],
    });
    config.stages["plan"] = { ...config.stages["plan"], nextStage: "develop" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    await tool.execute({}, ctx as any);

    expect(meta.verifyFailures).toEqual([]);
  });

  // ─── nextStage parameter override ────────────────────────────────────────

  it("nextStage param overrides default target", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "review" });
    config.stages["review"] = { ...config.stages["review"], nextStage: "completed" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "fix" }, ctx as any);

    expect((result as any).success).toBe(true);
    expect((result as any).currentStage).toBe("fix");
    expect(meta.currentStage).toBe("fix");
    expect(meta.previousStage).toBe("review");
  });

  it("nextStage param works for branch to awaiting_human", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    config.stages["clarify"] = { ...config.stages["clarify"], nextStage: "plan" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "awaiting_human" }, ctx as any);

    expect((result as any).success).toBe(true);
    expect(meta.currentStage).toBe("awaiting_human");
  });

  it("invalid nextStage returns error and does not advance", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "plan" });
    const originalStage = meta.currentStage;

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "nonexistent_stage" }, ctx as any);

    expect((result as any).success).toBe(false);
    expect((result as any).message).toContain("not defined");
    expect(meta.currentStage).toBe(originalStage);
  });

  it("nextStage same as current returns error", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "plan" });

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "plan" }, ctx as any);

    expect((result as any).success).toBe(false);
    expect((result as any).message).toContain("cannot advance to the same stage");
  });

  // ─── Verification gate ───────────────────────────────────────────────────

  describe("verification gate", () => {
    it("skips verification when verify.require is false", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: false },
      };

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      expect((result as any).success).toBe(true);
      expect(meta.currentStage).toBe("plan");
    });

    it("skips verification when verify is undefined", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: undefined,
      };

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      expect((result as any).success).toBe(true);
      expect(meta.currentStage).toBe("plan");
    });

    it("verify.require=true and no verify.md file → config skip, treated as pass (148 Phase 2)", async () => {
      // 148 Phase 2/3: When verify.require is true but no verify.md exists,
      // diagnoseVerifyConfig returns file_missing → runVerification returns skipped=true
      // → stage-advancer treats as pass → advance to nextStage
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool" },
      };
      const meta = makeTestMeta({ currentStage: "clarify" });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      // Config skip treated as pass → advance succeeds
      expect((result as any).success).toBe(true);
      expect(meta.currentStage).toBe("plan"); // advanced
    });

    it("verify.require=true and verification passes → advance to nextStage", async () => {
      // Set up a temp directory with a verify.md containing a passing rule
      const TMP = join(tmpdir(), "pi-advancer-verify-pass-" + Date.now());
      const verifyDir = join(TMP, ".pi", "references", "clarify_spec");
      await mkdir(verifyDir, { recursive: true });
      // Create a target file that the requiredFiles rule will check
      const targetFile = join(TMP, "docs", "design", "test_plan.md");
      await mkdir(join(TMP, "docs", "design"), { recursive: true });
      await writeFile(targetFile, "# Plan");
      // Create verify.md with a requiredFiles rule that will pass
      await writeFile(
        join(verifyDir, "verify.md"),
        `---
rules:
  requiredFiles:
    - "docs/design/test_plan.md"
---
Verify plan document exists.`,
      );

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool", verifyFile: ".pi/references/clarify_spec/verify.md" },
      };
      const meta = makeTestMeta({ currentStage: "clarify" });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      // Verification passes → should advance
      expect((result as any).success).toBe(true);
      expect((result as any).currentStage).toBe("plan");
      expect(meta.currentStage).toBe("plan");
      expect(meta.previousStage).toBe("clarify");
    });

    it("accepts deps with execFn", () => {
      const mockExecFn = async () => ({ stdout: "", stderr: "", code: 0 });
      const tool = createStageAdvancer(makeTestConfig(), { execFn: mockExecFn });
      expect(tool.name).toBe("stage_advance");
      expect(typeof tool.execute).toBe("function");
    });

    it("tool mode: verify failure at maxVerifyAttempts triggers circuit breaker (flowState → blocked)", async () => {
      // Create a verify.md with a rule that will FAIL (fileContentPattern won't match)
      const TMP = join(tmpdir(), "pi-advancer-circuit-" + Date.now());
      const verifyDir = join(TMP, ".pi", "references", "clarify_spec");
      await mkdir(verifyDir, { recursive: true });
      // Create a dummy file that exists but doesn't match the pattern
      const dummyFile = join(TMP, "docs", "design", "dummy.md");
      await mkdir(join(TMP, "docs", "design"), { recursive: true });
      await writeFile(dummyFile, "This file does not contain the required pattern.");
      // Create verify.md with a fileContentPattern rule that will fail
      await writeFile(
        join(verifyDir, "verify.md"),
        `---
rules:
  fileContentPattern:
    - path: "docs/design/dummy.md"
      pattern: "^## Required Section"
---
Verification that will fail because the pattern does not match.`,
      );

      const config = makeTestConfig({ projectRoot: TMP });
      config.maxVerifyAttempts = 2;
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool", verifyFile: ".pi/references/clarify_spec/verify.md" },
      };
      const meta = makeTestMeta({
        currentStage: "clarify",
        verifyAttempts: 1, // One previous attempt
      });

      const ctx = createCtx(meta);
      // Add ui mock for freezeAndPrompt notification
      (ctx as any).ui = { notify: () => {}, select: async () => undefined };
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      // Should fail and freeze the pipeline (circuit breaker)
      expect((result as any).success).toBe(false);
      expect(meta.flowState).toBe("blocked");

      // Cleanup
      await rm(TMP, { recursive: true, force: true });
    });

    // ─── Phase 3: skipVerify escape hatch ──────────────────────────────────

    it("skipVerify=true skips verification gate when config-class error exists", async () => {
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool" },
      };
      const meta = makeTestMeta({
        currentStage: "clarify",
        verifyConfigError: true,
        verifyFailures: [
          {
            ruleType: "fileContentPattern",
            detail: "fileContentPattern path is empty (config error)",
            timestamp: Date.now(),
          },
        ],
      });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({ skipVerify: true }, ctx as any);

      // Should advance directly (skip verification)
      expect((result as any).success).toBe(true);
      expect(meta.currentStage).toBe("plan");
    });

    it("skipVerify=true is REJECTED when no config-class error exists", async () => {
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool" },
      };
      const meta = makeTestMeta({
        currentStage: "clarify",
        verifyFailures: [
          {
            ruleType: "fileContentPattern",
            detail: 'doc.md: pattern "xyz" not found', // content failure, NOT config error
            timestamp: Date.now(),
          },
        ],
      });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({ skipVerify: true }, ctx as any);

      // Should be rejected
      expect((result as any).success).toBe(false);
      expect((result as any).message).toContain("skipVerify is only allowed");
      // Should NOT advance
      expect(meta.currentStage).toBe("clarify");
    });

    it("skipVerify=false (default) behaves normally with verification gate", async () => {
      // 148 Phase 2/3: no verify.md → config skip → treated as pass → advance
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool" },
      };
      const meta = makeTestMeta({
        currentStage: "clarify",
        verifyFailures: [
          {
            ruleType: "fileContentPattern",
            detail: "fileContentPattern path is empty (config error)",
            timestamp: Date.now(),
          },
        ],
      });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      // skipVerify not set — normal verification gate applies
      const result = await tool.execute({}, ctx as any);

      // Config skip (no verify.md) treated as pass → advance succeeds
      expect((result as any).success).toBe(true);
      expect(meta.currentStage).toBe("plan"); // advanced
    });

    it("skipVerify parameter is declared in tool schema", () => {
      const tool = createStageAdvancer(makeTestConfig());
      const params = tool.parameters as Record<string, any>;
      expect(params.properties?.skipVerify).toBeDefined();
      expect(params.properties.skipVerify.type).toBe("boolean");
    });

    it("skipVerify=true works after resume (verifyConfigError persists through resume)", async () => {
      // Simulates the full lifecycle: config error → freeze → resume → skipVerify
      // Before the fix, resume cleared verifyFailures making isConfigError([]) return false
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool" },
      };
      // After resume: verifyFailures cleared but verifyConfigError persists
      const meta = makeTestMeta({
        currentStage: "clarify",
        flowState: "running",
        verifyFailures: [],       // cleared by resume
        verifyConfigError: true,  // persisted through resume
      });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({ skipVerify: true }, ctx as any);

      // Should succeed — verifyConfigError marker allows escape
      expect((result as any).success).toBe(true);
      expect(meta.currentStage).toBe("plan");
      // verifyConfigError should be cleared after successful advance
      expect(meta.verifyConfigError).toBeUndefined();
    });

    it("skipVerify=true rejected when verifyConfigError is false/undefined (no config error)", async () => {
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool" },
      };
      const meta = makeTestMeta({
        currentStage: "clarify",
        verifyFailures: [],
        verifyConfigError: undefined,
      });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({ skipVerify: true }, ctx as any);

      expect((result as any).success).toBe(false);
      expect((result as any).message).toContain("skipVerify is only allowed");
    });
  });

  // ─── Phase 4 (143): Hash mismatch blocks advance ────────────────────────────

  describe("summary hash mismatch precheck (143 Phase 4)", () => {
    it("blocks advance when current stage summary hash mismatches disk", async () => {
      const TMP = join(tmpdir(), `pi-advancer-hash-${Date.now()}`);
      await mkdir(TMP, { recursive: true });
      const summaryPath = join(TMP, "develop.md");

      // Write file and compute hash
      const content = "# Develop Summary\nOriginal";
      await writeFile(summaryPath, content, "utf-8");
      const originalHash = require("node:crypto").createHash("sha256").update(content).digest("hex");

      // Modify file (simulate manual edit)
      await writeFile(summaryPath, "# Develop Summary\nModified", "utf-8");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "develop",
        summaries: {
          develop: { path: summaryPath, hash: originalHash, status: "valid" as const },
        },
      });
      const ctx = createCtx(meta);

      const tool = createStageAdvancer(config);
      const result = (await tool.execute({}, ctx as any)) as any;

      expect(result.success).toBe(false);
      expect(result.message).toContain("modified manually");
      expect(result.message).toContain("hash mismatch");
      expect(result.mismatchedStage).toBe("develop");

      await require("node:fs/promises").rm(TMP, { recursive: true, force: true });
    });

    it("allows advance when no summary exists for current stage", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "clarify",
        summaries: {},
      });
      const ctx = createCtx(meta);

      const tool = createStageAdvancer(config);
      const result = (await tool.execute({}, ctx as any)) as any;

      // Should NOT block on hash check (no summary to check)
      // May still fail on verification, but not on hash mismatch
      expect(result.mismatchedStage).toBeUndefined();
    });
  });
});

describe("Phase 4 (162): stage_advance confirm gate integration", () => {
  function createCtxWithUI(meta: any, selectReturn?: string) {
    const updates: any[] = [];
    const notifications: string[] = [];
    return {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => {
          const merged = { ...meta, ...m };
          updates.push(merged);
          Object.assign(meta, merged);
          return merged;
        },
      },
      updates,
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
      ui: {
        notify: (msg: string) => { notifications.push(msg); },
        select: selectReturn !== undefined
          ? async () => selectReturn
          : async () => undefined,
        transition: () => {},
        clearStage: () => {},
      },
      pi: { sendUserMessage: () => {} },
    };
  }

  function makePlanConfigWithConfirm(root: string, mode: "auto" | "manual" | "smart") {
    const base = makeTestConfig({ projectRoot: root });
    const planStage = {
      ...base.stages.plan,
      nextStage: "develop" as PipelineStage,
      verify: { require: true },
      allowedWritePaths: ["docs/"],
      confirm: { mode },
    };
    return {
      ...base,
      stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
    };
  }

  it("needConfirm parameter is accepted in tool schema", () => {
    const tool = createStageAdvancer(makeTestConfig());
    const params = tool.parameters as Record<string, any>;
    expect(params.properties?.needConfirm).toBeDefined();
    expect(params.properties.needConfirm.type).toBe("boolean");
  });

  it("smart mode + needConfirm not set → confirm_smart_skip + advance", async () => {
    const stageTmp = join(tmpdir(), "pi-advancer-smart-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await mkdir(join(stageTmp, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "smart");
    // Create plan doc + verify.md with no rules (passes trivially)
    const docsDir = join(stageTmp, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "77_Config_plan.md"), "# Plan\nplan\n", "utf-8");
    const refDir = join(stageTmp, ".pi", "references", "plan_spec");
    await mkdir(refDir, { recursive: true });
    await writeFile(join(refDir, "verify.md"), "---\nrequiredFiles:\n  - \"docs/design/77_Config_plan.md\"\n---\nVerify.", "utf-8");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createCtxWithUI(meta);

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("develop");

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_smart_skip");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("smart mode + needConfirm=true → confirm gate triggered", async () => {
    const stageTmp = join(tmpdir(), "pi-advancer-smart-complex-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await mkdir(join(stageTmp, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "smart");
    const docsDir = join(stageTmp, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "77_Config_plan.md"), "# Plan\nplan\n", "utf-8");
    const refDir = join(stageTmp, ".pi", "references", "plan_spec");
    await mkdir(refDir, { recursive: true });
    await writeFile(join(refDir, "verify.md"), "---\nrequiredFiles:\n  - \"docs/design/77_Config_plan.md\"\n---\nVerify.", "utf-8");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    // Select returns "Approve & Advance"
    const ctx = createCtxWithUI(meta, "Approve & Advance");

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({ needConfirm: true }, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("develop");
    expect(meta.confirmRejections).toBeUndefined();

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_approved");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("manual mode + approve → advance to develop", async () => {
    const stageTmp = join(tmpdir(), "pi-advancer-manual-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await mkdir(join(stageTmp, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    const docsDir = join(stageTmp, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "77_Config_plan.md"), "# Plan\nplan\n", "utf-8");
    const refDir = join(stageTmp, ".pi", "references", "plan_spec");
    await mkdir(refDir, { recursive: true });
    await writeFile(join(refDir, "verify.md"), "---\nrequiredFiles:\n  - \"docs/design/77_Config_plan.md\"\n---\nVerify.", "utf-8");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createCtxWithUI(meta, "Approve & Advance");

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("develop");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("manual mode + reject → route to clarify", async () => {
    const stageTmp = join(tmpdir(), "pi-advancer-manual-reject-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await mkdir(join(stageTmp, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    const docsDir = join(stageTmp, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "77_Config_plan.md"), "# Plan\nplan\n", "utf-8");
    const refDir = join(stageTmp, ".pi", "references", "plan_spec");
    await mkdir(refDir, { recursive: true });
    await writeFile(join(refDir, "verify.md"), "---\nrequiredFiles:\n  - \"docs/design/77_Config_plan.md\"\n---\nVerify.", "utf-8");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createCtxWithUI(meta, "Reject & Rework (back to clarify)");

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("clarify");
    expect(meta.confirmRejections).toBe(1);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("auto mode → no confirm gate, advances normally", async () => {
    const stageTmp = join(tmpdir(), "pi-advancer-auto-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await mkdir(join(stageTmp, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "auto");
    const docsDir = join(stageTmp, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, "77_Config_plan.md"), "# Plan\nplan\n", "utf-8");
    const refDir = join(stageTmp, ".pi", "references", "plan_spec");
    await mkdir(refDir, { recursive: true });
    await writeFile(join(refDir, "verify.md"), "---\nrequiredFiles:\n  - \"docs/design/77_Config_plan.md\"\n---\nVerify.", "utf-8");

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createCtxWithUI(meta);

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("develop");

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_auto_write");
    // Should NOT have confirm gate audit events
    expect(logContent).not.toContain("confirm_approved");
    expect(logContent).not.toContain("confirm_pending");

    await rm(stageTmp, { recursive: true, force: true });
  });
});
