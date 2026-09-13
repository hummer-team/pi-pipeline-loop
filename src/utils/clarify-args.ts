/**
 * @module clarify-args
 * Pure-function derivation of clarify-stage forward arguments from requirement document text.
 *
 * Phase 3 (171) Q3-A: when the user runs /pipeline-start without explicit forward args,
 * the plugin derives what to pass to the clarify subagent based on the document's
 * clarification round state.
 *
 * Phase 2 (176, R1Q1B "declaration is behavior"): the round-heading, answer-field
 * and model-confirmation patterns are supplied by the caller as runtime contract
 * anchors loaded from the deployed verify.md (`loadVerifyContractAnchors`). No
 * code-side regex source remains.
 *
 * Derivation rules (in order):
 * 1. No round headings found → "1" (fresh start, first round)
 * 2. Latest round has no answer markers → "await-answer" (do not auto-spawn, just notify)
 * 3. Latest round has answer but no confirmation marker → "full-und?" (trigger confirmation)
 * 4. Latest round has confirmation marker → "confirmed" (do not spawn, notify complete)
 */

import type { VerifyContractAnchors, VerifyContractPatternSet } from "./contract-loader";
import { splitRoundSections } from "./round-sections";

/** Result of the clarify forward args derivation. */
export type ClarifyForwardResult =
  | { kind: "fresh"; args: "1" }
  | { kind: "await-answer"; round: number }
  | { kind: "full-und?"; round: number }
  | { kind: "confirmed"; round: number };

/**
 * Compiles a round-heading anchor into a global+multiline regex.
 * Returns null when the anchor is missing or the patterns are invalid.
 */
function compileRoundHeading(anchor: VerifyContractPatternSet | undefined): RegExp | null {
  if (!anchor || anchor.patterns.length === 0) return null;
  try {
    return new RegExp(anchor.patterns.join("|"), "gm");
  } catch {
    return null;
  }
}

/**
 * Tests a pattern-set anchor against `text`, honoring its combination mode.
 * Invalid individual patterns count as non-matches.
 */
function anchorMatches(anchor: VerifyContractPatternSet | undefined, text: string): boolean {
  if (!anchor || anchor.patterns.length === 0) return false;
  const results = anchor.patterns.map((pattern) => {
    try {
      return new RegExp(pattern, "m").test(text);
    } catch {
      return false;
    }
  });
  return anchor.mode === "and" ? results.every(Boolean) : results.some(Boolean);
}

/**
 * Derives the clarify forward arguments from the requirement document text.
 *
 * @param docText - Full text content of the requirement document
 * @param anchors - Runtime contract anchors loaded from the deployed verify.md.
 *   When `roundHeading` is unavailable the derivation falls back to "fresh"
 *   (callers are expected to have already surfaced a fail-open notification).
 * @returns ClarifyForwardResult indicating what to forward
 */
export function deriveClarifyForwardArgs(
  docText: string,
  anchors?: VerifyContractAnchors,
): ClarifyForwardResult {
  const roundRe = compileRoundHeading(anchors?.roundHeading);
  if (!roundRe) {
    // No round-heading anchor → neutral fresh start (fail-open).
    return { kind: "fresh", args: "1" };
  }

  const sections = splitRoundSections(docText, roundRe);
  if (sections.length === 0) {
    return { kind: "fresh", args: "1" };
  }

  // Latest round = highest round number (last occurrence wins on ties).
  let latest = sections[0];
  for (const section of sections) {
    if (section.round >= latest.round) latest = section;
  }
  const roundBlock = latest.text;

  // Confirmation marker in the latest round block (bilingual, model confirmation heading).
  if (anchorMatches(anchors?.modelConfirm, roundBlock)) {
    return { kind: "confirmed", round: latest.round };
  }

  // Answer markers in the latest round block (bilingual).
  if (!anchorMatches(anchors?.answerField, roundBlock)) {
    return { kind: "await-answer", round: latest.round };
  }

  // Has answer but no confirmation → trigger full-und?
  return { kind: "full-und?", round: latest.round };
}
