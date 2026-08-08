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

    expect(line).toContain(" - session_shutdown");
    expect(line).toContain("pipelineId=pipe-test-001");
    expect(line).toContain("finalStage=review");
  });
});
