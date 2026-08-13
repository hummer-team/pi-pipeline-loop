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
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
});
