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
import type { DesignReviewIssueRecord, ReviewIssue } from "../../types";
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
import {
  hasEvidence,
  isBlockingSeverity,
  scanIssuesSection,
} from "../design-review/issue-ledger";
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

function sameCanonicalPath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
}

/**
 * 229 Phase 1 (B18): canonical issue extraction over a report SNAPSHOT.
 * Delegates to the SAME header-aware single-pass scan the verdict uses
 * (inert-line exclusion, heading-scoped section, exact whole-item sentinels)
 * so report-path consumers (coordinator recovery) never fall back to a second,
 * weaker parser. `round` binds generated stable ids (`DR-<round>-n`).
 */
export function extractDesignReviewIssueItems(
  content: string,
  issueHeadingPattern?: string,
  round = 1,
): ReviewIssue[] {
  const lines = stripInertLines(content);
  const section = extractReportSection(lines, compileHeadingRe(issueHeadingPattern, DEFAULT_ISSUE_HEADING_PATTERN));
  if (!section) return [];
  return scanIssuesSection(section.lines, round).records.map((r) => ({
    issueId: r.id,
    text: r.text,
  }));
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
    /**
     * 229 Phase 1 (F1/B11): blocking-set gate. Default TRUE — a verdict is
     * gated on BLOCKING issues (Blocker/High with Evidence) instead of "any
     * valid issue ⇒ FAIL". Pass `false` ONLY in tests/rollback to restore the
     * pre-229 verdict semantics verbatim (legacy reads of old templates).
     */
    severityGate?: boolean;
    /**
     * 229 Phase 2 (F2): require the cross-round `## Issue Ledger` and enforce
     * closure over `previousOpenIssues`. Phase 1 only reserves the option.
     */
    requireIssueLedger?: boolean;
    /** 229 Phase 2 (F2): previous round's open/carry-over records (closure input). */
    previousOpenIssues?: readonly DesignReviewIssueRecord[];
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

  // 229 Phase 1 (F1/B18): ONE header-aware enumeration (issue-ledger scan).
  // Sentinels are stripped BEFORE record construction (问题 11); stable ids
  // (`DR-<round>-n`) are shared with the report/ledger/receipt end-to-end.
  const scan = scanIssuesSection(issuesSection.lines, expectation.round);
  const records = scan.records;
  const issues: ReviewIssue[] = records.map((r) => ({ issueId: r.id, text: r.text }));
  const sentinelPresent = scan.sentinelPresent;

  if (issuesSection.empty && seen.length > 0) {
    return {
      verdict: "invalid",
      failures: ["Issues heading present but EMPTY — empty issues section is invalid"],
      reportHash,
    };
  }

  // ── 5. Decision order (229 F1 strict order) ──────────────────────────────
  const hasPass = seen.some((s) => s.value === "pass");
  const hasFail = seen.some((s) => s.value === "fail");

  // Rule 2 (kept verbatim): PASS needs the sentinel when the section carries
  // no candidate items at all (raw count includes sentinel lines).
  if (hasPass && !sentinelPresent && scan.rawItemCount === 0) {
    return {
      verdict: "invalid",
      failures: ["PASS without an explicit no-issues sentinel item"],
      reportHash,
    };
  }

  const severityGateOn = options?.severityGate !== false;
  if (severityGateOn) {
    // Rule 3 (两轨一致): record legality — every non-sentinel record needs a
    // legal severity; blocking records additionally need Evidence.
    const legality: string[] = [];
    for (const r of records) {
      if (r.severity === undefined) {
        legality.push(
          `issue "${r.id}" is missing a legal severity (Blocker | High | Medium | Low required)`,
        );
        continue;
      }
      if (isBlockingSeverity(r.severity) && !hasEvidence(r)) {
        legality.push(
          `blocking issue "${r.id}" (${r.severity}) requires Evidence (command / assertion / commit)`,
        );
      }
    }
    if (legality.length > 0) {
      return { verdict: "invalid", failures: legality, reportHash };
    }

    // Rule 4: ANY blocking issue ⇒ fail — even under a PASS conclusion.
    const blocking = records.filter((r) => isBlockingSeverity(r.severity));
    if (blocking.length > 0) {
      const passAlsoPresent = hasPass;
      const blockingText = blocking.map((r) => r.id).join(", ");
      const base = {
        reportHash,
        issues,
        reason: passAlsoPresent
          ? "blocking issues present — issues take precedence over PASS conclusion"
          : `blocking issues present: ${blockingText}`,
      };
      return applySmartDecisionGate(base, lines, options?.smartDecisionMode);
    }
  } else if (issues.length > 0) {
    // severityGate:false — pre-229 verdict rule verbatim: any valid issue fails.
    const passAlsoPresent = seen.some((s) => s.value === "pass");
    return applySmartDecisionGate(
      {
        reportHash,
        issues,
        reason: passAlsoPresent
          ? "valid issues present — issues take precedence over PASS conclusion"
          : "valid issues present",
      },
      lines,
      options?.smartDecisionMode,
    );
  }

  // Rule 5: verdict branches (mutually exclusive check kept verbatim).
  if (hasPass && hasFail) {
    return { verdict: "invalid", failures: ["mutually exclusive PASS and FAIL conclusions"], reportHash };
  }
  if (hasPass) {
    return { verdict: "pass", reportHash, issues, reason: "canonical single PASS conclusion" };
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
  return { verdict: "invalid", failures: ["no recognized verdict conclusion line"], reportHash };
}
