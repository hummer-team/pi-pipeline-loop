/**
 * 208 Phase 3 — `/pipeline-start` command menu semantics (G1/G2/G3).
 *
 * Covered acceptance items (plan §Phase 3 command tests, pipeline-start):
 * 1. blocked branch, select fast dismiss → success=false, error contains
 *    "interrupted" and "reopen automatically", retry timer armed (G1);
 * 2. awaiting_human branch, decided && applied → success=true with the
 *    existing "Decision executed." success string (contract unchanged);
 * 3. awaiting_human / blocked branches without UI → success=false, error
 *    contains the decision-menu hint plus stage/formatFrozenReason, and
 *    NOTHING is notified (notify call count 0, single message channel).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { formatDecisionMenuHint, clearAllDecisionTimers, __hasDecisionTimer } from "../../core/flow-state";
import { clearInputCapabilityOverrides } from "../../core/decision-menu-runtime";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta } from "../../types";

type SelectCall = { message: string; options: string[] };

// Shared, reset per test
let selectQueue: Array<string | undefined>;
let selectCalls: SelectCall[];
let pidCounter = 0;
let TMP: string;

/** Command context with a queue-driven select and notify capture. */
function makeStartCtx(meta: SessionMeta) {
  selectQueue = [];
  selectCalls = [];
  const notifications: string[] = [];
  const ctx = {
    session: {
      getMeta: () => meta,
      updateMeta: (p: Partial<SessionMeta>) => {
        Object.assign(meta, p);
        return meta;
      },
    },
    ui: {
      select: async (message: string, options: string[]) => {
        selectCalls.push({ message, options });
        return selectQueue.shift();
      },
      notify: (msg: string) => { notifications.push(msg); },
      setStatus: () => {},
    } as FlowStateCtx["ui"],
    _ctx: {
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
      },
    },
  };
  return { ctx: ctx as unknown as FlowStateCtx, notifications };
}

/** Unique pipelineId per test (shared names would leak scheduler state). */
function freshMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  pidCounter++;
  return makeTestMeta({
    currentStage: "develop",
    flowState: "blocked",
    blockedReason: "loop_overflow",
    pipelineId: `pipe-menu-start-${pidCounter}`,
    requirementDoc: join(TMP, "req.md"),
    ...overrides,
  });
}

function q(...responses: Array<string | undefined>): void {
  selectQueue = [...selectQueue, ...responses];
}

beforeEach(async () => {
  TMP = join(tmpdir(), "pi-start-menu-" + Date.now() + "-" + pidCounter);
  await mkdir(TMP, { recursive: true });
  await writeFile(join(TMP, "req.md"), "content", "utf-8");
  __setSafeWriteAuditLogOverride(async () => {});
});

afterEach(async () => {
  jest.useRealTimers();
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
  clearInputCapabilityOverrides();
  await rm(TMP, { recursive: true, force: true });
});

describe("208 Phase 3: /pipeline-start menu semantics", () => {
  it("test 1: blocked + fast dismiss → interrupted, success=false, auto reopen promised, timer armed", async () => {
    const meta = freshMeta();
    const { ctx } = makeStartCtx(meta);
    q(undefined); // streaming dismiss → interrupted
    const config = makeTestConfig({ projectRoot: TMP });
    const cmd = createPipelineStartCommand(config);

    jest.useFakeTimers();
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Decision menu interrupted");
    expect(result.error).toContain("reopen automatically");
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);

    // G1: the backoff timer re-opens the menu after 5s
    jest.advanceTimersByTime(5000);
    for (let i = 0; i < 80; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve().then(() => {});
    }
    expect(selectCalls.length).toBe(2);
  });

  it("test 2: awaiting_human (flowState=blocked) + Resume → success=true 'Decision executed.'", async () => {
    const meta = freshMeta({
      currentStage: "awaiting_human",
      previousStage: "develop",
      blockedReason: "ask_user",
    });
    const { ctx } = makeStartCtx(meta);
    q("Resume");
    const config = makeTestConfig({ projectRoot: TMP });
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(selectCalls.length).toBe(1);
    expect(result.success).toBe(true);
    expect(result.message).toBe("Decision executed.");
    expect(meta.flowState).toBe("running");
  });

  it("test 3a: awaiting_human without UI → success=false, error keeps hint + stage, 0 notifies", async () => {
    const meta = freshMeta({
      currentStage: "awaiting_human",
      previousStage: "develop",
    });
    const { ctx, notifications } = makeStartCtx(meta);
    delete (ctx.ui as { select?: unknown }).select;
    const config = makeTestConfig({ projectRoot: TMP });
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("awaiting_human");
    expect(result.error).toContain(formatDecisionMenuHint());
    expect(result.error).toContain("no_ui");
    // Single channel: the command never notifies in the no-UI case
    expect(notifications.filter((m) => m.includes("No decision menu is available")).length).toBe(0);
    expect(selectCalls.length).toBe(0);
  });

  it("test 3b: blocked without UI → success=false, error keeps formatFrozenReason + hint, 0 notifies", async () => {
    const meta = freshMeta();
    const { ctx, notifications } = makeStartCtx(meta);
    delete (ctx.ui as { select?: unknown }).select;
    const config = makeTestConfig({ projectRoot: TMP });
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "req.md" }, ctx as any);

    expect(result.success).toBe(false);
    // Pipeline frozen at "develop" (...). No decision menu is available (no_ui); hint
    expect(result.error).toContain(`Pipeline frozen at "${meta.currentStage}"`);
    expect(result.error).toContain(formatDecisionMenuHint());
    expect(notifications.filter((m) => m.includes("No decision menu is available")).length).toBe(0);
    expect(selectCalls.length).toBe(0);
  });
});
