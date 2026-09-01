/**
 * @module doc-path
 * Pure utility for extracting requirement document paths from free-form text.
 *
 * Used by session-starter JOIN auto-bind (Phase 1 / 170) to detect doc paths
 * mentioned in the first user message of a subagent session, and by the
 * unbound-notify text to surface candidate paths in audit fields.
 */

/**
 * Extract the first requirement document path from free-form text.
 *
 * Matches tokens shaped like relative docs-path or absolute Markdown paths.
 * Examples: `docs/design/82_Feat.md`, `/absolute/path/spec.md`.
 *
 * Return semantics:
 * - 0 matches → `null`
 * - 1 match   → the matched path
 * - 2+ matches → `null` (ambiguous — caller should NOT guess);
 *                 when `candidates` callback is provided it receives the full list
 *                 so the caller can log/audit them for diagnostics.
 *
 * @param rawText  - Text to scan (typically a user message)
 * @param candidates - Optional callback receiving the full candidate list on ambiguity
 * @returns The first doc path, or null when zero or ambiguous
 */
export function parseRequirementDocPath(
  rawText: string,
  candidates?: (paths: string[]) => void,
): string | null {
  if (!rawText || typeof rawText !== "string") {
    return null;
  }

  // Match relative paths (docs/.../*.md, doc/.../*.md) or absolute paths (/*.md).
  // The negative lookbehind (?<!\w) prevents the absolute-path branch from matching
  // mid-token slashes (e.g. "src/design/spec.md" must not yield "/design/spec.md").
  const mdPathRegex = /(?:(?:\.{0,2}\/)?(?:docs|doc)\/[\w\-./]+\.md|(?<!\w)\/[\w\-./]+\.md)/g;

  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = mdPathRegex.exec(rawText)) !== null) {
    const candidate = m[0];
    // De-duplicate (regex global could match overlapping substrings in pathological input)
    if (!matches.includes(candidate)) {
      matches.push(candidate);
    }
  }

  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return matches[0];
  }

  // Ambiguous: report candidates for audit, return null (no guessing)
  if (candidates) {
    candidates(matches);
  }
  return null;
}
