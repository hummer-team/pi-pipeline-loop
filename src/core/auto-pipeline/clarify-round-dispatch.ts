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
 * ③ `noteClarifyRoundDispatch` (monotonic) keeps a rewound round from refunding
 *   or re-consuming budget.
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import { resolveClarifyDescription } from "../../utils/clarify-args";
import { auditAutoDecision } from "./auto-audit";
import {
  buildClarifyFinalisationInstruction,
  noteClarifyFallbackUsed,
} from "./clarify-autopilot";
import type { ClarifyDispatchDecision } from "./clarify-dispatch";
import {
  buildProtocolDirective,
  parseClarifyQuestionCount,
  parseDecisionLedger,
  parseRequirementAssessment,
} from "./clarify-protocol";
import { noteClarifyRoundDispatch } from "./clarify-round-budget";
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
function composeExtraArgs(decision: ClarifyDispatchDecision, docText: string | null, tier: AutoJobConfig["tier"]): string {
  const baseArgs = decision.extraArgs ?? "";
  if (docText === null) return baseArgs;
  const directive = buildProtocolDirective({
    assessment: parseRequirementAssessment(docText),
    ledger: parseDecisionLedger(docText),
    questionCount: parseClarifyQuestionCount(docText),
    tier,
  });
  return directive ? `${baseArgs}\n\n${directive}` : baseArgs;
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
 * Dispatch one clarify subagent through the EXISTING `extraArgs` channel.
 *
 * @returns TRUE when the subagent really spawned; FALSE otherwise (the caller
 *   keeps the failure visible instead of swallowing the settle).
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
): Promise<boolean> {
  const { decision, doc, docText, progress } = docState;
  const now = Date.now();
  const baseArgs = extraArgsOverride ?? composeExtraArgs(decision, docText, job.tier);
  const extraArgs = finalisationInstruction ? `${baseArgs}\n\n${finalisationInstruction}` : baseArgs;

  // ③ Monotonic round stamp — written BEFORE the dispatch so a crash can never
  // refund a round. `clarifyDispatchedAt` follows every dispatch (dedupe ②).
  const stamp = noteClarifyRoundDispatch(
    {
      usedRounds: progress.clarifyRounds ?? 0,
      lastRound: progress.clarifyLastRound,
      lastDispatchedAt: progress.clarifyDispatchedAt,
    },
    decision.round,
    now,
  );
  progress.clarifyRounds = stamp.usedRounds;
  progress.clarifyLastRound = stamp.lastRound;
  progress.clarifyDispatchedAt = now;

  // Stall observation (single write point): growth resets, no-growth counts.
  const previous = progress.clarifyStallSignature === undefined
    ? undefined
    : {
        stalls: progress.clarifyStalls ?? 0,
        signature: progress.clarifyStallSignature,
        docLength: progress.clarifyStallDocLength ?? 0,
      };
  const observation = nextClarifyStallState(previous, {
    signature: `${decision.action}:${docState.assessmentVerdict}:${decision.round}`,
    docLength: docText?.length ?? 0,
  });
  progress.clarifyStalls = observation.stalls;
  progress.clarifyStallSignature = observation.signature;
  progress.clarifyStallDocLength = observation.docLength;
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

  if (!spawned.spawned) {
    // A failed dispatch is NOT a silent stop (B1): count one stall, audit, then
    // hand control back so the ordinary settle flow still runs.
    progress.clarifyStalls = observation.stalls + 1;
    progress.updatedAt = Date.now();
    state.updatedAt = progress.updatedAt;
    await persistClarifyState(config, state);
    await auditAutoDecision(config, {
      gate: "clarify_dispatch_failed",
      decision: decision.action,
      reason: spawned.deferred ? "deferred" : "not_spawned",
      round: String(decision.round),
    }, "warn");
    return false;
  }

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
  return true;
}

