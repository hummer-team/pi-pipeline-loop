/**
 * @module pipeline-init
 * /pipeline_init [0|1] — initializes the .pi/ directory structure and generates verify.md files.
 *
 * - `0` (dir): Creates .pi/ directory and copies template files from src/template/
 * - `1` (verify): Generates verify.md files from skill definitions
 * - No argument: Runs dir first, then verify
 *
 * Emits stage-convention status via PipelineUI and returns detailed result content
 * for the command bridge.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Command } from "../types";
import { CONFIG_DIR_NAME } from "../constants";
import { generateVerifyFiles } from "../core/verify-generator";
import { safeWriteAuditLog } from "../utils/auditLog";

/** Template directory — resolves to dist/template/ in production or src/template/ in dev */
const TEMPLATE_DIR = path.resolve(__dirname, "..", "template");

/**
 * Recursively collects all files in a directory, returning paths relative to the root.
 */
function collectTemplateFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTemplateFiles(fullPath, base));
    } else {
      results.push(path.relative(base, fullPath));
    }
  }
  return results;
}

/**
 * Counts how many template files already exist in the target .pi/ directory.
 * Excludes guide.md from the check (guide.md is always overwritten).
 */
function countExistingFiles(templateFiles: string[], targetDir: string): number {
  let count = 0;
  for (const relPath of templateFiles) {
    // Skip guide.md — it's always overwritten, not checked
    if (relPath === "guide.md") continue;
    const targetPath = path.join(targetDir, relPath);
    if (fs.existsSync(targetPath)) {
      count++;
    }
  }
  return count;
}

/**
 * Creates the `/pipeline_init` command.
 *
 * @param config - Pipeline configuration
 * @returns Command object
 */
export function createPipelineInitCommand(
  config: PipelineConfig,
): Command {
  return {
    name: "pipeline_init",
    description:
      "Initialize the .pi/ directory structure and generate verify.md files. " +
      "Use 0 for directory setup, 1 for verify generation, or no argument for both.",
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      // Parse argument — supports string "0"/"1"/"" or object { sub: "0"|"1"|"" }
      const sub = typeof args === "string"
        ? (args as string).trim()
        : String((args as Record<string, unknown>)?.sub ?? "").trim();

      const runDir = sub === "0" || sub === "";
      const runVerify = sub === "1" || sub === "";

      // ── Dir branch ─────────────────────────────────────────────────────
      if (runDir) {
        const dirResult = await executeDirBranch(config, ctx);
        if (!dirResult.success) {
          return dirResult;
        }
        // If sub === "0", check if option 3 flagged verify-after
        if (sub === "0") {
          if (dirResult.verifyAfter) {
            return await executeVerifyBranch(config);
          }
          return dirResult;
        }
        // sub === "" → continue to verify branch after dir (runVerify path, no duplicate verify)
      }

      // ── Verify branch ──────────────────────────────────────────────────
      if (runVerify) {
        return await executeVerifyBranch(config);
      }

      return { success: true, summary: "pipeline_init completed" };
    },
  };
}

/**
 * Dir branch: copies template files to .pi/ directory.
 * Returns `content` with copied/skipped file lists for bridge display.
 */
async function executeDirBranch(
  config: PipelineConfig,
  ctx?: any,
): Promise<{ success: boolean; verifyAfter?: boolean; summary?: string; content?: string; error?: string }> {
  const targetDir = path.join(config.projectRoot, CONFIG_DIR_NAME);

  // Check template directory exists
  if (!fs.existsSync(TEMPLATE_DIR)) {
    const errMsg = `Template directory not found: ${TEMPLATE_DIR}`;
    await safeWriteAuditLog("pipeline_init_error", { error: errMsg }, "error");
    return { success: false, error: errMsg };
  }

  // Collect all template files
  const templateFiles = collectTemplateFiles(TEMPLATE_DIR);

  // File-mark check: how many template files already exist in target?
  const existingCount = countExistingFiles(templateFiles, targetDir);

  if (existingCount > 0) {
    // Multiple execution detected — prompt user for action
    const hasUI = typeof ctx?.ui?.select === "function";

    if (hasUI) {
      const choice: string | undefined = await ctx.ui.select(
        "pipeline_init has been run before. Please select:",
        [
          "1. 强制覆盖所有文件",
          "2. 跳过已存在文件",
          "3. 重新执行 verify 生成",
          "4. 取消",
        ],
      );

      // undefined = Escape / cancel
      if (!choice || choice === "4. 取消" || choice === "4") {
        return { success: true, summary: "Cancelled by user", content: "# pipeline_init — cancelled by user" };
      }

      if (choice === "1. 强制覆盖所有文件" || choice === "1") {
        return copyTemplateFiles(templateFiles, targetDir, "overwrite", config);
      }
      if (choice === "2. 跳过已存在文件" || choice === "2") {
        return copyTemplateFiles(templateFiles, targetDir, "skip", config);
      }
      if (choice === "3. 重新执行 verify 生成" || choice === "3") {
        const copyResult = await copyTemplateFiles(templateFiles, targetDir, "skip", config);
        if (!copyResult.success) return copyResult;
        // Flag outer execute() to run verify branch after returning; propagate content
        return { success: true, verifyAfter: true, summary: "Files copied (skip mode)", content: copyResult.content };
      }

      // Fallback: treat as skip
      return copyTemplateFiles(templateFiles, targetDir, "skip", config);
    } else {
      // No UI — default to skip strategy
      return copyTemplateFiles(templateFiles, targetDir, "skip", config);
    }
  }

  // First time — copy all files
  return copyTemplateFiles(templateFiles, targetDir, "overwrite", config);
}

/**
 * Returns the display path for a template file.
 * `pipeline_loop.json` lives at project root; all others live under `.pi/`.
 */
function displayPath(rel: string): string {
  return rel === "pipeline_loop.json" ? rel : `${CONFIG_DIR_NAME}/${rel}`;
}

/**
 * Copies template files to the target directory with the specified strategy.
 * Collects copied/skipped file lists and returns a detailed `content` string
 * for the command bridge.
 */
async function copyTemplateFiles(
  templateFiles: string[],
  targetDir: string,
  strategy: "overwrite" | "skip",
  config: PipelineConfig,
): Promise<{ success: boolean; summary?: string; content?: string; error?: string }> {
  try {
    let copiedCount = 0;
    let skippedCount = 0;
    const copiedFiles: string[] = [];
    const skippedFiles: string[] = [];

    for (const relPath of templateFiles) {
      const srcPath = path.join(TEMPLATE_DIR, relPath);
      const destPath = path.join(targetDir, relPath);

      // guide.md is always overwritten regardless of strategy
      const alwaysOverwrite = relPath === "guide.md";

      if (strategy === "skip" && !alwaysOverwrite && fs.existsSync(destPath)) {
        skippedCount++;
        skippedFiles.push(displayPath(relPath));
        continue;
      }

      // Ensure parent directory exists
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(srcPath, destPath);
      copiedCount++;
      copiedFiles.push(displayPath(relPath));
    }

    // Also copy pipeline_loop.json to project root if it exists in template
    const loopJsonRelPath = "pipeline_loop.json";
    if (templateFiles.includes(loopJsonRelPath)) {
      const destLoopJson = path.join(config.projectRoot, loopJsonRelPath);
      if (!fs.existsSync(destLoopJson) || strategy === "overwrite") {
        await fsp.copyFile(
          path.join(TEMPLATE_DIR, loopJsonRelPath),
          destLoopJson,
        );
        // Only add to copiedFiles if not already counted via templateFiles loop
        if (!copiedFiles.includes(displayPath(loopJsonRelPath))) {
          copiedFiles.push(displayPath(loopJsonRelPath));
          copiedCount++;
        }
      } else if (strategy === "skip") {
        if (!skippedFiles.includes(displayPath(loopJsonRelPath))) {
          skippedFiles.push(displayPath(loopJsonRelPath));
          skippedCount++;
        }
      }
    }

    await safeWriteAuditLog("pipeline_init_done", {
      files: String(copiedCount),
      skipped: String(skippedCount),
      target: targetDir,
    });

    // Build content string for bridge display
    const lines: string[] = [
      "# pipeline_init — .pi/ directory setup",
      `- copied: ${copiedCount}`,
      `- skipped: ${skippedCount}`,
      `- target: ${CONFIG_DIR_NAME}/`,
    ];
    if (copiedFiles.length > 0) {
      lines.push("Copied files:");
      for (const f of copiedFiles) {
        lines.push(`  - ${f}`);
      }
    }
    if (skippedFiles.length > 0) {
      lines.push("Skipped files:");
      for (const f of skippedFiles) {
        lines.push(`  - ${f}`);
      }
    }

    return {
      success: true,
      summary: `Copied ${copiedCount} file(s) to ${CONFIG_DIR_NAME}/${strategy === "skip" ? ` (skipped ${skippedCount})` : ""}`,
      content: lines.join("\n"),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("pipeline_init_error", { error: errMsg }, "error");
    return { success: false, error: errMsg };
  }
}

/**
 * Verify branch: generates verify.md files from skill definitions.
 */
async function executeVerifyBranch(
  config: PipelineConfig,
): Promise<{ success: boolean; summary?: string; results?: unknown[] }> {
  // Pre-check: .pi/skills must exist
  const skillsDir = path.join(config.projectRoot, CONFIG_DIR_NAME, "skills");
  if (!fs.existsSync(skillsDir)) {
    return {
      success: true,
      summary: `skipped: ${CONFIG_DIR_NAME}/skills not found. Run /pipeline_init 0 first`,
      results: [],
    };
  }

  const results = await generateVerifyFiles(config);

  const generated = results.filter(r => r.status === "generated");
  const skipped = results.filter(r => r.status === "skipped");
  const errored = results.filter(r => r.status === "error");

  return {
    success: true,
    summary: `Generated ${generated.length} verify.md file(s), skipped ${skipped.length}, errors ${errored.length}`,
    results,
  };
}
