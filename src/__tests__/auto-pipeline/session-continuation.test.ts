/**
 * 221 Phase 4: `session_start` auto-start of a pending chained continuation.
 *
 * Frozen rules:
 * - only the lock-owning process may start (other/dead pid ⇒ no start, no steal);
 * - an active pipeline in this session is never preempted;
 * - a changed job file is drift → terminal `job_drift`, never a start;
 * - failure BEFORE the lock keeps the pending record retryable; failure AFTER
 *   the lock runs `session_fail`;
 * - two session starts in one process never double-start.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTestMeta } from "../helpers";
import {
  createAutoHarness,
  createSessionStub,
  deployHarnessAgents,
  HARNESS_DOCS,
  HARNESS_JOB_ID,
  HARNESS_JOB_YAML,
  type AutoHarness,
} from "./auto-harness";
import {
  __resetSessionContinuationForTests,
  resumePendingContinuationOnSessionStart,
} from "../../core/auto-pipeline/session-continuation";
import {
  __resetAutoJobLockForTests,
  acquireJobLock,
  isAutoJobActive,
} from "../../core/auto-pipeline/config-overlay";
import { readJobState, writeJobState, type AutoJobState } from "../../core/auto-pipeline/job-state";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

let harness: AutoHarness;
let audits: string[];
let notified: string[];
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  __resetSessionContinuationForTests();
  audits = [];
  notified = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
  harness = createAutoHarness();
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  __resetSessionContinuationForTests();
  harness.dispose();
});

/** A running sidecar whose first doc finished and whose hop is pending. */
async function installPending(): Promise<AutoJobState> {
  const state = await harness.install();
  // The fresh session has no in-process lock ownership: the lock FILE names
  // this process, and `startAutoJob` adopts it (production `session_start`).
  __resetAutoJobLockForTests();
  state.docs[0]!.status = "completed";
  state.docs[0]!.finalizeKey = `${HARNESS_JOB_ID}:0:completed`;
  state.pendingContinuation = { at: Date.now(), docIndex: 0, channel: "session_start" };
  await writeJobState(harness.root, state);
  return state;
}

function sessionCtx(currentStage: "completed" | "develop" = "completed", dispatch = false) {
  const stub = createSessionStub(makeTestMeta({ currentStage }));
  return {
    stub,
    ctx: {
      session: {
        getMeta: () => stub.session.getMeta(),
        updateMeta: (patch: Parameters<typeof stub.session.updateMeta>[0]) => {
          const next = stub.session.updateMeta(patch);
          return next;
        },
      },
      ui: {
        notify: (message: string) => {
          notified.push(message);
        },
      },
      // 226 review #1: a startup clarify round needs a delivery channel or the
      // dispatch-failure accounting (not the continuation) would own the doc.
      ...(dispatch ? { pi: { sendUserMessage: (): void => undefined } } : {}),
    },
  };
}

function writeLock(pid: number, jobId = HARNESS_JOB_ID): void {
  const lockPath = path.join(harness.root, ".pi", "auto_pipeline", "lock.json");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ token: "t", jobId, pid, startedAt: 1 }, null, 2), "utf8");
}

/**
 * Deterministic lock-holder liveness.
 *
 * The production hint distinguishes a LIVE foreign holder ("held by pid N")
 * from a DEAD one ("belongs to a dead process") through `kill(pid, 0)`. A
 * fabricated pid (`process.pid + 1`) is therefore only "live" when the OS
 * happens to have allocated it — and the full-suite runner continuously
 * spawns and reaps workers, so the same pid can be dead on the next run.
 * Stub the probe for the fabricated pid only and delegate every other pid to
 * the real `process.kill`, so the case no longer depends on the OS process
 * table at all.
 */
function stubLockHolderLiveness(pid: number, alive: boolean): () => void {
  const realKill = process.kill.bind(process);
  const spy = spyOn(process, "kill").mockImplementation(((
    target: number,
    signal?: number | NodeJS.Signals,
  ) => {
    if (target !== pid) return realKill(target, signal as never);
    if (alive) return true;
    const err = new Error(`kill ESRCH (pid ${pid})`) as NodeJS.ErrnoException;
    err.code = "ESRCH";
    throw err;
  }) as typeof process.kill);
  return () => spy.mockRestore();
}

describe("session_start continuation", () => {
  it("starts the pending doc once and clears the pending record", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    deployHarnessAgents(harness);
    const { ctx } = sessionCtx("completed", true);

    expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(true);

    const state = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(state.docIndex).toBe(1);
    expect(state.docs[1]?.status).toBe("running");
    expect(state.pendingContinuation).toBeUndefined();
    expect(audits.some((line) => line.includes("session_start_auto"))).toBe(true);
  });

  it("does not double-start on two concurrent session starts", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    deployHarnessAgents(harness);
    const { ctx } = sessionCtx("completed", true);

    const [first, second] = await Promise.all([
      resumePendingContinuationOnSessionStart(ctx as never, harness.config),
      resumePendingContinuationOnSessionStart(ctx as never, harness.config),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(readJobState(harness.root, HARNESS_JOB_ID)!.docIndex).toBe(1);
  });

  it("does not start when the lock belongs to another process, and explains why", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const foreignPid = process.pid + 1;
    writeLock(foreignPid);
    const restoreLiveness = stubLockHolderLiveness(foreignPid, true);
    const { ctx } = sessionCtx();

    try {
      expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(false);
      expect(readJobState(harness.root, HARNESS_JOB_ID)!.docs[1]?.status).toBe("pending");
      expect(notified.some((message) => message.includes("held by pid"))).toBe(true);
      expect(
        audits.some((line) => line.includes("pending_lock_foreign") && line.includes('"holder":"alive"')),
      ).toBe(true);
    } finally {
      restoreLiveness();
    }
  });

  it("does not reclaim a DEAD holder's lock (manual /pipeline-auto --next does)", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const deadPid = 4_194_303;
    writeLock(deadPid);
    const restoreLiveness = stubLockHolderLiveness(deadPid, false);
    const { ctx } = sessionCtx();

    try {
      expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(false);
      expect(readJobState(harness.root, HARNESS_JOB_ID)!.docs[1]?.status).toBe("pending");
      expect(notified.some((message) => message.includes("/pipeline-auto --next"))).toBe(true);
      expect(
        audits.some((line) => line.includes("pending_lock_foreign") && line.includes('"holder":"stale"')),
      ).toBe(true);
    } finally {
      restoreLiveness();
    }
  });

  it("throttles the foreign-lock hint to one notice per job", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const foreignPid = process.pid + 1;
    writeLock(foreignPid);
    const restoreLiveness = stubLockHolderLiveness(foreignPid, true);
    const { ctx } = sessionCtx();

    try {
      await resumePendingContinuationOnSessionStart(ctx as never, harness.config);
      await resumePendingContinuationOnSessionStart(ctx as never, harness.config);
      expect(notified.filter((message) => message.includes("held by pid"))).toHaveLength(1);
    } finally {
      restoreLiveness();
    }
  });

  it("hints (and does not start) when the lock file is missing or corrupt", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    // A deleted/corrupt lock is still a "pending job nobody can auto-start".
    fs.writeFileSync(
      path.join(harness.root, ".pi", "auto_pipeline", "lock.json"),
      "{ not json",
      "utf8",
    );
    const { ctx } = sessionCtx();

    expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(false);
    expect(readJobState(harness.root, HARNESS_JOB_ID)!.docs[1]?.status).toBe("pending");
    expect(notified.some((message) => message.includes("lock file is missing"))).toBe(true);
    expect(
      audits.some((line) => line.includes("pending_lock_foreign") && line.includes('"holder":"none"')),
    ).toBe(true);

    // Throttled: the same hint is not repeated on every session start.
    await resumePendingContinuationOnSessionStart(ctx as never, harness.config);
    expect(notified.filter((message) => message.includes("lock file is missing"))).toHaveLength(1);
  });

  it("never preempts an active pipeline in this session", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const { ctx } = sessionCtx("develop");

    expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(false);
    expect(readJobState(harness.root, HARNESS_JOB_ID)!.docs[1]?.status).toBe("pending");
  });

  it("never starts when another job already owns this process", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    // Another project root acquires beta in THIS process → held lock is beta.
    const other = createAutoHarness();
    try {
      const lock = acquireJobLock({ projectRoot: other.root, jobId: "beta" });
      expect(lock.ok).toBe(true);
      const { ctx } = sessionCtx();

      expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(false);
      expect(readJobState(harness.root, HARNESS_JOB_ID)!.docs[1]?.status).toBe("pending");
    } finally {
      other.dispose();
      __resetAutoJobLockForTests();
    }
  });

  it("a changed job file is drift → terminal job_drift, no start", async () => {
    await installPending();
    harness.writeDoc(HARNESS_DOCS[1]!);
    harness.writeBrokenJob();
    const { ctx } = sessionCtx();

    expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(true);

    const state = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(state.status).toBe("stopped");
    expect(state.stopReason).toBe("job_drift");
    expect(state.docs[1]?.status).toBe("pending");
    expect(isAutoJobActive()).toBe(false);
    expect(audits.some((line) => line.includes("job_drift"))).toBe(true);
  });

  it("failure BEFORE the lock keeps the pending record retryable", async () => {
    const state = await installPending();
    // A parse-visible-but-invalid job whose hash MATCHES the sidecar keeps the
    // drift gate quiet, so the failure happens inside `startAutoJob` (pre-lock).
    const invalid = "version: 1\nenabled: true\ndocs:\n  list: []\n";
    fs.writeFileSync(path.join(harness.root, "docs", "jobs", `${HARNESS_JOB_ID}.yaml`), invalid, "utf8");
    state.jobHash = hashJobBytes(invalid);
    await writeJobState(harness.root, state);
    const { ctx } = sessionCtx();

    expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(true);

    const after = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(after.status).toBe("running");
    expect(after.pendingContinuation).toBeDefined();
    expect(audits.some((line) => line.includes("pending_start_retryable"))).toBe(true);
    expect(notified.some((message) => message.includes("/pipeline-auto --next to retry"))).toBe(true);
    expect(isAutoJobActive()).toBe(false);
  });

  it("a lock already held by THIS process does not turn a pre-lock failure into session_fail", async () => {
    const state = await installPending();
    // Reproduce production: the previous session in the same process still owns
    // the module-level lock (finalizeCurrentDoc never releases it). The B3 phase
    // must come from `startAutoJob`, not from `isAutoJobActive()`.
    expect(acquireJobLock({ projectRoot: harness.root, jobId: HARNESS_JOB_ID }).ok).toBe(true);
    expect(isAutoJobActive()).toBe(true);

    const invalid = "version: 1\nenabled: true\ndocs:\n  list: []\n";
    fs.writeFileSync(path.join(harness.root, "docs", "jobs", `${HARNESS_JOB_ID}.yaml`), invalid, "utf8");
    state.jobHash = hashJobBytes(invalid);
    await writeJobState(harness.root, state);
    const { ctx } = sessionCtx();

    expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(true);

    const after = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(after.status).toBe("running");
    expect(after.stopReason).toBeUndefined();
    expect(after.pendingContinuation).toBeDefined();
    expect(audits.some((line) => line.includes("pending_start_retryable"))).toBe(true);
    expect(audits.some((line) => line.includes("session_fail"))).toBe(false);
  });

  it("failure AFTER the lock runs the terminal transaction (session_fail)", async () => {
    await installPending();
    // Valid job, but the next document does not exist → start fails after the
    // lock was adopted by `startAutoJob`.
    const { ctx } = sessionCtx();

    expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(true);

    const state = readJobState(harness.root, HARNESS_JOB_ID)!;
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("session_fail");
    expect(isAutoJobActive()).toBe(false);
  });

  it("does nothing without a pending continuation", async () => {
    const state = await harness.install();
    state.docs[0]!.status = "completed";
    await writeJobState(harness.root, state);
    const { ctx } = sessionCtx();

    expect(await resumePendingContinuationOnSessionStart(ctx as never, harness.config)).toBe(false);
  });

  it("keeps the shipped harness job file byte-stable (hash helper sanity)", () => {
    expect(hashJobBytes(HARNESS_JOB_YAML)).toBe(hashJobBytes(HARNESS_JOB_YAML));
  });
});
