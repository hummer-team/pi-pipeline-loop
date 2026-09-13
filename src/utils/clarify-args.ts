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
 * Round heading patterns (bilingual, Phase 0 / 175):
 * - Chinese: `# 第 N 轮澄清` / `## 第 N 轮澄清` (h1 or h2)
 * - English: `# Round N` / `## round 3` (h1 or h2, case-insensitive R)
 * - `#{1,2}` ensures h3+ headings (e.g. `### 3.0 对 Round 2 的修正`) are NOT matched.
 *
 * Answer markers (bilingual, Phase 0 / 175): `答:`/`答：`/`**答**`/`Answer:`
 * Confirmation marker (bilingual): `## 模型确认` / `## Model Confirmation`
 *
 * All patterns sourced from CONTRACT_TOKENS single source of truth (src/constants.ts).
 */

import { CONTRACT_TOKENS } from "../constants";

/** Result of the clarify forward args derivation. */
export type ClarifyForwardResult =
  | { kind: "fresh"; args: "1" }
  | { kind: "await-answer"; round: number }
  | { kind: "full-und?"; round: number }
  | { kind: "confirmed"; round: number };

/**
 * Bilingual round heading pattern (combined Chinese + English).
 * #{1,2} at line-start prevents ### (h3) false positives.
 * Capture groups: [1] = Chinese round number, [2] = English round number.
 */
const ROUND_HEADING_PATTERN = new RegExp(
  `(?:${CONTRACT_TOKENS.ROUND_HEADING_ZH}|${CONTRACT_TOKENS.ROUND_HEADING_EN})`,
  "gm",
);

/** Answer markers within a round block (bilingual) */
const ANSWER_PATTERN = new RegExp(CONTRACT_TOKENS.ANSWER_FIELD);

/**
 * Confirmation marker (bilingual model confirmation section heading).
 * NOTE: `m` flag only (no `g`) — `test()` is called once per invocation, and
 * the `g` flag would cause lastIndex statefulness across calls (175 regression).
 */
const CONFIRM_PATTERN = new RegExp(
  `(?:${CONTRACT_TOKENS.MODEL_CONFIRM_ZH}|${CONTRACT_TOKENS.MODEL_CONFIRM_EN})`,
  "m",
);

/**
 * Derives the clarify forward arguments from the requirement document text.
 *
 * @param docText - Full text content of the requirement document
 * @returns ClarifyForwardResult indicating what to forward
 */
export function deriveClarifyForwardArgs(docText: string): ClarifyForwardResult {
  // Find all round headings (bilingual)
  const rounds: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = ROUND_HEADING_PATTERN.exec(docText)) !== null) {
    // Group 1 = Chinese round number, Group 2 = English round number
    const roundNum = match[1] ?? match[2];
    if (roundNum !== undefined) {
      rounds.push(parseInt(roundNum, 10));
    }
  }

  if (rounds.length === 0) {
    // No rounds found → fresh start
    return { kind: "fresh", args: "1" };
  }

  const latestRound = Math.max(...rounds);

  // Extract the text block for the latest round (from its heading to end of doc).
  // Bilingual: match either Chinese or English heading for the latest round number.
  const headingPattern = new RegExp(
    `(?:^#{1,2}\\s*第\\s*${latestRound}\\s*轮澄清|^#{1,2}\\s*[Rr]ound\\s+${latestRound})`,
    "gm",
  );
  const headingMatch = headingPattern.exec(docText);
  if (!headingMatch) {
    // Shouldn't happen since we found it above, but fail-safe
    return { kind: "fresh", args: "1" };
  }

  const roundBlock = docText.substring(headingMatch.index);

  // Check for confirmation marker in the round block (bilingual)
  const hasConfirmation = CONFIRM_PATTERN.test(roundBlock);
  if (hasConfirmation) {
    return { kind: "confirmed", round: latestRound };
  }

  // Check for answer markers in the round block (bilingual)
  const hasAnswer = ANSWER_PATTERN.test(roundBlock);
  if (!hasAnswer) {
    return { kind: "await-answer", round: latestRound };
  }

  // Has answer but no confirmation → trigger full-und?
  return { kind: "full-und?", round: latestRound };
}
