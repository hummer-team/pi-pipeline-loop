/**
 * @module work-dir
 * Centralized resolvers for plugin-owned directory paths.
 *
 * All production code that needs to read a directory derived from `piWorkDir`
 * MUST go through these helpers instead of constructing paths from raw string
 * literals. This keeps the `piWorkDir` indirection transparent for consumers
 * and prevents future scattered-hardcoding regressions.
 *
 * See `184_Bug_plan.md` Phase 0 — D7 (auditDir consolidation), D4/D5 (piWorkDir).
 */

import * as os from "node:os";
import { CONFIG_DIR_NAME } from "../constants";
import type { PipelineConfig } from "../types";

/**
 * Returns the configured `piWorkDir` (relative to projectRoot), falling back
 * to CONFIG_DIR_NAME (".pi") when the field is absent.
 *
 * The fallback matches the default applied by `resolvePipelineConfig`, so in
 * practice `config.piWorkDir` is always defined after resolution; the guard
 * exists to keep this helper safe for partial / handcrafted configs (tests).
 */
export function resolvePiWorkDir(config: PipelineConfig): string {
  return config.piWorkDir ?? CONFIG_DIR_NAME;
}

/**
 * Returns the resolved audit log directory path (relative to projectRoot).
 *
 * Uses `config.auditDir` directly when set (resolve-time rewrite already
 * applied the piWorkDir prefix), otherwise derives the default
 * `${piWorkDir}/audit` so a custom piWorkDir propagates to the audit dir.
 */
export function resolveAuditDir(config: PipelineConfig): string {
  return config.auditDir ?? `${resolvePiWorkDir(config)}/audit`;
}

/**
 * Expands a leading `~` in a path to the user's home directory.
 *
 * - `~/foo/bar` → `{homedir}/foo/bar`
 * - Absolute path → returned unchanged
 * - Relative path → returned unchanged (caller decides how to resolve)
 *
 * Used by domainDir resolution (Phase 3 / 184_Bug D9) so users can write
 * `domainDir: "~/custom/domains"` in pipeline_loop.json.
 */
export function expandHomePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", os.homedir());
  }
  return p;
}

/**
 * Returns the ordered list of candidate file paths where a domain skill
 * definition may be located for the given `domainId`.
 *
 * Resolution chain (Phase 3 / 184_Bug D9 — "project-first, home-fallback"):
 *   1. project-level: `{projectRoot}/{domainDir}/{domainId}.md`
 *      (domainDir may be an absolute path or `~/...` — left to the caller to expand)
 *   2. home-level: `~/.pi/domains/{domainId}.md` (existing behaviour anchor)
 *   3. empty — caller treats as "skip injection"
 *
 * This function only computes the candidate list; the actual file-read and
 * frontmatter handling live in `prompt-injector.ts:buildDomainSkill` (Phase 3).
 */
export function resolveDomainSkillCandidates(
  config: PipelineConfig,
  domainId: string,
): string[] {
  const domainDir = config.domainDir ?? `${CONFIG_DIR_NAME}/domains`;
  // Project-level candidate — caller is responsible for ~ expansion and
  // absolute-vs-relative disambiguation before reading.
  const projectCandidate = `${domainDir}/${domainId}.md`;
  // Home-level fallback — `~/.pi/domains/{id}.md` literal; caller expands `~`.
  const homeCandidate = `~/.pi/domains/${domainId}.md`;
  return [projectCandidate, homeCandidate];
}
