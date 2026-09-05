/**
 * @module clarify-args
 * Pure-function derivation of clarify-stage forward arguments from requirement document text.
 *
 * Phase 3 (171) Q3-A: when the user runs /pipeline-start without explicit forward args,
 * the plugin derives what to pass to the clarify subagent based on the document's
 * clarification round state.
 *
 * Derivation rules (in order):
 * 1. No round headings found → "1" (fresh start, first round)
 * 2. Latest round has no answer markers → "await-answer" (do not auto-spawn, just notify)
 * 3. Latest round has answer but no confirmation marker → "full-und?" (trigger confirmation)
 * 4. Latest round has confirmation marker → "confirmed" (do not spawn, notify complete)
 *
 * Round heading pattern: `# 第 N 轮澄清` (Chinese round marker)
 * Answer markers: `答[:：]` or `**答**` (answer field)
 * Confirmation marker: `## 模型确认` (model confirmation section)
 */

/** Result of the clarify forward args derivation. */
export type ClarifyForwardResult =
  | { kind: "fresh"; args: "1" }
  | { kind: "await-answer"; round: number }
  | { kind: "full-und?"; round: number }
  | { kind: "confirmed"; round: number };

/** Pattern for round heading: `# 第 (\d+) 轮澄清` */
const ROUND_HEADING_PATTERN = /^#\s*第\s*(\d+)\s*轮澄清/gm;

/** Answer markers within a round block */
const ANSWER_PATTERN = /答\s*[:：]|[*]{2}答[*]{2}/;

/** Confirmation marker (model confirmation section heading) */
const CONFIRM_PATTERN = /^##\s*模型确认/gm;

/**
 * Derives the clarify forward arguments from the requirement document text.
 *
 * @param docText - Full text content of the requirement document
 * @returns ClarifyForwardResult indicating what to forward
 */
export function deriveClarifyForwardArgs(docText: string): ClarifyForwardResult {
  // Find all round headings
  const rounds: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = ROUND_HEADING_PATTERN.exec(docText)) !== null) {
    rounds.push(parseInt(match[1], 10));
  }

  if (rounds.length === 0) {
    // No rounds found → fresh start
    return { kind: "fresh", args: "1" };
  }

  const latestRound = Math.max(...rounds);

  // Extract the text block for the latest round (from its heading to end of doc)
  const roundHeadingRegex = new RegExp(`^#\\\\s*第\\\\s*${latestRound}\\\\s*轮澄清.*$`, "gm");
  // Simpler: find the position of the latest round heading and extract from there
  const headingPattern = new RegExp(`#\\s*第\\s*${latestRound}\\s*轮澄清`, "gm");
  const headingMatch = headingPattern.exec(docText);
  if (!headingMatch) {
    // Shouldn't happen since we found it above, but fail-safe
    return { kind: "fresh", args: "1" };
  }

  const roundBlock = docText.substring(headingMatch.index);

  // Check for confirmation marker in the round block
  const hasConfirmation = CONFIRM_PATTERN.test(roundBlock);
  if (hasConfirmation) {
    return { kind: "confirmed", round: latestRound };
  }

  // Check for answer markers in the round block
  const hasAnswer = ANSWER_PATTERN.test(roundBlock);
  if (!hasAnswer) {
    return { kind: "await-answer", round: latestRound };
  }

  // Has answer but no confirmation → trigger full-und?
  return { kind: "full-und?", round: latestRound };
}
