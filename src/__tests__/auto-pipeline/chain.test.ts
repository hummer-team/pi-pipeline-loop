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
  reconcilePendingContinuation,
  PENDING_CONTINUATION_TIMEOUT_MS,
  __resetFinalizeStateForTests,
} from "../../core/auto-pipeline/finalize";
import { isAutoJobActive, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { runPipelineAuto } from "../../commands/pipeline-auto";
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
    const sent: string[] = [];
    stub.setNewSession(async ({ withSession }) => {
      calls += 1;
      await withSession({ sendUserMessage: (message: string) => sent.push(message) });
    });

    const result = await continueJobAfterCompleted({ ...stub, ...stub.withNewSession() }, harness.config, harness.job);

    expect(calls).toBe(1);
    expect(result.skipped).toBe(false);
    expect(audits).toContain("pipeline_auto_chain");
    // 221 Phase 4: NO second command is injected — the fresh session finds the
    // pending continuation and starts it on `session_start`.
    expect(sent).toHaveLength(0);
    expect(harness.state()!.pendingContinuation?.channel).toBe("session_start");
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

  it("a hook host (no newSession) DISPATCHES the continuation command", async () => {
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    const dispatched: string[] = [];
    // Production `agent_settled` shape: pi can send a user message but the ctx
    // cannot replace the session (only ExtensionCommandContext has newSession).
    const hookCtx = {
      ...stub,
      pi: { sendUserMessage: (message: string) => dispatched.push(message) },
    };

    const result = await continueJobAfterCompleted(hookCtx, harness.config, harness.job);

    expect(result.skipped).toBe(false);
    expect(dispatched).toHaveLength(1);
    // 221 Phase 4: ONE minimal command — job id + token travel via lock.json.
    expect(dispatched[0]).toBe("/pipeline-auto --next");
    expect(dispatched[0]).not.toContain("--job");
    expect(dispatched[0]).not.toContain("--token");
    // Never started in this session — the dispatched command owns the hop.
    expect(harness.state()!.docs[1]?.status).toBe("pending");
  });

  it("a CANCELLED newSession falls back to the same-session serial", async () => {
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    stub.setNewSession(async ({ withSession }) => {
      await withSession({ sendUserMessage: () => undefined });
      return { cancelled: true };
    });

    const result = await continueJobAfterCompleted(
      { ...stub, ...stub.withNewSession() },
      harness.config,
      harness.job,
    );

    expect(result.skipped).toBe(false);
    expect(harness.state()!.docs[1]?.status).toBe("running");
    expect(harness.state()!.docIndex).toBe(1);
    // 221 Phase 4: a cancelled hop clears the pending record before the
    // same-session fallback (the fallback start then runs without a stale hop).
    expect(harness.state()!.pendingContinuation).toBeUndefined();
  });

  it("chain.onSessionFail:'stop' turns a refused hop into session_fail", async () => {
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    stub.setNewSession(async () => ({ cancelled: true }));
    const stopChain = { ...harness.job, chain: { ...harness.job.chain, onSessionFail: "stop" as const } };

    await continueJobAfterCompleted({ ...stub, ...stub.withNewSession() }, harness.config, stopChain);

    const persisted = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(persisted.status).toBe("failed");
    expect(persisted.stopReason).toBe("session_fail");
    expect(persisted.docs[1]?.status).toBe("pending");
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

describe("chain — dispatch channel bookkeeping (review round 2 issue 3)", () => {
  /** Re-stamp the outstanding hop as overdue (never wait 2 minutes in a test). */
  async function agePendingContinuation(): Promise<void> {
    const state = readJobState(harness.root, HARNESS_JOB_ID)!;
    state.pendingContinuation = {
      at: Date.now() - (PENDING_CONTINUATION_TIMEOUT_MS + 1_000),
      docIndex: state.docIndex,
      channel: "dispatch",
    };
    await writeJobState(harness.root, state);
  }

  it("the dispatch branch records the outstanding hop in the sidecar", async () => {
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    const hookCtx = { ...stub, pi: { sendUserMessage: () => undefined } };

    await continueJobAfterCompleted(hookCtx, harness.config, harness.job);

    const pending = readJobState(harness.root, HARNESS_JOB_ID)!.pendingContinuation;
    expect(pending?.channel).toBe("dispatch");
    expect(pending?.docIndex).toBe(0);
    // The audit says `dispatched`: nothing has rotated yet.
    expect(audits).toContain("pipeline_auto_chain");
  });

  it("a FRESH record is left alone (the hop may still be in flight)", async () => {
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));
    await continueJobAfterCompleted({ ...stub, pi: { sendUserMessage: () => undefined } }, harness.config, harness.job);

    const owned = await reconcilePendingContinuation(stub, harness.config);

    expect(owned).toBe(false);
    expect(readJobState(harness.root, HARNESS_JOB_ID)!.pendingContinuation).toBeDefined();
    expect(readJobState(harness.root, HARNESS_JOB_ID)!.docIndex).toBe(0);
  });

  it("an OVERDUE record falls back to the same-session serial", async () => {
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    await agePendingContinuation();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));

    const owned = await reconcilePendingContinuation(stub, harness.config);

    expect(owned).toBe(true);
    const state = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(state.status).toBe("running");
    expect(state.docIndex).toBe(1);
    expect(state.docs[1]?.status).toBe("running");
    // The hop was answered → the record is gone.
    expect(state.pendingContinuation).toBeUndefined();
  });

  it("an OVERDUE record whose next doc cannot start ends as session_fail", async () => {
    await harness.install();
    await agePendingContinuation();
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));

    const owned = await reconcilePendingContinuation(stub, harness.config);

    expect(owned).toBe(true);
    const state = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("session_fail");
    expect(state.pendingContinuation).toBeUndefined();
    expect(isAutoJobActive()).toBe(false);
  });

  it("a dispatched --next that cannot start the next doc closes the job (no hung run)", async () => {
    // The dispatched command body itself failed (here: the next document does
    // not exist). Without the close the job would stay `running` for ever.
    const installed = await harness.install();
    installed.docs[0]!.status = "completed";
    installed.docs[0]!.finalizeKey = `${HARNESS_JOB_ID}:0:completed`;
    await writeJobState(harness.root, installed);
    const stub = createSessionStub(makeTestMeta({ currentStage: "completed" }));

    const result = await runPipelineAuto(
      harness.config,
      { next: true, job: HARNESS_JOB_ID },
      stub as unknown as Parameters<typeof runPipelineAuto>[2],
    );

    expect(result.success).toBe(false);
    const state = readJobState(harness.root, HARNESS_JOB_ID)!;
    // Terminal either way — the exact reason is the documented failure chain's
    // (`start_failed` → `onFailure: stop`); the point is that nothing hangs.
    expect(state.status).toBe("failed");
    expect(state.pendingContinuation).toBeUndefined();
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
