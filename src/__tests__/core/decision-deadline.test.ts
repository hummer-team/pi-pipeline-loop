/**
 * 210 Phase 1: decision-wait deadline timer lifecycle on the shared runtime
 * registry (decision-menu-runtime).
 *
 * These cases drive the runtime module directly with injected deps, so they
 * cover the TIMER semantics (mutex with the backoff retry, shutdown cleanup,
 * single-flight arming) independently from the provider-chain semantics
 * covered by decision-policy.test.ts.
 */
import { describe, expect, it, afterEach } from "bun:test";
import {
  runDecisionMenu,
  clearAllDecisionTimers,
  clearDecisionDeadline,
  __hasDecisionDeadline,
  __hasDecisionTimer,
  __decisionTimerCount,
} from "../../core/decision-menu-runtime";
import type {
  DecisionMenuRuntimeDeps,
  EnsureDecisionMenuOpts,
  MenuAttemptDetail,
} from "../../core/decision-menu-runtime";
import type { SessionMeta } from "../../types";
import { makeTestMeta } from "../helpers";

const PIPELINE_ID = "pipe-deadline-test";

/** Blocked meta + frozen predicate sufficient for the retry scheduler. */
function blockedMeta(): SessionMeta {
  return makeTestMeta({
    pipelineId: PIPELINE_ID,
    flowState: "blocked",
    blockedReason: "violation_overflow",
  });
}

/**
 * Deps factory: `present` resolves through the caller-supplied responder so a
 * test can control both the outcome and the timing of the dialog.
 */
function makeDeps(
  meta: SessionMeta,
  presentImpl: (
    live: SessionMeta,
    opts: EnsureDecisionMenuOpts,
    attempt: number,
  ) => Promise<MenuAttemptDetail>,
  deadlineSink: { calls: string[] },
): DecisionMenuRuntimeDeps {
  return {
    readMeta: () => meta,
    isFrozen: (m) => m.flowState === "blocked",
    present: presentImpl,
    onDecisionDeadline: async (pipelineId) => {
      deadlineSink.calls.push(pipelineId);
    },
  };
}

/** Immediate "interrupted" attempt (streaming dismiss) → arms a backoff retry. */
async function interruptedAttempt(): Promise<MenuAttemptDetail> {
  return { outcome: "interrupted", applied: false, interruptedStage: "primary" };
}

afterEach(() => {
  clearAllDecisionTimers();
});

describe("decision deadline vs. backoff retry timer mutex", () => {
  it("an interrupted retry does not clear the armed deadline (independent fields)", async () => {
    const meta = blockedMeta();
    const sink = { calls: [] as string[] };
    const deps = makeDeps(meta, interruptedAttempt, sink);

    const result = await runDecisionMenu(deps, PIPELINE_ID, { decisionDeadlineMs: 30 });

    expect(result.retryArmed).toBe(true);
    // Both timers coexist right after the first attempt …
    expect(__hasDecisionTimer(PIPELINE_ID)).toBe(true);
    expect(__hasDecisionDeadline(PIPELINE_ID)).toBe(true);

    // … the deadline fires on schedule while the retry is still pending.
    await new Promise((r) => setTimeout(r, 60));
    expect(sink.calls).toEqual([PIPELINE_ID]);
    expect(__hasDecisionDeadline(PIPELINE_ID)).toBe(false);
    // Per-pipeline assertion: the global table is shared with other test files
    // in one process, so only this pipeline's own retry timer is observable here.
    expect(__hasDecisionTimer(PIPELINE_ID)).toBe(true);
  });

  it("clearDecisionDeadline leaves the backoff retry timer untouched", async () => {
    const meta = blockedMeta();
    const sink = { calls: [] as string[] };
    const deps = makeDeps(meta, interruptedAttempt, sink);

    await runDecisionMenu(deps, PIPELINE_ID, { decisionDeadlineMs: 30 });
    clearDecisionDeadline(PIPELINE_ID);

    expect(__hasDecisionDeadline(PIPELINE_ID)).toBe(false);
    expect(__hasDecisionTimer(PIPELINE_ID)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(sink.calls.length).toBe(0); // cleared, so it never fires
  });

  it("an applied human decision clears the pending deadline (no second decision)", async () => {
    const meta = blockedMeta();
    const sink = { calls: [] as string[] };
    const deps = makeDeps(meta, async () => ({ outcome: "decided", applied: true, decision: "resume" }), sink);

    const result = await runDecisionMenu(deps, PIPELINE_ID, { decisionDeadlineMs: 30 });

    expect(result.applied).toBe(true);
    expect(__hasDecisionDeadline(PIPELINE_ID)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(sink.calls.length).toBe(0);
  });
});

describe("decision deadline arming rules", () => {
  it("no decisionDeadlineMs → no deadline is armed (baseline shape)", async () => {
    const meta = blockedMeta();
    const sink = { calls: [] as string[] };
    const deps = makeDeps(meta, async () => ({ outcome: "cancelled", applied: false }), sink);

    await runDecisionMenu(deps, PIPELINE_ID, {});

    expect(__hasDecisionDeadline(PIPELINE_ID)).toBe(false);
  });

  it("a joined single-flight presentation does not re-arm or extend the deadline", async () => {
    const meta = blockedMeta();
    const sink = { calls: [] as string[] };
    let resolvePresent: ((d: MenuAttemptDetail) => void) | undefined;
    let presentCount = 0;
    const deps = makeDeps(
      meta,
      async () => {
        presentCount++;
        // Hold the dialog open so the deadline expires WHILE the chain is in flight.
        return await new Promise<MenuAttemptDetail>((resolve) => {
          resolvePresent = resolve;
        });
      },
      sink,
    );

    const first = runDecisionMenu(deps, PIPELINE_ID, { decisionDeadlineMs: 30, source: "freeze" });
    await new Promise((r) => setTimeout(r, 5)); // let the first attempt enter present()

    // The joiner awaits the SAME in-flight promise, so it can only resolve once
    // the (held-open) dialog does — start both and settle the dialog at the end.
    const joiner = runDecisionMenu(deps, PIPELINE_ID, { decisionDeadlineMs: 1, source: "settle" });
    await new Promise((r) => setTimeout(r, 10));
    expect(presentCount).toBe(1); // single-flight: no second ui.select
    expect(__hasDecisionDeadline(PIPELINE_ID)).toBe(true); // joiner did NOT shorten it to 1ms

    await new Promise((r) => setTimeout(r, 40));
    // Exactly one convergence, fired by the FIRST caller's window, mid-presentation.
    expect(sink.calls).toEqual([PIPELINE_ID]);

    resolvePresent?.({ outcome: "cancelled", applied: false });
    const [firstResult, joinedResult] = await Promise.all([first, joiner]);
    expect(joinedResult.joined).toBe(true);
    expect(firstResult.joined).toBe(false);
  });
});

describe("shutdown clears decision deadline timers", () => {
  it("clearAllDecisionTimers removes deadline + retry timers and suppresses firing", async () => {
    const meta = blockedMeta();
    const sink = { calls: [] as string[] };
    const deps = makeDeps(meta, interruptedAttempt, sink);

    await runDecisionMenu(deps, PIPELINE_ID, { decisionDeadlineMs: 30 });
    expect(__hasDecisionDeadline(PIPELINE_ID)).toBe(true);

    clearAllDecisionTimers();

    // Plan acceptance: after clearAllDecisionTimers, __hasDecisionDeadline === false
    expect(__hasDecisionDeadline(PIPELINE_ID)).toBe(false);
    expect(__hasDecisionTimer(PIPELINE_ID)).toBe(false);
    expect(__decisionTimerCount()).toBe(0);

    await new Promise((r) => setTimeout(r, 60));
    expect(sink.calls.length).toBe(0); // nothing fires after shutdown
  });
});
