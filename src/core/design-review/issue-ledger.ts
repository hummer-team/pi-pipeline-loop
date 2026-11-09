/**
 * @module design-review/issue-ledger
 * 229 Phase 0 (F1/F2): PURE issue-ledger primitives for the review-loop
 * convergence feature (requirement 229, plan v3 Phase 0 task 2).
 *
 * What lives here — and nothing else:
 * - header-aware parsing of the `## Issues` and `## Issue Ledger` report
 *   sections into {@link DesignReviewIssueRecord}s (four columns
 *   `ID/severity/evidence/summary` selected BY NAME; legacy 3-column tables
 *   and bullet lists fall back to the previous heuristics);
 * - sentinel-first filtering (问题 11): exact whole-item `None`/`无` sentinels
 *   are stripped BEFORE any record is constructed;
 * - stable issue id allocation, severity/open-set computation and the
 *   cross-round no-progress evaluation (F4).
 *
 * Pure over parameters: no I/O, no meta access, no clock reads, no side
 * effects. Verifier/severity-gate policy lives in the verifier (229 Phase 1);
 * persistence lives in the coordinator only (B17/B9).
 */

import type {
  DesignReviewIssueRecord,
  IssueSeverity,
  IssueStatus,
  ReviewProgressSnapshot,
} from "../../types";

/** Exact whole-item sentinels meaning "no issues" (same values as the verifier). */
export const NO_ISSUE_SENTINELS: ReadonlySet<string> = new Set([
  "none",
  "无",
  "n/a",
  "not applicable",
]);

/** Severities that fail the design-review verdict when present (F1 blocking set). */
const BLOCKING_SEVERITIES: ReadonlySet<IssueSeverity> = new Set(["Blocker", "High"]);

/** Statuses that CLOSE an issue; anything else (unknown/legacy) stays open. */
const CLOSED_STATUSES: ReadonlySet<IssueStatus> = new Set(["fixed", "accepted-risk"]);

/** Table separator row (`| --- | --- |`). */
const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]+\|\s*$/;

/** Markdown table row → trimmed cells. */
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;

/** Markdown bullet / ordered-list item → item text. */
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;

/** Stable issue id prefix used for design-review reports. */
export const DESIGN_ISSUE_ID_PREFIX = "DR";

/** Header-name aliases accepted in the first table row (evaluated lowercased). */
const HEADER_ALIASES: Readonly<Record<"id" | "severity" | "status" | "evidence" | "summary", readonly string[]>> = {
  id: ["id", "编号"],
  severity: ["severity", "等级", "级别"],
  status: ["status", "状态"],
  evidence: ["evidence", "证据"],
  summary: ["summary", "issue", "问题", "描述", "说明"],
};

/** Selected column indexes inside one table (absent ⇒ column not declared). */
interface LedgerColumns {
  id?: number;
  severity?: number;
  status?: number;
  evidence?: number;
  summary?: number;
}

/** True when the whole item is an exact no-issue sentinel (`None`/`无`/…). */
export function isNoIssueSentinel(text: string): boolean {
  return NO_ISSUE_SENTINELS.has(text.replace(/\*\*|__/g, "").trim().toLowerCase());
}

/** True when the severity is BLOCKING (Blocker/High). Missing ⇒ not blocking. */
export function isBlockingSeverity(severity?: IssueSeverity): boolean {
  return severity !== undefined && BLOCKING_SEVERITIES.has(severity);
}

/** True when the record carries non-empty evidence text. */
export function hasEvidence(record: { evidence?: string }): boolean {
  return (record.evidence ?? "").trim() !== "";
}

/** Display-level blocking predicate (`isBlockingSeverity` on the record). */
export interface DesignReviewIssueRecordLike {
  severity?: IssueSeverity;
}

/** True when the record is blocking (display only; the verifier owns the gate). */
export function isBlocking(record: DesignReviewIssueRecordLike): boolean {
  return isBlockingSeverity(record.severity);
}

/** Normalize one table cell for comparison (strip markdown/bold/backticks). */
function normalizeCell(raw: string | undefined): string {
  return (raw ?? "").replace(/[`*_]|__/g, "").trim().toLowerCase();
}

/** Detect a header row and map column names to indexes; `null` when not a header. */
function detectHeaderColumns(cells: readonly string[]): LedgerColumns | null {
  const columns: LedgerColumns = {};
  for (let i = 0; i < cells.length; i += 1) {
    const name = normalizeCell(cells[i]);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES) as Array<
      [keyof LedgerColumns, readonly string[]]
    >) {
      if (columns[key] === undefined && aliases.includes(name)) {
        columns[key] = i;
      }
    }
  }
  return columns.id !== undefined || columns.severity !== undefined ? columns : null;
}

/** Resolve the summary text of one data row (declared column or legacy heuristic). */
function resolveSummaryText(columns: LedgerColumns | null, cells: readonly string[]): string {
  if (columns !== null) {
    const index = columns.summary ?? columns.id;
    if (index === undefined) return "";
    return (cells[index] ?? "").trim();
  }
  // Legacy heuristic: 3-column tables carry the issue text in the second cell.
  return cells.length >= 2 ? (cells[1] ?? "").trim() : (cells[0] ?? "").trim();
}

/** Read a legal severity from a cell. Missing/illegal values stay `undefined` (verifier rejects). */
function parseSeverityCell(columns: LedgerColumns | null, cells: readonly string[]): IssueSeverity | undefined {
  if (columns?.severity === undefined) return undefined;
  const value = normalizeCell(cells[columns.severity]);
  if (value === "blocker") return "Blocker";
  if (value === "high") return "High";
  if (value === "medium") return "Medium";
  if (value === "low") return "Low";
  return undefined;
}

/** Read a legal status from a cell; absent/unknown ⇒ `open` (问题 10 normalization). */
function parseStatusCell(columns: LedgerColumns | null, cells: readonly string[]): IssueStatus {
  if (columns?.status === undefined) return "open";
  const value = normalizeCell(cells[columns.status]);
  if (value === "fixed" || value === "已修复") return "fixed";
  if (value === "carry-over" || value === "遗留" || value === "延后") return "carry-over";
  if (value === "accepted-risk" || value === "接受风险") return "accepted-risk";
  return "open";
}

/** Read the evidence cell; empty ⇒ `undefined` (missing evidence blocks blocking severities). */
function parseEvidenceCell(columns: LedgerColumns | null, cells: readonly string[]): string | undefined {
  if (columns?.evidence === undefined) return undefined;
  const value = (cells[columns.evidence] ?? "").trim();
  return value !== "" ? value : undefined;
}

/**
 * Allocate the next stable issue id (`{prefix}-{round}-{n}`) after the ids
 * already used for the same prefix+round. Ordinals are per (prefix, round) —
 * a new round restarts at 1 — and duplicates are skipped.
 */
export function nextIssueId(
  prefix: string,
  round: number,
  existing: readonly DesignReviewIssueRecord[] | readonly string[],
): string {
  let max = 0;
  const pattern = new RegExp(`^${prefix}-${round}-(\\d+)$`);
  const ids = existing.map((e) => (typeof e === "string" ? e : e.id));
  for (const id of ids) {
    const m = pattern.exec(id.trim());
    if (m && m[1] !== undefined) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${round}-${max + 1}`;
}

/** Ensure an id is unique against the records collected so far. */
function dedupeId(rawId: string, round: number, existing: readonly DesignReviewIssueRecord[]): string {
  const taken = new Set(existing.map((r) => r.id));
  if (!taken.has(rawId)) return rawId;
  return nextIssueId(DESIGN_ISSUE_ID_PREFIX, round, existing);
}

/** Derive the origin round from a stable issue id, else use the parsed round. */
function originFromId(id: string, round: number): string {
  const m = /^[A-Za-z]+-(\d+)-\d+$/.exec(id.trim());
  return m && m[1] !== undefined ? m[1] : String(round);
}

/** Build one record from a table data row (columns may be legacy `null`). */
function buildRecordFromCells(
  cells: readonly string[],
  columns: LedgerColumns | null,
  round: number,
  existing: readonly DesignReviewIssueRecord[],
): DesignReviewIssueRecord | null {
  const text = resolveSummaryText(columns, cells);
  if (text === "" || text.toLowerCase() === "issue" || isNoIssueSentinel(text)) return null;
  const rawId = columns?.id !== undefined ? (cells[columns.id] ?? "").trim() : "";
  const id = rawId !== "" ? dedupeId(rawId, round, existing) : nextIssueId(DESIGN_ISSUE_ID_PREFIX, round, existing);
  return {
    id,
    origin: originFromId(id, round),
    ...(columns?.severity !== undefined
      ? { severity: parseSeverityCell(columns, cells) }
      : {}),
    status: parseStatusCell(columns, cells),
    ...(columns?.evidence !== undefined ? { evidence: parseEvidenceCell(columns, cells) } : {}),
    text,
  };
}

/**
 * Single-pass scan of an `## Issues`-style section body (shared internal).
 * Mirrors the historical verifier item enumeration EXACTLY (inert lines
 * already stripped upstream): markdown separator/heading/blank rows are
 * skipped, table data rows resolve their summary cell (declared column or the
 * legacy `cells[1]` heuristic), bullets and bare lines count as items, and
 * exact whole-item sentinels are stripped BEFORE record construction.
 */
function walkIssuesSection(
  lines: readonly string[],
  round: number,
): { records: DesignReviewIssueRecord[]; sentinelPresent: boolean; rawItemCount: number } {
  const records: DesignReviewIssueRecord[] = [];
  let columns: LedgerColumns | null = null;
  let sentinelPresent = false;
  let rawItemCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // Markdown column separator (`| --- |`) is never a header and never data.
    if (TABLE_SEPARATOR_RE.test(trimmed)) continue;
    const tableRow = trimmed.match(TABLE_ROW_RE);
    if (tableRow && tableRow[1] !== undefined) {
      const cells = tableRow[1].split("|").map((c) => c.trim());
      const first = cells[0]?.toLowerCase() ?? "";
      if (columns === null) {
        const detected = detectHeaderColumns(cells);
        if (detected !== null) {
          columns = detected;
          continue;
        }
      }
      // Degenerate header-like rows are neither items nor data (legacy guard).
      if (first === "#" || first === "issue" || first === "问题" || first === "") continue;
      const text = resolveSummaryText(columns, cells);
      // Legacy count parity: only rows that produced a candidate item text
      // (sentinels included) enter the raw count.
      if (text !== "" && text.toLowerCase() !== "issue") rawItemCount += 1;
      if (text === "" || text.toLowerCase() === "issue" || isNoIssueSentinel(text)) {
        if (text !== "" && isNoIssueSentinel(text)) sentinelPresent = true;
        continue;
      }
      const record = buildRecordFromCells(cells, columns, round, records);
      if (record !== null) records.push(record);
      continue;
    }
    // Bullet / ordered item / bare line — the no-issue sentinel is written this
    // way and MUST be visible (stripped BEFORE record construction, 问题 11).
    const bullet = trimmed.match(BULLET_RE);
    const text = (bullet && bullet[1] !== undefined ? bullet[1] : trimmed).trim();
    rawItemCount += 1;
    if (isNoIssueSentinel(text)) {
      sentinelPresent = true;
      continue;
    }
    records.push({
      id: nextIssueId(DESIGN_ISSUE_ID_PREFIX, round, records),
      origin: String(round),
      status: "open",
      text,
    });
  }
  return { records, sentinelPresent, rawItemCount };
}

/**
 * Result of scanning one `## Issues` section body in a single pass.
 * `rawItemCount` counts candidate items INCLUDING sentinel lines — the
 * verifier's "PASS without an explicit sentinel" rule needs that raw view.
 */
export interface IssueSectionScan {
  /** Normalized records (sentinels stripped, defaults applied). */
  records: DesignReviewIssueRecord[];
  /** True when an exact whole-item no-issue sentinel line/cell is present. */
  sentinelPresent: boolean;
  /** Candidate item count including sentinel lines (excludes headers/separators). */
  rawItemCount: number;
}

/**
 * Shared single-pass scan for both report sections (verifier entry point).
 */
export function scanIssuesSection(
  lines: readonly string[],
  round: number,
): IssueSectionScan {
  return walkIssuesSection(lines, round);
}

/**
 * Parse a `## Issues` section body into normalized records. Header-aware
 * (`ID/severity/evidence/summary` by name); legacy 3-column tables and bullets
 * fall back to the previous heuristics (`cells[1]`, id generated, status open).
 * Sentinel rows/items never become records.
 */
export function parseIssuesSection(
  lines: readonly string[],
  round: number,
): DesignReviewIssueRecord[] {
  return walkIssuesSection(lines, round).records;
}

/**
 * Parse a `## Issue Ledger` section body (same contract plus the `status`
 * column; absent/unknown status ⇒ `open`).
 */
export function parseIssueLedgerSection(
  lines: readonly string[],
  round: number,
): DesignReviewIssueRecord[] {
  return walkIssuesSection(lines, round).records;
}

/**
 * Severity histogram over records with a declared severity (F1/binding).
 * Unspecified keys stay absent (no zero-filled noise).
 */
export function severityCounts(
  records: readonly DesignReviewIssueRecord[],
): Partial<Record<IssueSeverity, number>> {
  const counts: Partial<Record<IssueSeverity, number>> = {};
  for (const record of records) {
    if (record.severity === undefined) continue;
    counts[record.severity] = (counts[record.severity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compute the cross-round OPEN set (F2 closure): issues whose status is
 * `open`/`carry-over`, unknown or absent stay open (问题 10); only
 * `fixed`/`accepted-risk` leave the set.
 */
export function computeOpenSet(records: readonly DesignReviewIssueRecord[]): DesignReviewIssueRecord[] {
  return records.filter(
    (r) => r.status === undefined || !CLOSED_STATUSES.has(r.status as IssueStatus),
  );
}

/** Evaluation outcome of the cross-round no-progress check (F4). */
export interface NoProgressEvaluation {
  verdict: "progress" | "no-progress" | "exhausted";
  /** Consecutive no-progress rounds INCLUDING the current one (0 ⇒ progress). */
  streak: number;
}

/**
 * Evaluate one round against the STORED previous ledger (F4 / R3-Q4 B):
 * - no previous snapshot OR a different `loop` identity ⇒ progress with
 *   streak 0 (callers audit `no_progress_loop_mismatch`, 问题 20);
 * - the open set SHRANK ⇒ progress (streak resets);
 * - otherwise the streak extends by 1 and turns `exhausted` once the
 *   granted grace rounds are used up (`streak > grace`).
 */
export function evaluateNoProgress(
  prev: ReviewProgressSnapshot | undefined,
  next: ReviewProgressSnapshot,
  grace: number,
): NoProgressEvaluation {
  if (prev === undefined || prev.loop !== next.loop) {
    return { verdict: "progress", streak: 0 };
  }
  if (next.openIds.length < prev.openIds.length) {
    return { verdict: "progress", streak: 0 };
  }
  const streak = (prev.streak ?? 0) + 1;
  if (streak > grace) return { verdict: "exhausted", streak };
  return { verdict: "no-progress", streak };
}
