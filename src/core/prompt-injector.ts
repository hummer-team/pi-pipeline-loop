/**
 * @module prompt-injector
 * Factory for the `before_agent_start` hook.
 * Composes an 8-part system prompt appended after the pi base system prompt,
 * providing context references, domain skills, stage skills, loop status,
 * pipeline status, verification failures, verify tool guidance, and write scope.
 *
 * Injection method (D3): Plugin prompt is appended after `ctx.getSystemPrompt()`
 * (pi base + prior plugin modifications), separated by `\n\n---\n\n`.
 * When ctx.getSystemPrompt is unavailable, returns plugin prompt directly.
 *
 * Requirement document (D1/D2): Full-text injection removed. When in clarify stage
 * and meta.requirementDoc exists, the document path is included in context_reference
 * (REQUIRED CONTEXT FILES) for the agent to read via the read tool.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PipelineConfig, Hook, SessionMeta, StageConfig } from "../types";
import { PROTECTED_PATHS, ALLOWED_WRITE_ALL, DEFAULT_DECISION_SHORTCUT } from "../constants";
import { loadGitignoreInfo } from "../utils/gitignore";
import { safeWriteAuditLog, safeWritePromptSnapshot } from "../utils/auditLog";
import { isFrozen } from "./flow-state";
import { getStagePrompt, renderStageTemplate } from "./prompt-config";

/**
 * Builds Part 1: Context Reference.
 * Includes the previous stage's validated summary, any context files
 * associated with the current stage, and (for clarify stage) the requirement
 * document path for the agent to read via the read tool (D2).
 *
 * @param config - Pipeline configuration (for projectRoot)
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if no context files to reference
 */
function buildContextReference(
  config: PipelineConfig,
  meta: SessionMeta,
): string | null {
  const prevStage = meta.previousStage;
  const prevSummary = prevStage ? meta.summaries[prevStage] : undefined;
  const filesToRead: string[] = [];

  // Clarify stage: include requirement document path at the top (D2)
  if (meta.currentStage === "clarify" && meta.requirementDoc) {
    const reqDocPath = path.join(config.projectRoot, meta.requirementDoc);
    filesToRead.push(reqDocPath);
  }

  // Include previous stage's validated summary
  if (prevSummary && prevSummary.status === "valid") {
    filesToRead.push(prevSummary.path);
  }

  // Include any context files for the current stage (set during handoff)
  const contextFiles = meta.contextFiles;
  if (contextFiles && contextFiles[meta.currentStage]) {
    const stageContextFiles = contextFiles[meta.currentStage];
    if (Array.isArray(stageContextFiles)) {
      for (const f of stageContextFiles) {
        if (typeof f === "string") {
          filesToRead.push(f);
        }
      }
    }
  }

  if (filesToRead.length === 0) {
    return null;
  }

  return `# REQUIRED CONTEXT FILES (MUST READ FIRST)\n${filesToRead.map((f) => `- ${f}`).join("\n")}`;
}

/**
 * Builds Part 2: Domain Skill.
 * Reads the domain skill file from `~/.pi/domains/{domain.id}.md`.
 * Only included when the stage has `requireDomain: true`.
 *
 * @param stageConfig - Current stage configuration
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if domain not required or file missing
 */
async function buildDomainSkill(
  stageConfig: StageConfig,
  meta: SessionMeta,
): Promise<string | null> {
  if (!stageConfig.requireDomain) {
    return null;
  }

  const domainSkillPath = path.join(
    os.homedir(),
    ".pi",
    "domains",
    `${meta.domain.id}.md`,
  );

  try {
    const domainContent = await fs.readFile(domainSkillPath, "utf-8");
    return `# BUSINESS DOMAIN RULES (${meta.domain.id}@${meta.domain.version})\n${domainContent}`;
  } catch {
    // Domain skill file doesn't exist — skip this part
    return null;
  }
}

/**
 * Builds Part 3: Stage Skill.
 * Reads the stage-specific skill file from `{projectRoot}/.pi/skills/{skillPath}`.
 *
 * @param config - Pipeline configuration
 * @param stageConfig - Current stage configuration
 * @param meta - Current session metadata
 * @returns Prompt section string
 */
async function buildStageSkill(
  config: PipelineConfig,
  stageConfig: StageConfig,
  meta: SessionMeta,
): Promise<string | null> {
  const stageSkillPath = path.join(
    config.projectRoot,
    ".pi",
    "skills",
    stageConfig.skillPath,
  );

  try {
    const skillContent = await fs.readFile(stageSkillPath, "utf-8");
    return `# STAGE-SPECIFIC RULES (${meta.currentStage.toUpperCase()})\n${skillContent}`;
  } catch {
    return null;
  }
}

/**
 * Builds Part 4: Loop Status.
 * Only included for "develop" and "fix" stages.
 * Shows current step, loop attempts, constraints, and protected paths.
 * Dynamically includes allow list and gitignore patterns.
 *
 * @param config - Pipeline configuration
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if not a loop stage
 */
async function buildLoopStatus(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<string | null> {
  if (meta.currentStage !== "develop" && meta.currentStage !== "fix") {
    return null;
  }

  // Build protection information
  const allowList = config.protect?.allow ?? [];
  const userPaths = config.protect?.paths ?? [];
  const allHardcoded = [...PROTECTED_PATHS, ...userPaths];

  // Load gitignore patterns if enabled
  let gitignorePatterns: string[] = [];
  if (config.protect?.gitignore !== false) {
    const gitignoreInfo = await loadGitignoreInfo(config.projectRoot);
    if (gitignoreInfo) {
      gitignorePatterns = gitignoreInfo.patterns;
    }
  }

  // Build the scope line with dynamic protection info
  const scopeParts: string[] = [];

  // List allow exceptions first (if any)
  if (allowList.length > 0) {
    scopeParts.push(`Allowed (editable): ${allowList.join(", ")}`);
  }

  // List protected paths
  const protectedItems: string[] = [...allHardcoded];
  // Limit gitignore patterns to first 20 to avoid prompt bloat
  const maxPatterns = 20;
  if (gitignorePatterns.length > 0) {
    const displayPatterns = gitignorePatterns.slice(0, maxPatterns);
    protectedItems.push(...displayPatterns);
    if (gitignorePatterns.length > maxPatterns) {
      scopeParts.push(`Protected: ${protectedItems.join(", ")} (+${gitignorePatterns.length - maxPatterns} more gitignore patterns)`);
    } else {
      scopeParts.push(`Protected: ${protectedItems.join(", ")}`);
    }
  } else {
    scopeParts.push(`Protected: ${protectedItems.join(", ")}`);
  }

  return (
    `# LOOP ENGINEERING STATUS\n` +
    `- Current Step: #${meta.currentStepIndex}\n` +
    `- Loop Attempts: ${meta.loopCount + 1} / ${meta.maxLoops}\n` +
    `- Constraint: You MUST run tests after changes. If tests fail, this counts as an attempt.\n` +
    `- Limit: After ${meta.maxLoops} failed attempts, the pipeline will freeze.\n` +
    `- ${scopeParts.join("\n- ")}\n` +
    `- Write Scope: ${buildWriteScopeLine(config.stages[meta.currentStage])}`
  );
}

/**
 * Builds Part 5: Pipeline Status.
 * Shows pipeline ID, current stage, domain info, and summary validation status.
 * When pipeline is frozen, includes freeze reason and shortcut key hint.
 *
 * @param config - Pipeline configuration (for shortcut key)
 * @param meta - Current session metadata
 * @returns Prompt section string
 */
function buildPipelineStatus(config: PipelineConfig, meta: SessionMeta): string {
  const prevStage = meta.previousStage;
  const prevSummary = prevStage ? meta.summaries[prevStage] : undefined;
  const pendingValidation =
    prevSummary && prevSummary.status === "pending"
      ? "YES (Validate before proceed)"
      : "NO";

  const parts = [
    `# Pipeline Status`,
    `- Pipeline ID: ${meta.pipelineId}`,
    `- Current Stage: ${meta.currentStage}`,
    `- Domain: ${meta.domain.id}@${meta.domain.version}`,
    `- Pending Summary Validation: ${pendingValidation}`,
  ];

  // Inject frozen state hint to prevent agent from spinning on blocked tools
  if (isFrozen(meta)) {
    const shortcutKey = config.decisionShortcutKey ?? DEFAULT_DECISION_SHORTCUT;
    const reason = meta.blockedReason ?? meta.terminateReason ?? "unknown";
    parts.push(
      `- Pipeline Status: FROZEN (blocked: ${reason}) — 等待用户通过 TUI 决策菜单处理（快捷键 ${shortcutKey}）`,
    );
  }

  return parts.join("\n");
}

/**
 * Builds Part 6: Verification Failures.
 * Lists previous verification failures that must be fixed before advancing.
 * Only included when verifyFailures are present in SessionMeta.
 *
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if no failures
 */
function buildVerifyFailurePrompt(meta: SessionMeta): string | null {
  const failures = meta.verifyFailures;
  if (!failures || failures.length === 0) {
    return null;
  }

  const lines = failures.map(f => `- [${f.ruleType}] ${f.detail}`);
  return (
    `# PREVIOUS VERIFICATION FAILURES (MUST FIX)\n` +
    `The following verification checks failed. You MUST fix ALL of them before the stage can advance.\n\n` +
    lines.join("\n")
  );
}

/**
 * Builds Part 7: Verify Tool Guidance.
 * When verify.mode is "tool", injects guidance for the agent to call stage_advance
 * (primary) or pipeline_verify (fallback for re-verification).
 *
 * @param stageConfig - Current stage configuration
 * @returns Prompt section string, or null if not in tool mode
 */
function buildVerifyToolGuidance(stageConfig: StageConfig): string | null {
  if (stageConfig.verify?.mode !== "tool") {
    return null;
  }

  return (
    `# VERIFICATION MODE: TOOL\n` +
    `本阶段验证模式为 TOOL：完成本阶段工作后调用 \`stage_advance\` 宣告完成` +
    `（其内部执行验证门，通过后自动进入下一阶段）；` +
    `验证失败可调用 \`pipeline_verify\` 重新验证。`
  );
}

/**
 * Checks if a stage's bash prefix config implies git read-only mode.
 * Returns true when none of the git write sub-commands (add/commit/push)
 * appear as allowed bash prefixes.
 *
 * Read-only git commands (log, status, diff, show) are safe — they don't
 * mutate git state. Only add/commit/push are considered write operations.
 */
function isGitReadOnly(allowedBashPrefixes: string[] | undefined): boolean {
  if (!allowedBashPrefixes) return true;
  const gitWriteSubcommands = ["git add", "git commit", "git push"];
  return !allowedBashPrefixes.some(
    (p) => p === "git" || gitWriteSubcommands.some((gw) => p === gw || p.startsWith(gw + " ")),
  );
}

/**
 * Builds the write scope line for a stage.
 * - Whitelist mode: "docs/, doc/, documentation/"
 * - Full mode: "all (global protect applies)"
 */
function buildWriteScopeLine(stageConfig: StageConfig): string {
  const awp = stageConfig.allowedWritePaths;
  if (awp === undefined || awp.includes(ALLOWED_WRITE_ALL)) {
    return "all (global protect applies)";
  }
  if (awp.length === 0) {
    return "none (write forbidden)";
  }
  return awp.join(", ");
}

/**
 * Builds the Stage Write Scope section for all stages.
 * Injected as a lightweight standalone section for non-loop stages,
 * and appended to Loop Status for develop/fix.
 *
 * @param stageConfig - Current stage configuration
 * @param includeGitHint - Whether to append git read-only hint
 * @returns Prompt section string
 */
function buildStageWriteScope(
  stageConfig: StageConfig,
  includeGitHint: boolean
): string {
  const lines = [
    `# STAGE WRITE SCOPE`,
    `- Write Scope: ${buildWriteScopeLine(stageConfig)}`,
  ];
  if (includeGitHint && isGitReadOnly(stageConfig.allowedBashPrefixes)) {
    lines.push(`- Git: read-only (add/commit/push forbidden)`);
  }
  return lines.join("\n");
}

/**
 * Creates the `before_agent_start` hook that injects a composed system prompt.
 *
 * Injection method (D3): Appends plugin prompt after pi base system prompt.
 * Uses ctx.getSystemPrompt() to get the current system prompt (pi base + prior
 * plugin modifications), then appends the plugin prompt separated by `\n\n---\n\n`.
 * When ctx.getSystemPrompt is unavailable, returns plugin prompt directly.
 *
 * Dual-path rendering:
 * 1. If a yml stage template exists and contains all critical placeholders →
 *    render placeholders with dynamic values (paragraph-level null removal).
 * 2. Otherwise → fall back to the default 8-part prompt assembly.
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "before_agent_start" event
 */
export function createPromptInjector(config: PipelineConfig): Hook {
  return {
    event: "before_agent_start",
    handler: async (ctx: any): Promise<{ systemPrompt: string }> => {
      const meta = ctx.session.getMeta() as SessionMeta;
      const stageConfig = config.stages[meta.currentStage];

      // Build the plugin prompt (yml template or default 8-part)
      let pluginPrompt: string;

      // Try yml template path
      const template = await getStagePrompt(config.projectRoot, meta.currentStage);
      if (template !== null) {
        const values = await buildDynamicValues(config, meta, stageConfig);
        const rendered = renderStageTemplate(template, meta.currentStage, values);
        if (rendered.status === "missing_critical") {
          await safeWriteAuditLog("prompt_injector_missing_placeholder", {
            stage: meta.currentStage,
            missing: rendered.missing.join(","),
          }, "warn");
          pluginPrompt = await buildDefaultPrompt(config, meta, stageConfig);
          // E4: write prompt snapshot for fallback path (source=fallback)
          await safeWritePromptSnapshot("prompt_snapshot", {
            stage: meta.currentStage,
            pipelineId: meta.pipelineId,
            source: "fallback",
          }, pluginPrompt);
        } else {
          pluginPrompt = rendered.prompt;
          // E4: write prompt snapshot for successful yml rendering (source=yml)
          await safeWritePromptSnapshot("prompt_snapshot", {
            stage: meta.currentStage,
            pipelineId: meta.pipelineId,
            source: "yml",
          }, pluginPrompt);
        }
      } else {
        // Default path: no yml template → use 8-part assembly (no snapshot, E4 ❌)
        pluginPrompt = await buildDefaultPrompt(config, meta, stageConfig);
      }

      // Append plugin prompt after pi base system prompt (D3)
      const base = ctx.getSystemPrompt?.() ?? "";
      if (base) {
        return { systemPrompt: base + "\n\n---\n\n" + pluginPrompt };
      }
      return { systemPrompt: pluginPrompt };
    },
  };
}

/**
 * Builds the default 8-part prompt by calling each part builder and joining
 * non-null results with `\n\n---\n\n`. Used as the fallback when no yml
 * template is available or when critical placeholders are missing.
 *
 * @param config - Pipeline configuration
 * @param meta - Current session metadata
 * @param stageConfig - Current stage configuration
 * @returns Assembled prompt string
 */
async function buildDefaultPrompt(
  config: PipelineConfig,
  meta: SessionMeta,
  stageConfig: StageConfig,
): Promise<string> {
  const part1 = buildContextReference(config, meta);
  const part2 = await buildDomainSkill(stageConfig, meta);
  const part3 = await buildStageSkill(config, stageConfig, meta);
  const part4 = await buildLoopStatus(config, meta);
  const part5 = buildPipelineStatus(config, meta);
  const part6 = buildVerifyFailurePrompt(meta);
  const part7 = buildVerifyToolGuidance(stageConfig);
  // Part 8: Stage Write Scope (standalone for non-loop stages; loop stages get it in Part 4)
  const part8 = (meta.currentStage !== "develop" && meta.currentStage !== "fix")
    ? buildStageWriteScope(stageConfig, true)
    : null;

  const promptParts = [part1, part2, part3, part4, part5, part6, part7, part8].filter(
    (p): p is string => p !== null,
  );

  return promptParts.join("\n\n---\n\n");
}

/**
 * Builds the dynamic placeholder values map for template rendering.
 * Maps each of the 8 known placeholder keys to its computed value.
 * Null values trigger paragraph-level removal in renderStageTemplate.
 *
 * @param config - Pipeline configuration
 * @param meta - Current session metadata
 * @param stageConfig - Current stage configuration
 * @returns Record mapping placeholder keys (without {{}}) to their values
 */
async function buildDynamicValues(
  config: PipelineConfig,
  meta: SessionMeta,
  stageConfig: StageConfig,
): Promise<Record<string, string | null>> {
  const isLoopStage = meta.currentStage === "develop" || meta.currentStage === "fix";

  return {
    context_reference: buildContextReference(config, meta),
    domain_skill: await buildDomainSkill(stageConfig, meta),
    // Part 3: Stage Skill — now also available as {{stage_skill}} placeholder in yml templates
    stage_skill: await buildStageSkill(config, stageConfig, meta),
    loop_status: await buildLoopStatus(config, meta),
    pipeline_status: buildPipelineStatus(config, meta),
    verify_failures: buildVerifyFailurePrompt(meta),
    verify_tool_guidance: buildVerifyToolGuidance(stageConfig),
    // Write scope: null for loop stages (embedded in loop_status), built for non-loop
    stage_write_scope: isLoopStage ? null : buildStageWriteScope(stageConfig, true),
  };
}


