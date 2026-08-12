import { describe, it, expect } from "bun:test";
import { createSessionState, extractAssistantMessages, PIPELINE_META_CUSTOM_TYPE } from "../../core/session-state";
import type { SessionMeta } from "../../types";
import { makeTestMeta } from "../helpers";

/**
 * Minimal mock of ExtensionContext.sessionManager for testing SessionState.
 */
function makeMockSessionManager(entries: unknown[] = []) {
  return {
    getEntries: () => entries as any[],
    getBranch: () => entries as any[],
  };
}

/**
 * Minimal mock of ExtensionAPI for testing SessionState.
 */
function makeMockPi() {
  const appended: Array<{ customType: string; data: unknown }> = [];
  return {
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
    },
    appended,
  };
}

describe("SessionState", () => {
  describe("getMeta", () => {
    it("returns undefined when no pipeline meta entries exist", () => {
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager([]) } as any;
      const state = createSessionState(pi as any, ctx);

      expect(state.getMeta()).toBeUndefined();
    });

    it("returns undefined when entries exist but none match pipeline custom type", () => {
      const entries = [
        { type: "custom", customType: "other-type", data: { foo: "bar" } },
        { type: "message", message: { role: "user", content: "hello" } },
      ];
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
      const state = createSessionState(pi as any, ctx);

      expect(state.getMeta()).toBeUndefined();
    });

    it("returns the latest pipeline meta entry when multiple exist", () => {
      const meta1: Partial<SessionMeta> = { currentStage: "clarify", pipelineId: "pipe-1" } as SessionMeta;
      const meta2: Partial<SessionMeta> = { currentStage: "design", pipelineId: "pipe-1" } as SessionMeta;
      const entries = [
        { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: meta1 },
        { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: meta2 },
      ];
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
      const state = createSessionState(pi as any, ctx);

      const result = state.getMeta();
      expect(result).toBeDefined();
      expect(result!.currentStage).toBe("design");
    });
  });

  describe("updateMeta", () => {
    it("merges patch with existing meta and appends new entry", () => {
      const existing: SessionMeta = makeTestMeta({ currentStage: "clarify" });
      const entries = [
        { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: existing },
      ];
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
      const state = createSessionState(pi as any, ctx);

      const result = state.updateMeta({ currentStage: "design" });

      expect(result).toBeDefined();
      expect(result!.currentStage).toBe("design");
      expect(result!.pipelineId).toBe(existing.pipelineId); // preserved from existing
      expect(pi.appended.length).toBe(1);
      expect(pi.appended[0].customType).toBe(PIPELINE_META_CUSTOM_TYPE);
    });

    it("creates new meta when no existing entry", () => {
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager([]) } as any;
      const state = createSessionState(pi as any, ctx);

      const patch = { currentStage: "clarify" as const, pipelineId: "new-pipe" };
      const result = state.updateMeta(patch);

      expect(result).toBeDefined();
      expect(result!.currentStage).toBe("clarify");
      expect(pi.appended.length).toBe(1);
    });
  });
});

describe("extractAssistantMessages", () => {
  it("returns empty array when no entries", () => {
    const ctx = { sessionManager: makeMockSessionManager([]) } as any;
    expect(extractAssistantMessages(ctx)).toEqual([]);
  });

  it("extracts text from assistant message entries with string content", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "I'll help with that" } },
      { type: "message", message: { role: "assistant", content: "Done!" } },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const result = extractAssistantMessages(ctx);

    expect(result).toEqual(["I'll help with that", "Done!"]);
  });

  it("extracts text from assistant message entries with array content", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Part 1" },
            { type: "image", data: "..." },
            { type: "text", text: " Part 2" },
          ],
        },
      },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const result = extractAssistantMessages(ctx);

    expect(result).toEqual(["Part 1 Part 2"]);
  });

  it("skips non-message and non-assistant entries", () => {
    const entries = [
      { type: "custom", customType: "other", data: {} },
      { type: "message", message: { role: "user", content: "user message" } },
      { type: "model_change", provider: "openai", modelId: "gpt-4" },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const result = extractAssistantMessages(ctx);

    expect(result).toEqual([]);
  });
});
