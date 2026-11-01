/**
 * @module auto-pipeline/clarify-anchors
 * 221 Phase 0: single source for the clarify protocol anchors.
 *
 * Facts:
 * - Anchors were hard-coded constants (`## 需求评估`, `答：`, `## 模型确认`, …),
 *   so an English document could never finish end-to-end.
 * - Resolution order is always: job JSON (`.pi/pipeline_loop_job.json`)
 *   → deployed `verify.md` runtime anchors → bilingual code defaults.
 * - The SAME resolved anchor set feeds the parsers AND the injected directive
 *   (INV-4): the plugin never asks the agent to write A while parsing B.
 * - Fail-open: a missing/invalid configuration only warns and falls back; it
 *   never throws and never blocks an auto job or a human stage.
 * - The precheck switch is frozen: `completionMarker` unset (or an empty array)
 *   stays `undefined`; job `modelConfirm` aliases only affect prompts/primary.
 * - The JSON-file half lives in `clarify-protocol-config.ts` (module budget).
 */

import type { ClarifyProtocolConfig } from "../../types";
import type { VerifyContractAnchors } from "../../utils/contract-loader";
import { DEFAULT_COMPLETION_MARKERS } from "../../constants";

/** Fully resolved clarify protocol anchors consumed by parsers and injectors. */
export interface ResolvedClarifyAnchors {
  assessmentHeading: string[];
  goalHeading: string[];
  scopeHeading: string[];
  acceptanceHeading: string[];
  ledgerHeading: string[];
  eliminationMarkers: string[];
  conflictMarkers: string[];
  questionPatterns: RegExp[];
  roundPatterns: RegExp[];
  answerPatterns: RegExp[];
  answerPrimary: string;
  verdictReady: string[];
  verdictNeedsClarify: string[];
  modelConfirm: string[];
  completionPrimary: string;
}

/** Bilingual code defaults (used when neither job JSON nor verify.md declares a key). */
export const DEFAULT_CLARIFY_PROTOCOL: Required<Omit<ClarifyProtocolConfig, "modelConfirm">> & {
  modelConfirm: string[];
} = {
  assessmentHeading: ["## 需求评估", "## Requirement Assessment"],
  goalHeading: ["## 目标", "## Goal"],
  scopeHeading: ["## 范围", "## Scope"],
  acceptanceHeading: ["## 验收标准", "## Acceptance Criteria"],
  ledgerHeading: ["## 组合决策台账", "## Decision Ledger"],
  eliminationMarkers: ["淘汰理由", "淘汰原因", "elimination reason"],
  conflictMarkers: ["冲突矩阵", "conflict matrix"],
  questionPatterns: ["^##\\s*问题\\s+(\\d+)", "^##\\s*Question\\s+(\\d+)"],
  roundPatterns: ["^#{1,2}\\s*第\\s*(\\d+)\\s*轮", "^#{1,2}\\s*Round\\s+(\\d+)"],
  answerMarkers: ["答：", "Answer:"],
  answerPatterns: ["^\\s*答\\s*[:：]", "^\\s*Answer\\s*:"],
  verdictReady: ["ready", "已明确"],
  verdictNeedsClarify: ["needs-clarify", "需澄清"],
  modelConfirm: [...DEFAULT_COMPLETION_MARKERS],
};

/**
 * 221 (F4): permissive round-heading fallback for deployed documents that use
 * h3, omit "澄清", or write a Chinese numeral (`### 第二轮澄清`). Appended to the
 * EFFECTIVE round set only — never shown as the primary anchor.
 */
export const COMPAT_ROUND_PATTERN = "^#+\\s+.*轮";

/** Default flags used when validating regex sources. */
const PATTERN_FLAGS = "gm";

/** Normalize a marker config into a non-empty, deduped string list. */
export function normalizeMarkers(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

/** Primary (first) marker of a config value; empty string when unset. */
export function primaryMarker(value: string | string[] | undefined): string {
  return normalizeMarkers(value)[0] ?? "";
}

/**
 * Normalize a `completionMarker` config for ALL stages.
 *
 * Frozen semantics (INV-1): `undefined` and an EMPTY array both resolve to
 * `undefined` (= no precheck). A configured string stays a string; an array is
 * trimmed/deduped but keeps its array shape (its first entry is the primary).
 */
export function normalizeMarkerConfig(
  value: string | string[] | undefined,
): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const markers = normalizeMarkers(value);
  return markers.length > 0 ? markers : undefined;
}

/**
 * Merge job-JSON `modelConfirm` aliases into the stage `completionMarker`.
 *
 * - `configured` unset/empty ⇒ `undefined` — job aliases must NEVER enable
 *   precheck on their own (frozen B1 decision).
 * - `configured` set + aliases ⇒ additive union (string becomes an array).
 * - `configured` set + no aliases ⇒ the configured value unchanged.
 */
export function mergeCompletionMarkers(
  configured: string | string[] | undefined,
  aliases: string[] | undefined,
): string | string[] | undefined {
  const base = normalizeMarkerConfig(configured);
  if (base === undefined) return undefined;
  const own = normalizeMarkers(base);
  const merged = normalizeMarkers([...own, ...(aliases ?? [])]);
  return merged.length === own.length ? base : merged;
}

/** Compile a pattern group; any invalid source drops the WHOLE group (fail-open). */
function compileGroup(sources: string[], label: string, issues: string[]): RegExp[] | null {
  if (sources.length === 0) return null;
  let failed = false;
  for (const source of sources) {
    try {
      new RegExp(source, PATTERN_FLAGS);
    } catch (err) {
      failed = true;
      issues.push(`${label}: invalid pattern "${source}" (${String(err)})`);
    }
  }
  return failed ? null : sources.map((source) => new RegExp(source, PATTERN_FLAGS));
}

/**
 * Compile a round-heading group and validate the JOINED regex.
 *
 * Consumers join the sources with `|` before matching (`compileRoundHeading`);
 * two patterns declaring the same named group compile individually but throw
 * when joined — validating the join here prevents a silent `fresh` fallback.
 */
function compileRoundGroup(sources: string[], label: string, issues: string[]): RegExp[] | null {
  const regexes = compileGroup(sources, label, issues);
  if (!regexes) return null;
  try {
    new RegExp(regexes.map((r) => r.source).join("|"), PATTERN_FLAGS);
  } catch (err) {
    issues.push(`${label}: pattern set cannot be combined (${String(err)})`);
    return null;
  }
  return regexes;
}

/** Append the permissive round fallback to an effective set (deduped). */
function withCompatRound(patterns: RegExp[], issues: string[]): RegExp[] {
  if (patterns.some((p) => p.source === COMPAT_ROUND_PATTERN)) return patterns;
  const effective = [...patterns, new RegExp(COMPAT_ROUND_PATTERN, PATTERN_FLAGS)];
  try {
    new RegExp(effective.map((p) => p.source).join("|"), PATTERN_FLAGS);
    return effective;
  } catch (err) {
    issues.push(`round pattern compatibility alias dropped (${String(err)})`);
    return patterns;
  }
}

/** Escape one literal marker into a `^\s*<marker>` regex source. */
function markerPattern(marker: string): string {
  return `^\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
}

/**
 * Resolve every clarify anchor from job JSON → verify.md → defaults.
 *
 * Warnings (invalid patterns, unusable groups) are emitted via `console.warn`;
 * the call never throws (INV-5).
 */
export function resolveClarifyAnchors(input: {
  job?: ClarifyProtocolConfig;
  verify?: VerifyContractAnchors;
  completionMarker?: string | string[];
}): ResolvedClarifyAnchors {
  const issues: string[] = [];
  const { job, verify } = input;
  const pick = (explicit: string[] | undefined, fallback: string[]): string[] =>
    explicit && explicit.length > 0 ? [...explicit] : [...fallback];

  const questionPatterns =
    compileGroup(job?.questionPatterns ?? [], "clarify.questions.patterns", issues) ??
    compileGroup(DEFAULT_CLARIFY_PROTOCOL.questionPatterns, "default question patterns", issues)!;

  const roundPatterns = withCompatRound(
    compileRoundGroup(job?.roundPatterns ?? [], "clarify.rounds.patterns", issues) ??
      compileRoundGroup(verify?.roundHeading?.patterns ?? [], "verify.roundHeading", issues) ??
      compileRoundGroup(DEFAULT_CLARIFY_PROTOCOL.roundPatterns, "default round patterns", issues)!,
    issues,
  );

  const answerMarkers = pick(job?.answerMarkers, DEFAULT_CLARIFY_PROTOCOL.answerMarkers);
  const answerSources =
    job?.answerPatterns ??
    job?.answerMarkers?.map(markerPattern) ??
    verify?.answerField?.patterns ??
    [];
  const answerPatterns =
    compileGroup(answerSources, "clarify.answers.patterns", issues) ??
    compileGroup(DEFAULT_CLARIFY_PROTOCOL.answerPatterns, "default answer patterns", issues)!;

  const modelConfirm = normalizeMarkers([
    ...(job?.modelConfirm ?? []),
    ...normalizeMarkers(input.completionMarker),
    ...DEFAULT_CLARIFY_PROTOCOL.modelConfirm,
  ]);

  for (const issue of issues) console.warn(`[pi-pipeline] clarify anchors: ${issue}`);

  return {
    assessmentHeading: pick(job?.assessmentHeading, DEFAULT_CLARIFY_PROTOCOL.assessmentHeading),
    goalHeading: pick(job?.goalHeading, DEFAULT_CLARIFY_PROTOCOL.goalHeading),
    scopeHeading: pick(job?.scopeHeading, DEFAULT_CLARIFY_PROTOCOL.scopeHeading),
    acceptanceHeading: pick(job?.acceptanceHeading, DEFAULT_CLARIFY_PROTOCOL.acceptanceHeading),
    ledgerHeading: pick(job?.ledgerHeading, DEFAULT_CLARIFY_PROTOCOL.ledgerHeading),
    eliminationMarkers: pick(job?.eliminationMarkers, DEFAULT_CLARIFY_PROTOCOL.eliminationMarkers),
    conflictMarkers: pick(job?.conflictMarkers, DEFAULT_CLARIFY_PROTOCOL.conflictMarkers),
    questionPatterns,
    roundPatterns,
    answerPatterns,
    answerPrimary: answerMarkers[0]!,
    verdictReady: pick(job?.verdictReady, DEFAULT_CLARIFY_PROTOCOL.verdictReady),
    verdictNeedsClarify: pick(job?.verdictNeedsClarify, DEFAULT_CLARIFY_PROTOCOL.verdictNeedsClarify),
    modelConfirm,
    completionPrimary: modelConfirm[0]!,
  };
}
