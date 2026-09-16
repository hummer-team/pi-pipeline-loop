/**
 * @module regex-utils
 * Small shared helpers for building RegExp patterns from literal strings.
 *
 * Extracted (Phase 1 / 179) so both the completion-marker precheck
 * (auto-verifier) and the pipeline-turn bare-form gate (agent-settled) escape
 * user/document-provided literals the same way instead of duplicating the logic.
 */

/**
 * Escapes a string for safe use inside a RegExp pattern.
 * Replaces all special regex characters with their escaped forms.
 *
 * @param str - Raw literal string
 * @returns The escaped string, safe to embed in `new RegExp(...)`
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
