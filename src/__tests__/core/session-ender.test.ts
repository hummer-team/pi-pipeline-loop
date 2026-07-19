import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createSessionEnder } from "../../core/session-ender";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "pi-pipeline-session-ender-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
});

describe("createSessionEnder", () => {
  it("creates a hook with event 'session_end'", () => {
    const hook = createSessionEnder(makeTestConfig());
    expect(hook.event).toBe("session_end");
    expect(typeof hook.handler).toBe("function");
  });

  it("writes audit log with session_end action and finalStage", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "completed" });
    const ctx = createMockCtx(meta);

    const hook = createSessionEnder(config);
    await hook.handler(ctx as any);

    const logPath = join(TMP, ".pi", "audit", "audit.log");
    const content = await readFile(logPath, "utf-8");
    const entry = JSON.parse(content.trim().split("\n").pop()!);

    expect(entry.action).toBe("session_end");
    expect(entry.pipelineId).toBe("pipe-test-001");
    expect(entry.finalStage).toBe("completed");
    expect(entry.timestamp).toBeDefined();
  });

  it("writes audit log for arbitrary stage", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "fix" });
    const ctx = createMockCtx(meta);

    const hook = createSessionEnder(config);
    await hook.handler(ctx as any);

    const logPath = join(TMP, ".pi", "audit", "audit.log");
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);

    expect(entry.action).toBe("session_end");
    expect(entry.finalStage).toBe("fix");
  });
});
