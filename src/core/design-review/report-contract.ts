/**
 * @module design-review/report-contract
 * 193 Phase 0 (requirement 193 Q5-A / round-4 final plan item 5): the COMPLETE
 * structure contract for a design-review REPORT, applied by the trusted
 * verifier over the SAME snapshot it already uses
 * (identity → structure → verdict/issue semantics).
 *
 * Rules (and their limits):
 * - Five identity rows MUST be present, filled and non-contradictory:
 *   `**pipeline**`, `**plan**`, `**round**`, `**operation**` (alias
 *   `**operationId**`), `**input hash**` (aliases `**baselinePlanHash**`,
 *   `**输入版本**`, `**计划 hash**`). Equality with the CURRENT run's values is
 *   enforced by the verifier, never here.
 * - Exactly ONE heading each for Summary / Issues / Recommendations / Verdict.
 *   Bilingual aliases are accepted (摘要/总结, 问题/问题列表, 建议/修改建议,
 *   结论/判定). The Issues anchor honours the `runtime: issueHeading` pattern
 *   declared in the deployed verify.md (declaration is behavior).
 * - Section content must be SUBSTANTIVE: blank lines, markdown decoration,
 *   unfilled `{placeholder}` tokens and inert content (fenced code, block
 *   quotes, HTML comments — already stripped upstream) do NOT count.
 * - Section ORDER, spacing and case are irrelevant. Nothing here re-implements
 *   the verdict decision, the no-issues sentinel semantics or any severity
 *   based release logic (193 keeps "any valid issue ⇒ FAIL").
 *
 * Pure over a cleaned snapshot; performs no I/O and returns no verdict.
 */

import {
  DEFAULT_ISSUE_HEADING_PATTERN,
  collectReportFieldValues,
  extractReportSections,
  findReportField,
  hasSubstantiveContent,
} from "./report-sections";

/** Which identity row a spec describes (also the verifier's comparison kind). */
export type DesignReviewIdentityFieldKey = "pipeline" | "plan" | "round" | "operation" | "inputHash";

/** Identity row specification: canonical label plus accepted alias fragments. */
export interface DesignReviewIdentityFieldSpec {
  key: DesignReviewIdentityFieldKey;
  /** Canonical label, used in messages and field lookups */
  label: string;
  /** Row label fragments (regex-safe), canonical first, then legacy aliases */
  aliases: readonly string[];
  /** Plain-language aliases for corrective feedback (never regex) */
  humanAliases: readonly string[];
}

/**
 * The five identity rows a design-review report must carry. Alias content and
 * order are unchanged from the pre-193 verifier, so previously accepted (and
 * previously rejected) shapes keep behaving identically.
 */
export const DESIGN_REVIEW_IDENTITY_FIELDS: readonly DesignReviewIdentityFieldSpec[] = [
  { key: "pipeline", label: "pipeline", aliases: ["pipeline"], humanAliases: [] },
  { key: "plan", label: "plan", aliases: ["plan"], humanAliases: [] },
  { key: "round", label: "round", aliases: ["round"], humanAliases: [] },
  {
    key: "operation",
    label: "operation",
    aliases: ["operation", "operationId"],
    humanAliases: ["operationId"],
  },
  {
    key: "inputHash",
    label: "input hash",
    aliases: ["input hash", "input\\s*hash", "输入版本", "计划\\s*hash", "baselinePlanHash"],
    humanAliases: ["baselinePlanHash", "输入版本", "计划 hash"],
  },
];

/** Canonical report sections (193: all four are mandatory). */
export type DesignReviewReportSectionKey = "summary" | "issues" | "recommendations" | "verdict";

/** Heading specification for one mandatory section. */
export interface DesignReviewReportSectionSpec {
  key: DesignReviewReportSectionKey;
  /** Human-readable name used in messages */
  label: string;
  /** Built-in heading pattern; the Issues entry is contract-overridable */
  headingPattern: string;
  /** Hint shown in corrective messages (canonical heading + aliases) */
  headingHint: string;
}

/**
 * Mandatory section headings. Anchoring is strict (`^…$` over the cleaned
 * lines) so prose that merely mentions "Summary" cannot satisfy the contract.
 */
export const DESIGN_REVIEW_REPORT_SECTIONS: readonly DesignReviewReportSectionSpec[] = [
  {
    key: "summary",
    label: "Summary",
    headingPattern: "^#{1,4}\\s*(Summary|摘要|总结)\\s*$",
    headingHint: "## Summary (or ## 摘要 / ## 总结)",
  },
  {
    key: "issues",
    label: "Issues",
    headingPattern: DEFAULT_ISSUE_HEADING_PATTERN,
    headingHint: "## Issues (or ## 问题 / ## 问题列表)",
  },
  {
    key: "recommendations",
    label: "Recommendations",
    headingPattern: "^#{1,4}\\s*(Recommendations?|Suggestions?|修改建议|改进建议|建议)\\s*$",
    headingHint: "## Recommendations (or ## 建议 / ## 修改建议)",
  },
  {
    key: "verdict",
    label: "Verdict",
    headingPattern: "^#{1,4}\\s*(Verdict|Conclusion|结论|判定)\\s*$",
    headingHint: "## Verdict (or ## 结论 / ## 判定)",
  },
];

/** Options mirroring the verifier's contract-driven anchors and binding. */
export interface DesignReviewReportContractOptions {
  /** `runtime: issueHeading` pattern from the deployed verify.md (optional). */
  issueHeadingPattern?: string;
  /** Require the `**operation**` row (default true; pass false only when the
   *  current run has no operation identity to bind — legacy reads). */
  requireOperation?: boolean;
  /** Require the `**input hash**` row (default true, same condition as above). */
  requireInputHash?: boolean;
}



/**
 * Read ONE identity row's value through the shared alias policy (canonical
 * label first, legacy aliases after). This is how callers that must compare the
 * value against the CURRENT run read the row without duplicating alias lists.
 */
export function findDesignReviewIdentityValue(
  lines: readonly string[],
  key: DesignReviewIdentityFieldKey,
): string | undefined {
  const spec = DESIGN_REVIEW_IDENTITY_FIELDS.find((f) => f.key === key);
  if (spec === undefined) return undefined;
  return findReportField(lines, spec.aliases);
}

/**
 * Reject contradictory identity rows. Duplicated rows carrying the SAME value
 * are tolerated (no ambiguity); duplicated rows with DIFFERENT values are
 * rejected — one report must not assert two identities for the same field, so
 * an appended/forged row can never shadow the canonical one.
 */
export function findAmbiguousDesignReviewIdentityRows(
  lines: readonly string[],
): string[] {
  const failures: string[] = [];
  for (const field of DESIGN_REVIEW_IDENTITY_FIELDS) {
    const values = collectReportFieldValues(lines, field.aliases);
    const distinct = new Set(values);
    if (distinct.size > 1) {
      failures.push(
        `**${field.label}** identity field is ambiguous: ${[...distinct].slice(0, 3).join(" | ")}`,
      );
    }
  }
  return failures;
}

/**
 * Check the five identity rows are present, filled and non-contradictory. The
 * canonical VALUE comparison against the CURRENT run stays in the verifier
 * (only it knows the expected values), but the presence/alias policy lives here
 * so no consumer needs to duplicate the alias lists.
 */
export function checkDesignReviewReportIdentity(
  lines: readonly string[],
  options?: DesignReviewReportContractOptions,
): string[] {
  const failures: string[] = [];
  const requireOperation = options?.requireOperation !== false;
  const requireInputHash = options?.requireInputHash !== false;
  for (const field of DESIGN_REVIEW_IDENTITY_FIELDS) {
    if (field.key === "operation" && !requireOperation) continue;
    if (field.key === "inputHash" && !requireInputHash) continue;
    const values = collectReportFieldValues(lines, field.aliases);
    if (values.length === 0) {
      failures.push(`missing **${field.label}** identity field`);
      continue;
    }
  }
  failures.push(...findAmbiguousDesignReviewIdentityRows(lines));
  return failures;
}

/**
 * Check the four mandatory sections: exactly one heading each plus substantive
 * content under it. Failures are reported in contract order, independent of how
 * the report is arranged (any section order is acceptable).
 */
export function checkDesignReviewReportSections(
  lines: readonly string[],
  options?: DesignReviewReportContractOptions,
): string[] {
  const failures: string[] = [];
  for (const spec of DESIGN_REVIEW_REPORT_SECTIONS) {
    const pattern =
      spec.key === "issues"
        ? options?.issueHeadingPattern ?? spec.headingPattern
        : spec.headingPattern;
    let headingRe: RegExp;
    try {
      headingRe = new RegExp(pattern, "i");
    } catch {
      // An unusable contract anchor is fail-closed by the verifier's own
      // verdict-pattern path; fall back so the section is still checked.
      headingRe = new RegExp(spec.headingPattern, "i");
    }
    const sections = extractReportSections(lines, headingRe);
    if (sections.length === 0) {
      failures.push(`missing ${spec.label} section heading (${spec.headingHint})`);
      continue;
    }
    if (sections.length > 1) {
      failures.push(
        `${spec.label} section heading appears ${sections.length} times — exactly one ${spec.headingHint} is required`,
      );
    }
    if (!sections.some((s) => !s.empty && hasSubstantiveContent(s.lines))) {
      failures.push(
        `${spec.label} section has no content (blank lines, unfilled placeholders or inert examples do not count)`,
      );
    }
  }
  return failures;
}
