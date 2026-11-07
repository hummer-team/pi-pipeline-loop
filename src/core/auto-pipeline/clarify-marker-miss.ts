/**
 * @module auto-pipeline/clarify-marker-miss
 * 220 Phase 0 (D1): the settle-side "clarify completion marker is missing" seam.
 *
 * Facts:
 * - The autopilot never writes the marker and never degrades to `orchestrated`
 *   (the value is rejected at parse time by `job-schema`). A missing marker is
 *   routed by `clarify.onExhausted`:
 *   - `stop` (default) → doc failure (`clarify_marker_missing`);
 *   - `self-confirm` → ONE forced `full-und?` round, recorded as
 *     `clarifyFallbackUsed`; a second miss is a doc failure.
 * - The forced round goes through `dispatchClarifyRound` — the SAME channel as
 *   every other auto round (Phase 3 task 3: one dispatch implementation), so it
 *   is counted against the round budget, clears the same-visit spawn guard and
 *   carries the protocol directive. A failed dispatch is a doc failure, never a
 *   silent stop (B1).
 * - Called ONLY where the pipeline already knows the marker is missing (the
 *   settle completion-marker precheck), so a legitimate in-flight clarify turn
 *   is never mistaken for a failure.
 *
 * Kept out of `settle-seam.ts` so the settle transaction module stays inside the
 * 200-line budget and the clarify decision owns its own failure handling.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { docsDirsOf } from "../../docs-paths";
import type { RuntimeCtx } from "../runtime-ctx";
import { detectSessionRole } from "../session-role";
import { writeJobState } from "./job-state";
import { readActiveJobContext } from "./config-overlay";
import type { FinalizeCtx } from "./finalize";
import { handleDocFailure } from "./finalize";
import {
  buildClarifyFinalisationInstruction,
  noteClarifyFallbackUsed,
  resolveClarifyPromptMarkers,
} from "./clarify-autopilot";
import { dispatchClarifyRound } from "./clarify-round-dispatch";
import { noteClarifyDispatchFailure } from "./clarify-dispatch-failure";
import {
  buildClarifyDocState,
  DEFAULT_CLARIFY_DEPS,
  FORCED_FULL_UND_ARGS,
  type ClarifyEntryDeps,
} from "./clarify-state";
import { auditAutoDecision } from "./auto-audit";
import { auditAutoDiagnostic } from "./diagnostics";

/**
 * Route a missing clarify completion marker.
 *
 * @returns TRUE when the caller must stop its normal settle handling.
 */
export async function handleAutoClarifyMarkerMiss(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  deps: ClarifyEntryDeps = DEFAULT_CLARIFY_DEPS,
): Promise<boolean> {
  if (meta.currentStage !== "clarify") return false;
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active || active.state.status !== "running") return false;
  if (detectSessionRole(ctx as unknown as RuntimeCtx).isChild) return false;

  const { state, job } = active;
  const doc = meta.requirementDoc;
  const docState = doc ? await buildClarifyDocState({ config, state, job, doc, now: Date.now() }) : null;
  // A foreign/unbound doc is not this seam's document: leave the settle flow
  // untouched instead of charging the auto job's counters.
  if (!docState) return false;

  const canFallback =
    job.clarify.onExhausted === "self-confirm" && noteClarifyFallbackUsed({ state, docIndex: state.docIndex });

  await auditAutoDecision(config, {
    gate: "clarify_completion_marker",
    decision: canFallback ? "self_confirm" : "fail",
    reason: canFallback ? "marker_missing_forced_full_und" : "marker_missing",
  });

  if (!canFallback) {
    // Second miss (or `onExhausted: "stop"`) → doc failure (unified path).
    await handleDocFailure(ctx, config, state, job, {
      outcome: "failed",
      reason: "clarify_marker_missing",
    });
    return true;
  }

  try {
    await writeJobState(config.projectRoot, state);
  } catch (err) {
    auditAutoDiagnostic("clarify_fallback_persist_failed", "Auto-job clarify fallback could not be persisted.", {
      jobId: state.jobId,
      error: String(err),
    }, "error");
  }
  // Forced finalisation round — the only place where the plugin asks for the
  // marker itself.
  const outcome = await dispatchClarifyRound(
    ctx as never,
    config,
    meta,
    state,
    job,
    docState,
    deps,
    FORCED_FULL_UND_ARGS,
    buildClarifyFinalisationInstruction(resolveClarifyPromptMarkers(config)),
  );
  if (outcome === "deferred") {
    // 226 Phase 2: a live same-agent twin owns the spawn — pendingSpawns will
    // execute it, so the fallback round counts as dispatched (no second miss).
    ctx.ui?.notify?.(
      `Auto job "${state.jobId}": clarify answers are missing — one finalisation round is pending for ${doc ?? "the requirement doc"}.`,
    );
    return true;
  }
  if (outcome === "not_spawned") {
    // 226 Phase 2 (review B-#6): the forced round NEVER launched, so the
    // fallback was NOT really used — reset the flag and share the SAME
    // failure accounting (stall++, freeze or terminal), with the settle
    // channel. A doc failure with `clarify_marker_missing` here was a lie.
    const progress = state.docs[state.docIndex];
    if (progress) {
      progress.clarifyFallbackUsed = undefined;
      progress.updatedAt = Date.now();
      state.updatedAt = progress.updatedAt;
      await writeJobState(config.projectRoot, state);
    }
    await auditAutoDecision(config, {
      gate: "clarify_fallback",
      decision: "reset",
      reason: "forced_round_never_dispatched",
      round: String(docState.decision.round),
    });
    await noteClarifyDispatchFailure(
      ctx as never,
      config,
      meta,
      state,
      job,
      docState,
      deps,
      { channel: "settle" },
    );
    return true;
  }

  ctx.ui?.notify?.(
    `Auto job "${state.jobId}": clarify answers are missing — forcing one finalisation round for ${doc ?? "the requirement doc"}.`,
  );
  return true;
}
