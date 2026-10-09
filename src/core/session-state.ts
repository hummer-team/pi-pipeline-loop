/**
 * @module session-state
 * SessionState adapter over pi SDK's native CustomEntry mechanism.
 *
 * Provides a unified getMeta/updateMeta interface for persisting pipeline
 * SessionMeta across session reloads, replacing the non-existent ctx.session
 * API from the original stub.
 *
 * Phase 1 (143): Introduces shared state source — a per-pipeline meta.json
 * file at `{projectRoot}/{auditDir}/{pipelineId}/meta.json`. This file is
 * the authority for cross-session stage synchronization (sub-agent fork
 * and breakpoint resume). getMeta() reads shared source first (if pipelineId
 * matches), falling back to local session entries. updateMeta() dual-writes
 * to both local entries and the shared meta.json (fail-open on shared write).
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionMeta, ReliableMetaCommitResult, DesignReviewState, DesignReviewPhase, DesignReviewPauseReason } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";
import { resolveAuditDir } from "../utils/work-dir";
import {
  tryAcquireMetaLock,
  releaseMetaLock,
  publishSharedMeta,
  sharedPipelineDir,
  type MetaLockAcquisition,
} from "./pipeline-meta-transaction";
// 194 Phase 0 (C3): executor-run commit comparison + stale-write protection.
// commit-guard has no runtime imports of its own, so this adds no module cycle.
import {
  matchStageExecutorExpectation,
  stageExecutorRunPatchViolation,
  executorExpectationFromCurrent,
} from "./stage-executor/commit-guard";
import type { StageExecutorExpectation } from "./stage-executor/contracts";
import type { PipelineConfig } from "../types";

/** CustomEntry type identifier for pipeline metadata persistence. */
export const PIPELINE_META_CUSTOM_TYPE = "pi-pipeline:meta";

/**
 * Options for createSessionState enabling the shared state source.
 * When projectRoot is provided, getMeta/updateMeta will dual-read/write
 * the shared meta.json at `{projectRoot}/{auditDir}/{pipelineId}/meta.json`.
 */
export interface SessionStateOptions {
  /** Absolute path to the project root directory */
  projectRoot?: string;
  /** Audit directory relative to projectRoot (resolved by resolveAuditDir) */
  auditDir?: string;
  /** Plugin-owned asset directory (relative to projectRoot, default ".pi") */
  piWorkDir?: string;
}

/**
 * Unified interface for reading and writing pipeline SessionMeta
 * via the pi SDK's CustomEntry mechanism.
 *
 * Per plan, the interface only contains getMeta/updateMeta.
 * extractAssistantMessages is a standalone exported function.
 */
export interface SessionState {
  /** Read the latest SessionMeta from session entries. Returns undefined if none exists. */
  getMeta(): SessionMeta | undefined;

  /**
   * Write a new SessionMeta snapshot by merging the current state with a patch.
   * Uses pi.appendEntry() for persistence. Failures are logged but not thrown (fail-open).
   */
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;

  /**
   * 192 Phase 1 (F04): STRICT, fail-closed meta commit for the design-review
   * closed loop. Unlike updateMeta this NEVER reports success unless BOTH the
   * local appendEntry and the shared meta.json write were performed and the
   * shared file was read back and verified.
   *
   * Explicit failure modes reported as `{status:"unavailable"}`:
   * - shared state base dir not configured;
   * - shared meta.json unreadable/corrupt or bound to a foreign pipeline (stale);
   * - local appendEntry failure;
   * - shared write failure;
   * - read-back failure or identity mismatch after read-back.
   *
   * `{status:"conflict"}` is returned when the current persisted state does not
   * match `expected` (pipeline/auth/round/operation/phase/revision), including
   * a concurrent stale callback carrying the same authorization and round but
   * an older operation/revision.
   *
   * A successful getMeta() local snapshot (with `_sharedStale` stripped) is
   * NEVER treated as shared success.
   */
  updateMetaVerified?(patch: Partial<SessionMeta>, expected: MetaCommitExpectation): ReliableMetaCommitResult;
}

/**
 * 192 Phase 1: expectation compared against the CURRENT persisted state
 * before a strict commit is allowed to proceed. All optional fields are
 * compared only when provided (undefined = don't check).
 *
 * 194 Phase 0 (C3): extends the bounded executor-run anchors (stage / visit /
 * runId / terminalConsumed / declarationRevision / resultKey) — a concurrent
 * consumer of the SAME run can therefore only succeed on ONE side.
 *
 * Single-writer model: comparison is synchronous against the current owner
 * state; this makes no cross-process CAS/transaction claim.
 */
export interface MetaCommitExpectation extends StageExecutorExpectation {
  /** Current run pipeline id — must match the persisted state */
  pipelineId: string;
  /** Expected design-review authorizationId of the CURRENT state */
  authorizationId?: string;
  /** Expected design-review round of the CURRENT state */
  round?: number;
  /** Expected current operationId; `null` asserts there is NO current operation */
  operationId?: string | null;
  /** Expected design-review phase of the CURRENT state */
  phase?: import("../types").DesignReviewPhase;
  /** Expected state.updatedAt (finite revision anchor for same-auth same-round conflicts) */
  stateUpdatedAt?: number;
  /**
   * 193 Phase 2 (task 4): in-lock dispatch-claim guard. When true, the
   * authoritative operation must STILL be `dispatchState === "pending"` with
   * `dispatchEvidence === "confirmed_not_sent"`. An operation already inside
   * the send-intent / unknown / trusted-id window can NEVER be claimed again
   * (no blind re-dispatch, exactly-once dispatch ownership).
   */
  operationClaimable?: true;
  /** 193 Phase 2 (task 8): the authoritative decision must carry this exact decisionId */
  decisionId?: string;
  /** 193 Phase 2 (task 8): the authoritative decision must be in this state */
  decisionState?: "pending" | "chosen" | "absent";
}

/**
 * Module-level cache for the shared state base directory.
 * Resolved once from projectRoot + auditDir on first createSessionState call.
 * Reset via __resetSharedStateDir() for test isolation.
 *
 * NOTE: The base dir is also captured per-instance via closure in createSessionState
 * so that concurrent sessions with different projectRoots don't interfere.
 * The module-level cache exists primarily for backward compatibility with
 * code that doesn't pass options.
 */
let sharedStateBaseDir = "";

/**
 * Test-only reset hook for the shared state base directory.
 * Mirrors __resetAuditDirPath() in auditLog.ts.
 */
export function __resetSharedStateDir(): void {
  sharedStateBaseDir = "";
}

/**
 * Resolve the shared state base directory from options.
 * Updates the module-level cache and returns the resolved path.
 */
function resolveSharedStateBaseDir(options?: SessionStateOptions): string {
  if (options?.projectRoot) {
    const auditDir = resolveAuditDir(options);
    const resolved = path.resolve(options.projectRoot, auditDir);
    if (!sharedStateBaseDir) sharedStateBaseDir = resolved;
    return resolved;
  }
  return sharedStateBaseDir;
}

/**
 * 192 Phase 1: raw read of the shared meta.json for strict-commit purposes.
 * Unlike getMeta() this does NOT fall back to local snapshots and does NOT
 * strip staleness markers — it reports exactly what shared storage says.
 */
function readSharedRaw(baseDir: string, pipelineId: string): {
  meta?: SessionMeta;
  error?: "missing" | "read_failed" | "corrupt" | "foreign_pipeline";
} {
  const metaPath = path.join(baseDir, pipelineId, "meta.json");
  let text: string;
  try {
    text = fs.readFileSync(metaPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { error: "missing" };
    // ENOTDIR (base path occupied by a plain file), EACCES, ELOOP etc.
    // are shared-storage health failures, never "file does not exist".
    return { error: "read_failed" };
  }
  try {
    const parsed = JSON.parse(text) as SessionMeta;
    if (!parsed || typeof parsed !== "object") return { error: "corrupt" };
    if (parsed.pipelineId !== pipelineId) return { error: "foreign_pipeline" };
    return { meta: parsed };
  } catch {
    return { error: "corrupt" };
  }
}

/**
 * 192 Phase 1: compare the CURRENT persisted state against a commit
 * expectation. Returns a conflict reason string, or null when the patch may
 * proceed. Synchronous single-writer comparison — no cross-process CAS claim.
 *
 * Exported so strict-capable test fixtures share the EXACT production
 * comparison semantics (no second implementation).
 */
export function matchCommitExpectation(
  current: SessionMeta,
  expected: MetaCommitExpectation,
): string | null {
  if (current.pipelineId !== expected.pipelineId) {
    return `pipeline_mismatch:${current.pipelineId ?? "none"}`;
  }
  const dr = current.designReview;
  if (expected.authorizationId !== undefined && dr?.authorizationId !== expected.authorizationId) {
    return "authorization_mismatch";
  }
  if (expected.round !== undefined && dr?.round !== expected.round) {
    return "round_mismatch";
  }
  if (expected.operationId !== undefined) {
    const curOpId = dr?.operation?.operationId;
    if (expected.operationId === null) {
      if (curOpId !== undefined) return "operation_expected_absent";
    } else if (curOpId !== expected.operationId) {
      return "operation_mismatch";
    }
  }
  if (expected.phase !== undefined && dr?.phase !== expected.phase) {
    return "phase_mismatch";
  }
  // Finite revision anchor: a stale callback that carries the SAME auth and
  // round but an older revision must still conflict.
  if (expected.stateUpdatedAt !== undefined && dr?.updatedAt !== expected.stateUpdatedAt) {
    return "revision_mismatch";
  }
  // 193 Phase 2 (task 4): in-lock dispatch-claim guard — only a still-pending,
  // provably-not-sent operation may be claimed for dispatch.
  if (expected.operationClaimable === true) {
    const op = dr?.operation;
    if (!op || op.dispatchState !== "pending" || op.dispatchEvidence !== "confirmed_not_sent") {
      return "operation_not_claimable";
    }
  }
  // 193 Phase 2 (task 8): human-decision anchor — the decision the caller
  // acted on must still be the authoritative one (id + state).
  if (expected.decisionId !== undefined && dr?.decision?.decisionId !== expected.decisionId) {
    return "decision_id_mismatch";
  }
  if (expected.decisionState !== undefined) {
    const cur = dr?.decision?.state;
    if (expected.decisionState === "absent" ? cur !== undefined : cur !== expected.decisionState) {
      return "decision_state_mismatch";
    }
  }
  // 194 Phase 0 (C3): bounded executor-run anchors (stage/visit/run/terminal/
  // declaration revision/result key) — one concurrent consumer can succeed.
  return matchStageExecutorExpectation(current, expected);
}

/**
 * 193 Phase 2: canonical JSON with sorted object keys — used ONLY for
 * equality comparisons of persisted sub-documents (deep "did this value
 * change?" test). Insertion-order differences never mask a real change.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * 193 Phase 2 (task 2): the design-review takeover phases that form an
 * active write barrier. `finished` is terminal (never a barrier). A `paused`
 * state is a barrier ONLY while a human plan-revision decision is in play
 * (pending or chosen) — plain writers must not roll back `chosen` state,
 * while pre-existing pause flows (drift/no-change/…) keep their legacy
 * behaviour (minimum intervention, no new authority either way).
 */
export function isDesignReviewBarrierActive(meta: SessionMeta | undefined): boolean {
  const dr = meta?.designReview;
  if (!dr || dr.phase === "finished") return false;
  if (dr.phase === "paused") {
    return dr.pauseReason === "decision-pending" || dr.decision !== undefined;
  }
  return true;
}

/**
 * 193 Phase 2 (task 2): violation reason when a PLAIN (expectation-less)
 * patch tries to change protected shared state under an active barrier, or
 * null when the patch is harmless. Whole-snapshot writers (e.g. a subagent
 * JOIN echo of a just-read parent meta whose designReview is unchanged) are
 * allowed; STALE or changed values are rejected because they would overwrite
 * a newer authoritative record (most importantly a persisted human choice).
 * Such patches must migrate to strict commits with expectations.
 */
export function plainPatchBarrierViolation(
  patch: Partial<SessionMeta>,
  authoritative: SessionMeta,
): string | null {
  // 194 Phase 0 (C3): run-identity protection applies EVEN when the
  // design-review barrier is closed — after `finished` the live develop run
  // is still the permission authority, so a stale whole-meta echo must never
  // erase it.
  const executorViolation = stageExecutorRunPatchViolation(patch, authoritative);
  if (executorViolation) return executorViolation;
  if (!isDesignReviewBarrierActive(authoritative)) return null;
  const authDr = authoritative.designReview!;
  if ("designReview" in patch) {
    if (patch.designReview === undefined) {
      return "authorization_clear_requires_strict";
    }
    if (canonicalJson(patch.designReview) !== canonicalJson(authDr)) {
      // Changed designReview payload (incl. any decision carried inside it).
      return "design_review_overwrite_requires_strict";
    }
  }
  if (
    "currentStage" in patch
    && patch.currentStage !== undefined
    && patch.currentStage !== authoritative.currentStage
  ) {
    return "current_stage_barrier_requires_strict";
  }
  return null;
}

/**
 * 192 Phase 1: shared strict-commit for design-review consumers.
 * Requires the adapter to expose `updateMetaVerified`; adapters without a
 * reliable interface get `unavailable` — a local read-back is NEVER
 * substituted as shared success.
 */
export function strictCommitMeta(
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
    updateMetaVerified?(patch: Partial<SessionMeta>, expected: MetaCommitExpectation): ReliableMetaCommitResult;
  },
  patch: Partial<SessionMeta>,
  expected: MetaCommitExpectation,
): ReliableMetaCommitResult {
  if (typeof session.updateMetaVerified !== "function") {
    safeWriteAuditLog("design_review_commit", {
      reason: "adapter_lacks_strict_interface",
    }, "error");
    return { status: "unavailable", reason: "adapter_lacks_strict_interface" };
  }
  return session.updateMetaVerified(patch, expected);
}

/**
 * 192 Phase 1: convenience — build a commit expectation from the CURRENT
 * design-review state so callers that simply want "no concurrent change since
 * my read" get the revision anchor automatically.
 */
export function expectedFromCurrent(
  meta: SessionMeta,
): MetaCommitExpectation {
  const dr = meta.designReview;
  return {
    pipelineId: meta.pipelineId ?? "unknown",
    ...(dr?.authorizationId !== undefined ? { authorizationId: dr.authorizationId } : {}),
    ...(dr?.round !== undefined ? { round: dr.round } : {}),
    ...(dr ? { operationId: dr.operation?.operationId ?? null as string | null } : {}),
    ...(dr?.phase !== undefined ? { phase: dr.phase } : {}),
    ...(dr?.updatedAt !== undefined ? { stateUpdatedAt: dr.updatedAt } : {}),
    // 194 Phase 0 (C3): anchor the latest executor run too — "no concurrent
    // change since my read" covers a run appearing OR disappearing meanwhile.
    ...executorExpectationFromCurrent(meta),
  };
}

/**
 * Create a SessionState adapter bound to the current pi ExtensionAPI and ExtensionContext.
 *
 * Read path:
 *   1. Scan local session entries in reverse for the latest pipeline meta CustomEntry.
 *      Extract pipelineId from it.
 *   2. If shared state base dir is configured AND pipelineId is known, read
 *      `{baseDir}/{pipelineId}/meta.json`. If it exists and contains a matching
 *      pipelineId, return it as the authoritative state (shared source wins).
 *   3. Otherwise fall back to the local entry result.
 *
 * Write path: calls pi.appendEntry() + writes meta.json (dual-write, fail-open on shared).
 */
export function createSessionState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options?: SessionStateOptions,
): SessionState {
  // Resolve base dir per-instance (captured in closure) — avoids cross-test interference.
  // Also updates module-level cache for backward compat.
  const instanceBaseDir = resolveSharedStateBaseDir(options);

  return {
    getMeta(): SessionMeta | undefined {
      try {
        const entries = ctx.sessionManager.getEntries();

        // Step 1: Scan local entries for pipelineId and local meta snapshot
        let localPipelineId: string | undefined;
        let localMeta: SessionMeta | undefined;
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (
            entry.type === "custom" &&
            "customType" in entry &&
            entry.customType === PIPELINE_META_CUSTOM_TYPE
          ) {
            const data = (entry as { data?: unknown }).data;
            if (data && typeof data === "object") {
              if (!localMeta) localMeta = data as SessionMeta;
              if (!localPipelineId && (data as SessionMeta).pipelineId) {
                localPipelineId = (data as SessionMeta).pipelineId;
              }
              if (localMeta && localPipelineId) break;
            }
          }
        }

        // Step 2: Read shared source if available (use per-instance base dir)
        if (localPipelineId && instanceBaseDir) {
          try {
            const metaPath = path.join(instanceBaseDir, localPipelineId, "meta.json");
            const content = fs.readFileSync(metaPath, "utf-8");
            const shared = JSON.parse(content) as SessionMeta;
            // Only trust shared source if pipelineId matches (guard against stale files)
            if (shared && shared.pipelineId === localPipelineId) {
              // Check if the local entry has a _sharedStale flag, which means the
              // last shared source write failed. In that case, fall back to local
              // entries to prevent state regression from old shared data.
              if ((localMeta as any)?._sharedStale) {
                // Return local meta without the internal stale markers
                const { _sharedStale, _sharedStaleAt, ...cleanLocal } = localMeta as any;
                return cleanLocal as SessionMeta;
              }
              return shared;
            }
          } catch {
            // Shared source doesn't exist or is unreadable — fall through to local
          }
        }

        // Step 3: Fall back to local entries
        return localMeta;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        safeWriteAuditLog("session_state_error", { operation: "getMeta", error: errMsg }, "error");
        return undefined;
      }
    },

    /**
     * 193 Phase 2 (tasks 1-3): the plain shared writer now runs under the
     * SAME exclusive commit lock as strict commits and merges onto the
     * authoritative shared snapshot re-read INSIDE the lock. Guarantees:
     * - Busy lock → returns undefined and writes NOTHING (no local fake
     *   success, no shared bypass).
     * - Changed designReview payloads, authorization clears, or a stale
     *   currentStage rollback under an active design-review barrier are
     *   REJECTED with zero effect: such patches must migrate to strict
     *   commits with expectations — serialization by the lock alone never
     *   accepts an expired whole-object overwrite.
     * - Shared-storage health failures keep the pre-existing fail-open
     *   behaviour (local write + _sharedStale stamp): the legacy fallback
     *   stays exactly as wide as it was, it is NOT a new authority.
     * - Publishing uses a unique temp file + fsync + atomic rename, so
     *   readers never observe half-written meta.json.
     */
    updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined {
      try {
        const current = this.getMeta();
        const preliminary = current ? { ...current, ...patch } : (patch as SessionMeta);

        // No shared storage configured → legacy local-only behaviour (unchanged).
        if (!preliminary.pipelineId || !instanceBaseDir) {
          pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, preliminary);
          return preliminary;
        }

        const acq = tryAcquireMetaLock(instanceBaseDir, preliminary.pipelineId);
        if (acq.status === "busy") {
          // Another writer owns the commit boundary. NEVER fake success:
          // zero writes, honest conflict, and evidence of WHO holds the lock
          // (same-machine evidence — this is not a lease to be stolen).
          safeWriteAuditLog("session_state_plain", {
            operation: "updateMeta",
            outcome: "rejected",
            reason: "lock_busy",
            lockDir: acq.lockDir,
            ...(acq.owner
              ? {
                  lockPid: String(acq.owner.pid),
                  lockHost: acq.owner.host,
                  lockToken: acq.owner.token.slice(0, 8),
                  lockCreatedAt: String(acq.owner.createdAt),
                }
              : { lockOwner: "missing" }),
            guidance: "Remove the exact residual lock only after ALL writers for this pipeline are confirmed stopped, then resume.",
          }, "warn");
          return undefined;
        }
        if (acq.status === "unavailable") {
          // Lock machinery itself failed → existing fail-open fallback (local
          // write + stale stamp). Never bypasses the lock into a shared write.
          safeWriteAuditLog("session_state_error", {
            operation: "updateMeta_shared",
            error: acq.error ?? acq.reason,
          }, "warn");
          try {
            pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, {
              ...preliminary, _sharedStale: true, _sharedStaleAt: Date.now(),
            });
          } catch {
            // Best-effort: local state stays consistent either way
          }
          return preliminary;
        }

        try {
          // 193 Phase 2: authoritative re-read INSIDE the lock. A healthy
          // shared snapshot is the merge base — a stale local meta (even one
          // flagged _sharedStale) never overwrites healthy shared state.
          // Only a genuinely absent file may fall back to the local state.
          const raw = readSharedRaw(instanceBaseDir, preliminary.pipelineId);
          const base = raw.meta ?? current ?? preliminary;
          if (raw.meta) {
            const violation = plainPatchBarrierViolation(patch, raw.meta);
            if (violation) {
              safeWriteAuditLog("session_state_plain", {
                operation: "updateMeta",
                outcome: "rejected",
                reason: violation,
                pipelineId: preliminary.pipelineId,
              }, "warn");
              // Zero-effect rejection: no local write, no shared write.
              return undefined;
            }
          }
          const merged = { ...base, ...patch };

          // Write 1: appendEntry (local session)
          pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, merged);

          // Write 2: meta.json (shared source, atomic publish, fail-open stamp)
          const pipelineDir = sharedPipelineDir(instanceBaseDir, preliminary.pipelineId);
          const pub = publishSharedMeta(pipelineDir, JSON.stringify(merged, null, 2));
          if (!pub.ok) {
            // Fail-open: log but don't block pipeline (pre-193 behaviour).
            safeWriteAuditLog("session_state_error", {
              operation: "updateMeta_shared",
              error: pub.error,
            }, "warn");
            // Stamp local entry with sharedStale flag so getMeta detects it.
            try {
              pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, {
                ...merged, _sharedStale: true, _sharedStaleAt: Date.now(),
              });
            } catch {
              // Best-effort: if even this fails, local state is still consistent
            }
          }

          return merged;
        } catch (err) {
          // Fail-open: log but don't throw to avoid blocking the pipeline
          const errMsg = err instanceof Error ? err.message : String(err);
          safeWriteAuditLog("session_state_error", {
            error: errMsg,
            operation: "updateMeta",
          }, "error");
          return undefined;
        } finally {
          const rel = releaseMetaLock(acq.lockDir, acq.token);
          if (!rel.ok) {
            safeWriteAuditLog("session_state_plain", {
              operation: "updateMeta_release",
              outcome: "release_failed",
              reason: rel.reason,
              lockDir: acq.lockDir,
              ...(rel.error !== undefined ? { error: rel.error } : {}),
              guidance: "Lock intentionally left in place (fail-closed). Stop every writer for this pipeline, then remove this exact directory before resuming.",
            }, "error");
          }
        }
      } catch (err) {
        // Fail-open: log but don't throw to avoid blocking the pipeline
        const errMsg = err instanceof Error ? err.message : String(err);
        // Use safeWriteAuditLog (fire-and-forget, never throws)
        safeWriteAuditLog("session_state_error", {
          error: errMsg,
          operation: "updateMeta",
        }, "error");
        return undefined;
      }
    },

    /**
     * 192 Phase 1 (F04): strict, fail-closed dual commit with read-back
     * verification. Success is reported ONLY when the shared meta.json write
     * succeeded AND the read-back content carries the patched identity.
     */
    updateMetaVerified(patch: Partial<SessionMeta>, expected: MetaCommitExpectation): ReliableMetaCommitResult {
      const unavailable = (reason: string, err?: unknown): ReliableMetaCommitResult => {
        safeWriteAuditLog("session_state_strict", {
          operation: "updateMetaVerified",
          outcome: "unavailable",
          reason,
          ...(err !== undefined
            ? { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }
            : {}),
        }, "error");
        return { status: "unavailable", reason };
      };
      try {
        // Explicit shared-configuration check: no strict commit without it.
        if (!instanceBaseDir) {
          return unavailable("shared_not_configured");
        }
        const current = this.getMeta();
        if (!current) {
          return unavailable("no_current_state");
        }
        if (current.pipelineId !== expected.pipelineId) {
          safeWriteAuditLog("session_state_strict", {
            operation: "updateMetaVerified", outcome: "conflict", reason: "pipeline_mismatch",
          }, "warn");
          return { status: "conflict", reason: `pipeline_mismatch:${current.pipelineId ?? "none"}` };
        }

        // Shared health precheck. "missing" is tolerated (first strict write
        // creates the file); every other read problem is a health failure.
        const pre = readSharedRaw(instanceBaseDir, expected.pipelineId);
        if (pre.error === "read_failed") return unavailable("shared_read_failed");
        if (pre.error === "corrupt") return unavailable("shared_corrupt");
        if (pre.error === "foreign_pipeline") return unavailable("shared_pipeline_stale");

        // 193 Phase 2 (tasks 1-4): the protected sequence
        //   authoritative read → expectation compare → merge → publish → read-back
        // runs under the EXCLUSIVE per-pipeline commit lock. Acquisition is a
        // single non-spinning attempt; a competing holder is an honest
        // conflict, never something to wait out. Menus and RPC dispatches
        // never happen inside this critical section.
        const acq = tryAcquireMetaLock(instanceBaseDir, expected.pipelineId);
        if (acq.status === "busy") {
          safeWriteAuditLog("session_state_strict", {
            operation: "updateMetaVerified",
            outcome: "conflict",
            reason: "lock_busy",
            lockDir: acq.lockDir,
            ...(acq.owner
              ? {
                  lockPid: String(acq.owner.pid),
                  lockHost: acq.owner.host,
                  lockToken: acq.owner.token.slice(0, 8),
                  lockCreatedAt: String(acq.owner.createdAt),
                }
              : { lockOwner: "missing" }),
            guidance: "Residual locks are fail-closed: stop every writer for this pipeline, then remove this exact directory manually and resume.",
          }, "warn");
          return { status: "conflict", reason: "lock_busy" };
        }
        if (acq.status === "unavailable") {
          return unavailable(`lock_${acq.reason}`, acq.error);
        }

        try {
          // Expectation comparison against the authoritative snapshot RE-READ
          // inside the lock (shared when healthy; getMeta() result otherwise —
          // never used as shared-success proof, only as pre-write comparison).
          const pre2 = readSharedRaw(instanceBaseDir, expected.pipelineId);
          if (pre2.error === "read_failed") return unavailable("shared_read_failed");
          if (pre2.error === "corrupt") return unavailable("shared_corrupt");
          if (pre2.error === "foreign_pipeline") return unavailable("shared_pipeline_stale");
          const authoritative = pre2.meta ?? current;
          const conflictReason = matchCommitExpectation(authoritative, expected);
          if (conflictReason) {
            safeWriteAuditLog("session_state_strict", {
              operation: "updateMetaVerified", outcome: "conflict", reason: conflictReason,
            }, "warn");
            return { status: "conflict", reason: conflictReason };
          }

          // 193 Phase 2 (task 2): merge on the AUTHORITATIVE shared snapshot,
          // never on a stale local one (which could roll back a committed
          // human choice via an unrelated whole-object patch).
          const merged = { ...authoritative, ...patch };

          // 193 Phase 2 (task 4): every design-review state write inside the
          // lock gets a UNIQUE, monotonic revision: max(now, auth + 1). Two
          // writes within the same millisecond still produce distinct
          // revisions; callers must use the PERSISTED state we read back.
          if (merged.designReview) {
            merged.designReview = {
              ...merged.designReview,
              updatedAt: Math.max(Date.now(), (authoritative.designReview?.updatedAt ?? 0) + 1),
            };
          }

          // Write 1: local appendEntry must succeed.
          try {
            pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, merged);
          } catch (err) {
            return unavailable("local_append_failed", err);
          }

          // Write 2: shared meta.json must be published ATOMICALLY (temp file
          // + fsync + rename) and must succeed — NO fail-open here.
          const pub = publishSharedMeta(
            sharedPipelineDir(instanceBaseDir, expected.pipelineId),
            JSON.stringify(merged, null, 2),
          );
          if (!pub.ok) {
            // Stamp staleness best-effort for the ordinary fail-open reader,
            // but the strict caller never sees success from this path.
            try {
              pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, {
                ...merged, _sharedStale: true, _sharedStaleAt: Date.now(),
              });
            } catch { /* best-effort */ }
            return unavailable("shared_write_failed", pub.error);
          }

          // Read-back verification from SHARED storage. A local snapshot (even
          // after _sharedStale stripping) is never accepted as proof.
          const back = readSharedRaw(instanceBaseDir, expected.pipelineId);
          if (back.error || !back.meta) {
            return unavailable(`shared_readback_${back.error ?? "missing"}`);
          }
          const rb = back.meta;
          if (rb.pipelineId !== expected.pipelineId) {
            return unavailable("readback_pipeline_mismatch");
          }
          if (patch.designReview) {
            const want = patch.designReview;
            const got = rb.designReview;
            if (
              !got
              || got.authorizationId !== want.authorizationId
              || got.round !== want.round
              || got.phase !== want.phase
              || (want.operation?.operationId ?? undefined) !== (got.operation?.operationId ?? undefined)
            ) {
              return unavailable("readback_identity_mismatch");
            }
            // 193 Phase 2 (tasks 8/10): the human decision and the approval
            // basis are acted upon ONLY after EVERY field reads back intact.
            if (
              want.decision !== undefined
              && canonicalJson(got?.decision) !== canonicalJson(want.decision)
            ) {
              return unavailable("readback_decision_mismatch");
            }
            if (
              want.approval !== undefined
              && canonicalJson(got?.approval) !== canonicalJson(want.approval)
            ) {
              return unavailable("readback_approval_mismatch");
            }
          }

          // 194 Phase 0 (C3): the executor run is identity authority — it must
          // read back byte-for-byte (canonical key order) or the commit is not
          // a success. A stale whole-meta echo can therefore never "succeed"
          // while silently erasing or replacing a live run.
          if (
            patch.stageExecutorRun !== undefined
            && canonicalJson(rb.stageExecutorRun) !== canonicalJson(patch.stageExecutorRun)
          ) {
            return unavailable("readback_executor_run_mismatch");
          }

          return { status: "persisted", meta: rb };
        } finally {
          // Release ONLY with our own token; a failed release is fail-closed
          // (the lock stays) and audited — the holder must not proceed to any
          // further action it cannot confirm.
          const rel = releaseMetaLock(acq.lockDir, acq.token);
          if (!rel.ok) {
            safeWriteAuditLog("session_state_strict", {
              operation: "updateMetaVerified",
              outcome: "release_failed",
              reason: rel.reason,
              lockDir: acq.lockDir,
              ...(rel.error !== undefined ? { error: rel.error } : {}),
              guidance: "Lock intentionally left in place (fail-closed). Stop every writer for this pipeline, then remove this exact directory before resuming.",
            }, "error");
          }
        }
      } catch (err) {
        return unavailable("strict_commit_exception", err);
      }
    },

  };
}

/**
 * Extract assistant messages from the current session branch.
 *
 * Scans ctx.sessionManager.getBranch() for message entries where
 * message.role === "assistant", extracting text content from each.
 *
 * Content extraction:
 * - string content → used directly
 * - array content → concatenates parts where type === "text"
 */
export function extractAssistantMessages(ctx: ExtensionContext): string[] {
  try {
    const entries = ctx.sessionManager.getBranch();
    const messages: string[] = [];

    for (const entry of entries) {
      if (entry.type !== "message") continue;

      const msgEntry = entry as { type: "message"; message: { role: string; content?: unknown } };
      if (msgEntry.message.role !== "assistant") continue;

      const content = msgEntry.message.content;
      if (typeof content === "string") {
        messages.push(content);
      } else if (Array.isArray(content)) {
        const textParts = content
          .filter((part: { type?: string }) => part.type === "text")
          .map((part: { text?: string }) => part.text ?? "");
        if (textParts.length > 0) {
          messages.push(textParts.join(""));
        }
      }
    }

    return messages;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeWriteAuditLog("session_state_error", { operation: "extractAssistantMessages", error: errMsg }, "error");
    return [];
  }
}

/**
 * Session interface accepted by strict design-review commits.
 * `updateMetaVerified` is provided by the real adapter (createSessionState)
 * and by compatible test fixtures; adapters without it are reported
 * `unavailable` — never a fake success.
 */
export interface StrictCommitSession {
  getMeta(): SessionMeta | undefined;
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
  updateMetaVerified?(patch: Partial<SessionMeta>, expected: MetaCommitExpectation): ReliableMetaCommitResult;
}

/**
 * Phase 2 (191) + 192 Phase 1: Commit result for design review state.
 */
export type DesignReviewCommitResult =
  | { ok: true; state: DesignReviewState }
  | {
      ok: false;
      reason: "no_meta" | "write_failed" | "verification_failed" | "conflict" | "unavailable";
      detail?: string;
    };

/**
 * 192 Phase 1 (F04): Reliably commits design review state via the STRICT
 * dual-write path (see SessionState.updateMetaVerified).
 *
 * Guarantees:
 * - Authorization identity guards (same auth, no round regression)
 * - Caller-supplied expectation (pipeline/auth/round/operation/phase/revision)
 *   is compared against the current persisted state BEFORE writing
 * - Local appendEntry AND shared meta.json write AND shared read-back must
 *   all succeed; a local-only snapshot is never reported as committed
 * - Adapters without the strict interface yield "unavailable" (fail-closed)
 *
 * @param session - Strict-commit-capable session (or legacy adapter)
 * @param state - Design review state to commit
 * @param expected - Optional explicit expectation; defaults to "current state
 *   unchanged since this read" (single-writer revision anchor)
 */
export function commitDesignReviewState(
  session: StrictCommitSession,
  state: DesignReviewState,
  expected?: MetaCommitExpectation,
): DesignReviewCommitResult {
  // Read current meta
  const meta = session.getMeta();
  if (!meta) {
    safeWriteAuditLog("design_review_commit", {
      reason: "no_meta",
    }, "error");
    return { ok: false, reason: "no_meta" };
  }

  // Structural conflict guards (kept from 191): authorization switch and
  // round regression are always conflicts, independent of `expected`.
  const currentDR = meta.designReview;
  if (currentDR) {
    if (currentDR.authorizationId !== state.authorizationId) {
      safeWriteAuditLog("design_review_commit", {
        reason: "authorization_conflict",
        currentAuthId: currentDR.authorizationId,
        newAuthId: state.authorizationId,
      }, "warn");
      return { ok: false, reason: "conflict" };
    }
    if (state.round < currentDR.round) {
      safeWriteAuditLog("design_review_commit", {
        reason: "round_regression",
        currentRound: String(currentDR.round),
        newRound: String(state.round),
      }, "warn");
      return { ok: false, reason: "conflict" };
    }
  }

  const exp = expected ?? expectedFromCurrent(meta);
  const res = strictCommitMeta(session, { designReview: state }, exp);

  if (res.status === "persisted") {
    safeWriteAuditLog("design_review_commit", {
      action: "committed",
      phase: state.phase,
      round: String(state.round),
      operationId: state.operation?.operationId || "none",
    });
    return { ok: true, state: res.meta.designReview ?? state };
  }
  if (res.status === "conflict") {
    safeWriteAuditLog("design_review_commit", {
      reason: "expected_conflict",
      detail: res.reason,
    }, "warn");
    return { ok: false, reason: "conflict", detail: res.reason };
  }
  safeWriteAuditLog("design_review_commit", {
    reason: "strict_unavailable",
    detail: res.reason,
    phase: state.phase,
  }, "error");
  return { ok: false, reason: "unavailable", detail: res.reason };
}

/**
 * Phase 5 (170): Health status of the last assistant run.
 *
 * - "truncated": The last assistant message was cut off by the model's output
 *   token limit (stopReason === "length"). The agent likely needs to retry in
 *   smaller chunks.
 * - "failed_transient": The last run ended with an error or was aborted
 *   (stopReason in ["error", "aborted"]) with an errorMessage present.
 * - "clean": Normal completion or no assistant messages yet.
 */
export type RunHealthKind = "truncated" | "failed_transient" | "clean";

/**
 * Phase 5 (170): Result of the last-run health check.
 */
export interface RunHealthResult {
  kind: RunHealthKind;
  /** ID of the last assistant message (for dedup in audit) */
  messageId?: string;
}

/**
 * Phase 5 (170): Extract metadata from the last assistant message in the branch.
 *
 * Returns `stopReason`, `errorMessage`, and the message `id` from the last
 * assistant message (if any). This is a parallel structure to
 * `extractAssistantMessages` that exposes per-message metadata without changing
 * the existing string[] signature.
 *
 * The higher-level `detectLastRunHealth` consumes this data to classify the
 * run into truncated/failed_transient/clean.
 *
 * Fail-open: returns null on any extraction error.
 *
 * @param ctx - Extension context with session manager
 * @returns Object with stopReason/errorMessage/messageId, or null if no assistant message found
 */
export function extractLastAssistantMeta(ctx: ExtensionContext): {
  stopReason?: string;
  errorMessage?: string;
  messageId?: string;
} | null {
  try {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message") continue;

      const msgEntry = entry as {
        type: "message";
        id?: string;
        message: { role: string; stopReason?: string; errorMessage?: string };
      };
      if (msgEntry.message.role !== "assistant") continue;

      return {
        stopReason: msgEntry.message.stopReason,
        errorMessage: msgEntry.message.errorMessage,
        messageId: msgEntry.id,
      };
    }
    return null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeWriteAuditLog("session_state_error", { operation: "extractLastAssistantMeta", error: errMsg }, "error");
    return null;
  }
}

/**
 * Phase 5 (170): Detects the health status of the last assistant run.
 *
 * Consumes `extractLastAssistantMeta` as the single scan implementation (DRY).
 * Classifies the run into truncated/failed_transient/clean based on the
 * `stopReason` field (when available from the SDK).
 *
 * This is a single shared implementation consumed by both agent_settled (audit)
 * and prompt_injector (next-turn warning injection) — DRY principle.
 *
 * Fail-open: returns "clean" on any extraction error.
 *
 * @param ctx - Extension context with session manager
 * @returns RunHealthResult with kind and optional messageId
 */
export function detectLastRunHealth(ctx: ExtensionContext): RunHealthResult {
  const meta = extractLastAssistantMeta(ctx);

  if (!meta) {
    return { kind: "clean" };
  }

  if (meta.stopReason === "length") {
    return { kind: "truncated", messageId: meta.messageId };
  }

  if (
    (meta.stopReason === "error" || meta.stopReason === "aborted") &&
    meta.errorMessage
  ) {
    return { kind: "failed_transient", messageId: meta.messageId };
  }

  return { kind: "clean", messageId: meta.messageId };
}

/**
 * Extract the text content of the first user-role message from the session branch.
 *
 * Used by Phase 1 (170) JOIN auto-bind to parse requirement doc paths from the
 * subagent's first user message (which typically contains the @mention prompt
 * including the document path).
 *
 * Content extraction mirrors extractAssistantMessages:
 * - string content → used directly
 * - array content → concatenates parts where type === "text"
 *
 * Returns empty string when no user message is found or on extraction failure.
 */
export function extractFirstUserMessageText(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager.getBranch();

    for (const entry of entries) {
      if (entry.type !== "message") continue;

      const msgEntry = entry as { type: "message"; message: { role: string; content?: unknown } };
      if (msgEntry.message.role !== "user") continue;

      const content = msgEntry.message.content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        const textParts = content
          .filter((part: { type?: string }) => part.type === "text")
          .map((part: { text?: string }) => part.text ?? "");
        if (textParts.length > 0) {
          return textParts.join("");
        }
      }
    }

    return "";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeWriteAuditLog("session_state_error", { operation: "extractFirstUserMessageText", error: errMsg }, "error");
    return "";
  }
}

/**
 * Extracts the text content of the LAST user message in the session branch.
 * Mirrors extractFirstUserMessageText traversal but iterates in reverse.
 * Used by Phase 2 (172) agent_settled gate to determine whether the current
 * settle turn originates from a pipeline-orchestrated interaction.
 *
 * Handles:
 * - string content → returned as-is
 * - array content → concatenates parts where type === "text"
 *
 * Returns empty string when no user message is found or on extraction failure.
 */
export function extractLastUserMessageText(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager.getBranch();

    // Iterate in reverse to find the last user message
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message") continue;

      const msgEntry = entry as { type: "message"; message: { role: string; content?: unknown } };
      if (msgEntry.message.role !== "user") continue;

      const content = msgEntry.message.content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        const textParts = content
          .filter((part: { type?: string }) => part.type === "text")
          .map((part: { text?: string }) => part.text ?? "");
        if (textParts.length > 0) {
          return textParts.join("");
        }
      }
    }

    return "";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeWriteAuditLog("session_state_error", { operation: "extractLastUserMessageText", error: errMsg }, "error");
    return "";
  }
}

/**
 * A single tool call record extracted from the session branch.
 * Used by selfVerifySkip to determine whether the model has already
 * successfully executed a given command during the current stage.
 */
export interface ToolCallRecord {
  /** Tool name (e.g. "bash", "write", "edit") */
  name: string;
  /** For bash: the full command string. For write/edit: the file path. */
  command?: string;
  /** For bash: the exit code (0 = success). Undefined if result not yet received. */
  exitCode?: number;
  /** For write/edit: whether the operation succeeded */
  success?: boolean;
  /** Unix timestamp (ms) when the call was recorded */
  ts: number;
}

/**
 * Extracts all tool call records from the current session branch.
 * Scans for tool_call + tool_result pairs, pairing them to capture
 * the execution outcome (exit code, success flag).
 *
 * @param ctx - Extension context with session manager
 * @returns Chronologically ordered array of tool call records
 */
export function extractToolCallRecords(ctx: ExtensionContext): ToolCallRecord[] {
  try {
    const entries = ctx.sessionManager.getBranch();
    const records: ToolCallRecord[] = [];

    // Index pending tool_call entries by their callId for result pairing
    const pendingCalls = new Map<string, { index: number; record: ToolCallRecord }>();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type !== "message") continue;

      const msgEntry = entry as {
        type: "message";
        message: {
          role: string;
          content?: unknown;
          toolCallId?: string;
          toolName?: string;
        };
      };
      const msg = msgEntry.message;

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Look for tool_use content blocks
        for (const block of msg.content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
          if (block?.type === "tool_use" && block.id && block.name) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            // Use real timestamp from entry metadata if available;
            // fall back to Date.now() for consistent unit with stageStartTime.
            const entryAny = entry as unknown as { timestamp?: unknown; createdAt?: unknown };
            const ts = typeof entryAny.timestamp === "number"
              ? entryAny.timestamp
              : (typeof entryAny.createdAt === "number" ? entryAny.createdAt : Date.now());
            let command: string | undefined;
            if (block.name === "bash") {
              command = typeof input.command === "string" ? input.command : undefined;
            } else if (block.name === "write" || block.name === "edit") {
              command = typeof input.filePath === "string" ? input.filePath : (typeof input.file_path === "string" ? input.file_path : undefined);
            }
            const record: ToolCallRecord = {
              name: block.name,
              command,
              ts,
            };
            pendingCalls.set(block.id, { index: i, record });
          }
        }
      } else if (msg.role === "user" && msg.toolCallId) {
        // Tool result — pair with pending call
        const pending = pendingCalls.get(msg.toolCallId);
        if (pending) {
          const content = msg.content;
          // Detect exit code from tool result content
          if (pending.record.name === "bash") {
            // bash tool results typically contain exit code info
            const text = typeof content === "string" ? content :
              (Array.isArray(content) ? content.map(p => typeof p === "object" && p && "text" in p ? (p as { text?: string }).text : "").join("") : "");
            const exitMatch = text.match(/exit code[:\s]+(-?\d+)/i) || text.match(/exitCode[:\s]+(-?\d+)/i);
            if (exitMatch) {
              pending.record.exitCode = parseInt(exitMatch[1], 10);
            }
            // When exitCode cannot be parsed, leave it undefined.
            // command-verifier's trySelfVerifySkip conservatively skips records with
            // undefined exitCode (does NOT treat as success), preventing false positives.
          } else if (pending.record.name === "write" || pending.record.name === "edit") {
            // Write/edit success: no error in result content
            const text = typeof content === "string" ? content :
              (Array.isArray(content) ? content.map(p => typeof p === "object" && p && "text" in p ? (p as { text?: string }).text : "").join("") : "");
            pending.record.success = !text.toLowerCase().includes("error") && !text.toLowerCase().includes("failed");
          }
          records.push(pending.record);
          pendingCalls.delete(msg.toolCallId);
        }
      }
    }

    return records.sort((a, b) => a.ts - b.ts);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeWriteAuditLog("session_state_error", { operation: "extractToolCallRecords", error: errMsg }, "error");
    return [];
  }
}
