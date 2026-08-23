import { describe, it, expect } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipelineQuitCommand } from "../../commands/pipeline-quit";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";

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

  it("returns error when meta has no pipelineId (not started) — no audit", async () => {
    const TMP = join(tmpdir(), "pi-quit-nometa-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const cmd = createPipelineQuitCommand(config);
    const ctx = createCtx({});
    const result = (await (cmd.execute as any)({}, ctx)) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBe("No active pipeline");

    // Verify no audit written: file should not exist (initAuditLog creates dir only)
    let auditExists = true;
    try {
      await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    } catch {
      auditExists = false;
    }
    expect(auditExists).toBe(false);
    // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
  });

  it("exits a running pipeline and sets flowState=aborted + terminateReason=user_quit", async () => {
    const TMP = join(tmpdir(), "pi-quit-running-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-quit-001",
      flowState: "running",
      sessionAllowedCommands: ["rm -rf"],
      verifyAttempts: 2,
      verifyFailures: [{ ruleType: "test", detail: "failed", timestamp: Date.now() }],
      sessionAllowedWritePaths: ["src/foo.ts"],
    });
    const ctx = createCtx(meta);
    const cmd = createPipelineQuitCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.success).toBe(true);
    expect(result.message).toContain("develop");
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("user_quit");
    // Temp state cleared
    expect(meta.sessionAllowedCommands).toEqual([]);
    expect(meta.verifyAttempts).toBe(0);
    expect(meta.verifyFailures).toEqual([]);
    expect(meta.sessionAllowedWritePaths).toEqual([]);
    // Preserved
    expect(meta.pipelineId).toBe("pipe-quit-001");
    expect(meta.currentStage).toBe("develop");

    // Audit verification: pipeline_quit event with stage=develop
    const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("pipeline_quit");
    expect(logContent).toContain("stage=develop");
    expect(logContent).toContain("pipelineId=pipe-quit-001");
    // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
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
    const TMP = join(tmpdir(), "pi-quit-idempotent-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      flowState: "aborted",
      terminateReason: "user_quit",
    });
    const ctx = createCtx(meta);
    const cmd = createPipelineQuitCommand(config);
    const result = (await (cmd.execute as any)({}, ctx)) as any;

    expect(result.success).toBe(true);
    expect(result.message).toBe("Pipeline already exited");
    // No updateMeta call
    expect(ctx._updates.length).toBe(0);

    // Verify no repeat audit: file should not exist (initAuditLog creates dir only)
    let auditExists = true;
    try {
      await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    } catch {
      auditExists = false;
    }
    expect(auditExists).toBe(false);
    // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
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
