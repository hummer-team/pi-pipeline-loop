/**
 * @module auto-pipeline/review-no-progress
 * 229 Phase 4 (F4/R3-Q4 B): the review/fix loop's no-progress detection,
 * ledger accounting and early stop.
 *
 * Facts (boundaries):
 * - loop identity: the review/fix ledger (`meta.reviewLedger.designReview →
 *   "reviewFix"`) NEVER mixes with the design-review loop's own ledger
 *   (`meta.designReview.progressLedger`): `evaluateNoProgress` pins the loop
 *   and a mismatch reads as progress (`no_progress_loop_mismatch` upstream).
 * - parseReviewFindings supports BOTH shapes of the shipped review report:
 *   the bullet-list template (`### 问题 N` + `等级：/是否修复：`) and tables
 *   with a severity column. Reports without an ID column get mechanical
 *   `CR-<round>-<n>` ids (问题 6).
 * - B17: the sidecar read-modify-write lives HERE and at the coordinator /
 *   pipeline-auto only; `round-budget.ts` and `issue-ledger.ts` stay pure.
 * - Question 9 contract: the freeze is signaled (`frozen: true`) so callers
 *   (stage-advancer) return IMMEDIATELY — no reviewPendingFail write, no
 *   routing, no commit on a frozen settle.
 */

import * as fs from "node:fs";
import type { DesignReviewIssueRecord, SessionMeta, PipelineConfig } from "../../types";
import { severityCounts, evaluateNoProgress, computeOpenSet, type NoProgressEvaluation } from "../design-review/issue-ledger";
import type { ReviewFixProgressLedger } from "../../types";
import { auditAutoDiagnostic } from "./diagnostics";
import { readActiveJobContext } from "./config-overlay";
import { writeJobState } from "./job-state";

/** Parse one severity token (bilingual aliases included). */
function parseSeverityToken(raw: string): string | undefined {
  const token = raw.trim().toLowerCase();
  if (token === "blocker" || token === "blocker") return "Blocker";
  if (token === "high") return "High";
  if (token === "medium") return "Medium";
  if (token === "low") return "Low";
  if (token === "阻断" || token === "严重") return "Blocker";
  if (token === "较高" || token === "高") return "High";
  if (token === "中") return "Medium";
  if (token === "低") return "Low";
  return undefined;
}

/** Parse the 是否修复 status token. Unknown values read as open (问题 10). */
function parseFixStatus(raw: string): string {
  const token = raw.trim();
  if (/^(已修复|fixed)$/i.test(token)) return "fixed";
  if (/^(接受风险|accepted-risk)$/i.test(token)) return "accepted-risk";
  if (/^(遗留|carry-over|延后)$/i.test(token)) return "carry-over";
  return "open";
}

/** Parse one list-form report block (`### 问题 N` bullets). */
function parseListFindings(lines: readonly string[], round: number): DesignReviewIssueRecord[] {
  const records: DesignReviewIssueRecord[] = [];
  let current: DesignReviewIssueRecord | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^#{3,4}\s*问题\s*(\d+)/.exec(trimmed);
    if (heading && heading[1] !== undefined) {
      current = {
        id: `CR-${String(round)}-${String(records.length + 1)}`,
        origin: String(round),
        status: "open",
        text: heading[0].replace(/^#+\s*/, "").trim(),
      };
      records.push(current);
      continue;
    }
    if (current === null) continue;
    const sev = /^[-*]?\s*(?:等级|severity)\s*[:：]\s*(.+)$/i.exec(trimmed);
    if (sev && sev[1] !== undefined) {
      const value = parseSeverityToken(sev[1]);
      if (value !== undefined) current.severity = value as DesignReviewIssueRecord["severity"];
      continue;
    }
    const fixStatus = /^[-*]?\s*(?:是否修复|状态)\s*[:：]\s*(.+)$/.exec(trimmed);
    if (fixStatus && fixStatus[1] !== undefined) {
      current.status = parseFixStatus(fixStatus[1]) as DesignReviewIssueRecord["status"];
      continue;
    }
    const evidence = /^[-*]?\s*(?:证据|evidence)\s*[:：]\s*(.+)$/i.exec(trimmed);
    if (evidence && evidence[1] !== undefined) {
      current.evidence = evidence[1].trim();
    }
  }
  return records;
}

/** Parse one table-form report (the severity column decides the header). */
function parseTableFindings(lines: readonly string[], round: number): DesignReviewIssueRecord[] {
  const records: DesignReviewIssueRecord[] = [];
  let columns: { id?: number; severity?: number; status?: number; evidence?: number; text?: number } | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!/^\|.*\|$/.test(trimmed)) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(trimmed)) continue;
    const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (columns === null) {
      const header = cells.map((c) => c.toLowerCase());
      if (header.some((c) => /^(等级|severity)$/.test(c))) {
        columns = {};
        cells.forEach((c, i) => {
          const name = c.toLowerCase();
          if (name === "id" || name === "编号") columns!.id = i;
          else if (/^(等级|severity)$/.test(name)) columns!.severity = i;
          else if (/^(状态|是否修复|status|fixed)$/.test(name)) columns!.status = i;
          else if (/^(证据|evidence)$/.test(name)) columns!.evidence = i;
          else if (columns!.text === undefined && columns!.severity !== i) columns!.text = i;
        });
        continue;
      }
      continue;
    }
    const severity = columns.severity !== undefined ? parseSeverityToken(cells[columns.severity] ?? "") : undefined;
    if (severity === undefined) continue;
    const rawId = columns.id !== undefined ? (cells[columns.id] ?? "").trim() : "";
    const id = rawId !== "" ? rawId : `CR-${String(round)}-${String(records.length + 1)}`;
    const statusValue = columns.status !== undefined ? (cells[columns.status] ?? "").trim() : "";
    records.push({
      id,
      origin: String(round),
      ...(severity !== undefined ? { severity: severity as DesignReviewIssueRecord["severity"] } : {}),
      status: statusValue !== "" ? (parseFixStatus(statusValue) as DesignReviewIssueRecord["status"]) : "open",
      ...(columns.evidence !== undefined && (cells[columns.evidence] ?? "").trim() !== ""
        ? { evidence: (cells[columns.evidence] ?? "").trim() }
        : {}),
      text: (columns.text !== undefined ? (cells[columns.text] ?? "") : "").trim(),
    });
  }
  return records;
}

/**
 * Parse the review report of ONE round into issue records (both list and
 * table shapes; no ID column ⇒ `CR-<round>-<n>`, 问题 6). Read-only.
 */
export function parseReviewFindings(reportPath: string, round: number): DesignReviewIssueRecord[] {
  let content: string;
  try {
    content = fs.readFileSync(reportPath, "utf-8");
  } catch {
    return [];
  }
  const listRecords = parseListFindings(content.split("\n"), round);
  if (listRecords.length > 0) return listRecords;
  return parseTableFindings(content.split("\n"), round);
}

/** One round's no-progress evaluation result for the review/fix loop. */
export interface ReviewRoundOutcome {
  verdict: NoProgressEvaluation["verdict"];
  streak: number;
  /** True when the loop was FROZEN (`no_progress_detected`) — callers return. */
  frozen: boolean;
}

/** docKey derivation shared by every sidecar mutation (stop-policy parity). */
export function sidecarDocKey(state: { docs: Array<{ doc: string }>; docIndex: number }): string {
  return state.docs[state.docIndex]?.doc ?? String(state.docIndex);
}

/**
 * Read the reviewer's no-progress grace counter for THIS doc (sidecar, once).
 * `null` without an active auto job or on a read failure (human mode: the
 * equity applies immediately — R1-Q5 C).
 */
export function readNoProgressGraceUsed(projectRoot: string, docKey: string): number {
  const active = readActiveJobContext(projectRoot);
  if (active === null) return 0;
  return active.state.counters.noProgressGraceUsed?.[docKey] ?? 0;
}

/**
 * One no-progress round CONSUMES the single observation grace. Failures only
 * audit (`job_state_persist_failed` reuse family) — never block the caller.
 */
export function bumpNoProgressGraceUsed(projectRoot: string, docKey: string): void {
  const active = readActiveJobContext(projectRoot);
  if (active === null) return;
  if (!active.state.counters.noProgressGraceUsed || typeof active.state.counters.noProgressGraceUsed !== "object") {
    active.state.counters.noProgressGraceUsed = {};
  }
  active.state.counters.noProgressGraceUsed[docKey] = (active.state.counters.noProgressGraceUsed[docKey] ?? 0) + 1;
  void writeJobState(projectRoot, active.state).catch((err: unknown) => {
    auditAutoDiagnostic("job_state_persist_failed", "No-progress grace counter write failed.", {
      jobId: active.jobId,
      docKey,
      error: String(err),
    });
  });
}

/**
 * 229 Phase 4 (B10): ONE sidecar mirror write for the doc's cumulative
 * design-review round count. Called from the coordinator's dispatch-counting
 * point only; failures only audit (`job_state_persist_failed` family).
 */
export function mirrorSidecarDesignReviewRounds(
  config: PipelineConfig,
  rounds: number,
): void {
  const active = readActiveJobContext(config.projectRoot);
  if (active === null) return;
  const docKey = sidecarDocKey(active.state);
  if (!active.state.counters.designReviewRounds || typeof active.state.counters.designReviewRounds !== "object") {
    active.state.counters.designReviewRounds = {};
  }
  // Monotonic: a mirror never refunds an inherited count.
  const current = active.state.counters.designReviewRounds[docKey] ?? 0;
  active.state.counters.designReviewRounds[docKey] = Math.max(current, rounds);
  void writeJobState(config.projectRoot, active.state).catch((err: unknown) => {
    auditAutoDiagnostic("job_state_persist_failed", "Design-review round budget mirror write failed.", {
      jobId: active.jobId,
      docKey,
      error: String(err),
    });
  });
}

/**
 * The review/fix loop-wide single entry: evaluate one round's outcome, write
 * `meta.reviewLedger`, and freeze ONCE when the open set did not shrink for
 * the granted grace (exhausted).
 *
 * Shuffle contract for callers (问题 9): `frozen: true` ⇒ IMMEDIATE return —
 * the module already froze (flow state blocked + audit); any routing commit
 * would race the frozen state.
 */
export async function noteReviewRoundOutcome(input: {
  config: PipelineConfig;
  meta: SessionMeta;
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  reportPath: string;
  round: number;
}): Promise<ReviewRoundOutcome> {
  const { config, meta, session } = input;
  const records = parseReviewFindings(input.reportPath, input.round);
  const open = computeOpenSet(records);
  const next = {
    loop: "reviewFix" as const,
    openIds: open.map((r) => r.id),
    severityCounts: severityCounts(open),
  };
  const prev = meta.reviewLedger;
  const activeCtx = readActiveJobContext(config.projectRoot);
  const docKey = activeCtx !== null ? sidecarDocKey(activeCtx.state) : "default";
  const graceUsed = activeCtx !== null ? (readNoProgressGraceUsed(config.projectRoot, docKey) ?? 0) : 0;
  // 229 (F4 宽限): ONE observation round for the first flat round; the second
  // consecutive flat round freezes (effective grace 0 after consumption).
  const effectiveGrace = graceUsed >= 1 ? 0 : 1;

  const evaluation = evaluateNoProgress(prev, next, effectiveGrace);
  const roundIndex = meta.reviewRound?.index ?? input.round;
  const ledger: ReviewFixProgressLedger = {
    loop: "reviewFix",
    roundIndex,
    pipelineId: meta.pipelineId ?? "unknown",
    openIds: next.openIds,
    severityCounts: next.severityCounts,
    streak: evaluation.streak,
  };
  session.updateMeta({ reviewLedger: ledger });

  if (evaluation.verdict === "no-progress" && activeCtx !== null) {
    bumpNoProgressGraceUsed(config.projectRoot, docKey);
  }
  if (evaluation.verdict === "exhausted") {
    const { freezeAndPrompt } = await import("../flow-state");
    const flowCtx = { session: input.session } as Parameters<typeof freezeAndPrompt>[0];
    await freezeAndPrompt(flowCtx, meta, "no_progress_detected", config);
    return { verdict: evaluation.verdict, streak: evaluation.streak, frozen: true };
  }
  return { verdict: evaluation.verdict, streak: evaluation.streak, frozen: false };
}
