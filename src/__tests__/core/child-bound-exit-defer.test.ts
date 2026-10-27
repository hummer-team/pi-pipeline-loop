/**
 * 216 Phase 2 (P3): the CHILD-side defer for owner-bound runs, driven through
 * the REAL `agent_settled` hook (issue181 confirm-gate fixture shape).
 *
 * The self-exciting loop this closes: `wake → settle → refused-exit → wake`.
 * A child session must never consume/advance an OWNER-bound run — it defers
 * (`stage_settle_child_deferred`, zero-side-effect on the run) and hands the
 * refusal to `recordStageExitRefusal`. Ordering evidence (R6-5): the defer sits
 * AFTER the manual confirm gate, so a child reaching the gate is still purely
 * gate-suppressed (`confirm_gate_suppressed_child`) with NO defer at all.
 *
 *  ⑫ manual confirm + child + bound run → gate handled, NO defer, run intact.
 *  ⑬ child + bound run (no gate) → defer: ONE `stage_settle_child_deferred`
 *     (+ one escalated owner arm), zero advance/usage/wake/spawn evidence,
 *     pendingSpawns and verifyAttempts exactly as persisted.
 *  ⑭ child WITHOUT bound run → verbatim baseline advance (R2-Q1-B guard).
 *  ⑮ reset scopes: continue keeps `frozenCount` / new period, real transition
 *     and `/pipeline-quit` clear the whole counter.
 *  ⑯ child-triggered freeze arms ONLY the owner menu channels — no menu is
 *     presented in the child TUI, no deadline is armed there (R6-7).
 *
 * Audit split: `stage_settle_child_deferred` / `confirm_gate_suppressed_child`
 * / `stage_advance` / `stage_usage` / `auto_advance_wake` are file-based
 * (walked); every `safeWriteAuditLog` family (refusal counting, menu arms,
 * blocked/aborted) is captured in-memory via the override.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSettled } from "../../core/agent-settled";
import { createStageAdvancer, maybeHandleConfirmGate } from "../../core/stage-advancer";
import { recordStageExitRefusal } from "../../core/stage-exit/stage-exit-refusal";
import { buildContinueResetFields, buildNewPeriodResetFields } from "../../core/meta-reset";
import { createPipelineQuitCommand } from "../../commands/pipeline-quit";
import { clearAllDecisionTimers, getFlowState } from "../../core/flow-state";
import {
  STAGE_EXIT_REFUSED_ESCALATION_REASON,
  STAGE_EXIT_REFUSED_OVERFLOW_REASON,
} from "../../constants";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { PIPELINE_ESCALATION_EVENT } from "../../utils/escalation-bus";
import { createMockCtx, makeTestConfig, makeTestMeta } from "../helpers";
import type {
  PipelineConfig,
  SessionMeta,
  StageExecutorBinding,
  StageExecutorRun,
  StageExitRefusal,
} from "../../types";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
const OWNER_FILE = "/sessions/owner.jsonl";
const CHILD_FILE = "/sessions/child.jsonl";
const RUN_ID = "run-216-defer";

function setManagerRunning(running: boolean): void {
  (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
    getRecord: () => undefined,
    hasRunning: () => running,
  };
}

// ─── In-memory capture of EVERY safeWriteAuditLog event ──────────────────────

interface CapturedAudit {
  event: string;
  message?: Record<string, string | boolean>;
  level?: string;
}
let audits: CapturedAudit[] = [];

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message: message as Record<string, string | boolean> | undefined, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
});

function eventsFor(event: string): CapturedAudit[] {
  return audits.filter((a) => a.event === event);
}
function refusalEvents(): CapturedAudit[] {
  return audits.filter((a) => a.event.startsWith("stage_exit_refusal_"));
}

// ─── Settle-driven harness (issue181 fixture shape) ──────────────────────────

let seq = 0;
const nextPid = (): string => `pipe-216-defer-${Date.now()}-${++seq}`;

/** An un-consumed owner-bound run for the CURRENT stage `plan`. */
function boundRunPlan(pipelineId: string): StageExecutorRun {
  const binding: StageExecutorBinding = {
    runId: RUN_ID,
    pipelineId,
    ownerSessionFile: OWNER_FILE,
    stage: "plan",
    stageVisitId: 1_700_000_000_000,
    operationId: "op-216-defer",
    agentId: "01a11bbb-c3b4-72bc-9397-4f5b9881be41",
    executorSessionFile: CHILD_FILE,
  };
  return {
    binding,
    status: "running",
    recovery: "none",
    consecutiveFailures: 0,
    terminalConsumed: false,
  };
}

interface SettleCase {
  root: string;
  config: PipelineConfig;
  meta: SessionMeta;
  ctx: ReturnType<typeof createMockCtx>;
  /** pi.sendUserMessage captures — the wake channel must stay empty on defers. */
  wakes: string[];
  /** Broadcasts captured on the structural pi event bus. */
  bus: { name: string; payload: Record<string, unknown> }[];
  /** Deep snapshot of the preset bound run (`undefined` when none exists). */
  boundRun: StageExecutorRun | undefined;
  /** Deep snapshot of the preset pendingSpawns (must survive untouched). */
  pendingPreset: SessionMeta["pendingSpawns"];
}

/**
 * Fresh tmp projectRoot + initialized file audits + CHILD ctx (parent header +
 * subagent name) driving the real settle hook over a `plan` stage whose verify
 * passes (required plan doc + `.pi/references/plan_spec/verify.md`).
 */
async function makeSettleCase(opts: {
  label: string;
  /** plan gets `confirm:{mode:"manual"}` (issue181 gate shape). */
  confirmManual?: boolean;
  /** meta carries an un-consumed owner-bound run for `plan`. */
  bound?: boolean;
  meta?: (pid: string) => Partial<SessionMeta>;
}): Promise<SettleCase> {
  const root = join(tmpdir(), `pi-216-defer-${opts.label}-${Date.now()}-${seq}`);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await mkdir(join(root, ".pi", "references", "plan_spec"), { recursive: true });

  const base = makeTestConfig({ projectRoot: root });
  const planStage = {
    ...base.stages.plan,
    nextStage: "develop" as const,
    verify: { require: true },
    allowedWritePaths: ["docs/"],
    // NO confirm marker inside the doc: a child + marker would resolve the
    // gate as `no-gate` BEFORE the suppression branch (stage-advancer:955).
    ...(opts.confirmManual ? { confirm: { mode: "manual" as const } } : {}),
  };
  // develop without an agent → the ⑭ baseline advance cannot spawn noise.
  const developStage = { ...base.stages.develop, agentPath: undefined };
  const config = {
    ...base,
    stages: {
      ...base.stages,
      plan: planStage as typeof base.stages.plan,
      develop: developStage as typeof base.stages.develop,
    },
  } as PipelineConfig;
  await initAuditLog(config);

  await writeFile(join(root, "docs", "design", "77_Config_plan.md"), "# Plan\nplan content here\n", "utf-8");
  await writeFile(
    join(root, ".pi", "references", "plan_spec", "verify.md"),
    "---\nrequiredFiles:\n  - \"docs/design/77_Config_plan.md\"\n---\nVerify plan.",
    "utf-8",
  );

  const pid = nextPid();
  seq++;
  const run = opts.bound ? boundRunPlan(pid) : null;
  const pendingPreset: SessionMeta["pendingSpawns"] = {
    review: { pipelineId: pid, agentName: "review-executor", requestedAt: 1_700_000_000_000, attempts: 0 },
  };
  const meta = makeTestMeta({
    currentStage: "plan",
    previousStage: "clarify",
    flowState: "running",
    requirementDoc: "docs/design/77_Config.md",
    pipelineId: pid,
    verifyAttempts: 2,
    ...(run ? { stageExecutorRun: run } : {}),
    pendingSpawns: JSON.parse(JSON.stringify(pendingPreset)),
    ...(opts.meta?.(pid) ?? {}),
  });

  const wakes: string[] = [];
  const bus: SettleCase["bus"] = [];
  // A named variable (not a literal) — extra `events` stays type-clean.
  const piMock = {
    sendUserMessage: (msg: string) => { wakes.push(msg); },
    events: {
      emit: (name: string, payload: Record<string, unknown>) => { bus.push({ name, payload }); },
      on: () => () => {},
    },
  };
  const ctx = createMockCtx(meta, {
    sessionHeader: { parentSession: OWNER_FILE },
    sessionFile: CHILD_FILE,
    sessionName: "plan-executor#a1b2c3d4",
    pi: piMock,
  });
  // The incident shape runs the child settle while a subagent is live.
  setManagerRunning(opts.confirmManual === true);

  return {
    root,
    config,
    meta,
    ctx,
    wakes,
    bus,
    boundRun: run ? JSON.parse(JSON.stringify(run)) : undefined,
    pendingPreset: JSON.parse(JSON.stringify(pendingPreset)),
  };
}

/** Concatenate EVERY audit file under the case root (pipeline AND system log). */
function readAllAudit(root: string): string {
  const base = join(root, ".pi", "audit");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, "utf-8"));
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out.join("\n");
}

/** Number of lines carrying EXACTLY this event token (`... - [LEVEL] event | ...`). */
function countEvents(content: string, event: string): number {
  const re = new RegExp(`\\] ${event} \\|`);
  return content.split("\n").filter((l) => re.test(l)).length;
}

/** Parse the LAST exact-event audit line into its `k=v` map. */
function fieldsOfLast(content: string, event: string): Record<string, string> {
  const re = new RegExp(`\\] ${event} \\|`);
  const lines = content.split("\n").filter((l) => re.test(l));
  if (lines.length === 0) throw new Error(`no audit line for event "${event}" in:\n${content}`);
  const out: Record<string, string> = {};
  for (const part of lines[lines.length - 1]!.split(" | ").slice(1)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

// ─── ⑫ gate keeps precedence over the defer (R6-5) ───────────────────────────

describe("216 P3: child defer ordering vs the manual confirm gate", () => {
  it("⑫ manual gate + child + bound run → gate suppressed, NO defer, run untouched", async () => {
    const c = await makeSettleCase({ label: "gate-before-defer", confirmManual: true, bound: true });
    let selectCalls = 0;
    c.ctx.ui.select = async () => { selectCalls++; return undefined; };

    await createAgentSettled(c.config).handler(c.ctx as never);

    const file = readAllAudit(c.root);
    // The child hit the gate first — the suppression branch returns BEFORE the
    // defer block, so `stage_settle_child_deferred` never appears.
    expect(countEvents(file, "confirm_gate_suppressed_child")).toBe(1);
    expect(countEvents(file, "stage_settle_child_deferred")).toBe(0);
    expect(countEvents(file, "stage_advance")).toBe(0);

    expect(selectCalls).toBe(0);
    expect(refusalEvents()).toHaveLength(0);
    expect(c.meta.currentStage).toBe("plan");
    expect(c.meta.stageExitRefusal).toBeUndefined();
    // The owner-bound run stays exactly as persisted — unconsumed.
    expect(c.meta.stageExecutorRun).toEqual(c.boundRun);
    expect(c.meta.stageExecutorRun!.terminalConsumed).toBe(false);
  });
});

// ─── ⑬ the defer itself ──────────────────────────────────────────────────────

describe("216 P3: child settles over an owner-bound run → deferred to the owner", () => {
  it("⑬ bound run + no gate → ONE deferred audit + ONE escalated arm, zero advance surface", async () => {
    const c = await makeSettleCase({ label: "defer-fire", bound: true });
    let selectCalls = 0;
    c.ctx.ui.select = async () => { selectCalls++; return undefined; };

    await createAgentSettled(c.config).handler(c.ctx as never);

    const file = readAllAudit(c.root);
    expect(countEvents(file, "stage_settle_child_deferred")).toBe(1);
    // The deferred-exit promise: NO advance, NO usage, NO wake, NO spawn.
    expect(countEvents(file, "stage_advance")).toBe(0);
    expect(countEvents(file, "stage_usage")).toBe(0);
    expect(countEvents(file, "auto_advance_wake")).toBe(0);
    expect(c.wakes).toHaveLength(0);
    expect(selectCalls).toBe(0);

    // The deferred audit carries the owner-mismatch truth + the run identity.
    const f = fieldsOfLast(file, "stage_settle_child_deferred");
    expect(f.stage).toBe("plan");
    expect(f.reason).toBe("bound_run_owner_mismatch");
    expect(f.runId).toBe(RUN_ID);

    // First child-origin defer → ONE escalated owner arm (running, no freeze).
    expect(refusalEvents().map((e) => e.event)).toEqual(["stage_exit_refusal_escalated"]);
    const escalated = eventsFor("stage_exit_refusal_escalated")[0]!;
    expect(escalated.level).toBe("warn");
    expect(escalated.message).toMatchObject({
      stage: "plan",
      toStage: "develop",
      reason: "bound_run_owner_mismatch",
      count: "1",
      source: "hook_settle",
    });
    const refusal = c.meta.stageExitRefusal!;
    expect(refusal.count).toBe(1);
    expect(refusal.frozenCount).toBe(0);
    expect(typeof refusal.escalatedAt).toBe("number");
    expect(getFlowState(c.meta)).toBe("running");
    expect(eventsFor("pipeline_blocked")).toHaveLength(0);

    // Exactly ONE owner-wake broadcast with the matching credential.
    expect(c.bus).toHaveLength(1);
    expect(c.bus[0]!.name).toBe(PIPELINE_ESCALATION_EVENT);
    expect(c.bus[0]!.payload).toMatchObject({
      pipelineId: c.meta.pipelineId,
      stage: "plan",
      reason: STAGE_EXIT_REFUSED_ESCALATION_REASON,
      at: refusal.escalatedAt,
    });

    // Untouched ownership / spawn / attempt state (defer = zero side effects
    // on everything the OWNER owns).
    expect(c.meta.currentStage).toBe("plan");
    expect(c.meta.stageExecutorRun).toEqual(c.boundRun);
    expect(c.meta.pendingSpawns).toEqual(c.pendingPreset);
    expect(c.meta.verifyAttempts).toBe(2);
  });
});

// ─── ⑭ baseline: no bound run → the child advances exactly as before ─────────

describe("216 P3: child WITHOUT a bound run keeps the verbatim baseline", () => {
  it("⑭ no bound run → real plan→develop advance, zero defer/refusal noise", async () => {
    const c = await makeSettleCase({ label: "no-bound-baseline" });

    await createAgentSettled(c.config).handler(c.ctx as never);

    const file = readAllAudit(c.root);
    expect(countEvents(file, "stage_settle_child_deferred")).toBe(0);
    expect(countEvents(file, "confirm_gate_suppressed_child")).toBe(0);
    expect(countEvents(file, "stage_advance")).toBe(1);

    expect(c.meta.currentStage).toBe("develop");
    expect(c.meta.previousStage).toBe("plan");
    expect(refusalEvents()).toHaveLength(0);
    expect(c.bus).toHaveLength(0);
    expect(eventsFor("pipeline_blocked")).toHaveLength(0);
  });
});

// ─── ⑮ reset scopes: continue / new period / real transition / quit ──────────

describe("216 P3: refusal-counter reset scopes", () => {
  const burnedVisit: StageExitRefusal = {
    stage: "develop",
    fromStage: "develop",
    toStage: "review",
    reason: "bound_run_owner_mismatch",
    count: 2,
    frozenCount: 1,
    lastAt: 1_700_000_000_000,
    escalatedAt: 1_700_000_000_500,
  };

  it("⑮a continue clears count + credential but KEEPS the visit frozenCount; new period clears all", () => {
    const config = makeTestConfig();
    const withCounter = makeTestMeta({ stageExitRefusal: { ...burnedVisit } });

    const cont = buildContinueResetFields(withCounter, config);
    expect("stageExitRefusal" in cont).toBe(true);
    expect(cont.stageExitRefusal).toEqual({ ...burnedVisit, count: 0, escalatedAt: undefined });

    // No counter to continue from → the key is not written at all.
    const contPlain = buildContinueResetFields(makeTestMeta(), config);
    expect("stageExitRefusal" in contPlain).toBe(false);

    // A NEW period is a fresh visit chain — the whole field clears.
    const fresh = buildNewPeriodResetFields(withCounter, config);
    expect("stageExitRefusal" in fresh).toBe(true);
    expect(fresh.stageExitRefusal).toBeUndefined();
  });

  it("⑮b a real transition clears the counter (no stale carry-over to the next visit)", async () => {
    const c = await makeSettleCase({
      label: "transition-clear",
      meta: () => ({
        stageExitRefusal: {
          stage: "plan", fromStage: "plan", toStage: "develop",
          reason: "bound_run_owner_mismatch", count: 1, frozenCount: 0,
          lastAt: 1_700_000_000_000,
        },
      }),
    });

    await createAgentSettled(c.config).handler(c.ctx as never);

    expect(c.meta.currentStage).toBe("develop");
    expect(c.meta.stageExitRefusal).toBeUndefined();
    expect(refusalEvents()).toHaveLength(0);
  });

  it("⑮c /pipeline-quit clears the counter (boundary must not leak into the next run)", async () => {
    const c = await makeSettleCase({
      label: "quit-clear",
      meta: () => ({ stageExitRefusal: { ...burnedVisit } }),
    });

    const result = (await createPipelineQuitCommand(c.config).execute({}, c.ctx as never)) as {
      success?: boolean;
    };

    expect(result.success).toBe(true);
    expect(c.meta.stageExitRefusal).toBeUndefined();
    expect(c.meta.terminateReason).toBe("user_quit");
  });

  // ─── code-review round 1 (issue 2): NON-auto migrations must clear too ─────

  it("⑮d `stage_advance` (the owner recovery path) clears the counter", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      // Same-stage counter from the PREVIOUS visit: without the reset the next
      // develop refusal would be read as `count=2` → immediate freeze.
      stageExitRefusal: {
        stage: "develop", fromStage: "develop", toStage: "review",
        reason: "bound_run_owner_mismatch", count: 2, frozenCount: 1,
        lastAt: 1_700_000_000_000,
      },
    });
    const ctx = createMockCtx(meta);

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as never)) as { success?: boolean };

    expect(result.success).toBe(true);
    const persisted = ctx.session.getMeta() as SessionMeta;
    expect(persisted.currentStage).toBe("review");
    expect(persisted.stageExitRefusal).toBeUndefined();
  });

  it("⑮e confirm REJECT route clears the counter (rework visit starts clean)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      previousStage: "clarify",
      pipelineId: nextPid(),
      stageExitRefusal: {
        stage: "plan", fromStage: "plan", toStage: "design-review",
        reason: "bound_run_owner_mismatch", count: 1, frozenCount: 0,
        lastAt: 1_700_000_000_000,
      },
    });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Rework (back to clarify)" });

    const gate = await maybeHandleConfirmGate(
      config,
      ctx as never,
      ctx.session.getMeta() as SessionMeta,
      { notify: () => {} } as never,
      { mode: "manual" },
    );

    expect(gate).toMatchObject({ result: "handled", action: "routed" });
    const persisted = ctx.session.getMeta() as SessionMeta;
    expect(persisted.currentStage).toBe("clarify");
    expect(persisted.stageExitRefusal).toBeUndefined();
  });

  it("⑮f Auto Review Plan authorization commit clears the counter", async () => {
    const root = join(tmpdir(), `pi-216-autoreview-${Date.now()}-${seq}`);
    await mkdir(join(root, "docs", "design"), { recursive: true });
    await writeFile(join(root, "docs", "design", "216_Req_Plan.md"), "# Plan\n", "utf-8");
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({
      currentStage: "plan",
      previousStage: "clarify",
      requirementDoc: "docs/design/216_Req.md",
      pipelineId: nextPid(),
      stageExitRefusal: { ...burnedVisit, stage: "plan", fromStage: "plan", toStage: "develop" },
    });
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });

    const gate = await maybeHandleConfirmGate(
      config,
      ctx as never,
      ctx.session.getMeta() as SessionMeta,
      { notify: () => {} } as never,
      { mode: "manual" },
    );

    expect(gate.result).toBe("handled");
    const persisted = ctx.session.getMeta() as SessionMeta;
    expect(persisted.currentStage).toBe("design-review");
    expect(persisted.stageExitRefusal).toBeUndefined();
  });
});

// ─── ⑯ the child freeze arms the OWNER menu only — never pops locally ────────

describe("216 P3: child-triggered freeze routes to the owner arm (R6-7)", () => {
  it("⑯ second same-cause refusal → frozen with menu_escalation arms ONLY, no menu in the child TUI", async () => {
    const c = await makeSettleCase({ label: "double-call-frozen" });
    const refusalCtx = c.ctx as unknown as Parameters<typeof recordStageExitRefusal>[0];
    const INPUT = {
      stage: "plan" as const,
      fromStage: "plan" as const,
      toStage: "develop" as const,
      reason: "bound_run_owner_mismatch",
      source: "hook_settle" as const,
    };
    let selectCalls = 0;
    c.ctx.ui.select = async () => { selectCalls++; return undefined; };

    // 1st same-cause defer → escalated (owner armed, running kept) — ⑬ shape.
    expect(await recordStageExitRefusal(refusalCtx, c.config, INPUT)).toBe("escalated");
    audits = [];
    c.bus.length = 0;

    // 2nd same-cause defer → freeze + owner handoff (the incident escalation
    // form: this is the same-visit endgame BEFORE the abort fuse).
    expect(await recordStageExitRefusal(refusalCtx, c.config, INPUT)).toBe("frozen");

    expect(eventsFor("stage_exit_refusal_overflow")).toHaveLength(1);
    expect(eventsFor("pipeline_blocked")).toHaveLength(1);
    expect(getFlowState(c.meta)).toBe("blocked");
    expect(c.meta.blockedReason).toBe(STAGE_EXIT_REFUSED_OVERFLOW_REASON);
    expect(c.meta.stageExitRefusal).toMatchObject({ count: 2, frozenCount: 1 });

    // The OWNER menu channels ONLY…
    expect(eventsFor("menu_escalation_armed")).toHaveLength(1);
    expect(eventsFor("menu_escalation_broadcast")).toHaveLength(1);
    expect(c.meta.menuEscalationPending).toBe(true);
    expect(c.bus.map((b) => b.payload.reason)).toEqual([STAGE_EXIT_REFUSED_OVERFLOW_REASON]);

    // …and NO decision provider ran in the child TUI (ensureDecisionMenu
    // untouched — a local menu would either pop here or abort headless).
    expect(selectCalls).toBe(0);
    expect(eventsFor("decision_menu_presented")).toHaveLength(0);
    expect(eventsFor("decision_deadline_armed")).toHaveLength(0);
    expect(eventsFor("pipeline_session_aborted")).toHaveLength(0);
  });
});
