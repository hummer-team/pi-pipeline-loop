import { describe, it, expect } from "bun:test";
import { detectLastRunHealth } from "../../core/session-state";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Build a mock ExtensionContext with session entries for health detection */
function makeHealthCtx(entries: unknown[]): { _ctx: ExtensionContext } {
  return {
    _ctx: {
      sessionManager: {
        getBranch: () => entries as unknown[],
        getEntries: () => entries as unknown[],
      },
    } as unknown as ExtensionContext,
  };
}

describe("detectLastRunHealth (Phase 5 / 170)", () => {
  it("returns 'clean' when no assistant messages exist", () => {
    const ctx = makeHealthCtx([]);
    const result = detectLastRunHealth(ctx._ctx);
    expect(result.kind).toBe("clean");
    expect(result.messageId).toBeUndefined();
  });

  it("returns 'truncated' when last assistant has stopReason='length'", () => {
    const entries = [
      {
        type: "message",
        id: "msg-001",
        message: { role: "assistant", content: "partial text...", stopReason: "length" },
      },
    ];
    const ctx = makeHealthCtx(entries);
    const result = detectLastRunHealth(ctx._ctx);
    expect(result.kind).toBe("truncated");
    expect(result.messageId).toBe("msg-001");
  });

  it("returns 'failed_transient' when stopReason='error' with errorMessage", () => {
    const entries = [
      {
        type: "message",
        id: "msg-002",
        message: {
          role: "assistant",
          content: "",
          stopReason: "error",
          errorMessage: "API timeout",
        },
      },
    ];
    const ctx = makeHealthCtx(entries);
    const result = detectLastRunHealth(ctx._ctx);
    expect(result.kind).toBe("failed_transient");
    expect(result.messageId).toBe("msg-002");
  });

  it("returns 'failed_transient' when stopReason='aborted' with errorMessage", () => {
    const entries = [
      {
        type: "message",
        id: "msg-003",
        message: {
          role: "assistant",
          content: "",
          stopReason: "aborted",
          errorMessage: "User cancelled",
        },
      },
    ];
    const ctx = makeHealthCtx(entries);
    const result = detectLastRunHealth(ctx._ctx);
    expect(result.kind).toBe("failed_transient");
  });

  it("returns 'clean' when last assistant has stopReason='end_turn'", () => {
    const entries = [
      {
        type: "message",
        id: "msg-004",
        message: { role: "assistant", content: "complete response", stopReason: "end_turn" },
      },
    ];
    const ctx = makeHealthCtx(entries);
    const result = detectLastRunHealth(ctx._ctx);
    expect(result.kind).toBe("clean");
    expect(result.messageId).toBe("msg-004");
  });

  it("returns 'clean' when stopReason='error' but no errorMessage", () => {
    const entries = [
      {
        type: "message",
        id: "msg-005",
        message: { role: "assistant", content: "", stopReason: "error" },
      },
    ];
    const ctx = makeHealthCtx(entries);
    const result = detectLastRunHealth(ctx._ctx);
    // No errorMessage → not classified as failed_transient
    expect(result.kind).toBe("clean");
  });

  it("scans backwards — picks the LAST assistant message, not the first", () => {
    const entries = [
      {
        type: "message",
        id: "msg-old",
        message: { role: "assistant", content: "old", stopReason: "length" },
      },
      {
        type: "message",
        id: "msg-user",
        message: { role: "user", content: "continue" },
      },
      {
        type: "message",
        id: "msg-new",
        message: { role: "assistant", content: "done", stopReason: "end_turn" },
      },
    ];
    const ctx = makeHealthCtx(entries);
    const result = detectLastRunHealth(ctx._ctx);
    expect(result.kind).toBe("clean"); // Last message is clean
    expect(result.messageId).toBe("msg-new");
  });

  it("fail-open: returns 'clean' when getBranch throws", () => {
    const ctx = {
      _ctx: {
        sessionManager: {
          getBranch: () => { throw new Error("boom"); },
          getEntries: () => [],
        },
      },
    } as unknown as { _ctx: ExtensionContext };
    const result = detectLastRunHealth(ctx._ctx);
    expect(result.kind).toBe("clean");
  });
});
