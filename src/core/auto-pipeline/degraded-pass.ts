/**
 * @module auto-pipeline/degraded-pass
 * 229 Phase 6 (F6/B1): degraded-pass record construction and binding check.
 *
 * Facts (contract):
 * - `completion` scope records MAY substitute completion-gate evidence ①
 *   (they REQUIRE `Blocker + High === 0` at construction — B5);
 * - `loop-exit` records are carry-over VISIBILITY only (open items leave the
 *   review loop AS debt, never as terminal evidence);
 * - binding = pipelineId equal + docPath equal to THIS run's requirement doc;
 *   anything else fail-closes (`degraded_pass_invalid`);
 * - duplicate writes are detected by (pipelineId, round, reason) so a repeat
 *   advance never re-stamps the same record (`degraded_pass_duplicate`).
 */

import type { DegradedPassRecord, SessionMeta } from "../../types";

/** Is THIS record eligible to substitute completion-gate evidence ①? */
export function isDegradedPassBound(
  meta: SessionMeta,
  record: DegradedPassRecord,
): boolean {
  if (record.scope !== "completion") return false;
  if (record.pipelineId !== meta.pipelineId) return false;
  if (record.docPath !== meta.requirementDoc) return false;
  const blockers = (record.severityCounts["Blocker"] ?? 0) + (record.severityCounts["High"] ?? 0);
  return blockers === 0;
}

/** True when THIS meta already carries the same degradation stamp. */
export function isDegradedPassDuplicate(
  existing: DegradedPassRecord | undefined,
  candidate: DegradedPassRecord,
): boolean {
  if (existing === undefined) return false;
  return (
    existing.pipelineId === candidate.pipelineId
    && existing.round === candidate.round
    && existing.reason === candidate.reason
    && existing.at === candidate.at
  );
}

/**
 * 229 Phase 5/6 (B5): mechanically build the degraded-pass record for the
 * review/fix loop's completion exit from meta state.
 *
 * `undefined` reasons (fail-closed, audit upstream):
 * - no reviewFix ledger (nothing bound — `degraded_release_unbound`);
 * - the aggregate says ANY blocking severity is still open
 *   (`Blocker + High > 0`) — the caller DEGRADES the target to
 *   `awaiting_human` instead.
 *
 * Open items become `accepted-risk` with their ledger-recorded severity
 * (ids without a declared severity are treated NON-blocking, consistent
 * with the review loop's own severity gate).
 */
export function buildDegradedPassFromReviewLedger(
  meta: SessionMeta,
  reason: string,
  jobId?: string,
): DegradedPassRecord | undefined {
  const ledger = meta.reviewLedger;
  if (ledger === undefined || ledger.loop !== "reviewFix") return undefined;
  const blockers = (ledger.severityCounts["Blocker"] ?? 0) + (ledger.severityCounts["High"] ?? 0);
  if (blockers > 0) return undefined;
  const openIssues: DegradedPassRecord["openIssues"] = ledger.openIds.map((id) => {
    const severity = ledger.severityById?.[id];
    return {
      id,
      ...(severity !== undefined ? { severity } : { severity: "Medium" as const }),
      status: "accepted-risk" as const,
    };
  });
  const at = Date.now();
  return {
    scope: "completion",
    reason: reason as DegradedPassRecord["reason"],
    pipelineId: meta.pipelineId,
    docPath: meta.requirementDoc ?? "",
    stage: meta.currentStage,
    round: ledger.roundIndex,
    openIssues,
    severityCounts: ledger.severityCounts,
    ...(jobId !== undefined ? { jobId } : {}),
    at,
  };
}
