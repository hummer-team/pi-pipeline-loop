/**
 * @module design-review/report-sections
 * 193 Phase 0: mechanical design-review REPORT text scanning extracted from
 * `core/verifiers/design-review-verifier.ts` so the trusted verifier and the
 * report structure contract share ONE implementation (no parallel parser).
 *
 * Boundaries (intentionally narrow):
 * - Pure over caller-provided content: NO file reads, NO globs, NO meta
 *   writes, NO dispatching, NO domain verdict decisions.
 * - "Inert" content (fenced code blocks, block quotes, HTML comments) is
 *   removed exactly as the trusted verifier has always done, so verdict and
 *   section rules can never be satisfied by examples or quotations.
 * - Section extraction returns EVERY matching heading occurrence (plus the
 *   body under each), which is what lets the contract detect duplicated or
 *   missing sections instead of silently reading the first one.
 *
 * Business policy (which sections are required, what counts as filled) lives
 * in `report-contract.ts`, never here.
 */

/** Default issue heading anchor (matches `## Issues` / `## 问题`). */
export const DEFAULT_ISSUE_HEADING_PATTERN = "^#{1,4}\\s*(Issues|问题列表|问题)\\s*$";

/** Body of one extracted section (heading excluded). */
export interface ExtractedReportSection {
  /** Index of the heading line within the supplied (already cleaned) lines */
  headingIndex: number;
  /** The heading line itself */
  heading: string;
  /** Body lines up to the next same-or-higher level heading (may be empty) */
  lines: string[];
  /** True when the body carries no non-blank line */
  empty: boolean;
}

/**
 * Clean report content for semantic scanning: remove fenced code blocks
 * (both ``` and ~~~), block-quote lines and HTML comments. Returns the
 * surviving lines in original order.
 */
export function stripInertLines(content: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let inHtmlComment = false;
  for (const raw of content.split("\n")) {
    const line = raw;
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) {
        fence = marker;
        continue; // fence open line is inert too
      }
      if (marker === fence) {
        fence = null;
        continue;
      }
      continue; // different marker inside a fence
    }
    if (fence) continue;
    if (inHtmlComment) {
      if (line.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (/^\s*<!--/.test(line) && !/-->\s*$/.test(line)) {
      inHtmlComment = true;
      continue;
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) continue; // single-line comment
    if (/^\s*>/.test(line)) continue; // blockquotes
    out.push(line);
  }
  return out;
}

/**
 * Extract EVERY section whose heading matches `headingRe`, each body running
 * until the next heading of the same or a higher level. Returns an empty array
 * when no heading matches (the caller decides whether absence is a failure).
 */
export function extractReportSections(
  lines: readonly string[],
  headingRe: RegExp,
): ExtractedReportSection[] {
  const sections: ExtractedReportSection[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!headingRe.test(line)) continue;
    const levelMatch = line.match(/^(#+)/);
    const level = levelMatch ? levelMatch[1]!.length : 2;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j]!;
      const h = candidate.match(/^(#+)\s/);
      if (h && h[1]!.length <= level) break;
      body.push(candidate);
    }
    sections.push({
      headingIndex: i,
      heading: line,
      lines: body,
      empty: body.filter((l) => l.trim() !== "").length === 0,
    });
  }
  return sections;
}

/** Extract the FIRST matching section, or null when the heading is absent. */
export function extractReportSection(
  lines: readonly string[],
  headingRe: RegExp,
): ExtractedReportSection | null {
  return extractReportSections(lines, headingRe)[0] ?? null;
}

/**
 * Locate an identity field row (case-insensitive label, full-line match) and
 * return its value. Accepts an ordered alias list; the first alias with a match
 * wins, so canonical labels keep priority over legacy aliases.
 */
export function findReportField(
  lines: readonly string[],
  labels: readonly string[],
): string | undefined {
  for (const label of labels) {
    const re = new RegExp(`^\\s*\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*(.+?)\\s*\\*{0,2}\\s*$`, "i");
    for (const line of lines) {
      const m = line.match(re);
      if (m) return m[1]!.replace(/\*+$/, "").trim();
    }
  }
  return undefined;
}

/**
 * Count the rows matching an identity field (any alias). Used by the structure
 * contract to reject contradictory duplicated identity rows.
 */
export function collectReportFieldValues(
  lines: readonly string[],
  labels: readonly string[],
): string[] {
  const values: string[] = [];
  for (const label of labels) {
    const re = new RegExp(`^\\s*\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*(.+?)\\s*\\*{0,2}\\s*$`, "i");
    for (const line of lines) {
      const m = line.match(re);
      if (m) values.push(m[1]!.replace(/\*+$/, "").trim());
    }
  }
  return values;
}

/** Compile a heading anchor from a contract pattern; invalid regex falls back
 *  to `fallbackPattern` (fail-closed behaviour is decided by the caller). */
export function compileHeadingRe(pattern: string | undefined, fallbackPattern: string): RegExp {
  try {
    return new RegExp(pattern ?? fallbackPattern, "i");
  } catch {
    return new RegExp(fallbackPattern, "i");
  }
}

/**
 * True when a line carries NO substantive text: blank, markdown decoration
 * only, or an unfilled `{placeholder}` / `{{placeholder}}` token. This is what
 * keeps "copied the template but filled nothing" from counting as content.
 */
export function isLazilyFilledLine(line: string): boolean {
  const withoutPlaceholders = line.replace(/\{\{?\s*[A-Za-z_][A-Za-z0-9_]*\s*\}?\}/g, "");
  return !/[A-Za-z0-9\u4e00-\u9fa5]/.test(withoutPlaceholders);
}

/** True when the section body carries at least one substantive line. */
export function hasSubstantiveContent(sectionLines: readonly string[]): boolean {
  return sectionLines.some((line) => line.trim() !== "" && !isLazilyFilledLine(line));
}
