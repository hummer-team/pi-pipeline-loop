import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createSessionEnder } from "../../core/session-ender";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";

const TMP = join(tmpdir(), "pi-pipeline-session-ender-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
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

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const line = lines.find((l: string) => l.includes("session_end"))!;

    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(line).toContain(" - session_end");
    expect(line).toContain("pipelineId=pipe-test-001");
    expect(line).toContain("finalStage=completed");
  });

  it("writes audit log for arbitrary stage", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "fix" });
    const ctx = createMockCtx(meta);

    const hook = createSessionEnder(config);
    await hook.handler(ctx as any);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const line = lines[lines.length - 1];

    expect(line).toContain(" - session_end");
    expect(line).toContain("finalStage=fix");
  });
});
