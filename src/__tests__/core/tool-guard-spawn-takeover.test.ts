import { describe, it, expect, beforeEach } from "bun:test";
import { createToolGuard, __resetReadOnlyIntersectionWarned } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog } from "../../utils/auditLog";
import type { PipelineStage } from "../../types";
import { auditLogFileFor } from "../helpers";

describe("createToolGuard", () => {
  beforeEach(() => {
    resetGitignoreCache();
  });

  // ─── Phase 4 / 177 (D7): plugin-owned spawn takeover ───────────────────────
  describe("Phase 4 / 177 (D7): plugin-owned spawn takeover", () => {
    async function makeTakeoverSetup(opts: {
      stage?: PipelineStage;
      takeoverStages?: PipelineStage[];
      isChild?: boolean;
    } = {}) {
      const TMP = join(tmpdir(), "pi-177-takeover-" + Date.now() + "-" + Math.random().toString(36).slice(2));
      await mkdir(join(TMP, "agents"), { recursive: true });
      await writeFile(
        join(TMP, "agents", "clarify-agent.md"),
        "---\nname: clarify-agent\n---\n# Clarify Agent\n",
      );
      const base = makeTestConfig({ projectRoot: TMP });
      const config = makeTestConfig({
        projectRoot: TMP,
        stages: {
          ...base.stages,
          clarify: { agentPath: "agents/clarify-agent.md", skillPath: "clarify/SKILL.md", nextStage: "plan", requireDomain: false },
          develop: { agentPath: "agents/clarify-agent.md", skillPath: "develop/SKILL.md", nextStage: "review", requireDomain: false },
        },
        ...(opts.takeoverStages ? { takeoverStages: opts.takeoverStages } : {}),
      } as any);
      const meta = makeTestMeta({ currentStage: opts.stage ?? "clarify" });
      const ctx = createMockCtx(meta, opts.isChild ? { sessionHeader: { parentSession: "/tmp/parent.jsonl" } } : undefined);
      ctx.toolCall = { name: "Agent", arguments: { subagent_type: "clarify-agent", prompt: "x" } };
      return { TMP, config, meta, ctx };
    }

    it("clarify (default on): owner + Agent + matching mention → block + reserved + pendingSpawns, no violation", async () => {
      const { TMP, config, meta, ctx } = await makeTakeoverSetup();
      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("Plugin-owned spawn");
      // Side effect ①: reserved evidence written before block
      expect(meta.activeSpawns?.clarify?.reserved).toBe(true);
      expect(meta.pendingSpawns?.clarify?.agentName).toBe("clarify-agent");
      // Side effect ②: not a violation
      expect((meta as any).violations ?? []).toHaveLength(0);

      await rm(TMP, { recursive: true, force: true });
    });

    it("non-takeover stage (develop default off) → not intercepted", async () => {
      const { TMP, config, ctx } = await makeTakeoverSetup({ stage: "develop" });
      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("takeoverStages override enabling develop → intercepted", async () => {
      const { TMP, config, meta, ctx } = await makeTakeoverSetup({
        stage: "develop",
        takeoverStages: ["clarify", "develop"],
      });
      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect(meta.pendingSpawns?.develop?.agentName).toBe("clarify-agent");
      await rm(TMP, { recursive: true, force: true });
    });

    it("non-Agent tool → not intercepted", async () => {
      const { TMP, config, ctx } = await makeTakeoverSetup();
      ctx.toolCall = { name: "read", arguments: {} };
      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("non-matching subagent_type → not intercepted", async () => {
      const { TMP, config, ctx } = await makeTakeoverSetup();
      ctx.toolCall = { name: "Agent", arguments: { subagent_type: "other-agent" } };
      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("child session → not intercepted (owner routes)", async () => {
      const { TMP, config, ctx } = await makeTakeoverSetup({ isChild: true });
      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });
  });
});

// ── Phase 0 (186): allowedReadOnlyPaths blocks writes ──────────────────────

describe("Phase 0 (186): allowedReadOnlyPaths blocks writes", () => {
  it("write/edit tool blocked by read-only path even when allowedWritePaths allows it", async () => {
    const TMP = join(tmpdir(), "pi-readonly-1-" + Date.now());
    await mkdir(TMP, { recursive: true });
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" }));

    // Create a plan doc that will be in read-only paths
    await mkdir(join(TMP, "docs", "design"), { recursive: true });
    await writeFile(join(TMP, "docs", "design", "186_plan.md"), "plan content");

    const config = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "review",
          requireDomain: false,
          // allowedWritePaths allows everything (**), but allowedReadOnlyPaths blocks plan docs
          allowedWritePaths: ["**"],
          allowedReadOnlyPaths: ["docs/design/*_plan*.md"],
        },
      },
    } as any);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    // Simulate write tool call targeting the read-only path
    ctx.toolCall = {
      name: "write",
      arguments: { path: join(TMP, "docs", "design", "186_plan.md"), content: "new content" },
    };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Should be blocked
    expect(result).toBeDefined();
    expect((result as any).reason).toContain("read-only");

    await rm(TMP, { recursive: true, force: true });
  });

  it("bash file target blocked by read-only path", async () => {
    const TMP = join(tmpdir(), "pi-readonly-2-" + Date.now());
    await mkdir(TMP, { recursive: true });
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" }));

    await mkdir(join(TMP, "docs", "design"), { recursive: true });
    await writeFile(join(TMP, "docs", "design", "186_plan.md"), "plan content");

    const config = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "review",
          requireDomain: false,
          allowedWritePaths: ["**"],
          allowedReadOnlyPaths: ["docs/design/*_plan*.md"],
        },
      },
    } as any);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    // Bash command that writes to a read-only path
    ctx.toolCall = {
      name: "bash",
      arguments: { command: `echo "overwrite" > ${join(TMP, "docs", "design", "186_plan.md")}` },
    };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Should be blocked
    expect(result).toBeDefined();
    expect((result as any).reason).toContain("read-only");

    await rm(TMP, { recursive: true, force: true });
  });

  it("intersection detection produces audit warning", async () => {
    __resetReadOnlyIntersectionWarned();
    const TMP = join(tmpdir(), "pi-readonly-3-" + Date.now());
    await mkdir(TMP, { recursive: true });
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" }));

    const config = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "review",
          requireDomain: false,
          // Overlap: both allowedWritePaths and allowedReadOnlyPaths include "docs/"
          allowedWritePaths: ["docs/"],
          allowedReadOnlyPaths: ["docs/"],
        },
      },
    } as any);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    // Use bash tool with a simple non-blocking command to trigger the handler
    ctx.toolCall = { name: "bash", arguments: { command: "echo hello" } };

    const hook = createToolGuard(config);
    await hook.handler(ctx as any);

    // Should have audit warning (fire-and-forget — give it a tick)
    await new Promise(resolve => setTimeout(resolve, 50));
    const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("readonly_write_intersection_warning");

    await rm(TMP, { recursive: true, force: true });
  });
});

// ── G5 (188): protect.ask dialog for out-of-project path blocks ────────────

describe("G5 (188): protect.ask dialog for out-of-project path blocks", () => {
  const COMMAND_ASK_OPTIONS = [
    "Follow default rules (block, default)",
    "Allow this command once",
    "Allow this command for session",
  ];

  it("out-of-project + whitelist + ask=true + user allows → pass (not blocked)", async () => {
    const TMP = join(tmpdir(), "pi-g5-ask-allow-" + Date.now());
    await mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = {
      ...config.stages["develop"],
      allowedWritePaths: ["docs/"],
    } as any;
    config.protect = { ...config.protect, ask: true };

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta, { selectReturn: COMMAND_ASK_OPTIONS[1] });
    ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/outside-ask-allow.md" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // User allowed → not blocked
    expect(result).toBeUndefined();

    await rm(TMP, { recursive: true, force: true });
  });

  it("out-of-project + whitelist + ask=true + user denies → block", async () => {
    const TMP = join(tmpdir(), "pi-g5-ask-deny-" + Date.now());
    await mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = {
      ...config.stages["develop"],
      allowedWritePaths: ["docs/"],
    } as any;
    config.protect = { ...config.protect, ask: true };

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta, { selectReturn: COMMAND_ASK_OPTIONS[0] });
    ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/outside-ask-deny.md" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // User denied → blocked
    expect((result as any).block).toBe(true);
    expect((result as any).reason).toContain("outside project root");

    await rm(TMP, { recursive: true, force: true });
  });

  it("out-of-project + whitelist + ask=false → direct block (no popup)", async () => {
    const TMP = join(tmpdir(), "pi-g5-noask-" + Date.now());
    await mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = {
      ...config.stages["develop"],
      allowedWritePaths: ["docs/"],
    } as any;
    // protect.ask is NOT set

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/outside-noask.md" } };
    let selectCalled = false;
    ctx.ui.select = async () => { selectCalled = true; return COMMAND_ASK_OPTIONS[1]; };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // ask=false → direct block, no popup
    expect((result as any).block).toBe(true);
    expect((result as any).reason).toContain("outside project root");
    expect(selectCalled).toBe(false);

    await rm(TMP, { recursive: true, force: true });
  });

  it("out-of-project + non-whitelist mode (full) → unchanged behavior (allowed)", async () => {
    const TMP = join(tmpdir(), "pi-g5-full-" + Date.now());
    await mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = {
      ...config.stages["develop"],
      allowedWritePaths: ["**"],
    } as any;
    config.protect = { ...config.protect, ask: true };

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/outside-full.md" } };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Full mode: out-of-project paths bypass whitelist → not blocked
    expect(result).toBeUndefined();

    await rm(TMP, { recursive: true, force: true });
  });
});
