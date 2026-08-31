import { describe, it, expect, beforeEach } from "bun:test";
import { maybeCompactOnPipelineCompleted } from "../../core/terminal-compact";
import type { TerminalCompactCtx } from "../../core/terminal-compact";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { DEFAULT_COMPACT_INSTRUCTIONS } from "../../constants";

/**
 * Creates a mock TerminalCompactCtx for testing.
 * All mock functions are configurable and trackable.
 */
function makeCompactCtx(
  meta: SessionMeta,
  opts?: {
    isIdle?: () => boolean;
    compact?: (cb: { customInstructions: string; onComplete: (r: unknown) => void; onError: (e: Error) => void }) => void;
    getContextUsage?: () => { tokens: number | null } | undefined;
  },
): TerminalCompactCtx & {
  updates: Partial<SessionMeta>[];
  notifications: string[];
} {
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
    ui: {
      notify: (msg: string) => { notifications.push(msg); },
    },
    _ctx: {
      isIdle: opts?.isIdle,
      compact: opts?.compact as TerminalCompactCtx["_ctx"]["compact"],
      getContextUsage: opts?.getContextUsage,
    },
    updates,
    notifications,
  };
}

describe("maybeCompactOnPipelineCompleted", () => {
  let config: PipelineConfig;

  beforeEach(() => {
    config = makeTestConfig();
  });

  // ─── No-consume guards ──────────────────────────────────────────────────────

  describe("no-consume guards (zero side effects)", () => {
    it("returns early when compact.enabled === false", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta);
      const disabledConfig = makeTestConfig({ compact: { enabled: false } });

      await maybeCompactOnPipelineCompleted(ctx, disabledConfig);

      expect(ctx.updates.length).toBe(0);
    });

    it("returns early when currentStage is not completed", async () => {
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = makeCompactCtx(meta);

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(ctx.updates.length).toBe(0);
    });

    it("returns early when terminalCompact is already set (compacted)", async () => {
      const meta = makeTestMeta({
        currentStage: "completed",
        terminalCompact: { outcome: "compacted", at: Date.now() },
      });
      const ctx = makeCompactCtx(meta);

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(ctx.updates.length).toBe(0);
    });

    it("returns early when terminalCompact is already set (failed)", async () => {
      const meta = makeTestMeta({
        currentStage: "completed",
        terminalCompact: { outcome: "failed", at: Date.now(), error: "test" },
      });
      const ctx = makeCompactCtx(meta);

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(ctx.updates.length).toBe(0);
    });

    it("returns early when terminalCompact is already set (skipped_below_threshold)", async () => {
      const meta = makeTestMeta({
        currentStage: "completed",
        terminalCompact: { outcome: "skipped_below_threshold", at: Date.now() },
      });
      const ctx = makeCompactCtx(meta);

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(ctx.updates.length).toBe(0);
    });

    it("returns silently when isIdle returns false (busy)", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta, { isIdle: () => false });

      await maybeCompactOnPipelineCompleted(ctx, config);

      // No updateMeta, no audit (silent return)
      expect(ctx.updates.length).toBe(0);
    });
  });

  // ─── Skip without consume ───────────────────────────────────────────────────

  describe("skip without consume", () => {
    it("skips when compact is unavailable (no _ctx.compact)", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta);
      // No compact function provided
      ctx._ctx.compact = undefined;

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(ctx.updates.length).toBe(0);
    });

    it("skips when tokens is null (usage unknown)", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta, {
        compact: () => {},
        getContextUsage: () => ({ tokens: null }),
      });

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(ctx.updates.length).toBe(0);
    });

    it("skips when tokens is undefined (usage unknown)", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta, {
        compact: () => {},
        getContextUsage: () => undefined,
      });

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(ctx.updates.length).toBe(0);
    });
  });

  // ─── Below threshold (consumes) ─────────────────────────────────────────────

  describe("below threshold (consumes)", () => {
    it("consumes and sets skipped_below_threshold when tokens < threshold", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta, {
        compact: () => {},
        getContextUsage: () => ({ tokens: 50_000 }),
      });

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(meta.terminalCompact).toBeDefined();
      expect(meta.terminalCompact?.outcome).toBe("skipped_below_threshold");
      expect(meta.terminalCompact?.tokensBefore).toBe(50_000);
    });

    it("uses custom threshold from config", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta, {
        compact: () => {},
        getContextUsage: () => ({ tokens: 30_000 }),
      });
      const customConfig = makeTestConfig({ compact: { tokenThreshold: 50_000 } });

      await maybeCompactOnPipelineCompleted(ctx, customConfig);

      expect(meta.terminalCompact?.outcome).toBe("skipped_below_threshold");
    });
  });

  // ─── Success path ───────────────────────────────────────────────────────────

  describe("success path", () => {
    it("calls compact and sets outcome=compacted on success", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      let compactCalled = false;
      const ctx = makeCompactCtx(meta, {
        compact: (opts) => {
          compactCalled = true;
          // Simulate async completion
          setTimeout(() => opts.onComplete({
            tokensBefore: 150_000,
            estimatedTokensAfter: 20_000,
          }), 0);
        },
        getContextUsage: () => ({ tokens: 150_000 }),
      });

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(compactCalled).toBe(true);
      expect(meta.terminalCompact?.outcome).toBe("compacted");
      expect(meta.terminalCompact?.tokensBefore).toBe(150_000);
      expect(meta.terminalCompact?.tokensAfter).toBe(20_000);
    });

    it("uses DEFAULT_COMPACT_INSTRUCTIONS when no custom instructions configured", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      let receivedInstructions = "";
      const ctx = makeCompactCtx(meta, {
        compact: (opts) => {
          receivedInstructions = opts.customInstructions;
          setTimeout(() => opts.onComplete({ tokensBefore: 200_000 }), 0);
        },
        getContextUsage: () => ({ tokens: 200_000 }),
      });

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(receivedInstructions).toBe(DEFAULT_COMPACT_INSTRUCTIONS);
    });

    it("uses custom instructions when configured", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      let receivedInstructions = "";
      const customInstructions = "Keep this specific text verbatim.";
      const ctx = makeCompactCtx(meta, {
        compact: (opts) => {
          receivedInstructions = opts.customInstructions;
          setTimeout(() => opts.onComplete({ tokensBefore: 200_000 }), 0);
        },
        getContextUsage: () => ({ tokens: 200_000 }),
      });
      const customConfig = makeTestConfig({ compact: { customInstructions } });

      await maybeCompactOnPipelineCompleted(ctx, customConfig);

      expect(receivedInstructions).toBe(customInstructions);
    });
  });

  // ─── Failure paths ──────────────────────────────────────────────────────────

  describe("failure paths (consumes, notifies)", () => {
    it("handles onError callback as failure", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta, {
        compact: (opts) => {
          setTimeout(() => opts.onError(new Error("Already compacted")), 0);
        },
        getContextUsage: () => ({ tokens: 200_000 }),
      });

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(meta.terminalCompact?.outcome).toBe("failed");
      expect(meta.terminalCompact?.error).toBe("Already compacted");
      expect(ctx.notifications.length).toBe(1);
      expect(ctx.notifications[0]).toContain("Already compacted");
      expect(ctx.notifications[0]).toContain("/compact");
    });

    it("handles synchronous throw as failure", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta, {
        compact: () => { throw new Error("Nothing to compact"); },
        getContextUsage: () => ({ tokens: 200_000 }),
      });

      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(meta.terminalCompact?.outcome).toBe("failed");
      expect(meta.terminalCompact?.error).toBe("Nothing to compact");
      expect(ctx.notifications[0]).toContain("/compact");
    });

    it("does not re-notify after failure (consumed flag)", async () => {
      const meta = makeTestMeta({
        currentStage: "completed",
        terminalCompact: { outcome: "failed", at: Date.now(), error: "previous" },
      });
      const ctx = makeCompactCtx(meta, {
        compact: () => {},
        getContextUsage: () => ({ tokens: 200_000 }),
      });

      await maybeCompactOnPipelineCompleted(ctx, config);

      // No new notifications (guard returns early)
      expect(ctx.notifications.length).toBe(0);
    });

    it("helper never throws to caller even on unexpected error", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = makeCompactCtx(meta, {
        compact: () => { throw new Error("catastrophic"); },
        getContextUsage: () => { throw new Error("also broken"); },
      });

      // Should not throw
      await expect(maybeCompactOnPipelineCompleted(ctx, config)).resolves.toBeUndefined();
    });
  });

  // ─── Exactly-once guarantee ─────────────────────────────────────────────────

  describe("exactly-once guarantee", () => {
    it("second call is a no-op after successful compaction", async () => {
      const meta = makeTestMeta({ currentStage: "completed" });
      let compactCallCount = 0;
      const ctx = makeCompactCtx(meta, {
        compact: (opts) => {
          compactCallCount++;
          setTimeout(() => opts.onComplete({ tokensBefore: 200_000 }), 0);
        },
        getContextUsage: () => ({ tokens: 200_000 }),
      });

      await maybeCompactOnPipelineCompleted(ctx, config);
      await maybeCompactOnPipelineCompleted(ctx, config);

      expect(compactCallCount).toBe(1);
    });
  });
});
