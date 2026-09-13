/**
 * @module round-sections
 * Splits a requirement document into clarification round sections by round
 * heading matches (Phase 1 / 176, shared by the groups evaluation engine and
 * the clarify forward-args derivation — single implementation, SOP reuse).
 *
 * A "round heading" regex is supplied by the caller (typically a group's `when`
 * pattern). It must be line-anchored (`^` + `m` flag) and expose the round
 * number via named groups `roundZh` / `roundEn` (or positional groups 1 / 2).
 */

/** A single round section: the round number and its text (heading to next heading). */
export interface RoundSection {
  /** Parsed round number. */
  round: number;
  /** Section text from the heading line up to (but excluding) the next heading. */
  text: string;
}

/**
 * Splits `docText` into round sections using `headingRe`.
 *
 * Semantics:
 * - Only line-start matches count (h3+ headings are excluded when the pattern
 *   uses `#{1,2}`; body mentions of "Round N" do not match).
 * - The last section extends to end-of-document (EOF).
 * - A match without a parseable round number is ignored.
 *
 * @param docText - Full requirement document text
 * @param headingRe - Round heading regex (named groups preferred)
 * @returns Ordered round sections
 */
export function splitRoundSections(docText: string, headingRe: RegExp): RoundSection[] {
  // Normalize flags: ensure global + multiline so `^` anchors per line and
  // `exec` advances across all headings.
  const flags = new Set(headingRe.flags.split(""));
  flags.add("g");
  flags.add("m");
  const re = new RegExp(headingRe.source, [...flags].join(""));

  const matches: { index: number; round: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(docText)) !== null) {
    const raw = match.groups?.roundZh ?? match.groups?.roundEn ?? match[1] ?? match[2];
    if (raw !== undefined) {
      const round = parseInt(raw, 10);
      if (!Number.isNaN(round)) {
        matches.push({ index: match.index, round });
      }
    }
    // Guard against zero-length matches causing an infinite loop.
    if (match.index === re.lastIndex) re.lastIndex++;
  }

  return matches.map((entry, i) => ({
    round: entry.round,
    text: docText.slice(entry.index, i + 1 < matches.length ? matches[i + 1].index : undefined),
  }));
}
