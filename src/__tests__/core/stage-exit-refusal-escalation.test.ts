/**
 * 216 Phase 2 (P3): the OWNER side of the running-state stage-exit arm.
 *
 * `recordStageExitRefusal` (accounting file) arms the owner with an
 * `escalatedAt` credential and one broadcast; this file closes the loop:
 *
 *  ⑧ `evaluateEscalationWake` wakes the owner exactly once when the running
 *     arm credential matches the payload `at`; a stale `at` is skipped with
 *     `predicate_mismatch` (no re-wake, no freeze fact).
 *  ⑨ a BLOCKED pipeline never rides the running arm — the frozen 203 channel
 *     owns that shape (wake dedup would double the menu otherwise).
 *  ⑩ the human-readable wake summary names the stage AND the `stage_advance`
 *     retry the OWNER must run (the child could not consume its bound run).
 *  ⑪ the overflow freeze is HUMAN-ONLY: with UI the decision menu is never
 *     converged by `decisionWaitTimeoutMs` (`__hasDecisionDeadline` false,
 *     positive control on an existing reason arms it), while the headless
 *     convergence keeps `decision_provider_absent` verbatim.
 *
 * Fixtures mirror `decision-policy.test.ts` (in-memory safe-audit capture,
 * hanging `ui.select` dialogs, unique pipelineIds for the process-global
 * decision-timer table); the wake deps call the exported
 * `evaluateEscalationWake` directly — the observer wiring is 203/211 tested.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  evaluateEscalationWake,
  type OwnerEscalationDeps,
} from "../../core/owner-escalation";
import {
  requestDecision,
  getFlowState,
  clearAllDecisionTimers,
  type FlowStateCtx,
} from "../../core/flow-state";
import { __hasDecisionDeadline } from "../../core/decision-menu-runtime";
import type { EscalationPayload } from "../../utils/escalation-bus";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import {
  STAGE_EXIT_REFUSED_ESCALATION_REASON,
  STAGE_EXIT_REFUSED_OVERFLOW_REASON,
} from "../../constants";
import type {
  DecisionPolicyConfig,
  PipelineConfig,
  SessionMeta,
  StageExitRefusal,
} from "../../types";

// ─── In-memory safe-audit capture (same pattern as decision-policy.test.ts) ───

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

function auditEvents(event: string): CapturedAudit[] {
  return audits.filter((a) => a.event === event);
}

/** Monotonic counter → unique pipelineId per case (decision-timer table is global). */
let idCounter = 0;
function uniquePipelineId(): string {
  idCounter++;
  return `pipe-216-wake-${idCounter}`;
}

/** Polls `predicate` until true (or the budget elapses) — timing-robust assert. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ─── ⑧–⑩ direct evaluateEscalationWake harness ───────────────────────────────

const AT = 1_700_000_000_123;
const CAUSE = "bound_exit_refused:owner_unproven:child_caller";

/** The running-state arm credential written by `recordStageExitRefusal` (①). */
function refusalCredential(overrides?: Partial<StageExitRefusal>): StageExitRefusal {
  return {
    stage: "develop",
    fromStage: "develop",
    toStage: "review",
    reason: CAUSE,
    count: 1,
    frozenCount: 0,
    lastAt: AT,
    escalatedAt: AT,
    ...overrides,
  };
}

function runningMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    pipelineId: uniquePipelineId(),
    currentStage: "develop",
    previousStage: "plan",
    flowState: "running",
    stageExitRefusal: refusalCredential(),
    ...overrides,
  });
}

interface WakeCapture {
  deps: OwnerEscalationDeps;
  summaries: string[];
  events: { event: string; payload: Record<string, unknown> }[];
  statusBars: number;
}

/** Minimal owner deps: everything the observer needs is a spy, nothing else. */
function makeWakeDeps(meta: SessionMeta, delivered = true): WakeCapture {
  const summaries: string[] = [];
  const events: WakeCapture["events"] = [];
  let statusBars = 0;
  const deps: OwnerEscalationDeps = {
    getMeta: () => meta,
    sendFollowUp: (summary: string) => {
      summaries.push(summary);
      return delivered;
    },
    syncStatusBar: () => {
      statusBars++;
    },
    audit: (event: string, payload: Record<string, unknown>) => {
      events.push({ event, payload });
    },
    isOwner: true,
  };
  return { deps, summaries, events, get statusBars() { return statusBars; } } as WakeCapture;
}

function refusedPayload(meta: SessionMeta, at: number): EscalationPayload {
  return {
    pipelineId: meta.pipelineId,
    stage: "develop",
    reason: STAGE_EXIT_REFUSED_ESCALATION_REASON,
    at,
  };
}

function eventsNamed(c: WakeCapture, event: string): WakeCapture["events"] {
  return c.events.filter((e) => e.event === event);
}

describe("216 P3: running-state owner wake (⑧–⑩)", () => {
  it("⑧ running + matching credential → exactly ONE wake; stale `at` → predicate_mismatch", () => {
    const meta = runningMeta();
    const w = makeWakeDeps(meta);

    evaluateEscalationWake(refusedPayload(meta, AT), w.deps);

    expect(w.summaries).toHaveLength(1);
    const woke = eventsNamed(w, "owner_wake_escalation");
    expect(woke).toHaveLength(1);
    expect(woke[0]!.payload).toMatchObject({
      pipelineId: meta.pipelineId,
      stage: "develop",
      reason: STAGE_EXIT_REFUSED_ESCALATION_REASON,
      at: AT,
    });
    expect(eventsNamed(w, "owner_wake_escalation_skipped")).toHaveLength(0);
    expect(w.statusBars).toBe(1);
    // Running-state arm: NO freeze fact, NO 203 menu-pending consumption.
    expect(getFlowState(meta)).toBe("running");
    expect(meta.menuEscalationPending).toBeUndefined();
    expect(meta.stageExitRefusal!.escalatedAt).toBe(AT);

    // Same arm, payload `at` NOT matching the stored credential → skipped.
    const w2 = makeWakeDeps(meta);
    evaluateEscalationWake(refusedPayload(meta, AT + 1), w2.deps);
    expect(w2.summaries).toHaveLength(0);
    const skipped = eventsNamed(w2, "owner_wake_escalation_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.payload.reason).toBe("predicate_mismatch");
  });

  it("⑨ blocked pipeline is the FROZEN channel's shape — the running arm never wakes", () => {
    // The 203 consumption dedup (`menuEscalationPending`) belongs to the
    // frozen payload family; a stage-exit payload reaching a blocked owner
    // must resolve predicate_mismatch, never a second wake for one freeze.
    const meta = runningMeta({
      flowState: "blocked",
      blockedReason: STAGE_EXIT_REFUSED_OVERFLOW_REASON,
      menuEscalationPending: true,
    });
    const w = makeWakeDeps(meta);

    evaluateEscalationWake(refusedPayload(meta, AT), w.deps);

    expect(w.summaries).toHaveLength(0);
    const skipped = eventsNamed(w, "owner_wake_escalation_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.payload.reason).toBe("predicate_mismatch");
    expect(eventsNamed(w, "owner_wake_escalation")).toHaveLength(0);
  });

  it("⑩ the wake summary names the stage and the stage_advance retry the OWNER runs", () => {
    const meta = runningMeta();
    const w = makeWakeDeps(meta);

    evaluateEscalationWake(refusedPayload(meta, AT), w.deps);

    expect(w.summaries).toHaveLength(1);
    const summary = w.summaries[0]!;
    expect(summary).toContain("develop");
    expect(summary).toContain("stage_advance");
    // Delivery failure keeps the 211 shape: skip audit, no wake event.
    const failing = makeWakeDeps(runningMeta(), false);
    evaluateEscalationWake(refusedPayload(failing.deps.getMeta()!, AT), failing.deps);
    expect(failing.summaries).toHaveLength(1); // attempted (and captured) …
    expect(eventsNamed(failing, "owner_wake_escalation")).toHaveLength(0);
    expect(eventsNamed(failing, "owner_wake_escalation_skipped")[0]!.payload.reason).toBe("delivery_failed");
  });
});

// ─── ⑪ human-only decision menu (R5-Q4-A / R6-8) ─────────────────────────────

/** Policy-enabled config factory (decision-policy.test.ts idiom). */
function policyConfig(policy: DecisionPolicyConfig): PipelineConfig {
  return makeTestConfig({ decisionPolicy: { enabled: true, ...policy } });
}

/** Minimal ctx that satisfies FlowStateCtx with a controllable ui.select. */
function makeFlowCtx(
  meta: SessionMeta,
  opts?: {
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    noUI?: boolean;
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
      ? {}
      : { select: opts?.select ?? (async () => undefined) },
    _ctx: {
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
      },
    },
    updates,
  } as unknown as FlowStateCtx & { updates: Partial<SessionMeta>[] };
  return ctx;
}

/** Already-frozen meta for the decision-provider chain entries. */
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

describe("216 P3: stage_exit_refused_overflow is HUMAN-ONLY (⑪)", () => {
  it("⑪ with UI: the menu is presented but NO decision deadline arms (positive control arms one)", async () => {
    const meta = frozenMeta({ blockedReason: STAGE_EXIT_REFUSED_OVERFLOW_REASON });
    const dialog = deferredSelect();
    const ctx = makeFlowCtx(meta, { select: () => dialog.promise });
    // A matching policy exists for a DIFFERENT reason — the human-only reason
    // must not be converged by `decisionWaitTimeoutMs` even with the wildcard-
    // style pressure of an enabled policy + timeout configured.
    const menu = requestDecision(
      ctx,
      meta,
      policyConfig({
        decisionWaitTimeoutMs: 5_000,
        byReason: { violation_overflow: { decision: "abort" }, "*": { decision: "restart" } },
      }),
      STAGE_EXIT_REFUSED_OVERFLOW_REASON,
      { source: "command" },
    );

    expect(await waitUntil(() => auditEvents("decision_menu_presented").length > 0)).toBe(true);
    // R5-Q4-A: human-only ⇒ the menu waits for a human, deadline NOT armed.
    expect(__hasDecisionDeadline(meta.pipelineId)).toBe(false);
    expect(auditEvents("decision_deadline_armed")).toHaveLength(0);

    await waitUntil(() => false, 50); // room for a mis-armed timer to act
    expect(__hasDecisionDeadline(meta.pipelineId)).toBe(false);
    expect(getFlowState(meta)).toBe("blocked"); // policy never converged the freeze
    expect(auditEvents("pipeline_session_aborted")).toHaveLength(0);

    dialog.release(undefined);
    await menu;
  });

  it("⑪ positive control: an existing (non-human-only) reason DOES arm the deadline", async () => {
    const meta = frozenMeta(); // violation_overflow
    const dialog = deferredSelect();
    const ctx = makeFlowCtx(meta, { select: () => dialog.promise });

    const menu = requestDecision(
      ctx,
      meta,
      policyConfig({ decisionWaitTimeoutMs: 5_000, byReason: { violation_overflow: { decision: "abort" } } }),
      "violation_overflow",
      { source: "command" },
    );

    expect(await waitUntil(() => auditEvents("decision_deadline_armed").length > 0)).toBe(true);
    expect(__hasDecisionDeadline(meta.pipelineId)).toBe(true);
    expect(auditEvents("decision_deadline_armed")[0]?.message?.["delayMs"]).toBe("5000");

    dialog.release(undefined);
    await menu;
  });

  it("⑪ headless: the human-only reason still converges — decision_provider_absent abort (verbatim)", async () => {
    const meta = frozenMeta({ blockedReason: STAGE_EXIT_REFUSED_OVERFLOW_REASON });
    const ctx = makeFlowCtx(meta, { noUI: true });

    const result = await requestDecision(
      ctx,
      meta,
      policyConfig({ byReason: { violation_overflow: { decision: "abort" } } }),
      STAGE_EXIT_REFUSED_OVERFLOW_REASON,
      { source: "replay" },
    );

    // No waiting object exists headless — "human-only" never means "stall
    // forever": the absent-provider convergence is unchanged.
    expect(result).toBeNull();
    expect(getFlowState(meta)).toBe("aborted");
    expect(meta.terminateReason).toBe("decision_provider_absent");
    expect(auditEvents("pipeline_session_aborted")).toHaveLength(1);
    expect(auditEvents("decision_deadline_armed")).toHaveLength(0);
  });
});
