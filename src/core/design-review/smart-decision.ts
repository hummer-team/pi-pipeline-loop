/**
 * @module design-review/smart-decision
 * 193 Phase 1: machine-readable PLAN REVISION DECISION protocol for FAIL
 * reports produced while the design-review stage runs in SMART mode.
 *
 * Contract (decided in 193, enforced by the trusted verifier over the SAME
 * report snapshot as the verdict):
 * - exactly ONE `## Plan Revision Decision` section (heading level 1–4,
 *   case/spacing tolerant, English + Chinese aliases);
 * - inside it, `**action**` is exactly one of the binary tokens
 *   `revise-plan` / `request-human` — anything else (NOTABLY `proceed-develop`,
 *   which smart mode must never be able to express) is invalid;
 * - inside it, `**reason**` is a non-empty, non-placeholder line;
 * - duplicated rows are tolerated ONLY when their values agree (the same
 *   distinct-value ambiguity rule as the identity contract);
 * - inert content (code fences / quotes / comments) cannot fake the fields —
 *   callers pass lines already cleaned by `stripInertLines`.
 *
 * Ordinary suggestion prose OUTSIDE the section is never a field. A PASS
 * report never needs this section (the caller simply does not invoke the
 * parser); non-smart modes ignore it entirely.
 */

import {
  collectReportFieldValues,
  compileHeadingRe,
  extractReportSections,
  isLazilyFilledLine,
} from "./report-sections";
import type { SmartPlanRevisionDecision } from "./decision-types";
import { SMART_PLAN_REVISION_ACTIONS } from "./decision-types";

/** Heading anchor for the decision section (English + Chinese aliases). */
export const PLAN_REVISION_DECISION_HEADING_PATTERN =
  "^#{1,4}\\s*(Plan Revision Decision|计划修订决策)\\s*$";

/** Field labels of the machine protocol (regex-alternation, case-insensitive). */
const ACTION_LABELS = ["action"];
const REASON_LABELS = ["reason"];

export type SmartDecisionParseResult =
  | { ok: true; decision: SmartPlanRevisionDecision }
  | { ok: false; failures: string[] };

/** Strip surrounding markdown emphasis and whitespace from a captured value. */
function canonicalFieldValue(value: string): string {
  return value.replace(/^\*+|\*+$/g, "").trim();
}

/**
 * A reason still wrapped in angle brackets (e.g. the copied template line
 * `<one non-empty line explaining the choice>` / `<待填写>`) is an UNFILLED
 * placeholder: real justifications are written as plain prose, not inside the
 * instruction delimiters. Complement to `isLazilyFilledLine`, which only
 * recognizes `{token}` style placeholders.
 */
function isTemplateReason(value: string): boolean {
  return /^<[^<>]*>$/.test(value);
}

/**
 * Parse the plan-revision decision from cleaned report lines.
 *
 * Pure over the SAME line snapshot the verdict was decided from — never a
 * second file read. Returns aggregate failures (all defects at once) so the
 * corrective feedback tells the reviewer exactly what to fix; the caller
 * treats any failure as INVALID (correction), never as FAIL (routing).
 */
export function parseDesignReviewSmartDecision(
  lines: readonly string[],
): SmartDecisionParseResult {
  const failures: string[] = [];
  const headingRe = compileHeadingRe(undefined, PLAN_REVISION_DECISION_HEADING_PATTERN);
  const sections = extractReportSections(lines, headingRe);

  if (sections.length === 0) {
    return {
      ok: false,
      failures: [
        "missing ## Plan Revision Decision section — a FAIL report under smart decision mode MUST carry exactly one",
      ],
    };
  }
  if (sections.length > 1) {
    return {
      ok: false,
      failures: [
        `## Plan Revision Decision section appears ${sections.length} times — exactly one is required`,
      ],
    };
  }

  const body = sections[0]!.lines;

  // ── action: binary machine token, exact value required ────────────────────
  const actionValues = [...new Set(
    collectReportFieldValues(body, ACTION_LABELS).map(canonicalFieldValue),
  )].filter((v) => v !== "");
  let action: SmartPlanRevisionDecision["action"] | undefined;
  if (actionValues.length === 0) {
    failures.push("missing **action**: field in the ## Plan Revision Decision section");
  } else if (actionValues.length > 1) {
    failures.push(
      `mutually exclusive **action** values in the ## Plan Revision Decision section: ${actionValues.join(", ")}`,
    );
  } else {
    const token = actionValues[0]!;
    if ((SMART_PLAN_REVISION_ACTIONS as readonly string[]).includes(token)) {
      action = token as SmartPlanRevisionDecision["action"];
    } else if (token === "proceed-develop") {
      failures.push(
        "unknown **action** token \"proceed-develop\" — allowed: revise-plan | request-human " +
          "(a FAIL report can NEVER release development; smart mode does not auto-advance on FAIL)",
      );
    } else {
      failures.push(
        `unknown **action** token "${token}" — allowed: ${SMART_PLAN_REVISION_ACTIONS.join(" | ")}`,
      );
    }
  }

  // ── reason: one non-empty, non-placeholder justification ─────────────────
  const reasonRows = collectReportFieldValues(body, REASON_LABELS);
  const reasonValues = [...new Set(reasonRows.map(canonicalFieldValue))].filter((v) => v !== "");
  let reason: string | undefined;
  if (reasonValues.length === 0) {
    failures.push(
      reasonRows.length > 0
        ? "**reason** is empty or an unfilled placeholder in the ## Plan Revision Decision section"
        : "missing **reason**: field in the ## Plan Revision Decision section",
    );
  } else if (reasonValues.length > 1) {
    failures.push(
      `mutually exclusive **reason** values in the ## Plan Revision Decision section: ${reasonValues.join(" | ")}`,
    );
  } else if (isLazilyFilledLine(reasonValues[0]!) || isTemplateReason(reasonValues[0]!)) {
    failures.push(
      "**reason** is empty or an unfilled placeholder in the ## Plan Revision Decision section",
    );
  } else {
    reason = reasonValues[0]!;
  }

  if (failures.length > 0 || action === undefined || reason === undefined) {
    return { ok: false, failures };
  }
  return { ok: true, decision: { action, reason } };
}
