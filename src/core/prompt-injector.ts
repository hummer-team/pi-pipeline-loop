/**
 * @module prompt-injector
 * Factory for the `before_agent_start` hook.
 * Composes a 5-part system prompt injected before each agent invocation,
 * providing context references, domain skills, stage skills, loop status,
 * and pipeline status.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PipelineConfig, Hook, SessionMeta, StageConfig } from "../types";
import { PROTECTED_PATHS } from "../constants";

/**
 * Builds Part 1: Context Reference.
 * Includes the previous stage's validated summary and any context files
 * associated with the current stage in session metadata.
 *
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if no context files to reference
 */
function buildContextReference(meta: SessionMeta): string | null {
  const prevStage = meta.previousStage;
  const prevSummary = prevStage ? meta.summaries[prevStage] : undefined;
  const filesToRead: string[] = [];

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
 *
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if not a loop stage
 */
function buildLoopStatus(meta: SessionMeta): string | null {
  if (meta.currentStage !== "develop" && meta.currentStage !== "fix") {
    return null;
  }

  return (
    `# LOOP ENGINEERING STATUS\n` +
    `- Current Step: #${meta.currentStepIndex}\n` +
    `- Loop Attempts: ${meta.loopCount + 1} / ${meta.maxLoops}\n` +
    `- Constraint: You MUST run tests after changes. If tests fail, this counts as an attempt.\n` +
    `- Limit: After ${meta.maxLoops} failed attempts, the pipeline will freeze.\n` +
    `- Scope: ONLY modify source code. DO NOT touch ${PROTECTED_PATHS.join(", ")}.`
  );
}

/**
 * Builds Part 5: Pipeline Status.
 * Shows pipeline ID, current stage, domain info, and summary validation status.
 *
 * @param meta - Current session metadata
 * @returns Prompt section string
 */
function buildPipelineStatus(meta: SessionMeta): string {
  const prevStage = meta.previousStage;
  const prevSummary = prevStage ? meta.summaries[prevStage] : undefined;
  const pendingValidation =
    prevSummary && prevSummary.status === "pending"
      ? "YES (Validate before proceed)"
      : "NO";

  return (
    `# Pipeline Status\n` +
    `- Pipeline ID: ${meta.pipelineId}\n` +
    `- Current Stage: ${meta.currentStage}\n` +
    `- Domain: ${meta.domain.id}@${meta.domain.version}\n` +
    `- Pending Summary Validation: ${pendingValidation}`
  );
}

/**
 * Creates the `before_agent_start` hook that injects a composed system prompt.
 *
 * The prompt is assembled from up to 6 parts joined by horizontal rule separators:
 * 0. Requirement Document — user's requirement doc (if loaded via /pipeline_start)
 * 1. Context Reference — previous stage summary + context files
 * 2. Domain Skill — domain rules from ~/.pi/domains/ (if required)
 * 3. Stage Skill — stage-specific rules from project .pi/skills/
 * 4. Loop Status — iteration count and constraints (develop/fix only)
 * 5. Pipeline Status — ID, stage, domain, validation status
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "before_agent_start" event
 */
export function createPromptInjector(config: PipelineConfig): Hook {
  return {
    event: "before_agent_start",
    handler: async (ctx: any): Promise<{ systemPrompt: string }> => {
      const meta = ctx.session.getMetadata() as SessionMeta;
      const stageConfig = config.stages[meta.currentStage];

      const part0 = await buildRequirementDoc(config, meta);
      const part1 = buildContextReference(meta);
      const part2 = await buildDomainSkill(stageConfig, meta);
      const part3 = await buildStageSkill(config, stageConfig, meta);
      const part4 = buildLoopStatus(meta);
      const part5 = buildPipelineStatus(meta);

      const promptParts = [part0, part1, part2, part3, part4, part5].filter(
        (p): p is string => p !== null,
      );

      return { systemPrompt: promptParts.join("\n\n---\n\n") };
    },
  };
}

/**
 * Builds Part 0: Requirement Document.
 * Loads the user's requirement document when running in clarify stage.
 *
 * @param config - Pipeline configuration
 * @param meta - Current session metadata
 * @returns Prompt section string, or null if no requirement doc
 */
async function buildRequirementDoc(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<string | null> {
  if (!meta.requirementDoc || meta.currentStage !== "clarify") {
    return null;
  }

  const docPath = path.join(config.projectRoot, meta.requirementDoc);
  try {
    const content = await fs.readFile(docPath, "utf-8");
    return `# USER REQUIREMENT DOCUMENT\n\n${content}`;
  } catch {
    return null;
  }
}
