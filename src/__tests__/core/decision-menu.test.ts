import { describe, it, expect, afterEach } from "bun:test";
import {
  formatDecisionMenuHint,
  clearAllDecisionTimers,
  scheduleDecisionRetry,
  clearDecisionTimer,
  freezeAndPrompt,
  promptDecisionMenu,
} from "../../core/flow-state";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";

function makeCtx(
  meta: SessionMeta,
  ui?: { select?: (msg: string, opts: string[]) => Promise<string | undefined>; notify?: (msg: string) => void },
): FlowStateCtx {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: ui as FlowStateCtx["ui"],
  };
}

describe("Phase 6 (172): formatDecisionMenuHint", () => {
  afterEach(() => {
    clearAllDecisionTimers();
  });

  it("uses default shortcut when config has no decisionShortcutKey", () => {
    const config = makeTestConfig();
    const hint = formatDecisionMenuHint(config);
    expect(hint).toContain(DEFAULT_DECISION_SHORTCUT);
    expect(hint).toContain("Open the decision menu");
  });

  it("uses configured shortcut key", () => {
    const config = makeTestConfig({ decisionShortcutKey: "ctrl+g" });
    const hint = formatDecisionMenuHint(config);
    expect(hint).toContain("ctrl+g");
    expect(hint).not.toContain(DEFAULT_DECISION_SHORTCUT);
  });

  it("hint format is consistent", () => {
    const config = makeTestConfig({ decisionShortcutKey: "alt+f1" });
    const hint = formatDecisionMenuHint(config);
    expect(hint).toBe("Open the decision menu (press alt+f1) to proceed.");
  });
});

describe("Phase 6 (172): clearAllDecisionTimers", () => {
  afterEach(() => {
    clearAllDecisionTimers();
  });

  it("does not throw when no timers exist", () => {
    expect(() => clearAllDecisionTimers()).not.toThrow();
  });
});

// ─── Timer lifecycle tests ──────────────────────────────────────────────────

describe("Phase 6 (172): decision retry timer lifecycle", () => {
  afterEach(() => {
    clearAllDecisionTimers();
  });

  it("promptDecisionMenu returns 'cancelled' on user Esc (delayed)", async () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
    const ctx = makeCtx(meta, {
      select: async () => {
        await new Promise(r => setTimeout(r, 2000));
        return undefined;
      },
    });
    const config = makeTestConfig();

    const outcome = await promptDecisionMenu(ctx, meta, config);
    expect(outcome).toBe("cancelled");
  });

  it("promptDecisionMenu returns 'interrupted' on fast undefined (< 1500ms)", async () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
    const ctx = makeCtx(meta, {
      select: async () => undefined, // Immediate undefined (no delay)
    });
    const config = makeTestConfig();

    const outcome = await promptDecisionMenu(ctx, meta, config);
    expect(outcome).toBe("interrupted");
  });

  it("promptDecisionMenu returns 'decided' when user selects an option", async () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
    const ctx = makeCtx(meta, {
      select: async () => "Resume",
    });
    const config = makeTestConfig();

    const outcome = await promptDecisionMenu(ctx, meta, config);
    expect(outcome).toBe("decided");
    // After resume, flowState should be running
    expect(meta.flowState).toBe("running");
  });

  it("promptDecisionMenu returns 'no-menu' when aborted", async () => {
    const meta = makeTestMeta({ flowState: "aborted" });
    const ctx = makeCtx(meta);
    const config = makeTestConfig();

    const outcome = await promptDecisionMenu(ctx, meta, config);
    expect(outcome).toBe("no-menu");
  });

  it("freezeAndPrompt does NOT stack: first prompt is awaited before any retry timer", async () => {
    const meta = makeTestMeta({ flowState: "running" });
    let selectCallCount = 0;
    const ctx = makeCtx(meta, {
      select: async () => {
        selectCallCount++;
        // Simulate interrupted (fast undefined)
        return undefined;
      },
    });
    const config = makeTestConfig();

    await freezeAndPrompt(ctx, meta, "test_reason", config);

    // First prompt was called once (not stacked)
    expect(selectCallCount).toBe(1);
    expect(meta.flowState).toBe("blocked");
  });

  it("clearDecisionTimer stops retry for specific pipeline", () => {
    const meta = makeTestMeta({ pipelineId: "pipe-timer-test" });
    const ctx = makeCtx(meta);
    const config = makeTestConfig();

    scheduleDecisionRetry(ctx, meta, config);
    // Timer should be registered
    clearDecisionTimer("pipe-timer-test");
    // Clearing again should be safe (no-op)
    expect(() => clearDecisionTimer("pipe-timer-test")).not.toThrow();
  });
});

// Need to import DEFAULT_DECISION_SHORTCUT for the hint tests
import { DEFAULT_DECISION_SHORTCUT } from "../../constants";
