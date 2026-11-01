/**
 * @module auto-pipeline/clarify-assessment
 * 220 Phase 1 (D3/Q6): the deterministic requirement-assessment half of the
 * clarify document protocol.
 *
 * Facts:
 * - The protocol is DOCUMENT-LEVEL (headings inside the requirement document),
 *   so no new agent, no new state machine and no verify-contract change is
 *   needed: the plugin only injects a "fill this in" directive.
 * - 221 Phase 1: anchors come from `resolveClarifyAnchors` (job JSON → verify.md
 *   → bilingual defaults). The legacy constants below remain as the PRIMARY
 *   alias of the defaults, so existing callers/tests keep their meaning.
 * - Parsing is deterministic and pure, so the clarify directive and the
 *   design-review guidance agree on the same facts.
 */

import {
  DEFAULT_CLARIFY_PROTOCOL,
  resolveClarifyAnchors,
  type ResolvedClarifyAnchors,
} from "./clarify-anchors";

/** Deterministic requirement assessment of one requirement document. */
export interface RequirementAssessment {
  /** TRUE when the assessment section exists (any alias). */
  present: boolean;
  /** Declared verdict; `unknown` when the section is missing/ambiguous. */
  verdict: "ready" | "needs-clarify" | "unknown";
  /** Mandatory sections (goal / scope / acceptance) that are absent, primary aliases. */
  missingSections: string[];
  /** Deterministic ambiguity hits (deduped, ≤ 10). */
  ambiguities: string[];
}

/** PRIMARY heading anchors of the assessment protocol (defaults, first alias). */
export const ASSESSMENT_HEADING = DEFAULT_CLARIFY_PROTOCOL.assessmentHeading[0]!;
export const GOAL_HEADING = DEFAULT_CLARIFY_PROTOCOL.goalHeading[0]!;
export const SCOPE_HEADING = DEFAULT_CLARIFY_PROTOCOL.scopeHeading[0]!;
export const ACCEPTANCE_HEADING = DEFAULT_CLARIFY_PROTOCOL.acceptanceHeading[0]!;
export const VERDICT_READY = DEFAULT_CLARIFY_PROTOCOL.verdictReady[0]!;
export const VERDICT_NEEDS_CLARIFY = DEFAULT_CLARIFY_PROTOCOL.verdictNeedsClarify[0]!;

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

/** Body of the first heading alias that exists in `sections`. */
export function sectionBody(
  sections: Map<string, string>,
  headings: string[],
): string | undefined {
  for (const heading of headings) {
    const body = sections.get(heading);
    if (body !== undefined) return body;
  }
  return undefined;
}

/** TRUE when the document carries ANY of the given headings (exact line match). */
function hasHeading(docText: string, headings: string[]): boolean {
  return docText
    .split(/\r?\n/)
    .some((line) => headings.some((heading) => line.trim() === heading));
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
 *
 * @param anchors - Resolved protocol anchors; omitted ⇒ bilingual defaults.
 */
export function parseRequirementAssessment(
  docText: string,
  anchors?: ResolvedClarifyAnchors,
): RequirementAssessment {
  const effective = anchors ?? resolveClarifyAnchors({});
  const sections = splitSections(docText);
  const body = sectionBody(sections, effective.assessmentHeading);
  const declared = body === undefined
    ? "unknown"
    : effective.verdictNeedsClarify.some((v) => body.includes(v))
      ? "needs-clarify"
      : effective.verdictReady.some((v) => body.includes(v))
        ? "ready"
        : "unknown";

  const missingSections = [
    effective.goalHeading,
    effective.scopeHeading,
    effective.acceptanceHeading,
  ]
    .filter((headings) => !hasHeading(docText, headings))
    // 221 Phase 1: report the PRIMARY alias so the injected directive and the
    // configured anchors always agree (INV-4).
    .map((headings) => headings[0]!);
  const ambiguities = collectAmbiguities(docText);
  const needsClarify = missingSections.length > 0 || ambiguities.length > 0;

  return {
    present: body !== undefined,
    verdict: needsClarify ? "needs-clarify" : declared,
    missingSections,
    ambiguities,
  };
}
