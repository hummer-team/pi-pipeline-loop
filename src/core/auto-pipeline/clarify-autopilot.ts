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
import { dispatchClarifyRound } from "./clarify-round-dispatch";
import {
  FORCED_FULL_UND_ARGS,
  persistClarifyState,
  type ClarifyDocState,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "./clarify-state";

/** The clarify plan for the currently executing doc. */
export interface ClarifyAutoPlan {
  /** Args appended to the clarify mention (`<doc> <args>`). */
  args: string;
  /** Round number that args refer to (charged to the per-doc budget). */
  round: number;
  /** Instruction appended after the mention (the `extraArgs` channel). */
  instruction: string;
  /** Job-level round cap (`clarify.maxRounds`). */
  maxRounds: number;
}

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
 */
export function buildClarifyAutoPlan(config: PipelineConfig): ClarifyAutoPlan | null {
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active || active.state.status !== "running") return null;
  return {
    args: "1",
    round: 1,
    instruction: buildClarifyInstruction(active.job, resolveClarifyPromptMarkers(config)),
    maxRounds: active.job.clarify.maxRounds,
  };
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
 */
export async function handleClarifyBudgetExhausted(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  state: AutoJobState,
  job: AutoJobConfig,
  docState: ClarifyDocState,
  deps: ClarifyEntryDeps,
): Promise<boolean> {
  const { decision } = docState;
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

  const allowed = noteClarifyFallbackUsed({ state, docIndex: state.docIndex });
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
    });
  }
  return true;
}
