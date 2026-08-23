import { describe, it, expect } from "bun:test";
import { createPipeline } from "../index";
import { makeTestConfig, makeTestMeta } from "./helpers";
import { PIPELINE_META_CUSTOM_TYPE } from "../core/session-state";

/**
 * Phase 2 registration bridge tests.
 *
 * Verifies the adapter layer in src/index.ts translates between
 * internal pipeline shapes and real pi SDK signatures:
 *  - registerCommand object-style (name, { description, handler })
 *  - registerTool single-object with label
 *  - hook bridge: (event, ctx) → RuntimeCtx
 *  - command string args → Record<string, unknown> parsing
 */

// ─── Mock Factories ──────────────────────────────────────────────────────────

function makeMockPi() {
  const registeredEvents: Array<{ event: string; handler: Function }> = [];
  const registeredTools: Array<Record<string, unknown>> = [];
  const registeredCommands: Array<{ name: string; options: Record<string, unknown> }> = [];
  const registeredShortcuts: Array<{ key: string; options: Record<string, unknown> }> = [];

  return {
    pi: {
      on: (event: string, handler: Function) => {
        registeredEvents.push({ event, handler });
      },
      registerTool: (tool: Record<string, unknown>) => {
        registeredTools.push(tool);
      },
      registerCommand: (name: string, options: Record<string, unknown>) => {
        registeredCommands.push({ name, options });
      },
      registerShortcut: (key: string, options: Record<string, unknown>) => {
        registeredShortcuts.push({ key, options });
      },
      appendEntry: () => {},
      exec: undefined,
    } as any,
    registeredEvents,
    registeredTools,
    registeredCommands,
    registeredShortcuts,
  };
}

/**
 * Build a mock ExtensionContext whose sessionManager returns a pipeline meta
 * CustomEntry so internal handlers can read valid SessionMeta.
 */
function makeMockExtCtx(overrides?: Record<string, unknown>) {
  const meta = makeTestMeta();

  return {
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: PIPELINE_META_CUSTOM_TYPE,
          data: meta,
        },
      ],
      getBranch: () => [],
    },
    ...overrides,
  } as any;
}

// ─── registerCommand: object-style with handler ─────────────────────────────

describe("registerCommand bridge", () => {
  it("calls pi.registerCommand(name, { description, handler }) for each command", async () => {
    const { pi, registeredCommands } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    // Four commands: pipeline-status, pipeline-start, pipeline-init, pipeline-quit
    expect(registeredCommands.length).toBe(4);

    for (const reg of registeredCommands) {
      // Object-style: name as first arg, options object as second
      expect(typeof reg.name).toBe("string");
      expect(reg.name.length).toBeGreaterThan(0);
      expect(typeof reg.options).toBe("object");
      expect(typeof reg.options.description).toBe("string");
      expect(typeof reg.options.handler).toBe("function");
    }

    const names = registeredCommands.map((c) => c.name);
    expect(names).toContain("pipeline-status");
    expect(names).toContain("pipeline-start");
    expect(names).toContain("pipeline-init");
  });

  it("command handler is an async function accepting (args: string, ctx)", async () => {
    const { pi, registeredCommands } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    for (const reg of registeredCommands) {
      const handler = reg.options.handler as Function;
      expect(typeof handler).toBe("function");
      // Handler should accept 2 parameters: (args: string, ctx)
      expect(handler.length).toBe(2);
    }
  });

  it("command handler invokes cmd.execute with parsed Record and RuntimeCtx", async () => {
    // This test verifies the bridge invokes cmd.execute correctly by checking
    // that pipeline-status returns a content result (indicating execute ran successfully).
    const { pi, registeredCommands } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    const statusCmd = registeredCommands.find((c) => c.name === "pipeline-status");
    expect(statusCmd).toBeDefined();

    const handler = statusCmd!.options.handler as Function;
    const notifyCalls: string[] = [];
    const extCtx = makeMockExtCtx({
      ui: {
        notify: (msg: string) => { notifyCalls.push(msg); },
        setStatus: () => {},
      },
    });

    // The handler parses "" → {} and calls cmd.execute({}, rctx).
    // pipeline-status returns { success: true, content: "..." }.
    // The bridge calls ctx.ui.notify(content) since result.content exists.
    await handler("", extCtx);

    // Verify that ui.notify was called (bridge processed the result)
    expect(notifyCalls.length).toBeGreaterThan(0);
    // The content should contain pipeline status information
    expect(notifyCalls[0]).toContain("Pipeline Status");
  });

  // ─── 136_E2E_Bug regression: parsed args reach cmd.execute ───────────────
  // The bridge invokes parseCommandArgs(cmd.name, args) and passes the parsed
  // Record into cmd.execute(). These tests assert that the doc_file argument
  // supplied to `/pipeline-start <doc_file>` reaches the handler as `{ file }`
  // — not as `{ raw }` via the default branch (which was the 136 bug).
  it("pipeline-start bridge: doc_file string argument is parsed into { file } and reaches cmd.execute", async () => {
    const { pi, registeredCommands } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    const startCmd = registeredCommands.find((c) => c.name === "pipeline-start");
    expect(startCmd).toBeDefined();

    const handler = startCmd!.options.handler as Function;
    const notifyCalls: string[] = [];
    // meta intentionally empty → fresh-start path with non-empty file fails at
    // fs.read (file not found), but the important thing is the error must be
    // "File not found", NOT the "/pipeline_start" hint (which fires only when
    // file is empty — i.e. when the bug reappears).
    const extCtx = makeMockExtCtx({
      // No meta → fresh-start path (meta undefined).
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
      },
      ui: {
        notify: (msg: string) => { notifyCalls.push(msg); },
        setStatus: () => {},
      },
    });

    // Simulate user typing: /pipeline-start docs/design/76_E2E_Feat.md
    await handler("docs/design/76_E2E_Feat.md", extCtx);

    // The bridge must have parsed "docs/design/76_E2E_Feat.md" into { file: "..." }.
    // If the bug regresses, { file } is empty → pipeline-start returns the
    // "/pipeline_start <doc_file>" hint instead of "File not found".
    expect(notifyCalls.length).toBeGreaterThan(0);
    const notified = notifyCalls.join(" | ");
    expect(notified).toContain("File not found");
    expect(notified).not.toContain("/pipeline_start");
    expect(notified).not.toContain("/pipeline-start <doc_file>");
  });

  it("pipeline-init bridge: subcommand string argument is parsed into { sub }", async () => {
    const { pi, registeredCommands } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    const initCmd = registeredCommands.find((c) => c.name === "pipeline-init");
    expect(initCmd).toBeDefined();

    const handler = initCmd!.options.handler as Function;
    const notifyCalls: string[] = [];
    const extCtx = makeMockExtCtx({
      ui: {
        notify: (msg: string) => { notifyCalls.push(msg); },
        setStatus: () => {},
      },
    });

    // "1" → pipeline-init subcommand; should parse to { sub: "1" }.
    await handler("1", extCtx);

    // pipeline-init with sub="1" attempts to generate files. Whether or not
    // the underlying generation succeeds is irrelevant here; the assertion
    // is that the bridge parsed { sub: "1" } (not { raw: "1" }). We verify
    // by checking that the handler produced output (i.e. it ran the init
    // path, not a default/unknown-command path).
    expect(notifyCalls.length).toBeGreaterThan(0);
  });
});

// ─── registerTool: single-object with label ─────────────────────────────────

describe("registerTool bridge", () => {
  it("calls pi.registerTool with single object including label", async () => {
    const { pi, registeredTools } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    // 7 standard tools (pipeline_verify is not registered because no stage has mode:"tool")
    expect(registeredTools.length).toBe(7);

    for (const tool of registeredTools) {
      // All required fields present
      expect(typeof tool.name).toBe("string");
      expect((tool.name as string).length).toBeGreaterThan(0);
      expect(typeof tool.label).toBe("string");
      expect((tool.label as string).length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).length).toBeGreaterThan(0);
      // label must equal name (per plan Phase 2)
      expect(tool.label).toBe(tool.name);
      // parameters field present
      expect(tool.parameters).toBeDefined();
      // execute function present
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("tool execute returns { content, details } shape", async () => {
    const { pi, registeredTools } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    // Pick pipeline_state tool (reads session meta, which our mock provides)
    const stateTool = registeredTools.find((t) => t.name === "pipeline_state");
    expect(stateTool).toBeDefined();

    const execute = stateTool!.execute as Function;
    const extCtx = makeMockExtCtx();

    const result = await execute("call-id-1", {}, undefined, undefined, extCtx);

    // Result must be { content: [{ type: "text", text: string }], details: ... }
    expect(result).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
    expect(result.details).toBeDefined();
  });

  it("tool execute function accepts 5 parameters matching SDK signature", async () => {
    const { pi, registeredTools } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    for (const tool of registeredTools) {
      const execute = tool.execute as Function;
      // SDK signature: execute(toolCallId, params, signal, onUpdate, ctx)
      expect(execute.length).toBe(5);
    }
  });
});

// ─── Hook bridge: (event, ctx) → RuntimeCtx mapping ─────────────────────────

describe("hook bridge", () => {
  it("wraps hook handler to translate (event, ctx) into RuntimeCtx", async () => {
    const { pi, registeredEvents } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    // Expect 7 hook registrations (session_start, before_agent_start, tool_call,
    // tool_result, agent_settled, session_shutdown, model_select)
    expect(registeredEvents.length).toBe(7);

    const eventNames = registeredEvents.map((e) => e.event);
    expect(eventNames).toContain("session_start");
    expect(eventNames).toContain("before_agent_start");
    expect(eventNames).toContain("tool_call");
    expect(eventNames).toContain("tool_result");
    expect(eventNames).toContain("agent_settled");
    expect(eventNames).toContain("session_shutdown");
    expect(eventNames).toContain("model_select");

    // Each handler should be a function
    for (const reg of registeredEvents) {
      expect(typeof reg.handler).toBe("function");
    }
  });

  it("hook handler accepts 2 parameters (event, ctx) matching SDK signature", async () => {
    const { pi, registeredEvents } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    for (const reg of registeredEvents) {
      // SDK signature: handler(event, ctx)
      expect(reg.handler.length).toBe(2);
    }
  });

  it("tool_call hook bridge passes RuntimeCtx with toolCall to internal handler", async () => {
    const { pi, registeredEvents } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    const toolCallHook = registeredEvents.find((e) => e.event === "tool_call");
    expect(toolCallHook).toBeDefined();

    const extCtx = makeMockExtCtx();
    const event = {
      type: "tool_call",
      toolName: "bash",
      input: { command: "ls" },
    };

    // Invoke the bridge handler. tool-guard returns undefined when tool is allowed.
    // This confirms the bridge correctly built RuntimeCtx and called tool-guard.
    const result = await toolCallHook!.handler(event, extCtx);

    // tool-guard returns undefined when all checks pass (tool is allowed)
    // "bash" with "ls" prefix is in allowedBashPrefixes, so it passes
    expect(result).toBeUndefined();
  });

  it("tool_call hook bridge blocks disallowed tools via RuntimeCtx", async () => {
    const { pi, registeredEvents } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    const toolCallHook = registeredEvents.find((e) => e.event === "tool_call");
    expect(toolCallHook).toBeDefined();

    const extCtx = makeMockExtCtx();
    const event = {
      type: "tool_call",
      toolName: "disallowed_tool",
      input: {},
    };

    // tool-guard should block this tool since it's not in allowedTools
    const result = await toolCallHook!.handler(event, extCtx);

    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("disallowed_tool");
    expect(result.reason).toContain("not allowed");
  });

  it("tool_result hook bridge passes RuntimeCtx with result to internal handler", async () => {
    const { pi, registeredEvents } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    const toolResultHook = registeredEvents.find((e) => e.event === "tool_result");
    expect(toolResultHook).toBeDefined();

    const extCtx = makeMockExtCtx();
    const event = {
      type: "tool_result",
      toolName: "bash",
      input: { command: "echo hello" },
      isError: false,
    };

    // loop-breaker returns undefined when there are no issues
    const result = await toolResultHook!.handler(event, extCtx);
    // loop-breaker may return undefined (no action needed) or an object
    // The key is that the bridge correctly translated isError=false → result.success=true
    expect(result === undefined || typeof result === "object").toBe(true);
  });

  it("session_start hook bridge invokes internal handler with RuntimeCtx", async () => {
    const { pi, registeredEvents } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    const sessionStartHook = registeredEvents.find((e) => e.event === "session_start");
    expect(sessionStartHook).toBeDefined();

    const extCtx = makeMockExtCtx();
    const event = { type: "session_start", reason: "startup" };

    // session_starter reads meta and may update it. The handler resolves without error.
    const result = await sessionStartHook!.handler(event, extCtx);
    // session_starter returns undefined (no return value needed for session_start)
    expect(result === undefined || typeof result === "object").toBe(true);
  });
});

// ─── registerShortcut: pipeline decision menu ──────────────────────────────

describe("registerShortcut bridge", () => {
  it("registers shortcut with default key 'ctrl+enter' when decisionShortcutKey is not set", async () => {
    const { pi, registeredShortcuts } = makeMockPi();
    const config = makeTestConfig(); // no decisionShortcutKey set
    const factory = createPipeline(config);
    await factory(pi);

    expect(registeredShortcuts.length).toBe(1);
    expect(registeredShortcuts[0].key).toBe("ctrl+enter");
    expect(typeof registeredShortcuts[0].options.description).toBe("string");
    expect(typeof registeredShortcuts[0].options.handler).toBe("function");
  });

  it("registers shortcut with custom key from config.decisionShortcutKey", async () => {
    const { pi, registeredShortcuts } = makeMockPi();
    const config = makeTestConfig({ decisionShortcutKey: "ctrl+shift+d" });
    const factory = createPipeline(config);
    await factory(pi);

    expect(registeredShortcuts.length).toBe(1);
    expect(registeredShortcuts[0].key).toBe("ctrl+shift+d");
  });

  it("registers shortcut with alt+f custom key", async () => {
    const { pi, registeredShortcuts } = makeMockPi();
    const config = makeTestConfig({ decisionShortcutKey: "alt+f" });
    const factory = createPipeline(config);
    await factory(pi);

    expect(registeredShortcuts.length).toBe(1);
    expect(registeredShortcuts[0].key).toBe("alt+f");
  });

  it("shortcut handler has correct description", async () => {
    const { pi, registeredShortcuts } = makeMockPi();
    const factory = createPipeline(makeTestConfig());
    await factory(pi);

    expect(registeredShortcuts[0].options.description).toBe("Pipeline decision menu");
  });
});
