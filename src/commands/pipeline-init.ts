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
import { createPipelineUI } from "../core/pipeline-ui";
import { safeWriteAuditLog } from "../utils/auditLog";
import { askProtectDecision } from "../utils/protect-ask";
import { resolveStagePath, DEFAULT_VERIFY_FILE } from "../constants";

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
      const ui = createPipelineUI(config);
      try {
        // Goal 1: Override status bar to "init" stage during command execution
        ui.setStage(ctx, "init");

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
      } finally {
        // Restore session-level status (Option A): use meta.currentStage if available, fallback to "clarify"
        const stage = ctx?.session?.getMeta?.()?.currentStage ?? "clarify";
        ui.setStage(ctx, stage);
      }
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
          "1. Force overwrite all files",
          "2. Skip existing files",
          "3. Re-run verify generation",
          "4. Cancel",
        ],
      );

      // undefined = Escape / cancel
      if (!choice || choice === "4. Cancel" || choice === "4") {
        return { success: true, summary: "Cancelled by user", content: "# pipeline-init — cancelled by user" };
      }

      if (choice === "1. Force overwrite all files" || choice === "1") {
        return copyTemplateFiles(templateFiles, targetDir, "overwrite", config);
      }
      if (choice === "2. Skip existing files" || choice === "2") {
        return copyTemplateFiles(templateFiles, targetDir, "skip", config);
      }
      if (choice === "3. Re-run verify generation" || choice === "3") {
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

    // Ensure docs/ directory exists for stage write whitelist (Phase 4)
    // Default write scope for clarify/plan/review is docs/; creating it avoids
    // first-write friction. Already-exists case is silently ignored (recursive: true).
    const docsDir = path.join(config.projectRoot, "docs");
    let docsCreated = false;
    if (!fs.existsSync(docsDir)) {
      await fsp.mkdir(docsDir, { recursive: true });
      docsCreated = true;
    }

    await safeWriteAuditLog("pipeline-init_done", {
      files: String(copiedCount),
      skipped: String(skippedCount),
      target: targetDir,
      docsDir: docsCreated ? "created" : "exists",
    });

    // Build content string for bridge display
    const lines: string[] = [
      "# pipeline-init — .pi/ directory setup",
      `- copied: ${copiedCount}`,
      `- skipped: ${skippedCount}`,
      `- target: ${CONFIG_DIR_NAME}/`,
      `- docs/: ${docsCreated ? "created" : "already exists"}`,
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
      summary: `Copied ${copiedCount} file(s) to ${CONFIG_DIR_NAME}/${strategy === "skip" ? ` (skipped ${skippedCount})` : ""}; docs/ ${docsCreated ? "created" : "ensured"}`,
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
  // Phase 6 (146): decouple gate — enable when llmExtract=true OR init.conflictCheck="model"
  const conflictCheckEnabled = config.init?.conflictCheck === "model";
  if (config.llmExtract !== true && !conflictCheckEnabled) return null;

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

  // LLM extraction progress animation (gated by output.pipelineStage)
  const ui = createPipelineUI(config);
  const showWorking = config.output?.pipelineStage === true && llmEnabled;
  if (showWorking) ui.progressStart(ctx, "init");

  // Phase 3 (Bug 2): when protect.ask=true, ask the user before overwriting an
  // existing verify.md via the merge path. "allow" proceeds, "block" skips the stage.
  const onMergeAsk = config.protect?.ask === true
    ? async (stage: string, verifyPath: string): Promise<"allow" | "block"> => {
        const meta = ctx?.session?.getMeta?.();
        if (!meta) return "block"; // no session meta → cannot ask → block (fail-safe, consistent with askProtectDecision Esc/no-UI)
        // verifyPath is already a relative path like `.pi/references/{stage}_spec/verify.md`
        const relPath = verifyPath.startsWith(config.projectRoot)
          ? verifyPath.slice(config.projectRoot.length + 1)
          : verifyPath;
        return askProtectDecision(ctx, meta, relPath);
      }
    : undefined;

  let results: VerifyGenerateResult[];
  try {
    results = await generateVerifyFiles(config, {
      callLLM: callLLM ?? undefined,
      onLLMStageStart: showWorking
        ? (stage: string) => { ui.progressUpdate(ctx, `(${stage})`); }
        : undefined,
      onMergeAsk,
    });
  } finally {
    if (showWorking) ui.progressEnd(ctx);
  }

  const generated = results.filter(r => r.status === "generated");
  const merged = results.filter(r => r.status === "merged");
  const skipped = results.filter(r => r.status === "skipped");
  const errored = results.filter(r => r.status === "error");

  // Build content string for bridge display — per-stage annotation
  const lines: string[] = [
    "# pipeline-init — verify.md generation",
    `- generated: ${generated.length}`,
    `- merged: ${merged.length}`,
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
  if (merged.length > 0) {
    lines.push("Merged (rules added to existing verify.md):");
    for (const r of merged) {
      const addedDesc = r.addedItems && r.addedItems.length > 0
        ? `+${r.addedItems.length}: ${r.addedItems.join(", ")}`
        : "merged";
      lines.push(`  - ${r.stage} (${addedDesc})`);
    }
  }
  if (skipped.length > 0) {
    lines.push("Skipped:");
    for (const r of skipped) {
      if (r.reason === "skill_not_found") {
        lines.push(`  - ${r.stage} (skipped: skill_not_found)`);
      } else if (r.reason === "no_items") {
        lines.push(`  - ${r.stage} (skipped: no_items)`);
      } else if (r.reason === "exists_custom") {
        lines.push(`  - ${r.stage} (skipped: user-authored custom rules protected)`);
      } else if (r.reason === "exists") {
        // Phase 2 (Bug 1): explicit display for "rules already present" skip —
        // avoids falling through to the "unknown reason" branch.
        lines.push(`  - ${r.stage} (skipped: rules already present)`);
      } else if (r.reason === "user_declined") {
        // Phase 3 (Bug 2): user declined overwrite via protect.ask dialog
        lines.push(`  - ${r.stage} (skipped: user declined overwrite)`);
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

  // Phase 4 (Bug 4-B): warn if any stage's verify.md references {requirementDoc}
  // placeholder — requires /pipeline-start <doc_file> to resolve.
  const placeholderStages = results.filter(r => r.hasRequirementDocPlaceholder === true);
  if (placeholderStages.length > 0) {
    const stageNames = placeholderStages.map(r => r.stage).join(", ");
    lines.push(`- warn: verify.md references {requirementDoc} in stage(s) [${stageNames}] — start pipeline with /pipeline-start <doc_file> to resolve`);
  }

  // Summary audit — unified for sub="1" and sub="" paths
  await safeWriteAuditLog("pipeline-init_verify", {
    generated: String(generated.length),
    skipped: String(skipped.length),
    errors: String(errored.length),
    llmEnabled: String(llmEnabled),
  });

  // Phase 6 (146): model-based conflict detection (after verify generation)
  let conflictContent = "";
  if (config.init?.conflictCheck !== "off") {
    try {
      const conflictResults = await runConflictCheck(config, callLLM);
      if (conflictResults.length > 0) {
        conflictContent = await handleConflictResults(config, conflictResults, ctx);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("pipeline-init_conflict_check_error", {
        error: errMsg,
      }, "warn");
      // Failure doesn't block init — graceful degradation
    }
  }

  const finalContent = conflictContent
    ? lines.join("\n") + "\n\n" + conflictContent
    : lines.join("\n");

  return {
    success: true,
    summary: `Generated ${generated.length} verify.md file(s), merged ${merged.length}, skipped ${skipped.length}, errors ${errored.length}`,
    content: finalContent,
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

// ─── Phase 6 (146): Model-based conflict detection ──────────────────────────

/** A single conflict/overlap item detected by the model */
interface ConflictItem {
  kind: "conflict" | "overlap";
  skillSnippet: string;
  pluginSnippet: string;
  reason: string;
  suggestion: string;
}

/** Result of conflict detection for a single stage */
interface ConflictCheckResult {
  stage: string;
  items: ConflictItem[];
  error?: string;
}

/**
 * Runs model-based conflict detection between business SKILL content and
 * plugin-injected prompt segments for each pipeline stage.
 *
 * @param config - Pipeline configuration
 * @param callLLM - LLM function (null if unavailable)
 * @returns Array of per-stage conflict results; empty if detection skipped
 */
async function runConflictCheck(
  config: PipelineConfig,
  callLLM: ((prompt: string) => Promise<string>) | null,
): Promise<ConflictCheckResult[]> {
  if (!callLLM) {
    await safeWriteAuditLog("pipeline-init_conflict_check_skipped", {
      reason: "llm_unavailable",
    });
    return [];
  }

  if (config.init?.conflictCheck === "off") {
    return [];
  }

  // Dynamic import for getConflictCheckPrompt + loadPromptConfig
  const { getConflictCheckPrompt } = await import("../core/prompt-config");
  const { readSkillBody } = await import("../core/verify-generator");
  const { loadPromptConfig } = await import("../core/prompt-config");

  const promptConfig = await loadPromptConfig(config.projectRoot);
  const stages: Array<[string, string]> = [
    ["clarify", "design/SKILL.md"],
    ["plan", "plan/SKILL.md"],
    ["develop", "develop/SKILL.md"],
    ["review", "review/SKILL.md"],
    ["fix", "fix/SKILL.md"],
  ];

  const results: ConflictCheckResult[] = [];

  for (const [stage, skillPath] of stages) {
    const skillBody = await readSkillBody(
      path.join(CONFIG_DIR_NAME, "skills", skillPath),
      config.projectRoot,
    );
    if (!skillBody) continue;

    // Build plugin segments for this stage
    const executorKey = `stage_executor_${stage}`;
    const deliverableKey = `stage_deliverable_${stage}`;
    const pluginSegments: string[] = [];
    if (promptConfig[executorKey]) pluginSegments.push(`[stage_executor_${stage}]\n${promptConfig[executorKey]}`);
    if (promptConfig[deliverableKey]) pluginSegments.push(`[stage_deliverable_${stage}]\n${promptConfig[deliverableKey]}`);

    if (pluginSegments.length === 0) continue;

    // Get conflict check prompt (with fallback chain)
    const checkPrompt = await getConflictCheckPrompt(config.projectRoot, stage);
    const fullPrompt = `${checkPrompt}\n\n---\n\nSkill content:\n\n${skillBody}\n\n---\n\nPlugin segments:\n\n${pluginSegments.join("\n\n")}`;

    // Call LLM with retry on parse failure
    let parsed: ConflictCheckResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await callLLM(fullPrompt);
        let cleaned = response.trim();
        const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

        const obj = JSON.parse(cleaned);
        if (obj && typeof obj === "object" && Array.isArray(obj.items)) {
          parsed = { stage, items: obj.items };
          break;
        }
      } catch (err) {
        if (attempt === 1) {
          // Second attempt failed — skip + audit
          const errMsg = err instanceof Error ? err.message : String(err);
          await safeWriteAuditLog("pipeline-init_conflict_check_error", {
            stage,
            error: errMsg,
          }, "warn");
          results.push({ stage, items: [], error: errMsg });
        }
        // First attempt failed — retry silently
      }
    }

    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Presents conflict detection results to the user via TUI and handles their choice.
 * Returns a summary of actions taken.
 */
async function handleConflictResults(
  config: PipelineConfig,
  conflictResults: ConflictCheckResult[],
  ctx?: any,
): Promise<string> {
  const stagesWithIssues = conflictResults.filter(r => r.items.length > 0);
  if (stagesWithIssues.length === 0) {
    return "No conflicts/overlaps detected between SKILL and plugin prompts.";
  }

  // Build summary of issues
  const lines: string[] = ["# SKILL vs Plugin Conflict Detection"];
  let totalIssues = 0;
  for (const r of stagesWithIssues) {
    lines.push(`\n## Stage: ${r.stage} (${r.items.length} issue(s))`);
    for (const item of r.items) {
      totalIssues++;
      lines.push(`- [${item.kind}] ${item.reason}`);
      lines.push(`  - Skill: "${item.skillSnippet.slice(0, 80)}..."`);
      lines.push(`  - Plugin: "${item.pluginSnippet.slice(0, 80)}..."`);
    }
  }
  lines.push(`\nTotal: ${totalIssues} issue(s) across ${stagesWithIssues.length} stage(s)`);

  // TUI interaction: offer 3 choices
  const choice = await ctx?.ui?.select?.(
    `Detected ${totalIssues} conflict/overlap issue(s). Choose action:`,
    ["auto-optimize", "manual-optimize", "skip"],
  );

  if (choice === "auto-optimize") {
    // Collect suggestions
    const suggestions: string[] = [];
    for (const r of stagesWithIssues) {
      for (const item of r.items) {
        suggestions.push(`[${r.stage}] ${item.suggestion}`);
      }
    }
    // Second confirmation
    const confirm = await ctx?.ui?.select?.(
      `Apply these suggestions?\n${suggestions.join("\n")}`,
      ["yes", "no"],
    );
    if (confirm === "yes") {
      await safeWriteAuditLog("pipeline-init_conflict_check_auto", {
        issues: String(totalIssues),
        action: "auto-optimize",
      });
      lines.push("\nAuto-optimize: suggestions logged. Manual application required (SKILL files are user-owned).");
    } else {
      lines.push("\nAuto-optimize cancelled by user.");
    }
  } else if (choice === "manual-optimize") {
    ctx?.ui?.notify?.(`Please manually fix the ${totalIssues} issue(s) listed above in your SKILL files.`);
    await safeWriteAuditLog("pipeline-init_conflict_check_manual", {
      issues: String(totalIssues),
    });
  } else {
    // skip or no UI
    await safeWriteAuditLog("pipeline-init_conflict_check_skip", {
      issues: String(totalIssues),
    });
    lines.push("\nConflict detection skipped by user.");
  }

  return lines.join("\n");
}
