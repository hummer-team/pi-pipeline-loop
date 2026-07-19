import { describe, it, expect } from "bun:test";
import { createPipeline } from "../index";
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
      registerTool: (name: string, _description: string, _parameters: any, _execute: any) => {
        registeredTools.push(name);
      },
      registerCommand: (name: string, _description: string, _execute: any) => {
        registeredCommands.push(name);
      },
    };

    const factory = createPipeline(makeTestConfig());
    await factory(mockPi as any);

    expect(registeredEvents).toContain("session_start");
    expect(registeredEvents).toContain("before_agent_start");
    expect(registeredEvents).toContain("tool_call");
    expect(registeredEvents).toContain("tool_result");
    expect(registeredEvents).toContain("session_end");
    expect(registeredEvents).toContain("agent_settled");
    expect(registeredEvents).toContain("session_shutdown");
    expect(registeredEvents.length).toBe(7);

    expect(registeredTools).toContain("stage_advance");
    expect(registeredTools).toContain("loop_check");
    expect(registeredTools).toContain("pipeline_state");
    expect(registeredTools).toContain("generate_stage_summary");
    expect(registeredTools).toContain("validate_summary");
    expect(registeredTools).toContain("pipeline_handoff");
    expect(registeredTools.length).toBe(6);

    expect(registeredCommands).toContain("pipeline-status");
    expect(registeredCommands.length).toBe(1);
  });

  it("passes correct tool metadata during registration", async () => {
    const toolRegistrations: Array<{ name: string; description: string }> = [];

    const mockPi = {
      on: () => {},
      registerTool: (name: string, description: string, _parameters: any, _execute: any) => {
        toolRegistrations.push({ name, description });
      },
      registerCommand: () => {},
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
