import { describe, it, expect } from "bun:test";
import { createPipelineQuitCommand } from "../../commands/pipeline-quit";
import { makeTestConfig, makeTestMeta } from "../helpers";

function createCtx(meta: any) {
  const updates: any[] = [];
  const statusCalls: { key: string; text: string | undefined }[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: any) => {
        const merged = { ...meta, ...patch };
        updates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
    },
    ui: {
      notify: (_msg: string) => {},
      setStatus: (key: string, text: string | undefined) => {
        statusCalls.push({ key, text });
      },
    },
    _updates: updates,
    _statusCalls: statusCalls,
  };
}

describe("createPipelineQuitCommand", () => {
  it("creates a command named 'pipeline-quit'", () => {
    const cmd = createPipelineQuitCommand(makeTestConfig());
    expect(cmd.name).toBe("pipeline-quit");
  });

  it("returns error when no session context", async () => {
    const cmd = createPipelineQuitCommand(makeTestConfig());
    const result = (await cmd.execute({}, undefined)) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBe("No active pipeline");
  });

  it("returns error when meta has no pipelineId (not started)", async () => {
    const cmd = createPipelineQuitCommand(makeTestConfig());
    const ctx = createCtx({});
    const result = (await (cmd.execute as any)({}, ctx)) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBe("No active pipeline");
  });

  it("exits a running pipeline and sets flowState=aborted + terminateReason=user_quit", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-quit-001",
      flowState: "running",
      tempAllowedBash: ["rm -rf"],
      verifyAttempts: 2,
      verifyFailures: [{ ruleType: "test", detail: "failed", timestamp: Date.now() }],
      sessionAllowedWritePaths: ["src/foo.ts"],
    });
    const ctx = createCtx(meta);
    const cmd = createPipelineQuitCommand(makeTestConfig());
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.success).toBe(true);
    expect(result.message).toContain("develop");
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("user_quit");
    // Temp state cleared
    expect(meta.tempAllowedBash).toEqual([]);
    expect(meta.verifyAttempts).toBe(0);
    expect(meta.verifyFailures).toEqual([]);
    expect(meta.sessionAllowedWritePaths).toEqual([]);
    // Preserved
    expect(meta.pipelineId).toBe("pipe-quit-001");
    expect(meta.currentStage).toBe("develop");
  });

  it("exits a blocked pipeline", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "verify failed",
    });
    const ctx = createCtx(meta);
    const cmd = createPipelineQuitCommand(makeTestConfig());
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.success).toBe(true);
    expect(meta.flowState).toBe("aborted");
    expect(meta.blockedReason).toBeUndefined();
  });

  it("exits an awaiting_human pipeline", async () => {
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      flowState: "running",
    });
    const ctx = createCtx(meta);
    const cmd = createPipelineQuitCommand(makeTestConfig());
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.success).toBe(true);
    expect(meta.flowState).toBe("aborted");
  });

  it("idempotent: already aborted → success without re-audit", async () => {
    const meta = makeTestMeta({
      flowState: "aborted",
      terminateReason: "user_quit",
    });
    const ctx = createCtx(meta);
    const cmd = createPipelineQuitCommand(makeTestConfig());
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.success).toBe(true);
    expect(result.message).toBe("Pipeline already exited");
    // No updateMeta call
    expect(ctx._updates.length).toBe(0);
  });

  it("clears TUI stage status bar on quit", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = createCtx(meta);
    const config = makeTestConfig({ output: { pipelineStage: true } });
    const cmd = createPipelineQuitCommand(config);
    await (cmd.execute as any)({}, ctx);

    // createPipelineUI calls setStatus with undefined to clear
    const clearCall = ctx._statusCalls.find(
      (c: any) => c.key === "pipeline-stage" && c.text === undefined,
    );
    expect(clearCall).toBeDefined();
  });
});
