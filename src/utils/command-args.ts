/**
 * @module command-args
 * Pure function mapping registered command name → parsed Record<string, unknown>.
 *
 * Extracted from src/index.ts (formerly private `parseCommandArgs`) so that:
 *   1. The contract between command registration name (hyphenated, e.g. "pipeline-start")
 *      and the switch-case branch is explicit and testable in isolation.
 *   2. Parameterized unit tests can guard against future name drift between
 *      registration and parsing.
 */

/**
 * Parse command-line string args into the Record<string, unknown> shape
 * expected by internal Command.execute() implementations.
 *
 * IMPORTANT: case labels MUST match the command registration names exposed to
 * the user (see src/commands/*.ts `name` field). All four pipeline commands
 * use hyphenated names: pipeline-init / pipeline-start / pipeline-status /
 * pipeline-quit.
 */
export function parseCommandArgs(
  commandName: string,
  args: string,
): Record<string, unknown> {
  switch (commandName) {
    case "pipeline-init":
      return { sub: args.trim() };
    case "pipeline-start": {
      // Phase 3 (171): split first token (file) from rest (forwardArgs).
      // /pipeline-start docs/design/82_Feat.md full-und?
      //   → { file: "docs/design/82_Feat.md", forwardArgs: "full-und?", raw: "..." }
      // Empty/whitespace-only → file="" forwardArgs="" (backward compat).
      const trimmed = args.trim();
      if (!trimmed) {
        return { file: "", forwardArgs: "", raw: args };
      }
      const firstSpace = trimmed.search(/\s/);
      if (firstSpace === -1) {
        return { file: trimmed, forwardArgs: "", raw: args };
      }
      const file = trimmed.substring(0, firstSpace);
      const forwardArgs = trimmed.substring(firstSpace + 1).trim();
      return { file, forwardArgs, raw: args };
    }
    case "pipeline-resume": {
      // Phase 1 / 175 (R1Q7A): /pipeline-resume accepts free-form forward args.
      // e.g. `/pipeline-resume 2 答` → { forwardArgs: "2 答", raw: " 2 答" }
      // Phase 0 (182): --force-resume flag bypasses the frozen decision menu
      // and falls through to the legacy direct-resume path (escape hatch).
      const rawArgs = args.trim();
      const forceResume = rawArgs.includes("--force-resume");
      // Strip the flag from forwardArgs and normalize whitespace
      const forwardArgs = rawArgs.replace(/--force-resume/g, "").replace(/\s+/g, " ").trim();
      return { forwardArgs, forceResume, raw: args };
    }
    case "pipeline-status":
      return {};
    case "pipeline-quit":
      return {};
    default:
      return { raw: args };
  }
}
