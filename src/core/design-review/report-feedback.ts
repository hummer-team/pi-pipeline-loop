/**
 * @module design-review/report-feedback
 * 193 Phase 0 (requirement 193 Q1-A/Q5-A, review round-1 issue 3): report-only
 * CORRECTIVE feedback for an invalid design-review REPORT.
 *
 * Why this exists: the generic verification hint ("please strictly follow the
 * SKILL output format requirements") never shows the model WHAT the current
 * report is missing or WHICH identity it must carry, so every retry repeats the
 * same defect. This module renders the guidance from the TRUSTED narrowed
 * context (persisted meta) — identity values are never reverse-inferred from
 * failure prose — and is used exclusively for report-domain failures:
 * update-invalid, other stages and ordinary rules keep their existing text.
 *
 * Pure renderer: no I/O, no meta writes, no dispatch, no budget accounting. The
 * caller (verify-advance) owns the existing retry budget/freeze/wake policy.
 */

import type { PipelineStage, SessionMeta, VerifyFailureItem } from "../../types";
import { deriveDomainVerificationContext } from "./verification-context";
import {
  DESIGN_REVIEW_IDENTITY_FIELDS,
  requiredReportSections,
} from "./report-contract";

/** ruleType the trusted auto-verifier attaches to design-review REPORT defects. */
export const DESIGN_REVIEW_REPORT_RULE_TYPE = "designReviewReport";

/**
 * True when these failures are design-review REPORT structure/attribution
 * failures for the CURRENT authoritative meta (trusted review context present).
 * An update deliverable (`designReviewUpdate`) or any other stage never matches,
 * so the report template cannot leak into unrelated feedback (193 task 4).
 */
export function isDesignReviewReportFailure(input: {
  meta: SessionMeta;
  stageName: PipelineStage;
  failures: readonly Pick<VerifyFailureItem, "ruleType">[];
}): boolean {
  if (input.stageName !== "design-review") return false;
  if (!input.failures.some((f) => f.ruleType === DESIGN_REVIEW_REPORT_RULE_TYPE)) return false;
  const context = deriveDomainVerificationContext(input.meta);
  return context !== null && context.kind === "review";
}

/** Rendered corrective guidance for one invalid design-review report. */
export interface DesignReviewReportFeedback {
  /** The report path the model must fix (canonical absolute path) */
  reportDoc: string;
  /** Concrete defects reported by the trusted verifier */
  failures: string[];
  /** Full corrective instruction (single line per section, ready to display) */
  message: string;
}

/**
 * Build the corrective feedback for an invalid design-review report.
 *
 * Returns `null` when the failures are NOT a report-domain failure for the
 * current authoritative context (caller then keeps its ordinary text).
 *
 * @param opts.reportDoc - Report path from the TRUSTED context (never inferred
 *   from failure text, so a stale/wrong path can never be echoed back)
 */
export function buildDesignReviewReportFeedback(opts: {
  meta: SessionMeta;
  stageName: PipelineStage;
  failures: readonly VerifyFailureItem[];
}): DesignReviewReportFeedback | null {
  if (!isDesignReviewReportFailure(opts)) return null;
  const context = deriveDomainVerificationContext(opts.meta);
  if (!context || context.kind !== "review") return null;

  // 193 Phase 1: when the CURRENT review operation was prepared in smart
  // mode, the corrective feedback also states the conditional plan-revision
  // decision requirement (legacy unpinned operations resolve honestly: the
  // verifier's concrete failure line remains the authoritative hint).
  const smartMode = opts.meta.designReview?.operation?.reviewConfirmMode === "smart";
  // the corrective copy lists the SAME required sections the
  // verifier demands — a round that owes a closure restatement is told so.
  const requireIssueLedger = hasIssueLedgerDebt(opts.meta);
  const message = renderReportFeedback(context, opts.failures, smartMode, requireIssueLedger);
  return { reportDoc: context.reportPath, failures: opts.failures.map((f) => f.detail), message };
}

/**
 * TRUE when the CURRENT round must restate a previous
 * open set (a `## Issue Ledger` obligation). Mirrors the verifier's own
 * `requireIssueLedger` input so the feedback and the check agree.
 */
function hasIssueLedgerDebt(meta: SessionMeta): boolean {
  const state = meta.designReview;
  if (state === undefined) return false;
  if (state.legacyCarryOver !== undefined && state.legacyCarryOver.length > 0) return true;
  const ledger = state.progressLedger;
  return ledger !== undefined && ledger.openIds.length > 0;
}

/** The five identity rows this review operation MUST carry, with real values. */
function identityRows(context: {
  pipelineId: string;
  planDoc: string;
  round: number;
  operationId: string;
  inputHash: string;
}): string[] {
  return [
    `**pipeline**: ${context.pipelineId}`,
    `**plan**: ${context.planDoc}`,
    `**round**: ${context.round}`,
    `**operation**: ${context.operationId}`,
    `**input hash**: ${context.inputHash}`,
  ];
}

/**
 * Complete four-section example, anchored on the CURRENT identity values.
 * Section headings are listed with their accepted aliases (the contract is
 * order-insensitive and spacing/case tolerant), and the no-issues sentinel is
 * stated explicitly because an EMPTY Issues section is never "no issues".
 */
function renderReportFeedback(
  context: {
    reportPath: string;
    planDoc: string;
    pipelineId: string;
    round: number;
    operationId: string;
    inputHash: string;
  },
  failures: readonly VerifyFailureItem[],
  smartMode: boolean,
  requireIssueLedger: boolean,
): string {
  const identity = identityRows(context);
  const block: string[] = [];
  const push = (line = ""): void => {
    block.push(line);
  };

  push(`Design-review report ${context.reportPath} is NOT a valid complete review report.`);
  push("Defects:");
  for (const f of failures) push(`  - ${f.detail}`);
  push();
  push("Fix ONLY this report file, in place. Do not update the plan, do not create any other");
  push("document and do not change the stage: an invalid report is a FORMAT problem, never a");
  push("review verdict, and it must never be routed to develop.");
  push();
  push("Identity this report MUST carry (bound to the CURRENT review operation):");
  for (const row of identity) push(`  ${row}`);
  const aliasNote = DESIGN_REVIEW_IDENTITY_FIELDS.filter((f) => f.humanAliases.length > 0)
    .map((f) => `**${f.label}** (also accepted: ${f.humanAliases.join(", ")})`)
    .join("; ");
  if (aliasNote !== "") push(`Aliases: ${aliasNote}.`);
  push();
  // the blocking-set gate has two dedicated
  // corrective lines when the report fails record legality.
  const failureText = failures.map((f) => f.detail).join(" ");
  if (failureText.includes("is missing a legal severity")) {
    push("Severity is REQUIRED on every issue: fill the Severity column of the Issues table");
    push("with ONE of Blocker | High | Medium | Low (uppercase, exact tokens) for each id.");
    push();
  }
  if (failureText.includes("requires Evidence")) {
    push("Blocking issues (Blocker/High) MUST cite Evidence: the exact failing command,");
    push("assertion or commit that proves the problem — 'unknown' or empty evidence is not");
    push("accepted, because blocking items always fail the verdict.");
    push();
  }
  push("Required sections — each EXACTLY once, any order, spacing/case free, and each with");
  push("real content (blank lines, unfilled {placeholders}, code blocks, blockquotes and HTML");
  push("comments do NOT count):");
  // the required list is shared with the section
  // checker (`requiredReportSections(options)`) — a required Issue Ledger
  // renders here too, so the corrective copy can never disagree with the check.
  for (const spec of requiredReportSections({ requireIssueLedger })) {
    push(`  - ${spec.label}: ${spec.headingHint}`);
  }
  push();
  push("Follow this shape exactly:");
  push("```markdown");
  push("# Design Review Report");
  push();
  for (const row of identity) push(row);
  push();
  push("## Summary");
  push();
  push("[What was reviewed, against which requirement/plan, and the overall assessment.]");
  push();
  push("## Issues");
  push();
  push("| ID | Severity | Evidence | Summary |");
  push("| --- | --- | --- | --- |");
  push(`| ${`DR-${context.round}-1`} | Blocker | <command / assertion / commit> | <one concrete problem> |`);
  push();
  push("[When there are NO issues write exactly: None — an empty Issues section is never");
  push("interpreted as no issues. Severity is REQUIRED on every issue; a Blocker or High");
  push("issue additionally requires Evidence. PASS = `None` or no blocking issue.]");
  push();
  push("## Recommendations");
  push();
  push("[Actionable recommendations for the plan author.]");
  push();
  push("## Verdict");
  push();
  push("**Design Review: PASS**");
  push("[PASS = `None` or no blocking issue; it is NOT automatic “any issue ⇒ FAIL”.]");
  push("```");

  if (smartMode) {
    push();
    push("SMART decision mode governs this review: a FAIL verdict must additionally carry");
    push("EXACTLY ONE decision section (a PASS report never includes it):");
    push("```markdown");
    push("## Plan Revision Decision");
    push();
    push("**action**: revise-plan");
    push("**reason**: <replace this line with one real justification>");
    push("```");
    push('Allowed actions: revise-plan | request-human ("proceed-develop" is NEVER valid —');
    push("a FAIL cannot release development; an ambiguous, duplicated, empty or placeholder");
    push("variant keeps the report INVALID).");
  }

  return block.join("\n");
}
