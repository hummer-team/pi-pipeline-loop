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
import { renderContractBlock, MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from "./skill-managed-block";
import { loadPromptConfig } from "../core/prompt-config";

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
 * Phase 5 / 177 (D11): Maps SKILL.md assets to their pipeline stage so their
 * managed-contract block can be rendered from the current yml config.
 */
const SKILL_ASSET_STAGE: Readonly<Record<string, string>> = {
  "skills/design/SKILL.md": "clarify",
  "skills/plan/SKILL.md": "plan",
  "skills/develop/SKILL.md": "develop",
  "skills/review/SKILL.md": "review",
  "skills/fix/SKILL.md": "fix",
};

/**
 * Reads a file as UTF-8, returning null when it cannot be read.
 */
async function readFileText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** SHA-256 of a UTF-8 string. */
function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Phase 5 / 177 (D11): Extracts the managed-contract block (markers inclusive).
 * Returns null when the markers are absent (pre-injection / user-authored file).
 */
function extractManagedBlock(content: string): string | null {
  const begin = content.indexOf(MANAGED_BLOCK_BEGIN);
  const end = content.indexOf(MANAGED_BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return content.slice(begin, end + MANAGED_BLOCK_END.length);
}

/** Normalizes block text for comparison (CRLF + surrounding whitespace). */
function normalizeBlock(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Checks all monitored template assets for drift between deployed and repo copies.
 *
 * Phase 5 / 177 (D11): SKILL.md assets are compared **only** within the
 * managed-contract block. The expected block is rendered from the current yml
 * `stage_deliverable_{stage}` (declaration-is-behavior) — block-external
 * localization is never counted as drift. A deployed SKILL without markers is
 * treated as "pending injection" (not drift). guide.md / clarify_template.md /
 * the yml keep whole-file hashing (always-overwrite assets).
 *
 * @param projectRoot - Project root (deployed `.pi/` lookup)
 * @param piWorkDir - Optional piWorkDir (defaults to ".pi" when omitted)
 * @returns Array of DriftEntry for each asset that genuinely drifted
 */
export async function checkTemplateDrift(
  projectRoot: string,
  piWorkDir: string = ".pi",
): Promise<DriftEntry[]> {
  const repoTemplateDir = resolveRepoTemplateDir();
  if (!repoTemplateDir) {
    await safeWriteAuditLog("template_drift_error", {
      reason: "repo_template_dir_unresolved",
    }, "warn");
    return [];
  }

  const deployedBase = path.join(projectRoot, piWorkDir);
  const drifts: DriftEntry[] = [];

  // Best-effort yml config for managed-block rendering; failure → SKILL checks skip.
  let promptConfig: Record<string, string> = {};
  try {
    promptConfig = await loadPromptConfig(projectRoot);
  } catch {
    // Fail-open: fall back to whole-file checks only for non-SKILL assets
  }

  for (const asset of DRIFT_CHECK_ASSETS) {
    try {
      const stage = SKILL_ASSET_STAGE[asset];
      if (stage) {
        // Managed-block-aware comparison for SKILL.md assets.
        const deployedPath = path.join(deployedBase, asset);
        const deployedContent = await readFileText(deployedPath);
        if (deployedContent === null) continue; // not deployed → no drift
        const deployedBlock = extractManagedBlock(deployedContent);
        if (deployedBlock === null) continue; // pending injection → not drift
        const deliverable = promptConfig[`stage_deliverable_${stage}`];
        if (!deliverable) continue;
        const expectedBlock = renderContractBlock(stage, deliverable);
        if (normalizeBlock(deployedBlock) !== normalizeBlock(expectedBlock)) {
          drifts.push({
            asset,
            deployedHash: sha256(deployedBlock),
            repoHash: sha256(expectedBlock),
          });
        }
        continue;
      }

      // Whole-file comparison for always-overwrite assets.
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

/**
 * Formats a drift notification message from an array of drift entries.
 * Phase 5 / 175 (R1Q2A): single notification with count + top 3 asset names
 * + /pipeline-init guidance. guide.md drift gets a hint appended.
 *
 * Returns null when drifts is empty (no notification needed).
 *
 * @param drifts - Array of drift entries to report
 * @returns English notification string, or null if no drifts
 */
export function formatDriftNotification(drifts: DriftEntry[]): string | null {
  if (drifts.length === 0) return null;

  const top3 = drifts.slice(0, 3).map(d => d.asset);
  const names = top3.join(", ") + (drifts.length > 3 ? `, … (+${drifts.length - 3} more)` : "");
  const guideHint = drifts.some(d => d.asset === "guide.md")
    ? " guide.md is outdated (overwrite via /pipeline-init)."
    : "";
  return `${drifts.length} template asset(s) drifted from repo: ${names}. Re-run /pipeline-init to overwrite.${guideHint}`;
}
