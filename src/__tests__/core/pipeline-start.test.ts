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

  // Phase 5 (Bug 5) → Phase 142: aborted restart with non-empty requirementDoc now resumes
  it("aborted restart + requirementDoc preserved + no file → resume preserves stage position", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      flowState: "aborted",
      requirementDoc: "docs/design/req.md",
    });
    const originalPipelineId = meta.pipelineId;
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
    // Phase 142: resume semantics (not restart) — stage position preserved
    expect(result.message).toContain("resumed");
    expect(updatedMeta).not.toBeNull();
    expect(updatedMeta.currentStage).toBe("develop"); // preserved from meta
    expect(updatedMeta.pipelineId).toBe(originalPipelineId); // pipelineId preserved
    expect(updatedMeta.requirementDoc).toBe("docs/design/req.md"); // requirementDoc preserved
    expect(updatedMeta.flowState).toBe("running");
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

  // Medium fix #4 → Phase 142: DRY — both restart paths split into resume (path1) and new (path2)
  it("aborted restart (both paths): path1 resumes stage position, path2 opens new pipeline", async () => {
    await fs.writeFile(docPath, "content", "utf-8");
    const config = makeTestConfig({ projectRoot: TMP, maxLoops: 5, maxLoopCycles: 7 });

    // Path 1: no-file restart (requirementDoc from meta) → resume (currentStage preserved)
    const meta1 = makeTestMeta({
      flowState: "aborted",
      requirementDoc: "existing.md",
    });
    const originalPipelineId1 = meta1.pipelineId;
    let updatedMeta1: any = null;
    const ctx1 = {
      session: {
        getMeta: () => meta1,
        updateMeta: (m: any) => { updatedMeta1 = m; },
      },
    };
    const cmd1 = createPipelineStartCommand(config);
    const r1: any = await cmd1.execute({ file: "" }, ctx1 as any);

    // Path 2: with-file restart (requirementDoc from file, overrides empty meta) → open new
    const meta2 = makeTestMeta({
      flowState: "aborted",
      // no requirementDoc
    });
    const originalPipelineId2 = meta2.pipelineId;
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

    // Path 1: resume — stage position preserved, pipelineId preserved
    expect(r1.message).toContain("resumed");
    expect(updatedMeta1.currentStage).toBe("develop"); // preserved from meta
    expect(updatedMeta1.pipelineId).toBe(originalPipelineId1); // preserved
    expect(updatedMeta1.requirementDoc).toBe("existing.md");
    expect(updatedMeta1.flowState).toBe("running");

    // Path 2: open new — currentStage=clarify, new pipelineId
    expect(r2.message).toContain("restarted");
    expect(updatedMeta2.currentStage).toBe("clarify");
    expect(updatedMeta2.pipelineId).not.toBe(originalPipelineId2); // new pipelineId
    expect(updatedMeta2.requirementDoc).toBe("req.md");
    expect(updatedMeta2.flowState).toBe("running");

    // Shared structural fields for both paths
    for (const m of [updatedMeta1, updatedMeta2]) {
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
    it("with-file branch → writes unified format status bar, no notify", async () => {
      await fs.writeFile(docPath, "# Req\nDo X", "utf-8");
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
      const ctx = createMockCtx(meta);

      const cmd = createPipelineStartCommand(config);
      const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

      expect(result.success).toBe(true);
      // Status bar must use unified format: [ {pipelineId} • clarify -> plan ]
      // pipelineId is dynamically generated, so match with regex
      const grayOpen = "\x1b[90m";
      const grayClose = "\x1b[0m";
      const statusText = ctx.statusCalls.find(c => c.key === "pipeline-stage")?.text;
      expect(statusText).toMatch(new RegExp(`^\\[ pipe-.+ • clarify ${grayOpen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-> plan${grayClose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\]$`));
      // setStage uses setStatus only (no notify); ensure notifications don't echo the bar text
      expect(ctx.notifications.some(n => n.includes("clarify"))).toBe(false);
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

    it("aborted restart branch → writes unified format status bar", async () => {
      await fs.writeFile(docPath, "content", "utf-8");
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ flowState: "aborted" });
      const ctx = createMockCtx(meta);

      const cmd = createPipelineStartCommand(config);
      const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

      expect(result.success).toBe(true);
      expect(result.message).toContain("restarted");
      // Status bar uses unified format with dynamic pipelineId
      const grayOpen = "\x1b[90m";
      const grayClose = "\x1b[0m";
      const statusText = ctx.statusCalls.find(c => c.key === "pipeline-stage")?.text;
      expect(statusText).toMatch(new RegExp(`^\\[ pipe-.+ • clarify ${grayOpen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-> plan${grayClose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\]$`));
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

  // ─── Phase 1 (140): agentPath validation on pipeline-start ────────────────────
  describe("agentPath validation (Phase 1)", () => {
    it("missing agentPath for active stages → returns error and does not initialize meta", async () => {
      await fs.writeFile(docPath, "content", "utf-8");
      const config = makeTestConfig({
        projectRoot: TMP,
        stages: Object.fromEntries(
          ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
            (s, i, a) => [
              s,
              {
                // plan and fix have no agentPath
                agentPath: s === "plan" || s === "fix" ? undefined : "a.md",
                skillPath: "s.md",
                nextStage: a[i + 1] ?? null,
                requireDomain: false,
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

      expect(result.success).toBe(false);
      expect(result.error).toContain("missing agentPath");
      expect(result.error).toContain("plan");
      expect(result.error).toContain("fix");
      expect(result.error).toContain(".pi/agents/develop-agent.md");
      // Meta must NOT be initialized
      expect(updatedMeta).toBeNull();
    });

    it("all active stages have agentPath → start proceeds normally", async () => {
      await fs.writeFile(docPath, "# Req\nDo X", "utf-8");
      const config = makeTestConfig({ projectRoot: TMP });
      // makeTestConfig sets agentPath for all stages via helpers.ts
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
      expect(updatedMeta.currentStage).toBe("clarify");
    });

    it("missing agentPath also blocks aborted restart", async () => {
      const config = makeTestConfig({
        projectRoot: TMP,
        stages: Object.fromEntries(
          ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
            (s, i, a) => [
              s,
              {
                agentPath: s === "develop" ? undefined : "a.md",
                skillPath: "s.md",
                nextStage: a[i + 1] ?? null,
                requireDomain: false,
              },
            ],
          ),
        ) as any,
      });
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

      expect(result.success).toBe(false);
      expect(result.error).toContain("missing agentPath");
      expect(result.error).toContain("develop");
      expect(updatedMeta).toBeNull();
    });

    it("disabled stage (require: false) with missing agentPath → start proceeds normally", async () => {
      await fs.writeFile(docPath, "# Req\nDo X", "utf-8");
      // Simulate a disabled stage (like json-config-loader does for require: false)
      const config = makeTestConfig({
        projectRoot: TMP,
        stages: Object.fromEntries(
          ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
            (s, i, a) => [
              s,
              {
                // review is disabled: no agentPath, but disabled: true
                agentPath: s === "review" ? undefined : "a.md",
                skillPath: "s.md",
                nextStage: a[i + 1] ?? null,
                requireDomain: false,
                disabled: s === "review" ? true : undefined,
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

      // Should succeed because disabled stage is skipped in validation
      expect(result.success).toBe(true);
      expect(updatedMeta).not.toBeNull();
      expect(updatedMeta.currentStage).toBe("clarify");
    });
  });

  // ─── Phase 142: Resume / New decision matrix ──────────────────────────────────
  describe("resume/new decision matrix (Phase 142)", () => {
    // Case 1: aborted + plan + file empty + requirementDoc → resume to plan
    it("aborted + plan + no file + requirementDoc → resumes to plan", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "plan",
        previousStage: "clarify",
        flowState: "aborted",
        requirementDoc: "docs/design/req.md",
      });
      const originalPipelineId = meta.pipelineId;
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
      expect(result.message).toContain("resumed");
      expect(result.currentStage).toBe("plan");
      expect(updatedMeta).not.toBeNull();
      expect(updatedMeta.currentStage).toBe("plan");
      expect(updatedMeta.flowState).toBe("running");
      expect(updatedMeta.pipelineId).toBe(originalPipelineId);
      expect(updatedMeta.requirementDoc).toBe("docs/design/req.md");
    });

    // Case 2: aborted + plan + file===requirementDoc → resume to plan
    it("aborted + plan + file === requirementDoc → resumes to plan", async () => {
      await fs.writeFile(docPath, "content", "utf-8");
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "plan",
        previousStage: "clarify",
        flowState: "aborted",
        requirementDoc: "req.md",
      });
      const originalPipelineId = meta.pipelineId;
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
      expect(result.message).toContain("resumed");
      expect(result.currentStage).toBe("plan");
      expect(updatedMeta.currentStage).toBe("plan");
      expect(updatedMeta.pipelineId).toBe(originalPipelineId);
    });

    // Case 3: aborted + plan + file!==requirementDoc → open new clarify
    it("aborted + plan + file !== requirementDoc → opens new pipeline at clarify", async () => {
      await fs.writeFile(docPath, "content", "utf-8");
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "aborted",
        requirementDoc: "old-doc.md",
      });
      const originalPipelineId = meta.pipelineId;
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
      expect(result.currentStage).toBe("clarify");
      expect(updatedMeta.currentStage).toBe("clarify");
      expect(updatedMeta.pipelineId).not.toBe(originalPipelineId);
      // When meta has existing requirementDoc, buildRestartMeta preserves it (meta.requirementDoc || file)
      expect(updatedMeta.requirementDoc).toBe("old-doc.md");
    });

    // Case 4: aborted + completed → error, no updateMeta
    it("aborted + completed → returns error, does NOT call updateMeta", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "completed",
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

      expect(result.success).toBe(false);
      expect(result.error).toContain("completed");
      expect(updatedMeta).toBeNull();
    });

    // Case 5: aborted + awaiting_human → error with decision menu hint
    it("aborted + awaiting_human → returns error with decision menu hint", async () => {
      const config = makeTestConfig({ projectRoot: TMP, decisionShortcutKey: "ctrl+x" });
      const meta = makeTestMeta({
        currentStage: "awaiting_human",
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

      expect(result.success).toBe(false);
      expect(result.error).toContain("awaiting_human");
      expect(result.error).toContain("decision menu");
      expect(result.error).toContain("ctrl+x");
      expect(updatedMeta).toBeNull();
    });

    // Case 6: aborted + no requirementDoc + file empty → error with /pipeline-start hint
    it("aborted + no requirementDoc + no file → returns error with /pipeline-start hint", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "aborted",
        // no requirementDoc
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
      expect(updatedMeta).toBeNull();
    });

    // Case 7: Field rebuild — resume to plan rebuilds stage chain fields, clears counters
    it("resume rebuilds stage chain fields and clears transient state", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "plan",
        previousStage: "clarify",
        flowState: "aborted",
        requirementDoc: "docs/design/req.md",
        contextFiles: { clarify: ["/tmp/ctx1.md"] },
        summaries: { clarify: { path: "/tmp/s.md", hash: "abc", status: "valid" } },
        verifyAttempts: 5,
        verifyFailures: [{ ruleType: "test", detail: "fail", timestamp: 0 }],
        violations: [{ type: "write_protected", detail: "blocked", timestamp: 0 }],
        loopCount: 3,
        loopCycleCount: 2,
        advancedThisTurn: true,
        verifyConfigError: true,
        blockedReason: "verify_overflow",
        terminated: true,
        terminateReason: "user_abort",
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
      expect(updatedMeta).not.toBeNull();

      // Preserved fields
      expect(updatedMeta.currentStage).toBe("plan");
      expect(updatedMeta.requirementDoc).toBe("docs/design/req.md");
      expect(updatedMeta.contextFiles).toEqual({ clarify: ["/tmp/ctx1.md"] });
      expect(updatedMeta.summaries).toEqual({ clarify: { path: "/tmp/s.md", hash: "abc", status: "valid" } });

      // Rebuilt fields
      expect(updatedMeta.previousStage).toBe("clarify"); // clarify.nextStage === plan
      expect(updatedMeta.stageVisitOrder).toEqual(["clarify", "plan"]);

      // Cleared counters / transient state
      expect(updatedMeta.verifyAttempts).toBe(0);
      expect(updatedMeta.verifyFailures).toEqual([]);
      expect(updatedMeta.violations).toEqual([]);
      expect(updatedMeta.loopCount).toBe(0);
      expect(updatedMeta.currentStepIndex).toBe(0);
      expect(updatedMeta.advancedThisTurn).toBeUndefined();
      expect(updatedMeta.loopCycleCount).toBeUndefined();
      expect(updatedMeta.verifyConfigError).toBeUndefined();
      expect(updatedMeta.blockedReason).toBeUndefined();
      expect(updatedMeta.terminated).toBeUndefined();
      expect(updatedMeta.terminateReason).toBeUndefined();
      expect(updatedMeta.flowState).toBe("running");
    });

    // Case 8: Audit — resume produces pipeline_start (mode=resume) + pipeline_resumed events
    it("resume writes pipeline_start (mode=resume) and pipeline_resumed audit events", async () => {
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "aborted",
        requirementDoc: "docs/design/req.md",
      });
      const ctx = {
        session: {
          getMeta: () => meta,
          updateMeta: () => {},
        },
      };

      const cmd = createPipelineStartCommand(config);
      const result: any = await cmd.execute({ file: "" }, ctx as any);
      expect(result.success).toBe(true);

      // Read audit log
      const logFile = path.join(auditDir, getDateAuditFileName());
      const logContent = await fs.readFile(logFile, "utf-8");

      // pipeline_start event with mode=resume (audit format: pipe-separated key=value)
      expect(logContent).toContain("pipeline_start");
      expect(logContent).toContain("mode=resume");

      // pipeline_resumed event with fromStage/toStage/requirementDoc
      expect(logContent).toContain("pipeline_resumed");
      expect(logContent).toContain("fromStage=plan");
      expect(logContent).toContain("toStage=plan");
      expect(logContent).toContain("docs/design/req.md");

      // Clean up audit state
      __resetAuditDirPath();
    });

    // Case 9: TUI — resume branch writes unified format status bar with resumed stage
    it("resume branch → writes unified format status bar with resumed stage", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "aborted",
        requirementDoc: "docs/design/req.md",
      });
      const ctx = createMockCtx(meta);

      const cmd = createPipelineStartCommand(config);
      const result: any = await cmd.execute({ file: "" }, ctx as any);

      expect(result.success).toBe(true);
      expect(result.message).toContain("resumed");

      // Status bar must reflect resumed stage: plan -> develop
      const grayOpen = "\x1b[90m";
      const grayClose = "\x1b[0m";
      const statusText = ctx.statusCalls.find(c => c.key === "pipeline-stage")?.text;
      expect(statusText).toMatch(new RegExp(`^\\[ pipe-.+ • plan ${grayOpen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-> develop${grayClose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\]$`));
    });
  });
});
