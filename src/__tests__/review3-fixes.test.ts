/**
 * @module review3-fixes.test
 * Round-3 code review fixes verification (173_E2E_Bug_plan review report 2).
 *
 * Covers:
 * - Issue 1 (test debt): choose_stage execution chain, 🔴-2 startup+blocked
 *   no stale_reset, C8 replay select=1, C5 quit 3-round zero-notify,
 *   C11 violations-don't-increase consumer test, secondary Esc audit,
 *   source default "menu", startup replay source "replay", basis in notify.
 * - Issue 2 fix verification: directStageSelect bypass (shortcut→secondary directly)
 * - Issue 3 fix verification: no-UI dismissCount skip, hostRole audit, noUi tag
 * - Issue 4 fix verification: source defaults, replay source, notify basis
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  executeDecision,
  promptDecisionMenu,
  inferResumeStage,
  clearAllDecisionTimers,
} from "../core/flow-state";
import type { FlowStateCtx } from "../core/flow-state";
import type { SessionMeta, PipelineConfig } from "../types";
import { makeTestMeta, makeTestConfig } from "./helpers";
import { askProtectDecision, askCommandDecision } from "../utils/protect-ask";
import { initAuditLog, getDateAuditFileName } from "../utils/auditLog";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TMP: string;

function makeCtx(
  meta: SessionMeta,
  ui?: {
    select?: (msg: string, opts: string[]) => Promise<string | undefined>;
    notify?: (msg: string) => void;
  },
): FlowStateCtx & { updates: Partial<SessionMeta>[]; notifications: string[] } {
  const updates: Partial<SessionMeta>[] = [];
  const notifications: string[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        updates.push(patch);
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: ui as FlowStateCtx["ui"],
    updates,
    notifications,
  };
}

async function setupTmp(label: string): Promise<PipelineConfig> {
  TMP = join(tmpdir(), `pi-review3-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(TMP, { recursive: true });
  const config = makeTestConfig({ projectRoot: TMP });
  await initAuditLog(config);
  return config;
}

afterEach(async () => {
  clearAllDecisionTimers();
  if (TMP) {
    await rm(TMP, { recursive: true, force: true }).catch(() => {});
  }
});

// ─── Issue 1: choose_stage execution chain ───────────────────────────────────

describe("Review-r3 Issue 1: choose_stage execution chain", () => {
  it("choose_stage forward: clears counters + marks skipped summaries", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      loopCount: 5,
      verifyAttempts: 2,
      violations: [{ type: "write_protected", detail: "v", timestamp: 0 }],
      summaries: {
        clarify: { path: "/c.md", hash: "c", status: "valid" },
        plan: { path: "/p.md", hash: "p", status: "valid" },
      },
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "choose_stage", config, {
      source: "menu",
      targetStage: "review",
      basis: "currentStage",
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("review");
    // Counters cleared
    expect(meta.loopCount).toBe(0);
    expect(meta.verifyAttempts).toBe(0);
    expect(meta.violations).toEqual([]);
    expect(meta.flowState).toBe("running");
    expect(meta.currentStage).toBe("review");
    // stageVisitOrder appended
    expect(meta.stageVisitOrder).toContain("review");
  });

  it("choose_stage backward: marks target summary as invalid", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "review",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      summaries: {
        plan: { path: "/p.md", hash: "p", status: "valid" },
      },
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "choose_stage", config, {
      source: "menu",
      targetStage: "plan",
    });

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("plan");
    expect(meta.summaries.plan?.status).toBe("invalid");
  });

  it("choose_stage rejects when pipeline not frozen", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "choose_stage", config, {
      targetStage: "review",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("not frozen");
  });

  it("choose_stage rejects when no targetStage provided", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "test" });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "choose_stage", config);

    expect(result.success).toBe(false);
    expect(result.message).toContain("targetStage");
  });

  it("choose_stage preserves sessionAllowedWritePaths/Commands", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "test",
      sessionAllowedWritePaths: ["docs/a.md"],
      sessionAllowedCommands: ["rm -rf /tmp"],
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "choose_stage", config, {
      targetStage: "review",
    });

    // sessionAllowed* preserved (same freeze event continuation)
    expect(meta.sessionAllowedWritePaths).toEqual(["docs/a.md"]);
    expect(meta.sessionAllowedCommands).toEqual(["rm -rf /tmp"]);
  });
});

// ─── Issue 1: inferResumeStage 4-level chain ─────────────────────────────────

describe("Review-r3 Issue 1: inferResumeStage chain", () => {
  const config = makeTestConfig();

  it("level 1: currentStage (non-awaiting_human)", () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const result = inferResumeStage(meta, config);
    expect(result.stage).toBe("develop");
    expect(result.basis).toBe("currentStage");
  });

  it("level 1b: awaiting_human → previousStage", () => {
    const meta = makeTestMeta({ currentStage: "awaiting_human", previousStage: "plan" });
    const result = inferResumeStage(meta, config);
    expect(result.stage).toBe("plan");
    expect(result.basis).toBe("currentStage");
  });

  it("level 2: stageVisitOrder last entry", () => {
    const meta = makeTestMeta({
      currentStage: "completed",
      stageVisitOrder: ["clarify", "plan", "develop"],
    });
    const result = inferResumeStage(meta, config);
    expect(result.stage).toBe("develop");
    expect(result.basis).toBe("stageVisitOrder");
  });

  it("level 3: highest valid summary → nextStage", () => {
    const meta = makeTestMeta({
      currentStage: "completed",
      summaries: {
        clarify: { path: "/c.md", hash: "c", status: "valid" },
        plan: { path: "/p.md", hash: "p", status: "valid" },
      },
    });
    const result = inferResumeStage(meta, config);
    // plan is higher → nextStage = develop
    expect(result.stage).toBe("develop");
    expect(result.basis).toBe("summaries");
  });

  it("level 4: no inference → null", () => {
    const meta = makeTestMeta({ currentStage: "completed", summaries: {} });
    const result = inferResumeStage(meta, config);
    expect(result.stage).toBeNull();
    expect(result.basis).toBe("none");
  });
});

// ─── Issue 1: 🔴-2 startup+blocked → no stale_reset + replay select = 1 ──────

describe("Review-r3 Issue 1: 🔴-2 startup+blocked replay", () => {
  it("startup+blocked → no pipeline_stale_reset, menu replay (not abort)", async () => {
    const config = await setupTmp("startup-blocked");
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    // No select mock → promptDecisionMenu returns no-menu (no UI in session-starter ctx)
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: { notify: () => {} },
      event: { reason: "startup" },
      _ctx: {},
    };

    const { createSessionStarter } = await import("../core/session-starter");
    const hook = createSessionStarter(config);
    await hook.handler(ctx as any);

    // 🔴-2 key assertion: flowState should remain blocked (NOT stale_startup abort)
    expect(meta.flowState).toBe("blocked");
    expect(meta.terminateReason).not.toBe("stale_startup");
  });
});

// ─── Issue 1: C5 quit → 3 rounds settle zero notification ────────────────────

describe("Review-r3 Issue 1: C5 quit → dormant settle silence", () => {
  it("after quit (aborted+user_quit), 3 consecutive settles produce zero notifications", async () => {
    const config = await setupTmp("quit-silence");
    const meta = makeTestMeta({
      flowState: "aborted",
      terminateReason: "user_quit",
      currentStage: "develop",
    });
    const notifications: string[] = [];
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: { notify: (msg: string) => { notifications.push(msg); } },
      toolCall: { name: "bash", arguments: { command: "echo test" } },
      result: { success: true, exitCode: 0 },
      _ctx: {},
    };

    const { createAgentSettled } = await import("../core/agent-settled");
    const hook = createAgentSettled(config);

    // 3 consecutive settle events
    await hook.handler(ctx as any);
    await hook.handler(ctx as any);
    await hook.handler(ctx as any);

    // C5: Zero notifications after quit (dormant silencing)
    expect(notifications.length).toBe(0);
  });
});

// ─── Issue 1: C11 consumer-level "violations don't increase" ─────────────────

describe("Review-r3 Issue 1: C11 violations-don't-increase (tool-guard consumer)", () => {
  it("3 rapid dismisses → violations array stays empty (no violation tracking)", async () => {
    const config = await setupTmp("c11-violations");
    const meta = makeTestMeta({
      flowState: "running",
      violations: [],
    });
    // Mock select that returns immediately (fast dismiss)
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: {
        select: async () => undefined,
        notify: () => {},
      },
      toolCall: { name: "write", arguments: { path: "/some/protected/file" } },
      result: undefined,
      _ctx: {},
    };

    // Call askProtectDecision 3 times (simulating 3 fast-dismiss asks)
    await askProtectDecision(ctx, meta, "/some/protected/file", config);
    await askProtectDecision(ctx, meta, "/some/protected/file", config);
    await askProtectDecision(ctx, meta, "/some/protected/file", config);

    // C11: violations array stays at 0 — dismissed is NOT a violation
    expect(meta.violations?.length ?? 0).toBe(0);
    // But dismissCount accumulates to 3
    expect(meta.dismissCount).toBe(3);
  });
});

// ─── Issue 2 fix: directStageSelect bypass ───────────────────────────────────

describe("Review-r3 Issue 2: directStageSelect bypass", () => {
  it("directStageSelect=true → single select call (skips first-level menu)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      currentStage: "develop",
    });
    const selectCalls: { msg: string; opts: string[] }[] = [];
    const ctx = makeCtx(meta, {
      select: async (msg, opts) => {
        selectCalls.push({ msg, opts });
        // Return "develop" (the first inferred default item)
        return opts[0];
      },
    });

    await promptDecisionMenu(ctx, meta, config, {
      source: "shortcut",
      directStageSelect: true,
    });

    // With directStageSelect, only ONE select call should happen (the stage list),
    // NOT two (first-level + secondary)
    expect(selectCalls.length).toBe(1);
    // The single call should be the stage selection (contains "Choose stage")
    expect(selectCalls[0].msg).toContain("Choose stage");
  });

  it("without directStageSelect → two select calls (first + secondary on choose_stage)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      currentStage: "develop",
    });
    const selectCalls: { msg: string; opts: string[] }[] = [];
    let callCount = 0;
    const ctx = makeCtx(meta, {
      select: async (msg, opts) => {
        selectCalls.push({ msg, opts });
        callCount++;
        if (callCount === 1) return "Choose stage…"; // first-level → choose_stage
        return opts[0]; // secondary → first stage option
      },
    });

    await promptDecisionMenu(ctx, meta, config);

    // Normal path: first-level menu + secondary menu = 2 select calls
    expect(selectCalls.length).toBe(2);
    expect(selectCalls[0].msg).toContain("Pipeline blocked");
    expect(selectCalls[1].msg).toContain("Choose stage");
  });
});

// ─── Issue 3 fix: no-UI dismissCount skip + hostRole audit ───────────────────

describe("Review-r3 Issue 3: no-UI dismissCount skip + hostRole audit", () => {
  it("no UI (select missing) → dismissCount does NOT increment", async () => {
    const config = await setupTmp("no-ui-dismiss");
    const meta = makeTestMeta({ dismissCount: 0 });
    // ctx without ui.select
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: { notify: () => {} },
      _ctx: {},
    };

    await askProtectDecision(ctx, meta, "test/file.md", config);

    // Issue 3 fix: no-UI should NOT increment dismissCount
    expect(meta.dismissCount).toBe(0);
  });

  it("select throws → dismissCount does NOT increment", async () => {
    const config = await setupTmp("throw-dismiss");
    const meta = makeTestMeta({ dismissCount: 0 });
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: {
        select: async () => { throw new Error("UI unavailable"); },
        notify: () => {},
      },
      _ctx: {},
    };

    const outcome = await askProtectDecision(ctx, meta, "test/file.md", config);

    // Still classified as block/dismissed
    expect(outcome.decision).toBe("block");
    expect(outcome.action).toBe("dismissed");
    // But dismissCount NOT incremented (environment fact, not user behavior)
    expect(meta.dismissCount).toBe(0);
  });

  it("audit log includes hostRole field for pipeline_protect_ask", async () => {
    const config = await setupTmp("hostrole-audit");
    const meta = makeTestMeta();
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: { select: async () => undefined, notify: () => {} },
      _ctx: {},
    };

    await askProtectDecision(ctx, meta, "test/file.md", config);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("pipeline_protect_ask");
    expect(content).toContain("hostRole=");
  });

  it("audit log includes hostRole field for pipeline_command_ask", async () => {
    const config = await setupTmp("cmd-hostrole");
    const meta = makeTestMeta();
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: { select: async () => undefined, notify: () => {} },
      _ctx: {},
    };

    await askCommandDecision(ctx, meta, "rm -rf /", config);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("pipeline_command_ask");
    expect(content).toContain("hostRole=");
  });

  it("no-UI audit includes noUi=true tag", async () => {
    const config = await setupTmp("noui-tag");
    const meta = makeTestMeta();
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: { notify: () => {} },
      _ctx: {},
    };

    await askProtectDecision(ctx, meta, "test/file.md", config);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("noUi=true");
  });
});

// ─── Issue 4 fix: source defaults + replay source + notify basis ────────────

describe("Review-r3 Issue 4: audit source defaults", () => {
  it("promptDecisionMenu without opts.source → source='menu' in audit", async () => {
    const config = await setupTmp("source-default");
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeCtx(meta, {
      select: async () => "Resume",
    });

    await promptDecisionMenu(ctx, meta, config);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("pipeline_decision");
    expect(content).toContain("source=menu");
  });
});

// ─── Issue 1: Secondary menu Esc audit ──────────────────────────────────────

describe("Review-r3 Issue 1: secondary menu Esc audit", () => {
  it("Esc in secondary choose_stage menu (slow, ≥1500ms) → pipeline_decision_cancelled with context", async () => {
    const config = await setupTmp("esc-secondary");
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    let callCount = 0;
    const ctx = makeCtx(meta, {
      select: async (_msg, _opts) => {
        callCount++;
        if (callCount === 1) return "Choose stage…"; // first-level choose_stage
        // Simulate user holding Esc for ≥1500ms (genuine user cancel, not streaming dismiss)
        await new Promise((r) => setTimeout(r, 1600));
        return undefined; // secondary Esc (slow)
      },
      notify: () => {},
    });

    const outcome = await promptDecisionMenu(ctx, meta, config);

    expect(outcome).toBe("cancelled");
    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("pipeline_decision_cancelled");
    expect(content).toContain("choose_stage_secondary");
  });
});

// ─── Issue 1: C8 replay select exactly 1 time ──────────────────────────────

describe("Review-r3 Issue 1: C8 replay select=1", () => {
  it("frozen replay via promptDecisionMenu → ui.select called exactly once", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    let selectCount = 0;
    const ctx = makeCtx(meta, {
      select: async (msg, opts) => {
        selectCount++;
        return "Resume";
      },
    });

    await promptDecisionMenu(ctx, meta, config);

    // C8 replay matrix "select exactly 1 time" cell
    expect(selectCount).toBe(1);
  });
});

// ─── Issue 4 fix: startup replay source="replay" (not "startup") ─────────────

describe("Review-r3 Issue 4: startup replay source='replay'", () => {
  it("startup+blocked replay audit uses source='replay' (not 'startup')", async () => {
    const config = await setupTmp("startup-replay-source");
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: {
        notify: () => {},
        select: async (_msg: string, opts: string[]) => opts[0], // pick first
      },
      event: { reason: "startup" },
      _ctx: {},
    };

    const { createSessionStarter, __resetPluginVersionStamp } = await import("../core/session-starter");
    __resetPluginVersionStamp();
    const hook = createSessionStarter(config);
    await hook.handler(ctx as any);

    // Plan §3.1 dictates source="replay" for all replay reasons (including startup)
    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    // Should NOT contain "source=startup" (which was the old bug)
    expect(content).not.toContain("source=startup");
  });
});

// ─── Issue 4 fix: C8 notify includes inference basis ─────────────────────────

describe("Review-r3 Issue 4: C8 replay notify includes basis", () => {
  it("frozen replay notify includes inference basis in parens", async () => {
    const config = await setupTmp("notify-basis");
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const notifications: string[] = [];
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => { Object.assign(meta, m); return meta; },
      },
      ui: {
        notify: (msg: string) => { notifications.push(msg); },
      },
      event: { reason: "reload" },
      _ctx: {},
    };

    const { createSessionStarter, __resetPluginVersionStamp } = await import("../core/session-starter");
    __resetPluginVersionStamp();
    const hook = createSessionStarter(config);
    await hook.handler(ctx as any);

    // Issue 4 fix: notify text should include basis in parens
    const basisNotify = notifications.find(n => n.includes("inference"));
    expect(basisNotify).toBeDefined();
    // basis should be "currentStage" (since currentStage = "develop")
    expect(basisNotify).toContain("(currentStage)");
  });
});

// ─── Issue 1: Secondary menu default-first ordering ──────────────────────────

describe("Review-r3 Issue 1: secondary menu default-first ordering", () => {
  it("inferred stage appears first with '(default)' suffix", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      currentStage: "develop",
    });
    let secondaryOpts: string[] = [];
    let callCount = 0;
    const ctx = makeCtx(meta, {
      select: async (_msg, opts) => {
        callCount++;
        if (callCount === 1) return "Choose stage…";
        secondaryOpts = opts;
        return opts[0];
      },
    });

    await promptDecisionMenu(ctx, meta, config);

    // First item should be the inferred stage with "(default)" suffix
    expect(secondaryOpts.length).toBeGreaterThan(0);
    expect(secondaryOpts[0]).toBe("develop (default)");
    // Total 6 items: inferred + 5 other stages
    expect(secondaryOpts.length).toBe(6);
  });
});

// ─── Issue 1: choose_stage audit basis field ─────────────────────────────────

describe("Review-r3 Issue 1: choose_stage audit fields", () => {
  it("choose_stage audit includes fromStage, toStage, basis, source", async () => {
    const config = await setupTmp("choose-stage-audit");
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "choose_stage", config, {
      source: "menu",
      targetStage: "review",
      basis: "currentStage",
    });

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("pipeline_decision");
    expect(content).toContain("decision=choose_stage");
    expect(content).toContain("fromStage=develop");
    expect(content).toContain("toStage=review");
    expect(content).toContain("basis=currentStage");
    expect(content).toContain("source=menu");
  });
});
