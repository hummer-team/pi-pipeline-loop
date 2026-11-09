/**
 * @module auto-pipeline/review-findings-directive
 * 229 Phase 2 (F2/B7/B9): read-only previous-findings context for the
 * design-review agent.
 *
 * Facts (boundaries):
 * - B7: this module is the findings DIRECTIVE (dispatch-time injection); the
 *   cross-round ledger PARSING base lives in
 *   `core/design-review/issue-ledger.ts`. The name avoids the 220
 *   `design-review-ledger-*` (decision台账溯源) confusion.
 * - B9: synthesis is a PURE read-time function (deterministic over the same
 *   report bytes). Persistence of a legacy carry-over happens ONLY in the
 *   coordinator; the auto-verifier stays strictly read-only.
 * - B6: BOTH tracks (auto and human) inject the previous round's open set and
 *   the declared scope — the directive content is track-agnostic.
 * - B8: the directive is appended by the coordinator when
 *   `operation.kind === "review"` only; update/develop-handoff dispatches
 *   never receive it.
 */

import * as fs from "node:fs";
import type { DesignReviewIssueRecord, DesignReviewState } from "../../types";
import { deriveReportPath } from "../design-review/state";
import {
  computeOpenSet,
  parseIssueLedgerSection,
} from "../design-review/issue-ledger";
import {
  DEFAULT_ISSUE_HEADING_PATTERN,
  compileHeadingRe,
  extractReportSection,
  stripInertLines,
} from "../design-review/report-sections";

/**
 * Pure synthesis of a LEGACY carry-over from a previous round's report bytes
 * (B9): reports without a `## Issue Ledger` get deterministic `LEGACY-<n>`
 * ids in section order. No I/O beyond the caller-provided string.
 */
export function synthesizeLegacyCarryOver(input: {
  reportContent: string;
  round: number;
}): DesignReviewIssueRecord[] {
  const lines = stripInertLines(input.reportContent);
  const section = extractReportSection(
    lines,
    compileHeadingRe(undefined, DEFAULT_ISSUE_HEADING_PATTERN),
  );
  if (!section) return [];
  const ledgerSection = extractReportSection(
    lines,
    /^#{1,4}\s*(Issue Ledger|问题台账)\s*$/i,
  );
  if (ledgerSection !== null) return []; // ledger exists — never synthesize
  const parsed = parseIssueLedgerSection(section.lines, input.round);
  return parsed.map((record, i) => ({
    ...record,
    id: `LEGACY-${String(i + 1)}`,
    origin: String(input.round),
  }));
}

/**
 * Read-only resolution of the previous round's OPEN findings (F2):
 * - `round <= 1` ⇒ `null` (no previous round — closure is skipped upstream);
 * - the round-(n-1) report carries `## Issue Ledger` ⇒ open set from the ledger;
 * - otherwise a legacy carry-over is synthesized from the `## Issues` body;
 * - unreadable/absent previous report ⇒ `null` (with `legacy: false`).
 */
export function resolvePreviousOpenFindings(input: {
  planDoc: string;
  round: number;
}): { records: DesignReviewIssueRecord[]; reportPath: string; legacy: boolean } | null {
  if (input.round <= 1) return null;
  const reportPath = deriveReportPath(input.planDoc, input.round - 1);
  let content: string;
  try {
    content = fs.readFileSync(reportPath, "utf-8");
  } catch {
    return null;
  }
  const cleaned = stripInertLines(content);
  const ledgerSection = extractReportSection(
    cleaned,
    /^#{1,4}\s*(Issue Ledger|问题台账)\s*$/i,
  );
  if (ledgerSection !== null) {
    const records = computeOpenSet(parseIssueLedgerSection(ledgerSection.lines, input.round - 1));
    return { records, reportPath, legacy: false };
  }
  return {
    records: synthesizeLegacyCarryOver({ reportContent: content, round: input.round - 1 }),
    reportPath,
    legacy: true,
  };
}

/** 229 Phase 3 (B14): the declared update scope persisted on the state. */
export type DeclaredScope = { phases: readonly number[]; sections: readonly string[] };

/** One-line rendering of a declared scope ("Phase 2, Phase 5 (declared)"). */
function renderScope(scope: DeclaredScope | undefined): string | null {
  if (scope === undefined) return null;
  if (scope.phases.length === 0 && scope.sections.length === 0) return null;
  const parts = [
    ...scope.phases.map((p) => `Phase ${String(p)}`),
    ...scope.sections.map((s) => `${s}`),
  ];
  return parts.join(", ");
}

/**
 * Render the per-round findings directive (B6: both tracks). Bounded to ≤6
 * lines; `null` when there is nothing to restate (empty open set and no
 * declared scope ⇒ the dispatch prompt stays unchanged).
 */
export function renderReviewFindingsDirective(
  previous: readonly DesignReviewIssueRecord[],
  reportPath: string,
  declaredScope?: DeclaredScope,
): string | null {
  if (previous.length === 0) return null;
  const scopeLine = renderScope(declaredScope);
  const lines: string[] = [];
  lines.push(
    `[auto-pipeline] Previous-round open findings (from ${reportPath}) are the closure baseline —`,
  );
  lines.push(
    previous.map((r) => `${r.id}${r.severity !== undefined ? ` (${r.severity}, ${r.status ?? "open"})` : ""}`).join(", "),
  );
  lines.push(
    "Restate EVERY id above in this round's `## Issue Ledger` with a legal status",
    "(open / fixed / accepted-risk / carry-over); a missing id invalidates the report.",
    "`## Issues` carries only NEW/unclosed items of THIS round.",
  );
  if (scopeLine !== null) {
    lines.push(`Scope for this round: ${scopeLine} (declared).`);
  }
  return lines.length <= 6 ? lines.join("\n") : lines.slice(0, 6).join("\n");
}

/** Leaf helper for the coordinator: a state's declared scope, normalized. */
export function declaredScopeOf(state: DesignReviewState | undefined): DeclaredScope | undefined {
  const raw = state?.lastDeclaredScope;
  if (!raw) return undefined;
  return { phases: raw.phases, sections: raw.sections };
}
