/**
 * @module verify-rules-cache
 * Module-level cache for parsed verify.md requiredCommands prefixes.
 * Used by tool-guard to quickly check whether a bash command matches
 * any expected command prefix from the current stage's verify.md.
 *
 * Cache invalidation: mtime-based — when the verify.md file changes,
 * the cache entry is refreshed on next access.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig, PipelineStage } from "../types";
import { DEFAULT_VERIFY_FILE, resolveStagePath } from "../constants";
import { parseVerifyFile, type VerifyRules } from "./auto-verifier";

/**
 * Normalizes a command for prefix matching (lowercase, collapse whitespace, strip ./).
 * Mirrors normalizeCmdForMatch in command-verifier for consistency.
 */
function normalizePrefix(cmd: string): string {
  return cmd.toLowerCase().replace(/^\.\//, "").replace(/\s+/g, " ").trim();
}

/** Cache entry: normalized command prefixes + mtime of source verify.md */
interface CacheEntry {
  prefixes: string[];
  mtimeMs: number;
}

/** Module-level cache keyed by absolute verify.md path */
const cache = new Map<string, CacheEntry>();

/**
 * Returns the normalized command prefixes extracted from the current stage's
 * verify.md requiredCommands. Returns [] if the verify.md does not exist or
 * contains no requiredCommands.
 *
 * @param config - Pipeline configuration (for projectRoot)
 * @param stage - Current pipeline stage
 * @returns Array of normalized command prefixes
 */
export async function getStageRequiredCommandPrefixes(
  config: PipelineConfig,
  stage: PipelineStage,
): Promise<string[]> {
  const stageConfig = config.stages[stage];
  const verifyFile = stageConfig.verify?.verifyFile ?? resolveStagePath(DEFAULT_VERIFY_FILE, stage);
  const absPath = path.isAbsolute(verifyFile)
    ? verifyFile
    : path.join(config.projectRoot, verifyFile);

  // Check mtime for cache invalidation
  let mtimeMs = 0;
  try {
    const stat = fs.statSync(absPath);
    mtimeMs = stat.mtimeMs;
  } catch {
    return [];
  }

  const cached = cache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.prefixes;
  }

  // Parse and extract prefixes
  try {
    const { rules } = await parseVerifyFile(absPath);
    const prefixes = (rules?.requiredCommands ?? []).map(c => normalizePrefix(c.cmd));
    cache.set(absPath, { prefixes, mtimeMs });
    return prefixes;
  } catch {
    return [];
  }
}

/**
 * Clears the module-level verify rules cache (for testing).
 */
export function __clearVerifyRulesCache(): void {
  cache.clear();
}
