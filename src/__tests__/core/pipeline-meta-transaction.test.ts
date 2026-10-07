/**
 * 193 Phase 2 (Unit Tests Core #1): the exclusive meta.json commit boundary.
 *
 * Layers covered:
 * 1. the mechanical lock/publish module itself (atomic mkdir, owner token,
 *    fail-closed release, atomic replace, honest unavailability);
 * 2. the REAL `createSessionState` adapter wired to the lock: strict commits
 *    conflict on a busy lock with ZERO writes, plain writers refuse to fake
 *    success or roll back a persisted choice, stale whole-object overwrites
 *    and authorization clears are rejected under the design-review barrier,
 *    same-millisecond revisions stay unique, and extended expectations
 *    (dispatch claim / decision anchors) reject honestly;
 * 3. REAL competing PROCESSES (fixture `pipeline-meta-competing-writer.ts`)
 *    over one shared directory with a file barrier: two different human
 *    choices, double send-intent claims, plain counters vs a persisted
 *    choice, stale whole-object overwrite, and the half-write detector.
 *    Nothing here is serial-only or mocked-strict: the acceptance invariants
 *    are exercised across process boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  META_LOCK_DIR_NAME,
  META_LOCK_OWNER_FILE,
  META_FILE_NAME,
  sharedPipelineDir,
  metaLockDirPath,
  readMetaLockOwner,
  tryAcquireMetaLock,
  releaseMetaLock,
  publishSharedMeta,
} from "../../core/pipeline-meta-transaction";
import {
  createSessionState,
  matchCommitExpectation,
  isDesignReviewBarrierActive,
  plainPatchBarrierViolation,
  __resetSharedStateDir,
  type MetaCommitExpectation,
} from "../../core/session-state";
import type { HumanDecision, HumanDecisionChoice } from "../../core/design-review/decision-types";
import { buildPendingHumanDecision } from "../../core/design-review/human-decision";
import { createInitialState } from "../../core/design-review/state";
import type { DesignReviewState, SessionMeta } from "../../types";

const PIPE = "pipe-lock-1";
const FIXTURE = path.join(__dirname, "..", "fixtures", "pipeline-meta-competing-writer.ts");

/** Narrowed read of a persisted choice (union-safe). */
function persistedChoice(meta: SessionMeta): HumanDecisionChoice | "none" {
  const d = meta.designReview?.decision;
  return d && d.state === "chosen" ? d.choice : "none";
}

// ─── temp-dir harness ────────────────────────────────────────────────────────

let root: string;
let baseDir: string; // == {projectRoot}/.pi/audit — the shared base

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "dr-meta-lock-"));
  baseDir = path.join(root, ".pi/audit");
});

afterEach(() => {
  // Restore permissions on any pipeline/lock dirs the failure tests chmod'd
  // so rmSync can always clean up.
  try {
    if (fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory()) {
      for (const pid of fs.readdirSync(baseDir)) {
        const d = path.join(baseDir, pid);
        try {
          fs.chmodSync(d, 0o755);
          const lk = path.join(d, META_LOCK_DIR_NAME);
          if (fs.existsSync(lk)) fs.chmodSync(lk, 0o755);
        } catch {
          /* may not exist */
        }
      }
    }
  } catch {
    /* base dir may never have been created */
  }
  __resetSharedStateDir();
  fs.rmSync(root, { recursive: true, force: true });
});

// ─── 1. mechanical lock + atomic publish ─────────────────────────────────────

describe("193 Phase 2: exclusive lock mechanics", () => {
  it("acquire creates the lock dir with full owner evidence; release removes it", () => {
    const acq = tryAcquireMetaLock(baseDir, PIPE);
    expect(acq.status).toBe("acquired");
    if (acq.status !== "acquired") return;
    expect(fs.existsSync(acq.lockDir)).toBe(true);
    const owner = readMetaLockOwner(acq.lockDir);
    expect(owner).toBeDefined();
    expect(owner!.token).toBe(acq.token);
    expect(owner!.pid).toBe(process.pid);
    expect(owner!.host.length).toBeGreaterThan(0);
    expect(owner!.createdAt).toBeGreaterThan(0);
    const rel = releaseMetaLock(acq.lockDir, acq.token);
    expect(rel.ok).toBe(true);
    expect(fs.existsSync(acq.lockDir)).toBe(false);
  });

  it("a second acquire attempt sees busy with the holder's owner evidence and never steals", () => {
    const first = tryAcquireMetaLock(baseDir, PIPE);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;
    const second = tryAcquireMetaLock(baseDir, PIPE);
    expect(second.status).toBe("busy");
    if (second.status === "busy") {
      expect(second.owner?.token).toBe(first.token);
      expect(second.owner?.pid).toBe(process.pid);
    }
    // still busy after the failed attempt (no steal, no destroy)
    expect(fs.existsSync(metaLockDirPath(baseDir, PIPE))).toBe(true);
    releaseMetaLock(first.lockDir, first.token);
  });

  it("release requires the OWN token: wrong token is not_owner and keeps the lock", () => {
    const acq = tryAcquireMetaLock(baseDir, PIPE);
    if (acq.status !== "acquired") throw new Error("acquire failed");
    const bad = releaseMetaLock(acq.lockDir, "someone-elses-token");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("not_owner");
    expect(fs.existsSync(acq.lockDir)).toBe(true);
    // missing owner metadata → owner_missing, still never deleted
    fs.rmSync(path.join(acq.lockDir, META_LOCK_OWNER_FILE));
    const missing = releaseMetaLock(acq.lockDir, acq.token);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("owner_missing");
    expect(fs.existsSync(acq.lockDir)).toBe(true);
    // human-confirmed cleanup of the residual lock enables acquisition again
    fs.rmSync(acq.lockDir, { recursive: true, force: true });
    expect(tryAcquireMetaLock(baseDir, PIPE).status).toBe("acquired");
  });

  it("a crashed holder's residual lock is fail-closed: busy with owner undefined, never auto-stolen", () => {
    const lockDir = metaLockDirPath(baseDir, PIPE);
    fs.mkdirSync(lockDir, { recursive: true });
    // owner.json absent entirely (crash between mkdir and owner write)
    const acq = tryAcquireMetaLock(baseDir, PIPE);
    expect(acq.status).toBe("busy");
    if (acq.status === "busy") expect(acq.owner).toBeUndefined();
    expect(fs.existsSync(lockDir)).toBe(true);
    fs.writeFileSync(
      path.join(lockDir, META_LOCK_OWNER_FILE),
      JSON.stringify({ token: "t", pid: 999999, host: "elsewhere", createdAt: 1 }),
      "utf-8",
    );
    const again = tryAcquireMetaLock(baseDir, PIPE);
    expect(again.status).toBe("busy");
    if (again.status === "busy") expect(again.owner?.pid).toBe(999999);
    // owner_missing + not_owner both refuse to delete
    expect(releaseMetaLock(lockDir, "whatever").ok).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("unavailable reasons are honest: occupied base → pipeline_dir_failed; read-only pipeline dir → lock_create_failed", () => {
    // The shared BASE path is occupied by a plain FILE: the pipeline dir can
    // never be established → the lock boundary does not exist at all.
    fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
    fs.writeFileSync(baseDir, "not a directory", "utf-8");
    const acq = tryAcquireMetaLock(baseDir, PIPE);
    expect(acq.status).toBe("unavailable");
    if (acq.status === "unavailable") expect(acq.reason).toBe("pipeline_dir_failed");
    fs.rmSync(baseDir);

    const dir = sharedPipelineDir(baseDir, PIPE);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o555);
    const acq2 = tryAcquireMetaLock(baseDir, PIPE);
    expect(acq2.status).toBe("unavailable");
    if (acq2.status === "unavailable") expect(acq2.reason).toBe("lock_create_failed");
    fs.chmodSync(dir, 0o755);
  });

  it("release failure is surfaced (remove_failed) and the lock stays; no auto-continue", () => {
    const acq = tryAcquireMetaLock(baseDir, PIPE);
    if (acq.status !== "acquired") throw new Error("acquire failed");
    const dir = sharedPipelineDir(baseDir, PIPE);
    // Block BOTH the parent (cannot unlink the lock entry) and the lock dir
    // (cannot unlink owner.json) so the failed release is fully atomic:
    // nothing is deleted, owner evidence stays intact.
    fs.chmodSync(dir, 0o555);
    fs.chmodSync(acq.lockDir, 0o555);
    const rel = releaseMetaLock(acq.lockDir, acq.token);
    expect(rel.ok).toBe(false);
    if (!rel.ok) expect(rel.reason).toBe("remove_failed");
    expect(fs.existsSync(acq.lockDir)).toBe(true);
    expect(fs.existsSync(path.join(acq.lockDir, META_LOCK_OWNER_FILE))).toBe(true);
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(acq.lockDir, 0o755);
    expect(releaseMetaLock(acq.lockDir, acq.token).ok).toBe(true);
  });

  it("publish replaces atomically and leaves no temp residue", () => {
    const dir = sharedPipelineDir(baseDir, PIPE);
    fs.mkdirSync(dir, { recursive: true });
    expect(publishSharedMeta(dir, JSON.stringify({ pipelineId: PIPE, v: 1 })).ok).toBe(true);
    expect(publishSharedMeta(dir, JSON.stringify({ pipelineId: PIPE, v: 22 })).ok).toBe(true);
    const finalPath = path.join(dir, META_FILE_NAME);
    expect((JSON.parse(fs.readFileSync(finalPath, "utf-8")) as { v: number }).v).toBe(22);
    const residue = fs.readdirSync(dir).filter((f) => f !== META_FILE_NAME);
    expect(residue).toEqual([]);
  });

  it("a failed publish leaves the previous file fully intact", () => {
    const dir = sharedPipelineDir(baseDir, PIPE);
    fs.mkdirSync(dir, { recursive: true });
    publishSharedMeta(dir, JSON.stringify({ pipelineId: PIPE, v: 1 }));
    fs.chmodSync(dir, 0o555); // temp-file creation must fail
    const res = publishSharedMeta(dir, JSON.stringify({ pipelineId: PIPE, v: 2 }));
    expect(res.ok).toBe(false);
    fs.chmodSync(dir, 0o755);
    expect((JSON.parse(fs.readFileSync(path.join(dir, META_FILE_NAME), "utf-8")) as { v: number }).v).toBe(1);
    // cleanup removed this writer's own temp file only
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

// ─── 2. the REAL adapter: strict/plain writers under the boundary ────────────

function makeAdapter(): { session: ReturnType<typeof createSessionState>; entries: unknown[] } {
  const entries: unknown[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = { sessionManager: { getEntries: () => entries, getBranch: () => entries } };
  __resetSharedStateDir();
  const session = createSessionState(pi as never, ctx as never, {
    projectRoot: root,
    auditDir: ".pi/audit",
  });
  return { session, entries };
}

/**
 * An adapter with SEEDED local entries (a plain deep-equal whole-object echo
 * of the shared snapshot — barrier-legal by design), exactly like a real
 * session process resolving its pipeline through getMeta().
 */
function makeSeededAdapter(): ReturnType<typeof makeAdapter> {
  const h = makeAdapter();
  h.session.updateMeta(readSharedFile());
  return h;
}

function pendingDecision(): HumanDecision {
  return buildPendingHumanDecision({
    reviewIdentity: {
      pipelineId: PIPE,
      planDoc: "/x/plan.md",
      authorizationId: "auth-1",
      round: 1,
      operationId: "op-review-1",
      stageVisitId: 111,
    },
    reportDoc: "/x/round1_report.md",
    reportHash: "r".repeat(64),
    planHash: "p".repeat(64),
    issues: [{ issueId: "1", text: "Missing rollback plan" }],
    mode: "manual",
    ownerSessionFile: "/x/owner.json",
  });
}

function withChosen(dr: DesignReviewState, choice: HumanDecisionChoice): DesignReviewState {
  return {
    ...dr,
    decision: {
      ...dr.decision!,
      state: "chosen",
      choice,
      source: "human",
      decidedAt: Date.now(),
    } as HumanDecision,
  };
}

function decisionPendingState(): DesignReviewState {
  const base = createInitialState("/x/plan.md", "menu", "p".repeat(64), "/x/owner.json", {
    pipelineId: PIPE,
  });
  return {
    ...base,
    authorizationId: "auth-1",
    phase: "paused",
    pauseReason: "decision-pending",
    operation: {
      operationId: "op-review-1",
      kind: "review",
      stageVisitId: 111,
      attempt: 1,
      dispatchState: "dispatched",
      agentId: "agent-1",
      createdAt: 111,
      updatedAt: 111,
    },
    decision: pendingDecision(),
  };
}

function claimableState(): DesignReviewState {
  const base = createInitialState("/x/plan.md", "menu", "p".repeat(64), undefined, {
    pipelineId: PIPE,
  });
  return {
    ...base,
    authorizationId: "auth-2",
    phase: "pass_ready",
    operation: {
      operationId: "op-handoff-1",
      kind: "develop-handoff",
      stageVisitId: 222,
      attempt: 1,
      dispatchState: "pending",
      dispatchEvidence: "confirmed_not_sent",
      dispatchReason: "prepared_not_dispatched",
      createdAt: 222,
      updatedAt: 222,
    },
  };
}

function seedShared(state: DesignReviewState): void {
  const { session } = makeAdapter();
  session.updateMeta({
    currentStage: "design-review",
    previousStage: "plan",
    stageStartTime: 100,
    pipelineId: PIPE,
    domain: { id: "general", version: "latest", skillPath: "/tmp/domain.md" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    designReview: state,
  });
}

function sharedMetaPath(): string {
  return path.join(sharedPipelineDir(baseDir, PIPE), META_FILE_NAME);
}

function readSharedFile(): SessionMeta {
  return JSON.parse(fs.readFileSync(sharedMetaPath(), "utf-8")) as SessionMeta;
}

describe("193 Phase 2: real adapter strict commits under the exclusive lock", () => {
  it("busy lock → strict conflict with ZERO shared writes; plain writer returns undefined and writes nothing", () => {
    seedShared(decisionPendingState());
    const session = makeSeededAdapter().session;
    const acq = tryAcquireMetaLock(baseDir, PIPE);
    if (acq.status !== "acquired") throw new Error("setup: acquire failed");
    const before = fs.readFileSync(sharedMetaPath(), "utf-8");

    const dr = session.getMeta()!.designReview!;
    const res = session.updateMetaVerified!(
      { designReview: withChosen(dr, "revise-plan") },
      {
        pipelineId: PIPE,
        authorizationId: dr.authorizationId,
        round: dr.round,
        operationId: dr.operation?.operationId ?? null,
        phase: dr.phase,
        stateUpdatedAt: dr.updatedAt,
        decisionId: dr.decision!.decisionId,
        decisionState: "pending",
      },
    );
    expect(res.status).toBe("conflict");
    if (res.status === "conflict") expect(res.reason).toBe("lock_busy");

    const plain = session.updateMeta({ loopCount: 7 });
    expect(plain).toBeUndefined();

    expect(fs.readFileSync(sharedMetaPath(), "utf-8")).toBe(before); // byte-for-byte
    releaseMetaLock(acq.lockDir, acq.token);
  });

  it("in-locked unavailable (read-only pipeline dir) → strict unavailable lock_* and plain fail-open WITHOUT shared bypass", () => {
    seedShared(decisionPendingState());
    const session = makeSeededAdapter().session;
    const before = fs.readFileSync(sharedMetaPath(), "utf-8");
    fs.chmodSync(sharedPipelineDir(baseDir, PIPE), 0o555);

    const dr = session.getMeta()!.designReview!;
    const res = session.updateMetaVerified!(
      { designReview: { ...dr, updatedAt: Date.now() } },
      { pipelineId: PIPE, authorizationId: dr.authorizationId, round: dr.round, stateUpdatedAt: dr.updatedAt },
    );
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") expect(res.reason.startsWith("lock_")).toBe(true);

    const plain = session.updateMeta({ loopCount: 9 });
    expect(plain).toBeDefined(); // legacy fail-open local write
    expect(fs.readFileSync(sharedMetaPath(), "utf-8")).toBe(before); // never bypassed the lock
    fs.chmodSync(sharedPipelineDir(baseDir, PIPE), 0o755);
  });

  it("same-millisecond strict writes still get UNIQUE monotonic revisions", () => {
    seedShared(decisionPendingState());
    const session = makeSeededAdapter().session;
    const realNow = Date.now;
    const FIXED = Date.now() + 60_000; // strictly ahead of the seeded revision
    Date.now = () => FIXED;
    try {
      const dr1 = session.getMeta()!.designReview!;
      const r1 = session.updateMetaVerified!(
        { designReview: { ...dr1, outcome: { verdict: "fail", recordedAt: FIXED } } },
        { pipelineId: PIPE, stateUpdatedAt: dr1.updatedAt },
      );
      expect(r1.status).toBe("persisted");
      if (r1.status !== "persisted") return;
      expect(r1.meta.designReview!.updatedAt).toBe(FIXED);

      const r2 = session.updateMetaVerified!(
        { designReview: { ...r1.meta.designReview! } },
        { pipelineId: PIPE, stateUpdatedAt: FIXED },
      );
      expect(r2.status).toBe("persisted");
      if (r2.status !== "persisted") return;
      // strictly greater even though the clock never moved
      expect(r2.meta.designReview!.updatedAt).toBe(FIXED + 1);
      expect(readSharedFile().designReview!.updatedAt).toBe(FIXED + 1);
    } finally {
      Date.now = realNow;
    }
  });

  it("a plain counter writer NEVER rolls back a concurrently persisted choice (merges on authoritative)", () => {
    seedShared(decisionPendingState());
    // Reader A seeds its local snapshot while the decision is still pending.
    const a = makeSeededAdapter();
    // B persists the human choice through a strict commit.
    const b = makeSeededAdapter();
    const dr = b.session.getMeta()!.designReview!;
    const commit = b.session.updateMetaVerified!(
      { designReview: withChosen(dr, "proceed-develop") },
      {
        pipelineId: PIPE,
        authorizationId: dr.authorizationId,
        round: dr.round,
        operationId: dr.operation?.operationId ?? null,
        phase: dr.phase,
        stateUpdatedAt: dr.updatedAt,
        decisionId: dr.decision!.decisionId,
        decisionState: "pending",
      },
    );
    expect(commit.status).toBe("persisted");
    // A now performs a benign plain counter write from its OLD local snapshot.
    const merged = a.session.updateMeta({ loopCount: 3, currentStepIndex: 1 });
    expect(merged).toBeDefined();
    const shared = readSharedFile();
    expect(shared.designReview?.decision?.state).toBe("chosen");
    expect(persistedChoice(shared)).toBe("proceed-develop");
    expect(merged!.designReview?.decision?.state).toBe("chosen");
  });

  it("stale whole-object overwrite / authorization clear / stage rollback are REJECTED under the barrier with zero effect", () => {
    seedShared(decisionPendingState());
    const session = makeSeededAdapter().session;
    const before = fs.readFileSync(sharedMetaPath(), "utf-8");
    const fresh = session.getMeta()!;

    // 1) stale (changed) whole designReview object
    const staleDr: DesignReviewState = { ...fresh.designReview!, decision: undefined, pauseReason: "drift" };
    expect(session.updateMeta({ designReview: staleDr })).toBeUndefined();
    // 2) authorization clear through the plain path
    expect(session.updateMeta({ designReview: undefined })).toBeUndefined();
    // 3) currentStage move while the decision barrier is active
    expect(session.updateMeta({ currentStage: "plan" })).toBeUndefined();

    expect(fs.readFileSync(sharedMetaPath(), "utf-8")).toBe(before);

    // Deep-equal whole-object echo (JOIN-style) remains legal.
    expect(session.updateMeta({ designReview: fresh.designReview })).toBeDefined();
  });

  it("barrier predicates: only decision-carrying pauses block plain writers; finished/legacy pause do not", () => {
    const pendingMeta = { designReview: decisionPendingState() } as unknown as SessionMeta;
    expect(isDesignReviewBarrierActive(pendingMeta)).toBe(true);
    const chosenMetaState = withChosen(decisionPendingState(), "revise-plan");
    const chosenMeta = { designReview: chosenMetaState } as unknown as SessionMeta;
    expect(isDesignReviewBarrierActive(chosenMeta)).toBe(true);
    const driftMeta = {
      designReview: { ...decisionPendingState(), decision: undefined, pauseReason: "drift" },
    } as unknown as SessionMeta;
    expect(isDesignReviewBarrierActive(driftMeta)).toBe(false); // legacy pause untouched
    const finishedMeta = {
      designReview: { ...decisionPendingState(), phase: "finished" as const },
    } as unknown as SessionMeta;
    expect(isDesignReviewBarrierActive(finishedMeta)).toBe(false);

    const patchDrift = { designReview: driftMeta.designReview };
    expect(plainPatchBarrierViolation(patchDrift, driftMeta)).toBeNull();
    // Legacy (non-decision) pauses keep plain-writer freedom — an
    // authorization clear through the plain path stays possible there.
    expect(plainPatchBarrierViolation({ designReview: undefined }, driftMeta)).toBeNull();
    // Under the ACTIVE decision barrier the same clear is refused.
    expect(plainPatchBarrierViolation({ designReview: undefined }, pendingMeta))
      .toBe("authorization_clear_requires_strict");
    expect(plainPatchBarrierViolation({ designReview: pendingMeta.designReview }, pendingMeta)).toBeNull();
    expect(plainPatchBarrierViolation({ designReview: chosenMeta.designReview }, pendingMeta))
      .toBe("design_review_overwrite_requires_strict");
    expect(plainPatchBarrierViolation({ currentStage: "develop" }, pendingMeta))
      .toBe("current_stage_barrier_requires_strict");
    // inactive barrier → plain writes stay as free as before (minimum intervention)
    expect(plainPatchBarrierViolation({ designReview: undefined }, finishedMeta)).toBeNull();
  });

  it("extended expectations: non-claimable operations and wrong decision anchors conflict honestly", () => {
    const claimable = claimableState();
    const meta = { pipelineId: PIPE, designReview: claimable } as SessionMeta;
    // claimable while pending + confirmed_not_sent
    expect(
      matchCommitExpectation(meta, { pipelineId: PIPE, operationId: "op-handoff-1", operationClaimable: true }),
    ).toBeNull();
    // inside the send-intent / unknown / trusted window → never re-claimable
    for (const evidence of ["send_intent", "unknown", "trusted_id"] as const) {
      const m2: SessionMeta = {
        ...meta,
        designReview: { ...claimable, operation: { ...claimable.operation!, dispatchEvidence: evidence } },
      };
      expect(
        matchCommitExpectation(m2, { pipelineId: PIPE, operationId: "op-handoff-1", operationClaimable: true }),
      ).toBe("operation_not_claimable");
    }
    // a dispatched operation is not claimable either
    const m3: SessionMeta = {
      ...meta,
      designReview: {
        ...claimable,
        operation: { ...claimable.operation!, dispatchState: "dispatched", dispatchEvidence: undefined },
      },
    };
    expect(matchCommitExpectation(m3, { pipelineId: PIPE, operationClaimable: true })).toBe("operation_not_claimable");

    // decision anchors
    const m4: SessionMeta = { ...meta, designReview: { ...claimable, decision: pendingDecision() } };
    expect(matchCommitExpectation(m4, { pipelineId: PIPE, decisionId: "other-id" })).toBe("decision_id_mismatch");
    expect(
      matchCommitExpectation(m4, {
        pipelineId: PIPE,
        decisionId: m4.designReview!.decision!.decisionId,
        decisionState: "pending",
      }),
    ).toBeNull();
    expect(matchCommitExpectation(meta, { pipelineId: PIPE, decisionState: "absent" })).toBeNull();
    expect(matchCommitExpectation(m4, { pipelineId: PIPE, decisionState: "absent" })).toBe("decision_state_mismatch");
    expect(matchCommitExpectation(m4, { pipelineId: PIPE, decisionState: "chosen" })).toBe("decision_state_mismatch");
  });

  it("strict claim of a dispatch succeeds exactly once — the second dispatcher is refused", () => {
    seedShared(claimableState());
    const session = makeSeededAdapter().session;
    const dr = session.getMeta()!.designReview!;
    const expected: MetaCommitExpectation = {
      pipelineId: PIPE,
      authorizationId: dr.authorizationId,
      round: dr.round,
      operationId: "op-handoff-1",
      phase: dr.phase,
      stateUpdatedAt: dr.updatedAt,
      operationClaimable: true,
    };
    const first = session.updateMetaVerified!(
      { designReview: { ...dr, operation: { ...dr.operation!, dispatchEvidence: "send_intent" } } },
      expected,
    );
    expect(first.status).toBe("persisted");
    const second = session.updateMetaVerified!(
      { designReview: { ...dr, operation: { ...dr.operation!, dispatchEvidence: "send_intent" } } },
      expected,
    );
    expect(second.status).toBe("conflict");
  });

  it("corrupt or foreign shared storage keeps strict fail-closed (health taxonomy unchanged)", () => {
    seedShared(decisionPendingState());
    const session = makeSeededAdapter().session;
    fs.writeFileSync(sharedMetaPath(), "{ half written", "utf-8");
    const res = session.updateMetaVerified!({}, { pipelineId: PIPE });
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") expect(res.reason).toBe("shared_corrupt");
    fs.writeFileSync(sharedMetaPath(), JSON.stringify({ pipelineId: "someone-else" }), "utf-8");
    const res2 = session.updateMetaVerified!({}, { pipelineId: PIPE });
    expect(res2.status).toBe("unavailable");
    if (res2.status === "unavailable") expect(res2.reason).toBe("shared_pipeline_stale");
  });
});

// ─── 3. REAL competing processes ─────────────────────────────────────────────

interface ChildHandle {
  readyFile: string;
  goFile: string;
  resultFile: string;
  proc: ReturnType<typeof Bun.spawn>;
  label: string;
}

function spawnWriter(label: string, mode: string, extraArg?: string): ChildHandle {
  const readyFile = path.join(root, `${label}.ready`);
  const goFile = path.join(root, `${label}.go`);
  const resultFile = path.join(root, `${label}.result`);
  const proc = Bun.spawn(
    [
      process.execPath,
      FIXTURE,
      mode,
      root,
      ".pi/audit",
      PIPE,
      readyFile,
      goFile,
      resultFile,
      ...(extraArg !== undefined ? [extraArg] : []),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  return { readyFile, goFile, resultFile, proc, label };
}

async function waitReady(child: ChildHandle, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(child.readyFile)) {
    if (child.proc.exitCode !== null) {
      throw new Error(`child ${child.label} exited before ready (code ${child.proc.exitCode})`);
    }
    if (Date.now() - start > timeoutMs) throw new Error(`child ${child.label} ready timeout`);
    await Bun.sleep(5);
  }
}

async function finishChild(child: ChildHandle): Promise<Record<string, unknown>> {
  await child.proc.exited;
  if (!fs.existsSync(child.resultFile)) {
    throw new Error(`child ${child.label} produced no result (exit ${child.proc.exitCode})`);
  }
  return JSON.parse(fs.readFileSync(child.resultFile, "utf-8")) as Record<string, unknown>;
}

async function race(children: ChildHandle[]): Promise<Record<string, unknown>[]> {
  await Promise.all(children.map((c) => waitReady(c)));
  // Release every child within the same millisecond window: REAL contention.
  for (const c of children) fs.writeFileSync(c.goFile, "go", "utf-8");
  return await Promise.all(children.map((c) => finishChild(c)));
}

describe("193 Phase 2: cross-process exclusive commits (real processes)", () => {
  it("two processes committing DIFFERENT choices: at most one persisted, loser conflicts", async () => {
    seedShared(decisionPendingState());
    const originalRevision = readSharedFile().designReview!.updatedAt;
    const results = await race([
      spawnWriter("wA", "choice-commit", "revise-plan"),
      spawnWriter("wB", "choice-commit", "proceed-develop"),
    ]);
    const persisted = results.filter((r) => r.status === "persisted");
    const losers = results.filter((r) => r.status !== "persisted");
    expect(persisted.length).toBe(1);
    expect(losers.length).toBe(1);
    expect([
      "lock_busy",
      "revision_mismatch",
      "decision_state_mismatch",
      "decision_id_mismatch",
    ]).toContain(String(losers[0]!.reason));
    // The persisted choice is EXACTLY one of the two real submissions.
    const shared = readSharedFile();
    expect(shared.designReview?.decision?.state).toBe("chosen");
    expect(["revise-plan", "proceed-develop"]).toContain(String(persisted[0]!.persistedChoice));
    expect(String(persistedChoice(shared))).toBe(String(persisted[0]!.persistedChoice));
    expect(Number(shared.designReview?.updatedAt)).toBeGreaterThan(originalRevision);
  }, 40000);

  it("a lock held by ANOTHER process is honestly busy; after human release the writer succeeds", async () => {
    seedShared(decisionPendingState());
    // Spawn FIRST: the child seeds its local entries (its own brief lock
    // cycle) and waits at the go barrier. Only THEN does another process
    // (this test) hold the commit lock when the child fires its commit.
    const busyChild = spawnWriter("busy", "choice-commit", "revise-plan");
    await waitReady(busyChild);
    const held = tryAcquireMetaLock(baseDir, PIPE);
    if (held.status !== "acquired") throw new Error("setup acquire failed");
    try {
      fs.writeFileSync(busyChild.goFile, "go", "utf-8");
      const busyResult = await finishChild(busyChild);
      expect(busyResult.status).toBe("conflict");
      expect(busyResult.reason).toBe("lock_busy");
      // shared untouched
      expect(readSharedFile().designReview?.decision?.state).toBe("pending");
    } finally {
      // Human confirms all writers stopped → releases the EXACT lock.
      const rel = releaseMetaLock(held.lockDir, held.token);
      expect(rel.ok).toBe(true);
    }
    const okChild = spawnWriter("after", "choice-commit", "revise-plan");
    const [okResult] = await race([okChild]);
    expect(okResult.status).toBe("persisted");
    expect(readSharedFile().designReview?.decision?.state).toBe("chosen");
  }, 40000);

  it("double send-intent claims: exactly one dispatcher claims the operation", async () => {
    seedShared(claimableState());
    const results = await race([
      spawnWriter("cA", "send-intent-claim"),
      spawnWriter("cB", "send-intent-claim"),
    ]);
    const persisted = results.filter((r) => r.status === "persisted");
    expect(persisted.length).toBe(1);
    expect(persisted[0]!.persistedEvidence).toBe("send_intent");
    const losers = results.filter((r) => r.status !== "persisted");
    expect(["lock_busy", "revision_mismatch", "operation_not_claimable"]).toContain(String(losers[0]!.reason));
    const shared = readSharedFile();
    expect(shared.designReview?.operation?.dispatchEvidence).toBe("send_intent");
  }, 40000);

  it("a process holding a stale whole snapshot cannot overwrite a freshly chosen decision", async () => {
    seedShared(decisionPendingState());
    const child = spawnWriter("stale", "stale-overwrite");
    await waitReady(child);
    // A DIFFERENT process context persists the human choice AFTER the child
    // already read the pending snapshot.
    const parent = makeSeededAdapter();
    const dr = parent.session.getMeta()!.designReview!;
    const commit = parent.session.updateMetaVerified!(
      { designReview: withChosen(dr, "revise-plan") },
      {
        pipelineId: PIPE,
        authorizationId: dr.authorizationId,
        round: dr.round,
        operationId: dr.operation?.operationId ?? null,
        phase: dr.phase,
        stateUpdatedAt: dr.updatedAt,
        decisionId: dr.decision!.decisionId,
        decisionState: "pending",
      },
    );
    expect(commit.status).toBe("persisted");
    const result = await race([child]); // child was ready; the go barrier fires now
    expect(result[0]!.rejected).toBe(true);
    expect(result[0]!.decisionStateAfter).toBe("chosen");
    expect(result[0]!.decisionChoiceAfter).toBe("revise-plan");
  }, 40000);

  it("plain counter processes never roll back the chosen decision", async () => {
    seedShared(decisionPendingState());
    const child = spawnWriter("counter", "plain-counter");
    await waitReady(child);
    const parent = makeSeededAdapter();
    const dr = parent.session.getMeta()!.designReview!;
    const commit = parent.session.updateMetaVerified!(
      { designReview: withChosen(dr, "proceed-develop") },
      {
        pipelineId: PIPE,
        authorizationId: dr.authorizationId,
        round: dr.round,
        operationId: dr.operation?.operationId ?? null,
        phase: dr.phase,
        stateUpdatedAt: dr.updatedAt,
        decisionId: dr.decision!.decisionId,
        decisionState: "pending",
      },
    );
    expect(commit.status).toBe("persisted");
    const result = await race([child]);
    expect(result[0]!.returned).toBe(true); // benign counter write succeeded
    expect(result[0]!.decisionStateAfter).toBe("chosen"); // choice survived it
    expect(result[0]!.decisionChoiceAfter).toBe("proceed-develop");
  }, 40000);

  it("readers never observe half-written meta.json while a writer publishes rapidly", async () => {
    seedShared(decisionPendingState());
    const reader = spawnWriter("reader", "reader");
    await waitReady(reader);
    fs.writeFileSync(reader.goFile, "go", "utf-8");
    // Hammer atomic publishes from this process while the child parses.
    const parent = makeSeededAdapter();
    let filler = "x";
    for (let i = 0; i < 120; i++) {
      filler += "xy";
      parent.session.updateMeta({
        loopCount: i,
        domain: { id: "general", version: "latest", skillPath: filler.slice(0, 4000) },
      });
    }
    const result = await finishChild(reader);
    expect(Number(result.reads)).toBeGreaterThan(0);
    expect(result.parseFailures).toBe(0);
    expect(result.pipelineMismatch).toBe(0);
  }, 40000);
});
