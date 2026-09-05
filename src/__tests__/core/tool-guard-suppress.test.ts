import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";

/** Create an agent file with frontmatter name for resolveAgentMention */
async function writeAgentFile(projectRoot: string, agentPath: string, name: string): Promise<void> {
  const fullPath = join(projectRoot, agentPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, `---\nname: ${name}\n---\n# Agent\n`);
}

describe("Phase 4 (171): suppressDuplicateSpawn", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = join(tmpdir(), "pi-tg-suppress-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    await mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  it("default off: no suppression when suppressDuplicateSpawn is not set", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: { plan: { agentName: "feat-design-plan-agent", startedAt: Date.now() } },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Default: no suppression (guard.suppressDuplicateSpawn is undefined)
    expect(result).toBeUndefined();
  });

  it("enabled: blocks Agent call with matching subagent_type in clarify stage for owner", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    // Enable suppression for clarify stage
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      guard: { suppressDuplicateSpawn: true },
    };
    // Create agent file so resolveAgentMention returns the expected name
    await writeAgentFile(TMP, config.stages["clarify"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "clarify",
      flowState: "running",
      activeSpawns: { clarify: { agentName: "feat-design-plan-agent", startedAt: Date.now() } },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    expect(result).toBeDefined();
    expect((result as any).block).toBe(true);
    expect((result as any).reason).toContain("already running");

    // Check spawn_suppressed audit
    const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("spawn_suppressed");
  });

  it("enabled: does NOT block when subagent_type does not match", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = {
      ...config.stages["plan"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: { plan: { agentName: "feat-design-plan-agent", startedAt: Date.now() } },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "different-agent" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Different subagent_type → no suppression
    expect(result).toBeUndefined();
  });

  it("enabled: does NOT block for non-owner (child) session", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = {
      ...config.stages["plan"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: { plan: { agentName: "feat-design-plan-agent", startedAt: Date.now() } },
    });
    // Child session: parentSession header present
    const ctx = createMockCtx(meta, {
      sessionHeader: { parentSession: "parent" },
      sessionName: "agent#aabb1122",
      sessionFile: "child-session",
    });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Child session → not blocked (user sovereignty)
    expect(result).toBeUndefined();
  });

  it("enabled: does NOT block for develop stage (only clarify/plan)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = {
      ...config.stages["develop"],
      guard: { suppressDuplicateSpawn: true },
    };

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      activeSpawns: { develop: { agentName: "develop-agent", startedAt: Date.now() } },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "develop-agent" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Develop stage → not blocked (legitimate task-invocation)
    expect(result).toBeUndefined();
  });

  it("enabled: does NOT block when no active spawn for current stage", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = {
      ...config.stages["plan"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      // No activeSpawns
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // No active spawn → not blocked
    expect(result).toBeUndefined();
  });

  it("enabled: stale activeSpawn (>30min) is treated as absent", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = {
      ...config.stages["plan"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: { plan: { agentName: "feat-design-plan-agent", startedAt: Date.now() - 31 * 60 * 1000 } },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Stale → treated as absent → not blocked
    expect(result).toBeUndefined();
  });

  it("suppression does NOT count as violation", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["clarify"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "clarify",
      flowState: "running",
      activeSpawns: { clarify: { agentName: "feat-design-plan-agent", startedAt: Date.now() } },
      violations: [],
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    await hook.handler(ctx as any);

    // Violations should NOT be incremented
    expect(meta.violations?.length ?? 0).toBe(0);
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
  });
});
