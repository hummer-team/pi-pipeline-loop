/**
 * @module guard-conflict-report
 *
 * 195 Phase 2: Shared pure functions for describing configuration conflicts
 * with actionable "next step" guidance. These functions are used by both
 * blocking guards (dispatch fail-fast, tool rejection) and non-blocking
 * warnings (read-only ∩ write intersection) so that the same configuration
 * produces byte-identical descriptions regardless of entry point.
 *
 * Consequence text is co-sourced with the circuit-breaker fact:
 * "单次拦截计 1 violation，同桶满 DEFAULT_MAX_VIOLATIONS (3) 即 violation_overflow 冻结"
 */

import { DEFAULT_MAX_VIOLATIONS } from "../constants";
import { getFlowState, formatAbortedNotifyText, formatFrozenReason, formatDecisionMenuHint } from "../core/flow-state";
import { isPathReadOnly } from "./protect";
import { resolveCommitDocPath } from "../core/verify-path-resolver";
import type { SessionMeta, PipelineStage } from "../types";

/**
 * Describes a read-only ∩ writable path conflict.
 * Used by both warnReadOnlyWriteIntersection (non-blocking) and
 * checkDispatchConflicts (blocking) — same inputs produce identical text.
 */
export function describeReadOnlyWriteConflict(
  stageName: string,
  readOnlyPaths: string[],
  allowedWritePaths: string[],
): string {
  return [
    `Configuration conflict: allowedReadOnlyPaths ∩ allowedWritePaths overlap for stage '${stageName}'.`,
    `Conflict paths: [${readOnlyPaths.join(", ")}] overlap with write paths [${allowedWritePaths.join(", ")}].`,
    `Consequence: read-only takes priority; any write to these paths will be blocked.`,
    `Each blocked write counts as 1 violation; when the bucket reaches DEFAULT_MAX_VIOLATIONS (${DEFAULT_MAX_VIOLATIONS}), violation_overflow freeze is triggered.`,
    `Suggested fix: remove the conflicting paths from allowedWritePaths, or narrow allowedReadOnlyPaths.`,
    `Next step: adjust stage '${stageName}' config so allowedReadOnlyPaths and allowedWritePaths do not overlap.`,
  ].join("\n");
}

/**
 * Describes an empty write-scope conflict during design-review.
 * Stage contract requires deliverables but the write scope resolves to nothing.
 */
export function describeEmptyWriteScopeConflict(
  stageName: string,
  writeScopeDesc: string,
): string {
  return [
    `Configuration conflict: stage '${stageName}' contract requires deliverable output but the design-review write scope is empty.`,
    `Write scope: ${writeScopeDesc}.`,
    `Consequence: the sub-agent will be spawned but unable to write any deliverable file.`,
    `Each blocked write counts as 1 violation; when the bucket reaches DEFAULT_MAX_VIOLATIONS (${DEFAULT_MAX_VIOLATIONS}), violation_overflow freeze is triggered.`,
    `Suggested fix: adjust the design-review operation's writable file list, or exit design-review mode.`,
    `Next step: ensure the design-review write scope includes at least one path the stage contract expects.`,
  ].join("\n");
}

/**
 * Describes a frozen/blocked pipeline state for rejection messages.
 * Co-sourced with dispatch-conflict text so that the same state produces
 * byte-identical consequence wording.
 */
export function describeFrozenBlocked(meta: SessionMeta): string {
  const fs = getFlowState(meta);
  if (fs === "aborted") {
    return formatAbortedNotifyText(
      meta.currentStage,
      meta.terminateReason ?? "session_quit",
      meta.requirementDoc,
    );
  }
  // blocked or awaiting_human
  return [
    `Pipeline frozen: ${formatFrozenReason(meta)}.`,
    `Consequence: all write tools are rejected.`,
    `Each blocked write counts as 1 violation; when the bucket reaches DEFAULT_MAX_VIOLATIONS (${DEFAULT_MAX_VIOLATIONS}), violation_overflow freeze is triggered.`,
    `Next step: ${formatDecisionMenuHint()}`,
  ].join("\n");
}

/**
 * Describes an invalid next-stage transition, echoing the legal chain.
 */
export function describeInvalidNextStage(legalChain: string[]): string {
  return [
    `Invalid nextStage: the requested target is not a legal successor of the current stage.`,
    `Legal chain: ${legalChain.join(" → ")}.`,
    `Next step: call stage_advance with a nextStage that appears in the legal chain above.`,
  ].join("\n");
}

/** Result of checkDispatchConflicts when a conflict is found. */
export interface DispatchConflictResult {
  blocked: true;
  conflictType: "readonly_write" | "empty_write_scope";
  report: string;
}

/**
 * Checks for dispatch-blocking configuration conflicts before sub-agent spawn.
 * Returns null when no conflict is detected (spawn may proceed).
 *
 * Conflict i: stage deliverable write targets (from getStageDeliverableExemptions)
 *   hit read-only paths and exemption does not apply (e.g. requirementDoc missing).
 *   Uses isPathReadOnly for proper glob pattern matching.
 *
 * Conflict ii: design-review dynamic write scope is empty but stage contract
 *   requires output (resolveDesignReviewWritePolicy + describeWriteScope).
 *   Checks when requirementDoc is set AND design-review blocks writes.
 */
export async function checkDispatchConflicts(
  stage: PipelineStage,
  meta: SessionMeta,
  allowedReadOnlyPaths: string[] | undefined,
  allowedWritePaths: string[] | undefined,
  resolveWritePolicy: () => Promise<{ mode: string; writable?: readonly string[]; reason?: string }> | { mode: string; writable?: readonly string[]; reason?: string },
  describeScope: (policy: { mode: string; writable?: readonly string[]; reason?: string }) => Promise<string> | string,
): Promise<DispatchConflictResult | null> {
  // Compute required deliverable path (if any)
  let requiredDeliverablePath: string | null = null;
  if ((stage === "develop" || stage === "fix") && meta.requirementDoc) {
    const reqBase = meta.requirementDoc.replace(/\.md$/, "");
    if (reqBase) {
      requiredDeliverablePath = resolveCommitDocPath(reqBase);
    }
  }

  // Conflict i: required deliverable path is blocked by read-only patterns
  if (requiredDeliverablePath && allowedReadOnlyPaths?.length) {
    if (isPathReadOnly(requiredDeliverablePath, allowedReadOnlyPaths)) {
      const report = describeReadOnlyWriteConflict(
        stage,
        allowedReadOnlyPaths,
        allowedWritePaths ?? [],
      );
      return { blocked: true, conflictType: "readonly_write", report };
    }
  }

  // Conflict ii: design-review write scope is empty but stage requires deliverables
  // This happens when requirementDoc is set (so stage requires output) but
  // design-review policy blocks all writes
  if (requiredDeliverablePath) {
    const policy = await resolveWritePolicy();
    if (policy.mode !== "ordinary") {
      const scopeDesc = await describeScope(policy);
      if (scopeDesc.startsWith("nothing")) {
        const report = describeEmptyWriteScopeConflict(stage, scopeDesc);
        return { blocked: true, conflictType: "empty_write_scope", report };
      }
    }
  }

  return null;
}
