import { describe, it, expect, beforeEach } from "bun:test";
import {
  getFlowState,
  isFrozen,
  buildDecisionMenu,
  executeDecision,
  freezeAndPrompt,
  formatFrozenReason,
  promptDecisionMenu,
} from "../../core/flow-state";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestMeta, makeTestConfig } from "../helpers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(
  meta: SessionMeta,
  ui?: { select?: (msg: string, opts: string[]) => Promise<string | undefined>; notify?: (msg: string) => void },
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

// ─── getFlowState ────────────────────────────────────────────────────────────

describe("getFlowState", () => {
  it("returns flowState when explicitly set", () => {
    const meta = makeTestMeta({ flowState: "blocked" });
    expect(getFlowState(meta)).toBe("blocked");
  });

  it("returns 'blocked' for legacy terminated=true", () => {
    const meta = makeTestMeta({ terminated: true, flowState: undefined });
    expect(getFlowState(meta)).toBe("blocked");
  });

  it("returns 'running' when flowState is undefined and terminated is false", () => {
    const meta = makeTestMeta({ flowState: undefined, terminated: false });
    expect(getFlowState(meta)).toBe("running");
  });

  it("returns 'running' by default", () => {
    const meta = makeTestMeta();
    expect(getFlowState(meta)).toBe("running");
  });

  it("prefers flowState over terminated (flowState='aborted', terminated=true)", () => {
    const meta = makeTestMeta({ flowState: "aborted", terminated: true });
    expect(getFlowState(meta)).toBe("aborted");
  });
});

// ─── isFrozen ────────────────────────────────────────────────────────────────

describe("isFrozen", () => {
  it("returns true when flowState is 'blocked'", () => {
    const meta = makeTestMeta({ flowState: "blocked" });
    expect(isFrozen(meta)).toBe(true);
  });

  it("returns true when flowState is 'aborted'", () => {
    const meta = makeTestMeta({ flowState: "aborted" });
    expect(isFrozen(meta)).toBe(true);
  });

  it("returns true when currentStage is 'awaiting_human'", () => {
    const meta = makeTestMeta({ currentStage: "awaiting_human" });
    expect(isFrozen(meta)).toBe(true);
  });

  it("returns false when flowState is 'running' and stage is normal", () => {
    const meta = makeTestMeta({ flowState: "running", currentStage: "develop" });
    expect(isFrozen(meta)).toBe(false);
  });

  it("returns true for legacy terminated=true (mapped to blocked)", () => {
    const meta = makeTestMeta({ terminated: true });
    expect(isFrozen(meta)).toBe(true);
  });
});

// ─── buildDecisionMenu ───────────────────────────────────────────────────────

describe("buildDecisionMenu", () => {
  it("returns 5 items for blocked state", () => {
    const meta = makeTestMeta({ flowState: "blocked" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toEqual([
      "Resume",
      "Skip",
      "Rollback",
      "Restart & New",
      "Abort & Exit",
    ]);
  });

  it("returns 5 items for awaiting_human stage", () => {
    const meta = makeTestMeta({ currentStage: "awaiting_human" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toHaveLength(5);
    expect(menu).toContain("Resume");
  });

  it("returns 2 items for running state", () => {
    const meta = makeTestMeta({ flowState: "running" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toEqual(["Restart & New", "Abort & Exit"]);
  });

  it("returns null for aborted state", () => {
    const meta = makeTestMeta({ flowState: "aborted" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toBeNull();
  });
});

// ─── executeDecision ─────────────────────────────────────────────────────────

describe("executeDecision", () => {
  let config: PipelineConfig;

  beforeEach(() => {
    config = makeTestConfig();
  });

  it("resume: sets flowState=running, clears blockedReason, resets counters", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
      loopCount: 5,
      verifyAttempts: 3,
      verifyFailures: [{ ruleType: "test", detail: "fail", timestamp: 0 }],
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "resume", config);

    expect(result.success).toBe(true);
    expect(result.message).toContain("resumed");
    // Check updates
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.flowState).toBe("running");
    expect(lastUpdate.blockedReason).toBeUndefined();
    expect(lastUpdate.loopCount).toBe(0);
    expect(lastUpdate.verifyAttempts).toBe(0);
    expect(lastUpdate.verifyFailures).toEqual([]);
  });

  it("resume: transitions awaiting_human → previousStage", async () => {
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      previousStage: "develop",
      flowState: "running",
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "resume", config);

    expect(result.success).toBe(true);
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("develop");
  });

  it("skip: rejects when pipeline is not frozen", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "skip", config);

    expect(result.success).toBe(false);
    expect(result.message).toContain("not frozen");
  });

  it("skip: advances to nextStage when frozen", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "verify_fail",
      summaries: { develop: { path: "/tmp/s.md", hash: "abc", status: "valid" } },
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "skip", config);

    expect(result.success).toBe(true);
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("review"); // develop → review
    expect(lastUpdate.flowState).toBe("running");
    // Summary should be marked "skipped" per plan Phase 1 task 1
    expect(lastUpdate.summaries?.develop?.status).toBe("skipped");
  });

  it("rollback: rejects when pipeline is not frozen", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "rollback", config);

    expect(result.success).toBe(false);
  });

  it("rollback: goes to previousStage when frozen", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      flowState: "blocked",
      summaries: { plan: { path: "/tmp/p.md", hash: "def", status: "valid" } },
    });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "rollback", config);

    expect(result.success).toBe(true);
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("plan");
    expect(lastUpdate.flowState).toBe("running");
    // Target stage summary marked invalid
    expect(lastUpdate.summaries?.plan?.status).toBe("invalid");
  });

  it("restart: creates new pipelineId, resets to clarify", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      requirementDoc: "req.md",
      summaries: { clarify: { path: "/tmp/c.md", hash: "x", status: "valid" } },
    });
    const originalPipelineId = meta.pipelineId;
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "restart", config);

    expect(result.success).toBe(true);
    expect(result.message).toContain("restarted");
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.pipelineId).toBeDefined();
    expect(lastUpdate.pipelineId).not.toBe(originalPipelineId);
    expect(lastUpdate.currentStage).toBe("clarify");
    expect(lastUpdate.flowState).toBe("running");
    expect(lastUpdate.summaries).toEqual({});
  });

  it("abort: sets flowState=aborted with terminateReason", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "abort", config);

    expect(result.success).toBe(true);
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.flowState).toBe("aborted");
    expect(lastUpdate.terminateReason).toBe("user_abort");
  });

  it("unknown decision returns failure", async () => {
    const meta = makeTestMeta();
    const ctx = makeCtx(meta);

    const result = await executeDecision(ctx, meta, "unknown" as any, config);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown decision");
  });

  // ── verifyConfigError lifecycle ────────────────────────────────────────────

  it("resume: preserves verifyConfigError flag (escape hatch stays reachable)", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "verify_config_error",
      verifyConfigError: true,
      verifyFailures: [{ ruleType: "fileContentPattern", detail: "EISDIR", timestamp: 0 }],
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "resume", config);

    // verifyFailures cleared, but verifyConfigError preserved
    expect(meta.verifyFailures).toEqual([]);
    expect(meta.verifyConfigError).toBe(true);
    expect(meta.flowState).toBe("running");
  });

  it("skip: clears verifyConfigError flag (stage transition)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "verify_config_error",
      verifyConfigError: true,
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "skip", config);

    expect(meta.verifyConfigError).toBeUndefined();
  });

  it("rollback: clears verifyConfigError flag (stage transition)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      flowState: "blocked",
      verifyConfigError: true,
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "rollback", config);

    expect(meta.verifyConfigError).toBeUndefined();
  });

  it("restart: clears verifyConfigError flag (new pipeline)", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      verifyConfigError: true,
    });
    const ctx = makeCtx(meta);

    await executeDecision(ctx, meta, "restart", config);

    expect(meta.verifyConfigError).toBeUndefined();
  });
});

// ─── freezeAndPrompt ─────────────────────────────────────────────────────────

describe("freezeAndPrompt", () => {
  it("transitions running → blocked on first call", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta);
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.flowState).toBe("blocked");
    expect(lastUpdate.blockedReason).toBe("loop_overflow");
  });

  it("is idempotent: does not re-update if already blocked", async () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "existing_reason" });
    const ctx = makeCtx(meta);
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "new_reason", config);

    // Should NOT have called updateMeta since already blocked
    expect(ctx.updates.length).toBe(0);
  });

  it("with UI select: user selects option → executes decision", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    let selectCalled = false;
    const ctx = makeCtx(meta, {
      select: async (_msg: string, _opts: string[]) => {
        selectCalled = true;
        return "Abort & Exit"; // abort
      },
      notify: (_msg: string) => {},
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    expect(selectCalled).toBe(true);
    // Should have flowState=blocked from freeze, then aborted from executeDecision
    expect(meta.flowState).toBe("aborted");
  });

  it("with UI select: user presses Esc → stays blocked + notify reason (no shortcut)", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      select: async () => undefined, // Esc
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "verify_fail", config);

    expect(meta.flowState).toBe("blocked");
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("verify_fail");
    expect(notifications[0]).toContain("decision menu");
    // Should NOT contain shortcut key
    expect(notifications[0]).not.toContain("ctrl+enter");
  });

  it("without UI: keeps blocked, no crash, notify includes reason", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "max_loop_cycles", config);

    expect(meta.flowState).toBe("blocked");
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("max_loop_cycles");
    expect(notifications[0]).toContain("decision menu");
  });

  it("without any UI: no crash, stays blocked", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta); // no UI at all
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "some_reason", config);

    expect(meta.flowState).toBe("blocked");
  });

  it("frozen message includes blockedReason, not shortcut key", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig({ decisionShortcutKey: "alt+f" });

    await freezeAndPrompt(ctx, meta, "test_reason", config);

    expect(notifications[0]).toContain("test_reason");
    expect(notifications[0]).not.toContain("alt+f");
  });

  it("opts.ui overrides ctx.ui for select", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctxUiSelectCalled: boolean[] = [];
    const optsUiSelectCalled: boolean[] = [];

    const ctx = makeCtx(meta, {
      select: async () => { ctxUiSelectCalled.push(true); return undefined; },
      notify: () => {},
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "reason", config, {
      ui: {
        select: async () => { optsUiSelectCalled.push(true); return "Abort & Exit"; },
        notify: () => {},
      },
    });

    expect(ctxUiSelectCalled.length).toBe(0);
    expect(optsUiSelectCalled.length).toBe(1);
  });
});

// ── 168 Phase 1: formatFrozenReason ──────────────────────────────────────────

describe("168 Phase 1: formatFrozenReason", () => {
  it("returns blockedReason when present", () => {
    const meta = makeTestMeta({ blockedReason: "loop_overflow" });
    expect(formatFrozenReason(meta)).toBe("loop_overflow");
  });

  it("falls back to terminateReason when blockedReason is absent", () => {
    const meta = makeTestMeta({ terminateReason: "user_abort" });
    expect(formatFrozenReason(meta)).toBe("user_abort");
  });

  it("returns 'unknown' when neither reason is present", () => {
    const meta = makeTestMeta({});
    expect(formatFrozenReason(meta)).toBe("unknown");
  });

  it("appends first 2 verifyFailures", () => {
    const meta = makeTestMeta({
      blockedReason: "verify_attempt_overflow",
      verifyFailures: [
        { ruleType: "requiredFiles", detail: "Missing: output.md", timestamp: 1 },
        { ruleType: "fileContentPattern", detail: "pattern not found", timestamp: 2 },
        { ruleType: "keywords", detail: "Missing: kw1", timestamp: 3 },
      ],
    });
    const result = formatFrozenReason(meta);
    expect(result).toContain("verify_attempt_overflow");
    expect(result).toContain("[requiredFiles] Missing: output.md");
    expect(result).toContain("[fileContentPattern] pattern not found");
    // Should only include first 2 failures
    expect(result).not.toContain("[keywords]");
  });

  it("truncates to maxLen with ellipsis (maxLen is hard upper bound)", () => {
    const meta = makeTestMeta({
      blockedReason: "a".repeat(300),
    });
    const result = formatFrozenReason(meta, 50);
    expect(result.length).toBe(50); // hard upper bound: (maxLen-1) chars + "…"
    expect(result).toEndWith("…");
  });

  it("handles multi-byte characters without splitting (maxLen hard upper bound)", () => {
    // Chinese characters are 3 bytes each but 1 JS char unit — Array.from handles surrogate pairs
    const meta = makeTestMeta({
      blockedReason: "日本語テスト".repeat(20), // 60 chars, all multi-byte
    });
    const result = formatFrozenReason(meta, 10);
    expect(result.length).toBeLessThanOrEqual(10); // hard upper bound preserved
    expect(result).toEndWith("…");
  });

  it("handles empty verifyFailures array", () => {
    const meta = makeTestMeta({
      blockedReason: "test_reason",
      verifyFailures: [],
    });
    expect(formatFrozenReason(meta)).toBe("test_reason");
  });
});

// ── 168 Phase 2: promptDecisionMenu (re-popup while frozen) ──────────────────

describe("168 Phase 2: promptDecisionMenu", () => {
  it("can be called when already blocked (re-popup)", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const selectCalls: number[] = [];
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      select: async () => {
        selectCalls.push(1);
        return "Resume";
      },
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    // First call
    await promptDecisionMenu(ctx, meta, config);
    expect(selectCalls.length).toBe(1);

    // Second call (re-popup while still blocked)
    await promptDecisionMenu(ctx, meta, config);
    expect(selectCalls.length).toBe(2);
  });

  it("Esc cancel writes pipeline_decision_cancelled audit + notify with reason (no shortcut)", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "verify_attempt_overflow",
    });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      select: async () => undefined, // Esc
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig();

    await promptDecisionMenu(ctx, meta, config);

    // Should notify with reason (not shortcut key)
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("verify_attempt_overflow");
    expect(notifications[0]).toContain("decision menu");
    expect(notifications[0]).not.toContain("ctrl+enter");
  });

  it("returns aborted without prompting when flowState is aborted", async () => {
    const meta = makeTestMeta({ flowState: "aborted" });
    const selectCalls: number[] = [];
    const ctx = makeCtx(meta, {
      select: async () => {
        selectCalls.push(1);
        return "Resume";
      },
    });
    const config = makeTestConfig();

    await promptDecisionMenu(ctx, meta, config);
    // No select call (aborted → null menu → return early)
    expect(selectCalls.length).toBe(0);
  });
});
