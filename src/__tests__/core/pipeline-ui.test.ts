import { describe, it, expect } from "bun:test";
import { createPipelineUI, STAGE_STATUS_KEY } from "../../core/pipeline-ui";
import { makeTestConfig } from "../helpers";
import type { PipelineConfig } from "../../types";

function makeCtx() {
  const notifications: string[] = [];
  const statusCalls: { key: string; text: string }[] = [];
  return {
    ctx: {
      ui: {
        notify: (msg: string) => { notifications.push(msg); },
        setStatus: (key: string, text: string) => { statusCalls.push({ key, text }); },
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

    it("clearStage clears status bar (empty string)", () => {
      const config = makeTestConfig({ output: { pipelineStage: true } });
      const ui = createPipelineUI(config);
      const { ctx, statusCalls } = makeCtx();

      ui.clearStage(ctx);

      expect(statusCalls).toEqual([{ key: STAGE_STATUS_KEY, text: "" }]);
    });
  });
});
