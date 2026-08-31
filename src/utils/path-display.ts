/**
 * @module path-display
 * Shared helper for converting absolute paths to project-relative display strings.
 *
 * Used by pipeline-ui, pipeline-handoff, generate-summary, and prompt-injector
 * to show deliverable paths in a concise, human-readable format. Storage layer
 * (meta.summaries[].path, audit logs, contextFiles) keeps absolute paths for
 * machine reliability (hash checks, cross-session cwd differences).
 */

import path from "node:path";

/**
 * Converts an absolute path to a project-relative display string.
 *
 * - If absPath is within projectRoot: returns POSIX-normalized relative path
 *   (e.g. ".pi/audit/pipe-xxx/plan.md")
 * - If absPath is outside projectRoot: returns the original absolute path
 *   (POSIX-normalized)
 * - If projectRoot or absPath is empty/undefined: returns absPath as-is
 *
 * All returned paths use POSIX separators (forward slashes) for cross-platform
 * consistency in display output.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param absPath - Absolute path to convert
 * @returns Project-relative path (when inside root) or original absolute path
 */
export function toProjectRelative(projectRoot: string, absPath: string): string {
  if (!projectRoot || !absPath) {
    return absPath;
  }

  // Normalize both paths to resolve symlinks/.. segments consistently
  const normalizedRoot = path.resolve(projectRoot);
  const normalizedPath = path.resolve(absPath);

  // Check if the path is within the project root
  const rel = path.relative(normalizedRoot, normalizedPath);

  // path.relative returns an absolute path when the two paths are on different
  // drives (Windows) or when the path is genuinely outside the root (starts with "..")
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // Outside root — return POSIX-normalized absolute path
    return normalizedPath.split(path.sep).join("/");
  }

  // Inside root — return POSIX-normalized relative path
  return rel.split(path.sep).join("/");
}
