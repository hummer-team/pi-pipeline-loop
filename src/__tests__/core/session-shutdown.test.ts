import { describe, it, expect, beforeAll } from "bun:test";
import { createSessionShutdown } from "../../core/session-shutdown";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";

const TMP = join(tmpdir(), "pi-pipeline-shutdown-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

describe("createSessionShutdown", () => {
  it("creates a hook with event 'session_shutdown'", () => {
    const hook = createSessionShutdown(makeTestConfig());
    expect(hook.event).toBe("session_shutdown");
    expect(typeof hook.handler).toBe("function");
  });

  it("writes audit log with session_shutdown action and finalStage", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta);

    const hook = createSessionShutdown(config);
    await hook.handler(ctx as any);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim().split("\n").find((l: string) => l.includes("session_shutdown"))!;

    expect(line).toContain(" - [INFO] session_shutdown");
    expect(line).toContain("pipelineId=pipe-test-001");
    expect(line).toContain("finalStage=review");
  });

  // Migrated from session-ender.test.ts — Case A: handler is function type
  it("creates a hook whose handler is a function", () => {
    const hook = createSessionShutdown(makeTestConfig());
    expect(typeof hook.handler).toBe("function");
  });

  // Migrated from session-ender.test.ts — Case B: finalStage=completed, timestamp + pipelineId
  it("writes audit log with finalStage=completed and correct format", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "completed" });
    const ctx = createMockCtx(meta);

    const hook = createSessionShutdown(config);
    await hook.handler(ctx as any);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const line = lines.find((l: string) => l.includes("completed"))!;

    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(line).toContain(" - [INFO] session_shutdown");
    expect(line).toContain("pipelineId=pipe-test-001");
    expect(line).toContain("finalStage=completed");
  });

  // Migrated from session-ender.test.ts — Case C: finalStage=fix, verify last line
  it("writes audit log with finalStage=fix on last line", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "fix" });
    const ctx = createMockCtx(meta);

    const hook = createSessionShutdown(config);
    await hook.handler(ctx as any);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = lines[lines.length - 1];

    expect(lastLine).toContain(" - [INFO] session_shutdown");
    expect(lastLine).toContain("finalStage=fix");
  });

  describe("flowState reset on shutdown", () => {
    it("resets flowState to aborted when reason is 'quit'", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "running",
        pipelineId: "pipe-quit-test",
      });
      const ctx = {
        ...createMockCtx(meta),
        event: { reason: "quit" },
      };

      const hook = createSessionShutdown(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("aborted");
      expect(meta.terminateReason).toBe("session_quit");

      // Verify audit log
      const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
      const content = await readFile(logPath, "utf-8");
      expect(content).toContain("pipeline_session_aborted");
      expect(content).toContain("reason=session_quit");
    });

    it("resets flowState to aborted when reason is 'new'", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "running",
        pipelineId: "pipe-new-test",
      });
      const ctx = {
        ...createMockCtx(meta),
        event: { reason: "new" },
      };

      const hook = createSessionShutdown(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("aborted");
      expect(meta.terminateReason).toBe("session_quit");
    });

    it("does NOT reset flowState when reason is 'resume'", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "running",
      });
      const ctx = {
        ...createMockCtx(meta),
        event: { reason: "resume" },
      };

      const hook = createSessionShutdown(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("running");
    });

    it("does NOT reset flowState when reason is 'fork'", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "running",
      });
      const ctx = {
        ...createMockCtx(meta),
        event: { reason: "fork" },
      };

      const hook = createSessionShutdown(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("running");
    });

    it("does NOT reset flowState when reason is 'reload'", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "running",
      });
      const ctx = {
        ...createMockCtx(meta),
        event: { reason: "reload" },
      };

      const hook = createSessionShutdown(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("running");
    });

    it("does NOT reset flowState when reason is missing (backward compat)", async () => {
      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "running",
      });
      const ctx = createMockCtx(meta);
      // No event field — backward compatible

      const hook = createSessionShutdown(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("running");
    });
  });
});
