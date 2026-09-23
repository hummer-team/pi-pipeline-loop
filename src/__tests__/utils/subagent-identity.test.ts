import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  validateSubagentCreated,
  setOwnerSessionAccessor,
  __resetOwnerSessionAccessor,
} from "../../utils/subagent-identity";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { SessionMeta } from "../../types";

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
    // Reset module-level accessor before each test
    __resetOwnerSessionAccessor();
  });

  afterEach(() => {
    __resetOwnerSessionAccessor();
    __resetAuditDirPath();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("type matches expected agent → no-op (no stop emitted)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;
    const meta = makeTestMeta({ currentStage: "develop" });

    // Set up the module-level accessor (real access path — no fake pi.session)
    setOwnerSessionAccessor(() => meta);

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const pi = {
      events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
      ui: { notify: (_msg: string) => {} },
    };

    await validateSubagentCreated({ id: "agent-1", type: "develop-agent" }, config, pi);

    // No stop should be emitted (type matches)
    expect(emitted.filter(e => e.event === "subagents:rpc:stop")).toHaveLength(0);
  });

  it("type mismatch → stop emitted + notify (via module-level accessor)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;
    const meta = makeTestMeta({ currentStage: "develop" });

    // Set up the module-level accessor (real access path — no fake pi.session)
    setOwnerSessionAccessor(() => meta);

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const notifications: string[] = [];
    const pi = {
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

  it("accessor not set (cold start) → no-op (fail-safe)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;

    // Do NOT call setOwnerSessionAccessor — simulates cold start
    // No hook has fired yet, so the accessor is null.

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const pi = {
      events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
    };

    // Should not throw and should not emit stop
    await validateSubagentCreated({ id: "agent-1", type: "wrong-agent" }, config, pi);
    expect(emitted.filter(e => e.event === "subagents:rpc:stop")).toHaveLength(0);
  });

  it("accessor returns undefined meta → no-op (fail-safe)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;

    // Accessor returns undefined (no meta available yet)
    setOwnerSessionAccessor(() => undefined);

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const pi = {
      events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
    };

    await validateSubagentCreated({ id: "agent-1", type: "wrong-agent" }, config, pi);
    expect(emitted.filter(e => e.event === "subagents:rpc:stop")).toHaveLength(0);
  });

  it("pi handle is null → no-op (fail-safe)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await validateSubagentCreated({ id: "agent-1", type: "wrong-agent" }, config, null);
  });

  it("real SDK path: pi has no session property → accessor is the only meta source", async () => {
    // This test proves the fix: the pi SDK ExtensionAPI does NOT have a
    // `session` property. The module-level accessor (set by hook callbacks)
    // is the only way to read currentStage.
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;
    const meta = makeTestMeta({ currentStage: "develop" });

    // Set up accessor (as the factory does from hook ctx)
    setOwnerSessionAccessor(() => meta);

    // pi handle mimics the REAL SDK ExtensionAPI: has `events` but NO `session`
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const pi = {
      events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
      ui: { notify: (_msg: string) => {} },
      // NOTE: NO `session` property — this is the real SDK shape
    };

    await validateSubagentCreated({ id: "agent-1", type: "code-review-agent" }, config, pi);

    // Must still detect the mismatch and emit stop — proving the accessor works
    const stopEvents = emitted.filter(e => e.event === "subagents:rpc:stop");
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0].payload.agentId).toBe("agent-1");
  });

  it("accessor is dynamic: reflects latest meta across hook invocations", async () => {
    // Proves that the accessor reads fresh meta each time, not a stale snapshot.
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" } as any;
    config.stages["review"] = { ...config.stages["review"], agentPath: "agents/review-agent.md" } as any;

    // Shared mutable meta (simulates session.getMeta() returning fresh data)
    let currentMeta: SessionMeta = makeTestMeta({ currentStage: "develop" });
    setOwnerSessionAccessor(() => currentMeta);

    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const pi = {
      events: { emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }) },
      ui: { notify: (_msg: string) => {} },
    };

    // develop stage → expect develop-agent → mismatch with "review-agent" → stop
    await validateSubagentCreated({ id: "agent-1", type: "review-agent" }, config, pi);
    expect(emitted.filter(e => e.event === "subagents:rpc:stop")).toHaveLength(1);

    // Simulate stage advance (hook fires, accessor now returns updated meta)
    currentMeta = { ...currentMeta, currentStage: "review" };

    // review stage → expect review-agent → match with "review-agent" → no stop
    emitted.length = 0;
    await validateSubagentCreated({ id: "agent-2", type: "review-agent" }, config, pi);
    expect(emitted.filter(e => e.event === "subagents:rpc:stop")).toHaveLength(0);
  });
});
