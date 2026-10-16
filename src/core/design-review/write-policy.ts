/**
 * @module design-review/write-policy
 * 194 Phase 1 (C4): ONE place that answers "what may this run write RIGHT NOW".
 *
 * Before 194 the writable set was re-derived independently by the bash guard,
 * the write/edit guard and the prompt guidance, each from a slightly different
 * slice of state (kind + planDoc + reportDoc). That is how the update receipt
 * could be validated while the guard still refused to let the executor create
 * it. The policy below is the single source of the EXACT path list; guards and
 * prompt text consume it, and nothing widens it from config directories.
 *
 * Modes:
 * - `ordinary` — no design-review loop governs this session: the original
 *   stage-whitelist / global-protect chain applies unchanged.
 * - `scoped`   — an authorized operation is running: ONLY the exact absolute
 *   paths in `writable` may be written (review: current report; update: the
 *   original plan plus, for a 194 standalone output, exactly its own receipt
 *   document). Everything else — requirement docs, source code, other rounds'
 *   reports, other operations' receipts — stays read-only.
 * - `readonly` — the loop is paused waiting for the owner (human decision or
 *   executor recovery): no write is advertised, and the prompt must not
 *   advertise a writable report. One narrow exception (200 Bug Phase 3,
 *   G3-1/G3-2): during a NON-decision pause the current review operation's
 *   already-bound reportDoc stays editable through a `scoped` grant exactly
 *   like a live review round — see `isPausedReportEditable`. Decision-anchor
 *   windows (`decision-pending` / `new-decision`) keep the full freeze.
 * - `blocked`  — the governing identity cannot be proven (incomplete state or
 *   an unprovable output binding): fail closed, never inherit a newer
 *   executor's permissions.
 */

import * as path from "node:path";
import type {
  DesignReviewOperationKind,
  DesignReviewPhase,
  DesignReviewState,
  PipelineConfig,
  PipelineStage,
  SessionMeta,
  StageConfig,
} from "../../types";
import { hasCompleteDesignReviewIdentity } from "./state";
import { narrowUpdateArtifact } from "./update-artifact";
import {
  isHardcodedProtected,
  isPathReadOnly,
  isPathProtectedForModify,
  buildProtectedPaths,
  toProjectRelative,
  type ProtectState,
} from "../../utils/protect";

/** Lifecycle write mode for the current session. */
export type DesignReviewWriteMode = "ordinary" | "scoped" | "readonly" | "blocked";

/** Resolved write policy for the current design-review context. */
export interface DesignReviewWritePolicy {
  /** What governs writes right now. */
  mode: DesignReviewWriteMode;
  /** Operation kind that produced `writable` (absent for `ordinary`). */
  operationKind?: DesignReviewOperationKind;
  /** Design-review phase at resolution time. */
  phase?: DesignReviewPhase;
  /**
   * EXACT absolute paths that may be written. Non-empty only in `scoped`
   * mode; `readonly`/`blocked` always carry an empty list.
   */
  writable: readonly string[];
  /** Machine-readable explanation when writes are narrowed or refused. */
  reason?: string;
  /**
   * 194 Phase 3 (C4): true when `finished` released the loop BACK to the
   * ordinary stage/global protect chain — and only after the current
   * develop-handoff's trusted success receipt was proven. A released loop
   * still keeps its cycle artifacts (plan, review reports, update receipts)
   * read-only; consumers must never widen this back to unrestricted writes.
   */
  finishedRelease?: boolean;
}

const NO_WRITABLE: readonly string[] = Object.freeze([]);

/** Ordinary flow: the design-review loop does not govern this session. */
function ordinary(): DesignReviewWritePolicy {
  return { mode: "ordinary", writable: NO_WRITABLE };
}

/**
 * 194 Phase 3 (C4): the `finished` lifecycle row of the permission matrix.
 *
 * A finished loop releases writes back to the ordinary stage/global protect
 * chain ONLY when the current develop-handoff carries its trusted success
 * receipt (`dispatchState=completed` + `dispatchEvidence=trusted_id` + a real
 * agentId — the exact shape `finishCurrentHandoffReliably` commits). Anything
 * else claiming `finished` (receipt insufficient, evidence never trusted, or
 * an identity that cannot be proven) stays fail-closed: a phase label alone
 * must never open develop writes. Legacy finished records (pre-192 loops with
 * a review/update operation, or none) release with the artifact guard,
 * matching the 191-compat `classifyDesignReviewFlow` terminal behavior.
 */
function resolveFinishedRelease(state: DesignReviewState): DesignReviewWritePolicy {
  const operation = state.operation;
  const operationKind = operation?.kind;

  // C4: an unprovable identity cannot even claim a finished release.
  if (!hasCompleteDesignReviewIdentity(state)) {
    return {
      mode: "blocked",
      ...(operationKind !== undefined ? { operationKind } : {}),
      phase: "finished",
      writable: NO_WRITABLE,
      reason: "design_review_identity_incomplete",
    };
  }

  if (operation && operation.kind === "develop-handoff") {
    const trustedReceipt =
      operation.dispatchState === "completed"
      && operation.dispatchEvidence === "trusted_id"
      && typeof operation.agentId === "string"
      && operation.agentId.length > 0;
    if (!trustedReceipt) {
      return {
        mode: "blocked",
        operationKind: operation.kind,
        phase: "finished",
        writable: NO_WRITABLE,
        reason: "finished_release_unproven",
      };
    }
    return {
      mode: "ordinary",
      finishedRelease: true,
      operationKind: operation.kind,
      phase: "finished",
      writable: NO_WRITABLE,
    };
  }

  // Legacy finished record: released, with the cycle artifacts still
  // read-only (enforced by stage-executor/lifecycle-access).
  return {
    mode: "ordinary",
    finishedRelease: true,
    ...(operationKind !== undefined ? { operationKind } : {}),
    phase: "finished",
    writable: NO_WRITABLE,
  };
}

/**
 * 200 Bug Phase 3 (G3-2): the two pause reasons that mark a HUMAN decision
 * anchor window. During these the owner is reading the report the pending
 * decision is hash-anchored against, so the model must not rewrite it — the
 * decision basis would move silently under the reader. Every other pause
 * reason is a recovery state where persisting the current report is exactly
 * what unblocks the loop.
 */
const DECISION_ANCHOR_PAUSE_REASONS: ReadonlySet<string> = new Set([
  "decision-pending",
  "new-decision",
]);

/**
 * 200 Bug Phase 3 (G3-1/G3-2): may a paused loop still edit its OWN current
 * review report?
 *
 * True only when: the loop is `paused`, the current operation is a bound
 * `review`, its `reportDoc` is a non-empty string, and the pause reason is
 * NOT a decision-anchor window. A legacy record without `pauseReason` counts
 * as editable (consistent with the `paused` reason-rendering fallback).
 * `update` receipts / planDoc and the fail-closed unbound-report contract are
 * untouched: the predicate simply never fires for them.
 *
 * Phase 4 reuses this as the single source of truth for the lazy decision
 * reportHash re-anchor guard.
 */
export function isPausedReportEditable(state: DesignReviewState): boolean {
  if (state.phase !== "paused") return false;
  const operation = state.operation;
  if (!operation || operation.kind !== "review") return false;
  const report = state.reportDoc;
  if (typeof report !== "string" || report.length === 0) return false;
  // Undefined reason (historical records) behaves like the rendered "paused".
  if (
    state.pauseReason !== undefined &&
    DECISION_ANCHOR_PAUSE_REASONS.has(state.pauseReason)
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve the write policy from persisted meta ONLY.
 *
 * The standalone receipt path comes from the operation's pinned descriptor
 * (`narrowUpdateArtifact`), never from a directory scan, a tool argument or an
 * override path, so a revision attempt cannot authorize an arbitrary file by
 * naming it.
 */
export function resolveDesignReviewWritePolicy(
  meta: SessionMeta | undefined,
): DesignReviewWritePolicy {
  const state = meta?.designReview;
  if (!state) return ordinary();

  // 194 Phase 3 (C4): `finished` is a CONDITIONAL release, evaluated before
  // the no-operation shortcut so a finished record is never treated as if no
  // loop had ever governed this session.
  if (state.phase === "finished") {
    return resolveFinishedRelease(state);
  }

  const operation = state.operation;
  // No current operation: nothing is executing under this loop, so the
  // original permission chain governs (the pending-decision read-only window
  // is enforced separately by decision-guard).
  if (!operation) return ordinary();

  // Phase is read BEFORE the identity predicate below, which narrows the state
  // type to `never` in its negative branch (DesignReviewState already satisfies
  // it); the captured value stays usable for audit fields.
  const phase = state.phase;

  // C4: an identity that cannot be proven must NOT inherit permissions.
  if (!hasCompleteDesignReviewIdentity(state)) {
    return {
      mode: "blocked",
      operationKind: operation.kind,
      phase,
      writable: NO_WRITABLE,
      reason: "design_review_identity_incomplete",
    };
  }

  // C4: a paused loop waits for the owner; no automatic write is advertised
  // — except the bound current review report during a non-decision pause
  // (200 Bug Phase 3, G3-1/G3-2): the executor must be able to persist its
  // report while the owner arranges recovery. Decision-anchor windows stay
  // frozen so the human reads exactly the content a decision hashes against.
  if (state.phase === "paused") {
    if (isPausedReportEditable(state) && operation.kind === "review") {
      const report = state.reportDoc;
      if (typeof report === "string" && report.length > 0) {
        return {
          mode: "scoped",
          operationKind: operation.kind,
          phase,
          writable: Object.freeze([path.resolve(report)]),
        };
      }
    }
    return {
      mode: "readonly",
      operationKind: operation.kind,
      phase,
      writable: NO_WRITABLE,
      reason: state.pauseReason ? `paused:${state.pauseReason}` : "paused",
    };
  }

  if (operation.kind === "review") {
    const report = state.reportDoc;
    if (typeof report !== "string" || report.length === 0) {
      // The report path is not bound yet: nothing is writable (fail closed).
      return {
        mode: "scoped",
        operationKind: operation.kind,
        phase,
        writable: NO_WRITABLE,
        reason: "review_report_path_unbound",
      };
    }
    return {
      mode: "scoped",
      operationKind: operation.kind,
      phase,
      writable: Object.freeze([path.resolve(report)]),
    };
  }

  if (operation.kind === "update") {
    const output = narrowUpdateArtifact(
      operation.updateArtifact,
      state.planDoc,
      state.round,
      operation.operationId,
    );
    if (!output.ok) {
      // C1: a malformed / foreign descriptor is a hard block, never a silent
      // downgrade to the legacy embedded-section contract.
      return {
        mode: "blocked",
        operationKind: operation.kind,
        phase,
        writable: NO_WRITABLE,
        reason: `update_output_unprovable:${output.reason}`,
      };
    }
    if (output.kind === "legacy") {
      // Pre-194 operation: the plan body carries the receipt section (192).
      return {
        mode: "scoped",
        operationKind: operation.kind,
        phase,
        writable: Object.freeze([path.resolve(state.planDoc)]),
      };
    }
    return {
      mode: "scoped",
      operationKind: operation.kind,
      phase,
      writable: Object.freeze([path.resolve(state.planDoc), path.resolve(output.receiptDoc)]),
    };
  }

  // develop-handoff: the transition is plugin-owned; the model writes nothing.
  return {
    mode: "scoped",
    operationKind: operation.kind,
    phase: state.phase,
    writable: NO_WRITABLE,
    reason: "handoff_is_plugin_owned",
  };
}

/**
 * Exact-path membership test for guards.
 *
 * Both the lexical operand and the symlink-resolved target must pass (the
 * caller checks each separately, as 192 issue 4 established); matching is
 * canonical string equality against `policy.writable` — no prefixes, no globs,
 * no directory grants, so a scoped file can never smuggle in its siblings.
 */
export function isPathWithinWriteScope(
  policy: DesignReviewWritePolicy,
  projectRoot: string,
  absPath: string,
): boolean {
  if (policy.mode !== "scoped") return false;
  if (policy.writable.length === 0) return false;
  const rel = toProjectRelative(projectRoot, absPath);
  if (rel === null) return false; // outside the project root — fail closed
  const canonical = path.resolve(absPath);
  return policy.writable.some((candidate) => candidate === canonical);
}

/** A deliverable the declared scope cannot actually be written under. */
export interface WriteScopeConflict {
  /** Absolute path of the offending deliverable. */
  absPath: string;
  /** Project-relative form (null when outside the root). */
  relPath: string | null;
  /** Machine-readable conflict class. */
  reason: "outside_project_root" | "hardcoded_protected" | "gitignore_protected" | "stage_read_only";
}

/**
 * Pre-dispatch conflict probe (C4 / Phase 1 task 5).
 *
 * A scoped deliverable that the protection chain refuses — protected by
 * hardcoded/gitignore rules, marked read-only by the stage, or living outside
 * the project root — must block the dispatch BEFORE any visit or RPC is
 * recorded, instead of dispatching an executor that is guaranteed to fail its
 * own deliverable. The probe NEVER widens authorization: it only reports
 * conflicts for paths the policy already declares writable.
 *
 * @param config - Pipeline config (protection inputs)
 * @param stage - Stage whose write guidance is being prepared (update = "plan")
 * @param projectRoot - Canonical project root
 * @param scopePaths - Exact paths the policy declares writable
 * @param protectState - Protection state from the caller (gitignore included
 *   when available; null-safe by design)
 */
export function findWriteScopeConflicts(
  config: PipelineConfig,
  stage: PipelineStage,
  projectRoot: string,
  scopePaths: readonly string[],
  protectState: ProtectState | null,
): WriteScopeConflict[] {
  const stageConfig: StageConfig | undefined = config.stages?.[stage];
  const hardcoded = buildProtectedPaths(config);
  const conflicts: WriteScopeConflict[] = [];

  for (const absPath of scopePaths) {
    const relPath = toProjectRelative(projectRoot, absPath);
    if (relPath === null) {
      conflicts.push({ absPath, relPath: null, reason: "outside_project_root" });
      continue;
    }
    // Hardcoded protection (.pi/.git/user paths) can never be exempted.
    if (isHardcodedProtected(relPath, hardcoded)) {
      conflicts.push({ absPath, relPath, reason: "hardcoded_protected" });
      continue;
    }
    if (protectState !== null && isPathProtectedForModify(relPath, protectState)) {
      conflicts.push({ absPath, relPath, reason: "gitignore_protected" });
      continue;
    }
    if (stageConfig !== undefined && isPathReadOnly(relPath, stageConfig.allowedReadOnlyPaths)) {
      conflicts.push({ absPath, relPath, reason: "stage_read_only" });
    }
  }
  return conflicts;
}

/**
 * Human/prompt-readable rendering of the scope, shared by the injected prompt
 * and guard messages so the model is never told one thing the guard enforces
 * differently.
 */
export function describeWriteScope(policy: DesignReviewWritePolicy): string {
  switch (policy.mode) {
    case "ordinary":
      if (policy.finishedRelease) {
        // 194 Phase 3 (C4): finished released the loop, but the cycle's own
        // documents stay closed — the prompt must tell the model what the
        // guard will still refuse.
        return "the develop stage's normal write scope (global protect applies); the finished design-review cycle's plan, review reports and update receipts stay read-only";
      }
      return "the stage's normal write scope (no design-review loop governs this session)";
    case "blocked":
      return `nothing — this run's identity or output binding cannot be proven (${policy.reason ?? "unknown"})`;
    case "readonly":
      return `nothing — the loop is paused waiting for the owner (${policy.reason ?? "paused"})`;
    case "scoped":
      if (policy.writable.length === 0) {
        return `nothing — this ${policy.operationKind ?? "design-review"} operation writes no model-owned files${policy.reason ? ` (${policy.reason})` : ""}`;
      }
      return [
        `EXACTLY these files (everything else is read-only):`,
        ...policy.writable.map((p) => `- ${p}`),
      ].join("\n");
  }
}
