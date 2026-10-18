/**
 * @module stage-executor/lifecycle-access
 * 194 Phase 3 (C4, task 1): ONE small policy module that orders the
 * design-review lifecycle permission checks for every mutating tool entry:
 *
 *   runtime identity  →  dynamic write scope  →  stage/global protect chain
 *
 * The meta-driven scope half is the existing `design-review/write-policy`
 * (single source of the EXACT writable list, shared with the prompt). This
 * module adds the half the meta cannot prove on its own — WHO is calling:
 * a child session that recorded its own executor binding
 * (`pi-pipeline:executor-binding`, runtime-binding.ts) is compared against
 * the owner's CURRENT run. A stale or unverifiable closed-loop child never
 * inherits the current operation's permissions, not even its scoped files,
 * and never reopens the finished-cycle artifact guard either.
 *
 * Finished-release rules (C4 matrix, last two rows):
 * - the write policy releases `finished` to the ordinary chain ONLY with the
 *   current develop-handoff's trusted success receipt (see write-policy);
 * - a released loop keeps its artifacts read-only: the plan, every round's
 *   design-review report of that plan (new `Design_Review_*` or legacy
 *   `review-design-*` names), and every `Design_Review_Update_*` receipt
 *   of that plan (plus the bounded consumed-report receipt). A legitimate
 *   `{reqBase}_Develop_Commit.md` matches none of these patterns and stays
 *   writable through the normal stage chain.
 */

import * as path from "node:path";
import { reqBaseFromPlanStem } from "../naming/doc-naming";
import type { DesignReviewState, SessionMeta } from "../../types";
import type { RuntimeCtx } from "../runtime-ctx";
import { toProjectRelative } from "../../utils/protect";
import {
  readOwnExecutorBinding,
  resolveExecutorCallerRole,
  type BindingEntryLike,
  type ExecutorCallerRole,
} from "./runtime-binding";
import type { StageExecutorBinding } from "./contracts";
import {
  resolveDesignReviewWritePolicy,
  type DesignReviewWritePolicy,
} from "../design-review/write-policy";

/** No-writable constant shared with the refusal payloads below. */
const NO_WRITABLE: readonly string[] = Object.freeze([]);

/** Runtime evidence a guard entry point can prove about its own caller. */
export interface LifecycleRuntimeEvidence {
  /** Whether the calling session is a child/subagent session. */
  readonly isChild: boolean;
  /** The caller's OWN session file from runtime evidence (never a snapshot). */
  readonly callerSessionFile: string | null;
  /** The caller's own recorded executor binding (null = not a proven executor). */
  readonly ownBinding: StageExecutorBinding | null;
}

/** Resolved lifecycle access for one mutating entry (C4 order applied). */
export interface LifecycleWriteAccess {
  /**
   * The governing write policy AFTER the identity overlay: a stale/unknown
   * closed-loop child yields `blocked` regardless of what meta would allow.
   */
  readonly policy: DesignReviewWritePolicy;
  /** Caller role from runtime evidence; "none" = no recorded binding to judge. */
  readonly callerRole: ExecutorCallerRole | "none";
}

/**
 * Read THIS session's own executor-binding entry from the runtime session
 * manager. Absent entries (or an unavailable manager) are not an error —
 * they simply mean the caller is not a PROVEN closed-loop executor, and the
 * meta-driven policy alone governs. A swallowed read failure stays fail-open
 * in that sense only: it cannot fabricate identity for a stale child either.
 */
export function readSelfExecutorBinding(ctx: RuntimeCtx): StageExecutorBinding | null {
  try {
    const sm = ((ctx._ctx as unknown) as Record<string, unknown> | undefined)?.sessionManager as
      | { getEntries?: () => readonly BindingEntryLike[] }
      | undefined;
    const entries = sm?.getEntries?.();
    if (!entries) return null;
    return readOwnExecutorBinding(entries);
  } catch {
    return null;
  }
}

/**
 * Collect the runtime identity evidence available at a tool entry point.
 * The session entries are only read when a design-review loop could actually
 * govern writes (avoids a per-call entry scan for ordinary pipeline work).
 */
export function collectLifecycleEvidence(
  ctx: RuntimeCtx,
  meta: SessionMeta | undefined,
  isChild: boolean,
): LifecycleRuntimeEvidence {
  const callerSessionFile = readSelfSessionFile(ctx);
  if (!meta?.designReview) {
    return { isChild, callerSessionFile, ownBinding: null };
  }
  return { isChild, callerSessionFile, ownBinding: readSelfExecutorBinding(ctx) };
}

/**
 * Resolve the C4 lifecycle write access for one mutating call.
 *
 * Identity overlay applies to CHILDREN that recorded their own executor
 * binding — the only population whose permissions could be inherited from an
 * older run. Owner sessions and children without a recorded binding keep the
 * meta-driven policy (their identity is not claimable as a closed-loop
 * executor at this layer).
 */
export function resolveLifecycleWriteAccess(
  meta: SessionMeta | undefined,
  evidence: LifecycleRuntimeEvidence,
): LifecycleWriteAccess {
  const policy = resolveDesignReviewWritePolicy(meta);
  if (!evidence.isChild || evidence.ownBinding === null) {
    return { policy, callerRole: "none" };
  }

  const role = resolveExecutorCallerRole({
    currentRun: meta?.stageExecutorRun,
    callerSessionFile: evidence.callerSessionFile,
    callerIsChild: true,
    ownBinding: evidence.ownBinding,
  });
  if (role === "child-stale") {
    return {
      policy: {
        mode: "blocked",
        writable: NO_WRITABLE,
        reason: "executor_identity_stale",
      },
      callerRole: role,
    };
  }
  if (role === "unknown") {
    // A recorded closed-loop binding with nothing to compare it against (or a
    // contradictory session file) is NOT identity: fail closed, per C3.
    return {
      policy: {
        mode: "blocked",
        writable: NO_WRITABLE,
        reason: "executor_identity_unknown",
      },
      callerRole: role,
    };
  }
  return { policy, callerRole: role };
}

/** Escape a literal string for embedding in a RegExp (shared idiom). */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The caller's OWN session file from runtime evidence: `RuntimeCtx.selfSessionFile`
 * (set by the bridge in production), falling back to the session manager read —
 * the exact same source the bridge itself uses. Never from a meta snapshot.
 */
function readSelfSessionFile(ctx: RuntimeCtx): string | null {
  if (typeof ctx.selfSessionFile === "string" && ctx.selfSessionFile.length > 0) {
    return ctx.selfSessionFile;
  }
  try {
    const sm = ((ctx._ctx as unknown) as Record<string, unknown> | undefined)?.sessionManager as
      | { getSessionFile?: () => string }
      | undefined;
    const file = sm?.getSessionFile?.();
    return typeof file === "string" && file.length > 0 ? file : null;
  } catch {
    return null;
  }
}

/**
 * True when `absPath` targets a document of the FINISHED design-review cycle
 * that must stay read-only after the release (C4: "plan and review artifacts
 * read-only", "development must not overwrite the current report, that plan's
 * design-review report files or known receipts").
 *
 * Matching is bounded to the cycle's own identity: exact pinned paths first,
 * then the plan-directory's derived report/receipt file-name patterns — no
 * globs beyond those two shapes, so an unrelated `{reqBase}_Develop_Commit.md`
 * or any source file never matches.
 */
export function isFinishedReleaseProtectedPath(
  projectRoot: string,
  absPath: string,
  state: DesignReviewState,
): boolean {
  const canonical = path.resolve(absPath);

  // Exact pinned documents of the cycle (work even when the plan lives
  // outside the project root — canonical equality still applies).
  const exact = [
    state.planDoc,
    state.reportDoc,
    state.reviewInputReceipt?.reportDoc,
    state.operation?.updateArtifact?.receiptDoc,
  ];
  if (exact.some((candidate) => typeof candidate === "string" && candidate.length > 0 && path.resolve(candidate) === canonical)) {
    return true;
  }

  const rel = toProjectRelative(projectRoot, canonical);
  if (rel === null) return false;
  const planRel = toProjectRelative(projectRoot, state.planDoc);
  if (planRel === null) return false;
  // Derived documents live DIRECTLY beside the plan, never in sibling dirs.
  if (path.dirname(rel) !== path.dirname(planRel)) return false;

  const name = path.basename(rel);
  // Every round's review report of THIS plan (dual read, 201 Phase 4):
  // new `Design_Review_{round}_{reqBase}_Design.md` and legacy
  // `review-design-{round}-{planBasename}`.
  const reqBase = reqBaseFromPlanStem(path.parse(state.planDoc).name);
  const reportPattern = new RegExp(
    `(?:^review-design-\\d+-${escapeRegex(path.basename(state.planDoc))}$)` +
      `|(?:^Design_Review_\\d+_${escapeRegex(reqBase)}_Design\\.md$)`,
  );
  if (reportPattern.test(name)) return true;
  // Every standalone update receipt of THIS plan (hard switch, 201 Phase 4):
  // `Design_Review_Update_{round}_{operationId(36)}_{reqBase}_Design.md`
  const receiptPattern = new RegExp(
    `^Design_Review_Update_\\d+_[0-9a-f-]{36}_.+_Design\\.md$`,
  );
  return receiptPattern.test(name);
}

/** Convenience: finished-release active on the given access decision. */
export function isFinishedReleaseActive(access: LifecycleWriteAccess): boolean {
  return access.policy.mode === "ordinary" && access.policy.finishedRelease === true;
}
