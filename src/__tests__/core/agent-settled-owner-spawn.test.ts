import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog } from "../../utils/auditLog";
import type { PipelineStage, SessionMeta } from "../../types";
import { auditLogFileFor } from "../helpers";

const TMP = join(tmpdir(), "pi-pipeline-agent-settled-owner-spawn-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

describe("Phase 2 / 177 (D4): owner pendingSpawns consumption", () => {
  it("owner agent_settled consumes pendingSpawns and spawns once", async () => {
    // Reuse the module-level TMP (audit already initialized in beforeAll) so the
    // module-level audit dir path is not redirected for other test files.
    const agentsDir = join(TMP, "agents-pending");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "dev-agent.md"),
      "---\nname: develop-agent\n---\n# Dev Agent\n",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "agents-pending/dev-agent.md",
          skillPath: "develop/SKILL.md",
          nextStage: "review",
          requireDomain: false,
        },
      },
    } as any);

    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-settled-pending",
      pendingSpawns: { develop: { agentName: "develop-agent", requestedAt: Date.now(), attempts: 0 } },
    });

    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });
    // No user messages → fail-open pipeline turn
    (ctx._ctx.sessionManager as any).getBranch = () => [];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // pendingSpawns consumed and cleared
    expect(meta.pendingSpawns?.develop).toBeUndefined();
    // Owner spawned via fallback (latch off by default in this file)
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("[plugin auto-handoff]");
    expect(sentMessages[0]).toContain("develop-agent");
  });
});

// ─── Phase 0 (182) G5: advance liveness guard ──────────────────────────────

describe("Phase 0 (182) G5: advance_deferred_stage_agent_live", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  it("defers advance when activeSpawns evidence shows live executor", async () => {
    const TMP5 = join(tmpdir(), "pi-advance-guard-1-" + Date.now());
    await mkdir(join(TMP5, ".pi", "audit"), { recursive: true });
    await mkdir(join(TMP5, "agents"), { recursive: true });
    // Create agent file so resolveAgentMention can find "develop-agent"
    await writeFile(join(TMP5, "agents", "test-agent.md"), "---\nname: develop-agent\n---\n# Agent\n");
    const config = makeTestConfig({ projectRoot: TMP5 });
    await initAuditLog(config);

    // Install manager so probeAgentState("agent-123") returns "live"
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: (id: string) => (id === "agent-123" ? { status: "running" } : undefined),
      hasRunning: () => true,
    };

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      // Simulate activeSpawns with a live agent
      activeSpawns: {
        develop: {
          agentName: "develop-agent",
          agentId: "agent-123",
          startedAt: Date.now(),
        },
      },
    });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Verify the advance guard fired (audit event + stage unchanged)
    const auditPath = auditLogFileFor(join(TMP5, ".pi", "audit"));
    let auditContent = "";
    try {
      auditContent = await readFile(auditPath, "utf-8");
    } catch {
      // File may not exist if guard didn't reach audit write
    }
    // Primary assertion: stage was not advanced (guard either fired or early-return preserved state)
    expect(meta.currentStage).toBe("develop");
    // Explicit assertion: audit must contain the defer event exactly once
    expect(auditContent).toContain("advance_deferred_stage_agent_live");

    // Cleanup
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    await rm(TMP5, { recursive: true, force: true });
  });

  it("defers advance when name-probe finds live agent (manual spawn)", async () => {
    const TMP5 = join(tmpdir(), "pi-advance-guard-2-" + Date.now());
    await mkdir(join(TMP5, ".pi", "audit"), { recursive: true });
    await mkdir(join(TMP5, "agents"), { recursive: true });
    // Create agent file so resolveAgentMention can find "develop-agent"
    await writeFile(join(TMP5, "agents", "test-agent.md"), "---\nname: develop-agent\n---\n# Agent\n");
    const config = makeTestConfig({ projectRoot: TMP5 });
    await initAuditLog(config);

    // Install mock manager with a live agent matching the expected name
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      listRecords: () => [
        { id: "manual-agent-1", name: "develop-agent", status: "running" },
      ],
      getRecord: () => undefined,
    };

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      // No activeSpawns evidence (manual spawn not in ledger)
    });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Verify the guard either fired (audit defer event) or preserved state (stage unchanged)
    const auditPath = auditLogFileFor(join(TMP5, ".pi", "audit"));
    let auditContent = "";
    try {
      auditContent = await readFile(auditPath, "utf-8");
    } catch {
      // File may not exist
    }
    // Primary assertion: stage not advanced
    expect(meta.currentStage).toBe("develop");
    // Explicit assertion: audit must contain the defer event with manual_live_probe basis
    expect(auditContent).toContain("advance_deferred_stage_agent_live");
    expect(auditContent).toContain("manual_live_probe");

    // Cleanup
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    await rm(TMP5, { recursive: true, force: true });
  });

  it("does not defer when no evidence (fail-open)", async () => {
    const TMP5 = join(tmpdir(), "pi-advance-guard-3-" + Date.now());
    await mkdir(join(TMP5, ".pi", "audit"), { recursive: true });
    await mkdir(join(TMP5, "agents"), { recursive: true });
    // Create agent file so resolveAgentMention can find "develop-agent"
    await writeFile(join(TMP5, "agents", "test-agent.md"), "---\nname: develop-agent\n---\n# Agent\n");
    const config = makeTestConfig({ projectRoot: TMP5 });
    await initAuditLog(config);

    // No manager, no activeSpawns
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      // No verify.require → settle returns early before advance check
    });
    const ctx = createMockCtx(meta);
    (ctx._ctx.sessionManager as any).getBranch = () => [];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Verify no defer audit (guard didn't fire because no evidence → fail-open)
    const auditPath = auditLogFileFor(join(TMP5, ".pi", "audit"));
    // Read audit file if it exists; either outcome (missing file or file without defer event) is valid
    let auditContent = "";
    try {
      auditContent = await readFile(auditPath, "utf-8");
    } catch {
      // File not existing is also valid (nothing was written)
    }
    // Explicit assertion: stage unchanged, and no defer event was written
    expect(meta.currentStage).toBe("develop");
    expect(auditContent).not.toContain("advance_deferred_stage_agent_live");

    await rm(TMP5, { recursive: true, force: true });
  });

  // Phase 5 (182) ④: child settle → guard does NOT fire
  it("child settle does not trigger liveness guard (guard is owner-only)", async () => {
    const TMP5 = join(tmpdir(), "pi-advance-guard-4-" + Date.now());
    await mkdir(join(TMP5, ".pi", "audit"), { recursive: true });
    await mkdir(join(TMP5, "agents"), { recursive: true });
    // Create agent file so resolveAgentMention can find "develop-agent"
    await writeFile(join(TMP5, "agents", "test-agent.md"), "---\nname: develop-agent\n---\n# Agent\n");
    const config = makeTestConfig({ projectRoot: TMP5 });
    await initAuditLog(config);

    // Install manager so probeAgentState returns "live" for the agentId
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: (id: string) => (id === "agent-child-test" ? { status: "running" } : undefined),
      hasRunning: () => true,
    };

    // ActiveSpawns has a live agent — normally the guard would fire for owner settle
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      activeSpawns: {
        develop: {
          agentName: "develop-agent",
          agentId: "agent-child-test",
          startedAt: Date.now(),
        },
      },
    });
    // Child session context: parentSession header present
    const ctx = createMockCtx(meta, {
      sessionHeader: { parentSession: "parent-session-id" },
      sessionName: "agent#child001",
      sessionFile: "child-session",
    });
    (ctx._ctx.sessionManager as any).getBranch = () => [];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Stage unchanged (child settle has its own semantics, guard skipped)
    expect(meta.currentStage).toBe("develop");

    // Audit should NOT contain advance_deferred for child settle
    const auditPath = auditLogFileFor(join(TMP5, ".pi", "audit"));
    let auditContent = "";
    try {
      auditContent = await readFile(auditPath, "utf-8");
    } catch {
      // File may not exist
    }
    expect(auditContent).not.toContain("advance_deferred_stage_agent_live");

    // Cleanup
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    await rm(TMP5, { recursive: true, force: true });
  });

  // Phase 5 (182) ⑤: double settle race (owner×2 + child×1) → advance exactly once
  // Scenario: owner-settle (live evidence, deferred) → child-settle (guard skipped, advance fires)
  //           → owner-settle (already advanced, no second advance)
  // The positive assertion: stage_advance audit count is exactly 1 after all three settles.
  it("owner-settle deferred + child-settle + owner-settle → advance exactly once to review", async () => {
    const TMP5 = join(tmpdir(), "pi-advance-guard-5-" + Date.now());
    await mkdir(join(TMP5, ".pi", "audit"), { recursive: true });
    await mkdir(join(TMP5, "agents"), { recursive: true });
    // Create agent file so resolveAgentMention can find "develop-agent"
    await writeFile(join(TMP5, "agents", "test-agent.md"), "---\nname: develop-agent\n---\n# Agent\n");

    // Set up verify infrastructure so advance can happen when guard allows
    const vrDir = join(TMP5, "references", "develop_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(TMP5, "exists.md"), "content");

    const config = makeTestConfig({
      projectRoot: TMP5,
      stages: Object.fromEntries(
        ["clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "agents/test-agent.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "develop"
                ? { require: true, verifyFile: "references/develop_spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });
    await initAuditLog(config);

    // Shared meta — mutations visible to all settle calls
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      activeSpawns: {
        develop: {
          agentName: "develop-agent",
          agentId: "agent-race-test",
          startedAt: Date.now(),
        },
      },
    });

    const hook = createAgentSettled(config);

    // ── Step 1: owner-settle #1 with live evidence → advance DEFERRED ──
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: (id: string) => (id === "agent-race-test" ? { status: "running" } : undefined),
      hasRunning: () => true,
      listRecords: () => [{ id: "agent-race-test", name: "develop-agent", status: "running" }],
    };

    const ownerCtx = createMockCtx(meta);
    (ownerCtx._ctx.sessionManager as any).getBranch = () => [];
    await hook.handler(ownerCtx as any);

    // Stage must remain "develop" — guard deferred
    expect(meta.currentStage).toBe("develop");

    // ── Step 2: child-settle (guard is owner-only → skipped, verify fires) ──
    // Clear activeSpawns evidence so verify path succeeds (child guard skipped)
    delete meta.activeSpawns;

    const childCtx = createMockCtx(meta, {
      sessionHeader: { parentSession: "parent-session-id" },
      sessionName: "agent#child001",
      sessionFile: "child-session",
    });
    (childCtx._ctx.sessionManager as any).getBranch = () => [];
    await hook.handler(childCtx as any);

    // Child settle with no guard and verify passing → advance to review
    expect(meta.currentStage).toBe("review");

    // ── Step 3: owner-settle #2 (already at review, no second advance) ──
    // Remove manager to ensure no evidence blocks
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];

    const ownerCtx2 = createMockCtx(meta);
    (ownerCtx2._ctx.sessionManager as any).getBranch = () => [];
    await hook.handler(ownerCtx2 as any);

    // Stage stays at "review" — no double advance
    expect(meta.currentStage).toBe("review");

    // Audit assertions: exactly 1 stage_advance event (develop → review)
    const auditPath = auditLogFileFor(join(TMP5, ".pi", "audit"));
    const auditContent = await readFile(auditPath, "utf-8");

    // Guard fired once (step 1 deferred)
    expect(auditContent).toContain("advance_deferred_stage_agent_live");

    // Count stage_advance events — must be exactly 1 (not 0, not 2+)
    const advanceMatches = auditContent.match(/stage_advance/g);
    expect(advanceMatches).not.toBeNull();
    expect(advanceMatches!.length).toBe(1);

    // Cleanup
    await rm(TMP5, { recursive: true, force: true });
  });
});

// ── Phase 0 (186): consumePendingSpawns before source gate + syncStageStatusBar ──

describe("Phase 0 (186): consumePendingSpawns runs before source gate", () => {
  it("consumePendingSpawns executes even when source gate rejects (non-pipeline turn)", async () => {
    // Re-initialize audit log to the module-level TMP (prior tests may have redirected it)
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const agentsDir = join(TMP, "agents-186-srcgate");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "dev-agent.md"),
      "---\nname: develop-agent\n---\n# Dev Agent\n",
    );

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "agents-186-srcgate/dev-agent.md",
          skillPath: "develop/SKILL.md",
          nextStage: "review",
          requireDomain: false,
        },
      },
    } as any);

    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-186-srcgate",
      pendingSpawns: { develop: { agentName: "develop-agent", requestedAt: Date.now(), attempts: 0 } },
    });

    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });
    // Set a non-pipeline user message so the source gate rejects
    (ctx._ctx.sessionManager as any).getBranch = () => [
      { type: "message", message: { role: "user", content: "What is the weather today?" } },
    ];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Source gate should have rejected (non-pipeline turn)
    const auditPath = auditLogFileFor(join(TMP, ".pi", "audit"), meta.pipelineId);
    const auditContent = await readFile(auditPath, "utf-8");
    expect(auditContent).toContain("agent_settled_non_pipeline_turn");

    // But pendingSpawns should still have been consumed (moved before source gate)
    expect(meta.pendingSpawns?.develop).toBeUndefined();
    // Owner spawned via fallback
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("[plugin auto-handoff]");
    expect(sentMessages[0]).toContain("develop-agent");
  });
});

describe("Phase 0 (186): syncStageStatusBar on every owner settle", () => {
  it("syncStageStatusBar is called on every owner settle (setStatus invoked with pipeline-stage key)", async () => {
    // Re-initialize audit log to the module-level TMP (prior tests may have redirected it)
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    // No user messages → fail-open pipeline turn
    (ctx._ctx.sessionManager as any).getBranch = () => [];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // syncStageStatusBar calls ui.setStage which calls writeStageStatusLast
    // which calls setStatus(STAGE_STATUS_KEY, undefined) then setStatus(STAGE_STATUS_KEY, message)
    const pipelineStageCalls = ctx.statusCalls.filter(c => c.key === "pipeline-stage");
    // At least one setStatus call with "pipeline-stage" key (the move-to-end pattern emits 2 calls)
    expect(pipelineStageCalls.length).toBeGreaterThanOrEqual(1);
    // The last call should have a non-undefined text (the actual stage message)
    const lastCall = pipelineStageCalls[pipelineStageCalls.length - 1];
    expect(lastCall.text).toBeDefined();
    expect(lastCall.text).toContain("develop");
  });

  it("syncStageStatusBar is NOT called on child settle (owner-only)", async () => {
    // Re-initialize audit log to the module-level TMP (prior tests may have redirected it)
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/tmp/parent.jsonl" },
      sessionFile: "/tmp/child.jsonl",
    });
    // No user messages → fail-open pipeline turn
    (ctx._ctx.sessionManager as any).getBranch = () => [];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Child session → syncStageStatusBar should NOT be called
    // (no setStatus calls for pipeline-stage key from syncStageStatusBar)
    // Note: other pipeline-ui methods may also call setStatus, but syncStageStatusBar
    // specifically calls setStage which uses writeStageStatusLast.
    // For a child session, the only setStatus calls would come from stageEntry/transition,
    // not from syncStageStatusBar. Since there's no stage transition here, there should
    // be zero setStatus calls for "pipeline-stage" key.
    const pipelineStageCalls = ctx.statusCalls.filter(c => c.key === "pipeline-stage");
    expect(pipelineStageCalls.length).toBe(0);
  });
});
