import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { makeTestConfig, createMockCtx, makeTestMeta } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";

let TMP: string;
let docPath: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-start-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
  docPath = path.join(TMP, "req.md");
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("createPipelineStartCommand", () => {
  it("starts a pipeline with a valid doc file", async () => {
    await fs.writeFile(docPath, "# My Requirements\nDo X and Y", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx);

    expect(result.success).toBe(true);
    expect(result.pipelineId).toMatch(/^pipe-/);
    expect(result.currentStage).toBe("clarify");
    expect(result.requirementContent).toContain("# My Requirements");
    expect(updatedMeta).not.toBeNull();
    expect(updatedMeta.currentStage).toBe("clarify");
    expect(updatedMeta.requirementDoc).toBe("req.md");
  });

  it("returns error when file is missing", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: () => {},
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "nonexistent.md" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("File not found");
  });

  // Phase 5 (Bug 5): aborted restart with empty requirementDoc is rejected
  it("aborted restart + empty requirementDoc + no file → returns /pipeline-start hint", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      flowState: "aborted",
      // requirementDoc intentionally omitted (undefined)
    });
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "" }, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("/pipeline-start");
    expect(result.error).toContain("run /pipeline-start <doc_file>");
    expect(updatedMeta).toBeNull();
  });

  // Phase 5 (Bug 5): aborted restart with non-empty requirementDoc preserves it
  it("aborted restart + requirementDoc preserved + no file → restart succeeds", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      flowState: "aborted",
      requirementDoc: "docs/design/req.md",
    });
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "" }, ctx as any);

    expect(result.success).toBe(true);
    expect(result.message).toContain("restarted");
    expect(updatedMeta).not.toBeNull();
    expect(updatedMeta.requirementDoc).toBe("docs/design/req.md");
  });

  // Medium fix #3: aborted restart + empty requirementDoc + new file → uses new file
  it("aborted restart + empty requirementDoc + file provided → adopts new file (no silent discard)", async () => {
    await fs.writeFile(docPath, "new content", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      flowState: "aborted",
      // requirementDoc intentionally omitted (undefined)
    });
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(true);
    expect(result.message).toContain("restarted");
    expect(updatedMeta).not.toBeNull();
    // The new file must be adopted (not silently discarded)
    expect(updatedMeta.requirementDoc).toBe("req.md");
  });

  // Medium fix #4: buildRestartMeta DRY — both restart paths produce identical structure
  it("aborted restart (both paths) produces consistent SessionMeta structure", async () => {
    await fs.writeFile(docPath, "content", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP, maxLoops: 5, maxLoopCycles: 7 });

    // Path 1: no-file restart (requirementDoc from meta)
    const meta1 = makeTestMeta({
      flowState: "aborted",
      requirementDoc: "existing.md",
    });
    let updatedMeta1: any = null;
    const ctx1 = {
      session: {
        getMeta: () => meta1,
        updateMeta: (m: any) => { updatedMeta1 = m; },
      },
    };
    const cmd1 = createPipelineStartCommand(config);
    const r1: any = await cmd1.execute({ file: "" }, ctx1 as any);

    // Path 2: with-file restart (requirementDoc from file, overrides empty meta)
    const meta2 = makeTestMeta({
      flowState: "aborted",
      // no requirementDoc
    });
    let updatedMeta2: any = null;
    const ctx2 = {
      session: {
        getMeta: () => meta2,
        updateMeta: (m: any) => { updatedMeta2 = m; },
      },
    };
    const cmd2 = createPipelineStartCommand(config);
    const r2: any = await cmd2.execute({ file: "req.md" }, ctx2 as any);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // Both paths must produce the same structural fields (except pipelineId, stageStartTime, requirementDoc)
    for (const m of [updatedMeta1, updatedMeta2]) {
      expect(m.currentStage).toBe("clarify");
      expect(m.flowState).toBe("running");
      expect(m.loopCount).toBe(0);
      expect(m.currentStepIndex).toBe(0);
      expect(m.verifyAttempts).toBe(0);
      expect(m.verifyFailures).toEqual([]);
      expect(m.blockedReason).toBeUndefined();
      expect(m.terminated).toBeUndefined();
      expect(m.terminateReason).toBeUndefined();
      expect(m.maxLoops).toBe(5);
      expect(m.maxLoopCycles).toBe(7);
      expect(m.pipelineId).toMatch(/^pipe-/);
    }
    expect(updatedMeta1.requirementDoc).toBe("existing.md");
    expect(updatedMeta2.requirementDoc).toBe("req.md");
  });

  // Phase 5 (Bug 5): fresh start without doc_file is rejected
  it("no file → returns error with /pipeline-start <doc_file> hint (no state machine initialized)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "" }, ctx);

    // Phase 5: no file → rejection, meta NOT initialized
    expect(result.success).toBe(false);
    expect(result.error).toContain("/pipeline-start");
    expect(result.error).toContain("run /pipeline-start <doc_file>");
    expect(updatedMeta).toBeNull();
  });

  it("returns error when pipeline already running", async () => {
    await fs.writeFile(docPath, "content", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("already running");
  });

  it("allows restart when pipeline is aborted", async () => {
    await fs.writeFile(docPath, "content", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      flowState: "aborted",
      requirementDoc: "old-req.md",
    });
    const ctx = createMockCtx(meta);

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(true);
    expect(result.message).toContain("restarted");
  });

  // Regression: aborted restart resets verifyAttempts/verifyFailures/terminated (Medium #9)
  it("aborted restart resets verifyAttempts, verifyFailures, terminated, terminateReason", async () => {
    await fs.writeFile(docPath, "content", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      flowState: "aborted",
      terminated: true,
      terminateReason: "user_abort",
      verifyAttempts: 5,
      verifyFailures: [{ ruleType: "test", detail: "fail", timestamp: 0 }],
      blockedReason: "verify_attempt_overflow",
    });
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(true);
    expect(updatedMeta).not.toBeNull();
    expect(updatedMeta.flowState).toBe("running");
    expect(updatedMeta.verifyAttempts).toBe(0);
    expect(updatedMeta.verifyFailures).toEqual([]);
    expect(updatedMeta.terminated).toBeUndefined();
    expect(updatedMeta.terminateReason).toBeUndefined();
    expect(updatedMeta.blockedReason).toBeUndefined();
  });

  it("rejects when pipeline is blocked with shortcut key hint", async () => {
    await fs.writeFile(docPath, "content", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP, decisionShortcutKey: "alt+f" });
    const meta = makeTestMeta({ flowState: "blocked" });
    const ctx = createMockCtx(meta);

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("alt+f");
    expect(result.error).toContain("decision menu");
  });

  it("handles empty file content", async () => {
    await fs.writeFile(docPath, "", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx);

    expect(result.success).toBe(true);
    expect(result.requirementContent).toBe("");
    expect(updatedMeta.requirementDoc).toBe("req.md");
  });

  it("returns error when verify.md is missing for stages with verify.require", async () => {
    await fs.writeFile(docPath, "content", "utf-8");
    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify:
                s === "develop" || s === "review"
                  ? { require: true }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: () => {},
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("verify.md missing");
    expect(result.missingStages).toContain("develop");
    expect(result.missingStages).toContain("review");
    expect(result.suggestion).toContain("/pipeline-init 1");
  });

  it("starts normally when all verify.md files exist", async () => {
    await fs.writeFile(docPath, "content", "utf-8");

    // Create verify.md files for stages that require them
    const developVerifyDir = path.join(TMP, ".pi", "references", "develop_spec");
    await fs.mkdir(developVerifyDir, { recursive: true });
    await fs.writeFile(path.join(developVerifyDir, "verify.md"), "---\nrules:\n  keywords: []\n---\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify: s === "develop" ? { require: true } : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    let updatedMeta: any = null;
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { updatedMeta = m; },
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx);

    expect(result.success).toBe(true);
    expect(updatedMeta).not.toBeNull();
  });

  it("writes pipeline_start_error to audit when file is missing", async () => {
    // Set up audit log to a temp directory
    const auditDir = path.join(TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: () => {},
      },
    };

    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "nonexistent.md" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("File not found");

    // Read the audit log and verify
    const logFile = path.join(auditDir, getDateAuditFileName());
    const logContent = await fs.readFile(logFile, "utf-8");

    expect(logContent).toContain("pipeline_start_error");
    expect(logContent).toContain("[ERROR]");
    expect(logContent).toContain("nonexistent.md");

    // Clean up audit state
    __resetAuditDirPath();
  });

  // ─── Phase 0: TUI status bar sync on pipeline-start ──────────────────────────
  describe("TUI status bar sync (Phase 0)", () => {
    it("with-file branch → writes 'Pipeline → clarify' to status bar, no notify", async () => {
      await fs.writeFile(docPath, "# Req\nDo X", "utf-8");
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
      const ctx = createMockCtx(meta);

      const cmd = createPipelineStartCommand(config);
      const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

      expect(result.success).toBe(true);
      // Status bar must contain the pipeline stage
      expect(ctx.statusCalls).toEqual(
        expect.arrayContaining([{ key: "pipeline-stage", text: "Pipeline → clarify" }])
      );
      // setStage uses setStatus only (no notify); ensure notifications don't echo the bar text
      expect(ctx.notifications.some(n => n === "Pipeline → clarify")).toBe(false);
    });

    // Phase 5 (Bug 5): no-file fresh start is rejected — status bar NOT written
    it("no-file fresh start → rejected with /pipeline-start hint, status bar unchanged", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
      const ctx = createMockCtx(meta);

      const cmd = createPipelineStartCommand(config);
      const result: any = await cmd.execute({ file: "" }, ctx as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain("/pipeline-start");
      expect(result.error).toContain("run /pipeline-start <doc_file>");
      // Status bar must remain untouched (no pipeline init)
      expect(ctx.statusCalls).toEqual([]);
    });

    it("aborted restart branch → writes 'Pipeline → clarify' to status bar", async () => {
      await fs.writeFile(docPath, "content", "utf-8");
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ flowState: "aborted" });
      const ctx = createMockCtx(meta);

      const cmd = createPipelineStartCommand(config);
      const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

      expect(result.success).toBe(true);
      expect(result.message).toContain("restarted");
      expect(ctx.statusCalls).toEqual(
        expect.arrayContaining([{ key: "pipeline-stage", text: "Pipeline → clarify" }])
      );
    });

    it("already-running branch → does NOT write status bar (stage unchanged)", async () => {
      await fs.writeFile(docPath, "content", "utf-8");
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);

      const cmd = createPipelineStartCommand(config);
      const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain("already running");
      // Status bar must remain untouched
      expect(ctx.statusCalls).toEqual([]);
    });
  });
});
