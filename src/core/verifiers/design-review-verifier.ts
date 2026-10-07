/**
 * @module verifiers/design-review-verifier
 * 192 Phase 3 (K07/F02): trusted semantic verifier for design-review REPORTS.
 * 193 Phase 0 (Q5-A / final plan item 5): the SAME snapshot now also satisfies
 * the COMPLETE report structure contract before any routing verdict is derived.
 *
 * Pure over a caller-provided content SNAPSHOT (single read upstream): this
 * module never reads files, globs directories, writes meta or dispatches.
 * It decides the domain verdict from the SAME content that produced
 * reportHash, bound to the CURRENT run identity:
 *
 * - identity fields (canonical full-field comparison, never basename/includes):
 *     **pipeline**: {pipelineId}
 *     **plan**: {absolute planDoc}
 *     **round**: {round}
 *     **operation**: {review operationId}
 *     **input hash**: {review inputHash == authorized plan content hash}
 *   Attribution/contract unverifiable ⇒ invalid.
 * - structure contract (193): Summary / Issues / Recommendations / Verdict each
 *   present EXACTLY ONCE with substantive content (order and spacing free);
 *   unfilled placeholders, blank bodies and inert examples never count.
 * - verdict: taken ONLY from verdict-pattern matches on content lines outside
 *   fenced code / blockquotes / HTML comments. A "PASS" word in a Summary
 *   body is NOT a verdict line (patterns are anchored). Unknown capture
 *   tokens never default to pass.
 * - issues: extracted from the `## Issues` heading section over the SAME
 *   cleaned content. The sentinel for "no issues" is an EXACT whole-item
 *   "None"/"无"; "无法恢复…" is still a real issue.
 * - decision order:
 *     1. attribution/version unverifiable → invalid
 *     2. incomplete structure (missing/empty/duplicated section) → invalid
 *     3. valid non-empty issues → fail (even when a PASS line also exists)
 *     4. no issues + mutually exclusive PASS & FAIL → invalid
 *     5. canonical single PASS → pass; single FAIL → fail
 *     6. empty issues heading / unknown token / no conclusion → invalid
 *   193 Phase 1: at step 3/5 a FAIL additionally passes the SMART decision
 *   gate — under `smartDecisionMode` the SAME snapshot must carry exactly
 *   one valid `## Plan Revision Decision` (binary action + real reason),
 *   otherwise the verdict becomes INVALID (correction, never routing).
 *   PASS is exempt; non-smart consumers keep the historical behaviour.
 *
 * The mechanical inert-line cleaning and section extraction live in
 * `design-review/report-sections.ts` and the section/identity policy in
 * `design-review/report-contract.ts` — this module keeps re-exporting the
 * historical helpers so existing consumers stay source-compatible, and never
 * grows a second, weaker parser.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ReviewIssue } from "../../types";
import {
  DEFAULT_ISSUE_HEADING_PATTERN,
  compileHeadingRe,
  extractReportSection,
  stripInertLines,
} from "../design-review/report-sections";
import {
  checkDesignReviewReportIdentity,
  checkDesignReviewReportSections,
  findDesignReviewIdentityValue,
} from "../design-review/report-contract";
import { parseDesignReviewSmartDecision } from "../design-review/smart-decision";
import type { SmartPlanRevisionDecision } from "../design-review/decision-types";

/** Historical export (192): inert-line cleaning shared with the contract. */
export { DEFAULT_ISSUE_HEADING_PATTERN, stripInertLines };

/** Expected identity binding for the CURRENT review operation. */
export interface DesignReviewReportExpectation {
  pipelineId: string;
  /** Canonical absolute plan path */
  planDoc: string;
  round: number;
  /** Review operation id; when provided the report MUST carry it */
  operationId?: string;
  /** Review inputHash (authorized plan content hash); must appear when known */
  inputHash?: string;
}

export type DesignReviewReportVerdict =
  | {
      verdict: "pass" | "fail";
      reportHash: string;
      issues: ReviewIssue[];
      reason: string;
      /**
       * 193 Phase 1: machine plan-revision decision verified from the SAME
       * snapshot. Present ONLY on a FAIL verdict when `smartDecisionMode`
       * was requested and the section parsed cleanly; never present on PASS
       * or for non-smart consumers.
       */
      smartDecision?: SmartPlanRevisionDecision;
    }
  | { verdict: "invalid"; failures: string[]; reportHash?: string };

/**
 * Default anchored verdict patterns (capture group 1). Business verify.md
 * `runtime: verdict` anchor patterns REPLACE these when the contract is
 * usable; the default set mirrors the shipped template. Anchoring (full-line
 * patterns) is what keeps prose "PASS" from acting as a verdict.
 */
export const DEFAULT_DESIGN_REVIEW_VERDICT_PATTERNS: readonly string[] = [
  "结论\\s*[:：]\\s*[*_]{0,2}(不通过|通过)[*_]{0,2}",
  "Verdict\\s*[:：]\\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}",
  "Conclusion\\s*[:：]\\s*[*_]{0,2}(?!(?:PASS|FAIL)\\b)(pass|fail)[*_]{0,2}",
  "\\*\\*Design Review[:：]\\s*(PASS|FAIL)\\*\\*",
  "\\*\\*设计评审[:：]\\s*(通过|不通过)\\*\\*",
];

export function computeReportHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Extract list/table issue items from the Issues section body. */
function parseIssueItems(sectionLines: readonly string[]): string[] {
  const items: string[] = [];
  for (const line of sectionLines) {
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      items.push(bullet[1]!.trim());
      continue;
    }
    const tableRow = line.match(/^\s*\|(.+)\|\s*$/);
    if (tableRow && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      const cells = tableRow[1]!.split("|").map((c) => c.trim());
      const first = cells[0]?.toLowerCase() ?? "";
      if (first === "#" || first === "issue" || first === "问题" || first === "") continue;
      // Prefer the "Issue" column when a 3+ column table is used
      const text = cells.length >= 2 ? (cells[1] ?? cells[0]!) : cells[0]!;
      if (text && text.toLowerCase() !== "issue") items.push(text);
      continue;
    }
    // Bare (non-list, non-heading, non-table) non-empty lines in the Issues
    // section count as items — the canonical no-issues sentinel ("None"/"无")
    // is written this way and MUST be visible to the sentinel check.
    const trimmed = line.trim();
    if (trimmed !== "" && !/^#/.test(trimmed)) {
      items.push(trimmed);
    }
  }
  return items;
}

function sameCanonicalPath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
}

/** Exact whole-item sentinels meaning "no issues". */
const NO_ISSUE_SENTINELS = new Set(["none", "无", "n/a", "not applicable"]);

/** Keep only valid issue items: exact whole-item "None"/"无"-style sentinels
 *  drop out; everything else ("无法恢复…", "nonequivalent") stays an issue. */
function filterValidIssueItems(rawItems: readonly string[]): ReviewIssue[] {
  const out: ReviewIssue[] = [];
  for (const item of rawItems) {
    const normalized = item.replace(/\*\*|__/g, "").trim().toLowerCase();
    if (NO_ISSUE_SENTINELS.has(normalized)) continue;
    out.push({ issueId: String(out.length + 1), text: item });
  }
  return out;
}

/**
 * 192 fix (issue 3): canonical issue extraction over a report SNAPSHOT.
 * Exposes the SAME semantics the snapshot verdict uses (inert-line exclusion,
 * heading-scoped section, exact whole-item sentinels) so report-path consumers
 * (coordinator recovery) never fall back to a second, weaker parser.
 */
export function extractDesignReviewIssueItems(
  content: string,
  issueHeadingPattern?: string,
): ReviewIssue[] {
  const lines = stripInertLines(content);
  const section = extractReportSection(lines, compileHeadingRe(issueHeadingPattern, DEFAULT_ISSUE_HEADING_PATTERN));
  if (!section) return [];
  return filterValidIssueItems(parseIssueItems(section.lines));
}

/** Map a captured verdict token to pass/fail (不通过/FAIL/fail → fail). */
function tokenToVerdict(token: string): "pass" | "fail" {
  if (token === "不通过") return "fail";
  if (/^fail$/i.test(token)) return "fail";
  if (/^通过$/.test(token) || /^pass$/i.test(token)) return "pass";
  return "fail"; // unreachable: patterns capture only known tokens
}

/** True when the token is recognized by the verdict vocabulary. */
function isKnownVerdictToken(token: string): boolean {
  return /^(PASS|FAIL|通过|不通过|pass|fail)$/i.test(token);
}

/**
 * 193 Phase 1 (tasks 5/6): SMART-mode FAIL gate applied to the SAME cleaned
 * snapshot the verdict was decided from. A FAIL under smart decision mode
 * MUST carry exactly one valid `## Plan Revision Decision`; missing or
 * malformed ⇒ INVALID (corrective feedback path), never routed. Non-smart
 * consumers get the historical FAIL untouched. PASS never calls this gate.
 */
function applySmartDecisionGate(
  fail: { reportHash: string; issues: ReviewIssue[]; reason: string },
  lines: readonly string[],
  smartDecisionMode: boolean | undefined,
): DesignReviewReportVerdict {
  if (!smartDecisionMode) {
    return { verdict: "fail", ...fail };
  }
  const parsed = parseDesignReviewSmartDecision(lines);
  if (!parsed.ok) {
    return { verdict: "invalid", failures: parsed.failures, reportHash: fail.reportHash };
  }
  return { verdict: "fail", ...fail, smartDecision: parsed.decision };
}

/**
 * Verify a design-review report SNAPSHOT against the current review identity.
 * verdictPatterns/issueHeadingPattern let the loaded verify.md contract drive
 * the shapes (declaration is behavior); when omitted the built-in defaults
 * (mirroring the shipped template) apply. smartDecisionMode (193 Phase 1)
 * additionally requires a valid plan-revision decision on FAIL verdicts.
 */
export function verifyDesignReviewReportSnapshot(
  content: string,
  expectation: DesignReviewReportExpectation,
  options?: {
    verdictPatterns?: readonly string[];
    issueHeadingPattern?: string;
    smartDecisionMode?: boolean;
  },
): DesignReviewReportVerdict {
  const reportHash = computeReportHash(content);
  const failures: string[] = [];
  const lines = stripInertLines(content);
  const contractOptions = {
    issueHeadingPattern: options?.issueHeadingPattern,
    requireOperation: expectation.operationId !== undefined,
    requireInputHash: expectation.inputHash !== undefined,
  };

  // ── 1. Identity/attribution ────────────────────────────────────────────────
  // 193 Phase 0: presence, alias acceptance and duplicate-row ambiguity are
  // POLICY and live in design-review/report-contract.ts (single alias table);
  // this module keeps only the canonical VALUE comparison, because only it
  // knows the CURRENT run's values.
  const identityFailures = checkDesignReviewReportIdentity(lines, contractOptions);
  if (identityFailures.length > 0) {
    return { verdict: "invalid", failures: identityFailures, reportHash };
  }

  const pipelineField = findDesignReviewIdentityValue(lines, "pipeline");
  if (pipelineField !== expectation.pipelineId) {
    failures.push(
      `pipeline identity mismatch: report="${pipelineField ?? ""}" current="${expectation.pipelineId}"`,
    );
  }

  const planField = findDesignReviewIdentityValue(lines, "plan");
  if (planField === undefined || !sameCanonicalPath(planField, expectation.planDoc)) {
    failures.push("plan identity mismatch: report references a different plan document");
  }

  const roundField = findDesignReviewIdentityValue(lines, "round");
  if (roundField !== String(expectation.round)) {
    failures.push(`round identity mismatch: report="${roundField ?? ""}" current="${expectation.round}"`);
  }

  if (expectation.operationId !== undefined) {
    const opField = findDesignReviewIdentityValue(lines, "operation");
    if (opField !== expectation.operationId) {
      failures.push("operation identity mismatch: report belongs to a different review operation");
    }
  }

  if (expectation.inputHash !== undefined) {
    const hashField = findDesignReviewIdentityValue(lines, "inputHash");
    if (hashField !== expectation.inputHash) {
      failures.push("input hash mismatch: report was produced against a different plan version");
    }
  }

  if (failures.length > 0) {
    return { verdict: "invalid", failures, reportHash };
  }

  // ── 2. 193 Phase 0: complete structure contract over the SAME snapshot ────
  const structureFailures = checkDesignReviewReportSections(lines, contractOptions);
  if (structureFailures.length > 0) {
    return { verdict: "invalid", failures: structureFailures, reportHash };
  }

  // ── 3. Verdict candidates (anchored patterns only) ────────────────────────
  const verdictPatterns = options?.verdictPatterns && options.verdictPatterns.length > 0
    ? options.verdictPatterns
    : DEFAULT_DESIGN_REVIEW_VERDICT_PATTERNS;

  const seen: Array<{ value: "pass" | "fail"; token: string; line: string }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    for (const p of verdictPatterns) {
      let re: RegExp;
      try {
        re = new RegExp(p, "i");
      } catch {
        // Invalid regex in the contract → fail-closed for the domain verdict
        return { verdict: "invalid", failures: [`invalid verdict pattern in contract: ${p}`], reportHash };
      }
      const m = re.exec(trimmed);
      if (m && m[1] !== undefined) {
        if (!isKnownVerdictToken(m[1])) {
          // Unknown capture token NEVER defaults to pass
          return {
            verdict: "invalid",
            failures: [`unknown verdict token "${m[1]}" (no default pass) at: ${trimmed}`],
            reportHash,
          };
        }
        seen.push({ value: tokenToVerdict(m[1]), token: m[1], line: trimmed });
        break;
      }
    }
  }

  // ── 4. Issues section over the SAME cleaned content ───────────────────────
  const issueHeadingRe = compileHeadingRe(options?.issueHeadingPattern, DEFAULT_ISSUE_HEADING_PATTERN);
  const issuesSection = extractReportSection(lines, issueHeadingRe);
  if (!issuesSection) {
    // Unreachable while the structure contract runs first, kept fail-closed.
    return { verdict: "invalid", failures: ["missing Issues section heading"], reportHash };
  }

  const rawItems = parseIssueItems(issuesSection.lines);
  // Exact whole-item sentinel only; "无法恢复…" / "nonequivalent" still count
  const validIssues = filterValidIssueItems(rawItems);

  const sentinelPresent = rawItems.some((i) =>
    NO_ISSUE_SENTINELS.has(i.replace(/\*\*|__/g, "").trim().toLowerCase()),
  );

  if (issuesSection.empty && seen.length > 0) {
    return {
      verdict: "invalid",
      failures: ["Issues heading present but EMPTY — empty issues section is invalid"],
      reportHash,
    };
  }

  // ── 5. Decision order ──────────────────────────────────────────────────────
  if (validIssues.length > 0) {
    // Issues take precedence: even a PASS conclusion cannot mask valid issues
    const passAlsoPresent = seen.some((s) => s.value === "pass");
    return applySmartDecisionGate(
      {
        reportHash,
        issues: validIssues,
        reason: passAlsoPresent
          ? "valid issues present — issues take precedence over PASS conclusion"
          : "valid issues present",
      },
      lines,
      options?.smartDecisionMode,
    );
  }

  const hasPass = seen.some((s) => s.value === "pass");
  const hasFail = seen.some((s) => s.value === "fail");
  if (hasPass && hasFail) {
    return { verdict: "invalid", failures: ["mutually exclusive PASS and FAIL conclusions"], reportHash };
  }
  if (seen.length > 1 && hasPass && !hasFail) {
    // multiple PASS lines are tolerated (same conclusion repeated)
    return { verdict: "pass", reportHash, issues: [], reason: "canonical single PASS conclusion" };
  }
  if (hasFail) {
    return applySmartDecisionGate(
      {
        reportHash,
        // A FAIL conclusion with no issue items: issues MUST have been provided —
        // the section was empty of real items; FAIL without items is ambiguous
        // unless the section carried only the sentinel (then it would be PASS-side
        // exclusive) — keep fail with empty issues (consumer requires items).
        issues: [],
        reason: "FAIL conclusion without issue items",
      },
      lines,
      options?.smartDecisionMode,
    );
  }
  if (hasPass) {
    if (!sentinelPresent && rawItems.length === 0) {
      return {
        verdict: "invalid",
        failures: ["PASS without an explicit no-issues sentinel item"],
        reportHash,
      };
    }
    return { verdict: "pass", reportHash, issues: [], reason: "canonical single PASS conclusion" };
  }
  return { verdict: "invalid", failures: ["no recognized verdict conclusion line"], reportHash };
}
