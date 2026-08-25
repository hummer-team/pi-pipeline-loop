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
  ProtectConfig,
  StageConfig,
  StageJsonConfig,
  StartStageMode,
} from "../types";
import {
  DEFAULT_SKILL_PATH,
  DEFAULT_VERIFY_FILE,
  DEFAULT_DECISION_SHORTCUT,
  STAGE_TYPE_TOOL_DEFAULTS,
  resolveStagePath,
} from "../constants";

const VALID_STAGES = new Set<PipelineStage>([
  "clarify",
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
    maxVerifyAttempts:
      typeof json.maxVerifyAttempts === "number" ? json.maxVerifyAttempts : undefined,
    decisionShortcutKey:
      typeof json.decisionShortcutKey === "string" ? json.decisionShortcutKey : undefined,
    output: parseOutputConfig(json.output),
    llmExtract: typeof json.llmExtract === "boolean" ? json.llmExtract : undefined,
    protect: parseProtectConfig(json.protect),
    startStageMode: parseStartStageMode(json.startStageMode),
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

/**
 * Parses the output configuration from JSON config.
 * Validates that output is an object and pipelineStage is boolean.
 * Returns undefined for missing/invalid output; logs warning for invalid values.
 */
function parseOutputConfig(raw: unknown): { pipelineStage?: boolean } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    console.warn(`[pi-pipeline] Invalid output config — expected object, got ${typeof raw}`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const pipelineStage = obj.pipelineStage;
  if (pipelineStage !== undefined && typeof pipelineStage !== "boolean") {
    console.warn(
      `[pi-pipeline] Invalid output.pipelineStage "${String(pipelineStage)}" — expected boolean, ignoring`,
    );
    return undefined;
  }
  return { pipelineStage: typeof pipelineStage === "boolean" ? pipelineStage : undefined };
}

/**
 * Parses and validates a decisionShortcutKey value from JSON config.
 * Must be a string matching KeyId format: modifier combinations of ctrl/shift/alt/super
 * followed by a final key (single alphanumeric or SpecialKey whitelist entry).
 * Invalid values warn and fall back to DEFAULT_DECISION_SHORTCUT.
 */
function parseDecisionShortcutKey(raw: unknown): string {
  const DEFAULT_KEY = DEFAULT_DECISION_SHORTCUT;
  if (typeof raw !== "string" || raw.length === 0) {
    if (raw !== undefined) {
      console.warn(
        `[pi-pipeline] Invalid decisionShortcutKey "${String(raw)}" — expected non-empty string, falling back to '${DEFAULT_KEY}'`,
      );
    }
    return DEFAULT_KEY;
  }
  // KeyId format: zero or more modifier prefixes (ctrl|shift|alt|super)+
  // followed by a final key segment that is either:
  //   - a single lowercase letter or digit [a-z0-9]
  //   - a SpecialKey whitelist entry (enter, escape, tab, space, etc.)
  // Supports multi-modifier combos like "ctrl+shift+d", "ctrl+enter", "alt+f1"
  const SPECIAL_KEYS = "enter|escape|tab|space|backspace|delete|home|end|pageUp|pageDown|up|down|left|right";
  const KEY_ID_REGEX = new RegExp(
    `^((ctrl|shift|alt|super)\\+)*(${SPECIAL_KEYS}|f[1-9]|f1[0-2]|[a-z0-9])$`,
  );
  if (!KEY_ID_REGEX.test(raw)) {
    console.warn(
      `[pi-pipeline] Invalid decisionShortcutKey "${raw}" — does not match KeyId format, falling back to '${DEFAULT_KEY}'`,
    );
    return DEFAULT_KEY;
  }
  return raw;
}

/**
 * Parses the protect configuration from JSON config.
 * Validates gitignore (boolean), paths (string[]), and allow (string[]).
 * Invalid types are logged as warnings and ignored.
 */
function parseProtectConfig(raw: unknown): ProtectConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    console.warn(`[pi-pipeline] Invalid protect config — expected object, got ${typeof raw}`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const result: ProtectConfig = {};

  // Parse gitignore (boolean)
  if (obj.gitignore !== undefined) {
    if (typeof obj.gitignore === "boolean") {
      result.gitignore = obj.gitignore;
    } else {
      console.warn(
        `[pi-pipeline] Invalid protect.gitignore "${String(obj.gitignore)}" — expected boolean, ignoring`,
      );
    }
  }

  // Parse paths (string[])
  if (obj.paths !== undefined) {
    if (Array.isArray(obj.paths) && obj.paths.every((p) => typeof p === "string")) {
      result.paths = obj.paths as string[];
    } else {
      console.warn(
        `[pi-pipeline] Invalid protect.paths — expected string[], ignoring`,
      );
    }
  }

  // Parse allow (string[])
  if (obj.allow !== undefined) {
    if (Array.isArray(obj.allow) && obj.allow.every((a) => typeof a === "string")) {
      result.allow = obj.allow as string[];
    } else {
      console.warn(
        `[pi-pipeline] Invalid protect.allow — expected string[], ignoring`,
      );
    }
  }

  // Parse ask (boolean)
  if (obj.ask !== undefined) {
    if (typeof obj.ask === "boolean") {
      result.ask = obj.ask;
    } else {
      console.warn(
        `[pi-pipeline] Invalid protect.ask "${String(obj.ask)}" — expected boolean, ignoring`,
      );
    }
  }

  return result;
}

/**
 * Parses and validates a startStageMode value from JSON config.
 * Must be one of "auto", "confirm", or "ask".
 * Invalid values log a warning and return undefined (resolved to "auto" default).
 */
function parseStartStageMode(raw: unknown): StartStageMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "auto" || raw === "confirm" || raw === "ask") {
    return raw;
  }
  console.warn(
    `[pi-pipeline] Invalid startStageMode "${String(raw)}" — expected "auto"|"confirm"|"ask", falling back to "auto"`,
  );
  return undefined;
}

/**
 * Parses and validates allowedWritePaths from JSON stage config.
 * Must be string[] (each entry is a path prefix or "**").
 * Invalid types are logged as warnings and ignored (returns undefined).
 */
function parseAllowedWritePaths(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn(
      `[pi-pipeline] Invalid allowedWritePaths — expected string[], got ${typeof raw}, ignoring`,
    );
    return undefined;
  }
  for (const entry of raw) {
    if (typeof entry !== "string") {
      console.warn(
        `[pi-pipeline] Invalid allowedWritePaths entry "${String(entry)}" — expected string, ignoring entire array`,
      );
      return undefined;
    }
  }
  return raw as string[];
}

/**
 * Walks the nextStage chain from `start` and returns the cycle path
 * (e.g. ["review","fix","review"]) if any visited node is revisited,
 * or null if the chain terminates without a cycle.
 */
function findCycle(
  stages: Record<PipelineStage, StageConfig>,
  start: PipelineStage,
): PipelineStage[] | null {
  const visited = new Map<PipelineStage, number>(); // stage → index in path
  const path: PipelineStage[] = [];
  let current: PipelineStage | null = start;
  while (current !== null) {
    const prevIdx = visited.get(current);
    if (prevIdx !== undefined) {
      // Return the cycle from first occurrence of `current` to end, plus `current`
      return [...path.slice(prevIdx), current];
    }
    visited.set(current, path.length);
    path.push(current);
    const sc: StageConfig | undefined = stages[current];
    current = sc?.nextStage ?? null;
  }
  return null;
}

/**
 * Normalizes a cycle path for deduplication: rotate so the lexicographically
 * smallest node comes first, then join with " → ". The trailing duplicate
 * node (closing the loop) is kept for display but excluded from rotation.
 */
function normalizeCycleKey(cycle: PipelineStage[]): string {
  // cycle looks like ["a","b","c","a"] — last element equals first
  if (cycle.length < 2) return cycle.join(" → ");
  const body = cycle.slice(0, -1); // without the closing duplicate
  let minIdx = 0;
  for (let i = 1; i < body.length; i++) {
    if (body[i] < body[minIdx]) minIdx = i;
  }
  const rotated = [...body.slice(minIdx), ...body.slice(0, minIdx)];
  // Append the first element to close the loop for display
  rotated.push(rotated[0]);
  return rotated.join(" → ");
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
        agentPath: undefined,
        skillPath: resolveStagePath(DEFAULT_SKILL_PATH, stageName),
        allowedWritePaths: [],
        nextStage: null,
        requireDomain: false,
        disabled: true,
      };
      continue;
    }

    const defaults =
      STAGE_TYPE_TOOL_DEFAULTS[stageName] ||
      STAGE_TYPE_TOOL_DEFAULTS.clarify;

    stages[stageName] = {
      agentPath: jsonStage.agentPath,
      skillPath:
        jsonStage.skillPath ||
        resolveStagePath(DEFAULT_SKILL_PATH, stageName),
      allowedWritePaths:
        parseAllowedWritePaths(jsonStage.allowedWritePaths) ?? defaults.allowedWritePaths,
      nextStage:
        jsonStage.nextStage !== undefined ? jsonStage.nextStage : null,
      requireDomain: jsonStage.requireDomain ?? false,
      verify: jsonStage.verify
        ? {
            // All stages default to verify.require = true
            require: jsonStage.verify.require ?? true,
            verifyFile:
              jsonStage.verify.verifyFile ||
              resolveStagePath(DEFAULT_VERIFY_FILE, stageName),
            mode: parseVerifyMode(jsonStage.verify.mode),
            selfVerifySkip: jsonStage.verify.selfVerifySkip ?? false,
            completionMarker: jsonStage.verify.completionMarker,
          }
        : undefined,
    };
  }

  // Post-process: reconnect nextStage chains around disabled stages
  if (disabledStages.size > 0) {
    const STAGE_ORDER: PipelineStage[] = [
      "clarify",
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

  // Warn on circular references (DFS along nextStage chain)
  const seenCycleKeys = new Set<string>();
  for (const stageName of Object.keys(stages)) {
    const sc = stages[stageName as PipelineStage];
    if (!sc!.nextStage) continue;
    const cycle = findCycle(stages, stageName as PipelineStage);
    if (!cycle) continue;
    // Normalize cycle: rotate to lexicographically smallest node, then dedupe
    const normalizedKey = normalizeCycleKey(cycle);
    if (seenCycleKeys.has(normalizedKey)) continue;
    seenCycleKeys.add(normalizedKey);
    console.info(
      `[pi-pipeline] Circular reference detected: ${normalizedKey}. ` +
        `maxLoopCycles=${json.maxLoopCycles ?? 3} will limit cycles.`,
    );
  }

  return {
    stages,
    projectRoot,
    auditDir: json.auditDir || ".pi/audit",
    domainDir: json.domainDir || ".pi/domains",
    maxLoops: json.maxLoops ?? 3,
    maxLoopCycles: json.maxLoopCycles ?? 3,
    maxVerifyAttempts: json.maxVerifyAttempts ?? json.maxLoops ?? 3,
    decisionShortcutKey: parseDecisionShortcutKey(json.decisionShortcutKey),
    output: { pipelineStage: json.output?.pipelineStage ?? true },
    llmExtract: json.llmExtract ?? false,
    protect: {
      gitignore: json.protect?.gitignore ?? true,
      paths: json.protect?.paths ?? [],
      allow: json.protect?.allow ?? [],
      ask: json.protect?.ask ?? false,
    },
    startStageMode: json.startStageMode ?? "auto",
  };
}
