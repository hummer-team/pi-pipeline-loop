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
import type { PipelineConfig, Hook, SessionMeta, StageConfig } from "../types";
import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { ALLOWED_WRITE_ALL, AUDIT_THROTTLE_WINDOW_MS, COMMIT_DOC_NAMING_CONSTRAINT } from "../constants";
import { loadGitignoreInfo } from "../utils/gitignore";
import { safeWriteAuditLog, safeWritePromptSnapshot } from "../utils/auditLog";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { computeStringHash } from "../utils/hash";
import { isFrozen, getFlowState, formatFrozenReason, formatDecisionMenuHint } from "./flow-state";
import { isDormant } from "./dormancy";
import { probeAgentState } from "../utils/subagents-introspect";
import { detectLastRunHealth, extractLastUserMessageText } from "./session-state";
import { parseClarifyTurnArgs } from "../utils/clarify-args";
import { resolveAgentMention } from "../utils/subagent-rpc";
import { getStagePrompt, renderStageTemplate, loadPromptConfig } from "./prompt-config";
import { resolvePiWorkDir, resolveDomainSkillCandidates, resolveGitignoreSkipDirs } from "../utils/work-dir";
import { buildProtectedPaths } from "../utils/protect";
import type { RuntimeCtx } from "./runtime-ctx";

/**
 * Builds Part 1: Context Reference.
 * Includes the previous stage's summary (both "valid" and "pending" status),
 * any context files associated with the current stage, and (for clarify stage)
 * the requirement document path for the agent to read via the read tool (D2).
 *
 * Bug 3.1 fix: "pending" summaries are also included so the review stage
 * can access the develop deliverable even when the summary has not yet been
 * validated (e.g., during the first review cycle).
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

  // Clarify/plan stage: include requirement document path at the top (D2)
  // Phase 1 (169): plan new session also needs the requirement doc for context passing
  if ((meta.currentStage === "clarify" || meta.currentStage === "plan") && meta.requirementDoc) {
    const reqDocPath = path.join(config.projectRoot, meta.requirementDoc);
    filesToReadSet.add(reqDocPath);
  }

  // Include previous stage's summary (valid or pending — Bug 3.1 fix)
  if (prevSummary && (prevSummary.status === "pending" || prevSummary.status === "valid")) {
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
 * Implements the 3-state lookup chain (Phase 3 / 184_Bug D9):
 *   1. Project-level: `{projectRoot}/{expanded domainDir}/{domain.id}.md`
 *   2. Home-level: `~/.pi/domains/{domain.id}.md` (existing behaviour anchor)
 *   3. Neither found → return null (skip injection)
 *
 * Only included when the stage has `requireDomain: true`.
 *
 * Red line: when domainDir is at its default (`.pi/domains`) AND the project-level
 * directory does not exist, the resolution falls through to the home-level path —
 * byte-identical to the pre-Phase-3 behaviour. No existing test should regress.
 *
 * @param config - Pipeline configuration (for projectRoot + domainDir)
 * @param stageConfig - Current stage configuration
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if domain not required or file missing
 */
async function buildDomainSkill(
  config: PipelineConfig,
  stageConfig: StageConfig,
  meta: SessionMeta,
): Promise<string | null> {
  if (!stageConfig.requireDomain) {
    return null;
  }

  // Single source of truth for candidate resolution (Phase 3 / 184_Bug D9).
  // Returns absolute paths ready for direct fs.readFile calls.
  const candidates = resolveDomainSkillCandidates(config, meta.domain.id);
  let lastError: string | undefined;

  for (const candidatePath of candidates) {
    try {
      const content = await fs.readFile(candidatePath, "utf-8");
      if (content.trim()) {
        return `# BUSINESS DOMAIN RULES (${meta.domain.id}@${meta.domain.version})\n${content}`;
      }
    } catch {
      // Candidate file missing or unreadable — expected probe path (project→home
      // chain), not an error. Exempt from catch-error-log convention; exhaustion
      // is recorded below when the chain is fully depleted.
      lastError = `read failed: ${candidatePath}`;
    }
  }

  // All candidates exhausted (either missing or empty). Record error-level
  // audit with throttle to avoid per-turn log storms (one per domain per 60s).
  if (shouldEmitWithinWindow(`domain_skill_missing:${meta.domain.id}`, AUDIT_THROTTLE_WINDOW_MS)) {
    await safeWriteAuditLog(
      "domain_skill_candidates_exhausted",
      {
        domainId: meta.domain.id,
        candidates: candidates.join("; "),
        lastError: lastError ?? "all candidates empty",
      },
      "error",
    );
  }

  // Fail-open: skip injection when no candidate was usable
  return null;
}

/**
 * Strips YAML frontmatter from content using a lenient regex.
 * Used for fingerprint normalization in idempotent stage-skill detection.
 *
 * WARNING: The `m` flag + non-anchored closing `---` may match `---` dividers
 * in the body. Use `stripLeadingFrontmatter` for injection output where
 * correctness matters.
 *
 * @param content - Raw file content potentially containing YAML frontmatter
 * @returns Content with frontmatter removed
 */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\s*/m, "");
}

/**
 * Strictly strips leading YAML frontmatter from content for injection output.
 *
 * Unlike `stripFrontmatter` (lenient, for fingerprint normalization), this
 * function only strips when:
 * 1. Content starts with a `---` line (anchored at string start, no `m` flag).
 *    The opening `---` tolerates optional trailing whitespace (spaces/tabs)
 *    before the line break.
 * 2. A closing `---` exists on its own line (trailing whitespace allowed).
 *
 * Both LF (`\n`) and CRLF (`\r\n`) line endings are accepted at the opening
 * delimiter, the closing delimiter, and the line preceding the closing
 * delimiter. This ensures correct stripping when skill files are checked out
 * with `core.autocrlf=true` on Windows.
 *
 * If the content does NOT start with `---`, it is returned as-is — even if
 * `---` dividers appear later in the body. This eliminates the risk of
 * accidentally deleting body content separated by `---` markdown rules.
 *
 * @param content - Raw file content potentially containing YAML frontmatter
 * @returns Content with leading frontmatter block removed, or original content
 *          if no leading frontmatter is found
 */
export function stripLeadingFrontmatter(content: string): string {
  // Match only at string start: `---` line → body → closing `---` on its own line
  // No `m` flag ensures `^` anchors to string start, not line start.
  // Tolerates: optional trailing whitespace on opening `---`, CRLF (`\r\n`)
  // line endings at all line-break positions.
  const match = content.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (match) {
    return content.slice(match[0].length);
  }
  return content;
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
    resolvePiWorkDir(config),
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
    // NOTE: pass raw skillContent (with frontmatter) for fingerprint consistency
    const skillName = stageConfig.skillPath.split("/")[0];
    if (isStageSkillInBase(base, skillContent, skillName)) {
      return null;
    }

    // D6: Strip leading frontmatter before injection to avoid YAML noise in system prompt
    const strippedContent = stripLeadingFrontmatter(skillContent);

    // Guard: pure frontmatter file → nothing meaningful to inject
    if (!strippedContent.trim()) {
      return null;
    }

    return `# STAGE-SPECIFIC RULES (${meta.currentStage.toUpperCase()})\n${strippedContent}`;
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
  // Dynamic hardcoded set: anchor .pi/ + piWorkDir/ + .git/ + user paths (deduped)
  const allHardcoded = buildProtectedPaths(config);

  // Load gitignore patterns if enabled
  let gitignorePatterns: string[] = [];
  if (config.protect?.gitignore !== false) {
    // When piWorkDir differs from default, also skip traversing into it
    const extraSkip = resolveGitignoreSkipDirs(config);
    const gitignoreInfo = await loadGitignoreInfo(config.projectRoot, extraSkip);
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
 * When pipeline is frozen, includes freeze reason and decision menu prompt.
 *
 * @param config - Pipeline configuration
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
    const reason = formatFrozenReason(meta);
    parts.push(
      `- Pipeline Status: FROZEN (blocked: ${reason}) — ${formatDecisionMenuHint(config)}`,
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

  const lines = failures.map(f => (
    f.group
      ? `- [${f.group}][${f.ruleType}] ${f.detail}`
      : `- [${f.ruleType}] ${f.detail}`
  ));
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
 * Phase 5 (170): Builds the RUN TRUNCATION WARNING section.
 *
 * Injected when the last assistant run was truncated (stopReason === "length").
 * Warns the agent to check document integrity and retry with smaller chunks.
 *
 * @param ctx - Runtime context for session branch access
 * @returns Prompt section string, or null if no truncation detected
 */
function buildTruncationWarning(ctx: RuntimeCtx): string | null {
  try {
    const health = detectLastRunHealth(ctx._ctx as Parameters<typeof detectLastRunHealth>[0]);
    if (health.kind !== "truncated") return null;

    return [
      `# RUN TRUNCATION WARNING`,
      `Your previous response was truncated by the model output limit.`,
      `Before continuing:`,
      `1. Check the requirement document for incomplete sections at the tail.`,
      `2. Break remaining content into smaller chunks (≤2KB each) and write incrementally.`,
      `3. Do NOT retry the same large payload — it will be truncated again.`,
      `4. If tool call parameters were cut mid-argument, reconstruct them from scratch.`,
    ].join("\n");
  } catch {
    return null; // Fail-open
  }
}

/**
 * Phase 3 (170) ⑤: Builds the PIPELINE STATE section for frozen pipelines.
 *
 * Injected into the prompt when `isFrozen(meta)` is true. Provides:
 * - One-line state summary (flowState + frozenReason)
 * - Exit guidance: blocked → decision menu; aborted → /pipeline-start
 *
 * @param config - Pipeline configuration (for projectRoot / requirementDoc)
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if pipeline is not frozen
 */
function buildPipelineStateSection(
  config: PipelineConfig,
  meta: SessionMeta,
): string | null {
  if (!isFrozen(meta)) return null;

  const flowState = getFlowState(meta);
  const frozenReason = formatFrozenReason(meta);
  const lines: string[] = [
    `# PIPELINE STATE`,
    `- State: ${flowState}`,
    `- Reason: ${frozenReason}`,
  ];

  if (flowState === "aborted") {
    const docHint = meta.requirementDoc ?? "<requirement-doc>";
    lines.push(`- Action: Run \`/pipeline-start ${docHint}\` to resume or restart.`);
  } else {
    lines.push(`- Action: ${formatDecisionMenuHint(config)} Alternatively, run /pipeline-quit to abort.`);
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
export function createPromptInjector(config: PipelineConfig): Hook<"before_agent_start"> {
  return {
    event: "before_agent_start",
    handler: async (ctx: RuntimeCtx): Promise<BeforeAgentStartEventResult | void> => {
      const rawMeta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 2b (173) C3: dormant guard — zero injection, zero snapshot
      // Covers: no meta, aborted, completed (terminal=silent equivalent)
      if (!rawMeta || isDormant(rawMeta)) return undefined;
      const meta: SessionMeta = rawMeta;
      const stageConfig = config.stages[meta.currentStage];

      // Phase 4 / 177 (D7③): persist the user's current-round clarify args so the
      // plugin-owned takeover spawn can use them verbatim in the subagent title.
      // Best-effort; never blocks injection.
      if (meta.currentStage === "clarify") {
        try {
          const lastUserMsg = extractLastUserMessageText(ctx._ctx as Parameters<typeof extractLastUserMessageText>[0]);
          const args = parseClarifyTurnArgs(lastUserMsg, resolveAgentMention(config, "clarify"));
          if (args && args !== meta.lastClarifyTurnArgs) {
            ctx.session.updateMeta({ lastClarifyTurnArgs: args });
          }
        } catch {
          // Fail-open: arg persistence must never block prompt injection
        }
      }

      // Extract base system prompt EARLY (before buildDynamicValues)
      // Needed for idempotent stage-skill injection detection
      // Phase 0 (183): apply gated skills dedup before downstream consumption
      const baseRaw = ctx.getSystemPrompt?.() ?? "";
      const dedup = skillsDedup(baseRaw);
      const base = dedup.prompt;

      // Phase 1 (183): emit audit events for skills dedup outcome (fail-open)
      try {
        if (dedup.removedPairs > 0) {
          await safeWriteAuditLog("prompt_skills_dedup", {
            stage: meta.currentStage,
            pipelineId: meta.pipelineId,
            removed_pairs: String(dedup.removedPairs),
            removed_bytes: String(dedup.removedBytes),
            hash_before: computeStringHash(baseRaw),
            hash_after: computeStringHash(base),
          }, "info");
        } else if (dedup.skippedReason) {
          await safeWriteAuditLog("prompt_skills_dedup_skipped", {
            stage: meta.currentStage,
            pipelineId: meta.pipelineId,
            reason: dedup.skippedReason,
            ...(dedup.error ? { error: dedup.error } : {}),
          }, dedup.error ? "error" : "warn");
        }
      } catch {
        // Fail-open: audit must never block prompt injection
      }

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

      // Phase 3 (170) ⑤: inject PIPELINE STATE section for frozen pipelines
      const pipelineStateSection = buildPipelineStateSection(config, meta);
      const pipelineStateSuffix = pipelineStateSection
        ? "\n\n---\n\n" + pipelineStateSection
        : "";

      // Phase 5 (170): inject RUN TRUNCATION WARNING for truncated runs
      const truncationWarning = buildTruncationWarning(ctx);
      const truncationSuffix = truncationWarning
        ? "\n\n---\n\n" + truncationWarning
        : "";

      const pluginPromptFull = pluginPrompt + pipelineStateSuffix + truncationSuffix;

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
  const part2 = await buildDomainSkill(config, stageConfig, meta);
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
    domain_skill: await buildDomainSkill(config, stageConfig, meta),
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

  // Phase 4 (171) High A: compute active-spawn note (shared by yml and fallback paths).
  // Gated by probe=live to avoid "zombie clause" when the spawn has already settled.
  // review#2 Low: on probe=unknown (manager singleton absent), fall back to the
  // 30-min time-window check for visibility hint purposes (non-blocking).
  // Note: tool-guard's checkLiveSpawn was removed in Phase 2 / 175 (dead code after
  // evidence-based refactor); this prompt-injector visibility logic is independent.
  const activeSpawn = meta.activeSpawns?.[meta.currentStage];
  let activeSpawnNote = "";
  if (activeSpawn) {
    let isLive = false;
    if (activeSpawn.agentId) {
      // Primary: probe manager singleton
      const probe = probeAgentState(activeSpawn.agentId);
      if (probe === "live") {
        isLive = true;
      } else if (probe === "unknown") {
        // Manager singleton absent → degrade to time-based check (aligned with tool-guard)
        const age = Date.now() - activeSpawn.startedAt;
        isLive = age < 30 * 60 * 1000;
      }
      // probe === "settled" → isLive stays false
    } else {
      // Fallback: time-based check (no agentId recorded, e.g. fallback spawn)
      const age = Date.now() - activeSpawn.startedAt;
      isLive = age < 30 * 60 * 1000; // 30min staleness threshold
    }
    if (isLive) {
      activeSpawnNote = `\n**⚠ Active spawn**: An auto-spawned \`${executor.subagent_type}\` is already executing this stage. Await its completion notification; do NOT spawn a duplicate, and do NOT self-execute its deliverable in the main thread.`;
    }
  }

  // Try to load per-stage executor text from yml `stage_executor_{stage}` key
  const ymlKey = `stage_executor_${meta.currentStage}`;
  const promptConfig = await loadPromptConfig(config.projectRoot);
  const ymlTemplate = promptConfig[ymlKey];

  if (ymlTemplate && ymlTemplate.trim()) {
    // Fill placeholders from yml template
    return ymlTemplate
      .replaceAll("{subagent_type}", executor.subagent_type)
      .replaceAll("{context_arg}", `<document path filled by main thread, e.g. _plan.md>`)
      .replaceAll("{active_spawn_note}", activeSpawnNote);
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
    // Phase 2 (172) G2: triage guidance for owner session
    lines.push(`**Triage**: If the user asks an unrelated question (not @mention with doc path or round args), answer briefly and do NOT touch pipeline state. Only pipeline-turn messages (containing verification results, stage routing, or @agent doc args) trigger verification.`);
    // Phase 7 (172) G1 + Phase 1 (175 R2Q2) + Phase 4 / 177 (D7): plugin-owned re-launch.
    // The plugin spawns the new task; direct model invocation is intercepted/rewritten.
    lines.push(`**Re-launch**: When the user mentions \`@${executor.subagent_type} {file} {args}\` during clarify, the plugin spawns a **new task** with \`description = Clarify: {file} {args}\` — the previous task is never resumed. Each round gets its own plugin-owned task title reflecting the round number, carrying the user's current-round args verbatim (e.g. \`2 答\`).`);
  } else if (executor.mode === "task-invocation") {
    lines.push(`This stage is executed by sub-agent: \`${executor.subagent_type}\``);
    lines.push("");
    // Phase 2 / 175 (R2Q5A) + Phase 4 / 177 (D7④): the plugin owns spawning.
    lines.push(`**Scheduling**: The plugin owns spawning of \`${executor.subagent_type}\` on stage entry. If the main thread calls \`${executor.subagent_type}\` via the Agent/task tool, the call is intercepted and rewritten to the plugin spawn path — do NOT rely on self-invocation.`);
    lines.push(`**Return protocol**: Sub-agent returns \`nextStage: <stage>\` suggestion; main thread calls stage_advance.`);
    lines.push(`**Context**: context_arg filled by main thread from document artifacts (e.g. \`_plan.md\`, \`_commit.md\`)`);
  } else {
    // lightweight-advance: plan stage — receive @feat-design-plan-agent return then advance
    lines.push(`This stage uses \`${executor.subagent_type}\` (lightweight advance mode).`);
    lines.push("");
    lines.push(`**Scheduling**: User @\`${executor.subagent_type}\` in chat; main thread receives \`nextStage: develop\` and calls stage_advance.`);
    lines.push(`**Context**: context_arg filled by main thread from document artifacts`);
  }

  // Append active-spawn note (probe=live gated) to fallback path
  if (activeSpawnNote) {
    lines.push(activeSpawnNote);
  }

  return lines.join("\n");
}

/**
 * Builds the plugin default deliverables segment for {{stage_deliverables}} placeholder.
 * Reads from yml `stage_deliverable_{stage}` key and wraps with a header.
 * Returns null when the key is missing/empty (paragraph auto-removed by renderStageTemplate).
 *
 * 168 Phase 3: Replaces `{pipelineId}` placeholder in the rendered output with
 * the actual pipelineId from session metadata, so the model sees real values
 * rather than literal placeholder strings.
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

  // 168 Phase 3: substitute {pipelineId} so the model sees real pipelineId
  const pipelineId = meta.pipelineId ?? "";
  const rendered = value.trim().replaceAll("{pipelineId}", pipelineId);

  // Phase 3 (182) Task 3: append commit doc naming constraint for develop/fix
  // stages so the model sees the rule at the point of writing commit docs.
  const isLoopStage = meta.currentStage === "develop" || meta.currentStage === "fix";
  const namingSuffix = isLoopStage ? `\n\n**Naming**: ${COMMIT_DOC_NAMING_CONSTRAINT}` : "";

  return `# STAGE DELIVERABLES (PLUGIN)\n${rendered}${namingSuffix}`;
}

// ─── skillsDedup: gated deduplication of <available_skills> blocks ──────────

/** Contract header line from pi skills.js:281 */
const SKILLS_INTRO_LINE = "The following skills provide specialized instructions for specific tasks.";

/** Result of the skillsDedup pure function */
export interface SkillsDedupResult {
  /** Deduplicated prompt (byte-identical to input when no-op) */
  prompt: string;
  /** Number of duplicate pairs removed (0 = no-op) */
  removedPairs: number;
  /** Net bytes removed (UTF-8 byte length delta) */
  removedBytes: number;
  /** Set only on abnormal paths (fail-open) */
  skippedReason?: "mismatch" | "malformed";
  /** Error message when caught exception triggered fail-open (for caller audit) */
  error?: string;
}

/** Represents a matched pair: header line → closing tag line (inclusive) */
interface SkillPairRange {
  start: number;
  end: number;
}

/** Count non-overlapping occurrences of needle in haystack */
function countNeedle(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/** Result of extracting skill pairs from prompt lines */
interface ExtractResult {
  pairs: SkillPairRange[];
  /** True if any header→closing interval was missing the <available_skills> open tag */
  malformed: boolean;
}

/**
 * Extract skill pairs from prompt lines.
 * Each pair: header line (SKILLS_INTRO_LINE) → nearest </available_skills> line.
 * Between them, an <available_skills> open tag must exist.
 *
 * If a header→closing interval lacks the open tag, the pair is skipped and
 * `malformed` is set to true, but scanning continues so subsequent valid pairs
 * are still extracted. The caller decides how to handle the malformed flag.
 */
function extractSkillPairs(lines: string[]): ExtractResult {
  const pairs: SkillPairRange[] = [];
  let malformed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== SKILLS_INTRO_LINE) continue;
    // Find nearest </available_skills> after header
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== "</available_skills>") continue;
      // Verify <available_skills> open tag exists between header and closing
      let hasOpen = false;
      for (let k = i + 1; k < j; k++) {
        if (lines[k].includes("<available_skills>")) {
          hasOpen = true;
          break;
        }
      }
      if (!hasOpen) {
        // Structural anomaly: mark malformed but continue scanning
        // so subsequent valid pairs are still extracted
        malformed = true;
        i = j; // advance past this malformed pair
        break;
      }
      pairs.push({ start: i, end: j });
      i = j; // advance past this pair
      break;
    }
  }
  return { pairs, malformed };
}

/** Extract trimmed block text for a pair (start..end inclusive) */
function pairBlockText(lines: string[], pair: SkillPairRange): string {
  return lines.slice(pair.start, pair.end + 1).join("\n").trim();
}

/** Find index of last line matching "Current working directory:" prefix */
function findLastCwdLineIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimStart().startsWith("Current working directory:")) {
      return i;
    }
  }
  return -1;
}

/** Find index of first non-empty line starting from `from` */
function findNextNonEmpty(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() !== "") return i;
  }
  return -1;
}

/** Check if a line is a cwd line */
function isCwdLine(line: string): boolean {
  return line.trimStart().startsWith("Current working directory:");
}

/** Check if a line index falls within any removal range */
function isInAnyRemovalRange(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (idx >= lo && idx <= hi) return true;
  }
  return false;
}

/**
 * Gated deduplication of `<available_skills>` blocks in the system prompt.
 *
 * Removes duplicate blocks that arise when pi-subagents append-mode subagent
 * sessions receive the block both from the parent prompt and pi core
 * unconditional append. Only triggers when:
 * - At least 2 well-formed pairs exist (header + open tag + closing tag)
 * - All pairs are byte-identical (after trim)
 *
 * Strategy: keep the LAST pair, remove all preceding ones.
 * For each removed pair, also removes the immediately following non-empty
 * "Current working directory:" line if it matches the prompt's last such line.
 *
 * Fail-open: any structural anomaly returns the original prompt unchanged.
 *
 * @param prompt - The raw system prompt string
 * @returns Deduplication result with the processed prompt and metadata
 */
export function skillsDedup(prompt: string): SkillsDedupResult {
  const noop: SkillsDedupResult = { prompt, removedPairs: 0, removedBytes: 0 };

  try {
    // Short-circuit: fewer than 2 opening tags → no duplication possible
    if (countNeedle(prompt, "<available_skills>") < 2) return noop;

    const lines = prompt.split("\n");
    const { pairs, malformed } = extractSkillPairs(lines);

    // Structural anomaly detected (header→closing without open tag) → fail-open
    if (malformed) {
      return { ...noop, skippedReason: "malformed" };
    }

    // Fewer than 2 complete pairs → no-op
    if (pairs.length < 2) return noop;

    // Byte-identity check across all pairs (trimmed block comparison)
    const referenceText = pairBlockText(lines, pairs[0]);
    for (let i = 1; i < pairs.length; i++) {
      if (pairBlockText(lines, pairs[i]) !== referenceText) {
        return { ...noop, skippedReason: "mismatch" };
      }
    }

    // All pairs identical → keep last, remove all preceding
    const pairsToRemove = pairs.slice(0, -1);
    const lastCwdIdx = findLastCwdLineIndex(lines);
    const removeRanges: Array<[number, number]> = [];

    for (const pair of pairsToRemove) {
      let rangeEnd = pair.end;
      // Check if next non-empty line after closing tag is a cwd line matching the last
      const nextNonEmpty = findNextNonEmpty(lines, pair.end + 1);
      if (nextNonEmpty !== -1 && isCwdLine(lines[nextNonEmpty]) && lastCwdIdx !== -1) {
        if (lines[nextNonEmpty] === lines[lastCwdIdx]) {
          rangeEnd = nextNonEmpty; // include cwd line in removal
        }
      }
      removeRanges.push([pair.start, rangeEnd]);
    }

    // Build result by excluding removed line ranges
    const keptLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!isInAnyRemovalRange(i, removeRanges)) {
        keptLines.push(lines[i]);
      }
    }

    const result = keptLines.join("\n");
    return {
      prompt: result,
      removedPairs: pairsToRemove.length,
      // Use Buffer.byteLength for accurate UTF-8 byte count (not UTF-16 code units)
      removedBytes: Buffer.byteLength(prompt) - Buffer.byteLength(result),
    };
  } catch (err: unknown) {
    // Any internal error → fail-open with malformed; capture error for caller audit
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ...noop, skippedReason: "malformed", error: errMsg };
  }
}
