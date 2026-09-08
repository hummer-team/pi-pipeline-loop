/**
 * @module template-drift
 * Phase 6 (170): Detects drift between deployed template assets and the
 * repository source templates.
 *
 * Deployment model: when `/pipeline-init` runs, template files from
 * `src/template/` are copied to the project's `.pi/` directory. Over time
 * the deployed copies may diverge from the repo source (user customizations,
 * outdated versions, etc.).
 *
 * This module computes SHA-256 hashes for both sides and reports mismatches.
 * It does NOT modify deployed copies — drift is reported only.
 *
 * Fail-open: any IO error returns an empty array (no crash, no notify).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { safeWriteAuditLog } from "./auditLog";

/**
 * A single drift entry comparing a deployed asset to its repo source.
 */
export interface DriftEntry {
  /** Relative path of the asset within the template directory */
  asset: string;
  /** SHA-256 hash of the deployed copy */
  deployedHash: string;
  /** SHA-256 hash of the repo source */
  repoHash: string;
}

/**
 * Template asset paths to check for drift.
 * These are the critical assets that must stay in sync between the plugin
 * source templates and the deployed `.pi/` directory.
 *
 * Phase 6 (170): Skills (SKILL.md files) are included — the 09-01 incident
 * root cause was a drifted `.pi/skills/design/SKILL.md` (08-30 old version).
 * Agent definitions (`.pi/agents/*.md`) are intentionally excluded — they
 * often contain user customizations (model/thinking params).
 *
 * Phase 5 (173) C14: guide.md added — always overwritten by /pipeline-init,
 * so without drift detection, outdated guides silently persist. Users must
 * re-run /pipeline-init to update; drift warning makes this visible.
 */
const DRIFT_CHECK_ASSETS: string[] = [
  "references/pipeline-stage-prompt.yml",
  "references/clarify_template.md",
  "guide.md",
  "skills/design/SKILL.md",
  "skills/plan/SKILL.md",
  "skills/develop/SKILL.md",
  "skills/review/SKILL.md",
  "skills/fix/SKILL.md",
];

/**
 * Computes the SHA-256 hash of a file's contents.
 * Returns null if the file cannot be read.
 */
async function computeFileHash(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  } catch {
    return null;
  }
}

/**
 * Resolves the absolute path to the plugin's template source directory.
 *
 * Uses `__dirname` from the compiled CommonJS output (`dist/utils/template-drift.js`)
 * to navigate to `dist/template/`. When the template dir doesn't exist at the
 * expected location, returns null.
 */
function resolveRepoTemplateDir(): string | null {
  try {
    // __dirname = dist/utils/ (compiled) → go up 1 level to dist/, then into template/
    const distDir = path.resolve(__dirname, "..");
    const templateDir = path.join(distDir, "template");
    return templateDir;
  } catch {
    return null;
  }
}

/**
 * Checks all monitored template assets for drift between deployed and repo copies.
 *
 * @param config - Pipeline configuration (uses projectRoot for deployed path lookup)
 * @returns Array of DriftEntry for each asset whose deployed hash differs from repo
 */
export async function checkTemplateDrift(
  projectRoot: string,
): Promise<DriftEntry[]> {
  const repoTemplateDir = resolveRepoTemplateDir();
  if (!repoTemplateDir) {
    await safeWriteAuditLog("template_drift_error", {
      reason: "repo_template_dir_unresolved",
    }, "warn");
    return [];
  }

  const deployedBase = path.join(projectRoot, ".pi");
  const drifts: DriftEntry[] = [];

  for (const asset of DRIFT_CHECK_ASSETS) {
    try {
      const repoPath = path.join(repoTemplateDir, asset);
      const deployedPath = path.join(deployedBase, asset);

      const [repoHash, deployedHash] = await Promise.all([
        computeFileHash(repoPath),
        computeFileHash(deployedPath),
      ]);

      // Skip if either side is unreadable (directory missing, etc.)
      if (repoHash === null || deployedHash === null) continue;

      if (repoHash !== deployedHash) {
        drifts.push({ asset, deployedHash, repoHash });
      }
    } catch (err) {
      // Fail-open per asset: log but continue checking others
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("template_drift_error", {
        asset,
        error: errMsg,
      }, "warn");
    }
  }

  return drifts;
}
