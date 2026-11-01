/**
 * @module auto-pipeline/clarify-anchor-patterns
 * 221 Phase 0/1 (INV-6): regex compilation helpers for the clarify anchors.
 *
 * Facts:
 * - Split out of `clarify-anchors.ts` to keep that module inside the 200-line
 *   budget; this file has NO configuration knowledge — it only validates and
 *   compiles pattern groups.
 * - Every failure is fail-open: the affected GROUP is dropped and an issue is
 *   reported, never a throw (INV-5).
 * - A round group is additionally validated as a JOINED alternation because
 *   consumers join the sources with `|` before matching; individually valid
 *   patterns can still collide on a named group.
 */

/** Default flags used when validating/compiling regex sources. */
const PATTERN_FLAGS = "gm";

/**
 * 221 (F4): permissive round-heading fallback for deployed documents that use
 * h3, omit "澄清", or write a Chinese numeral (`### 第二轮澄清`). Appended to the
 * EFFECTIVE round set only — never shown as the primary anchor.
 */
export const COMPAT_ROUND_PATTERN = "^#+\\s+.*轮";

/** Compile a pattern group; any invalid source drops the WHOLE group (fail-open). */
export function compileGroup(
  sources: string[],
  label: string,
  issues: string[],
): RegExp[] | null {
  if (sources.length === 0) return null;
  let failed = false;
  for (const source of sources) {
    try {
      new RegExp(source, PATTERN_FLAGS);
    } catch (err) {
      failed = true;
      issues.push(`${label}: invalid pattern "${source}" (${String(err)})`);
    }
  }
  return failed ? null : sources.map((source) => new RegExp(source, PATTERN_FLAGS));
}

/**
 * Compile a round-heading group and validate the JOINED regex.
 *
 * Consumers join the sources with `|` before matching (`compileRoundHeading`);
 * two patterns declaring the same named group compile individually but throw
 * when joined — validating the join here prevents a silent `fresh` fallback.
 */
export function compileRoundGroup(
  sources: string[],
  label: string,
  issues: string[],
): RegExp[] | null {
  const regexes = compileGroup(sources, label, issues);
  if (!regexes) return null;
  try {
    new RegExp(regexes.map((r) => r.source).join("|"), PATTERN_FLAGS);
  } catch (err) {
    issues.push(`${label}: pattern set cannot be combined (${String(err)})`);
    return null;
  }
  return regexes;
}

/** Append the permissive round fallback to an effective set (deduped). */
export function withCompatRound(patterns: RegExp[], issues: string[]): RegExp[] {
  if (patterns.some((p) => p.source === COMPAT_ROUND_PATTERN)) return patterns;
  const effective = [...patterns, new RegExp(COMPAT_ROUND_PATTERN, PATTERN_FLAGS)];
  try {
    new RegExp(effective.map((p) => p.source).join("|"), PATTERN_FLAGS);
    return effective;
  } catch (err) {
    issues.push(`round pattern compatibility alias dropped (${String(err)})`);
    return patterns;
  }
}

/** Escape one literal marker into a `^\s*<marker>` regex source. */
export function markerPattern(marker: string): string {
  return `^\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
}
