/**
 * 208 Phase 3 — `/pipeline-resume` command menu semantics (G1/G2/G3).
 *
 * Covered acceptance items (plan §Phase 3 command tests 1–6):
 * 1. select immediate undefined → outcome=interrupted → retry armed; fake
 *    timers advance 5s → second select (G1). retryArmed=true message
 *    contains "reopen automatically"; retryArmed=false (resolved elsewhere)
 *    message contains "run /pipeline-resume";
 * 2. frozen with a pre-armed retry timer → command entry clears it (G2),
 *    exactly one in-flight select;
 * 3. select throws → resume_skipped_no_menu(reason="select_error") (G3);
 * 4. child session → reason="child_session"; no UI → reason="no_ui" with
 *    exactly one command-side notify (notifyOnUnavailable: false);
 * 5. --force-resume unchanged (no menu, direct executeDecision("resume"));
 * 6. guard-rejected decision (rewind with no rework gate) → "Decision not
 *    applied: …" + failureReason guard_rejected + retryArmed=true copies;
 * 7. slow Esc → cancelled: "remains frozen" message, no runtime notify
 *    (review round 2, single user-facing channel).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import {
  scheduleDecisionRetry,
  clearAllDecisionTimers,
  __hasDecisionTimer,
} from "../../core/flow-state";
import { clearInputCapabilityOverrides } from "../../core/decision-menu-runtime";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta } from "../../types";

type SelectCall = { message: string; options: string[] };
type CapturedAudit = {
  event: string;
  message: Record<string, string | boolean> | undefined;
};

// Shared, reset per test
let audits: CapturedAudit[] = [];
let selectQueue: Array<string | undefined>;
let selectCalls: SelectCall[];
let pidCounter = 0;

/** Command context with a queue-driven select and notify capture. */
function makeMenuCtx(meta: SessionMeta) {
  selectQueue = [];
  selectCalls = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = createMockCtx(meta, { sessionName: "owner" }) as any;
  ctx.ui.select = async (message: string, options: string[]) => {
    selectCalls.push({ message, options });
    return selectQueue.shift();
  };
  ctx.notifyCalls = [];
  ctx.ui.notify = (msg: string) => { ctx.notifyCalls.push(msg); };
  return ctx as Omit<FlowStateCtx, "ui"> & { ui: NonNullable<FlowStateCtx["ui"]>; notifyCalls: string[] };
}

/** Unique pipelineId per test (shared names would leak scheduler state). */
function freshMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  pidCounter++;
  return makeTestMeta({
    currentStage: "develop",
    flowState: "blocked",
    blockedReason: "loop_overflow",
    pipelineId: `pipe-menu-resume-${pidCounter}`,
    ...overrides,
  });
}

function q(...responses: Array<string | undefined>): void {
  selectQueue = [...selectQueue, ...responses];
}

/** Flush pending microtasks without touching timers. */
async function drain(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve().then(() => {});
  }
}

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message) => {
    audits.push({ event, message });
  });
});

afterEach(() => {
  jest.useRealTimers();
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
  clearInputCapabilityOverrides();
});

describe("208 Phase 3: /pipeline-resume menu semantics", () => {
  it("test 1: select undefined fast → interrupted + retry armed; 5s later second select (G1)", async () => {
    const meta = freshMeta();
    const ctx = makeMenuCtx(meta);
    q(undefined); // streaming dismiss (fast undefined → interrupted)
    const config = makeTestConfig();
    const cmd = createPipelineResumeCommand(config);

    jest.useFakeTimers();
    const result: any = await cmd.execute({}, ctx as any);

    // interrupted with armed retry: message promises automatic reopen
    expect((result as any).error).toBeUndefined();
    expect((result as any).message).toContain("Decision menu interrupted");
    expect((result as any).message).toContain("reopen automatically");
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);

    // G1: the armed backoff timer re-opens the menu after 5s
    jest.advanceTimersByTime(5000);
    await drain();
    expect(selectCalls.length).toBe(2); // second presentation happened
    // attempt 2 interrupted again → re-armed at 10s (backoff ×2); later cleared.
    jest.advanceTimersByTime(10000);
    await drain();
    expect(selectCalls.length).toBe(3);
  });

  it("test 1b: interrupted but pipeline resolved elsewhere → no retry, 'run /pipeline-resume'", async () => {
    const meta = freshMeta();
    const ctx = makeMenuCtx(meta);
    const config = makeTestConfig();
    // The menu dismisses quickly (interrupted) but ANOTHER entry already
    // resolved the pipeline during the dialog → post-check unfreezes.
    ctx.ui.select = async (message: string, options: string[]) => {
      selectCalls.push({ message, options });
      meta.flowState = undefined; // resolved concurrently
      return undefined;
    };
    const cmd = createPipelineResumeCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    expect((result as any).message).toContain("Decision menu interrupted");
    expect((result as any).message).toContain("run /pipeline-resume");
    expect((result as any).message).not.toContain("reopen automatically");
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(false);
  });

  it("test 2: pre-armed timer on a frozen pipeline → cleared by the command entry (G2)", async () => {
    const meta = freshMeta();
    const ctx = makeMenuCtx(meta);
    const config = makeTestConfig();
    q("Resume");
    // Simulate a stale retry timer left by the freeze entry / settle path.
    scheduleDecisionRetry(ctx, meta, config, 1);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(true);

    const cmd = createPipelineResumeCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    // G2: direct call never coexists with a pending timer.
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(false);
    // "Resume" applied → decided path, exactly one select.
    expect(selectCalls.length).toBe(1);
    expect((result as any).message).toContain("Decision executed");
  });

  it("test 3: select throws → resume_skipped_no_menu(select_error), no child_session fallback (G3)", async () => {
    const meta = freshMeta();
    const ctx = makeMenuCtx(meta);
    ctx.ui.select = async () => {
      selectCalls.push({ message: "x", options: [] });
      throw new Error("dialog boom");
    };
    const config = makeTestConfig();
    const cmd = createPipelineResumeCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip).toBeDefined();
    expect(skip?.message?.["reason"]).toBe("select_error");
    // G3: no reverse-inference to child_session
    expect(skip?.message?.["reason"]).not.toBe("child_session");
    expect((result as any).message).toContain("select_error");
    // notifyOnUnavailable: false → only the command's own notify
    expect(ctx.notifyCalls.filter((m: string) => m.includes("No decision menu is available")).length).toBe(1);
  });

  it("test 4a: child session → resume_skipped_no_menu(child_session)", async () => {
    const meta = freshMeta();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createMockCtx(meta, { sessionName: "child#12345678" }) as any;
    let selectCallsChild = 0;
    ctx.ui.select = async () => { selectCallsChild++; return "Resume"; };
    const config = makeTestConfig();
    const cmd = createPipelineResumeCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip?.message?.["reason"]).toBe("child_session");
    expect(selectCallsChild).toBe(0);
    expect((result as any).message).toContain("child_session");
  });

  it("test 4b: no UI → resume_skipped_no_menu(no_ui), exactly one notify, message keeps stage + reason", async () => {
    const meta = freshMeta();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = createMockCtx(meta) as any;
    delete ctx.ui.select;
    const notifications: string[] = [];
    ctx.ui.notify = (msg: string) => { notifications.push(msg); };
    const config = makeTestConfig();
    const cmd = createPipelineResumeCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip?.message?.["reason"]).toBe("no_ui");
    // Exactly one user-facing notify (runtime notify suppressed)
    expect(notifications.filter((m) => m.includes("No decision menu is available")).length).toBe(1);
    // Message keeps the stage and the freeze reason
    expect((result as any).message).toContain(String(meta.currentStage));
    expect((result as any).message).toContain("no_ui");
  });

  it("test 5: --force-resume → no menu, direct resume (unchanged)", async () => {
    const meta = freshMeta();
    const ctx = makeMenuCtx(meta);
    const config = makeTestConfig();
    const cmd = createPipelineResumeCommand(config);
    const result: any = await cmd.execute({ forceResume: true }, ctx as any);

    expect(selectCalls.length).toBe(0);
    expect((result as any).error).toBeUndefined();
    expect(meta.flowState).toBe("running");
  });

  it("test 6: guard-rejected rewind → 'Decision not applied' + guard_rejected + auto reopen copy", async () => {
    const meta = freshMeta(); // no stageVisitOrder → rewind gate unresolved
    const ctx = makeMenuCtx(meta);
    q("Rewind last_round");
    const config = makeTestConfig();
    const cmd = createPipelineResumeCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    expect(selectCalls.length).toBe(1);
    expect((result as any).message).toContain("Decision not applied");
    expect((result as any).message).toContain("reopen automatically"); // retryArmed=true
    // failureReason guard_rejected is observable via the decision_not_applied audit
    const notApplied = audits.find((a) => a.event === "decision_not_applied");
    expect(notApplied?.message?.["reason"]).toBe("guard_rejected");
    expect(notApplied?.message?.["decision"]).toBe("rewind_last_round");
  });

  it("test 7: slow Esc → cancelled, 'remains frozen' message, no runtime notify", async () => {
    const meta = freshMeta();
    const ctx = makeMenuCtx(meta);
    jest.useFakeTimers();
    ctx.ui!.select = async (message: string, options: string[]) => {
      selectCalls.push({ message, options });
      jest.advanceTimersByTime(1600); // >= DECISION_DISMISS_INTERRUPT_MS → user Esc
      return undefined;
    };
    const config = makeTestConfig();
    const cmd = createPipelineResumeCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    expect((result as any).message).toContain("Pipeline remains frozen");
    expect((result as any).message).not.toContain("No decision menu is available");
    // notifyOnCancel: false → the command message is the only channel
    expect(ctx.notifyCalls.length).toBe(0);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(false);
  });
});
