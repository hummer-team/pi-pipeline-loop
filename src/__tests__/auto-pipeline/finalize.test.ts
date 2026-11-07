/**
 * 219 Phase 5 §4/§5: the finalize transaction.
 *
 * Key behaviors:
 * - `finalizeCurrentDoc`: sidecar FIRST (receipt), then release/audit/notify.
 *   ★ never rolls back the overlay, never releases the lock.
 * - `finalizeJob`: the ONLY rollback + unlock path, with a terminal status.
 * - Idempotence (M3): two settles produce ONE receipt and ONE cleanup audit;
 *   the lookup is decoupled from `docIndex`.
 * - `buildJobSummary` reports completed / skipped / failed / pending + reason.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { makeTestMeta } from "../helpers";
import { createAutoHarness, createSessionStub, HARNESS_JOB_ID, HARNESS_DOCS } from "./auto-harness";
import {
  buildJobSummary,
  finalizeCurrentDoc,
  finalizeJob,
  handleDocFailure,
  syncAutoCountersFromMeta,
  __resetFinalizeStateForTests,
} from "../../core/auto-pipeline/finalize";
import { isAutoJobActive, readJobLock, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { createJobState, readJobState } from "../../core/auto-pipeline/job-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

let harness: ReturnType<typeof createAutoHarness>;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  audits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage) => {
    audits.push(stage);
  });
  harness = createAutoHarness();
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  harness.dispose();
});

describe("finalize — finalizeCurrentDoc", () => {
  it("writes the receipt, releases resources, audits and notifies", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop", pipelineId: "pipe-1" }));

    const result = await finalizeCurrentDoc(stub, harness.config, { outcome: "completed" });

    expect(result.skipped).toBe(false);
    const state = harness.state()!;
    expect(state.docs[0]?.status).toBe("completed");
    expect(state.docs[0]?.finalizeKey).toBe(`${HARNESS_JOB_ID}:0:completed`);
    expect(state.lastSettleAt).toBeGreaterThan(0);
    // Sidecar receipt exists BEFORE the release patch (ordering).
    expect(stub.patches.length).toBeGreaterThan(0);
    expect(audits).toContain("pipeline_auto_cleanup");
    expect(stub.notified.some((m) => m.includes("completed"))).toBe(true);
  });

  it("does NOT roll back the overlay and does NOT release the lock", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    const modeBefore = harness.config.stages.plan?.confirm?.mode;
    await finalizeCurrentDoc(stub, harness.config, { outcome: "completed" });

    expect(isAutoJobActive()).toBe(true);
    expect(readJobLock(harness.root)).not.toBeNull();
    // No rollback happened: the live config is untouched by the doc transaction.
    expect(harness.config.stages.plan?.confirm?.mode).toBe(modeBefore);
  });

  it("failed outcome records the reason and still releases", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    await finalizeCurrentDoc(stub, harness.config, { outcome: "failed", reason: "verify_failures" });

    const doc = harness.state()!.docs[0]!;
    expect(doc.status).toBe("failed");
    expect(doc.failReason).toBe("verify_failures");
    expect(doc.finalizeKey).toBe(`${HARNESS_JOB_ID}:0:failed`);
  });

  it("is idempotent (M3): a second call is skipped with no second cleanup audit", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));

    const first = await finalizeCurrentDoc(stub, harness.config, { outcome: "completed" });
    const second = await finalizeCurrentDoc(stub, harness.config, { outcome: "completed" });

    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    expect(audits.filter((a) => a === "pipeline_auto_cleanup")).toHaveLength(1);
  });

  it("is idempotent across a docIndex move (disk lookup is position-independent)", async () => {
    const state = await harness.install();
    state.docs[0]!.finalizeKey = `${HARNESS_JOB_ID}:0:completed`;
    state.docIndex = 1;
    const { writeJobState } = await import("../../core/auto-pipeline/job-state");
    await writeJobState(harness.root, state);

    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    const result = await finalizeCurrentDoc(stub, harness.config, { outcome: "completed", docIndex: 0 });
    expect(result.skipped).toBe(true);
  });

  it("without an active job it is inert", async () => {
    __resetAutoJobLockForTests();
    const stub = createSessionStub(makeTestMeta());
    expect((await finalizeCurrentDoc(stub, harness.config, { outcome: "completed" })).skipped).toBe(true);
  });
});

describe("finalize — finalizeJob", () => {
  it("rolls back the overlay, releases the lock and writes the terminal status", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    // Simulate a real overlay application first.
    const { applyOverlay } = await import("../../core/auto-pipeline/config-overlay");
    const fs = await import("node:fs");
    const json = JSON.parse(fs.readFileSync(harness.config.configSourcePath!, "utf8"));
    const snapshot = applyOverlay(harness.config, json, {
      ...harness.job,
      jobHash: harness.jobHash,
      jobId: HARNESS_JOB_ID,
      jobPath: `docs/jobs/${HARNESS_JOB_ID}.yaml`,
    });
    const state = harness.state()!;
    state.overlaySnapshot = {
      appliedAt: snapshot.appliedAt,
      jobHash: snapshot.jobHash,
      before: snapshot.before,
      entries: snapshot.entries,
    };
    const { writeJobState } = await import("../../core/auto-pipeline/job-state");
    await writeJobState(harness.root, state);
    expect(harness.config.stages.plan?.confirm?.mode).toBe("auto");

    const result = await finalizeJob(stub, harness.config, { stopReason: "job_completed" });

    expect(result.skipped).toBe(false);
    expect(harness.config.stages.plan?.confirm?.mode).toBe("manual");
    expect(readJobLock(harness.root)).toBeNull();
    expect(isAutoJobActive()).toBe(false);
    expect(harness.state()!.status).toBe("completed");
    expect(audits).toContain("pipeline_auto_overlay_restore");
    expect(audits).toContain("pipeline_auto_stop");
  });

  it("a non-running job is skipped (idempotent) and only notified", async () => {
    await harness.install({ status: "completed" });
    const stub = createSessionStub(makeTestMeta());
    const result = await finalizeJob(stub, harness.config, { stopReason: "job_completed" });
    expect(result.skipped).toBe(true);
    expect(stub.notified[0]).toContain("already finished");
  });

  it("maps stop reasons to terminal statuses", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta());
    await finalizeJob(stub, harness.config, { stopReason: "user_cancelled" });
    expect(readJobState(harness.root, HARNESS_JOB_ID)?.status).toBe("stopped");

    __resetFinalizeStateForTests();
    await harness.install({ status: "running" });
    const stub2 = createSessionStub(makeTestMeta());
    await finalizeJob(stub2, harness.config, { stopReason: "verify_failures" });
    expect(readJobState(harness.root, HARNESS_JOB_ID)?.status).toBe("failed");
  });
});

describe("finalize — buildJobSummary", () => {
  it("reports every bucket plus the stop reason", () => {
    const state = createAutoHarness().state;
    void state;
    const fake = {
      schemaVersion: 1 as const,
      jobId: "alpha_loop",
      jobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: "h",
      jobTotalDocs: 4,
      docIndex: 1,
      status: "stopped" as const,
      startedAt: 0,
      updatedAt: 0,
      counters: { totalLoops: 0, totalFreezes: 0, consecutiveVerifyFailures: 0, autoResumes: 0, finalGraceUsed: {} },
      docs: [
        { doc: HARNESS_DOCS[0]!, status: "completed" as const, updatedAt: 0 },
        { doc: HARNESS_DOCS[1]!, status: "skipped" as const, updatedAt: 0 },
        { doc: "docs/design/c.md", status: "failed" as const, updatedAt: 0 },
        { doc: "docs/design/d.md", status: "pending" as const, updatedAt: 0 },
      ],
      stopReason: "budget_exhausted" as const,
    };
    const summary = buildJobSummary(fake);
    expect(summary).toContain("1 completed");
    expect(summary).toContain("1 skipped");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("1 pending");
    expect(summary).toContain("budget_exhausted");
    // No failed-doc receipt → no failReason detail appended.
    expect(summary).not.toContain("failReason");
  });

  it("226 Phase 3: the summary carries the stopped document's REAL cause", () => {
    const fake = {
      schemaVersion: 1 as const,
      jobId: "alpha_loop",
      jobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: "h",
      jobTotalDocs: 2,
      docIndex: 0,
      status: "failed" as const,
      startedAt: 0,
      updatedAt: 0,
      counters: { totalLoops: 0, totalFreezes: 0, consecutiveVerifyFailures: 0, autoResumes: 0, finalGraceUsed: {} },
      docs: [
        { doc: HARNESS_DOCS[0]!, status: "failed" as const, updatedAt: 0, failReason: "clarify_dispatch_failed" },
        { doc: HARNESS_DOCS[1]!, status: "pending" as const, updatedAt: 0 },
      ],
      stopReason: "doc_failed" as const,
    };
    const summary = buildJobSummary(fake);
    expect(summary).toContain("(doc_failed)");
    expect(summary).toContain("[failReason: clarify_dispatch_failed]");
  });
});

describe("finalize — doc_failed stop label (226 Phase 3)", () => {
  it("soft doc failure + onFailure: stop → stopReason doc_failed (never the borrowed budget_exhausted)", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));

    await handleDocFailure(stub, harness.config, harness.state()!, harness.job, {
      outcome: "failed",
      reason: "clarify_dispatch_failed",
    });

    const state = harness.state()!;
    expect(state.docs[0]?.failReason).toBe("clarify_dispatch_failed");
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("doc_failed");
  });

  it("a HARD verdict keeps its own stop reason (the recheck/loop brake labels do not change)", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));

    await handleDocFailure(stub, harness.config, harness.state()!, harness.job, {
      outcome: "failed",
      verdict: { kind: "hard", stopReason: "wall_clock" },
      reason: "wall_clock",
    });

    expect(harness.state()!.stopReason).toBe("wall_clock");
  });
});

describe("finalize — sidecar-only transaction (review 219 issue 9)", () => {
  it("finalizes even when the job file is unreadable/unparseable", async () => {
    await harness.install();
    // A user edit that breaks the YAML must never skip the receipt / release /
    // lock release (`readActiveJobContext` would have returned null).
    harness.writeBrokenJob();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop", pipelineId: "pipe-1" }));

    const result = await finalizeCurrentDoc(stub, harness.config, { outcome: "completed" });

    expect(result.skipped).toBe(false);
    const state = harness.state()!;
    expect(state.docs[0]?.status).toBe("completed");
    expect(state.docs[0]?.finalizeKey).toBe(`${HARNESS_JOB_ID}:0:completed`);
  });
});

describe("finalize — consecutiveVerifyFailures (review 219 issue 7)", () => {
  function freshState() {
    return createJobState({
      jobId: HARNESS_JOB_ID,
      jobPath: `docs/jobs/${HARNESS_JOB_ID}.yaml`,
      jobHash: "h",
      docs: HARNESS_DOCS.map((doc) => ({ doc })),
    });
  }

  const failures = (n: number) =>
    Array.from({ length: n }, (_v, i) => ({ ruleType: "keywords", detail: `rule ${i}`, timestamp: 0 }));

  it("ONE failed attempt with three violated rules counts once (not three)", () => {
    const state = freshState();
    syncAutoCountersFromMeta({
      state,
      meta: makeTestMeta({ verifyAttempts: 1, verifyFailures: failures(3) }),
      docIndex: 0,
    });
    expect(state.counters.consecutiveVerifyFailures).toBe(1);
  });

  it("each failed attempt adds one and a pass resets the streak", () => {
    const state = freshState();
    for (const attempts of [1, 2, 3]) {
      syncAutoCountersFromMeta({
        state,
        meta: makeTestMeta({ verifyAttempts: attempts, verifyFailures: failures(2) }),
        docIndex: 0,
      });
    }
    expect(state.counters.consecutiveVerifyFailures).toBe(3);

    // Same attempt window seen twice → no double counting.
    syncAutoCountersFromMeta({
      state,
      meta: makeTestMeta({ verifyAttempts: 3, verifyFailures: failures(2) }),
      docIndex: 0,
    });
    expect(state.counters.consecutiveVerifyFailures).toBe(3);

    // A pass clears the failures → the streak restarts.
    syncAutoCountersFromMeta({ state, meta: makeTestMeta({ verifyAttempts: 3, verifyFailures: [] }), docIndex: 0 });
    expect(state.counters.consecutiveVerifyFailures).toBe(0);
  });
});
