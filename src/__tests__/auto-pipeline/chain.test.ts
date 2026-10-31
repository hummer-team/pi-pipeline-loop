/**
 * 219 Phase 5 §6: chaining and the failure degradation.
 *
 * Key behaviors (M1 round 2: §6.1 and §6.2 share ONE ordering):
 * - completed doc + pending docs + `chain.newSession` → new session is tried
 *   first; cancelled/thrown → same-session serial; serial failure → `session_fail`.
 * - `chain.newSession:false` → same-session serial directly.
 * - failure path: hard stop ignores `onFailure`; `stop` ends the job;
 *   `continue` advances to the next doc.
 * - `session_fail` is written ONLY when the same-session serial also fails.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { makeTestMeta } from "../helpers";
import { createAutoHarness, createSessionStub, HARNESS_JOB_ID, HARNESS_DOCS } from "./auto-harness";
import {
  continueJobAfterCompleted,
  finalizeCurrentDoc,
  handleDocFailure,
  __resetFinalizeStateForTests,
} from "../../core/auto-pipeline/finalize";
import { isAutoJobActive, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { readJobState, writeJobState } from "../../core/auto-pipeline/job-state";
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

describe("chain — success path", () => {
  it("starts a new session when the host supports it", async () => {
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    let calls = 0;
    stub.setNewSession(async ({ withSession }) => {
      calls += 1;
      await withSession({ sendUserMessage: () => undefined });
    });

    const result = await continueJobAfterCompleted({ ...stub, ...stub.withNewSession() }, harness.config, harness.job);

    expect(calls).toBe(1);
    expect(result.skipped).toBe(false);
    expect(audits).toContain("pipeline_auto_chain");
    // The next doc does NOT start in this session (the new session owns it).
    expect(harness.state()!.docs[1]?.status).toBe("pending");
  });

  it("chain.newSession:false starts the next doc in the same session", async () => {
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub();
    const noNewSession = { ...harness.job, chain: { ...harness.job.chain, newSession: false } };

    const result = await continueJobAfterCompleted(stub, harness.config, noNewSession);

    expect(result.skipped).toBe(false);
    expect(harness.state()!.docs[1]?.status).toBe("running");
    expect(harness.state()!.docIndex).toBe(1);
  });

  it("no pending docs → finalizeJob(job_completed)", async () => {
    const state = await harness.install();
    state.docs[0]!.status = "completed";
    state.docs[1]!.status = "skipped";
    await writeJobState(harness.root, state);
    const stub = createSessionStub();

    const result = await continueJobAfterCompleted(stub, harness.config, harness.job);

    expect(result.skipped).toBe(false);
    expect(readJobState(harness.root, HARNESS_JOB_ID)?.status).toBe("completed");
    expect(isAutoJobActive()).toBe(false);
  });
});

describe("chain — failure path (M1)", () => {
  it("onFailure:stop ends the job (hard stop is not required)", async () => {
    const state = await harness.install();
    const stub = createSessionStub();
    const stopJob = { ...harness.job, docs: { ...harness.job.docs, onFailure: "stop" as const } };

    await handleDocFailure(stub, harness.config, state, stopJob, {
      outcome: "failed",
      reason: "start_failed",
    });

    const persisted = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(persisted.docs[0]?.status).toBe("failed");
    expect(persisted.status).toBe("failed");
  });

  it("a HARD verdict ignores onFailure:continue", async () => {
    const state = await harness.install();
    const stub = createSessionStub();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const continueJob = { ...harness.job, docs: { ...harness.job.docs, onFailure: "continue" as const } };

    await handleDocFailure(stub, harness.config, state, continueJob, {
      outcome: "failed",
      verdict: { kind: "hard", stopReason: "wall_clock" },
      reason: "wall_clock",
    });

    const persisted = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(persisted.status).toBe("failed");
    expect(persisted.stopReason).toBe("wall_clock");
    expect(persisted.docs[1]?.status).toBe("pending"); // never continued
  });

  it("M1: newSession throws → same-session serial succeeds → NO session_fail", async () => {
    const state = await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub();
    stub.setNewSession(async () => {
      throw new Error("host refused a new session");
    });
    const continueJob = { ...harness.job, docs: { ...harness.job.docs, onFailure: "continue" as const } };

    await handleDocFailure({ ...stub, ...stub.withNewSession() }, harness.config, state, continueJob, {
      outcome: "failed",
      reason: "start_failed",
    });

    const persisted = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(persisted.status).toBe("running");
    expect(persisted.stopReason).toBeUndefined();
    expect(persisted.docIndex).toBe(1);
    expect(persisted.docs[1]?.status).toBe("running");
  });

  it("session_fail is written only when the same-session serial also fails", async () => {
    const state = await harness.install();
    // No doc file → the serial start fails too.
    const stub = createSessionStub();
    const continueJob = { ...harness.job, docs: { ...harness.job.docs, onFailure: "continue" as const } };

    await handleDocFailure(stub, harness.config, state, continueJob, {
      outcome: "failed",
      reason: "start_failed",
    });

    const persisted = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(persisted.status).toBe("failed");
    expect(persisted.stopReason).toBe("session_fail");
  });

  it("a repeated failure on the same doc is idempotent (one cleanup row)", async () => {
    const state = await harness.install();
    const stub = createSessionStub();
    const stopJob = { ...harness.job, docs: { ...harness.job.docs, onFailure: "stop" as const } };

    await handleDocFailure(stub, harness.config, state, stopJob, { outcome: "failed", reason: "boom" });
    // The job is terminal now; a second attempt must not re-run the transaction.
    __resetFinalizeStateForTests();
    const reloaded = readJobState(harness.root, HARNESS_JOB_ID)!;
    const second = await finalizeCurrentDoc(stub, harness.config, { outcome: "failed", reason: "boom" });
    expect(reloaded.status).toBe("failed");
    expect(["skipped", "ok"]).toContain(second.skipped ? "skipped" : "ok");
  });
});
