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
import { resolveCommitDocPath, getStageDeliverableExemptions } from "../core/verify-path-resolver";
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

/**
 * Describes an empty or parse-failed rule set during verification.
 * When verify.md is missing, empty, or has invalid frontmatter, the owner
 * needs actionable guidance on the only legal next step.
 */
export function describeEmptyOrInvalidRuleSet(
  stageName: string,
  rulesSource: string | undefined,
  parseError: string | undefined,
): string {
  const sourceInfo = rulesSource ? ` (source: ${rulesSource})` : '';
  
  if (parseError) {
    return [
      `Verification configuration error for stage '${stageName}'${sourceInfo}.`,
      `Issue: verify.md frontmatter parse failed — ${parseError}.`,
      `Consequence: no verification rules can be evaluated; verification cannot proceed.`,
      `Next step: fix the frontmatter syntax in verify.md. Ensure the file starts with "---" and contains valid YAML between the delimiters.`,
    ].join("\n");
  }
  
  return [
    `Verification configuration error for stage '${stageName}'${sourceInfo}.`,
    `Issue: verify.md is empty or contains no verification rules.`,
    `Consequence: no verification rules can be evaluated; verification cannot proceed.`,
    `Next step: add verification rules to verify.md (e.g., requiredFiles, requiredCommands, keywords).`,
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
 * Conflict i: For develop/fix stages, check if the required deliverable path
 *   (commit doc) hits read-only paths AND the Phase 1 exemption does NOT apply
 *   (i.e., requirementDoc is missing or stage is not develop/fix).
 *
 * Conflict ii: For design-review stage, check if the dynamic write scope is
 *   empty but the stage contract requires output (allowedWritePaths is configured).
 */
export async function checkDispatchConflicts(
  stage: PipelineStage,
  meta: SessionMeta,
  allowedReadOnlyPaths: string[] | undefined,
  allowedWritePaths: string[] | undefined,
  resolveWritePolicy: () => Promise<{ mode: string; writable?: readonly string[]; reason?: string }> | { mode: string; writable?: readonly string[]; reason?: string },
  describeScope: (policy: { mode: string; writable?: readonly string[]; reason?: string }) => Promise<string> | string,
): Promise<DispatchConflictResult | null> {
  // Conflict i: Check if contract-required write target hits read-only AND exemption does NOT apply.
  // When requirementDoc exists: check exact deliverable path against read-only + exemption.
  // When requirementDoc is MISSING: exemption does not apply (getStageDeliverableExemptions returns []),
  // and the contract-required write target pattern is `docs/design/*_plan_commit.md`.
  // Use a representative instance of that pattern to probe for pattern-level intersection.
  if (stage === "develop" || stage === "fix") {
    if (meta.requirementDoc) {
      // Exact path: resolveCommitDocPath(requirementDoc base)
      const reqBase = meta.requirementDoc.replace(/\.md$/, "");
      if (reqBase) {
        const deliverablePath = resolveCommitDocPath(reqBase);
        if (allowedReadOnlyPaths?.length) {
          const exemptions = getStageDeliverableExemptions(meta, stage);
          const isExempted = exemptions.includes(deliverablePath);
          if (!isExempted && isPathReadOnly(deliverablePath, allowedReadOnlyPaths)) {
            const report = describeReadOnlyWriteConflict(
              stage,
              allowedReadOnlyPaths,
              allowedWritePaths ?? [],
            );
            return { blocked: true, conflictType: "readonly_write", report };
          }
        }
      }
    } else if (allowedReadOnlyPaths?.length) {
      // requirementDoc missing: exemption does NOT apply.
      // Contract-required write target pattern: docs/design/*_plan_commit.md.
      // Probe with a representative instance — if it hits read-only, the pattern is blocked.
      const contractPatternProbe = resolveCommitDocPath("plan");
      if (isPathReadOnly(contractPatternProbe, allowedReadOnlyPaths)) {
        const report = describeReadOnlyWriteConflict(
          stage,
          allowedReadOnlyPaths,
          allowedWritePaths ?? [],
        );
        return { blocked: true, conflictType: "readonly_write", report };
      }
    }
  }


  // Conflict ii: For design-review stage, check if write scope is empty
  // BUT only if stage contract requires output (allowedWritePaths is configured)
  if (stage === "design-review" && allowedWritePaths && allowedWritePaths.length > 0) {
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
