/**
 * 192 Phase 1 (F04): strict meta-commit tests against the REAL
 * createSessionState adapter with a temp-dir shared store.
 *
 * Covers:
 * - local/shared any-path failure, corrupt shared, missing shared config,
 *   stale shared (foreign pipeline)
 * - same-auth same-round stale operation/revision conflict
 * - stage patch consistency (single commit carrying stage+operation)
 * - original updateMeta still fail-open
 * - commitDesignReviewState fail-closed without strict adapter
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  createSessionState,
  commitDesignReviewState,
  matchCommitExpectation,
  PIPELINE_META_CUSTOM_TYPE,
  __resetSharedStateDir,
  type MetaCommitExpectation,
} from "../../core/session-state";
import type { SessionMeta, DesignReviewState, ReliableMetaCommitResult } from "../../types";
import { createInitialState, generateUUID } from "../../core/design-review/state";
import { makeMockSessionManager } from "../helpers";

/**
 * Real-adapter harness: appended local entries and the shared meta.json both
 * live under a fresh temp directory. The mock session manager SHARES the
 * appendEntry array so getMeta reads what was just written.
 */
function makeRealAdapter(opts?: { breakSharedBase?: boolean }) {
  const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-reliable-"));
  const auditDir = ".pi/audit";
  let sharedBase = path.join(projectRoot, auditDir);
  if (opts?.breakSharedBase) {
    // F04 probe: the shared base path occupied by a PLAIN FILE — every
    // mkdir/write under it must fail (ENOTDIR).
    const blocker = path.join(projectRoot, "audit-blocker");
    fs.writeFileSync(blocker, "not a directory");
    sharedBase = path.join(blocker, "sub");
  }

  let appendBroken = false;
  const entries: unknown[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      if (appendBroken) throw new Error("append_entry_simulated_failure");
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = { sessionManager: makeMockSessionManager(entries) };

  const session = createSessionState(
    pi as never,
    ctx as never,
    opts?.breakSharedBase
      // Absolute broken base (bypasses projectRoot join): auditDir resolves to the blocker
      ? { projectRoot, auditDir: path.relative(projectRoot, sharedBase) }
      : { projectRoot, auditDir },
  );

  return {
    session,
    projectRoot,
    breakAppend: () => {
      appendBroken = true;
    },
    sharedMetaPath: path.join(sharedBase, "pipe-strict-1", "meta.json"),
    cleanup: () => {
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

function baseMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    currentStage: "design-review",
    previousStage: "plan",
    stageStartTime: Date.now(),
    pipelineId: "pipe-strict-1",
    domain: { id: "general", version: "latest", skillPath: "/tmp/domain.md" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    ...overrides,
  };
}

function makeDrState(meta: SessionMeta, session: ReturnType<typeof createSessionState>): DesignReviewState {
  const state = createInitialState("/tmp/project/docs/plan.md", "menu", "a".repeat(64), "/tmp/s.json", {
    pipelineId: meta.pipelineId,
  });
  session.updateMeta({ designReview: state });
  return (session.getMeta()!.designReview)!;
}

describe("192 Phase 1: real adapter strict updateMetaVerified", () => {
  let h: ReturnType<typeof makeRealAdapter>;

  afterEach(() => {
    h?.cleanup();
  });

  it("persists via BOTH local append and shared meta.json, verified by read-back", () => {
    h = makeRealAdapter();
    const meta = baseMeta();
    h.session.updateMeta(meta); // seed local entry so getMeta resolves the pipeline

    const dr = makeDrState(meta, h.session);
    const expected: MetaCommitExpectation = {
      pipelineId: "pipe-strict-1",
      authorizationId: dr.authorizationId,
      round: dr.round,
      operationId: null,
    };
    const res = h.session.updateMetaVerified!(
      { designReview: { ...dr, phase: "review_running", updatedAt: Date.now() }, currentStage: "design-review" },
      expected,
    );
    expect(res.status).toBe("persisted");
    if (res.status === "persisted") {
      expect(res.meta.designReview?.phase).toBe("review_running");
    }
    // The SHARED file physically exists and carries the patch (read-back proof)
    const raw = JSON.parse(fs.readFileSync(h.sharedMetaPath, "utf-8")) as SessionMeta;
    expect(raw.designReview?.phase).toBe("review_running");
  });

  it("returns unavailable when the shared configuration is missing", () => {
    // createSessionState WITHOUT options → no shared base dir
    const entries: unknown[] = [];
    const pi = { appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } };
    __resetSharedStateDir();
    const session = createSessionState(pi as never, { sessionManager: makeMockSessionManager(entries) } as never);
    session.updateMeta(baseMeta());
    const res = session.updateMetaVerified!({ currentStage: "develop" }, { pipelineId: "pipe-strict-1" });
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") {
      expect(res.reason).toBe("shared_not_configured");
    }
  });

  it("returns unavailable when the shared base path is a plain file (F04 probe)", () => {
    h = makeRealAdapter({ breakSharedBase: true });
    const meta = baseMeta();
    h.session.updateMeta(meta);
    const dr = makeDrState(meta, h.session);
    const res = h.session.updateMetaVerified!(
      { designReview: { ...dr, phase: "review_running" } },
      { pipelineId: "pipe-strict-1", authorizationId: dr.authorizationId },
    );
    // Shared write must fail → NEVER a fake success (previously ok=true)
    expect(res.status).toBe("unavailable");
    expect(fs.existsSync(path.join(h.projectRoot, "audit-blocker", "sub"))).toBe(false);
  });

  it("returns unavailable when shared meta.json is corrupt", () => {
    h = makeRealAdapter();
    const meta = baseMeta();
    h.session.updateMeta(meta);
    const dir = path.dirname(h.sharedMetaPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(h.sharedMetaPath, "{not-json!!", "utf-8");

    const res = h.session.updateMetaVerified!(
      { currentStage: "develop" },
      { pipelineId: "pipe-strict-1" },
    );
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") expect(res.reason).toBe("shared_corrupt");
  });

  it("returns unavailable when shared meta.json belongs to a foreign pipeline (stale)", () => {
    h = makeRealAdapter();
    const meta = baseMeta();
    h.session.updateMeta(meta);
    const dir = path.dirname(h.sharedMetaPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(h.sharedMetaPath, JSON.stringify({ pipelineId: "someone-else" }), "utf-8");

    const res = h.session.updateMetaVerified!(
      { currentStage: "develop" },
      { pipelineId: "pipe-strict-1" },
    );
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") expect(res.reason).toBe("shared_pipeline_stale");
  });

  it("returns unavailable when the LOCAL append fails (shared never written)", () => {
    h = makeRealAdapter();
    const meta = baseMeta();
    h.session.updateMeta(meta); // seeds BEFORE breaking append
    h.breakAppend(); // from now on pi.appendEntry throws
    const res = h.session.updateMetaVerified!(
      { currentStage: "develop" },
      { pipelineId: "pipe-strict-1" },
    );
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") expect(res.reason).toBe("local_append_failed");
    // The failed strict commit must NOT have touched shared storage
    const raw = JSON.parse(fs.readFileSync(h.sharedMetaPath, "utf-8")) as SessionMeta;
    expect(raw.currentStage).toBe("design-review");
  });

  it("conflicts on pipeline mismatch", () => {
    h = makeRealAdapter();
    h.session.updateMeta(baseMeta());
    const res = h.session.updateMetaVerified!(
      { currentStage: "develop" },
      { pipelineId: "other-pipeline" },
    );
    expect(res.status).toBe("conflict");
  });

  it("conflicts for a concurrent stale callback with SAME auth and SAME round but older revision", () => {
    h = makeRealAdapter();
    const meta = baseMeta();
    h.session.updateMeta(meta);
    const dr = makeDrState(meta, h.session);

    // Writer A advances the state (same auth, same round, still NO operation,
    // but a newer revision timestamp).
    const revA = dr.updatedAt;
    const resA = h.session.updateMetaVerified!(
      { designReview: { ...dr, phase: "review_running", updatedAt: Date.now() + 50 } },
      { pipelineId: "pipe-strict-1", authorizationId: dr.authorizationId, round: dr.round, operationId: null, stateUpdatedAt: revA },
    );
    expect(resA.status).toBe("persisted");

    // Writer B (stale) carries the SAME auth + round + operation expectation
    // but the OLD revision → same-auth same-round conflict required by F04.
    const resB = h.session.updateMetaVerified!(
      { designReview: { ...dr, phase: "update_ready", updatedAt: Date.now() + 60 } },
      { pipelineId: "pipe-strict-1", authorizationId: dr.authorizationId, round: dr.round, operationId: null, stateUpdatedAt: revA },
    );
    expect(resB.status).toBe("conflict");
    if (resB.status === "conflict") expect(resB.reason).toBe("revision_mismatch");
  });

  it("conflicts when the current operationId differs from the expectation", () => {
    h = makeRealAdapter();
    const meta = baseMeta();
    h.session.updateMeta(meta);
    const dr = makeDrState(meta, h.session);
    const res = h.session.updateMetaVerified!(
      { designReview: { ...dr, phase: "review_running" } },
      { pipelineId: "pipe-strict-1", operationId: "op-that-does-not-exist" },
    );
    expect(res.status).toBe("conflict");
    if (res.status === "conflict") expect(res.reason).toBe("operation_mismatch");
  });

  it("stage patch + designReview in ONE commit lands atomically; write-only failures report unavailable", () => {
    h = makeRealAdapter();
    const meta = baseMeta();
    h.session.updateMeta(meta);
    const dr = makeDrState(meta, h.session);

    // Single consistent patch: stage + counters + designReview
    const res = h.session.updateMetaVerified!(
      {
        currentStage: "plan",
        previousStage: "design-review",
        verifyFailures: [],
        designReview: { ...dr, phase: "update_ready" },
      },
      { pipelineId: "pipe-strict-1", authorizationId: dr.authorizationId, round: dr.round },
    );
    expect(res.status).toBe("persisted");
    const raw = JSON.parse(fs.readFileSync(h.sharedMetaPath, "utf-8")) as SessionMeta;
    expect(raw.currentStage).toBe("plan");
    expect(raw.previousStage).toBe("design-review");
    expect(raw.designReview?.phase).toBe("update_ready");

    // Now block ONLY the shared WRITE (file stays readable): a strict commit
    // must report unavailable, never a fake success. (Skip when running as
    // root, where read-only bits are not enforced.)
    // 193 Phase 2: publishing writes a fresh temp file in the pipeline dir
    // then renames it atomically, so the block must target the DIRECTORY's
    // write bit (the meta.json file permission no longer gates replacement —
    // that is the point of atomic publishing, readers never see a half-write).
    // With the directory unwritable the exclusive commit boundary itself
    // cannot be established → the honest strict failure is the lock reason.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const pipelineDir = path.dirname(h.sharedMetaPath);
    fs.chmodSync(pipelineDir, 0o555);
    try {
      const res2 = h.session.updateMetaVerified!(
        { currentStage: "completed" },
        { pipelineId: "pipe-strict-1" },
      );
      expect(res2.status).toBe("unavailable");
      if (res2.status === "unavailable") expect(res2.reason).toBe("lock_lock_create_failed");
      // Shared still shows the PREVIOUS successful state (no partial apply)
      const still = JSON.parse(fs.readFileSync(h.sharedMetaPath, "utf-8")) as SessionMeta;
      expect(still.currentStage).toBe("plan");
    } finally {
      fs.chmodSync(pipelineDir, 0o755);
    }
  });
});

describe("192 Phase 1: legacy updateMeta stays fail-open", () => {
  it("shared write failure does NOT throw and still returns the merged local snapshot", () => {
    const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-failopen-"));
    try {
      const blocker = path.join(projectRoot, "blocked");
      fs.writeFileSync(blocker, "plain file");
      const entries: unknown[] = [];
      const pi = { appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } };
      const session = createSessionState(pi as never, { sessionManager: makeMockSessionManager(entries) } as never, {
        projectRoot,
        auditDir: path.join("blocked", "must-fail"),
      });
      const merged = session.updateMeta(baseMeta());
      expect(merged).toBeDefined();
      expect(merged!.pipelineId).toBe("pipe-strict-1");
      // Strict interface on the SAME adapter reports the shared problem instead
      const res = session.updateMetaVerified!(
        { currentStage: "develop" },
        { pipelineId: "pipe-strict-1" },
      );
      expect(res.status).toBe("unavailable");
    } finally {
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("192 Phase 1: commitDesignReviewState fail-closed adapter detection", () => {
  it("returns unavailable when the adapter lacks updateMetaVerified (no test-only success)", () => {
    const meta = baseMeta();
    const legacySession = {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch) as SessionMeta,
    };
    const state = createInitialState("/tmp/p_plan.md", "menu", "b".repeat(64));
    const res = commitDesignReviewState(legacySession, state);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("unavailable");
      expect(res.detail).toBe("adapter_lacks_strict_interface");
    }
  });

  it("matchCommitExpectation checks every field incl. phase and null-operation", () => {
    const dr = createInitialState("/tmp/p_plan.md", "menu", "c".repeat(64));
    const meta = baseMeta({ designReview: dr });
    expect(matchCommitExpectation(meta, {
      pipelineId: "pipe-strict-1",
      authorizationId: dr.authorizationId,
      round: 1,
      operationId: null,
      phase: "review_ready",
      stateUpdatedAt: dr.updatedAt,
    })).toBeNull();
    expect(matchCommitExpectation(meta, { pipelineId: "pipe-strict-1", phase: "paused" })).toBe("phase_mismatch");
    expect(matchCommitExpectation(meta, { pipelineId: "pipe-strict-1", round: 2 })).toBe("round_mismatch");
    expect(matchCommitExpectation(meta, { pipelineId: "pipe-strict-1", authorizationId: "other" })).toBe("authorization_mismatch");
    const withOp = { ...meta, designReview: { ...dr, operation: {
      operationId: "op-1", kind: "review" as const, stageVisitId: 1, attempt: 1,
      dispatchState: "pending" as const, createdAt: 1, updatedAt: 1, round: 1,
    } } };
    expect(matchCommitExpectation(withOp, { pipelineId: "pipe-strict-1", operationId: null })).toBe("operation_expected_absent");
    expect(matchCommitExpectation(withOp, { pipelineId: "pipe-strict-1", operationId: "op-1" })).toBeNull();
    expect(matchCommitExpectation(withOp, { pipelineId: "pipe-strict-1", operationId: "op-2" })).toBe("operation_mismatch");
  });
});
