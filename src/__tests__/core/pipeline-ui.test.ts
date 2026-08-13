import { describe, it, expect, afterEach } from "bun:test";
import { createPipelineUI, STAGE_STATUS_KEY, PROGRESS_FRAMES, DEFAULT_PROGRESS_FRAME_MS } from "../../core/pipeline-ui";
import { makeTestConfig } from "../helpers";
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
      ui.transition(ctx, "design", "plan");
      ui.fail(ctx, "design", "verify failed");

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
      expect(() => ui.fail({}, "design", "reason")).not.toThrow();
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

    it("transition produces '{from} → {to}' + setStatus", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.transition(ctx, "design", "plan");

      expect(notifications).toEqual(["design → plan"]);
      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "design → plan" }]);
    });

    it("fail produces '{stage} ⚠ {reason}' + setStatus", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.fail(ctx, "design", "verify failed");

      expect(notifications).toEqual(["design ⚠ verify failed"]);
      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "design ⚠ verify failed" }]);
    });

    it("notify produces message + no setStatus", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, notifications, statusCalls } = makeCtx();

      ui.notify(ctx, "hello");

      expect(notifications).toEqual(["hello"]);
      expect(statusCalls).toEqual([]);
    });

    it("setStage sets status bar text", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, statusCalls } = makeCtx();

      ui.setStage(ctx, "working...");

      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "working..." }]);
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
      ui.progressStart(ctx, "design", undefined, 5);
      await sleep(30);

      // End and check no dangling timers
      ui.progressEnd(ctx);
      const countAfterEnd = statusCalls.length;
      await sleep(30);
      expect(statusCalls.length).toBe(countAfterEnd);

      // Verify second label was used
      expect(statusCalls.some(c => c.text?.includes("Pipeline → design"))).toBe(true);
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
});
