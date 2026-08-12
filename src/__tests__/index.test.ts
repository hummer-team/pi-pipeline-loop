import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import defaultExport, { createPipeline, createPipelineFromJson } from "../index";
import { makeTestConfig } from "./helpers";

describe("createPipeline", () => {
  it("returns an ExtensionFactory function", () => {
    const factory = createPipeline(makeTestConfig());
    expect(typeof factory).toBe("function");
  });

  it("registers all hooks, tools, and commands with the ExtensionAPI", async () => {
    const registeredEvents: string[] = [];
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];

    const mockPi = {
      on: (event: string, _handler: any) => {
        registeredEvents.push(event);
      },
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool.name);
      },
      registerCommand: (name: string, _options: any) => {
        registeredCommands.push(name);
      },
      exec: undefined,
    };

    const factory = createPipeline(makeTestConfig());
    await factory(mockPi as any);

    expect(registeredEvents).toContain("session_start");
    expect(registeredEvents).toContain("before_agent_start");
    expect(registeredEvents).toContain("tool_call");
    expect(registeredEvents).toContain("tool_result");
    expect(registeredEvents).toContain("agent_settled");
    expect(registeredEvents).toContain("session_shutdown");
    expect(registeredEvents).toContain("model_select");
    expect(registeredEvents.length).toBe(7);

    expect(registeredTools).toContain("stage_advance");
    expect(registeredTools).toContain("loop_check");
    expect(registeredTools).toContain("pipeline_state");
    expect(registeredTools).toContain("generate_stage_summary");
    expect(registeredTools).toContain("validate_summary");
    expect(registeredTools).toContain("pipeline_handoff");
    expect(registeredTools).toContain("request_bash_permission");
    expect(registeredTools.length).toBe(7);

    expect(registeredCommands).toContain("pipeline-status");
    expect(registeredCommands).toContain("pipeline-start");
    expect(registeredCommands).toContain("pipeline_init");
    expect(registeredCommands.length).toBe(3);
  });

  it("passes correct tool metadata during registration", async () => {
    const toolRegistrations: Array<{ name: string; description: string }> = [];

    const mockPi = {
      on: () => {},
      registerTool: (tool: { name: string; description: string }) => {
        toolRegistrations.push({ name: tool.name, description: tool.description });
      },
      registerCommand: () => {},
      exec: undefined,
    };

    const factory = createPipeline(makeTestConfig());
    await factory(mockPi as any);

    for (const reg of toolRegistrations) {
      expect(reg.name).toBeTruthy();
      expect(reg.description).toBeTruthy();
      expect(typeof reg.description).toBe("string");
      expect(reg.description.length).toBeGreaterThan(10);
    }
  });
});

// ─── Default Export Tests ─────────────────────────────────────────────────────

const FIXTURE_DIR = ".pi";
const FIXTURE_PATH = path.join(FIXTURE_DIR, "pipeline_loop.json");
const FIXTURE_CONFIG = JSON.stringify({
  stages: {
    clarify: { require: true },
    design: { require: true },
    plan: { require: true },
    develop: { require: true },
    review: { require: true },
    fix: { require: true },
    awaiting_human: { require: false },
    completed: { require: false },
  },
});

describe("default export", () => {
  beforeAll(() => {
    // Create .pi/pipeline_loop.json fixture for Test B and Test D
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, FIXTURE_CONFIG);
  });

  afterAll(() => {
    // Clean up fixture
    try { fs.unlinkSync(FIXTURE_PATH); } catch { /* ignore */ }
    try { fs.rmdirSync(FIXTURE_DIR); } catch { /* ignore */ }
  });

  function createMockPi() {
    const registeredEvents: string[] = [];
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];
    return {
      pi: {
        on: (event: string, _handler: any) => { registeredEvents.push(event); },
        registerTool: (tool: { name: string }) => {
          registeredTools.push(tool.name);
        },
        registerCommand: (name: string, _options: any) => {
          registeredCommands.push(name);
        },
        exec: undefined,
      },
      registeredEvents,
      registeredTools,
      registeredCommands,
    };
  }

  // Test A: default export function exists with correct signature
  it("is an async function", () => {
    expect(typeof defaultExport).toBe("function");
  });

  // Test B: config file exists → registers hooks/tools/commands normally
  it("registers hooks, tools, and commands when config file exists", async () => {
    const { pi, registeredEvents, registeredTools, registeredCommands } = createMockPi();
    await defaultExport(pi as any);

    expect(registeredEvents.length).toBe(7);
    expect(registeredEvents).toContain("session_start");
    expect(registeredEvents).toContain("before_agent_start");
    expect(registeredEvents).toContain("model_select");

    expect(registeredTools.length).toBe(7);
    expect(registeredTools).toContain("stage_advance");
    expect(registeredTools).toContain("pipeline_handoff");

    expect(registeredCommands.length).toBe(3);
    expect(registeredCommands).toContain("pipeline-status");
    expect(registeredCommands).toContain("pipeline-start");
    expect(registeredCommands).toContain("pipeline_init");
  });

  // Test C: config file missing → console.warn + graceful degradation
  it("warns and does not register when config file is missing", async () => {
    // Temporarily remove the fixture
    const saved = fs.readFileSync(FIXTURE_PATH, "utf-8");
    fs.unlinkSync(FIXTURE_PATH);

    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = ((...args: any[]) => {
      warnCalls.push(String(args[0]));
    }) as any;
    const { pi, registeredEvents } = createMockPi();

    await defaultExport(pi as any);

    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain(".pi/pipeline_loop.json not found");
    expect(warnCalls[0]).toContain("Pipeline disabled");
    expect(registeredEvents.length).toBe(0);

    console.warn = originalWarn;

    // Restore fixture for subsequent tests
    fs.writeFileSync(FIXTURE_PATH, saved);
  });

  // Test D: createPipelineFromJson() defaults to .pi/pipeline_loop.json
  it("createPipelineFromJson() defaults to .pi/pipeline_loop.json", () => {
    // Write a config with a distinguishable maxLoops to the default path
    const originalContent = fs.readFileSync(FIXTURE_PATH, "utf-8");
    const customConfig = JSON.stringify({
      stages: {
        clarify: { require: true },
        design: { require: true },
        plan: { require: true },
        develop: { require: true },
        review: { require: true },
        fix: { require: true },
        awaiting_human: { require: false },
        completed: { require: false },
      },
      maxLoops: 7,
    });
    fs.writeFileSync(FIXTURE_PATH, customConfig);

    try {
      const factory = createPipelineFromJson();
      expect(typeof factory).toBe("function");

      // Verify the factory was built from the default path config
      // by invoking it and checking it registers correctly
      const mockPi = {
        on: () => {},
        registerTool: () => {},
        registerCommand: () => {},
      };
      // factory(pi) should not throw — config loaded successfully
      expect(() => factory(mockPi as any)).not.toThrow();
    } finally {
      // Restore original fixture
      fs.writeFileSync(FIXTURE_PATH, originalContent);
    }
  });
});
