/**
 * @module design-review/degraded-release
 * the design-review
 * loop-exhaustion release. ONLY a commit — the dispatch of the fresh develop
 * visit is performed by the `flow-state` side (`invokeResumeDispatch`), so no
 * `flow-state ↔ degraded-release` import cycle exists.
 *
 * Facts:
 * - Open issues / severities come from `designReview.progressLedger`; when a
 *   ledger is missing, the review receipt's issue ids + the previous round's
 *   report supply the severities; when BOTH are unavailable the release is
 *   REFUSED (`degraded_release_unbound`, fail-closed).
 * - The degraded-pass approval is ALWAYS recorded (also for an
 *   `awaiting_human` target — evidence ② can stand later); the `loop-exit`
 *   `degradedPass` record is written ONLY when the target is not
 *   `awaiting_human` (carried items land as `carry-over`).
 * - ONE strict commit carries the migration + visit + finished state +
 *   `exhaustedLoops`; a commit failure leaves ZERO state changes.
 */

import type {
  DegradedPassIssue,
  DegradedPassReason,
  DesignReviewIssueRecord,
  DesignReviewState,
  IssueSeverity,
  PipelineStage,
  PipelineConfig,
  SessionMeta,
} from "../../types";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { recordStageVisit } from "../../utils/stage-visit";
import { effectiveMax } from "../../utils/stage-visit";
import { strictCommitMeta, type MetaCommitExpectation } from "../session-state";
import { buildForwardStagePatch } from "../stage-migration";
import { computeReportHash } from "../verifiers/design-review-verifier";
import {
  DEFAULT_ISSUE_HEADING_PATTERN,
  compileHeadingRe,
  extractReportSection,
  stripInertLines,
} from "./report-sections";
import { computeOpenSet, parseIssuesSection } from "./issue-ledger";
import { deriveReportPath } from "./state";
import * as fs from "node:fs";

/** Inputs the caller owns; `targetStage` came from loop-exhaustion (B3). */
export interface DegradedReleaseInput {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMetaVerified?: never;
    // strictCommitMeta is called directly (the session adapter is compatible).
  } & Parameters<typeof strictCommitMeta>[0];
  config: PipelineConfig;
  meta: SessionMeta;
  drState: DesignReviewState;
  reason: string;
  targetStage: PipelineStage | "awaiting_human";
  jobId?: string;
}

export type DegradedReleaseResult =
  | { ok: true; freshMeta: SessionMeta }
  | { ok: false; code: "degraded_release_unbound" | "release_commit_failed"; detail: string };

/**
 * resolve the carried open set.
 *
 * Precedence: the design-review progress ledger (the authoritative cross-round
 * view) → the review receipt's stable ids repaired with the previous round's
 * report severities → REFUSED (`bound: false`). The ledger path must project
 * the REAL records: an empty projection would silently drop every carry-over
 * and make the loop-exit `degradedPass` (and its downstream visibility)
 * unreachable.
 */
function resolveOpenIssues(
  drState: DesignReviewState,
  reportPath: string,
): { records: DesignReviewIssueRecord[]; bound: boolean } {
  const ledger = drState.progressLedger;
  if (ledger !== undefined) {
    // Severities come from the ledger's per-issue map; the ledger itself never
    // fabricates one (missing severity stays missing — see `prepareDegradedRelease`).
    const records: DesignReviewIssueRecord[] = ledger.openIds.map((id) => {
      const severity = ledger.severityById?.[id];
      return {
        id,
        origin: String(ledger.round),
        status: "carry-over" as const,
        ...(severity !== undefined ? { severity } : {}),
        text: "unresolved carried issue",
      };
    });
    return { records, bound: true };
  }
  const issueIds = drState.reviewInputReceipt?.issueIds;
  if (issueIds === undefined || issueIds.length === 0) {
    return { records: [], bound: false };
  }
  // Repair severities from the PREVIOUS round's report snapshot.
  let content: string | undefined;
  try {
    content = fs.readFileSync(reportPath, "utf-8");
  } catch {
    return { records: issueIds.map((id) => ({ id, origin: "", text: "unresolved carried issue" })), bound: true };
  }
  const parsed = parseIssuesSection(
    extractReportSection(
      stripInertLines(content),
      compileHeadingRe(undefined, DEFAULT_ISSUE_HEADING_PATTERN),
    )?.lines ?? [],
    drState.round - 1,
  );
  const byId = new Map(parsed.map((r) => [r.id, r]));
  const records = issueIds.map((id) => byId.get(id) ?? { id, origin: "", text: "unresolved carried issue" });
  return { records, bound: true };
}

/**
 * The degraded release for the design-review loop. Returns `ok:false`
 * WITH the caller keeping the freeze when the open set is unbound or the
 * strict commit conflicts — ZERO state changes in every failure path.
 */
export async function prepareDegradedRelease(
  input: DegradedReleaseInput,
): Promise<DegradedReleaseResult> {
  const { session, config, meta, drState, reason, targetStage } = input;

  // ── Open-set resolution (fail-closed) ─────────────────────────────────────
  const reportPath = drState.reviewInputReceipt?.reportDoc ?? deriveReportPath(drState.planDoc, drState.round - 1);
  const resolved = resolveOpenIssues(drState, reportPath);
  if (!resolved.bound) {
    await safeWriteAuditLog("degraded_release_unbound", {
      pipelineId: meta.pipelineId,
      stage: "design-review",
      round: String(drState.round),
    }, "warn");
    return { ok: false, code: "degraded_release_unbound", detail: "no progress ledger and no review receipt to bind the carried issues" };
  }
  const severityCounts: Partial<Record<IssueSeverity, number>> = {};
  for (const r of resolved.records) {
    if (r.severity !== undefined) {
      severityCounts[r.severity] = (severityCounts[r.severity] ?? 0) + 1;
    }
  }

  // ── Approval identity (fail-closed on missing identity) ───────────────────
  const reviewOperationId = drState.operation?.operationId;
  if (reviewOperationId === undefined) {
    await safeWriteAuditLog("degraded_release_unbound", {
      pipelineId: meta.pipelineId,
      stage: "design-review",
      round: String(drState.round),
      reason: "operation_missing",
    }, "warn");
    return { ok: false, code: "degraded_release_unbound", detail: "no review operation id to bind the approval" };
  }
  let reportHash = drState.outcome?.reportHash;
  if (reportHash === undefined) {
    try {
      reportHash = computeReportHash(fs.readFileSync(reportPath, "utf-8"));
    } catch {
      reportHash = undefined;
    }
  }
  if (drState.planHash === undefined || reportHash === undefined) {
    await safeWriteAuditLog("degraded_release_unbound", {
      pipelineId: meta.pipelineId,
      stage: "design-review",
      round: String(drState.round),
      reason: "hash_missing",
    }, "warn");
    return { ok: false, code: "degraded_release_unbound", detail: "plan/report hashes unavailable for the approval" };
  }

  const openIssueIds = drState.progressLedger?.openIds ?? resolved.records.map((r) => r.id);
  const at = Date.now();
  // a severity MUST be parseable — a missing one is never
  // fabricated as `Medium` (that would understate the real risk in the
  // accepted-risk/carry-over distribution). Fail-closed instead.
  const missingSeverity = resolved.records.filter(
    (r) => openIssueIds.includes(r.id) && r.severity === undefined,
  );
  if (missingSeverity.length > 0) {
    await safeWriteAuditLog("degraded_release_unbound", {
      pipelineId: meta.pipelineId,
      stage: "design-review",
      round: String(drState.round),
      reason: "severity_missing",
      issueIds: missingSeverity.map((r) => r.id).join(","),
    }, "warn");
    return {
      ok: false,
      code: "degraded_release_unbound",
      detail: `no parseable severity for carried issues: ${missingSeverity.map((r) => r.id).join(", ")}`,
    };
  }
  const degradedPassIssueList: DegradedPassIssue[] = resolved.records
    .filter((r) => openIssueIds.includes(r.id) && r.severity !== undefined)
    .map((r) => ({
      id: r.id,
      severity: r.severity as IssueSeverity,
      status: "carry-over" as const,
    }));

  const finishedState: DesignReviewState = {
    ...drState,
    phase: "finished",
    approval: {
      reviewOperationId,
      round: drState.round,
      planHash: drState.planHash,
      reportHash,
      authorizedAt: at,
      basis: {
        kind: "degraded-pass",
        reason: reason as DegradedPassReason,
        round: drState.round,
        openIssueIds,
      },
    },
    updatedAt: at,
  };

  const isAwaitTarget = targetStage === "awaiting_human";
  const visitResult = recordStageVisit(meta, isAwaitTarget ? "awaiting_human" : (targetStage as PipelineStage), effectiveMax(meta, config), config);
  if (!visitResult.ok) {
    await safeWriteAuditLog("release_visit_budget_exhausted", {
      pipelineId: meta.pipelineId,
      stage: "design-review",
      targetStage,
    }, "warn");
    return { ok: false, code: "release_commit_failed", detail: "stage visit budget exhausted (soft stop required upstream)" };
  }

  const patch: Partial<SessionMeta> = {
    ...buildForwardStagePatch({ meta, prevStage: "design-review", toStage: (isAwaitTarget ? "awaiting_human" : targetStage) as PipelineStage }),
    ...visitResult.patch,
    designReview: finishedState,
    flowState: "running",
    blockedReason: undefined,
    exhaustedLoops: [
      ...(meta.exhaustedLoops ?? []),
      { loop: "designReview" as const, reason: reason as DegradedPassReason, at },
    ],
    ...(degradedPassIssueList.length > 0 && !isAwaitTarget
      ? {
          degradedPass: {
            scope: "loop-exit" as const,
            reason: reason as DegradedPassReason,
            pipelineId: meta.pipelineId,
            docPath: meta.requirementDoc ?? "",
            stage: "design-review" as const,
            round: drState.round,
            openIssues: degradedPassIssueList,
            severityCounts,
            ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
            at,
          },
        }
      : {}),
  };
  const expected: MetaCommitExpectation = {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: drState.operation?.operationId ?? null,
    phase: drState.phase,
    stateUpdatedAt: drState.updatedAt,
  };
  const commit = strictCommitMeta(session, patch, expected);
  if (commit.status !== "persisted") {
    return { ok: false, code: "release_commit_failed", detail: `${commit.status}` };
  }
  await safeWriteAuditLog("design_review_coordinator", {
    action: "degraded_pass_written",
    pipelineId: meta.pipelineId,
    stage: "design-review",
    round: String(drState.round),
    reason,
    scope: isAwaitTarget ? "approval-only" : "loop-exit",
  });
  const freshMeta = (session.getMeta() as SessionMeta | undefined) ?? meta;
  return { ok: true, freshMeta };
}
