/**
 * @module auto-pipeline/clarify-round-dispatch
 * 220 Phase 3 (D1): sidecar accounting + the real dispatch of one clarify round.
 *
 * Three idempotence layers, none replaceable by another:
 * ① the `spawnedStages` guard in `subagent-rpc` rejects a second spawn of the
 *   SAME visit — cleared here on purpose, so it protects ordinary paths but
 *   never blocks an auto round;
 * ② `CLARIFY_DISPATCH_DEDUPE_MS` (30s) absorbs the burst of settles one visit
 *   can produce for an unchanged round;
 * ③ `noteClarifyRoundDispatch` counts EVERY real dispatch of the round (226
 *   Phase 2: no rewind protection, no refund on a re-dispatched round).
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import { resolveClarifyDescription } from "../../utils/clarify-args";
import { auditAutoDecision } from "./auto-audit";
import { noteClarifyFallbackUsed } from "./clarify-autopilot";
import type { ResolvedClarifyAnchors } from "./clarify-anchors";
import type { ClarifyDispatchDecision } from "./clarify-dispatch";
import {
  buildProtocolDirective,
  parseClarifyQuestionCount,
  parseDecisionLedger,
  parseRequirementAssessment,
} from "./clarify-protocol";
import { stampClarifyRoundDispatch } from "./clarify-round-budget";
import { nextClarifyStallState } from "./clarify-stall";
import {
  FORCED_FULL_UND_ARGS,
  persistClarifyState,
  type ClarifyDocState,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "./clarify-state";
import { handleDocFailure } from "./finalize";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobState } from "./job-state";

/**
 * Round args first, protocol directive second: the args channel is positional,
 * the directive is prose (`subagent-rpc` appends `extraArgs` to the prompt).
 */
function composeExtraArgs(
  decision: ClarifyDispatchDecision,
  docText: string | null,
  tier: AutoJobConfig["tier"],
  anchors: ResolvedClarifyAnchors,
  baseArgsOverride?: string,
): { extraArgs: string; protocolApplied: boolean } {
  const baseArgs = baseArgsOverride ?? decision.extraArgs ?? "";
  if (docText === null) return { extraArgs: baseArgs, protocolApplied: false };
  const directive = buildProtocolDirective(
    {
      assessment: parseRequirementAssessment(docText, anchors),
      ledger: parseDecisionLedger(docText, anchors),
      questionCount: parseClarifyQuestionCount(docText, anchors),
      tier,
    },
    anchors,
  );
  return directive
    ? { extraArgs: `${baseArgs}\n\n${directive}`, protocolApplied: true }
    : { extraArgs: baseArgs, protocolApplied: false };
}

/** Clear the same-visit spawn guard so the auto round really dispatches (B1). */
function clearClarifySpawnGuards(ctx: ClarifyEntryCtx, meta: SessionMeta): void {
  const clarify: PipelineStage = "clarify";
  ctx.session.updateMeta({
    spawnedStages: { ...(meta.spawnedStages ?? {}), [clarify]: undefined },
    activeSpawns: { ...(meta.activeSpawns ?? {}), [clarify]: undefined },
  });
}

/**
 * 226 Phase 2: outcome of one dispatch attempt.
 * `spawned` — the subagent really spawned (round counted);
 * `deferred` — a live same-agent twin postponed the spawn (pendingSpawns
 *   dispatches the SAME round later): NOT a failure, NOT a stall, but its
 *   reservation is COMMITTED (the round is counted exactly once here);
 * `not_spawned` — nothing was sent: the reservation is refunded and the
 *   caller routes the failure through `noteClarifyDispatchFailure`.
 */
export type ClarifyDispatchOutcome = "spawned" | "deferred" | "not_spawned";

/**
 * Dispatch one clarify subagent through the EXISTING `extraArgs` channel.
 *
 * 226 Phase 2 accounting: the round is RESERVED before the dispatch (a crash
 * can never refund it) and refunded with exactly ONE extra write when nothing
 * was sent (`not_spawned`). A `deferred` round keeps its reservation because
 * `pendingSpawns` dispatches that same round; the stall observation and the
 * needs-clarify streak are written ONLY after a real spawn — a failed dispatch
 * never fabricates progress evidence.
 *
 * @returns the three-state outcome (see `ClarifyDispatchOutcome`).
 */
export async function dispatchClarifyRound(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  state: AutoJobState,
  job: AutoJobConfig,
  docState: ClarifyDocState,
  deps: ClarifyEntryDeps,
  extraArgsOverride?: string,
  finalisationInstruction?: string,
): Promise<ClarifyDispatchOutcome> {
  const { decision, doc, docText, progress } = docState;
  const now = Date.now();
  const composed = composeExtraArgs(decision, docText, job.tier, docState.anchors, extraArgsOverride);
  const baseArgs = composed.extraArgs;
  const extraArgs = finalisationInstruction ? `${baseArgs}\n\n${finalisationInstruction}` : baseArgs;
  if (composed.protocolApplied) {
    await auditAutoDecision(config, {
      gate: "clarify_protocol",
      decision: decision.action,
      round: String(decision.round),
    });
  }

  // Account snapshot for the ONE-write refund on a failed dispatch (226 P2).
  const beforeAccount = {
    clarifyRounds: progress.clarifyRounds,
    clarifyLastRound: progress.clarifyLastRound,
    clarifyDispatchedAt: progress.clarifyDispatchedAt,
  };
  // Stall observation is computed BEFORE, folded in ONLY on success so a
  // failure never writes a "no progress" observation for its own mistake
  // (226 review #5: the observation is a success-side accounting entry).
  const previousStall = progress.clarifyStallSignature === undefined
    ? undefined
    : {
        stalls: progress.clarifyStalls ?? 0,
        signature: progress.clarifyStallSignature,
        docLength: progress.clarifyStallDocLength ?? 0,
      };

  // ③ Monotonic round stamp — written BEFORE the dispatch so a crash can never
  // refund a round. `clarifyDispatchedAt` follows every dispatch (dedupe ②).
  stampClarifyRoundDispatch(progress, decision.round, now);
  progress.updatedAt = now;
  state.updatedAt = now;
  await persistClarifyState(config, state);

  // ① The auto round owns its dispatch: clear the visit guard first.
  clearClarifySpawnGuards(ctx, meta);
  const notify = ctx.ui?.notify;
  const spawned = await deps.spawn(
    (ctx as { pi?: unknown }).pi,
    config,
    "clarify",
    ctx.session.getMeta() ?? meta,
    {
      ...(notify ? { ui: { notify: (msg: string): void => notify(msg) } } : {}),
      session: ctx.session,
      runtimeCtx: ctx,
      description: resolveClarifyDescription(doc, decision.extraArgs).description,
      extraArgs,
    },
  );

  if (spawned.deferred) {
    // 226 review #2: a live same-agent twin postponed the spawn; the owner
    // consumes `pendingSpawns` on its next settle and dispatches the SAME round.
    // The reservation is therefore COMMITTED, never refunded: charging the round
    // exactly once here keeps `maxRounds` a real dispatch budget (the dequeue
    // side never charges again) and keeps the guide's "deferred only emits
    // `clarify_dispatch_deferred`" contract true. The finalisation fact is bound
    // to this committed round too, so the next settle defers to the marker gate
    // instead of dispatching `full-und?` a second time.
    if (decision.action === "spawn-full-und") progress.clarifyFinalisationRound = decision.round;
    progress.updatedAt = Date.now();
    state.updatedAt = progress.updatedAt;
    await persistClarifyState(config, state);
    return "deferred";
  }

  if (!spawned.spawned) {
    // Roll back the reservation (budget / round / dedupe) — exactly ONE extra
    // write; then report the outcome. The failure ACCOUNTING (stall++, freeze
    // or terminal) is the caller's job (`noteClarifyDispatchFailure`).
    progress.clarifyRounds = beforeAccount.clarifyRounds;
    progress.clarifyLastRound = beforeAccount.clarifyLastRound;
    progress.clarifyDispatchedAt = beforeAccount.clarifyDispatchedAt;
    progress.updatedAt = Date.now();
    state.updatedAt = progress.updatedAt;
    await persistClarifyState(config, state);
    await auditAutoDecision(config, {
      gate: "clarify_round_refund",
      decision: decision.action,
      reason: "reservation_refunded",
      round: String(decision.round),
    });
    return "not_spawned";
  }

  // Success side: stall observation (single write point).
  const observation = nextClarifyStallState(previousStall, {
    signature: `${decision.action}:${docState.assessmentVerdict}:${decision.round}`,
    docLength: docText?.length ?? 0,
  });
  progress.clarifyStalls = observation.stalls;
  progress.clarifyStallSignature = observation.signature;
  progress.clarifyStallDocLength = observation.docLength;
  // 226 Phase 1: the finalisation fact is bound to a REAL dispatch only.
  if (decision.action === "spawn-full-und") progress.clarifyFinalisationRound = decision.round;

  // Streak: consecutive rounds still needing clarification AND not growing.
  const nextStreak = docState.assessmentVerdict === "needs-clarify" && !docState.grew
    ? (progress.clarifyNeedsClarifyStreak ?? 0) + 1
    : 0;
  progress.clarifyNeedsClarifyStreak = nextStreak > 0 ? nextStreak : undefined;
  progress.updatedAt = Date.now();
  state.updatedAt = progress.updatedAt;
  await persistClarifyState(config, state);
  await auditAutoDecision(config, {
    gate: "clarify_dispatch",
    decision: decision.action,
    reason: decision.reason,
    round: String(decision.round),
    coalesced: decision.coalesced,
  });
  return "spawned";
}

