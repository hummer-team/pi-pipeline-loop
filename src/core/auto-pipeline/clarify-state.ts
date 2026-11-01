/**
 * @module auto-pipeline/clarify-state
 * 220 Phase 3 (D1): the per-doc clarify sidecar state and the two outcome
 * helpers shared by the clarify entry point and its dispatch step.
 *
 * Facts:
 * - `AutoJobDocProgress` is the ONLY home of the clarify counters (B13: sidecar,
 *   never `meta`), so every read/write goes through this module.
 * - Counters are per doc and never inherited across docs: a new document starts
 *   with `undefined` (no reset write, no back-fill).
 * - A persistence failure is reported (error level) but never changes control
 *   flow: the round already happened, hiding it would be worse.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import { loadVerifyContractAnchors } from "../../utils/contract-loader";
import { spawnStageSubagent } from "../../utils/subagent-rpc";
import { freezeAndPrompt } from "../flow-state";
import { auditAutoDecision } from "./auto-audit";
import { decideClarifyDispatch, type ClarifyDispatchDecision } from "./clarify-dispatch";
import { parseRequirementAssessment } from "./clarify-protocol";
import { DEFAULT_CLARIFY_STALL_LIMIT } from "./clarify-stall";
import { auditAutoDiagnostic } from "./diagnostics";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobDocProgress, AutoJobState } from "./job-state";
import { writeJobState } from "./job-state";

/** Forward args of the plugin-forced finalisation round. */
export const FORCED_FULL_UND_ARGS = " full-und?";

/**
 * Consecutive `needs-clarify` rounds after which clarify is frozen as
 * "the requirement itself is unclear" (Q6/Q7: two failed assessments in a row
 * mean the document, not the round, is the problem).
 */
export const CLARIFY_NEEDS_CLARIFY_LIMIT = 2;

/** Minimum context the auto clarify modules need (subagent-rpc's spawn shape). */
export interface ClarifyEntryCtx {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: { notify?: (msg: string, type?: "info" | "error" | "warning") => void };
  pi?: unknown;
}

/**
 * The two side effects of an auto clarify round, injected so a suite can pin the
 * contract WITHOUT a process-wide `mock.module` (which would corrupt unrelated
 * suites that share the same modules).
 */
export interface ClarifyEntryDeps {
  spawn: typeof spawnStageSubagent;
  freeze: typeof freezeAndPrompt;
}

export const DEFAULT_CLARIFY_DEPS: ClarifyEntryDeps = {
  spawn: spawnStageSubagent,
  freeze: freezeAndPrompt,
};

/** The document facts one round is decided on (read once, never re-parsed). */
export interface ClarifyDocState {
  doc: string;
  docText: string | null;
  progress: AutoJobDocProgress;
  decision: ClarifyDispatchDecision;
  assessmentVerdict: "ready" | "needs-clarify" | "unknown";
  grew: boolean;
}

/**
 * Read the running document ONCE and derive the round decision.
 *
 * Shared by `clarify-entry.ts` (the settle-side entry) and
 * `clarify-marker-miss.ts` (the forced finalisation round), so both dispatch
 * paths decide on the same evidence — a second read/parse block would let the
 * two paths disagree about the current round.
 *
 * @returns `null` when the sidecar's running doc is not the caller's document
 *   (the counters must never be attributed to a foreign document).
 */
export async function buildClarifyDocState(input: {
  config: PipelineConfig;
  state: AutoJobState;
  job: AutoJobConfig;
  doc: string;
  now: number;
}): Promise<ClarifyDocState | null> {
  const { config, state, job, doc, now } = input;
  const progress = state.docs[state.docIndex];
  if (!progress || progress.doc !== doc) return null;

  const docText = await readRequirementText(config.projectRoot, doc);
  const { anchors } = await loadVerifyContractAnchors(config, "clarify");
  const assessment = docText === null ? null : parseRequirementAssessment(docText);
  const previousDocLength = progress.clarifyStallDocLength ?? 0;

  const decision = decideClarifyDispatch({
    autoActive: true,
    requirementDoc: doc,
    docText,
    ...(anchors ? { anchors } : {}),
    usedRounds: progress.clarifyRounds ?? 0,
    maxRounds: job.clarify.maxRounds,
    stalls: progress.clarifyStalls ?? 0,
    stallLimit: DEFAULT_CLARIFY_STALL_LIMIT,
    needsClarifyStreak: progress.clarifyNeedsClarifyStreak ?? 0,
    needsClarifyLimit: CLARIFY_NEEDS_CLARIFY_LIMIT,
    assessment,
    ...(progress.clarifyLastRound !== undefined ? { lastDispatchedRound: progress.clarifyLastRound } : {}),
    ...(progress.clarifyDispatchedAt !== undefined ? { lastDispatchedAt: progress.clarifyDispatchedAt } : {}),
    now,
  });

  return {
    doc,
    docText,
    progress,
    decision,
    assessmentVerdict: assessment?.verdict ?? "unknown",
    grew: (docText?.length ?? 0) > previousDocLength,
  };
}

/** Persist the sidecar; a write failure is reported but never blocks the flow. */
export async function persistClarifyState(config: PipelineConfig, state: AutoJobState): Promise<void> {
  try {
    await writeJobState(config.projectRoot, state);
  } catch (err) {
    auditAutoDiagnostic("clarify_state_persist_failed", "Auto-job clarify state could not be persisted.", {
      jobId: state.jobId,
      error: String(err),
    }, "error");
  }
}

/** Reset every per-doc clarify counter once clarify is confirmed. */
export function resetClarifyCounters(progress: AutoJobDocProgress, now: number): void {
  progress.clarifyRounds = undefined;
  progress.clarifyLastRound = undefined;
  progress.clarifyDispatchedAt = undefined;
  progress.clarifyStalls = undefined;
  progress.clarifyStallSignature = undefined;
  progress.clarifyStallDocLength = undefined;
  progress.clarifyNeedsClarifyStreak = undefined;
  progress.updatedAt = now;
}

/** Read the requirement document; `null` when it cannot be read (never throws). */
export async function readRequirementText(projectRoot: string, doc: string): Promise<string | null> {
  const abs = path.isAbsolute(doc) ? doc : path.join(projectRoot, doc);
  try {
    return await fs.promises.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/** Freeze the pipeline with one clarify-specific reason (job policy decides). */
export async function freezeClarify(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  reason: string,
  decision: ClarifyDispatchDecision,
  deps: ClarifyEntryDeps,
): Promise<boolean> {
  await auditAutoDecision(config, {
    gate: "clarify_freeze",
    decision: decision.action,
    reason,
    round: String(decision.round),
  });
  await deps.freeze(ctx as never, meta, reason, config, { ui: ctx.ui as never });
  return true;
}
