/**
 * @module auto-pipeline/clarify-assessment
 * 220 Phase 1 (D3/Q6): the deterministic requirement-assessment half of the
 * clarify document protocol.
 *
 * Facts:
 * - The protocol is DOCUMENT-LEVEL (headings inside the requirement document),
 *   so no new agent, no new state machine and no verify-contract change is
 *   needed: the plugin only injects a "fill this in" directive.
 * - Anchors are constants here (never scattered literals) and mirror the
 *   deployed clarify skill: `## 需求评估` declares `ready` / `needs-clarify`.
 * - Parsing is deterministic and pure, so the clarify directive and the
 *   design-review guidance agree on the same facts.
 * - Extracted from `clarify-protocol.ts` (220 develop: the file budget is
 *   ≤200 lines per module); the protocol module re-exports this API, so no
 *   caller had to change.
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

/** Heading anchors of the assessment protocol (single source of truth). */
export const ASSESSMENT_HEADING = "## 需求评估";
export const GOAL_HEADING = "## 目标";
export const SCOPE_HEADING = "## 范围";
export const ACCEPTANCE_HEADING = "## 验收标准";
export const VERDICT_READY = "ready";
export const VERDICT_NEEDS_CLARIFY = "needs-clarify";

/** Vague words that make a requirement ambiguous when they stand alone. */
const AMBIGUOUS_WORDS = ["TBD", "待定", "若干", "尽快", "优化一下", "更快", "更好", "尽量"];
/** A sentence longer than this is treated as unreadable/ambiguous. */
const MAX_SENTENCE_LENGTH = 120;
/** Hard cap of reported ambiguities (keeps prompts bounded). */
const MAX_AMBIGUITIES = 10;
/** Trim length of one reported fragment. */
const FRAGMENT_LIMIT = 160;

/**
 * Split a document into `## heading → body` sections (heading text preserved).
 * Shared with the decision-ledger parser: both halves read the same sections.
 */
export function splitSections(docText: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current !== null) sections.set(current, buffer.join("\n"));
  };
  for (const line of docText.split(/\r?\n/)) {
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

/** TRUE when the document carries the given heading (exact line match). */
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
