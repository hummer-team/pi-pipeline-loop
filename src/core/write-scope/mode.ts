/**
 * @module write-scope/mode
 * 218 Phase 2 (T2.1/T2.2, F.2/D4): the SINGLE resolution point for the
 * `protect.whitelistMiss` three-state contract.
 *
 * Four-tier precedence (highest wins, D4):
 *   1. `stages[stage].protect.whitelistMiss`        — per-stage block (single value)
 *   2. `config.protect.whitelistMiss.stages[stage]` — global per-stage override table
 *   3. `config.protect.whitelistMiss.mode` (or the string shorthand itself)
 *   4. `"ask"`                                       — the F.2 default
 *
 * Semantics (F.2, locked):
 * - NEVER relaxes hardcoded/gitignore protection, git policy, destructive
 *   commands or read-only deliverables — those layers are decided by their own
 *   channels before any whitelist-miss handling applies.
 * - `"deny"` keeps the pre-218 behaviour (immediate block + `read_only_path`
 *   violation counting) byte-for-byte (global constraint 8).
 */

import type { PipelineConfig, PipelineStage, WhitelistMissConfig, WhitelistMissMode } from "../../types";

/** Value guard for runtime-loaded configs (JSON input is not type-checked). */
function isWhitelistMissMode(value: unknown): value is WhitelistMissMode {
  return value === "ask" || value === "deny" || value === "allow";
}

/**
 * Resolve the effective whitelist-miss mode for one stage.
 *
 * @param config - Full pipeline configuration (global + stage protect blocks)
 * @param stage - The stage being guarded
 * @returns The resolved mode; "ask" when nothing is configured
 */
export function resolveWhitelistMissMode(
  config: PipelineConfig,
  stage: PipelineStage,
): WhitelistMissMode {
  // Tier 1: per-stage block (highest priority per D4 / F.2).
  const stageBlock = config.stages?.[stage]?.protect?.whitelistMiss;
  if (isWhitelistMissMode(stageBlock)) return stageBlock;

  // Tier 2/3: global contract — string shorthand or object form.
  const raw = config.protect?.whitelistMiss;
  if (raw === undefined) return "ask";

  if (isWhitelistMissMode(raw)) return raw;

  if (typeof raw === "object" && raw !== null) {
    const obj = raw as WhitelistMissConfig;
    const tableEntry = obj.stages?.[stage];
    if (isWhitelistMissMode(tableEntry)) return tableEntry;
    if (isWhitelistMissMode(obj.mode)) return obj.mode;
  }

  // Tier 4: F.2 default. An unrecognized shape (should have been dropped by
  // the loader) degrades to "ask" — the interactive default, never "deny".
  return "ask";
}
