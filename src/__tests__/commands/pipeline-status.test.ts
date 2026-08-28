import { describe, it, expect } from "bun:test";
import { createPipelineStatusCommand } from "../../commands/pipeline-status";
import { makeTestConfig, makeTestMeta } from "../helpers";

function createCtx(meta: any) {
  return {
    session: { getMeta: () => meta },
  };
}

describe("createPipelineStatusCommand", () => {
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
});
