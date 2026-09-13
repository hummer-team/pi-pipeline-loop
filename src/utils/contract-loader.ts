/**
 * @module contract-loader
 * Runtime contract-anchor loader (Phase 2 / 176, decisions R1Q1B / R2Q3 / R3Q1).
 *
 * "Declaration is behavior": the deployed verify.md is the single source for the
 * runtime patterns used by clarify round derivation and review verdict parsing.
 * This module scans the parsed groups schema for `runtime:` attributes and
 * validates the anchor contract:
 * - group-level `runtime: roundHeading` → `when` must contain a named round group.
 * - node-level `runtime: answerField | modelConfirm | verdict`.
 * - verdict patterns must each expose capture group 1 (value-extraction contract).
 *
 * Missing/invalid anchors are returned as `issues` (fail-open at the consumer),
 * never thrown.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, PipelineStage } from "../types";
import { DEFAULT_VERIFY_FILE, resolveStagePath } from "../constants";
import { parseFrontmatter } from "../core/verify-frontmatter";

/** A runtime anchor's pattern set (multiple patterns combined by `mode`). */
export interface VerifyContractPatternSet {
  patterns: string[];
  mode: "and" | "or";
}

/**
 * Runtime contract anchors extracted from a verify.md groups schema.
 * All keys are optional; a key is treated as missing when an issue is reported.
 */
export interface VerifyContractAnchors {
  /** Group-level round heading anchor (from group `when`). */
  roundHeading?: VerifyContractPatternSet;
  /** Node-level answer field anchor. */
  answerField?: VerifyContractPatternSet;
  /** Node-level model confirmation anchor. */
  modelConfirm?: VerifyContractPatternSet;
  /** Node-level verdict anchor (each pattern must expose capture group 1). */
  verdict?: VerifyContractPatternSet;
}

/** Result of loading runtime anchors. */
export interface LoadVerifyContractAnchorsResult {
  anchors: VerifyContractAnchors;
  /** Human-readable issue list; non-empty issues mean the key is unavailable. */
  issues: string[];
}

/** Valid node-level runtime anchor names. */
const NODE_RUNTIME_KEYS = new Set(["answerField", "modelConfirm", "verdict"]);

/** Valid group-level runtime anchor names. */
const GROUP_RUNTIME_KEYS = new Set(["roundHeading"]);

/**
 * Resolves the absolute verify.md path for a stage (single source, Phase 2 / 176).
 * Extracted from runVerification to eliminate duplicated path logic.
 *
 * @param config - Pipeline configuration
 * @param stage - Pipeline stage
 * @param overrideFile - Optional per-execution verify file override
 */
export function resolveVerifyFilePath(
  config: PipelineConfig,
  stage: PipelineStage,
  overrideFile?: string,
): string {
  const verifyFile = overrideFile ?? config.stages[stage].verify?.verifyFile;
  return verifyFile
    ? (path.isAbsolute(verifyFile) ? verifyFile : path.join(config.projectRoot, verifyFile))
    : path.join(config.projectRoot, resolveStagePath(DEFAULT_VERIFY_FILE, stage));
}

/** Returns true when the pattern compiles and declares a named round group. */
export function hasNamedRoundGroup(pattern: string): boolean {
  try {
    // Compile check (throws on invalid regex).
    new RegExp(pattern);
  } catch {
    return false;
  }
  return /\(\?<round(?:Zh|En)>/.test(pattern);
}

/**
 * Counts capturing groups in a regex source. Uses the `(?:pattern|)` trick:
 * appending an empty alternative guarantees a match whose array length equals
 * the number of capturing groups plus one.
 *
 * @returns Group count, or -1 when the pattern is not a valid regex
 */
export function countCaptureGroups(pattern: string): number {
  try {
    const re = new RegExp(`${pattern}|`);
    const match = re.exec("");
    return match ? match.length - 1 : 0;
  } catch {
    return -1;
  }
}

/** Builds a pattern set from a node's patterns + mode. */
function toPatternSet(patterns: string[] | undefined, mode: "and" | "or" | undefined): VerifyContractPatternSet {
  return { patterns: patterns ?? [], mode: mode ?? "and" };
}

/**
 * Loads and validates runtime contract anchors from the deployed verify.md.
 *
 * @param config - Pipeline configuration
 * @param stage - Pipeline stage
 * @param overrideFile - Optional per-execution verify file override
 * @returns Anchors plus an issue list (issues non-empty ⇒ anchor unavailable)
 */
export async function loadVerifyContractAnchors(
  config: PipelineConfig,
  stage: PipelineStage,
  overrideFile?: string,
): Promise<LoadVerifyContractAnchorsResult> {
  const anchors: VerifyContractAnchors = {};
  const issues: string[] = [];
  const verifyPath = resolveVerifyFilePath(config, stage, overrideFile);

  let raw: string;
  try {
    raw = await fs.readFile(verifyPath, "utf-8");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    issues.push(`verify.md unreadable at "${verifyPath}": ${errMsg}`);
    return { anchors, issues };
  }

  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 2 || !parts[1].trim()) {
    issues.push(`verify.md has no YAML frontmatter at "${verifyPath}"`);
    return { anchors, issues };
  }

  const rules = await parseFrontmatter(parts[1].trim());
  if (!rules) {
    issues.push(`verify.md frontmatter could not be parsed at "${verifyPath}"`);
    return { anchors, issues };
  }

  for (const group of rules.groups ?? []) {
    if (group.runtime !== undefined) {
      if (!GROUP_RUNTIME_KEYS.has(group.runtime)) {
        issues.push(`group "${group.name}" has invalid runtime "${group.runtime}"`);
      } else if (!group.when) {
        issues.push(`group "${group.name}" runtime "${group.runtime}" requires a when pattern`);
      } else if (!hasNamedRoundGroup(group.when)) {
        issues.push(`group "${group.name}" runtime "roundHeading" when pattern lacks named groups roundZh/roundEn`);
      } else {
        anchors.roundHeading = { patterns: [group.when], mode: "and" };
      }
    }

    for (const node of group.rules) {
      if (node.runtime === undefined) continue;
      if (!NODE_RUNTIME_KEYS.has(node.runtime)) {
        issues.push(`node runtime "${node.runtime}" is invalid`);
        continue;
      }
      const set = toPatternSet(node.patterns, node.mode);
      if (set.patterns.length === 0) {
        issues.push(`node runtime "${node.runtime}" has no patterns`);
        continue;
      }
      if (node.runtime === "verdict") {
        const bad = set.patterns.filter((p) => countCaptureGroups(p) < 1);
        if (bad.length > 0) {
          issues.push(`verdict runtime pattern(s) missing capture group 1: ${bad.join(", ")}`);
          continue;
        }
        anchors.verdict = set;
      } else if (node.runtime === "answerField") {
        anchors.answerField = set;
      } else if (node.runtime === "modelConfirm") {
        anchors.modelConfirm = set;
      }
    }
  }

  return { anchors, issues };
}
