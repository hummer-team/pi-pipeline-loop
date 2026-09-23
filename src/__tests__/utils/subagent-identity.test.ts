import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { validateSubagentCreated } from "../../utils/subagent-identity";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

describe("G4 (188): validateSubagentCreated", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(tmpdir(), "pi-g4-identity-" + Date.now());
    fs.mkdirSync(path.join(TMP, ".pi", "audit"), { recursive: true });
    // Create agent files for test stages
    const agentDir = path.join(TMP, "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "develop-agent.md"), "---\nname: develop-agent\n---\n# Dev Agent\n");
    fs.writeFileSync(path.join(agentDir, "review-agent.md"), "---\nname: review-agent\n---\n# Review Agent\n");
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
  });

  afterEach(() => {
    __resetAuditDirPath();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("type matches expected agent → no-op (no stop emitted)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;
    const meta = makeTestMeta({ currentStage: "develop" });

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const pi = {
      session: { getMeta: () => meta },
      events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
      ui: { notify: (_msg: string) => {} },
    };

    await validateSubagentCreated({ id: "agent-1", type: "develop-agent" }, config, pi);

    // No stop should be emitted (type matches)
    expect(emitted.filter(e => e.event === "subagents:rpc:stop")).toHaveLength(0);
  });

  it("type mismatch → stop emitted + notify", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;
    const meta = makeTestMeta({ currentStage: "develop" });

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const notifications: string[] = [];
    const pi = {
      session: { getMeta: () => meta },
      events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
      ui: { notify: (msg: string) => notifications.push(msg) },
    };

    await validateSubagentCreated({ id: "agent-1", type: "code-review-agent" }, config, pi);

    // Stop should be emitted
    const stopEvents = emitted.filter(e => e.event === "subagents:rpc:stop");
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0].payload.agentId).toBe("agent-1");

    // User should be notified
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("code-review-agent");
    expect(notifications[0]).toContain("develop-agent");

    // Audit should record the mismatch
    const logContent = fs.readFileSync(path.join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("subagent_identity_mismatch_blocked");
  });

  it("pi.events unavailable → no-op (fail-safe)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;
    const meta = makeTestMeta({ currentStage: "develop" });

    const pi = {
      session: { getMeta: () => meta },
      // No events
    };

    // Should not throw — just resolves
    await validateSubagentCreated({ id: "agent-1", type: "wrong-agent" }, config, pi);
  });

  it("currentStage unreadable → no-op (fail-safe)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;

    // Session returns undefined meta
    const pi = {
      session: { getMeta: () => undefined },
      events: { emit: () => {} },
    };

    // Should not throw
    await validateSubagentCreated({ id: "agent-1", type: "wrong-agent" }, config, pi);
  });

  it("pi is null → no-op (fail-safe)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await validateSubagentCreated({ id: "agent-1", type: "wrong-agent" }, config, null);
  });
});
