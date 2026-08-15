import { describe, it, expect, beforeEach } from "bun:test";
import {
  getFlowState,
  isFrozen,
  buildDecisionMenu,
  executeDecision,
  freezeAndPrompt,
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
      "继续尝试",
      "跳过",
      "回退上一阶段",
      "终止并重开",
      "终止并退出",
    ]);
  });

  it("returns 5 items for awaiting_human stage", () => {
    const meta = makeTestMeta({ currentStage: "awaiting_human" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toHaveLength(5);
    expect(menu).toContain("继续尝试");
  });

  it("returns 2 items for running state", () => {
    const meta = makeTestMeta({ flowState: "running" });
    const menu = buildDecisionMenu(meta);
    expect(menu).toEqual(["终止并重开", "终止并退出"]);
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
        return "终止并退出"; // abort
      },
      notify: (_msg: string) => {},
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    expect(selectCalled).toBe(true);
    // Should have flowState=blocked from freeze, then aborted from executeDecision
    expect(meta.flowState).toBe("aborted");
  });

  it("with UI select: user presses Esc → stays blocked + notify shortcut", async () => {
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
    expect(notifications[0]).toContain("ctrl+d");
  });

  it("without UI: keeps blocked, no crash", async () => {
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
    expect(notifications[0]).toContain("ctrl+d");
  });

  it("without any UI: no crash, stays blocked", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const ctx = makeCtx(meta); // no UI at all
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "some_reason", config);

    expect(meta.flowState).toBe("blocked");
  });

  it("uses custom shortcut key from config", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    const notifications: string[] = [];
    const ctx = makeCtx(meta, {
      notify: (msg: string) => { notifications.push(msg); },
    });
    const config = makeTestConfig({ decisionShortcutKey: "alt+f" });

    await freezeAndPrompt(ctx, meta, "test_reason", config);

    expect(notifications[0]).toContain("alt+f");
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
        select: async () => { optsUiSelectCalled.push(true); return "终止并退出"; },
        notify: () => {},
      },
    });

    expect(ctxUiSelectCalled.length).toBe(0);
    expect(optsUiSelectCalled.length).toBe(1);
  });
});
