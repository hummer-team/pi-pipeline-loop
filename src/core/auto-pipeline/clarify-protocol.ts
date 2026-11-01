/**
 * @module auto-pipeline/clarify-protocol
 * 220 Phase 1/4 (D3): the requirement-assessment and decision-ledger protocol.
 *
 * Facts:
 * - The protocol is DOCUMENT-LEVEL (headings inside the requirement document),
 *   so no new agent, no new state machine and no verify contract change is
 *   needed: the plugin only injects a "fill this in" directive.
 * - Anchors are constants in this module (never scattered literals) and mirror
 *   the deployed clarify skill:
 *   `## 需求评估` (ready / needs-clarify) and `## 组合决策台账`.
 * - Parsing is deterministic and pure so design-review guidance and the
 *   clarify directive agree on the same facts.
 * - The directive NEVER presets a verdict: it lists what is missing and lets
 *   the clarify agent decide.
 */

/** Deterministic requirement assessment of one requirement document. */
export interface RequirementAssessment {
  /** TRUE when the `## 需求评估` section exists. */
  present: boolean;
  /** Declared verdict; `unknown` when the section is missing/ambiguous. */
  verdict: "ready" | "needs-clarify" | "unknown";
  /** Mandatory sections (`## 目标` / `## 范围` / `## 验收标准`) that are absent. */
  missingSections: string[];
  /** Deterministic ambiguity hits (deduped, ≤ 10). */
  ambiguities: string[];
}

/** Parsed decision ledger of one requirement document. */
export interface DecisionLedger {
  /** TRUE when the `## 组合决策台账` section exists. */
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

/** Heading anchors of the protocol (single source of truth). */
export const ASSESSMENT_HEADING = "## 需求评估";
export const LEDGER_HEADING = "## 组合决策台账";
export const GOAL_HEADING = "## 目标";
export const SCOPE_HEADING = "## 范围";
export const ACCEPTANCE_HEADING = "## 验收标准";
export const VERDICT_READY = "ready";
export const VERDICT_NEEDS_CLARIFY = "needs-clarify";
/** Marks a ledger without documented elimination reasons. */
const ELIMINATION_MARKERS = ["淘汰理由", "淘汰原因"];
/** Marks a ledger with a cross-question conflict matrix. */
const CONFLICT_MARKER = "冲突矩阵";

/** Vague words that make a requirement ambiguous when they stand alone. */
const AMBIGUOUS_WORDS = ["TBD", "待定", "若干", "尽快", "优化一下", "更快", "更好", "尽量"];
/** A sentence longer than this is treated as unreadable/ambiguous. */
const MAX_SENTENCE_LENGTH = 120;
/** Hard cap of reported ambiguities (keeps prompts bounded). */
const MAX_AMBIGUITIES = 10;
/** Trim length of one reported fragment. */
const FRAGMENT_LIMIT = 160;

/** Split a document into `## heading → body` sections (heading text preserved). */
function splitSections(docText: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = docText.split(/\r?\n/);
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current !== null) sections.set(current, buffer.join("\n"));
  };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      current = line.trim();
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return sections;
}

/** TRUE when the document carries the given heading (exact prefix match). */
function hasHeading(docText: string, heading: string): boolean {
  return docText.split(/\r?\n/).some((line) => line.trim() === heading);
}

/** Collect the deterministic ambiguity fragments of one document. */
function collectAmbiguities(docText: string): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const push = (fragment: string): void => {
    const trimmed = fragment.trim();
    if (trimmed.length === 0 || seen.has(trimmed) || hits.length >= MAX_AMBIGUITIES) return;
    seen.add(trimmed);
    hits.push(trimmed.length > FRAGMENT_LIMIT ? `${trimmed.slice(0, FRAGMENT_LIMIT)}…` : trimmed);
  };

  for (const line of docText.split(/\r?\n/)) {
    for (const word of AMBIGUOUS_WORDS) {
      if (line.includes(word)) {
        push(line);
        break;
      }
    }
    // `等等` is only a defect when it trails an actual list item; a line that
    // starts with it is prose, not an unterminated enumeration.
    if (/[^\s，。、；：！？]等等/.test(line)) push(line);
  }

  for (const sentence of docText.split(/[。！？!?\n]/)) {
    const trimmed = sentence.trim();
    if (trimmed.length > MAX_SENTENCE_LENGTH) {
      push(`${trimmed.slice(0, MAX_SENTENCE_LENGTH)}…`);
    }
  }
  return hits;
}

/**
 * Parse the requirement assessment of one document.
 *
 * `verdict` is `needs-clarify` as soon as the document has a missing mandatory
 * section or a deterministic ambiguity; otherwise the declared verdict wins.
 */
export function parseRequirementAssessment(docText: string): RequirementAssessment {
  const sections = splitSections(docText);
  const present = sections.has(ASSESSMENT_HEADING);
  const body = sections.get(ASSESSMENT_HEADING) ?? "";
  const declared = body.includes(VERDICT_NEEDS_CLARIFY)
    ? "needs-clarify"
    : body.includes(VERDICT_READY)
      ? "ready"
      : "unknown";

  const missingSections = [GOAL_HEADING, SCOPE_HEADING, ACCEPTANCE_HEADING].filter(
    (heading) => !hasHeading(docText, heading),
  );
  const ambiguities = collectAmbiguities(docText);
  const needsClarify = missingSections.length > 0 || ambiguities.length > 0;

  return {
    present,
    verdict: needsClarify ? "needs-clarify" : declared,
    missingSections,
    ambiguities,
  };
}

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
export function parseDecisionLedger(docText: string): DecisionLedger {
  const sections = splitSections(docText);
  const present = sections.has(LEDGER_HEADING);
  if (!present) {
    return { present: false, entries: 0, labels: [], hasEliminatedReasons: false, hasConflictMatrix: false };
  }
  const body = sections.get(LEDGER_HEADING) ?? "";
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
    hasEliminatedReasons: ELIMINATION_MARKERS.some((marker) => body.includes(marker)),
    hasConflictMatrix: body.includes(CONFLICT_MARKER),
  };
}

/**
 * Number of open questions of the LATEST clarify round.
 *
 * Round headings are `## … 轮 …` lines; without one the whole document counts
 * (first round of a document often has no explicit round heading).
 */
export function parseClarifyQuestionCount(docText: string): number {
  const questionRe = /^##\s+问题\s+\d+/gm;
  const roundStarts: number[] = [];
  const roundRe = /^#+\s+.*轮/mg;
  let roundMatch: RegExpExecArray | null;
  while ((roundMatch = roundRe.exec(docText)) !== null) roundStarts.push(roundMatch.index);
  const start = roundStarts.length > 0 ? roundStarts[roundStarts.length - 1]! : 0;
  const slice = docText.slice(start);
  let count = 0;
  while (questionRe.exec(slice) !== null) count += 1;
  return count;
}

/**
 * Build the directive appended to a clarify dispatch.
 *
 * @returns NULL when nothing has to be completed.
 */
export function buildProtocolDirective(input: {
  assessment: RequirementAssessment;
  ledger: DecisionLedger;
  questionCount: number;
  tier: "rule" | "assisted";
}): string | null {
  const { assessment, ledger, questionCount, tier } = input;
  const problems: string[] = [];

  if (!assessment.present) {
    problems.push(
      `Add a \`${ASSESSMENT_HEADING}\` section stating \`${VERDICT_READY}\` or \`${VERDICT_NEEDS_CLARIFY}\`.`,
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
      `Add a \`${LEDGER_HEADING}\` table (question / chosen option / eliminated option / score / elimination reason / dependencies).`,
    );
  } else if (ledger.present && !ledger.hasEliminatedReasons) {
    problems.push(`Document the elimination reasons inside \`${LEDGER_HEADING}\`.`);
  }
  if (tier === "assisted" && ledger.present && !ledger.hasConflictMatrix) {
    problems.push(
      `Add the \`${CONFLICT_MARKER}\` (cross-question conflict-and-resolution matrix) inside \`${LEDGER_HEADING}\`.`,
    );
  }
  if (problems.length === 0) return null;

  return [
    "[auto-pipeline] Complete the requirement protocol before finalising:",
    ...problems.map((problem) => `- ${problem}`),
    "Do not invent evidence: an item you cannot decide stays a documented open question.",
  ].join("\n");
}
