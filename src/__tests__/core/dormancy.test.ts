/**
 * @module dormancy.test
 * Phase 2a (173) C2 + C6 — Dormancy predicate matrix and no-meta defensive guards.
 *
 * Test plan (per docs/design/173_E2E_Bug_plan.md §Phase 2a):
 *   - Predicate matrix: {no meta / no pipelineId / running / blocked / aborted / completed}
 *     × {owner, child} = ≥8 tests
 *   - DORMANT_KEEP_PROTECTION constant existence + value=false pin
 *   - No-meta ctx: hooks (prompt-injector, tool-guard, agent-settled, loop-breaker, session-shutdown)
 *     + shortcut: zero exception, guidance/silence, meta not written, violations not increased
 *   - Behavior preservation: existing tests all green = preservation acceptance
 */

import { describe, it, expect } from "bun:test";
import { isDormant, DORMANT_KEEP_PROTECTION, getHostRole } from "../../core/dormancy";
import { createPromptInjector } from "../../core/prompt-injector";
import { createToolGuard } from "../../core/tool-guard";
import { createAgentSettled } from "../../core/agent-settled";
import { createLoopBreaker } from "../../core/loop-breaker";
import { createSessionShutdown } from "../../core/session-shutdown";
import { createPipelineState } from "../../core/pipeline-state";
import { createLoopChecker } from "../../core/loop-checker";
import { createSessionStarter } from "../../core/session-starter";
import type { SessionMeta, PipelineConfig } from "../../types";
import type { RuntimeCtx } from "../../core/runtime-ctx";
import { makeTestConfig, makeTestMeta, createMockRuntimeCtx } from "../helpers";

// ─── C2: isDormant Predicate Matrix ──────────────────────────────────────────

describe("Phase 2a (173) C2: isDormant predicate matrix", () => {
  it("returns true when meta is undefined", () => {
    expect(isDormant(undefined)).toBe(true);
  });

  it("returns true when meta has no pipelineId", () => {
    const meta = { currentStage: "develop", pipelineId: "" } as SessionMeta;
    expect(isDormant(meta)).toBe(true);
  });

  it("returns false when flowState is running", () => {
    const meta = makeTestMeta({ flowState: "running" });
    expect(isDormant(meta)).toBe(false);
  });

  it("returns false when flowState is blocked", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
    expect(isDormant(meta)).toBe(false);
  });

  it("returns true when flowState is aborted", () => {
    const meta = makeTestMeta({ flowState: "aborted", terminateReason: "user_quit" });
    expect(isDormant(meta)).toBe(true);
  });

  it("returns true when currentStage is completed (terminal = silent)", () => {
    const meta = makeTestMeta({ currentStage: "completed", flowState: "running" });
    expect(isDormant(meta)).toBe(true);
  });

  it("returns false when flowState is undefined (defaults to running)", () => {
    const meta = makeTestMeta({ flowState: undefined });
    expect(isDormant(meta)).toBe(false);
  });

  it("returns true for aborted with terminateReason stale_startup", () => {
    const meta = makeTestMeta({ flowState: "aborted", terminateReason: "stale_startup" });
    expect(isDormant(meta)).toBe(true);
  });

  it("returns false for awaiting_human (frozen but not dormant)", () => {
    const meta = makeTestMeta({ currentStage: "awaiting_human", flowState: "blocked" });
    expect(isDormant(meta)).toBe(false);
  });
});

// ─── DORMANT_KEEP_PROTECTION switch ──────────────────────────────────────────

describe("Phase 2a (173) C2: DORMANT_KEEP_PROTECTION switch", () => {
  it("exists and is false by default (🔴-1 full silencing)", () => {
    expect(DORMANT_KEEP_PROTECTION).toBe(false);
  });

  it("is a boolean constant (compile-time existence check)", () => {
    expect(typeof DORMANT_KEEP_PROTECTION).toBe("boolean");
  });
});

// ─── getHostRole helper ──────────────────────────────────────────────────────

describe("Phase 2a (173) C2: getHostRole helper", () => {
  it("returns 'owner' when ctx is undefined", () => {
    expect(getHostRole(undefined)).toBe("owner");
  });

  it("returns 'owner' for ctx without parentSession", () => {
    const meta = makeTestMeta();
    const ctx = createMockRuntimeCtx(meta);
    expect(getHostRole(ctx)).toBe("owner");
  });

  it("returns 'child' for ctx with parentSession header", () => {
    const meta = makeTestMeta();
    const ctx = createMockRuntimeCtx(meta, {
      sessionHeader: { parentSession: "parent-file" },
    });
    expect(getHostRole(ctx)).toBe("child");
  });
});

// ─── C6: No-meta defensive guards ────────────────────────────────────────────

describe("Phase 2a (173) C6: no-meta defensive guards", () => {
  const config = makeTestConfig();

  it("prompt-injector: returns undefined (zero injection) when no meta", async () => {
    const ctx = createMockRuntimeCtx(undefined as unknown as SessionMeta);
    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as unknown as RuntimeCtx);
    expect(result).toBeUndefined();
  });

  it("tool-guard: returns undefined (full pass-through) when no meta", async () => {
    const ctx = createMockRuntimeCtx(undefined as unknown as SessionMeta);
    ctx.toolCall = { name: "bash", arguments: { command: "echo hello" } };
    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as unknown as RuntimeCtx);
    expect(result).toBeUndefined();
  });

  it("agent-settled: returns void (no audit, no notify) when no meta", async () => {
    const ctx = createMockRuntimeCtx(undefined as unknown as SessionMeta);
    const hook = createAgentSettled(config);
    // Should not throw
    await expect(hook.handler(ctx as unknown as RuntimeCtx)).resolves.toBeUndefined();
  });

  it("loop-breaker: returns void (zero counting) when no meta", async () => {
    const ctx = createMockRuntimeCtx(undefined as unknown as SessionMeta);
    ctx.toolCall = { name: "bash", arguments: { command: "bun test" } };
    ctx.result = { success: false, exitCode: 1 };
    const hook = createLoopBreaker(config);
    await expect(hook.handler(ctx as unknown as RuntimeCtx)).resolves.toBeUndefined();
  });

  it("session-shutdown: returns void (identity audit only) when no meta", async () => {
    const ctx = createMockRuntimeCtx(undefined as unknown as SessionMeta);
    const hook = createSessionShutdown(config);
    await expect(hook.handler(ctx as unknown as RuntimeCtx)).resolves.toBeUndefined();
  });

  it("pipeline-state tool: returns guidance message when no meta", async () => {
    const ctx = { session: { getMeta: () => undefined } } as unknown as RuntimeCtx;
    const tool = createPipelineState(config);
    const result = await tool.execute({}, ctx);
    expect((result as Record<string, string>).message).toContain("No active pipeline");
  });

  it("loop-checker tool: returns guidance message when no meta", async () => {
    const ctx = { session: { getMeta: () => undefined } } as unknown as RuntimeCtx;
    const tool = createLoopChecker(config);
    const result = await tool.execute({ result: "pass" }, ctx);
    expect((result as Record<string, string>).message).toContain("No active pipeline");
  });

  it("meta is not written by any guard when no meta exists", async () => {
    let updateCalled = false;
    const ctx = {
      session: {
        getMeta: () => undefined,
        updateMeta: () => { updateCalled = true; return undefined; },
      },
      ui: { notify: () => {} },
      toolCall: { name: "bash", arguments: { command: "echo test" } },
      _ctx: {},
    };

    // Run all hooks — none should call updateMeta
    const injectorHook = createPromptInjector(config);
    await injectorHook.handler(ctx as unknown as RuntimeCtx);

    const guardHook = createToolGuard(config);
    await guardHook.handler(ctx as unknown as RuntimeCtx);

    const settledHook = createAgentSettled(config);
    await settledHook.handler(ctx as unknown as RuntimeCtx);

    expect(updateCalled).toBe(false);
  });
});
