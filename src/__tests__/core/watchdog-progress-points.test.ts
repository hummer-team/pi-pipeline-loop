/**
 * 210 Phase 2 — stage-progress whitelist at its REAL entry points.
 *
 * Requirement 5.4 names six sources that may renew the stage idle clock. This
 * file drives each one through the production call site (not through
 * `touchStageProgress` directly), which is the only way to catch a renewal point
 * that was wired to the wrong stage, a wrong pipelineId, or dropped entirely:
 *
 *   verify        auto-verifier `runVerification` (entry)
 *   spawn         utils/subagent-rpc `spawnStageSubagent` → sink
 *   settle        utils/subagent-lifecycle-registry `registerTerminal` → sink
 *                 (plus the same report inside the `agent_settled` hook)
 *   tool          core/loop-breaker `tool_result` handler (success only)
 *   menu          core/flow-state `presentDecisionMenuCore` → ensureDecisionMenu
 *   stage_advance stage-advance arm hooks → `executeDecision` (skip)
 *
 * The `utils` sources travel through the dependency-inversion sink
 * (`utils/stage-progress-sink`), because a runtime `utils → core` import is
 * forbidden by the static guard in `utils/subagent-rpc.test.ts`. The sink is
 * installed the same way `createPipeline` installs it.
 *
 * Assertions are synchronous bookkeeping checks (`lastProgressAt` moved,
 * `lastProgressSource` attributed, clock still armed), so they do not race a
 * timer. The one end-to-end renewal case uses a real short timer and polls.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { FlowStateCtx } from "../../core/flow-state";
import type { PipelineConfig, SessionMeta, StageProgressSource } from "../../types";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import {
  armStageWatchdog,
  touchStageProgress,
} from "../../core/stage-watchdog";
import {
  __stageWatchdogState,
  clearAllDecisionTimers,
} from "../../core/decision-menu-runtime";
import {
  reportStageProgress,
  setStageProgressReporter,
  __hasStageProgressReporter,
} from "../../utils/stage-progress-sink";
import { registerTerminal } from "../../utils/subagent-lifecycle-registry";
import { spawnStageSubagent } from "../../utils/subagent-rpc";
import { runVerification } from "../../core/auto-verifier";
import { createLoopBreaker } from "../../core/loop-breaker";
import { executeDecision, freezeAndPrompt } from "../../core/flow-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

// ─── Harness ────────────────────────────────────────────────────────────────

let audits: Array<{ event: string; fields: Record<string, string | boolean> }> = [];

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message) => {
    audits.push({ event, fields: (message ?? {}) as Record<string, string | boolean> });
  });
  // Production wiring (index.ts:108) — the utils side reports through the sink.
  setStageProgressReporter(touchStageProgress);
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  setStageProgressReporter(null);
  clearAllDecisionTimers();
});

let idCounter = 0;
function uniquePipelineId(): string {
  idCounter++;
  return `pipe-wdpp-${idCounter}`;
}

/** Idle window generously above the duration of every driven entry point. */
const IDLE_MS = 4000;
const WALL_MS = 60000;

function watchdogConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return makeTestConfig({
    watchdog: { enabled: true, stageTimeoutMs: WALL_MS, stageIdleTimeoutMs: IDLE_MS },
    ...overrides,
  });
}

function runningMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    pipelineId: uniquePipelineId(),
    currentStage: "develop",
    flowState: "running",
    stageStartTime: Date.now(),
    ...overrides,
  });
}

function makeCtx(meta: SessionMeta, ui?: FlowStateCtx["ui"]): FlowStateCtx {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ...(ui ? { ui } : {}),
    _ctx: {
      sessionManager: { getBranch: () => [], getEntries: () => [] },
    } as unknown as FlowStateCtx["_ctx"],
  };
}

/**
 * Arms a clock, then waits long enough that any renewal is a strictly later
 * `Date.now()` reading — the deterministic part of the assertion below.
 */
async function armedPipeline(
  meta: SessionMeta,
  config = watchdogConfig(),
  ui?: FlowStateCtx["ui"],
): Promise<FlowStateCtx> {
  const ctx = makeCtx(meta, ui);
  armStageWatchdog(ctx, config);
  expect(__stageWatchdogState(meta.pipelineId!).armed).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 3));
  return ctx;
}

/**
 * The whitelist contract for ONE source: the entry point must (a) push the idle
 * basis forward and (b) record itself as the attribution, without disturbing the
 * armed pair. A missed wiring (wrong pipelineId / dropped call) fails here.
 */
function expectRenewed(
  pipelineId: string,
  source: StageProgressSource,
  previousProgressAt: number,
): void {
  const state = __stageWatchdogState(pipelineId);
  expect(state.armed).toBe(true);
  expect(state.lastProgressSource).toBe(source);
  expect(state.lastProgressAt! - previousProgressAt).toBeGreaterThan(0);
}

/** Idle basis of a pipeline right now (the arm sets it to `Date.now()`). */
function progressAt(pipelineId: string): number {
  const at = __stageWatchdogState(pipelineId).lastProgressAt;
  expect(typeof at).toBe("number");
  return at as number;
}

// ─── verify — auto-verifier entry ───────────────────────────────────────────

describe("progress point: verify (runVerification)", () => {
  it("renews the idle clock at the verification entry", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    await armedPipeline(meta);
    const before = progressAt(id);

    await runVerification(watchdogConfig(), meta, ["assistant output"]);

    expectRenewed(id, "verify", before);
  });

  it("renews even when the verification run itself fails fast", async () => {
    // A broken stage (config error, unreadable deliverable) still IS activity:
    // the idle clock measures silence, not success.
    const meta = runningMeta({ currentStage: "review" });
    const id = meta.pipelineId!;
    await armedPipeline(meta);
    const before = progressAt(id);

    const result = await runVerification(watchdogConfig(), meta, []);

    expect(result.rulePassed).toBeTypeOf("boolean");
    expectRenewed(id, "verify", before);
  });
});

// ─── tool — loop-breaker tool_result handler ────────────────────────────────

describe("progress point: tool (loop-breaker)", () => {
  it("renews on a successful tool result", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    await armedPipeline(meta);
    const before = progressAt(id);

    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "read", arguments: { path: "src/index.ts" } };
    ctx.result = { success: true };
    await createLoopBreaker(watchdogConfig()).handler(ctx as never);

    expectRenewed(id, "tool", before);
  });

  it("does NOT renew on a failing tool result (a silent error loop must still time out)", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    await armedPipeline(meta);
    const before = progressAt(id);

    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
    ctx.result = { success: false, exitCode: 1 };
    await createLoopBreaker(watchdogConfig()).handler(ctx as never);

    const state = __stageWatchdogState(id);
    expect(state.lastProgressAt).toBe(before);
    expect(state.lastProgressSource).not.toBe("tool");
  });
});

// ─── spawn — subagent dispatch through the sink ─────────────────────────────

describe("progress point: spawn (subagent-rpc via sink)", () => {
  /** Project root carrying one stage agent definition, as the real spawn needs. */
  function spawnFixture(stage: "plan" | "develop"): { config: PipelineConfig; root: string } {
    const root = path.join(tmpdir(), `pi-wdpp-${stage}-${Date.now()}`);
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "agents", `${stage}-agent.md`),
      `---\nname: ${stage}-agent\n---\n# ${stage} Agent\n`,
    );
    const config = makeTestConfig({
      projectRoot: root,
      watchdog: { enabled: true, stageTimeoutMs: WALL_MS, stageIdleTimeoutMs: IDLE_MS },
      stages: {
        ...makeTestConfig().stages,
        [stage]: {
          agentPath: `agents/${stage}-agent.md`,
          skillPath: `${stage}/SKILL.md`,
          nextStage: stage === "plan" ? "develop" : "review",
          requireDomain: false,
        },
      },
    });
    return { config, root };
  }

  it("renews after a successful dispatch on the followUp channel", async () => {
    const { config, root } = spawnFixture("plan");
    try {
      const meta = runningMeta({ currentStage: "plan" });
      const id = meta.pipelineId!;
      await armedPipeline(meta, config);
      const before = progressAt(id);

      // No event bus on this pi → the followUp fallback channel dispatches and
      // reports `spawn` (subagent-rpc.ts:1058).
      const pi = { sendUserMessage: () => {} };
      const result = await spawnStageSubagent(pi, config, "plan", meta, {
        ui: { notify: () => {} },
      });
      expect(result.spawned).toBe(true);
      expectRenewed(id, "spawn", before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not report a dispatch that never happened", async () => {
    const { config, root } = spawnFixture("plan");
    try {
      const meta = runningMeta({ currentStage: "plan" });
      const id = meta.pipelineId!;
      await armedPipeline(meta, config);
      const before = progressAt(id);

      // No dispatch channel at all (no bus, no sendUserMessage) → nothing spawned
      // → the idle clock must NOT be renewed by a failed dispatch.
      const result = await spawnStageSubagent({}, config, "plan", meta);
      expect(result.spawned).toBe(false);

      expect(__stageWatchdogState(id).lastProgressAt).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── settle — child terminal event through the sink ─────────────────────────

describe("progress point: settle (child terminal via sink)", () => {
  it("renews the owning pipeline's idle clock on a child terminal event", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    await armedPipeline(meta);
    const before = progressAt(id);

    registerTerminal("subagent", `wdpp-agent-${id}`, "terminal", "completed", "develop", id);

    expectRenewed(id, "settle", before);
  });

  it("falls back to the registered entry's pipeline when the event omits it", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const agentId = `wdpp-orphan-${id}`;
    await armedPipeline(meta);

    // First registration binds the agent to the pipeline (spawn side).
    registerTerminal("subagent", agentId, "terminal", "completed", "develop", id);
    await new Promise((resolve) => setTimeout(resolve, 3));
    const before = progressAt(id);

    // A late terminal event WITHOUT a pipelineId must still renew the owner.
    registerTerminal("subagent", agentId, "terminal", "cancelled");
    expectRenewed(id, "settle", before);
  });

  it("a terminal event of a foreign pipeline never touches this clock", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    await armedPipeline(meta);
    const before = progressAt(id);
    const beforeKey = __stageWatchdogState(id).stageKey;

    registerTerminal("subagent", `wdpp-foreign-${id}`, "terminal", "completed", "develop", uniquePipelineId());

    expect(__stageWatchdogState(id).lastProgressAt).toBe(before);
    expect(__stageWatchdogState(id).stageKey).toBe(beforeKey);
  });
});

// ─── menu — decision menu presentation through flow-state ──────────────────

describe("progress point: menu (decision menu presentation)", () => {
  it("renews the live clock when the frozen pipeline's menu is presented", async () => {
    // Realistic state: the freeze came from another source (loop overflow), so
    // the stage clocks of the visit are still live when the menu appears. A
    // human sitting on the dialog must not look like a stalled stage, and the
    // presentation itself is the event that proves the pipeline is talking.
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const config = watchdogConfig();
    const ctx = await armedPipeline(meta, config, { select: async () => undefined, notify: () => {} });
    const before = progressAt(id);

    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    expect(meta.flowState).toBe("blocked");
    expectRenewed(id, "menu", before);
  });

  it("renews when the human answers the menu and resume re-arms the visit", async () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const config = watchdogConfig();
    const ctx = await armedPipeline(meta, config, { select: async () => "Resume", notify: () => {} });
    const before = progressAt(id);

    await freezeAndPrompt(ctx, meta, "verify_fail", config);

    // Answered: the presentation touch and the answer touch both say "menu", and
    // the resume branch re-arms the SAME visit (stageStartTime untouched), whose
    // idempotency rule keeps the attribution instead of resetting it to "none".
    expect(meta.flowState).toBe("running");
    expectRenewed(id, "menu", before);
    expect(__stageWatchdogState(id).stageKey).toBe(`${id}:${meta.stageStartTime}`);
  });
});

// ─── stage_advance — the re-arm hooks ───────────────────────────────────────

describe("progress point: stage_advance (re-arm hooks)", () => {
  it("attributes the new visit to the advance when the clocks are re-armed", async () => {
    const meta = runningMeta({
      flowState: "blocked",
      blockedReason: "verify_fail",
      summaries: {
        develop: { path: "/tmp/wdpp.md", hash: "abc", status: "valid" },
      },
    });
    const id = meta.pipelineId!;
    const config = watchdogConfig();
    const ctx = makeCtx(meta);
    armStageWatchdog(ctx, config, { progressSource: "settle" });

    // skip advances develop → review: a NEW stage visit, re-armed by the branch
    // hook with the advance as its first progress event.
    const previousKey = __stageWatchdogState(id).stageKey;
    const result = await executeDecision(ctx, meta, "skip", config);

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("review");
    const state = __stageWatchdogState(id);
    expect(state.armed).toBe(true);
    expect(state.stageKey).toBe(`${id}:${meta.stageStartTime}`);
    expect(state.stageKey).not.toBe(previousKey);
    expect(state.lastProgressSource).toBe("stage_advance");
  });

  it("a re-armed fresh visit reports no source at all rather than the old visit's", () => {
    // A new visit has no progress history: `stage_watchdog_timeout` must then say
    // "none" — never inherit the event that ended the PREVIOUS stage.
    const meta = runningMeta();
    const id = meta.pipelineId!;
    const config = watchdogConfig();
    const ctx = makeCtx(meta);

    armStageWatchdog(ctx, config, { progressSource: "settle" });
    expect(__stageWatchdogState(id).lastProgressSource).toBe("settle");

    clearAllDecisionTimers();
    meta.stageStartTime = Date.now() + 1000;
    armStageWatchdog(ctx, config);

    expect(__stageWatchdogState(id).armed).toBe(true);
    expect(__stageWatchdogState(id).lastProgressSource).toBeUndefined();
  });
});

// ─── Sink contract (DI boundary) ────────────────────────────────────────────

describe("stage-progress sink contract", () => {
  it("is inert while no consumer is registered (standalone utils consumer = baseline)", () => {
    setStageProgressReporter(null);
    const meta = runningMeta();
    expect(() => reportStageProgress(meta.pipelineId, "spawn")).not.toThrow();
    expect(__hasStageProgressReporter()).toBe(false);
    expect(__stageWatchdogState(meta.pipelineId!).armed).toBe(false);
  });

  it("ignores a report without a pipelineId (must not touch another pipeline)", () => {
    const meta = runningMeta();
    const id = meta.pipelineId!;
    armStageWatchdog(makeCtx(meta), watchdogConfig());
    const before = __stageWatchdogState(id).lastProgressAt;

    expect(() => reportStageProgress(undefined, "spawn")).not.toThrow();
    expect(__stageWatchdogState(id).lastProgressAt).toBe(before);
  });

  // 210 review issue 11 (code_spec §4): the sink reports through the unified
  // audit writer, not `console`. The channel changed; the containment contract
  // (never propagate a consumer failure) does not.
  it("contains a throwing consumer by writing an error audit instead of breaking the flow", async () => {
    const captured: Array<{ event: string; fields: Record<string, string | boolean>; level?: string }> = [];
    __setSafeWriteAuditLogOverride(async (event, message, level) => {
      captured.push({ event, fields: (message ?? {}) as Record<string, string | boolean>, level });
    });
    setStageProgressReporter(() => {
      throw new Error("consumer blew up");
    });
    try {
      // The sink logs, never propagates: a renewal is advisory (requirement 5.4).
      expect(() => reportStageProgress("pipe-wdpp-throwing", "settle")).not.toThrow();
      await Promise.resolve();
    } finally {
      __setSafeWriteAuditLogOverride(null);
      setStageProgressReporter(null);
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]!.event).toBe("stage_progress_sink_error");
    expect(captured[0]!.level).toBe("error");
    expect(captured[0]!.fields["source"]).toBe("settle");
    expect(String(captured[0]!.fields["error"])).toContain("consumer blew up");
  });

  it("reaches a core-side clock through the consumer `createPipeline` installs", async () => {
    // The composition-root wiring itself is asserted in index-registration.test.ts
    // (calling the factory here would mutate other DI globals). This mirrors it
    // with the SAME function pointer — `touchStageProgress` — so the utils → sink
    // → watchdog path is exercised end to end without the plugin factory.
    setStageProgressReporter(touchStageProgress);
    const meta = runningMeta();
    const id = meta.pipelineId!;
    await armedPipeline(meta, watchdogConfig());
    const before = progressAt(id);

    reportStageProgress(id, "spawn");

    expectRenewed(id, "spawn", before);
  });
});
