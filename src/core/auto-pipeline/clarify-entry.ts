/**
 * @module auto-pipeline/clarify-entry
 * 220 Phase 3/4 (D1/D2/D3): the ONLY entry point of an unattended clarify round.
 *
 * Division of responsibility:
 * - `clarify-dispatch.ts` decides WHAT to do (pure);
 * - `clarify-round-budget.ts` / `clarify-stall.ts` own the two counters;
 * - `clarify-protocol.ts` owns the document protocol directive;
 * - `clarify-state.ts` owns the sidecar shape, the shared doc-state builder and
 *   the outcome helpers;
 * - `clarify-round-dispatch.ts` performs the accounting and the dispatch;
 * - THIS module routes one decision to its freeze/dispatch outcome and accounts
 *   the STARTUP round `/pipeline-start` dispatches.
 *
 * Human track: every branch is gated by the caller (`meta.autoJob`) and by an
 * ACTIVE job lock, so a session without an auto job never reaches this module.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { auditAutoDecision } from "./auto-audit";
import { stampClarifyRoundDispatch } from "./clarify-round-budget";
import {
  buildClarifyDocState,
  DEFAULT_CLARIFY_DEPS,
  freezeClarify,
  persistClarifyState,
  resetClarifyCounters,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "./clarify-state";
import { dispatchClarifyRound } from "./clarify-round-dispatch";
import { handleClarifyBudgetExhausted } from "./clarify-autopilot";
import { readActiveJobContext } from "./config-overlay";

export type { ClarifyEntryCtx, ClarifyEntryDeps, ClarifyDocState } from "./clarify-state";
export { CLARIFY_NEEDS_CLARIFY_LIMIT } from "./clarify-state";

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

  const now = Date.now();
  const docState = await buildClarifyDocState({ config, state, job, doc, now });
  if (!docState) return false;
  const { decision, progress } = docState;

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

/**
 * 220 D6: account the STARTUP clarify round that `/pipeline-start` dispatched.
 *
 * `maxRounds` is the TOTAL allowance, so the round that opened the stage must
 * be charged like every later round; otherwise the settle-side budget grants
 * one extra dispatch (`maxRounds + 1`).
 *
 * Called only AFTER a startup dispatch really happened. A missing/foreign
 * sidecar doc is never charged (counters are per document). A user-supplied
 * `forwardArgs` override is a human intervention — the job does not own that
 * round, so it is not charged either (the caller passes no plan).
 */
export async function noteClarifyStartupDispatch(input: {
  config: PipelineConfig;
  doc: string;
  round: number;
  now?: number;
}): Promise<void> {
  const active = readActiveJobContext(input.config.projectRoot);
  if (!active || active.state.status !== "running") return;
  const { state } = active;
  const progress = state.docs[state.docIndex];
  if (!progress || progress.doc !== input.doc) return;

  const now = input.now ?? Date.now();
  stampClarifyRoundDispatch(progress, input.round, now);
  progress.updatedAt = now;
  state.updatedAt = now;
  await persistClarifyState(input.config, state);
  await auditAutoDecision(input.config, {
    gate: "clarify_dispatch",
    decision: "fresh",
    reason: "clarify_startup_round",
    round: String(input.round),
  });
}
