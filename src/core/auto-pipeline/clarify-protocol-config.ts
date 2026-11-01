/**
 * @module auto-pipeline/clarify-protocol-config
 * 221 Phase 0: optional `.pi/pipeline_loop_job.json` parsing and loading.
 *
 * Facts:
 * - The job config nests anchors by protocol concept (`clarify.ledger.heading`)
 *   while consumers want a FLAT `ClarifyProtocolConfig`; the mapping lives here
 *   so a template key can never be written without a reader.
 * - Unknown keys only warn (forward compatibility); an invalid key is dropped
 *   without affecting its siblings (fail-open, INV-5).
 * - Loading happens in `resolvePipelineConfig`, BEFORE the audit log exists, so
 *   `console.warn` is the only available channel (same as the JSON loader).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ClarifyProtocolConfig } from "../../types";
import { PIPELINE_LOOP_JOB_CONFIG_FILE } from "../../constants";

type JsonRecord = Record<string, unknown>;

/** Top-level keys accepted in the job config file. */
const TOP_LEVEL_KEYS = ["version", "clarify"] as const;

/** Nested `clarify` keys accepted in the job config file. */
const CLARIFY_KEYS = [
  "assessment",
  "sections",
  "ledger",
  "questions",
  "rounds",
  "answers",
  "verdicts",
  "modelConfirm",
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read an optional string-array key; invalid entries are dropped with an issue. */
function readArray(value: unknown, label: string, issues: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array of non-empty strings`);
    return undefined;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      issues.push(`${label} entry ignored (expected a non-empty string)`);
      continue;
    }
    seen.add(item.trim());
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/** Read an optional object key; unknown nested keys warn but do not block. */
function readObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
  issues: string[],
): JsonRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`unknown key "${label}.${key}" ignored`);
  }
  return value;
}

/**
 * Parse the raw job config value into a flat `ClarifyProtocolConfig` (pure).
 *
 * @returns `config` only when at least one anchor key was declared; `issues`
 *   always carries every warning (unknown keys, invalid values, version drift).
 */
export function parseClarifyProtocolJson(raw: unknown): {
  config?: ClarifyProtocolConfig;
  issues: string[];
} {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    issues.push("top-level value must be an object");
    return { issues };
  }
  for (const key of Object.keys(raw)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      issues.push(`unknown top-level key "${key}" ignored`);
    }
  }
  if (raw.version !== undefined && raw.version !== 1) {
    issues.push(`unsupported version ${String(raw.version)} (expected 1); parsing continues`);
  }
  const clarify = readObject(raw.clarify, "clarify", CLARIFY_KEYS, issues);
  if (!clarify) return { issues };

  const config: ClarifyProtocolConfig = {};
  const assign = (key: keyof ClarifyProtocolConfig, value: string[] | undefined): void => {
    if (value) config[key] = value;
  };

  const assessment = readObject(clarify.assessment, "clarify.assessment", ["heading"], issues);
  assign("assessmentHeading", readArray(assessment?.heading, "clarify.assessment.heading", issues));

  const sections = readObject(
    clarify.sections,
    "clarify.sections",
    ["goal", "scope", "acceptance"],
    issues,
  );
  assign("goalHeading", readArray(sections?.goal, "clarify.sections.goal", issues));
  assign("scopeHeading", readArray(sections?.scope, "clarify.sections.scope", issues));
  assign("acceptanceHeading", readArray(sections?.acceptance, "clarify.sections.acceptance", issues));

  const ledger = readObject(
    clarify.ledger,
    "clarify.ledger",
    ["heading", "eliminationMarkers", "conflictMarkers"],
    issues,
  );
  assign("ledgerHeading", readArray(ledger?.heading, "clarify.ledger.heading", issues));
  assign(
    "eliminationMarkers",
    readArray(ledger?.eliminationMarkers, "clarify.ledger.eliminationMarkers", issues),
  );
  assign("conflictMarkers", readArray(ledger?.conflictMarkers, "clarify.ledger.conflictMarkers", issues));

  const questions = readObject(clarify.questions, "clarify.questions", ["patterns"], issues);
  assign("questionPatterns", readArray(questions?.patterns, "clarify.questions.patterns", issues));

  const rounds = readObject(clarify.rounds, "clarify.rounds", ["patterns"], issues);
  assign("roundPatterns", readArray(rounds?.patterns, "clarify.rounds.patterns", issues));

  const answers = readObject(clarify.answers, "clarify.answers", ["markers", "patterns"], issues);
  assign("answerMarkers", readArray(answers?.markers, "clarify.answers.markers", issues));
  assign("answerPatterns", readArray(answers?.patterns, "clarify.answers.patterns", issues));

  const verdicts = readObject(clarify.verdicts, "clarify.verdicts", ["ready", "needsClarify"], issues);
  assign("verdictReady", readArray(verdicts?.ready, "clarify.verdicts.ready", issues));
  assign("verdictNeedsClarify", readArray(verdicts?.needsClarify, "clarify.verdicts.needsClarify", issues));

  const modelConfirm = readObject(clarify.modelConfirm, "clarify.modelConfirm", ["markers"], issues);
  assign("modelConfirm", readArray(modelConfirm?.markers, "clarify.modelConfirm.markers", issues));

  return Object.keys(config).length > 0 ? { config, issues } : { issues };
}

/**
 * Read and parse the OPTIONAL `.pi/pipeline_loop_job.json`.
 *
 * @returns `undefined` when the file is missing, unreadable, not JSON, or
 *   declares no anchor at all (the human default path stays untouched).
 */
export function loadClarifyProtocolConfig(projectRoot: string): ClarifyProtocolConfig | undefined {
  const file = path.join(projectRoot, PIPELINE_LOOP_JOB_CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[pi-pipeline] ${PIPELINE_LOOP_JOB_CONFIG_FILE} is unreadable: ${String(err)}`);
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[pi-pipeline] ${PIPELINE_LOOP_JOB_CONFIG_FILE} is not valid JSON: ${String(err)}`);
    return undefined;
  }

  const result = parseClarifyProtocolJson(parsed);
  for (const issue of result.issues) {
    console.warn(`[pi-pipeline] ${PIPELINE_LOOP_JOB_CONFIG_FILE}: ${issue}`);
  }
  return result.config;
}
