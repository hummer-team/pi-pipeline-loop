/**
 * 208 Phase 2 — J6 freeze reason-change re-popup on `freezeAndPrompt`.
 *
 * Covered acceptance items (plan §Phase 2 unit tests 1–5):
 * 1. already blocked + SAME reason → idempotent no-op (no popup, no audit);
 * 2. already blocked + DIFFERENT reason (no in-flight menu) → blockedReason
 *    updated + `pipeline_block_reason_changed` audit + exactly one select;
 * 3. already aborted → no popup, no state change;
 * 4. child + reason change → no popup, `menuEscalationPending=true`,
 *    one escalation broadcast, `menu_escalation_armed` audit;
 * 5. reason change with an in-flight menu → join (select still 1), no extra
 *    popup for the new reason, only the `pipeline_block_reason_changed` audit.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import {
  freezeAndPrompt,
  ensureDecisionMenu,
  clearAllDecisionTimers,
  __decisionTimerCount,
} from "../../core/flow-state";
import { PIPELINE_ESCALATION_EVENT, type EscalationPayload } from "../../utils/escalation-bus";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";

type SelectCall = { message: string; options: string[] };
type CapturedAudit = {
  event: string;
  message: Record<string, string | boolean> | undefined;
  level: string | undefined;
};

// Shared, reset per test
let audits: CapturedAudit[] = [];
let notifyCalls: string[] = [];
let selectCalls: SelectCall[];
let selectQueue: Array<string | undefined>;
let meta: SessionMeta;
let updates: Partial<SessionMeta>[];
let ctx: FlowStateCtx;
let config: ReturnType<typeof makeTestConfig>;

/** Optional deferral: when set, the FIRST select parks until released. */
let parkSelect: ((v: string | undefined) => void) | null = null;
/** Resolve handle of the parked select (set by park(), used by release()). */
let releaseParked: ((v: string | undefined) => void) | null = null;
let parkedSelects = 0;

function begin(overrides?: Partial<SessionMeta>): void {
  audits = [];
  notifyCalls = [];
  selectCalls = [];
  selectQueue = [];
  updates = [];
  parkSelect = null;
  releaseParked = null;
  parkedSelects = 0;
  meta = makeTestMeta({
    flowState: "blocked",
    blockedReason: "loop_overflow",
    ...overrides,
  });
  ctx = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        updates.push(patch);
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: {
      select: async (message: string, options: string[]) => {
        selectCalls.push({ message, options });
        if (parkSelect !== null) {
          // Park the FIRST select so the presentation stays in-flight.
          parkedSelects++;
          if (parkedSelects > 1) {
            throw new Error("unexpected second select in parked mode");
          }
          const resolve = parkSelect;
          parkSelect = null; // later selects fall back to the queue
          return new Promise<string | undefined>((res) => {
            releaseParked = res;
          });
        }
        return selectQueue.shift();
      },
      input: async () => undefined,
      notify: (msg: string) => notifyCalls.push(msg),
    } as FlowStateCtx["ui"],
  };
  config = makeTestConfig();
}

/** Queue a raw select response (undefined = dismiss). */
function q(...responses: Array<string | undefined>): void {
  selectQueue = [...selectQueue, ...responses];
}

/** Arm a parked first select; release it later with releaseParked(answer). */
function park(): void {
  parkSelect = () => {};
}

/** Flush pending microtasks (no timers — everything runs on microtasks). */
async function drain(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve().then(() => {});
  }
}

beforeEach(() => {
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message, level });
    if (process.env.DEBUG_AUDITS) console.log(`[audit] ${event} ${JSON.stringify(message)} level=${level}`);
  });
});

afterEach(() => {
  jest.useRealTimers();
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
});

describe("208 Phase 2: freezeAndPrompt J6 reason change", () => {
  it("test 1: already blocked + same reason → no popup, no pipeline_block_reason_changed", async () => {
    begin(); // meta blocked with loop_overflow
    await freezeAndPrompt(ctx, meta, "loop_overflow", config);

    expect(selectCalls.length).toBe(0);
    expect(notifyCalls.length).toBe(0);
    expect(updates.length).toBe(0);
    expect(audits.some((a) => a.event === "pipeline_block_reason_changed")).toBe(false);
    expect(meta.blockedReason).toBe("loop_overflow");
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 2: blocked + different reason (no in-flight) → update + audit + 1 select", async () => {
    begin(); // meta blocked with loop_overflow
    clearAllDecisionTimers(); // fixture precondition: no in-flight / pending presentation
    q("Resume");
    await freezeAndPrompt(ctx, meta, "verify_failure_loop_overflow", config);

    // blockedReason refreshed to the new cause, then the applied "Resume"
    // decision un-freezes the pipeline (clearing blockedReason).
    expect(updates.some((u) => u.blockedReason === "verify_failure_loop_overflow")).toBe(true);
    expect(meta.flowState).toBe("running");
    // audit written (warn) with previous + new reason
    const change = audits.filter((a) => a.event === "pipeline_block_reason_changed");
    expect(change.length).toBe(1);
    expect(change[0].message?.previousReason).toBe("loop_overflow");
    expect(change[0].message?.reason).toBe("verify_failure_loop_overflow");
    expect(change[0].level).toBe("warn");
    // exactly one popup for the new reason; decision applied → no retry timer
    expect(selectCalls.length).toBe(1);
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 3: already aborted → no popup, no state change", async () => {
    begin({ flowState: "aborted", blockedReason: "loop_overflow" });
    await freezeAndPrompt(ctx, meta, "verify_failure_loop_overflow", config);

    expect(selectCalls.length).toBe(0);
    expect(notifyCalls.length).toBe(0);
    expect(updates.length).toBe(0);
    expect(meta.flowState).toBe("aborted");
    expect(audits.some((a) => a.event === "pipeline_block_reason_changed")).toBe(false);
  });

  it("test 4: child + reason change → no popup, menuEscalationPending, 1 broadcast, armed audit", async () => {
    begin(); // meta blocked with loop_overflow
    // Child gate: session name matching the subagent pattern (owner gate fails open)
    ctx._ctx = {
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        getSessionFile: () => "child#12345678",
        getSessionName: () => "child#12345678",
      },
    } as never;
    // Event bus stub: count emissions on the escalation channel
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    ctx.pi = {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => {
          broadcasts.push({ event, payload });
        },
        on: () => {},
        off: () => {},
      },
    };

    await freezeAndPrompt(ctx, meta, "verify_failure_loop_overflow", config);

    // No popup in the child session
    expect(selectCalls.length).toBe(0);
    expect(notifyCalls.length).toBe(0);
    // Escalation armed for the owner to render the menu once
    expect(meta.menuEscalationPending).toBe(true);
    expect(updates.some((u) => u.menuEscalationPending === true)).toBe(true);
    expect(audits.some((a) => a.event === "menu_escalation_armed")).toBe(true);
    // Exactly one broadcast wake event
    expect(
      broadcasts.filter((b) => b.event === PIPELINE_ESCALATION_EVENT).length,
    ).toBe(1);
    // Reason-change audit still reflects the new cause
    const change = audits.filter((a) => a.event === "pipeline_block_reason_changed");
    expect(change.length).toBe(1);
    expect(change[0].message?.reason).toBe("verify_failure_loop_overflow");
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 5: reason change with in-flight menu → join (select 1), only the audit", async () => {
    begin(); // meta blocked with loop_overflow
    clearAllDecisionTimers();
    park(); // first select parks → presentation stays in-flight

    // Start an in-flight presentation (settle entry), then trigger the reason
    // change while it is still pending.
    const p1 = ensureDecisionMenu(ctx, meta, config, { source: "settle" });
    await drain();
    expect(selectCalls.length).toBe(1); // first popup live

    const p2 = freezeAndPrompt(ctx, meta, "verify_failure_loop_overflow", config);
    await drain();

    // The freeze entry must have JOINED the in-flight presentation
    expect(audits.some((a) => a.event === "decision_menu_joined_inflight")).toBe(true);
    // New reason is audited immediately
    const change = audits.filter((a) => a.event === "pipeline_block_reason_changed");
    expect(change.length).toBe(1);
    expect(change[0].message?.previousReason).toBe("loop_overflow");
    expect(change[0].message?.reason).toBe("verify_failure_loop_overflow");
    // meta refreshed even though the popup joins an older presentation
    expect(meta.blockedReason).toBe("verify_failure_loop_overflow");

    // Resolve the in-flight menu → the join completes without a second select.
    releaseParked!("Resume");
    await Promise.all([p1, p2]);
    // Still exactly one select for both the original and the joined callers
    expect(selectCalls.length).toBe(1);
    expect(__decisionTimerCount()).toBe(0);
  });

  it("test 6: interrupted popup + pending timer, then a different reason → audit written once", async () => {
    begin({ flowState: "running", blockedReason: undefined });
    jest.useFakeTimers();
    clearAllDecisionTimers();

    // First freeze: the popup is dismissed instantly (streaming interrupt) and
    // the scheduler keeps a pending backoff timer + lastPresentedReason.
    q(undefined);
    await freezeAndPrompt(ctx, meta, "loop_overflow", config);
    expect(__decisionTimerCount()).toBe(1);
    expect(audits.some((a) => a.event === "pipeline_block_reason_changed")).toBe(false);

    // Second freeze with a DIFFERENT reason while that timer is still pending:
    // freezeAndPrompt records the transition (single write point), so the
    // scheduler's own J6 observation of the same transition must be suppressed.
    // The popup is dismissed again (stays frozen) — otherwise the pipeline would
    // unfreeze and the scheduler's J6 branch (which requires isFrozen) would
    // never run, making this assertion blind to the dedupe token.
    q(undefined);
    await freezeAndPrompt(ctx, meta, "verify_failure_loop_overflow", config);

    // Still frozen on the NEW reason, with a fresh backoff timer armed.
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("verify_failure_loop_overflow");
    expect(__decisionTimerCount()).toBe(1);

    // Exactly ONE audit despite two write points (freeze entry + scheduler).
    const change = audits.filter((a) => a.event === "pipeline_block_reason_changed");
    expect(change.length).toBe(1);
    expect(change[0].message?.previousReason).toBe("loop_overflow");
    expect(change[0].message?.reason).toBe("verify_failure_loop_overflow");
  });
});
