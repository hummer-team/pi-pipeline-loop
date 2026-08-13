/**
 * @module pipeline-init
 * /pipeline-init [0|1] — initializes the .pi/ directory structure and generates verify.md files.
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
 * Creates the `/pipeline-init` command.
 *
 * @param config - Pipeline configuration
 * @returns Command object
 */
export function createPipelineInitCommand(
  config: PipelineConfig,
): Command {
  return {
    name: "pipeline-init",
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
        if (!dirResult.success) return dirResult;
        // sub="0": verify only when option 3 flagged; sub="": always run verify after dir
        const needVerify = sub === "0" ? !!dirResult.verifyAfter : true;
        if (needVerify) {
          return runVerifyWithAudit(config, dirResult, { audit: !!dirResult.verifyAfter }, ctx);
        }
        return dirResult;
      }

      // ── Verify branch ──────────────────────────────────────────────────
      if (runVerify) {
        return await executeVerifyBranch(config, ctx);
      }

      return { success: true, summary: "pipeline-init completed", content: "# pipeline-init — nothing to do" };
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
    await safeWriteAuditLog("pipeline-init_error", { error: errMsg }, "error");
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
        "pipeline-init has been run before. Please select:",
        [
          "1. 强制覆盖所有文件",
          "2. 跳过已存在文件",
          "3. 重新执行 verify 生成",
          "4. 取消",
        ],
      );

      // undefined = Escape / cancel
      if (!choice || choice === "4. 取消" || choice === "4") {
        return { success: true, summary: "Cancelled by user", content: "# pipeline-init — cancelled by user" };
      }

      if (choice === "1. 强制覆盖所有文件" || choice === "1") {
        return copyTemplateFiles(templateFiles, targetDir, "overwrite", config);
      }
      if (choice === "2. 跳过已存在文件" || choice === "2") {
        return copyTemplateFiles(templateFiles, targetDir, "skip", config);
      }
      if (choice === "3. 重新执行 verify 生成" || choice === "3") {
        // Flag outer execute() to run verify branch (regenerate verify.md from skill Must markers)
        return { success: true, verifyAfter: true };
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

    await safeWriteAuditLog("pipeline-init_done", {
      files: String(copiedCount),
      skipped: String(skippedCount),
      target: targetDir,
    });

    // Build content string for bridge display
    const lines: string[] = [
      "# pipeline-init — .pi/ directory setup",
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
    await safeWriteAuditLog("pipeline-init_error", { error: errMsg }, "error");
    return { success: false, error: errMsg };
  }
}

/**
 * Import type for verify generation results.
 */
import type { VerifyGenerateResult } from "../core/verify-generator";

/**
 * Extracts text content from a pi-ai AssistantMessage.
 * Filters TextContent blocks and joins their text.
 */
function extractAssistantText(msg: { content: Array<{ type: string; text?: string }> }): string {
  return msg.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * Minimal type for pi-ai compat `complete()` function.
 * Avoids importing from `@earendil-works/pi-ai/compat` at compile time
 * (subpath export not resolvable under moduleResolution:"node").
 *
 * Signature: complete(model, context, options?)
 * - context: { messages } — conversation messages
 * - options: { apiKey?, transformHeaders?, env? } — auth/provider overrides
 */
type CompatCompleteFn = (
  model: unknown,
  context: {
    messages: Array<{ role: string; content: string; timestamp: number }>;
  },
  options?: {
    apiKey?: string;
    transformHeaders?: (h: Record<string, string>) => Record<string, string>;
    env?: Record<string, string>;
  },
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}>;

/**
 * Constructs a callLLM function using pi-ai compat `complete()` + ctx.modelRegistry.
 * Returns null if model is unavailable or llmExtract is disabled.
 *
 * Uses the official compat `complete()` entry point (auto-resolves provider via
 * `resolveApiProvider(model.api)` from the built-in registry) instead of
 * `createModels()` which creates an empty provider instance that swallows errors
 * via lazyStream, producing silent "fake success" (llmStatus="ok" but LLM never called).
 *
 * Error explicit: compat `complete()` returns (not rejects) error messages with
 * `errorMessage` / `stopReason === "error"`. We detect these and throw, so the
 * caller's catch → `llmStatus="fail"` + `verify_llm_extract_error` audit fires.
 *
 * @param config - Pipeline configuration
 * @param ctx - Runtime context with modelRegistry access
 * @returns callLLM function or null
 */
async function buildCallLLM(
  config: PipelineConfig,
  ctx?: any,
): Promise<((prompt: string) => Promise<string>) | null> {
  if (config.llmExtract !== true) return null;

  try {
    const extCtx = ctx?._ctx;
    if (!extCtx?.modelRegistry) {
      await safeWriteAuditLog("llm_build_error", { error: "no modelRegistry available in context" }, "error");
      return null;
    }

    const available = extCtx.modelRegistry.getAvailable();
    if (!available || available.length === 0) {
      await safeWriteAuditLog("llm_build_error", { error: "no models available in registry" }, "error");
      return null;
    }

    const model = extCtx.model ?? available[0];

    // Dynamic import: compat module auto-registers built-in providers on load.
    // @ts-expect-error subpath export not resolvable under moduleResolution:"node" — exists at runtime
    const compat = await import("@earendil-works/pi-ai/compat") as { complete: CompatCompleteFn };
    const { complete } = compat;

    // callLLM closure — reuse within single pipeline-init invocation
    const callLLM = async (prompt: string): Promise<string> => {
      const authResult = await extCtx.modelRegistry.getApiKeyAndHeaders(model);
      const apiKey = authResult?.ok ? authResult.apiKey : undefined;
      const headers = authResult?.ok ? authResult.headers : undefined;

      const msg = await complete(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        {
          ...(apiKey ? { apiKey } : {}),
          ...(headers ? { transformHeaders: (h: Record<string, string>) => ({ ...h, ...headers }) } : {}),
        },
      );

      // Error explicit: compat complete() returns error messages instead of rejecting.
      // Detect and throw so caller's catch → llmStatus="fail" + audit.
      if (msg.errorMessage || msg.stopReason === "error") {
        throw new Error(msg.errorMessage || "LLM returned error (stopReason=error)");
      }

      return extractAssistantText(msg);
    };

    return callLLM;
  } catch (err) {
    // Model unavailable or import failed — audit + degrade gracefully
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("llm_build_error", { error: errMsg }, "error");
    return null;
  }
}

/**
 * Verify branch: generates verify.md files from skill definitions.
 * Returns `content` with generated/skipped/errored counts and file lists.
 */
async function executeVerifyBranch(
  config: PipelineConfig,
  ctx?: any,
): Promise<{ success: boolean; summary?: string; content?: string; results?: VerifyGenerateResult[] }> {
  // Pre-check: .pi/skills must exist
  const skillsDir = path.join(config.projectRoot, CONFIG_DIR_NAME, "skills");
  if (!fs.existsSync(skillsDir)) {
    return {
      success: true,
      summary: `skipped: ${CONFIG_DIR_NAME}/skills not found. Run /pipeline-init 0 first`,
      content: `# pipeline-init — verify.md generation\n- skipped: ${CONFIG_DIR_NAME}/skills not found. Run /pipeline-init 0 first`,
      results: [],
    };
  }

  // Construct callLLM if llmExtract is enabled
  const callLLM = await buildCallLLM(config, ctx);
  const llmEnabled = callLLM !== null;

  // LLM extraction working indicator (gated by output.pipelineStage)
  const showWorking = config.output?.pipelineStage === true && llmEnabled;
  const onLLMStageStart = showWorking
    ? (stage: string) => { ctx?.ui?.setWorkingMessage?.(`Extracting items for ${stage} (LLM)...`); }
    : undefined;

  const results = await generateVerifyFiles(config, {
    callLLM: callLLM ?? undefined,
    onLLMStageStart,
  });

  // Restore default working message after LLM extraction
  if (showWorking) {
    ctx?.ui?.setWorkingMessage?.();
    ctx?.ui?.setWorkingIndicator?.();
  }

  const generated = results.filter(r => r.status === "generated");
  const skipped = results.filter(r => r.status === "skipped");
  const errored = results.filter(r => r.status === "error");

  // Build content string for bridge display — per-stage annotation
  const lines: string[] = [
    "# pipeline-init — verify.md generation",
    `- generated: ${generated.length}`,
    `- skipped: ${skipped.length}`,
    `- errors: ${errored.length}`,
    `- llmExtract: ${llmEnabled ? "on" : "off"}`,
  ];
  if (generated.length > 0) {
    lines.push("Generated:");
    for (const r of generated) {
      const detail = formatStageDetail(r);
      lines.push(`  - ${r.stage} (${detail})`);
    }
  }
  if (skipped.length > 0) {
    lines.push("Skipped:");
    for (const r of skipped) {
      if (r.reason === "skill_not_found") {
        lines.push(`  - ${r.stage} (skipped: skill_not_found)`);
      } else if (r.reason === "no_items") {
        lines.push(`  - ${r.stage} (skipped: no_items)`);
      } else {
        lines.push(`  - ${r.stage} (${r.error ?? "unknown reason"})`);
      }
    }
  }
  if (errored.length > 0) {
    lines.push("Errors:");
    for (const r of errored) {
      lines.push(`  - ${r.stage} (${r.error ?? "unknown error"})`);
    }
  }
  if (generated.length === 0) {
    const hasSkillNotFound = skipped.some(r => r.reason === "skill_not_found");
    const hasNoItems = skipped.some(r => r.reason === "no_items");
    if (hasSkillNotFound && hasNoItems) {
      // Mixed: show both hints
      lines.push(`- hint: skill files not found for some stages — check pipeline_loop.json skillPath and ${CONFIG_DIR_NAME}/skills/ layout`);
      lines.push("- hint: other stages have skill files but no **Must**/**必须** markers — add `**必须**` marker lines to those SKILL.md files");
    } else if (hasSkillNotFound) {
      lines.push(`- hint: skill files not found under ${CONFIG_DIR_NAME}/skills/. Check pipeline_loop.json skillPath config and ${CONFIG_DIR_NAME}/skills/ layout`);
    } else if (hasNoItems) {
      lines.push("- hint: skill files found but no **Must**/**必须** markers — add `**必须**` marker lines to SKILL.md files, then re-run");
    }
  }
  if (config.llmExtract === true && !llmEnabled) {
    lines.push("- llm: unavailable (no model configured)");
  }

  // Summary audit — unified for sub="1" and sub="" paths
  await safeWriteAuditLog("pipeline-init_verify", {
    generated: String(generated.length),
    skipped: String(skipped.length),
    errors: String(errored.length),
    llmEnabled: String(llmEnabled),
  });

  return {
    success: true,
    summary: `Generated ${generated.length} verify.md file(s), skipped ${skipped.length}, errors ${errored.length}`,
    content: lines.join("\n"),
    results,
  };
}

/**
 * Formats per-stage detail for TUI display.
 * Shows hardcoded/llm counts and status.
 */
function formatStageDetail(r: VerifyGenerateResult): string {
  const parts: string[] = [];
  if (r.hardcodedCount !== undefined) {
    parts.push(`hardcoded: ${r.hardcodedCount}`);
  }
  if (r.llmStatus === "ok" && r.llmCount !== undefined) {
    parts.push(`llm: ${r.llmCount}`);
  } else if (r.llmStatus === "fail") {
    parts.push("llm: fail, fallback");
  } else if (r.llmStatus === "off") {
    // LLM not enabled — don't show llm detail
  }
  return parts.length > 0 ? `${r.status}, ${parts.join(", ")}` : r.status;
}

/**
 * Runs verify generation with try/catch protection and optional audit logging.
 *
 * Used by the unified verify dispatch in execute() — both sub="0" (option 3 rerun)
 * and sub="" (combined dir+verify) paths converge here.
 *
 * @param dir  - The dir branch result to merge with verify output
 * @param opts.audit - Whether to record audit log (true only for option 3 rerun)
 */
async function runVerifyWithAudit(
  config: PipelineConfig,
  dir: { success: boolean; summary?: string; content?: string },
  opts: { audit: boolean },
  ctx?: any,
): Promise<{ success: boolean; summary?: string; content?: string; results?: VerifyGenerateResult[]; error?: string }> {
  try {
    const verify = await executeVerifyBranch(config, ctx);
    if (opts.audit) {
      await safeWriteAuditLog("pipeline-init_verify_rerun", {
        stage: "option3",
        generated: String(verify.results?.filter(r => r.status === "generated").length ?? 0),
        skipped: String(verify.results?.filter(r => r.status === "skipped").length ?? 0),
        errors: String(verify.results?.filter(r => r.status === "error").length ?? 0),
      });
    }
    return mergeInitResults(dir, verify);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (opts.audit) {
      await safeWriteAuditLog("pipeline-init_verify_rerun", { stage: "option3", error: errMsg }, "error");
    }
    return { success: false, error: errMsg };
  }
}

/**
 * Merges dir and verify branch results into a single result object.
 * Combines `summary` (`; `), `content` (`\n\n`), and passes through `results`.
 */
function mergeInitResults(
  dir: { success: boolean; summary?: string; content?: string },
  verify: { success: boolean; summary?: string; content?: string; results?: VerifyGenerateResult[] },
): { success: boolean; summary?: string; content?: string; results?: VerifyGenerateResult[] } {
  return {
    success: dir.success && verify.success,
    summary: [dir.summary, verify.summary].filter(Boolean).join("; "),
    content: [dir.content, verify.content].filter(Boolean).join("\n\n"),
    results: verify.results,
  };
}
