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
import {
  COMPAT_ROUND_PATTERN,
  compileGroup,
  compileRoundGroup,
  markerPattern,
  withCompatRound,
} from "./clarify-anchor-patterns";

// Re-exported for consumers that only need the compatibility alias.
export { COMPAT_ROUND_PATTERN };

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
  /** Effective literal answer markers (job → defaults); first entry is the primary. */
  answerMarkers: string[];
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
  // Plan Phase 0 order: job `patterns` → deployed verify.md patterns → patterns
  // GENERATED from the markers. A job that only declares `answers.markers`
  // must not short-circuit verify.md, BUT its marker patterns must be part of
  // the accepted set: the prompt asks for `answers.markers` while the parser
  // would otherwise only accept verify.md (INV-4, review 221-3b). The explicit
  // job markers therefore come FIRST, followed by the verify.md patterns.
  const jobMarkerPatterns = job?.answerMarkers?.length
    ? job.answerMarkers.map(markerPattern)
    : undefined;
  const answerSources =
    job?.answerPatterns ??
    (jobMarkerPatterns
      ? [...new Set([...jobMarkerPatterns, ...(verify?.answerField?.patterns ?? [])])]
      : verify?.answerField?.patterns) ??
    (job?.answerMarkers ?? DEFAULT_CLARIFY_PROTOCOL.answerMarkers).map(markerPattern);
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
    answerMarkers,
    answerPrimary: answerMarkers[0]!,
    verdictReady: pick(job?.verdictReady, DEFAULT_CLARIFY_PROTOCOL.verdictReady),
    verdictNeedsClarify: pick(job?.verdictNeedsClarify, DEFAULT_CLARIFY_PROTOCOL.verdictNeedsClarify),
    modelConfirm,
    completionPrimary: modelConfirm[0]!,
  };
}
