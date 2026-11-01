/**
 * @module auto-pipeline/clarify-entry
 * 220 Phase 3/4 (D1/D2/D3): the ONLY entry point of an unattended clarify round.
 *
 * Division of responsibility:
 * - `clarify-dispatch.ts` decides WHAT to do (pure);
 * - `clarify-round-budget.ts` / `clarify-stall.ts` own the two counters;
 * - `clarify-protocol.ts` owns the document protocol directive;
 * - `clarify-state.ts` owns the sidecar shape + the shared outcome helpers;
 * - `clarify-round-dispatch.ts` performs the accounting and the dispatch;
 * - THIS module routes one decision to its freeze/dispatch outcome.
 *
 * Human track: every branch is gated by the caller (`meta.autoJob`) and by an
 * ACTIVE job lock, so a session without an auto job never reaches this module.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { loadVerifyContractAnchors } from "../../utils/contract-loader";
import { auditAutoDecision } from "./auto-audit";
import { decideClarifyDispatch } from "./clarify-dispatch";
import { parseRequirementAssessment } from "./clarify-protocol";
import {
  DEFAULT_CLARIFY_DEPS,
  freezeClarify,
  persistClarifyState,
  readRequirementText,
  resetClarifyCounters,
  type ClarifyDocState,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "./clarify-state";
import { dispatchClarifyRound } from "./clarify-round-dispatch";
import { handleClarifyBudgetExhausted } from "./clarify-autopilot";
import { DEFAULT_CLARIFY_STALL_LIMIT } from "./clarify-stall";
import { readActiveJobContext } from "./config-overlay";

export type { ClarifyEntryCtx, ClarifyEntryDeps, ClarifyDocState } from "./clarify-state";

/**
 * Consecutive `needs-clarify` rounds after which clarify is frozen as
 * "the requirement itself is unclear" (Q6/Q7: two failed assessments in a row
 * mean the document, not the round, is the problem).
 */
export const CLARIFY_NEEDS_CLARIFY_LIMIT = 2;

/**
 * Run ONE unattended clarify round for the active auto job.
 *
 * @returns TRUE when the caller must stop its normal settle handling (the round
 *   was dispatched, coalesced or froze); FALSE when it may continue (a completed
 *   clarify, an unbound/foreign doc, or a dispatch that never happened).
 */
export async function runAutoClarifyRound(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  deps: ClarifyEntryDeps = DEFAULT_CLARIFY_DEPS,
): Promise<boolean> {
  if (meta.currentStage !== "clarify") return false;
  const active = readActiveJobContext(config.projectRoot);
  if (!active || active.state.status !== "running") return false;
  const { state, job } = active;
  const doc = meta.requirementDoc;
  if (!doc) return false;
  const progress = state.docs[state.docIndex];
  // The running doc must be the one this session is clarifying; otherwise the
  // sidecar counters would be attributed to the wrong document.
  if (!progress || progress.doc !== doc) return false;

  const now = Date.now();
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

  const docState: ClarifyDocState = {
    doc,
    docText,
    progress,
    decision,
    assessmentVerdict: assessment?.verdict ?? "unknown",
    grew: (docText?.length ?? 0) > previousDocLength,
  };

  switch (decision.action) {
    case "not-auto":
      return false;
    case "confirmed":
      // Clarify is finished: refund the per-doc counters and let the normal
      // settle flow verify/advance (the marker is on disk).
      resetClarifyCounters(progress, now);
      state.updatedAt = now;
      await persistClarifyState(config, state);
      await auditAutoDecision(config, {
        gate: "clarify_confirmed",
        decision: "confirmed",
        round: String(decision.round),
      });
      return false;
    case "stalled":
      return freezeClarify(ctx, config, meta, "clarify_stalled", decision, deps);
    case "requirement-unclear":
      return freezeClarify(ctx, config, meta, "clarify_requirement_unclear", decision, deps);
    case "budget-exhausted":
      return handleClarifyBudgetExhausted(ctx, config, meta, state, job, docState, deps);
    default: {
      // fresh / await-answer / spawn-full-und
      if (decision.coalesced) {
        // ② Same round inside the dedupe window: one visit produces many
        // settles, one dispatch. Consumed — never a human-facing hint.
        await auditAutoDecision(config, {
          gate: "clarify_dispatch",
          decision: "coalesced",
          reason: decision.reason,
          round: String(decision.round),
          coalesced: true,
        });
        return true;
      }
      // A real dispatch consumes the settle; a FAILED one re-counted the stall
      // and returns FALSE so the ordinary settle flow still runs (B1).
      return dispatchClarifyRound(ctx, config, meta, state, job, docState, deps);
    }
  }
}
