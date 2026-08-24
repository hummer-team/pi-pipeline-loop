import { describe, it, expect, afterEach } from "bun:test";
import { createPipelineUI, STAGE_STATUS_KEY, PROGRESS_FRAMES, DEFAULT_PROGRESS_FRAME_MS, _setNextStageGray, NEXT_STAGE_GRAY } from "../../core/pipeline-ui";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import type { PipelineConfig } from "../../types";

/** Helper: async sleep */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function makeCtx() {
  const notifications: string[] = [];
  const statusCalls: { key: string; text: string | undefined }[] = [];
  return {
    ctx: {
      ui: {
        notify: (msg: string) => { notifications.push(msg); },
        setStatus: (key: string, text: string | undefined) => { statusCalls.push({ key, text }); },
      },
    },
    notifications,
    statusCalls,
  };
}

describe("createPipelineUI", () => {
  describe("output.pipelineStage: false (default)", () => {
    it("all methods are no-ops", () => {
      const config = makeTestConfig({ output: { pipelineStage: false } });
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.notify(ctx, "test");
      ui.setStage(ctx, "label");
      ui.clearStage(ctx);
      ui.stageEntry(ctx, "clarify");
      ui.transition(ctx, "plan", "plan");
      ui.fail(ctx, "plan", "verify failed");

      expect(notifications).toEqual([]);
      expect(statusCalls).toEqual([]);
    });

    it("no-op when ctx has no ui", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      // ctx without ui — should not throw
      expect(() => ui.notify({}, "test")).not.toThrow();
      expect(() => ui.stageEntry({}, "clarify")).not.toThrow();
      expect(() => ui.transition({}, "a", "b")).not.toThrow();
      expect(() => ui.fail({}, "plan", "reason")).not.toThrow();
      expect(() => ui.setStage({}, "label")).not.toThrow();
      expect(() => ui.clearStage({})).not.toThrow();
    });

    it("no-op when output is undefined", () => {
      const config = makeTestConfig();
      delete (config as any).output;
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.stageEntry(ctx, "clarify");
      expect(notifications).toEqual([]);
      expect(statusCalls).toEqual([]);
    });
  });

  describe("output.pipelineStage: true", () => {
    it("stageEntry produces 'Pipeline → {stage}' + setStatus", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.stageEntry(ctx, "clarify");

      expect(notifications).toEqual(["Pipeline → clarify"]);
      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "Pipeline → clarify" }]);
    });

    it("transition produces formatted output for 'to' stage + setStatus", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.transition(ctx, "clarify", "plan");

      // Without meta, falls back to "Pipeline → {to}"
      expect(notifications).toEqual(["Pipeline → plan"]);
      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "Pipeline → plan" }]);
    });

    it("fail produces 'Pipeline → {stage} ⚠ {reason}' + setStatus", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.fail(ctx, "plan", "verify failed");

      expect(notifications).toEqual(["Pipeline → plan ⚠ verify failed"]);
      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "Pipeline → plan ⚠ verify failed" }]);
    });

    it("notify produces message + no setStatus", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.notify(ctx, "hello");

      expect(notifications).toEqual(["hello"]);
      expect(statusCalls).toEqual([]);
    });

    it("setStage formats stage name via formatStage", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, statusCalls } = makeCtx();

      // Without meta, formatStage falls back to "Pipeline → {stage}"
      ui.setStage(ctx, "working...");

      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "Pipeline → working..." }]);
    });

    it("clearStage clears status bar (undefined)", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, statusCalls } = makeCtx();

      ui.clearStage(ctx);

      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: undefined }]);
    });
  });

  describe("progress lifecycle", () => {
    // Track all timers to clean up after each test
    let pendingUIs: ReturnType<typeof createPipelineUI>[] = [];

    afterEach(() => {
      // Clean up any dangling progress timers
      for (const ui of pendingUIs) {
        ui.progressEnd({ ui: { setStatus: () => {} } });
      }
      pendingUIs = [];
    });

    it("pipelineStage: false → all progress methods are no-op", async () => {
      const config = makeTestConfig({ output: { pipelineStage: false } });
      const ui = createPipelineUI(config);
      const { ctx, statusCalls } = makeCtx();

      ui.progressStart(ctx, "init");
      ui.progressUpdate(ctx, "(design)");
      ui.progressEnd(ctx);

      expect(statusCalls).toEqual([]);
    });

    it("pipelineStage: true → progressStart immediately writes first frame", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      pendingUIs.push(ui);
      const { ctx, statusCalls } = makeCtx();

      ui.progressStart(ctx, "init", undefined, 50);

      expect(statusCalls.length).toBe(1);
      expect(statusCalls[0].key).toBe(STAGE_STATUS_KEY);
      expect(statusCalls[0].text).toBe(`Pipeline → init ${PROGRESS_FRAMES[0]}`);
    });

    it("pipelineStage: true → animation advances frames over time", async () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      pendingUIs.push(ui);
      const { ctx, statusCalls } = makeCtx();

      ui.progressStart(ctx, "init", undefined, 5);
      await sleep(30);

      // Should have ≥2 setStatus calls (first frame + at least one interval tick)
      expect(statusCalls.length).toBeGreaterThanOrEqual(2);
      // Frames should differ (animation advanced)
      const texts = statusCalls.map(c => c.text);
      const uniqueTexts = new Set(texts);
      expect(uniqueTexts.size).toBeGreaterThanOrEqual(2);
      // All texts should contain "Pipeline → init"
      for (const t of texts) {
        expect(t).toContain("Pipeline → init");
      }
    });

    it("progressUpdate updates message and synchronously re-renders", async () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      pendingUIs.push(ui);
      const { ctx, statusCalls } = makeCtx();

      ui.progressStart(ctx, "init", undefined, 10000); // long interval to prevent auto-advance
      const beforeCount = statusCalls.length;

      ui.progressUpdate(ctx, "(design)");

      // Should have one additional setStatus call
      expect(statusCalls.length).toBe(beforeCount + 1);
      const lastCall = statusCalls[statusCalls.length - 1];
      expect(lastCall.text).toContain("Pipeline → init");
      expect(lastCall.text).toContain("(design)");
      expect(lastCall.text).toContain(PROGRESS_FRAMES[0]); // first frame (no advance with 10s interval)
    });

    it("progressEnd stops animation and writes base text without frame", async () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      pendingUIs.push(ui);
      const { ctx, statusCalls } = makeCtx();

      ui.progressStart(ctx, "init", undefined, 5);
      await sleep(20);

      ui.progressEnd(ctx);

      // Last setStatus should be base text (no frame)
      const lastCall = statusCalls[statusCalls.length - 1];
      expect(lastCall.text).toBe("Pipeline → init");

      // Wait a bit more — no new setStatus calls after progressEnd
      const countAfterEnd = statusCalls.length;
      await sleep(30);
      expect(statusCalls.length).toBe(countAfterEnd);
    });

    it("progressStart repeated calls don't create double timers", async () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      pendingUIs.push(ui);
      const { ctx, statusCalls } = makeCtx();

      ui.progressStart(ctx, "init", undefined, 5);
      await sleep(15);

      // Call progressStart again — should clear old timer
      ui.progressStart(ctx, "plan", undefined, 5);
      await sleep(30);

      // End and check no dangling timers
      ui.progressEnd(ctx);
      const countAfterEnd = statusCalls.length;
      await sleep(30);
      expect(statusCalls.length).toBe(countAfterEnd);

      // Verify second label was used
      expect(statusCalls.some(c => c.text?.includes("Pipeline → plan"))).toBe(true);
    });

    it("ctx without ui → progress methods don't throw", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      pendingUIs.push(ui);

      expect(() => ui.progressStart({}, "init")).not.toThrow();
      expect(() => ui.progressUpdate({}, "(design)")).not.toThrow();
      expect(() => ui.progressEnd({})).not.toThrow();
    });

    it("exports: PROGRESS_FRAMES and DEFAULT_PROGRESS_FRAME_MS are correct", () => {
      expect(PROGRESS_FRAMES.length).toBe(10);
      expect(DEFAULT_PROGRESS_FRAME_MS).toBe(120);
    });
  });

  describe("unified format (Phase 4)", () => {
    it("with meta + nextStage → [ {pipelineId} • {stage} -> {nextStage} ] with ANSI gray", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = createMockCtx(meta);

      ui.stageEntry(ctx, "clarify");

      const grayOpen = "\x1b[90m";
      const grayClose = "\x1b[0m";
      const expected = `[ pipe-test-001 • clarify ${grayOpen}-> plan${grayClose} ]`;
      expect(ctx.statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: expected }]);
      expect(ctx.notifications).toEqual([expected]);
    });

    it("with meta + nextStage=null (completed) → [ {pipelineId} • {stage} ] (no arrow)", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const meta = makeTestMeta({ currentStage: "completed" });
      const ctx = createMockCtx(meta);

      ui.stageEntry(ctx, "completed");

      const expected = "[ pipe-test-001 • completed ]";
      expect(ctx.statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: expected }]);
    });

    it("without meta → fallback 'Pipeline → {stage}'", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      // ctx without session.getMeta
      const ctx = { ui: { notify: () => {}, setStatus: () => {} } };
      const statusCalls: { key: string; text: string }[] = [];
      const ctxWithCapture = {
        ui: {
          notify: () => {},
          setStatus: (key: string, text: string) => { statusCalls.push({ key, text }); },
        },
      };

      ui.stageEntry(ctxWithCapture, "init");

      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "Pipeline → init" }]);
    });

    it("fail with meta → [ {pipelineId} • {stage} ] ⚠ {reason}", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = createMockCtx(meta);

      ui.fail(ctx, "develop", "verify failed");

      const expected = "[ pipe-test-001 • develop ] ⚠ verify failed";
      expect(ctx.statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: expected }]);
      expect(ctx.notifications).toEqual([expected]);
    });

    it("NEXT_STAGE_GRAY=false → pure text fallback without ANSI codes", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = createMockCtx(meta);

      // Temporarily disable gray styling
      _setNextStageGray(false);
      try {
        ui.stageEntry(ctx, "clarify");

        // Output should contain "-> plan" without any ANSI escape codes
        const expected = "[ pipe-test-001 • clarify -> plan ]";
        expect(ctx.statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: expected }]);
        expect(ctx.notifications).toEqual([expected]);
        // Verify no ANSI gray codes present
        expect(expected).not.toContain("\x1b[90m");
        expect(expected).not.toContain("\x1b[0m");
      } finally {
        // Restore original value
        _setNextStageGray(true);
      }
    });
  });
});
