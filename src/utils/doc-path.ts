/**
 * @module doc-path
 * Pure utility for extracting requirement document paths from free-form text.
 *
 * Used by session-starter JOIN auto-bind (Phase 1 / 170) to detect doc paths
 * mentioned in the first user message of a subagent session, and by the
 * unbound-notify text to surface candidate paths in audit fields.
 */

/**
 * Checks if a filename looks like a version variant.
 *
 * Matches patterns such as:
 * - `v1.md`, `v2.md`, `v10.md`
 * - `spec_1.md`, `spec_2.md` (trailing underscore+digit before extension)
 * - `round1.md`, `round2.md` (trailing digit before extension)
 *
 * @param filename - The filename (without directory) to check
 * @returns true if the filename has version-like morphology
 */
function isVersionLikeFilename(filename: string): boolean {
  // v1, v2, v10, etc. (possibly with surrounding text)
  if (/^v\d+\.\w+$/.test(filename)) return true;
  // Ends with _N or N before extension: spec_1.md, round2.md
  if (/[_]\d+\.\w+$/.test(filename)) return true;
  if (/\d+\.\w+$/.test(filename)) return true;
  return false;
}

/**
 * Extract the first requirement document path from free-form text.
 *
 * Matches tokens shaped like relative docs-path or absolute Markdown paths.
 * Examples: `docs/design/82_Feat.md`, `/absolute/path/spec.md`.
 *
 * Return semantics:
 * - 0 matches → `null`
 * - 1 match   → the matched path
 * - 2+ matches, same directory with version-like filenames
 *   (e.g. `docs/design/v1.md` + `docs/design/v2.md`) → `null` (ambiguous —
 *   caller should NOT guess); `candidates` callback receives the full list
 *   so the caller can log/audit them for diagnostics.
 * - 2+ matches, same directory but NOT version-like (e.g. `spec.md` +
 *   `notes.md`) → first match (take-first; not a version ambiguity).
 * - 2+ matches, different directories → first match (take-first heuristic;
 *   the user likely mentioned multiple docs, the first is the primary target).
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

  // Multiple matches: check for version-like ambiguity in same directory.
  // Only return null (ambiguous) when ALL matches share the same directory
  // AND all filenames look like version variants (v1/v2, _1/_2, etc.).
  // Otherwise: take first match (user likely mentioned multiple docs).
  const dirs = new Set(matches.map(p => p.replace(/\/[^/]*$/, "")));
  if (dirs.size === 1) {
    // Same directory — check if all filenames are version-like
    const filenames = matches.map(p => p.replace(/^.*\//, ""));
    const allVersionLike = filenames.every(f => isVersionLikeFilename(f));
    if (allVersionLike) {
      // Version ambiguity: don't guess, return null with candidates
      if (candidates) {
        candidates(matches);
      }
      return null;
    }
    // Same directory but not version-like → take first (not ambiguous)
  }

  // Different directories, or same directory without version ambiguity → take first
  return matches[0];
}
