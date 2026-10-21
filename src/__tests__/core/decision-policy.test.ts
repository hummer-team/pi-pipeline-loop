/**
 * 210 Phase 1: decision-provider chain (human → policy → abort).
 *
 * Coverage (per plan):
 * - resolveRule stage-override priority + wildcard + allowed sets (policy-config)
 * - no-UI path: matched rule auto-advances, no rule → decision_provider_absent
 * - B-3: guard-rejected policy → policy_decision_rejected, no retry loop
 * - timeout path: deadline fires while blocked → policy applies / aborts
 * - B-2 stale-state guard: pipelineId changed or state left frozen → zero writes
 *
 * 210 review issue 3 adds: the reload / command presentation entries
 * (`session-starter` replay, `/pipeline-resume`, `/pipeline-start`, settle
 * re-presentation) go through `requestDecision` as well, so a freeze restored
 * from disk re-arms the decision deadline (UI) or converges to
 * `decision_provider_absent` (headless) instead of stalling forever.
 *
 * Timing notes: every case that depends on a timer uses its OWN pipelineId
 * (the runtime table is process-global and shared with other test files) and
 * asserts outcomes by polling instead of sleeping a fixed budget, so heavy
 * concurrent runs cannot reorder the freeze / arm / fire sequence.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  freezeAndPrompt,
  ensureDecisionMenu,
  clearAllDecisionTimers,
  getFlowState,
  requestDecision,
  resolveDecisionReason,
} from "../../core/flow-state";
import { __hasDecisionDeadline } from "../../core/decision-menu-runtime";
import {
  resolveRule,
  isDecisionPolicyEnabled,
} from "../../core/decision-policy/policy-config";
import { tryApplyPolicy } from "../../core/decision-policy/policy-provider";
import type { FlowStateCtx } from "../../core/flow-state";
import type { DecisionPolicyConfig, PipelineConfig, SessionMeta } from "../../types";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";

/** Captured audit records (in-memory override — no file/routing dependency). */
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
});

/** All audit records for an event name. */
function auditEvents(event: string): CapturedAudit[] {
  return audits.filter((a) => a.event === event);
}

/** Monotonic counter → unique pipelineId per case (shared global timer table). */
let idCounter = 0;
function uniquePipelineId(): string {
  idCounter++;
  return `pipe-policy-test-${idCounter}`;
}

/** Policy-enabled config factory. */
function policyConfig(policy: DecisionPolicyConfig): PipelineConfig {
  return makeTestConfig({ decisionPolicy: { enabled: true, ...policy } });
}

/** Minimal ctx that satisfies FlowStateCtx with a controllable ui.select. */
function makeFlowCtx(
  meta: SessionMeta,
  opts?: {
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    noUI?: boolean;
    notify?: (message: string) => void;
  },
): FlowStateCtx & { updates: Partial<SessionMeta>[] } {
  const updates: Partial<SessionMeta>[] = [];
  const ctx = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        updates.push(patch);
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: opts?.noUI
      ? { ...(opts?.notify ? { notify: opts.notify } : {}) }
      : {
          select: opts?.select ?? (async () => undefined),
          ...(opts?.notify ? { notify: opts.notify } : {}),
        },
    _ctx: {
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
        // getSessionFile intentionally absent → restart skips registry writes
      },
    },
    updates,
  } as unknown as FlowStateCtx & { updates: Partial<SessionMeta>[] };
  return ctx;
}

/** Running-state meta that `freezeAndPrompt` freezes on entry. */
function blockedMeta(reason: string, overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    pipelineId: uniquePipelineId(),
    blockedReason: reason,
    ...overrides,
  });
}

/** Already-frozen meta for entries that bypass `freezeAndPrompt` (guards). */
function frozenMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    pipelineId: uniquePipelineId(),
    flowState: "blocked",
    blockedReason: "violation_overflow",
    ...overrides,
  });
}

/** Deferred handle that keeps a `ui.select` dialog open until released. */
function deferredSelect(): {
  promise: Promise<string | undefined>;
  release: (value: string | undefined) => void;
} {
  let release!: (value: string | undefined) => void;
  const promise = new Promise<string | undefined>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Polls `predicate` until true (or the budget elapses) — timing-robust assert. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<boolean> {
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ─── policy-config: resolveRule ──────────────────────────────────────────────

describe("resolveRule / isDecisionPolicyEnabled", () => {
  it("stage override wins over global (Q6=A)", () => {
    const config = policyConfig({
      byReason: { violation_overflow: { decision: "abort" } },
      stages: { review: { byReason: { violation_overflow: { decision: "restart" } } } },
    });
    const stageMeta = makeTestMeta({ currentStage: "review" });
    const otherMeta = makeTestMeta({ currentStage: "fix" });
    expect(resolveRule(stageMeta, config, "violation_overflow")?.rule.decision).toBe("restart");
    expect(resolveRule(otherMeta, config, "violation_overflow")?.rule.decision).toBe("abort");
    expect(resolveRule(otherMeta, config, "violation_overflow")?.origin).toBe("global");
    expect(resolveRule(stageMeta, config, "violation_overflow")?.origin).toBe("stage");
  });

  it("no entry / policy off resolves to null", () => {
    const config = policyConfig({ byReason: { max_loop_cycles: { decision: "resume" } } });
    expect(resolveRule(makeTestMeta(), config, "violation_overflow")).toBeNull();
    // stage has no entry for the reason but global has one for another reason
    const offConfig = makeTestConfig({
      decisionPolicy: { enabled: false, byReason: { violation_overflow: { decision: "abort" } } },
    });
    expect(isDecisionPolicyEnabled(offConfig)).toBe(false);
    expect(resolveRule(makeTestMeta(), offConfig, "violation_overflow")).toBeNull();
  });

  it("wildcard `*` matches any reason but never bypasses the per-reason set (B-1)", () => {
    const config = policyConfig({ byReason: { "*": { decision: "resume" } } });
    // Plain freeze reason → the wildcard entry applies.
    expect(resolveRule(makeTestMeta(), config, "violation_overflow")?.rule.decision).toBe("resume");
    // confirm_awaiting_human allows only restart|abort → `resume` must NOT resolve.
    expect(resolveRule(makeTestMeta(), config, "confirm_awaiting_human")).toBeNull();
  });

  it("stage exact reason wins over stage wildcard, stage wildcard over global", () => {
    const config = policyConfig({
      byReason: { "*": { decision: "restart" } },
      stages: {
        review: { byReason: { "*": { decision: "abort" }, violation_overflow: { decision: "skip" } } },
      },
    });
    const reviewMeta = makeTestMeta({ currentStage: "review" });
    expect(resolveRule(reviewMeta, config, "violation_overflow")?.rule.decision).toBe("skip");
    expect(resolveRule(reviewMeta, config, "loop_overflow")?.rule.decision).toBe("abort");
    expect(
      resolveRule(makeTestMeta({ currentStage: "fix" }), config, "loop_overflow")?.rule.decision,
    ).toBe("restart");
  });
});

// ─── policy-provider: tryApplyPolicy result shapes ───────────────────────────

describe("tryApplyPolicy", () => {
  it("no matching rule → { applied: false } and no state change", async () => {
    const meta = frozenMeta();
    const ctx = makeFlowCtx(meta, { noUI: true });
    const result = await tryApplyPolicy(
      ctx,
      meta,
      policyConfig({ byReason: { max_loop_cycles: { decision: "abort" } } }),
      "violation_overflow",
      "no_ui",
    );
    expect(result).toEqual({ applied: false });
    expect(ctx.updates.length).toBe(0);
  });

  it("matched rule → routed through executeDecision with decisionSource=policy", async () => {
    const meta = frozenMeta();
    const ctx = makeFlowCtx(meta, { noUI: true });
    const result = await tryApplyPolicy(
      ctx,
      meta,
      policyConfig({ byReason: { violation_overflow: { decision: "abort" } } }),
      "violation_overflow",
      "no_ui",
    );
    expect(result.applied).toBe(true);
    expect(result.decision).toBe("abort");
    expect(getFlowState(meta)).toBe("aborted");
    expect(meta.terminateReason).toBe("user_abort");
  });
});

// ─── no-UI path ──────────────────────────────────────────────────────────────

describe("requestDecision chain (via freezeAndPrompt)", () => {
  it("policy disabled → baseline passthrough: no-UI freeze stays blocked (no abort)", async () => {
    const meta = blockedMeta("violation_overflow");
    const ctx = makeFlowCtx(meta, { noUI: true });
    await freezeAndPrompt(ctx, meta, "violation_overflow", makeTestConfig());
    expect(getFlowState(meta)).toBe("blocked");
    expect(meta.terminateReason).toBeUndefined();
    // Baseline audit shape: no policy visibility fields, no deadline state events.
    const blocked = auditEvents("pipeline_blocked")[0];
    expect(blocked?.message?.policyEnabled).toBeUndefined();
    expect(blocked?.message?.decisionWaitMs).toBeUndefined();
    expect(auditEvents("decision_deadline_armed").length).toBe(0);
    expect(auditEvents("pipeline_session_aborted").length).toBe(0);
  });

  it("enabled + matched rule + no UI → auto-applied (restart) with decisionSource=policy", async () => {
    const meta = blockedMeta("violation_overflow");
    const originalId = meta.pipelineId;
    const ctx = makeFlowCtx(meta, { noUI: true });
    await freezeAndPrompt(ctx, meta, "violation_overflow", policyConfig({
      decisionWaitTimeoutMs: 1234,
      byReason: { violation_overflow: { decision: "restart" } },
    }));
    expect(meta.pipelineId).not.toBe(originalId); // restart executed
    expect(meta.currentStage).toBe("clarify");
    expect(getFlowState(meta)).toBe("running");

    // Requirement 5.3 audit contract: pipeline_decision carries WHO + WHY channel.
    const decision = auditEvents("pipeline_decision")[0];
    expect(decision?.message?.decision).toBe("restart");
    expect(decision?.message?.decisionSource).toBe("policy");
    expect(decision?.message?.trigger).toBe("no_ui");
    // …and the freeze audit exposes the provider-chain configuration.
    const blocked = auditEvents("pipeline_blocked")[0];
    expect(blocked?.message?.policyEnabled).toBe("true");
    expect(blocked?.message?.decisionWaitMs).toBe("1234");
    // No-UI never arms a wait timer (requirement 5.3 step 5).
    expect(auditEvents("decision_deadline_armed").length).toBe(0);
  });

  it("enabled + no rule + no UI → decision_provider_absent abort + aborted notify", async () => {
    const meta = blockedMeta("violation_overflow");
    const notices: string[] = [];
    const ctx = makeFlowCtx(meta, {
      noUI: true,
      notify: (message) => {
        notices.push(message);
      },
    });
    await freezeAndPrompt(ctx, meta, "violation_overflow", policyConfig({}));
    expect(getFlowState(meta)).toBe("aborted");
    expect(meta.terminateReason).toBe("decision_provider_absent");
    // Requirement 5.3 step 4: the abort is announced through the notify channel.
    expect(notices.some((text) => text.includes("decision_provider_absent"))).toBe(true);
  });

  it("B-3: guard-rejected policy (budgetValue <= loopCycleCount) → single-shot abort", async () => {
    const meta = blockedMeta("max_loop_cycles", { loopCycleCount: 3 });
    const ctx = makeFlowCtx(meta, { noUI: true });
    await freezeAndPrompt(ctx, meta, "max_loop_cycles", policyConfig({
      byReason: { max_loop_cycles: { decision: "set_budget", budgetValue: 2 } },
    }));
    expect(getFlowState(meta)).toBe("aborted");
    expect(meta.terminateReason).toBe("policy_decision_rejected");
    // B-3: exactly ONE convergence — the chain never re-applies the policy.
    const updateCount = ctx.updates.length;
    await waitUntil(() => false, 150);
    expect(ctx.updates.length).toBe(updateCount);

    // Acceptance 5.3/B-3 audit pair: the canonical non-application record plus
    // the policy-attributed rejection, each written EXACTLY once (no retry loop).
    const notApplied = auditEvents("decision_not_applied");
    expect(notApplied.length).toBe(1);
    expect(notApplied[0]?.message?.reason).toBe("guard_rejected");
    expect(notApplied[0]?.message?.decisionSource).toBe("policy");
    expect(notApplied[0]?.message?.trigger).toBe("no_ui");
    const rejected = auditEvents("policy_decision_rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.level).toBe("warn");
    expect(auditEvents("pipeline_session_aborted").length).toBe(1);
  });
});

// ─── timeout path (deadline fires while the menu is open) ────────────────────

describe("decision deadline convergence", () => {
  it("deadline fires with matched rule → policy applies (abort), human slot came first", async () => {
    const meta = blockedMeta("violation_overflow");
    const selectCalls: string[] = [];
    const ctx = makeFlowCtx(meta, {
      select: async (message) => {
        selectCalls.push(message);
        return undefined; // nobody answers
      },
    });
    await freezeAndPrompt(ctx, meta, "violation_overflow", policyConfig({
      decisionWaitTimeoutMs: 20,
      byReason: { "*": { decision: "abort" } },
    }));
    expect(selectCalls.length).toBe(1); // human slot was offered first
    expect(await waitUntil(() => getFlowState(meta) === "aborted")).toBe(true);
    expect(meta.terminateReason).toBe("user_abort"); // executed via the abort decision
    // State-audit pair (requirement 5.3): armed BEFORE the presentation, expired
    // at fire time, then the policy decision is attributed to `policy`.
    expect(auditEvents("decision_deadline_armed").length).toBe(1);
    expect(auditEvents("decision_deadline_expired").length).toBe(1);
    const decision = auditEvents("pipeline_decision")[0];
    expect(decision?.message?.decisionSource).toBe("policy");
    expect(decision?.message?.trigger).toBe("timeout");
  });

  it("deadline fires with no rule → decision_unresolved_timeout abort", async () => {
    const meta = blockedMeta("violation_overflow");
    const ctx = makeFlowCtx(meta, { select: async () => undefined });
    await freezeAndPrompt(ctx, meta, "violation_overflow", policyConfig({
      decisionWaitTimeoutMs: 20,
    }));
    // The terminal audit is written AFTER the meta flip (the run aggregate is
    // collected in between), so poll for the record instead of reading it the
    // instant `flowState === "aborted"` lands — same timing-robust rule the
    // rest of this file follows.
    expect(
      await waitUntil(() => auditEvents("pipeline_session_aborted").length > 0),
    ).toBe(true);
    expect(meta.terminateReason).toBe("decision_unresolved_timeout");
    expect(auditEvents("pipeline_session_aborted")[0]?.message?.reason).toBe(
      "decision_unresolved_timeout",
    );
    // A miss never produces a policy decision record.
    expect(auditEvents("pipeline_decision").length).toBe(0);
  });

  it("acceptance 5.3: a selection arriving AFTER the timeout converged is stale (zero writes)", async () => {
    const meta = blockedMeta("violation_overflow");
    const dialog = deferredSelect();
    const ctx = makeFlowCtx(meta, { select: () => dialog.promise });

    // The dialog stays open while the deadline lets the policy decide (abort).
    const menu = freezeAndPrompt(ctx, meta, "violation_overflow", policyConfig({
      decisionWaitTimeoutMs: 40,
      byReason: { "*": { decision: "abort" } },
    }));
    expect(await waitUntil(() => getFlowState(meta) === "aborted")).toBe(true);
    const writesByPolicy = ctx.updates.length; // the policy's own convergence write

    // The human answers late → B-2 guard must reject it without touching state.
    dialog.release("Resume");
    await menu;

    expect(ctx.updates.length).toBe(writesByPolicy); // no second decision applied
    expect(meta.terminateReason).toBe("user_abort"); // still the policy's abort
    expect(meta.flowState).toBe("aborted");
    // Acceptance: the late selection is recorded as stale, nothing else happens.
    expect(auditEvents("decision_menu_stale_selection").length).toBe(1);
    expect(auditEvents("pipeline_decision").length).toBe(1); // the policy's abort only
  });
});

// ─── B-2 stale-state guard ───────────────────────────────────────────────────

describe("B-2 stale-state selection guard", () => {
  it("stale selection after restart race → zero side effects + no state change", async () => {
    const presented = frozenMeta(); // what the menu was shown for
    const originalId = presented.pipelineId;
    let live: SessionMeta = presented;
    let updates = 0;
    const ctx = {
      session: {
        getMeta: () => live,
        updateMeta: (patch: Partial<SessionMeta>) => {
          updates++;
          Object.assign(live, patch);
          return live;
        },
      },
      ui: {
        // Simulate a restart racing with the open dialog: while the user is
        // picking, the meta pipelineId flips (new pipeline period).
        select: async () => {
          live = { ...presented, pipelineId: `pipe-after-restart-${idCounter}` };
          return "Resume";
        },
      },
    } as unknown as FlowStateCtx;
    const result = await ensureDecisionMenu(ctx, presented, makeTestConfig(), {});
    expect(result.failureReason).toBe("stale_state");
    expect(result.unavailableReason).toBe("stale_pipeline");
    expect(updates).toBe(0); // zero side effects
    expect(live.pipelineId).not.toBe(originalId); // the restart won
    expect(getFlowState(live)).toBe("blocked"); // and its frozen state is untouched
  });
});

// ─── deadline convergence guards ─────────────────────────────────────────────

describe("deadline convergence guards", () => {
  it("pipelineId changed before the deadline fires (restart race) → no action on the new period", async () => {
    const meta = frozenMeta();
    const originalId = meta.pipelineId;
    const dialog = deferredSelect();
    const ctx = makeFlowCtx(meta, { select: () => dialog.promise });

    const menu = ensureDecisionMenu(ctx, meta, policyConfig({
      byReason: { "*": { decision: "restart" } },
    }), { decisionDeadlineMs: 40 });

    // Non-vacuous: the deadline really is armed for the ORIGINAL pipeline.
    expect(__hasDecisionDeadline(originalId)).toBe(true);

    // Restart rebinds the period while the old chain's dialog is still open.
    meta.pipelineId = "pipe-after-restart";
    meta.currentStage = "clarify";

    expect(await waitUntil(() => !__hasDecisionDeadline(originalId))).toBe(true); // it fired
    await waitUntil(() => false, 50); // and had room to act
    expect(ctx.updates.length).toBe(0); // the guard suppressed every write
    expect(meta.terminateReason).toBeUndefined();

    dialog.release(undefined);
    await menu;
  });

  it("flowState became aborted before the deadline fires → no policy action", async () => {
    const meta = frozenMeta();
    const originalId = meta.pipelineId;
    const dialog = deferredSelect();
    const ctx = makeFlowCtx(meta, { select: () => dialog.promise });

    const menu = ensureDecisionMenu(ctx, meta, policyConfig({
      byReason: { "*": { decision: "restart" } },
    }), { decisionDeadlineMs: 40 });
    expect(__hasDecisionDeadline(originalId)).toBe(true);

    // An abort (e.g. /pipeline-quit elsewhere) lands while the dialog is open.
    meta.flowState = "aborted";
    meta.terminateReason = "session_quit";

    expect(await waitUntil(() => !__hasDecisionDeadline(originalId))).toBe(true);
    await waitUntil(() => false, 50);
    expect(ctx.updates.length).toBe(0); // deadline must not act on an aborted pipeline
    expect(meta.terminateReason).toBe("session_quit");

    dialog.release(undefined);
    await menu;
  });

  it("aborted while parked at the legacy awaiting_human freeze point → no policy action", async () => {
    // `awaiting_human` alone is a legit decision point, but aborted wins:
    // isDecisionPending must report it as resolved (guards both B-2 and the deadline).
    const meta = frozenMeta({ currentStage: "awaiting_human", flowState: "aborted", terminateReason: "session_quit" });
    const originalId = meta.pipelineId;
    const ctx = makeFlowCtx(meta, { select: async () => undefined });

    await ensureDecisionMenu(ctx, meta, policyConfig({
      byReason: { "*": { decision: "restart" } },
    }), { decisionDeadlineMs: 40 });

    expect(await waitUntil(() => !__hasDecisionDeadline(originalId))).toBe(true);
    await waitUntil(() => false, 50);
    expect(ctx.updates.length).toBe(0);
    expect(meta.terminateReason).toBe("session_quit");
    expect(meta.currentStage).toBe("awaiting_human");
  });
});

// ─── 210 review issue 3: reload / command entries route through the chain ───
//
// A pipeline that froze in a PREVIOUS process lost its decision timer with the
// process. The replay (`session-starter`) and command (`/pipeline-resume`,
// `/pipeline-start`) entries used to call `ensureDecisionMenu` directly, so with
// `decisionPolicy` enabled they re-opened the menu WITHOUT arming the decision
// deadline — R1-1 "no permanent stall without a provider" did not hold there.
// All frozen-presentation entries now go through `requestDecision`.

describe("requestDecision at the reload / command entries (210 review issue 3)", () => {
  it("already-frozen meta + policy enabled + headless → converges to decision_provider_absent", async () => {
    // This is the reload shape: `flowState=blocked` restored from disk, no
    // provider available and nobody at the keyboard.
    const meta = frozenMeta();
    const ctx = makeFlowCtx(meta, { noUI: true });

    const result = await requestDecision(ctx, meta, policyConfig({
      byReason: { max_loop_cycles: { decision: "abort" } }, // no rule for violation_overflow
    }), "violation_overflow", { source: "replay" });

    // Chain resolved WITHOUT a menu → null (callers must not render a menu result).
    expect(result).toBeNull();
    expect(getFlowState(meta)).toBe("aborted");
    expect(meta.terminateReason).toBe("decision_provider_absent");
    expect(auditEvents("pipeline_session_aborted").length).toBe(1);
  });

  it("already-frozen meta + policy enabled + UI → the decision deadline IS re-armed", async () => {
    const meta = frozenMeta();
    const originalId = meta.pipelineId!;
    const dialog = deferredSelect();
    const ctx = makeFlowCtx(meta, { select: async () => dialog.promise });

    const menu = requestDecision(ctx, meta, policyConfig({
      decisionWaitTimeoutMs: 5_000,
      byReason: { "*": { decision: "restart" } },
    }), "violation_overflow", { source: "command" });

    // The menu opened AND the wait timer exists — the exact gap the review found
    // (these entries used to call `ensureDecisionMenu` without a deadline at all).
    expect(await waitUntil(() => auditEvents("decision_deadline_armed").length > 0)).toBe(true);
    expect(__hasDecisionDeadline(originalId)).toBe(true);
    // The armed window comes from `decisionWaitTimeoutMs`, i.e. the caller really
    // passed `decisionDeadlineMs` down the chain.
    expect(auditEvents("decision_deadline_armed")[0]?.message?.["delayMs"]).toBe("5000");

    dialog.release(undefined);
    const result = await menu;
    // Cancelled dialog is a MENU result (not the chain-resolved-without-menu null).
    expect(result).not.toBeNull();
    expect(["cancelled", "interrupted", "no-menu"]).toContain(result!.outcome);
  });

  it("policy disabled → verbatim passthrough: menu opens, NO deadline is armed", async () => {
    const meta = frozenMeta();
    const originalId = meta.pipelineId!;
    const dialog = deferredSelect();
    const ctx = makeFlowCtx(meta, { select: async () => dialog.promise });

    const menu = requestDecision(ctx, meta, makeTestConfig(), "violation_overflow", { source: "replay" });
    expect(await waitUntil(() => auditEvents("decision_menu_presented").length > 0)).toBe(true);
    // Requirement 5.3 / B-1 gate: the chain and its timer exist only when enabled.
    expect(__hasDecisionDeadline(originalId)).toBe(false);
    expect(auditEvents("decision_deadline_armed").length).toBe(0);

    dialog.release(undefined);
    const result = await menu;
    expect(result).not.toBeNull();
  });

  it("resolveDecisionReason: persisted blockedReason wins, awaiting_human maps to confirm_awaiting_human", () => {
    expect(resolveDecisionReason(makeTestMeta({ blockedReason: "loop_overflow" }))).toBe("loop_overflow");
    expect(resolveDecisionReason(makeTestMeta({ currentStage: "awaiting_human", blockedReason: undefined })))
      .toBe("confirm_awaiting_human");
    expect(resolveDecisionReason(makeTestMeta({ currentStage: "review", blockedReason: undefined }))).toBe("unknown");
  });
});

// ─── 210 review issue 4 (Medium): no-UI stale-snapshot guard ─────────────────
//
// Replay / settle / command entries snapshot meta BEFORE several awaits and
// then enter the no-UI policy branch. Without the triple guard a stale
// snapshot could resolve its reason into a policy decision for a SUPERSEDED
// pipeline (restart race) or abort a NEW pipeline with
// `decision_provider_absent` — headless, nobody notices. The guard must bail
// with ONE warn audit and ZERO state side effects.

describe("no-UI policy stale-state guard (210 review issue 4)", () => {
  /** Headless ctx whose LIVE meta is `live` — deliberately distinct from the snapshot. */
  function makeLiveCtx(live: SessionMeta | undefined) {
    const updates: Partial<SessionMeta>[] = [];
    return {
      session: {
        getMeta: () => live,
        updateMeta: (patch: Partial<SessionMeta>) => {
          updates.push(patch);
          if (live) Object.assign(live, patch);
          return live;
        },
      },
      ui: { notify: () => {} }, // no select → no-UI branch
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
      updates,
    } as unknown as FlowStateCtx & { updates: Partial<SessionMeta>[] };
  }

  it("restart race (pipelineId changed) → stale_state audit, ZERO side effects", async () => {
    const snapshot = frozenMeta();
    const live = makeTestMeta({ pipelineId: uniquePipelineId(), flowState: "running" });
    const ctx = makeLiveCtx(live);

    const res = await requestDecision(ctx, snapshot, policyConfig({
      byReason: { violation_overflow: { decision: "restart" } },
    }), "violation_overflow", { source: "replay" });

    expect(res).toBeNull();
    const stale = auditEvents("decision_policy_stale_state");
    expect(stale.length).toBe(1);
    expect(stale[0]?.message?.failureReason).toBe("stale_state");
    expect(stale[0]?.message?.pipelineId).toBe(snapshot.pipelineId);
    expect(stale[0]?.level).toBe("warn");
    // Zero side effects: no policy decision, no abort, no meta writes.
    expect(auditEvents("pipeline_decision").length).toBe(0);
    expect(auditEvents("pipeline_session_aborted").length).toBe(0);
    expect(getFlowState(live)).toBe("running");
    expect(live.terminateReason).toBeUndefined();
    expect(ctx.updates.length).toBe(0);
  });

  it("same pipeline already resolved (live no longer a frozen decision point) → stale bail", async () => {
    const live = frozenMeta();
    const snapshot = { ...live }; // captured BEFORE a concurrent resume flipped live to running
    live.flowState = "running";
    live.blockedReason = undefined;
    const ctx = makeLiveCtx(live);

    const res = await requestDecision(ctx, snapshot, policyConfig({
      byReason: { violation_overflow: { decision: "restart" } },
    }), "violation_overflow", { source: "settle" });

    expect(res).toBeNull();
    expect(auditEvents("decision_policy_stale_state").length).toBe(1);
    expect(auditEvents("pipeline_decision").length).toBe(0);
    expect(getFlowState(live)).toBe("running");
    expect(ctx.updates.length).toBe(0);
  });

  it("live meta absent (session re-initialized) → stale bail, never aborts a foreign pipeline", async () => {
    const snapshot = frozenMeta();
    const ctx = makeLiveCtx(undefined);

    const res = await requestDecision(ctx, snapshot, policyConfig({}), "violation_overflow", { source: "command" });

    expect(res).toBeNull();
    expect(auditEvents("decision_policy_stale_state").length).toBe(1);
    expect(auditEvents("pipeline_session_aborted").length).toBe(0);
    expect(ctx.updates.length).toBe(0);
  });

  it("live blockedReason re-anchored: rule resolves from the FRESH freeze reason", async () => {
    const live = frozenMeta({ blockedReason: "max_loop_cycles", loopCycleCount: 3 });
    // Stale snapshot still carries the OLD freeze reason (J6 re-freeze race).
    const snapshot = { ...live, blockedReason: "violation_overflow" };
    const ctx = makeLiveCtx(live);

    const res = await requestDecision(ctx, snapshot, policyConfig({
      byReason: {
        violation_overflow: { decision: "restart" },
        max_loop_cycles: { decision: "abort" },
      },
    }), "violation_overflow", { source: "replay" });

    expect(res).toBeNull();
    expect(auditEvents("decision_policy_stale_state").length).toBe(0);
    const decision = auditEvents("pipeline_decision")[0];
    expect(decision?.message?.decision).toBe("abort"); // live reason wins
    expect(decision?.message?.decisionSource).toBe("policy");
    expect(decision?.message?.trigger).toBe("no_ui");
    expect(getFlowState(live)).toBe("aborted");
  });

  it("confirm-gate freeze WITHOUT persisted blockedReason keeps the caller-supplied reason", async () => {
    // awaiting_human freezes carry no blockedReason (resolveDecisionReason
    // maps them); the guard must fall back to the passed reason, not to
    // "undefined".
    const live = frozenMeta({ blockedReason: undefined, currentStage: "awaiting_human" });
    const ctx = makeLiveCtx(live);

    const res = await requestDecision(ctx, live, policyConfig({
      byReason: { confirm_awaiting_human: { decision: "abort" } },
    }), "confirm_awaiting_human", { source: "replay" });

    expect(res).toBeNull();
    expect(auditEvents("decision_policy_stale_state").length).toBe(0);
    const decision = auditEvents("pipeline_decision")[0];
    expect(decision?.message?.decision).toBe("abort");
    expect(decision?.message?.trigger).toBe("no_ui");
  });
});
