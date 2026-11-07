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
import type { RuntimeCtx } from "../runtime-ctx";
import { detectSessionRole } from "../session-role";
import { docsDirsOf } from "../../docs-paths";
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
import { noteClarifyDispatchFailure } from "./clarify-dispatch-failure";
import { handleClarifyBudgetExhausted } from "./clarify-autopilot";
import { readActiveJobContext } from "./config-overlay";

export type { ClarifyEntryCtx, ClarifyEntryDeps, ClarifyDocState } from "./clarify-state";
export { CLARIFY_NEEDS_CLARIFY_LIMIT } from "./clarify-state";

/**
 * Outcome of one unattended clarify round (226 Phase 1, three-state contract).
 *
 * - `consumed`: the settle is DONE — the round dispatched (or coalesced), froze
 *   or failed the document; the caller must stop its normal settle handling.
 * - `defer-to-marker`: the finalisation round was already dispatched and the
 *   completion marker is still missing; the caller SKIPS its await-answer
 *   precheck and hands the settle to the marker gate (`await-finalisation`).
 * - `pass-through`: nothing was routed (`not-auto`, unbound/foreign doc) or the
 *   document is `confirmed` — the caller continues its normal settle handling.
 */
export type AutoClarifyRoundOutcome = "consumed" | "defer-to-marker" | "pass-through";

/**
 * Run ONE unattended clarify round for the active auto job.
 *
 * @returns the three-state round outcome (see `AutoClarifyRoundOutcome`).
 */
export async function runAutoClarifyRound(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  deps: ClarifyEntryDeps = DEFAULT_CLARIFY_DEPS,
): Promise<AutoClarifyRoundOutcome> {
  if (meta.currentStage !== "clarify") return "pass-through";
  // Owner-only contract: a CHILD session never dispatches clarify rounds. The
  // same guard already exists in clarify-marker-miss.ts — this one removes the
  // "the round id happens to never match a child name" accident (223_Bug.md,
  // "incidental finding").
  if (detectSessionRole(ctx as unknown as RuntimeCtx).isChild) return "pass-through";
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active || active.state.status !== "running") return "pass-through";
  const { state, job } = active;
  const doc = meta.requirementDoc;
  if (!doc) return "pass-through";

  const now = Date.now();
  const docState = await buildClarifyDocState({ config, state, job, doc, now });
  if (!docState) return "pass-through";
  const { decision, progress } = docState;

  switch (decision.action) {
    case "not-auto":
      return "pass-through";
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
      return "pass-through";
    case "await-finalisation":
      // 226 Phase 1: the finalisation round was already dispatched but the
      // marker is not on disk — do NOT dispatch again; the caller skips its
      // await-answer precheck and the marker gate owns this settle.
      return "defer-to-marker";
    case "stalled":
      return (await freezeClarify(ctx, config, meta, "clarify_stalled", decision, deps))
        ? "consumed"
        : "pass-through";
    case "requirement-unclear":
      return (await freezeClarify(ctx, config, meta, "clarify_requirement_unclear", decision, deps))
        ? "consumed"
        : "pass-through";
    case "budget-exhausted":
      return (await handleClarifyBudgetExhausted(ctx, config, meta, state, job, docState, deps))
        ? "consumed"
        : "pass-through";
    default: {
      // fresh / await-answer / continue / spawn-full-und
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
        return "consumed";
      }
      // 226 Phase 2: the dispatch reports a THREE-state outcome. `spawned`
      // and `deferred` (a live same-agent twin owns the retry) both consume
      // the settle; a failed dispatch is routed through the shared failure
      // accounting (stall++, freeze or terminal) and ALSO consumes the
      // settle — the settle flow must not re-enter the same settle.
      const outcome = await dispatchClarifyRound(ctx, config, meta, state, job, docState, deps);
      if (outcome === "spawned") return "consumed";
      if (outcome === "deferred") {
        // A live same-agent twin exists; pendingSpawns + the 217 watchdog own the retry.
        await auditAutoDecision(config, {
          gate: "clarify_dispatch_deferred",
          decision: docState.decision.action,
          round: String(docState.decision.round),
        });
        return "consumed";
      }
      await noteClarifyDispatchFailure(ctx, config, meta, state, job, docState, deps, { channel: "settle" });
      return "consumed";
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
  /**
   * 223 Phase 1: index of `doc` in `state.docs` (defaults to
   * `state.docIndex`). Launching the NEXT document still has `docIndex`
   * pointing at the previous one; without the explicit index this round's
   * budget accounting would silently land on the wrong document.
   */
  docIndex?: number;
  round: number;
  now?: number;
}): Promise<void> {
  const active = readActiveJobContext(input.config.projectRoot, docsDirsOf(input.config).jobsDir);
  if (!active || active.state.status !== "running") return;
  const { state } = active;
  const progress = state.docs[input.docIndex ?? state.docIndex];
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
