/**
 * @module verify-file-parser
 * 225 code-review fix (issue 5): leaf module for verify.md parsing.
 *
 * `parseVerifyFile` used to live in `auto-verifier.ts`, which forced
 * `commit-contract.ts` (a leaf consumer: contract derivation + elevation)
 * into a RUNTIME import edge `commit-contract → auto-verifier` that closed a
 * cycle with `auto-verifier → commit-contract` (`hasCommitRequirement`). That
 * cycle only worked because the call was lazily executed; any module-level
 * call (or stricter ESM evaluation order) would break it.
 *
 * This module is a strict LEAF: it imports only `verify-frontmatter` (pure
 * parsing) and node:fs. `auto-verifier.ts` and `commit-contract.ts` both
 * import from here, restoring the one-directional dependency:
 * `auto-verifier → verify-file-parser ← commit-contract`.
 *
 * The public API of `parseVerifyFile` / `ParsedVerifyFile` is unchanged;
 * `auto-verifier.ts` re-exports it for backward compatibility.
 */

import fs from "node:fs/promises";
import { parseFrontmatter, type VerifyRules } from "./verify-frontmatter";

/**
 * Result of parsing a verify.md file.
 *
 * Phase 6 / 177 (D8): the Markdown body is a human-readable contract only —
 * the plugin reads frontmatter rules and `runtime:` anchors. The legacy `prompt`
 * (body) field was removed as a dead "write-only" field.
 */
export interface ParsedVerifyFile {
  /** Verification rules (null if no YAML frontmatter with keywords) */
  rules: VerifyRules | null;
  /** Phase 9: parse failure reason (present when rules is null due to parse error) */
  parseError?: string;
}

/**
 * Parses a verify.md file into rules.
 * Expects YAML frontmatter (between --- delimiters) for keyword rules.
 * The Markdown body is intentionally not returned (human-readable only).
 */
export async function parseVerifyFile(
  verifyPath: string,
): Promise<ParsedVerifyFile> {
  let raw: string;
  try {
    raw = await fs.readFile(verifyPath, "utf-8");
  } catch {
    return { rules: null, parseError: "file read failed" };
  }

  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 2) {
    return { rules: null, parseError: "no frontmatter delimiter" };
  }

  // parts[0] is before first --- (should be empty/whitespace)
  // parts[1] is the YAML frontmatter content
  const frontmatter = parts[1].trim();

  const rules = await parseFrontmatter(frontmatter);

  if (!rules) {
    return { rules: null, parseError: "frontmatter parse failed" };
  }

  return { rules };
}
