/**
 * @module json-config-loader
 * Reads pipeline_loop.json and resolves it into a full PipelineConfig.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PipelineConfig,
  PipelineJsonConfig,
  PipelineStage,
  StageConfig,
  StageJsonConfig,
} from "../types";
import {
  DEFAULT_AGENT_FILE,
  DEFAULT_SKILL_PATH,
  DEFAULT_VERIFY_FILE,
  STAGE_TYPE_TOOL_DEFAULTS,
  resolveStagePath,
} from "../constants";

const VALID_STAGES = new Set<PipelineStage>([
  "clarify",
  "design",
  "plan",
  "develop",
  "review",
  "fix",
  "awaiting_human",
  "completed",
]);

export function loadJsonConfig(jsonPath: string): PipelineJsonConfig {
  const raw = fs.readFileSync(jsonPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in pipeline config file: ${jsonPath}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `Pipeline config must be a JSON object, got ${typeof parsed}`,
    );
  }

  const json = parsed as Record<string, unknown>;

  if (!json.stages || typeof json.stages !== "object") {
    throw new Error(`pipeline_loop.json must contain a "stages" object`);
  }

  const stages = json.stages as Record<string, unknown>;
  for (const [key, value] of Object.entries(stages)) {
    if (!VALID_STAGES.has(key as PipelineStage)) {
      console.warn(
        `[pi-pipeline] Unknown stage "${key}" in pipeline_loop.json — skipping`,
      );
      continue;
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(
        `Stage "${key}" in pipeline_loop.json must be an object`,
      );
    }
  }

  return {
    stages: (json.stages as Partial<
      Record<PipelineStage, StageJsonConfig>
    >) || {},
    projectRoot: typeof json.projectRoot === "string" ? json.projectRoot : undefined,
    auditDir: typeof json.auditDir === "string" ? json.auditDir : undefined,
    domainDir: typeof json.domainDir === "string" ? json.domainDir : undefined,
    maxLoops: typeof json.maxLoops === "number" ? json.maxLoops : undefined,
    maxLoopCycles:
      typeof json.maxLoopCycles === "number" ? json.maxLoopCycles : undefined,
  };
}

export function resolvePipelineConfig(json: PipelineJsonConfig): PipelineConfig {
  const projectRoot = json.projectRoot || process.cwd();
  const stages: Record<PipelineStage, StageConfig> = {} as Record<
    PipelineStage,
    StageConfig
  >;

  for (const stageName of VALID_STAGES) {
    const jsonStage = json.stages[stageName];
    if (!jsonStage || jsonStage.require === false) {
      stages[stageName] = {
        agentFile: resolveStagePath(DEFAULT_AGENT_FILE, stageName),
        skillPath: resolveStagePath(DEFAULT_SKILL_PATH, stageName),
        allowedTools: [],
        allowedBashPrefixes: [],
        nextStage: null,
        requireDomain: false,
      };
      continue;
    }

    const defaults =
      STAGE_TYPE_TOOL_DEFAULTS[stageName] ||
      STAGE_TYPE_TOOL_DEFAULTS.clarify;

    stages[stageName] = {
      agentFile:
        jsonStage.agentFile ||
        resolveStagePath(DEFAULT_AGENT_FILE, stageName),
      skillPath:
        jsonStage.skillPath ||
        resolveStagePath(DEFAULT_SKILL_PATH, stageName),
      model: jsonStage.model,
      allowedTools: jsonStage.allowedTools || defaults.tools,
      allowedBashPrefixes:
        jsonStage.allowedBashPrefixes || defaults.bash,
      nextStage:
        jsonStage.nextStage !== undefined ? jsonStage.nextStage : null,
      requireDomain: jsonStage.requireDomain ?? false,
      verify: jsonStage.verify
        ? {
            require: jsonStage.verify.require ?? true,
            verifyFile:
              jsonStage.verify.verifyFile ||
              resolveStagePath(DEFAULT_VERIFY_FILE, stageName),
          }
        : undefined,
    };
  }

  // Validate nextStage references
  for (const [stageName, sc] of Object.entries(stages)) {
    if (sc!.nextStage && !stages[sc!.nextStage]) {
      throw new Error(
        `Stage "${stageName}" references unknown nextStage "${sc!.nextStage}"`,
      );
    }
  }

  return {
    stages,
    projectRoot,
    auditDir: json.auditDir || ".pi/audit",
    domainDir: json.domainDir || ".pi/domains",
    maxLoops: json.maxLoops ?? 3,
    maxLoopCycles: json.maxLoopCycles ?? 3,
  };
}
