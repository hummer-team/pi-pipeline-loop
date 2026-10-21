/**
 * 210 Phase 3: confirm-stall convergence into the unified decision provider chain.
 *
 * Coverage (per plan):
 * - the THREE stall entries (gate no-UI / reject-overflow pending / re-ask
 *   exhausted) each under decisionPolicy ON and OFF (behaviour matrix);
 * - policy OFF keeps the baseline verbatim: pending + notify, NO freeze
 *   (constraint 4 — zero new state writes / timers);
 * - policy ON converges the stall to `confirm_awaiting_human`:
 *   no-UI → immediate chain (rule applies / provider-absent abort);
 *   UI present → human slot with the decision-wait deadline armed;
 * - `resume` is not available for this reason: load-time rejection via
 *   validateDecisionPolicy AND runtime miss via resolveRule (wildcard rules
 *   cannot smuggle it past the allowed set).
 *
 * Harness notes: safeWrite audits are captured in-memory (the freeze / abort /
 * decision events); gate-internal `writeAuditLog` events stay file-backed via
 * the per-case tmp root. Every timer-touching case uses a UNIQUE pipelineId
 * (the runtime table is process-global) and `clearAllDecisionTimers` in
 * afterEach.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { maybeHandleConfirmGate } from "../../core/stage-advancer";
import { createAgentSettled } from "../../core/agent-settled";
import { clearAllDecisionTimers, getFlowState } from "../../core/flow-state";
import { __hasDecisionDeadline } from "../../core/decision-menu-runtime";
import {
  allowedDecisions,
  validateDecisionPolicy,
  resolveRule,
} from "../../core/decision-policy/policy-config";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { CONFIRM_GATE_REASK_MAX } from "../../constants";
import type { DecisionPolicyConfig, PipelineConfig, SessionMeta } from "../../types";

/** Captured safeWrite audit records (in-memory — no file/routing dependency). */
interface CapturedAudit {
  event: string;
  message?: Record<string, string | boolean>;
  level?: string;
}
let audits: CapturedAudit[] = [];

/** Unique pipelineId per case: the decision-timer table is process-global. */
let idCounter = 0;
function uniquePipelineId(): string {
  idCounter++;
  return `pipe-confirm-drift-${idCounter}`;
}

/** Monotonic per-case tmp root so file-backed gate audits never collide. */
let caseTmpSeq = 0;
async function makeCaseRoot(): Promise<string> {
  caseTmpSeq++;
  const root = path.join(tmpdir(), `pi-confirm-drift-${Date.now()}-${caseTmpSeq}`);
  await fs.mkdir(root, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: root }));
  return root;
}

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message: message as Record<string, string | boolean> | undefined, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
});

function auditEvents(event: string): CapturedAudit[] {
  return audits.filter((a) => a.event === event);
}

/** Plan-stage config with manual confirm + hook verify (matches the
 *  agent-settled-confirm-review fixture so the settle reaches the gate). */
function planManualConfig(root: string, maxRejections?: number): PipelineConfig {
  const base = makeTestConfig({ projectRoot: root });
  const planStage = {
    ...base.stages.plan,
    nextStage: "develop" as const,
    verify: { require: true },
    allowedWritePaths: ["docs/"],
    confirm: { mode: "manual" as const, ...(maxRejections !== undefined ? { maxRejections } : {}) },
  };
  return { ...base, stages: { ...base.stages, plan: planStage as typeof base.stages.plan } };
}

/** Review-stage config with a manual confirm gate (Reject routes to fix). */
function reviewManualConfig(root: string, maxRejections: number): PipelineConfig {
  const base = makeTestConfig({ projectRoot: root });
  const reviewStage = {
    ...base.stages.review,
    allowedWritePaths: ["docs/"],
    confirm: { mode: "manual" as const, maxRejections },
  };
  return { ...base, stages: { ...base.stages, review: reviewStage as typeof base.stages.review } };
}

/** Attach an ENABLED decisionPolicy block (mirrors loader normalization). */
function withPolicy(config: PipelineConfig, policy?: DecisionPolicyConfig): PipelineConfig {
  return {
    ...config,
    decisionPolicy: { ...(policy ?? {}), enabled: true },
  };
}

/** Write a plan doc WITHOUT the confirm marker so the gate really fires. */
async function createPlanDoc(root: string): Promise<void> {
  const docsDir = path.join(root, "docs", "design");
  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "77_Config_Plan.md"), "# Plan\nno marker yet\n", "utf-8");
}

/** verify.md (requiredFiles rule) that PASSES, for the agent-settled chain. */
async function createPassingVerifyMd(root: string): Promise<void> {
  const stageDir = path.join(root, ".pi", "references", "plan_spec");
  await fs.mkdir(stageDir, { recursive: true });
  await fs.writeFile(
    path.join(stageDir, "verify.md"),
    `---\nrequiredFiles:\n  - "docs/design/77_Config_Plan.md"\n---\nVerify plan.`,
    "utf-8",
  );
}

/** Plan-stage meta on a RUNNING pipeline (flowState unset = running). */
function runningPlanMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    pipelineId: uniquePipelineId(),
    currentStage: "plan",
    requirementDoc: "docs/design/77_Config.md",
    ...overrides,
  });
}

/** Sequential ui.select: returns the queued answers, undefined after empty. */
function sequencedSelect(answers: Array<string | undefined>): (message: string, options: string[]) => Promise<string | undefined> {
  const queue = [...answers];
  return async () => (queue.length > 0 ? queue.shift() : undefined);
}

/** Poll `predicate` until true (timing-robust assert for async arming). */
async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<boolean> {
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ─── Entry 1: maybeHandleConfirmGate no-UI branch (plan task 3.3) ────────────

describe("Phase 3: confirm gate no-UI branch → confirm_awaiting_human convergence", () => {
  it("policy OFF: baseline pending, zero freeze/state writes (constraint 4)", async () => {
    const root = await makeCaseRoot();
    await createPlanDoc(root);
    const config = planManualConfig(root);
    const meta = runningPlanMeta();
    const ctx = createMockCtx(meta);
    delete ctx.ui.select; // headless: no ui.select

    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as never, { mode: "manual" });

    expect(result.result).toBe("handled");
    if (result.result === "handled") expect(result.action).toBe("pending");
    // Baseline untouched: still running, no freeze audit, no chain audit.
    expect(getFlowState(meta)).toBe("running");
    expect(meta.flowState).toBeUndefined();
    expect(auditEvents("pipeline_blocked")).toHaveLength(0);
    expect(auditEvents("pipeline_session_aborted")).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("policy ON + no rule: freeze then provider-chain converges to abort (decision_provider_absent)", async () => {
    const root = await makeCaseRoot();
    await createPlanDoc(root);
    const config = withPolicy(planManualConfig(root));
    const meta = runningPlanMeta();
    const ctx = createMockCtx(meta);
    delete ctx.ui.select;

    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as never, { mode: "manual" });
    expect(result.result).toBe("handled");

    // Unified freeze path ran: blocked + pipeline_blocked with the new reason…
    expect(auditEvents("pipeline_blocked")).toHaveLength(1);
    expect(auditEvents("pipeline_blocked")[0].message?.reason).toBe("confirm_awaiting_human");
    // …then, no UI → no rule → provider-absent abort (requirement 5.3 step 4).
    expect(getFlowState(meta)).toBe("aborted");
    expect(meta.terminateReason).toBe("decision_provider_absent");
    const abort = auditEvents("pipeline_session_aborted")[0];
    expect(abort.message?.reason).toBe("decision_provider_absent");
    // Human-visible abort notification (acceptance: formatAbortedNotifyText).
    expect(ctx.notifications.some((n) => n.includes("decision_provider_absent"))).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("policy ON + rule abort: applied through executeDecision with decisionSource=policy", async () => {
    const root = await makeCaseRoot();
    await createPlanDoc(root);
    const config = withPolicy(planManualConfig(root), {
      byReason: { "confirm_awaiting_human": { decision: "abort" } },
    });
    const meta = runningPlanMeta();
    const ctx = createMockCtx(meta);
    delete ctx.ui.select;

    const ui = { notify: () => {} };
    await maybeHandleConfirmGate(config, ctx, meta, ui as never, { mode: "manual" });

    expect(getFlowState(meta)).toBe("aborted");
    // The decision went through the SAME channel as a human one (I4):
    // pipeline_decision carries decision=abort + decisionSource=policy.
    const decision = auditEvents("pipeline_decision")[0];
    expect(decision).toBeDefined();
    expect(decision.message?.decision).toBe("abort");
    expect(decision.message?.decisionSource).toBe("policy");
    expect(decision.message?.trigger).toBe("no_ui");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("policy ON + wildcard resume rule: ILLEGAL for this reason → miss → provider-absent abort (never auto-resume a confirm stall)", async () => {
    const root = await makeCaseRoot();
    await createPlanDoc(root);
    const config = withPolicy(planManualConfig(root), {
      byReason: { "*": { decision: "resume" } },
    });
    const meta = runningPlanMeta();
    const ctx = createMockCtx(meta);
    delete ctx.ui.select;

    const ui = { notify: () => {} };
    await maybeHandleConfirmGate(config, ctx, meta, ui as never, { mode: "manual" });

    // resolveRule must refuse the wildcard resume for confirm_awaiting_human…
    expect(resolveRule(meta, config, "confirm_awaiting_human")).toBeNull();
    // …so the stall aborts instead of silently un-freezing (Q15=A).
    expect(getFlowState(meta)).toBe("aborted");
    expect(meta.terminateReason).toBe("decision_provider_absent");
    expect(auditEvents("pipeline_decision")).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });
});

// ─── Entry 2: reject-overflow pending (plan task 3.1) ────────────────────────

describe("Phase 3: reject-overflow pending → convergence at the caller", () => {
  it("policy OFF: Esc on the overflow dialog keeps baseline pending (no freeze)", async () => {
    const root = await makeCaseRoot();
    const config = reviewManualConfig(root, 3);
    const meta = makeTestMeta({
      pipelineId: uniquePipelineId(),
      currentStage: "review",
      confirmRejections: 3, // nextCount 4 > max 3 → overflow
    });
    // Reject → overflow dialog → Esc (undefined) → pending.
    const ctx = createMockCtx(meta);
    ctx.ui.select = sequencedSelect(["Reject & Send to Fix", undefined, undefined]);

    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as never, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") expect(result.action).toBe("pending");

    expect(getFlowState(meta)).toBe("running");
    expect(auditEvents("pipeline_blocked")).toHaveLength(0);
    // Count untouched by the overflow-pending branch (baseline semantics).
    expect(meta.confirmRejections).toBe(3);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("policy ON: overflow pending converges to the human slot (blocked + deadline armed, no immediate abort)", async () => {
    const root = await makeCaseRoot();
    const config = withPolicy(reviewManualConfig(root, 3));
    const meta = makeTestMeta({
      pipelineId: uniquePipelineId(),
      currentStage: "review",
      confirmRejections: 3,
    });
    // Reject → overflow Esc → decision menu dismiss (chain keeps the human slot
    // because ui.select EXISTS; the deadline owns the timeout convergence).
    const ctx = createMockCtx(meta);
    ctx.ui.select = sequencedSelect(["Reject & Send to Fix", undefined, undefined]);

    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as never, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") expect(result.action).toBe("pending");

    expect(auditEvents("pipeline_blocked")).toHaveLength(1);
    expect(auditEvents("pipeline_blocked")[0].message?.reason).toBe("confirm_awaiting_human");
    expect(getFlowState(meta)).toBe("blocked");
    expect(meta.blockedReason).toBe("confirm_awaiting_human");
    // Q12=A: the human got the slot first — the abort only arms via deadline.
    expect(await waitUntil(() => __hasDecisionDeadline(meta.pipelineId))).toBe(true);
    expect(auditEvents("pipeline_session_aborted")).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });
});

// ─── Entry 3: agent-settled re-ask exhausted (plan task 3.2) ────────────────

describe("Phase 3: agent_settled re-ask exhausted → convergence", () => {
  /** Drive settles with a dismissing gate until the re-ask budget is spent. */
  async function exhaustReask(config: PipelineConfig, meta: SessionMeta, ctx: ReturnType<typeof createMockCtx>) {
    const hook = createAgentSettled(config);
    for (let i = 1; i <= CONFIRM_GATE_REASK_MAX; i++) {
      await hook.handler(ctx as never);
    }
    expect(meta.confirmGateReask).toEqual({ stage: "plan", count: CONFIRM_GATE_REASK_MAX });
    return hook;
  }

  it("policy OFF: notify-only after the cap, pipeline stays running (baseline verbatim)", async () => {
    const root = await makeCaseRoot();
    await createPlanDoc(root);
    await createPassingVerifyMd(root);
    const config = planManualConfig(root);
    const meta = runningPlanMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined; // every popup dismisses (Esc)

    const hook = await exhaustReask(config, meta, ctx);
    const selectsBefore = ctx.notifications.length;
    await hook.handler(ctx as never);

    // No further popup (cap spent) — notify only, exactly as before Phase 3.
    expect(ctx.notifications.length).toBeGreaterThan(selectsBefore);
    expect(getFlowState(meta)).toBe("running");
    expect(auditEvents("pipeline_blocked")).toHaveLength(0);
    expect(auditEvents("pipeline_session_aborted")).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("policy ON: exhausted re-ask budget freezes via confirm_awaiting_human with the human slot armed", async () => {
    const root = await makeCaseRoot();
    await createPlanDoc(root);
    await createPassingVerifyMd(root);
    const config = withPolicy(planManualConfig(root));
    const meta = runningPlanMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;

    const hook = await exhaustReask(config, meta, ctx);
    await hook.handler(ctx as never);

    expect(auditEvents("pipeline_blocked")).toHaveLength(1);
    expect(auditEvents("pipeline_blocked")[0].message?.reason).toBe("confirm_awaiting_human");
    expect(getFlowState(meta)).toBe("blocked");
    expect(meta.blockedReason).toBe("confirm_awaiting_human");
    // UI exists (select present) → human-first: deadline armed, no abort yet.
    expect(await waitUntil(() => __hasDecisionDeadline(meta.pipelineId))).toBe(true);
    expect(auditEvents("pipeline_session_aborted")).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("policy ON + no UI: exhausted re-ask converges immediately to provider-absent abort", async () => {
    const root = await makeCaseRoot();
    await createPlanDoc(root);
    await createPassingVerifyMd(root);
    const config = withPolicy(planManualConfig(root));
    const meta = runningPlanMeta();
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;

    const hook = await exhaustReask(config, meta, ctx);
    // UI disappears (headless degradation): the chain must not wait forever.
    delete ctx.ui.select;
    await hook.handler(ctx as never);

    expect(getFlowState(meta)).toBe("aborted");
    expect(meta.terminateReason).toBe("decision_provider_absent");
    await fs.rm(root, { recursive: true, force: true });
  });
});

// ─── Allowed-set contract (plan task 3.4, acceptance: load-time rejection) ───

describe("Phase 3: confirm_awaiting_human allowed-set contract", () => {
  it("allowedDecisions for confirm_awaiting_human is exactly restart|abort", () => {
    const allowed = allowedDecisions("confirm_awaiting_human");
    expect([...allowed].sort()).toEqual(["abort", "restart"]);
    expect(allowed.has("resume")).toBe(false);
    expect(allowed.has("skip")).toBe(false);
  });

  it("validateDecisionPolicy throws at load time for resume / skip under this reason (message names reason + decision)", () => {
    expect(() =>
      validateDecisionPolicy({ enabled: true, byReason: { confirm_awaiting_human: { decision: "resume" } } }),
    ).toThrow(/confirm_awaiting_human/);
    expect(() =>
      validateDecisionPolicy({ enabled: true, byReason: { confirm_awaiting_human: { decision: "resume" } } }),
    ).toThrow(/resume/);
    expect(() =>
      validateDecisionPolicy({
        enabled: true,
        stages: { review: { byReason: { confirm_awaiting_human: { decision: "skip" } } } },
      }),
    ).toThrow(/stages\.review/);
  });

  it("validateDecisionPolicy ACCEPTS restart for this reason (legal rules stay loadable)", () => {
    expect(() =>
      validateDecisionPolicy({ enabled: true, byReason: { confirm_awaiting_human: { decision: "restart" } } }),
    ).not.toThrow();
  });

  it("stage rule resume under a plain reason is still legal (contract is reason-scoped, not decision-scoped)", () => {
    const policy: DecisionPolicyConfig = {
      enabled: true,
      stages: { review: { byReason: { max_loop_cycles: { decision: "resume" } } } },
    };
    expect(() => validateDecisionPolicy(policy)).not.toThrow();
    const config = withPolicy(makeTestConfig(), policy);
    // resolveRule only refuses it when the ACTUAL freeze reason disallows it.
    expect(resolveRule(makeTestMeta({ currentStage: "review" }), config, "max_loop_cycles")?.rule.decision).toBe("resume");
    expect(resolveRule(makeTestMeta({ currentStage: "review" }), config, "confirm_awaiting_human")).toBeNull();
  });
});
