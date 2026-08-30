/**
 * @module prompt-injector
 * Factory for the `before_agent_start` hook.
 * Composes an 11-part system prompt appended after the pi base system prompt,
 * providing context references, domain skills, stage skills, loop status,
 * pipeline status, verification failures, verify tool guidance, write scope,
 * stage executor scheduling, plugin default deliverables, and smart confirm
 * guidance (Phase 5: 162, plan/review smart mode only).
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
import { computeStringHash } from "../utils/hash";
import { isFrozen } from "./flow-state";
import { getStagePrompt, renderStageTemplate, loadPromptConfig } from "./prompt-config";

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
  // Use Set for deduplication: prevSummary.path and contextFiles may reference
  // the same file (e.g. when the summary is also listed as a context file).
  // Dedup prevents the agent from being asked to read the same file twice.
  const filesToReadSet = new Set<string>();

  // Clarify stage: include requirement document path at the top (D2)
  if (meta.currentStage === "clarify" && meta.requirementDoc) {
    const reqDocPath = path.join(config.projectRoot, meta.requirementDoc);
    filesToReadSet.add(reqDocPath);
  }

  // Include previous stage's validated summary
  if (prevSummary && prevSummary.status === "valid") {
    filesToReadSet.add(prevSummary.path);
  }

  // Include any context files for the current stage (set during handoff)
  const contextFiles = meta.contextFiles;
  if (contextFiles && contextFiles[meta.currentStage]) {
    const stageContextFiles = contextFiles[meta.currentStage];
    if (Array.isArray(stageContextFiles)) {
      for (const f of stageContextFiles) {
        if (typeof f === "string") {
          filesToReadSet.add(f);
        }
      }
    }
  }

  if (filesToReadSet.size === 0) {
    return null;
  }

  return `# REQUIRED CONTEXT FILES (MUST READ FIRST)\n${[...filesToReadSet].map((f) => `- ${f}`).join("\n")}`;
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
    // Guard: skip injection when file exists but content is empty/whitespace-only
    if (!domainContent.trim()) {
      return null;
    }
    return `# BUSINESS DOMAIN RULES (${meta.domain.id}@${meta.domain.version})\n${domainContent}`;
  } catch {
    // Domain skill file doesn't exist — skip this part
    return null;
  }
}

/**
 * Strips YAML frontmatter from content.
 * Used for fingerprint normalization in idempotent stage-skill detection.
 *
 * @param content - Raw file content potentially containing YAML frontmatter
 * @returns Content with frontmatter removed
 */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\s*/m, "");
}

/**
 * Checks if a stage skill is already present in the base system prompt.
 * Used for idempotent injection to avoid duplicate skill content when
 * pi-subagents preload (channel B) and plugin {{stage_skill}} (channel A)
 * both inject the same skill into the same context.
 *
 * Detection strategy (priority order):
 * 1. Marker check: base contains "# Preloaded Skill: {skillName}"
 * 2. Fingerprint fallback: normalized skill content (trim + strip frontmatter,
 *    take >=200 char substring) found in base
 *
 * @param base - The base system prompt from ctx.getSystemPrompt()
 * @param skillContent - The raw skill file content
 * @param skillName - The skill name (first segment of skillPath, e.g. "design")
 * @returns true if skill is already in base, false otherwise
 */
export function isStageSkillInBase(
  base: string,
  skillContent: string,
  skillName: string,
): boolean {
  // Strategy 1: marker check (highest priority)
  if (base.includes(`# Preloaded Skill: ${skillName}`)) {
    return true;
  }

  // Strategy 2: fingerprint fallback
  // Normalize skill content: strip frontmatter, trim, take >=200 char substring
  const normalized = stripFrontmatter(skillContent).trim();
  if (normalized.length >= 200) {
    const fingerprint = normalized.substring(0, 200);
    if (base.includes(fingerprint)) {
      return true;
    }
  }

  return false;
}

/**
 * Builds Part 3: Stage Skill.
 * Reads the stage-specific skill file from `{projectRoot}/.pi/skills/{skillPath}`.
 * Implements idempotent injection: if the skill is already present in the base
 * system prompt (from pi-subagents preload), returns null to avoid duplication.
 *
 * @param config - Pipeline configuration
 * @param stageConfig - Current stage configuration
 * @param meta - Current session metadata
 * @param base - The base system prompt from ctx.getSystemPrompt()
 * @returns Prompt section string, or null if skill already in base, empty, or file missing
 */
async function buildStageSkill(
  config: PipelineConfig,
  stageConfig: StageConfig,
  meta: SessionMeta,
  base: string,
): Promise<string | null> {
  const stageSkillPath = path.join(
    config.projectRoot,
    ".pi",
    "skills",
    stageConfig.skillPath,
  );

  try {
    const skillContent = await fs.readFile(stageSkillPath, "utf-8");

    // Guard: skip injection when file exists but content is empty/whitespace-only
    if (!skillContent.trim()) {
      return null;
    }

    // Idempotent check: if skill already in base, return null to avoid duplication
    // skillName is the first segment of skillPath (e.g. "design/SKILL.md" → "design")
    const skillName = stageConfig.skillPath.split("/")[0];
    if (isStageSkillInBase(base, skillContent, skillName)) {
      return null;
    }

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
    `- Write Scope: ${buildWriteScopeLine(config.stages[meta.currentStage])}\n` +
    // Phase 3 (143): develop/fix stages must carry commitIds in stage summary
    `- Summary Requirement: Stage summary MUST call \`generate_stage_summary\` with \`commitIds\` parameter (all git commit ids produced in this stage)`
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
      `- Pipeline Status: FROZEN (blocked: ${reason}) — Use the TUI decision menu to proceed (shortcut: ${shortcutKey})`,
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
 * Builds violation history prompt section.
 * Lists blocked tool-call violations with correction detail.
 * Only included when violations are present in SessionMeta.
 *
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if no violations
 */
function buildViolationPrompt(meta: SessionMeta): string | null {
  const violations = meta.violations;
  if (!violations || violations.length === 0) {
    return null;
  }

  const lines = violations.map(v => {
    const tag = v.tool ? `[${v.type}] Tool "${v.tool}"` : `[${v.type}]`;
    const correction = v.suggestion ? `${v.detail} ${v.suggestion}` : v.detail;
    return `- ${tag}: ${correction}`;
  });
  return (
    `# PREVIOUS VIOLATIONS (MUST FIX)\n` +
    `The following tool usage violations were blocked. Correct your approach:\n\n` +
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
    `This stage uses TOOL verification mode: after completing your work, call \`stage_advance\` to declare done` +
    ` (it runs the verification gate internally and auto-advances on pass);` +
    ` on failure, call \`pipeline_verify\` to re-verify.`
  );
}

/**
 * Determines if git is read-only for a stage.
 * Develop and fix stages can perform git write operations (add/commit/push).
 * All other stages (clarify, plan, review, awaiting_human, completed) are git read-only.
 *
 * @param stageName - Current pipeline stage name
 * @returns true if git operations are read-only for this stage
 */
function isGitReadOnly(stageName: string): boolean {
  // develop and fix stages can write to git; all others are read-only
  return stageName !== "develop" && stageName !== "fix";
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
 * @param stageName - Current stage name for git read-only check
 * @returns Prompt section string
 */
function buildStageWriteScope(
  stageConfig: StageConfig,
  includeGitHint: boolean,
  stageName: string
): string {
  const lines = [
    `# STAGE WRITE SCOPE`,
    `- Write Scope: ${buildWriteScopeLine(stageConfig)}`,
  ];
  if (includeGitHint && isGitReadOnly(stageName)) {
    lines.push(`- Git: read-only (add/commit/push forbidden)`);
  }
  return lines.join("\n");
}

/**
 * Builds the completed stage summary prompt.
 * Phase 4 (139): Injected when the pipeline reaches completed stage,
 * summarizing pipelineId, final stage, artifact files, and loop cycles.
 *
 * @param _config - Pipeline configuration (for projectRoot)
 * @param meta - Current session metadata
 * @returns Summary text for the completed stage prompt
 */
function buildCompletedSummary(
  _config: PipelineConfig,
  meta: SessionMeta,
): string {
  const lines: string[] = [];
  lines.push("## Pipeline Completed Summary");
  lines.push("");
  lines.push(`- **pipelineId**: ${meta.pipelineId}`);
  lines.push(`- **endStage**: ${meta.previousStage ?? "completed"}`);
  lines.push(`- **loopCycle**: ${meta.loopCycleCount ?? 0}`);

  // List artifact files from summaries
  const artifactFiles = Object.entries(meta.summaries)
    .filter(([, s]) => s.status === "valid")
    .map(([stage, s]) => `- **${stage}**: ${s.path}`);
  if (artifactFiles.length > 0) {
    lines.push("- **Deliverable File**:");
    lines.push(...artifactFiles);
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

      // Extract base system prompt EARLY (before buildDynamicValues)
      // Needed for idempotent stage-skill injection detection
      const base = ctx.getSystemPrompt?.() ?? "";

      // Build the plugin prompt (yml template or default 10-part)
      let pluginPrompt: string;
      // Track rendering path for snapshot source label
      let snapshotSource: "yml" | "fallback" | "default" = "default";

      // Try yml template path
      const template = await getStagePrompt(config.projectRoot, meta.currentStage);
      if (template !== null) {
        const values = await buildDynamicValues(config, meta, stageConfig, base);
        const rendered = renderStageTemplate(template, meta.currentStage, values);
        if (rendered.status === "missing_critical") {
          await safeWriteAuditLog("prompt_injector_missing_placeholder", {
            stage: meta.currentStage,
            missing: rendered.missing.join(","),
          }, "warn");
          pluginPrompt = await buildDefaultPrompt(config, meta, stageConfig, base);
          snapshotSource = "fallback";
        } else {
          pluginPrompt = rendered.prompt;
          snapshotSource = "yml";
        }
      } else {
        // Default path: no yml template → use 10-part assembly
        pluginPrompt = await buildDefaultPrompt(config, meta, stageConfig, base);
        snapshotSource = "default";
      }

      // Phase 4 (139): completed stage summary injection
      let completedSummary = "";
      if (meta.currentStage === "completed") {
        completedSummary = buildCompletedSummary(config, meta);
      }

      const pluginPromptFull = completedSummary
        ? pluginPrompt + "\n\n---\n\n" + completedSummary
        : pluginPrompt;

      const systemPrompt = base
        ? base + "\n\n---\n\n" + pluginPromptFull
        : pluginPromptFull;

      // Phase 5 (146) + Phase 6 (161): unified prompt snapshot — record after full assembly
      // Snapshot level controlled by config.audit.promptSnapshot (default "full")
      // "full" mode writes 3 events: combined snapshot + separate base/plugin snapshots
      // "plugin" mode writes only pluginPromptFull (backward compatible)
      // "off" skips all snapshots
      const snapshotLevel = config.audit?.promptSnapshot ?? "full";
      if (snapshotLevel !== "off") {
        if (snapshotLevel === "full") {
          // Combined snapshot (preserves existing behavior)
          await safeWritePromptSnapshot("prompt_snapshot", {
            stage: meta.currentStage,
            pipelineId: meta.pipelineId,
            source: snapshotSource,
            prompt_hash: computeStringHash(systemPrompt),
          }, systemPrompt);
          // Base prompt snapshot (placeholder when no base exists)
          const baseContent = base || "(no base system prompt)";
          await safeWritePromptSnapshot("prompt_snapshot_base", {
            stage: meta.currentStage,
            pipelineId: meta.pipelineId,
            source: snapshotSource,
            prompt_hash: computeStringHash(baseContent),
          }, baseContent);
          // Plugin prompt snapshot
          await safeWritePromptSnapshot("prompt_snapshot_plugin", {
            stage: meta.currentStage,
            pipelineId: meta.pipelineId,
            source: snapshotSource,
            prompt_hash: computeStringHash(pluginPromptFull),
          }, pluginPromptFull);
        } else {
          // Non-full mode (e.g., "plugin"): write only plugin content
          await safeWritePromptSnapshot("prompt_snapshot", {
            stage: meta.currentStage,
            pipelineId: meta.pipelineId,
            source: snapshotSource,
          }, pluginPromptFull);
        }
      }

      return { systemPrompt };
    },
  };
}

/**
 * Phase 5 (162): Builds the smart confirm guidance section for stages with
 * confirm.mode === "smart". Returns null for non-smart stages or stages
 * that don't support the confirm gate (only plan/review).
 *
 * The guidance instructs the agent to self-assess complexity and explicitly
 * declare via stage_advance({ needConfirm: true }) when the work is complex,
 * or proceed automatically when not complex (recorded as confirm_smart_skip).
 *
 * @param stageConfig - Current stage configuration
 * @param meta - Current session metadata
 * @returns English protocol string, or null when not applicable
 */
function buildSmartConfirmGuidance(
  stageConfig: StageConfig,
  meta: SessionMeta,
): string | null {
  // Only plan and review stages support the confirm gate
  if (meta.currentStage !== "plan" && meta.currentStage !== "review") return null;
  // Only emit when confirm mode is "smart"
  if (stageConfig.confirm?.mode !== "smart") return null;

  const stage = meta.currentStage;
  const docRef = stage === "plan" ? "plan document" : "review report";

  return [
    `# SMART CONFIRM PROTOCOL (${stage.toUpperCase()})`,
    `Assess the complexity of your completed work.`,
    `- Complex: write "## 智能确认：复杂" to the ${docRef}, then call stage_advance({ needConfirm: true }).`,
    `- Not complex: call stage_advance() to proceed automatically (recorded in the audit log).`,
  ].join("\n");
}

/**
 * Builds the default 11-part prompt by calling each part builder and joining
 * non-null results with `\n\n---\n\n`. Used as the fallback when no yml
 * template is available or when critical placeholders are missing.
 *
 * Parts:
 * 1. Context Reference
 * 2. Domain Skill
 * 3. Stage Skill
 * 4. Loop Status (develop/fix only)
 * 5. Pipeline Status
 * 6. Verification Failures
 * 6b. Violations
 * 7. Verify Tool Guidance
 * 8. Stage Write Scope (non-loop stages)
 * 9. Stage Executor Scheduling (Phase 4: 139)
 * 10. Stage Deliverables (Phase 0: 146, plugin default deliverables)
 * 11. Smart Confirm Guidance (Phase 5: 162, plan/review smart mode only)
 *
 * @param config - Pipeline configuration
 * @param meta - Current session metadata
 * @param stageConfig - Current stage configuration
 * @param base - The base system prompt from ctx.getSystemPrompt()
 * @returns Assembled prompt string
 */
async function buildDefaultPrompt(
  config: PipelineConfig,
  meta: SessionMeta,
  stageConfig: StageConfig,
  base: string,
): Promise<string> {
  const part1 = buildContextReference(config, meta);
  const part2 = await buildDomainSkill(stageConfig, meta);
  const part3 = await buildStageSkill(config, stageConfig, meta, base);
  const part4 = await buildLoopStatus(config, meta);
  const part5 = buildPipelineStatus(config, meta);
  const part6 = buildVerifyFailurePrompt(meta);
  const part6b = buildViolationPrompt(meta);
  const part7 = buildVerifyToolGuidance(stageConfig);
  // Part 8: Stage Write Scope (standalone for non-loop stages; loop stages get it in Part 4)
  const part8 = (meta.currentStage !== "develop" && meta.currentStage !== "fix")
    ? buildStageWriteScope(stageConfig, true, meta.currentStage)
    : null;
  // Part 9: Stage Executor Scheduling (Phase 4: 139)
  const part9 = await buildStageExecutor(config, stageConfig, meta);
  // Part 10: Plugin Default Deliverables (Phase 0: 146)
  const part10 = await buildStageDeliverables(config, meta);
  // Part 11: Smart Confirm Guidance (Phase 5: 162)
  const part11 = buildSmartConfirmGuidance(stageConfig, meta);

  const promptParts = [part1, part2, part3, part4, part5, part6, part6b, part7, part8, part9, part10, part11].filter(
    (p): p is string => p !== null,
  );

  return promptParts.join("\n\n---\n\n");
}

/**
 * Builds the dynamic placeholder values map for template rendering.
 * Maps each of the 11 known placeholder keys to its computed value.
 * Null values trigger paragraph-level removal in renderStageTemplate.
 *
 * @param config - Pipeline configuration
 * @param meta - Current session metadata
 * @param stageConfig - Current stage configuration
 * @param base - The base system prompt from ctx.getSystemPrompt()
 * @returns Record mapping placeholder keys (without {{}}) to their values
 */
async function buildDynamicValues(
  config: PipelineConfig,
  meta: SessionMeta,
  stageConfig: StageConfig,
  base: string,
): Promise<Record<string, string | null>> {
  const isLoopStage = meta.currentStage === "develop" || meta.currentStage === "fix";

  return {
    context_reference: buildContextReference(config, meta),
    domain_skill: await buildDomainSkill(stageConfig, meta),
    // Part 3: Stage Skill — now also available as {{stage_skill}} placeholder in yml templates
    // Idempotent: returns null if skill already preloaded in base
    stage_skill: await buildStageSkill(config, stageConfig, meta, base),
    loop_status: await buildLoopStatus(config, meta),
    pipeline_status: buildPipelineStatus(config, meta),
    verify_failures: buildVerifyFailurePrompt(meta),
    violations: buildViolationPrompt(meta),
    verify_tool_guidance: buildVerifyToolGuidance(stageConfig),
    // Write scope: null for loop stages (embedded in loop_status), built for non-loop
    stage_write_scope: isLoopStage ? null : buildStageWriteScope(stageConfig, true, meta.currentStage),
    // Phase 4 (139): Stage executor scheduling segment (reads from yml)
    stage_executor: await buildStageExecutor(config, stageConfig, meta),
    // Phase 0 (146): Plugin default deliverables (reads from yml stage_deliverable_{stage})
    stage_deliverables: await buildStageDeliverables(config, meta),
    // Phase 5 (162): Smart confirm guidance (plan/review smart mode only; null → paragraph removed)
    smart_confirm_guidance: buildSmartConfirmGuidance(stageConfig, meta),
  };
}

// ─── Stage executor mapping (Phase 4 / 139 + Phase 0 / 146) ─────────────────

/** Stage → subagent_type mapping for {{stage_executor}} injection */
const STAGE_EXECUTOR_MAP: Record<string, { subagent_type: string; mode: string }> = {
  clarify: { subagent_type: "feat-design-plan-agent", mode: "lightweight-advance" },
  plan: { subagent_type: "feat-design-plan-agent", mode: "lightweight-advance" },
  develop: { subagent_type: "develop-agent", mode: "task-invocation" },
  review: { subagent_type: "code-review-agent", mode: "task-invocation" },
  fix: { subagent_type: "code-review-withfix-agent", mode: "task-invocation" },
};

/**
 * Builds the stage executor scheduling segment for {{stage_executor}} placeholder.
 * Returns the per-stage executor configuration text, or null for stages that
 * don't have executor injection (completed, awaiting_human).
 *
 * Reads from yml `stage_executor_{stage}` key first; fills {subagent_type} and
 * {context_arg} placeholders from the stage→agent mapping. Falls back to
 * hardcoded English default text when yml key is missing or empty.
 *
 * @param config - Pipeline configuration (for projectRoot to load yml)
 * @param _stageConfig - Current stage configuration
 * @param meta - Current session metadata
 * @returns Rendered executor segment string, or null if not applicable
 */
async function buildStageExecutor(
  config: PipelineConfig,
  _stageConfig: StageConfig,
  meta: SessionMeta,
): Promise<string | null> {
  const executor = STAGE_EXECUTOR_MAP[meta.currentStage];
  if (!executor) {
    return null;
  }

  // Try to load per-stage executor text from yml `stage_executor_{stage}` key
  const ymlKey = `stage_executor_${meta.currentStage}`;
  const promptConfig = await loadPromptConfig(config.projectRoot);
  const ymlTemplate = promptConfig[ymlKey];

  if (ymlTemplate && ymlTemplate.trim()) {
    // Fill placeholders from yml template
    return ymlTemplate
      .replaceAll("{subagent_type}", executor.subagent_type)
      .replaceAll("{context_arg}", `<document path filled by main thread, e.g. _plan.md>`);
  }

  // Fallback: hardcoded English default text (when yml key is missing/empty)
  const lines: string[] = [];
  lines.push("## Stage Executor Scheduling");
  lines.push("");

  if (meta.currentStage === "clarify") {
    // Clarify: user-invoked lightweight-advance mode
    lines.push(`This stage is executed by the user-invoked agent: \`${executor.subagent_type}\``);
    lines.push("");
    lines.push(`**Scheduling**: User @\`${executor.subagent_type}\` in chat with the requirement document path.`);
    lines.push(`**Return protocol**: On \`full-und?\` confirmation, write the \`## 模型确认\` marker to the requirement document and STOP. Do NOT call \`stage_advance\` — the \`agent_settled\` hook auto-verifies (completionMarker) and advances to \`plan\`.`);
  } else if (executor.mode === "task-invocation") {
    lines.push(`This stage is executed by sub-agent: \`${executor.subagent_type}\``);
    lines.push("");
    lines.push(`**Scheduling**: Main thread invokes \`${executor.subagent_type}\` via task tool.`);
    lines.push(`**Return protocol**: Sub-agent returns \`nextStage: <stage>\` suggestion; main thread calls stage_advance.`);
    lines.push(`**Context**: context_arg filled by main thread from document artifacts (e.g. \`_plan.md\`, \`_commit.md\`)`);
  } else {
    // lightweight-advance: plan stage — receive @feat-design-plan-agent return then advance
    lines.push(`This stage uses \`${executor.subagent_type}\` (lightweight advance mode).`);
    lines.push("");
    lines.push(`**Scheduling**: User @\`${executor.subagent_type}\` in chat; main thread receives \`nextStage: develop\` and calls stage_advance.`);
    lines.push(`**Context**: context_arg filled by main thread from document artifacts`);
  }

  return lines.join("\n");
}

/**
 * Builds the plugin default deliverables segment for {{stage_deliverables}} placeholder.
 * Reads from yml `stage_deliverable_{stage}` key and wraps with a header.
 * Returns null when the key is missing/empty (paragraph auto-removed by renderStageTemplate).
 *
 * @param config - Pipeline configuration (for projectRoot to load yml)
 * @param meta - Current session metadata
 * @returns Rendered deliverables segment string, or null if not applicable
 */
async function buildStageDeliverables(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<string | null> {
  const ymlKey = `stage_deliverable_${meta.currentStage}`;
  const promptConfig = await loadPromptConfig(config.projectRoot);
  const value = promptConfig[ymlKey];

  if (!value || !value.trim()) {
    return null;
  }

  return `# STAGE DELIVERABLES (PLUGIN)\n${value.trim()}`;
}
