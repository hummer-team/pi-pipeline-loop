import { describe, it, expect } from "bun:test";
import { buildRuntimeCtx } from "../../core/runtime-ctx";

/**
 * Minimal mocks for ExtensionAPI and ExtensionContext.
 */
function makeMocks() {
  const appended: unknown[] = [];
  const pi = {
    appendEntry: (_type: string, data: unknown) => { appended.push(data); },
  } as any;

  const ctx = {
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
    },
  } as any;

  return { pi, ctx, appended };
}

describe("buildRuntimeCtx", () => {
  it("creates RuntimeCtx with session and ui from ExtensionContext", () => {
    const { pi, ctx } = makeMocks();
    const rctx = buildRuntimeCtx(pi, ctx);

    expect(rctx.session).toBeDefined();
    expect(typeof rctx.session.getMeta).toBe("function");
    expect(typeof rctx.session.updateMeta).toBe("function");
    expect(rctx.ui).toBeDefined();
    expect(rctx._ctx).toBeDefined();
    expect(rctx._ctx).toBe(ctx);
    expect(rctx.toolCall).toBeUndefined();
    expect(rctx.result).toBeUndefined();
  });

  it("maps tool_call event to toolCall property", () => {
    const { pi, ctx } = makeMocks();
    const event = {
      type: "tool_call",
      toolName: "bash",
      input: { command: "ls -la" },
    };
    const rctx = buildRuntimeCtx(pi, ctx, event);

    expect(rctx.toolCall).toBeDefined();
    expect(rctx.toolCall!.name).toBe("bash");
    expect(rctx.toolCall!.arguments).toEqual({ command: "ls -la" });
    expect(rctx.result).toBeUndefined();
  });

  it("maps tool_result event to toolCall + result properties", () => {
    const { pi, ctx } = makeMocks();
    const event = {
      type: "tool_result",
      toolName: "bash",
      input: { command: "npm test" },
      isError: false,
    };
    const rctx = buildRuntimeCtx(pi, ctx, event);

    expect(rctx.toolCall).toBeDefined();
    expect(rctx.toolCall!.name).toBe("bash");
    expect(rctx.toolCall!.arguments).toEqual({ command: "npm test" });
    expect(rctx.result).toBeDefined();
    expect(rctx.result!.success).toBe(true);
    expect(rctx.result!.exitCode).toBe(0);
  });

  it("maps tool_result with isError=true to failure", () => {
    const { pi, ctx } = makeMocks();
    const event = {
      type: "tool_result",
      toolName: "bash",
      input: { command: "failing-command" },
      isError: true,
    };
    const rctx = buildRuntimeCtx(pi, ctx, event);

    expect(rctx.result).toBeDefined();
    expect(rctx.result!.success).toBe(false);
    expect(rctx.result!.exitCode).toBe(1);
  });

  it("handles event without toolName gracefully", () => {
    const { pi, ctx } = makeMocks();
    const event = { type: "session_start", reason: "startup" };
    const rctx = buildRuntimeCtx(pi, ctx, event);

    expect(rctx.toolCall).toBeUndefined();
    expect(rctx.result).toBeUndefined();
  });

  it("handles undefined event gracefully", () => {
    const { pi, ctx } = makeMocks();
    const rctx = buildRuntimeCtx(pi, ctx);

    expect(rctx.toolCall).toBeUndefined();
    expect(rctx.result).toBeUndefined();
  });

  it("handles tool_result with missing input", () => {
    const { pi, ctx } = makeMocks();
    const event = {
      type: "tool_result",
      toolName: "read",
      isError: false,
    };
    const rctx = buildRuntimeCtx(pi, ctx, event);

    expect(rctx.toolCall).toBeDefined();
    expect(rctx.toolCall!.name).toBe("read");
    expect(rctx.toolCall!.arguments).toEqual({});
  });
});
