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
import * as path from "node:path";
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
 *
 * Accepts any object with optional `auditDir` and `piWorkDir` fields so that
 * both full `PipelineConfig` instances and lightweight option bags (e.g.
 * `SessionStateOptions`) can share the same derivation logic.
 */
export function resolveAuditDir(config: {
  auditDir?: string;
  piWorkDir?: string;
}): string {
  return config.auditDir ?? `${config.piWorkDir ?? CONFIG_DIR_NAME}/audit`;
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
 * Returns the ordered list of absolute candidate file paths where a domain
 * skill definition may be located for the given `domainId`.
 *
 * Resolution chain (Phase 3 / 184_Bug D9 — "project-first, home-fallback"):
 *   1. project-level: `{projectRoot}/{expanded domainDir}/{domainId}.md`
 *      (domainDir supports `~` expansion and absolute paths)
 *   2. home-level: `{homedir}/.pi/domains/{domainId}.md` (existing behaviour anchor)
 *   3. empty — caller treats as "skip injection"
 *
 * All returned paths are absolute and ready for direct `fs.readFile` calls.
 * The actual file-read and frontmatter handling live in
 * `prompt-injector.ts:buildDomainSkill` (Phase 3), which consumes this
 * function as its single source of truth for candidate resolution.
 */
export function resolveDomainSkillCandidates(
  config: PipelineConfig,
  domainId: string,
): string[] {
  const fileName = `${domainId}.md`;

  // Project-level candidate — supports ~ expansion and absolute paths
  const domainDir = config.domainDir ?? `${CONFIG_DIR_NAME}/domains`;
  const expandedDomainDir = expandHomePath(domainDir);
  const projectCandidate = path.isAbsolute(expandedDomainDir)
    ? path.join(expandedDomainDir, fileName)
    : path.join(config.projectRoot, expandedDomainDir, fileName);

  // Home-level fallback — {homedir}/.pi/domains/{id}.md
  const homeCandidate = path.join(os.homedir(), CONFIG_DIR_NAME, "domains", fileName);

  return [projectCandidate, homeCandidate];
}
