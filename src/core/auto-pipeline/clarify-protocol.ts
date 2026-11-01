/**
 * @module auto-pipeline/clarify-protocol
 * 220 Phase 1/4 (D3): the requirement-assessment and decision-ledger protocol.
 *
 * Facts:
 * - The protocol is DOCUMENT-LEVEL (headings inside the requirement document),
 *   so no new agent, no new state machine and no verify contract change is
 *   needed: the plugin only injects a "fill this in" directive.
 * - 221 Phase 1: anchors come from `resolveClarifyAnchors` (job JSON →
 *   verify.md → bilingual defaults). No literal anchor is read here anymore.
 * - Parsing is deterministic and pure so design-review guidance and the
 *   clarify directive agree on the same facts.
 * - The directive NEVER presets a verdict: it lists what is missing and lets
 *   the clarify agent decide.
 * - 220 develop: the assessment half lives in `clarify-assessment.ts` (module
 *   budget ≤200 lines) and is re-exported here, so callers import one module.
 */

import {
  DEFAULT_CLARIFY_PROTOCOL,
  resolveClarifyAnchors,
  type ResolvedClarifyAnchors,
} from "./clarify-anchors";
import {
  VERDICT_NEEDS_CLARIFY,
  VERDICT_READY,
  sectionBody,
  splitSections,
  type RequirementAssessment,
} from "./clarify-assessment";

export { parseRequirementAssessment } from "./clarify-assessment";
export type { RequirementAssessment } from "./clarify-assessment";

/** Parsed decision ledger of one requirement document. */
export interface DecisionLedger {
  /** TRUE when the ledger section exists (any heading alias). */
  present: boolean;
  /** Number of decision rows. */
  entries: number;
  /** First-column labels of the ledger table (deduped, order preserved). */
  labels: string[];
  /** TRUE when elimination reasons are documented. */
  hasEliminatedReasons: boolean;
  /** TRUE when a cross-question conflict matrix is documented. */
  hasConflictMatrix: boolean;
}

/** PRIMARY heading anchor of the decision ledger (defaults, first alias). */
export const LEDGER_HEADING = DEFAULT_CLARIFY_PROTOCOL.ledgerHeading[0]!;

/** Count the data rows of the first markdown table inside a section body. */
function parseTableRows(body: string): string[][] {
  const rows: string[][] = [];
  let headerSeen = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) {
      // A blank line after a table ends it; prose before it is ignored.
      if (rows.length > 0 && line.length === 0) break;
      continue;
    }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator row
    if (!headerSeen) {
      headerSeen = true;
      continue; // header row
    }
    if (cells.every((cell) => cell.length === 0)) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * Parse the decision ledger of one document.
 *
 * `entries` counts decision rows; `labels` are the first-column values
 * (deduped, order preserved) used by design-review traceability checks.
 */
export function parseDecisionLedger(
  docText: string,
  anchors?: ResolvedClarifyAnchors,
): DecisionLedger {
  const effective = anchors ?? resolveClarifyAnchors({});
  const sections = splitSections(docText);
  const body = sectionBody(sections, effective.ledgerHeading);
  if (body === undefined) {
    return { present: false, entries: 0, labels: [], hasEliminatedReasons: false, hasConflictMatrix: false };
  }
  const rows = parseTableRows(body);
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const label = row[0] ?? "";
    if (label.length === 0 || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return {
    present: true,
    entries: rows.length,
    labels,
    hasEliminatedReasons: effective.eliminationMarkers.some((marker) => body.includes(marker)),
    hasConflictMatrix: effective.conflictMarkers.some((marker) => body.includes(marker)),
  };
}

/** Highest `lastIndex`-independent match index of a global pattern in `text`. */
function lastMatchIndex(pattern: RegExp, text: string): number {
  const re = new RegExp(pattern.source, "gm");
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    last = match.index;
    // A zero-length match must advance `lastIndex` or the loop never ends.
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return last;
}

/**
 * Number of open questions of the LATEST clarify round.
 *
 * Round headings are matched by the effective round patterns (job → verify.md →
 * defaults + the permissive `轮` compatibility alias); without one the whole
 * document counts (the first round often has no explicit round heading).
 */
export function parseClarifyQuestionCount(
  docText: string,
  anchors?: ResolvedClarifyAnchors,
): number {
  const effective = anchors ?? resolveClarifyAnchors({});
  let start = 0;
  for (const pattern of effective.roundPatterns) {
    start = Math.max(start, lastMatchIndex(pattern, docText));
  }
  const slice = docText.slice(start);
  const positions = new Set<number>();
  for (const pattern of effective.questionPatterns) {
    const re = new RegExp(pattern.source, "gm");
    let match: RegExpExecArray | null;
    while ((match = re.exec(slice)) !== null) {
      positions.add(match.index);
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
  return positions.size;
}

/**
 * Build the directive appended to a clarify dispatch.
 *
 * @returns NULL when nothing has to be completed.
 */
export function buildProtocolDirective(
  input: {
    assessment: RequirementAssessment;
    ledger: DecisionLedger;
    questionCount: number;
    tier: "rule" | "assisted";
  },
  anchors?: ResolvedClarifyAnchors,
): string | null {
  const { assessment, ledger, questionCount, tier } = input;
  const effective = anchors ?? resolveClarifyAnchors({});
  const assessmentHeading = effective.assessmentHeading[0]!;
  const ledgerHeading = effective.ledgerHeading[0]!;
  const verdictReady = effective.verdictReady[0] ?? VERDICT_READY;
  const verdictNeedsClarify = effective.verdictNeedsClarify[0] ?? VERDICT_NEEDS_CLARIFY;
  const conflictMarker = effective.conflictMarkers[0] ?? "冲突矩阵";
  const problems: string[] = [];

  if (!assessment.present) {
    problems.push(
      `Add a \`${assessmentHeading}\` section stating \`${verdictReady}\` or \`${verdictNeedsClarify}\`.`,
    );
  }
  if (assessment.missingSections.length > 0) {
    problems.push(`Add the mandatory sections: ${assessment.missingSections.join(" / ")}.`);
  }
  if (assessment.ambiguities.length > 0) {
    problems.push(
      `Remove or quantify these ambiguous fragments: ${assessment.ambiguities.join(" | ")}.`,
    );
  }
  if (questionCount >= 2 && !ledger.present) {
    problems.push(
      `Add a \`${ledgerHeading}\` table (question / chosen option / eliminated option / score / elimination reason / dependencies).`,
    );
  } else if (ledger.present && !ledger.hasEliminatedReasons) {
    problems.push(`Document the elimination reasons inside \`${ledgerHeading}\`.`);
  }
  if (tier === "assisted" && ledger.present && !ledger.hasConflictMatrix) {
    problems.push(
      `Add the \`${conflictMarker}\` (cross-question conflict-and-resolution matrix) inside \`${ledgerHeading}\`.`,
    );
  }
  if (problems.length === 0) return null;

  return [
    "[auto-pipeline] Complete the requirement protocol before finalising:",
    ...problems.map((problem) => `- ${problem}`),
    "Do not invent evidence: an item you cannot decide stays a documented open question.",
  ].join("\n");
}
