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
  DESIGN_REVIEW_REPORT_SECTIONS,
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
  const message = renderReportFeedback(context, opts.failures, smartMode);
  return { reportDoc: context.reportPath, failures: opts.failures.map((f) => f.detail), message };
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
  push("Required sections — each EXACTLY once, any order, spacing/case free, and each with");
  push("real content (blank lines, unfilled {placeholders}, code blocks, blockquotes and HTML");
  push("comments do NOT count):");
  for (const spec of DESIGN_REVIEW_REPORT_SECTIONS) push(`  - ${spec.label}: ${spec.headingHint}`);
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
  push("[When there are NO issues write exactly: None  — otherwise one numbered item per");
  push("concrete problem. An empty Issues section is never interpreted as no issues.]");
  push();
  push("## Recommendations");
  push();
  push("[Actionable recommendations for the plan author.]");
  push();
  push("## Verdict");
  push();
  push("**Design Review: PASS**");
  push("[Use FAIL whenever any valid issue exists — valid issues always mean FAIL.]");
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
