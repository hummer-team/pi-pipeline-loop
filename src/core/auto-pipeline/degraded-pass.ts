/**
 * @module auto-pipeline/degraded-pass
 * degraded-pass record construction and binding check.
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
import { readActiveJobContext } from "./config-overlay";
import { auditAutoDiagnostic } from "./diagnostics";
import { writeJobState } from "./job-state";

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

/**
 * True when THIS meta already carries the same degradation stamp.
 *
 * The key is (pipelineId, round, reason) — NEVER `at`: the candidate is built
 * with `Date.now()`, so an `at`-inclusive key could never match a re-stamp and
 * a repeat advance would duplicate the record.
 */
export function isDegradedPassDuplicate(
  existing: DegradedPassRecord | undefined,
  candidate: DegradedPassRecord,
): boolean {
  if (existing === undefined) return false;
  return (
    existing.pipelineId === candidate.pipelineId
    && existing.round === candidate.round
    && existing.reason === candidate.reason
  );
}

/**
 * Doc-progress MIRROR of a persisted degraded-pass record (Phase 6 task 4):
 * `AutoJobDocProgress.degradedPass` is read-only display data — it never
 * participates in any judgement (the gate reads `meta.degradedPass` only).
 * Failures stay diagnostics-only, like every other sidecar mirror write.
 */
export function mirrorDegradedPassToJobDoc(
  projectRoot: string,
  record: DegradedPassRecord,
): void {
  const active = readActiveJobContext(projectRoot);
  if (active === null) return;
  const doc = active.state.docs[active.state.docIndex];
  if (doc === undefined) return;
  const severityCounts: Record<string, number> = {};
  for (const [severity, count] of Object.entries(record.severityCounts)) {
    if (count !== undefined) severityCounts[severity] = count;
  }
  doc.degradedPass = { reason: record.reason, round: record.round, severityCounts };
  doc.updatedAt = Date.now();
  active.state.updatedAt = doc.updatedAt;
  void writeJobState(projectRoot, active.state).catch((err: unknown) => {
    auditAutoDiagnostic("job_state_persist_failed", "Degraded-pass mirror write failed.", {
      jobId: active.jobId,
      reason: record.reason,
      error: String(err),
    });
  });
}

/**
 * mechanically build the degraded-pass record for the
 * review/fix loop's completion exit from meta state.
 *
 * `undefined` reasons (fail-closed, audit upstream):
 * - no reviewFix ledger (nothing bound — `degraded_release_unbound`);
 * - the aggregate says ANY blocking severity is still open
 *   (`Blocker + High > 0`) — the caller DEGRADES the target to
 *   `awaiting_human` instead.
 *
 * Open items become `accepted-risk` with their ledger-recorded severity. An id
 * WITHOUT a declared severity never fabricates one (a `Medium` fallback would
 * understate the real distribution and desynchronise `openIssues` from
 * `severityCounts`): it is treated as non-blocking, exactly like the review
 * loop's own severity gate, and therefore does not enter the record.
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
  const openIssues: DegradedPassRecord["openIssues"] = [];
  for (const id of ledger.openIds) {
    const severity = ledger.severityById?.[id];
    if (severity === undefined) continue;
    openIssues.push({ id, severity, status: "accepted-risk" });
  }
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
