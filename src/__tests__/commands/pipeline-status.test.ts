import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPipelineStatusCommand } from "../../commands/pipeline-status";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createCtx(meta: any) {
  return {
    session: { getMeta: () => meta },
  };
}

describe("createPipelineStatusCommand", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = join(tmpdir(), "pi-status-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await mkdir(TMP, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it("creates a command named 'pipeline-status'", () => {
    const cmd = createPipelineStatusCommand(makeTestConfig());
    expect(cmd.name).toBe("pipeline-status");
  });

  it("returns error when no session context", async () => {
    const cmd = createPipelineStatusCommand(makeTestConfig());
    const result = await cmd.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("returns formatted pipeline status", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-status-001",
      loopCount: 2,
      currentStepIndex: 3,
      currentModel: { provider: "openai", modelId: "deepseek-v4" },
    });
    const ctx = createCtx(meta);

    const cmd = createPipelineStatusCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.success).toBe(true);
    expect(result.content).toContain("pipe-status-001");
    expect(result.content).toContain("develop");
    expect(result.content).toContain("deepseek-v4");
    expect(result.content).toContain("general@latest");
    expect(result.content).toContain("2/3");
    expect(result.content).toContain("Step: 3");
    expect(result.content).toContain(".pi/");
    expect(result.content).not.toContain("AGENTS.md");
    expect(result.content).toContain(".git/");
  });

  it("shows 'default' when no model configured", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const cmd = createPipelineStatusCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.content).toContain("Model: default");
  });

  it("shows 'Missing' when no summary exists for current stage", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ summaries: {} });
    const ctx = createCtx(meta);

    const cmd = createPipelineStatusCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.content).toContain("Summary Status: Missing");
  });

  it("shows summary path and status when summary exists", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      summaries: {
        develop: { path: "/tmp/dev.md", hash: "abc", status: "valid" as const },
      },
    });
    const ctx = createCtx(meta);

    const cmd = createPipelineStatusCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.content).toContain("Summary Status: valid");
    expect(result.content).toContain("/tmp/dev.md");
  });

  // ─── Phase 6 (170): Template drift regression tests ──

  it("shows Template drift line with 0 files when no .pi/ directory (no drift)", async () => {
    // Use a non-existent projectRoot → drift check returns empty → "0 file(s)"
    const config = makeTestConfig({ projectRoot: "/nonexistent/path/no-drift" });
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const cmd = createPipelineStatusCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.content).toContain("Template drift: 0 file(s)");
  });

  it("does not crash when drift check fails (fail-open)", async () => {
    const config = makeTestConfig({ projectRoot: "/invalid/root/xyz" });
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const cmd = createPipelineStatusCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    // Should still return success with drift line
    expect(result.success).toBe(true);
    expect(result.content).toContain("Template drift:");
  });

  it("lists drifted filenames when drift is detected", async () => {
    // Create a drifted deployed copy in the temp directory
    const deployedRefsDir = join(TMP, ".pi", "references");
    await mkdir(deployedRefsDir, { recursive: true });
    await writeFile(
      join(deployedRefsDir, "pipeline-stage-prompt.yml"),
      "# Deliberately drifted content\n",
      "utf-8",
    );

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const cmd = createPipelineStatusCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.success).toBe(true);
    // Drift line should contain non-zero count and the drifted asset name
    expect(result.content).toMatch(/Template drift: [1-9]\d* file\(s\)/);
    expect(result.content).toContain("pipeline-stage-prompt.yml");
  });
});
