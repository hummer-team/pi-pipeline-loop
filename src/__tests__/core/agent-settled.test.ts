import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";

const TMP = join(tmpdir(), "pi-pipeline-agent-settled-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

describe("createAgentSettled", () => {
  it("creates a hook with event 'agent_settled'", () => {
    const hook = createAgentSettled(makeTestConfig());
    expect(hook.event).toBe("agent_settled");
  });

  it("writes audit log with agent_settled action", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "design" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim().split("\n")[0];

    expect(line).toContain(" - agent_settled");
    expect(line).toContain("pipelineId=pipe-test-001");
    expect(line).toContain("stage=design");
  });

  it("notifies ui when notify is available", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    expect(ctx.notifications).toContain('Agent settled in "review" stage');
  });

  it("does not throw when ui.notify is absent", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    delete (ctx as any).ui;

    const hook = createAgentSettled(config);
    await expect(hook.handler(ctx as any)).resolves.toBeUndefined();
  });
});
