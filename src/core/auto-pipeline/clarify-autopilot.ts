/**
 * @module auto-pipeline/clarify-autopilot
 * 219 Phase 3 G1 + 220 Phase 0/2 (D1): clarify self-answer without a human.
 *
 * Facts:
 * - v1 has exactly ONE strategy (`self-answer`); the 219-era `orchestrated`
 *   mode is gone (a job file that still sets `clarify.mode` is rejected).
 * - The instruction ONLY asks the agent to write `答：` answers. It never asks
 *   the agent to run `full-und?` and never asks it to write `## 模型确认`:
 *   the marker is written by the clarify round dispatched with `full-und?`
 *   (`clarify-entry.ts`), so "who writes the marker" has a single answer.
 * - The instruction rides the EXISTING `extraArgs` channel
 *   (`prompt += extraArgs` in `subagent-rpc`), appended after the mention —
 *   no new dispatch parameter and no new subagent API.
 * - A missing answer marker is routed by `clarify.onExhausted`
 *   (`stop` → freeze + doc failure; `self-confirm` → one forced
 *   `full-und?` dispatch recorded as `clarifyFallbackUsed`).
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { docsDirsOf } from "../../docs-paths";
import { DEFAULT_COMPLETION_MARKERS } from "../../constants";
import { DEFAULT_CLARIFY_PROTOCOL } from "./clarify-anchors";
import {
  resolveClarifyPromptMarkers,
  type ClarifyPromptMarkers,
} from "./clarify-prompt-markers";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobState } from "./job-state";
import { readActiveJobContext } from "./config-overlay";
import { auditAutoDecision } from "./auto-audit";
import { auditAutoDiagnostic } from "./diagnostics";
import { dispatchClarifyRound } from "./clarify-round-dispatch";
import {
  FORCED_FULL_UND_ARGS,
  buildClarifyDocState,
  persistClarifyState,
  type ClarifyDocState,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "./clarify-state";

/**
 * The clarify plan for the currently executing doc.
 *
 * 223 Phase 1: a discriminated union. The startup seam no longer hard-codes
 * `fresh(1)` — it reuses the SAME shared decision layer
 * (`buildClarifyDocState` / `decideClarifyDispatch`)
 * the settle side uses, so re-starting the pipeline derives the round from the
 * document state and respects `clarify.maxRounds`.
 *
 * 223 review issue 13: only the UNION is exported — the individual variants are
 * an implementation detail of `buildClarifyAutoPlan`, so their export surface
 * cannot drift into a second source of truth.
 */
interface ClarifyAutoPlanBase {
  /** Round number that args refer to (charged to the per-doc budget). */
  round: number;
  /** Job-level round cap (`clarify.maxRounds`). */
  maxRounds: number;
}

/** A real dispatch of the clarify mention with the given args/instruction. */
interface ClarifyAutoDispatchPlan extends ClarifyAutoPlanBase {
  kind: "dispatch";
  action: "fresh" | "await-answer" | "continue" | "spawn-full-und";
  /**
   * Args appended to the clarify mention. NO leading space: the launch path
   * joins `` `${file} ${effectiveArgs}` `` and provides the separator itself
   * (only the settle-side `subagentRpc` concatenation needs a leading space).
   */
  args: string;
  /** Instruction appended after the mention (the `extraArgs` channel). */
  instruction: string;
}

/** The document already carries `## 模型确认`; nothing needs to be spawned. */
interface ClarifyAutoConfirmedPlan extends ClarifyAutoPlanBase {
  kind: "confirmed";
}

/** A gate stopped the startup dispatch (budget/stall/unclear requirement). */
interface ClarifyAutoBlockedPlan extends ClarifyAutoPlanBase {
  kind: "blocked";
  action: "budget-exhausted" | "stalled" | "requirement-unclear";
}

/** 226 Phase 1: the finalisation round is already dispatched; the document now owns the marker. */
interface ClarifyAutoMarkerPendingPlan extends ClarifyAutoPlanBase {
  kind: "marker-pending";
}

export type ClarifyAutoPlan =
  | ClarifyAutoDispatchPlan
  | ClarifyAutoConfirmedPlan
  | ClarifyAutoBlockedPlan
  | ClarifyAutoMarkerPendingPlan;

// 221 Phase 1: the resolver lives in `clarify-prompt-markers.ts` (dependency
// leaf shared with `prompt-injector` / `verify-generator`); re-exported here so
// existing call sites and tests keep a single import site.
export { resolveClarifyPromptMarkers };
export type { ClarifyPromptMarkers };

/**
 * Build the self-answer instruction.
 *
 * The agent answers the open questions in the document; finalisation
 * (`full-und?` + completion marker) is dispatched separately, so a single
 * clarify turn has exactly one responsibility.
 */
export function buildClarifyInstruction(
  job: AutoJobConfig,
  markers: Pick<ClarifyPromptMarkers, "answerMarker"> = {
    answerMarker: DEFAULT_CLARIFY_PROTOCOL.answerMarkers[0]!,
  },
): string {
  const maxRounds = job.clarify.maxRounds;
  return (
    `[auto-pipeline] This run is unattended — no human will answer. ` +
    `Work through the clarification rounds yourself (at most ${maxRounds}). ` +
    "For every open question pick the recommended option and write it into the requirement " +
    `document as \`${markers.answerMarker}<answer>\` with a one-line reason. ` +
    "Do not write the completion marker and do not run the finalisation flow: " +
    "the plugin dispatches that round itself once the answers are on disk."
  );
}

/**
 * Build the clarify plan for the active auto job, or `null` when this process
 * is not an auto runner (human mode keeps its unchanged derivation).
 *
 * 223 Phase 1: derives the plan from the SHARED decision layer
 * (`buildClarifyDocState` → `decideClarifyDispatch`) instead of returning a
 * constant `fresh(1)`, so a re-started pipeline reads the document's four
 * states and stays under `clarify.maxRounds`.
 *
 * Document attribution lives HERE: while a doc is being (re-)started,
 * `state.docIndex` still points at the PREVIOUS (completed) doc — it only
 * advances after `startNewPipeline` returns (`pipeline-auto.ts` M2). The
 * explicit `docIndex` is handed down so the inner guard resolves the right
 * progress entry. `null` (an unknown/foreign doc) falls back to the
 * fresh(1) plan, which is equivalent to the pre-223 behavior.
 */
export async function buildClarifyAutoPlan(
  config: PipelineConfig,
  doc: string,
): Promise<ClarifyAutoPlan | null> {
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active || active.state.status !== "running") return null;

  const markers = resolveClarifyPromptMarkers(config);
  const maxRounds = active.job.clarify.maxRounds;
  const freshPlan = (round: number): ClarifyAutoDispatchPlan => ({
    kind: "dispatch",
    action: "fresh",
    args: "1",
    round,
    instruction: buildClarifyInstruction(active.job, markers),
    maxRounds,
  });

  const index = active.state.docs.findIndex((d) => d.doc === doc);
  const target = index >= 0 ? active.state.docs[index] : undefined;
  if (!target?.doc) {
    // Not this job's document → fall back to the HUMAN derivation (null) and
    // leave an explicit diagnostic so the unmatched startup is observable.
    auditAutoDiagnostic("clarify_startup_doc_unmatched", "Startup clarify derivation skipped: the document is not part of the active auto job.", {
      jobId: active.state.jobId,
      requirementDoc: doc,
    }, "warn");
    return null;
  }

  const docState = await buildClarifyDocState({
    config, state: active.state, job: active.job, doc: target.doc,
    docIndex: index, now: Date.now(),
  });
  if (!docState) return freshPlan(1);

  const { decision } = docState;
  switch (decision.action) {
    case "fresh":
      return freshPlan(decision.round);
    case "await-answer":
      return {
        kind: "dispatch",
        action: "await-answer",
        args: `${decision.round} 答`,
        round: decision.round,
        instruction: buildClarifyInstruction(active.job, markers),
        maxRounds,
      };
    case "continue":
      // 226 Phase 1: answers are on disk but the requirement is NOT `ready`
      // — keep the round loop going with the next ordinary round.
      return {
        kind: "dispatch",
        action: "continue",
        args: `${decision.round} 答`,
        round: decision.round,
        instruction: buildClarifyInstruction(active.job, markers),
        maxRounds,
      };
    case "await-finalisation":
      // 226 Phase 1: the finalisation round was already dispatched and the
      // marker is still pending — the document owns it now; nothing to spawn.
      return { kind: "marker-pending", round: decision.round, maxRounds };
    case "spawn-full-und":
      return {
        kind: "dispatch",
        action: "spawn-full-und",
        args: FORCED_FULL_UND_ARGS.trim(),
        round: decision.round,
        instruction: buildClarifyFinalisationInstruction(markers),
        maxRounds,
      };
    case "confirmed":
      return { kind: "confirmed", round: decision.round, maxRounds };
    case "budget-exhausted":
    case "stalled":
    case "requirement-unclear":
      return { kind: "blocked", action: decision.action, round: decision.round, maxRounds };
    default:
      // not-auto: not this job's doc / auto contract inactive → human derivation.
      return null;
  }
}

/**
 * Record that the document had to fall back to a plugin-forced finalisation.
 *
 * @returns TRUE when the flag was newly set (the caller then persists and
 *   performs the ONE forced `full-und?` dispatch), FALSE when it was already
 *   used (the caller routes the doc through `handleDocFailure`).
 */
export function noteClarifyFallbackUsed(input: {
  state: AutoJobState;
  docIndex: number;
  now?: number;
}): boolean {
  const doc = input.state.docs[input.docIndex];
  if (!doc || doc.clarifyFallbackUsed) return false;
  doc.clarifyFallbackUsed = true;
  doc.updatedAt = input.now ?? Date.now();
  input.state.updatedAt = doc.updatedAt;
  return true;
}

/**
 * Instruction for the forced finalisation round (`full-und?`) — the round the
 * plugin dispatches when `clarify.onExhausted: "self-confirm"` accepted a
 * fallback. It is the ONLY instruction that mentions the marker.
 */
export function buildClarifyFinalisationInstruction(
  markers: Pick<ClarifyPromptMarkers, "completionMarker"> = {
    completionMarker: DEFAULT_COMPLETION_MARKERS[0],
  },
): string {
  return (
    "[auto-pipeline] Finalise the clarification: run the full-und? flow and write the " +
    `completion marker (\`${markers.completionMarker}\`) with the confirmation line. Do not skip the marker.`
  );
}

/**
 * 220 Phase 3 (D6/Q4): the round budget is exhausted.
 *
 * - `onExhausted: "stop"` (default) → freeze with `clarify_budget_exhausted`;
 *   the job's `freezePolicy` owns what happens next (Q11 single escape hatch).
 * - `onExhausted: "self-confirm"` → force exactly ONE `full-und?` round, recorded
 *   as `clarifyFallbackUsed`; a second exhaustion fails the document with
 *   `clarify_marker_missing` instead of looping.
 *
 * `finalize` is imported lazily: `finalize.ts` imports THIS module, so a static
 * import would create a load-time cycle (same precedent as `freeze-autopilot`).
 *
 * 223 Phase 1 (optional `docIndex`, default `state.docIndex`): while the NEXT
 * document is being started, `state.docIndex` still points at the previous one;
 * the startup path passes the explicit index so fallback accounting and doc
 * failures land on the document that actually exhausted the budget.
 */
export async function handleClarifyBudgetExhausted(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  state: AutoJobState,
  job: AutoJobConfig,
  docState: ClarifyDocState,
  deps: ClarifyEntryDeps,
  docIndex?: number,
): Promise<boolean> {
  const { decision } = docState;
  const targetIndex = docIndex ?? state.docIndex;
  if (job.clarify.onExhausted !== "self-confirm") {
    await auditAutoDecision(config, {
      gate: "clarify_freeze",
      decision: decision.action,
      reason: "clarify_budget_exhausted",
      round: String(decision.round),
    });
    await deps.freeze(ctx as never, meta, "clarify_budget_exhausted", config, { ui: ctx.ui as never });
    return true;
  }

  const allowed = noteClarifyFallbackUsed({ state, docIndex: targetIndex });
  await auditAutoDecision(config, {
    gate: "clarify_fallback",
    decision: allowed ? "self_confirm" : "fail",
    reason: allowed ? "budget_exhausted_forced_full_und" : "budget_exhausted_fallback_used",
    round: String(decision.round),
  });
  await persistClarifyState(config, state);
  const { handleDocFailure } = await import("./finalize");
  if (!allowed) {
    // The one fallback round was already spent — fail honestly.
    await handleDocFailure(ctx as never, config, state, job, {
      outcome: "failed",
      reason: "clarify_marker_missing",
      docIndex: targetIndex,
    });
    return true;
  }

  const dispatched = await dispatchClarifyRound(
    ctx,
    config,
    meta,
    state,
    job,
    docState,
    deps,
    FORCED_FULL_UND_ARGS,
    buildClarifyFinalisationInstruction(resolveClarifyPromptMarkers(config)),
  );
  if (!dispatched) {
    await handleDocFailure(ctx as never, config, state, job, {
      outcome: "failed",
      reason: "clarify_marker_missing",
      docIndex: targetIndex,
    });
  }
  return true;
}
