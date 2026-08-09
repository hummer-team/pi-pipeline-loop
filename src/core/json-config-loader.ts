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
    console.error("[pi-pipeline] Invalid JSON in pipeline config file: " + jsonPath);
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

/**
 * Parses a verify mode string from JSON config, validating and defaulting.
 * Returns "hook" for undefined/invalid values with a console warning.
 */
function parseVerifyMode(raw: unknown): "hook" | "tool" {
  if (raw === "hook" || raw === "tool") {
    return raw;
  }
  if (raw !== undefined) {
    console.warn(
      `[pi-pipeline] Invalid verify.mode "${String(raw)}" — falling back to "hook"`,
    );
  }
  return "hook";
}

export function resolvePipelineConfig(json: PipelineJsonConfig): PipelineConfig {
  const projectRoot = json.projectRoot || process.cwd();
  const stages: Record<PipelineStage, StageConfig> = {} as Record<
    PipelineStage,
    StageConfig
  >;
  const disabledStages = new Set<PipelineStage>();

  for (const stageName of VALID_STAGES) {
    const jsonStage = json.stages[stageName];
    if (!jsonStage || jsonStage.require === false) {
      disabledStages.add(stageName);
      const reason = !jsonStage ? "not in config" : "require: false";
      console.info(
        `[pi-pipeline] Skipping disabled stage: ${stageName} (${reason})`,
      );
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
            // Plan stage defaults to verify.require = false (plan has no deliverables to verify)
            require: jsonStage.verify.require ?? (stageName !== "plan"),
            verifyFile:
              jsonStage.verify.verifyFile ||
              resolveStagePath(DEFAULT_VERIFY_FILE, stageName),
            mode: parseVerifyMode(jsonStage.verify.mode),
          }
        : undefined,
    };
  }

  // Post-process: reconnect nextStage chains around disabled stages
  if (disabledStages.size > 0) {
    const STAGE_ORDER: PipelineStage[] = [
      "clarify",
      "design",
      "plan",
      "develop",
      "review",
      "fix",
      "awaiting_human",
      "completed",
    ];
    for (const [stageName, sc] of Object.entries(stages)) {
      if (disabledStages.has(stageName as PipelineStage)) continue;
      if (!sc!.nextStage) continue;
      if (!disabledStages.has(sc!.nextStage)) continue;
      const startIdx = STAGE_ORDER.indexOf(sc!.nextStage);
      let resolvedNext: PipelineStage | null = null;
      for (let i = startIdx + 1; i < STAGE_ORDER.length; i++) {
        if (!disabledStages.has(STAGE_ORDER[i]) && stages[STAGE_ORDER[i]]) {
          resolvedNext = STAGE_ORDER[i];
          break;
        }
      }
      sc!.nextStage = resolvedNext;
    }
  }

  // Validate nextStage references
  for (const [stageName, sc] of Object.entries(stages)) {
    if (sc!.nextStage && !stages[sc!.nextStage]) {
      throw new Error(
        `Stage "${stageName}" references unknown nextStage "${sc!.nextStage}"`,
      );
    }
  }

  // Warn on circular references
  for (const [stageName, sc] of Object.entries(stages)) {
    if (sc!.nextStage) {
      for (const [otherName, otherSc] of Object.entries(stages)) {
        if (otherName !== stageName && otherSc!.nextStage === stageName) {
          console.info(
            `[pi-pipeline] Circular reference detected: ${stageName} → ${sc!.nextStage} → ${stageName}. ` +
              `maxLoopCycles=${json.maxLoopCycles ?? 3} will limit cycles.`,
          );
          break;
        }
      }
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
