/**
 * @module auto-pipeline/clarify-dispatch-failure
 * 226 Phase 2 (D 新模块): the ONE failure-accounting module for clarify
 * dispatch failures, shared by all three channels (settle / startup / resume).
 *
 * Facts:
 * - One failed dispatch = exactly ONE stall: the stall observation belongs to
 *   SUCCESSFUL rounds (`clarify-round-dispatch.ts`), so the failure path keeps
 *   its own counter here. This is the fix for the 226 review #5 off-by-one:
 *   the trajectory is strictly 1 → 2 → 3.
 * - Budget: the round reservation was refunded by `dispatchClarifyRound`
 *   (`clarify_round_refund`); this module never touches `clarifyRounds`.
 * - Above `DEFAULT_CLARIFY_STALL_LIMIT` the document is TERMINATED with
 *   `clarify_dispatch_failed`; below the limit the document freezes and the
 *   job's `freezePolicy` (default resume) re-triggers the round — freeze is
 *   the retry TRIGGER, the stall limit is the cap.
 * - `finalize` is imported DYNAMICALLY: `finalize.ts` imports this module
 *   graph transitively, and the other auto-pipeline modules use the same
 *   guard (clarify-autopilot / freeze-autopilot) — no load-time cycle.
 * - `deferred` is NOT a failure: it never reaches this module.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { DEFAULT_CLARIFY_STALL_LIMIT } from "./clarify-stall";
import { isClarifyStalled } from "./clarify-stall";
import { freezeClarify, type ClarifyEntryCtx, type ClarifyEntryDeps, type ClarifyDocState } from "./clarify-state";
import { DEFAULT_CLARIFY_DEPS, buildClarifyDocState } from "./clarify-state";
import { auditAutoDecision } from "./auto-audit";
import { readActiveJobContext, } from "./config-overlay";
import { docsDirsOf } from "../../docs-paths";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobState } from "./job-state";
import { persistClarifyState } from "./clarify-state";

/** One failed dispatch = exactly ONE stall (the observation is written only on success). */
export async function noteClarifyDispatchFailure(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  state: AutoJobState,
  job: AutoJobConfig,
  docState: ClarifyDocState,
  deps: ClarifyEntryDeps,
  input: { channel: "settle" | "startup" | "resume"; docIndex?: number },
): Promise<true> {
  const index = input.docIndex ?? state.docIndex;
  const progress = state.docs[index];
  if (progress) {
    progress.clarifyStalls = (progress.clarifyStalls ?? 0) + 1;
    progress.updatedAt = Date.now();
    state.updatedAt = progress.updatedAt;
    await persistClarifyState(config, state);
  }
  await auditAutoDecision(config, {
    gate: "clarify_dispatch_failed",
    decision: docState.decision.action,
    reason: "not_spawned",
    channel: input.channel,
    round: String(docState.decision.round),
  }, "warn");

  if (isClarifyStalled({ stalls: progress?.clarifyStalls ?? 0 }, DEFAULT_CLARIFY_STALL_LIMIT)) {
    // Dynamic import: finalize imports this module graph transitively; the other
    // auto-pipeline modules use the same guard (clarify-autopilot / freeze-autopilot).
    const { handleDocFailure } = await import("./finalize");
    await handleDocFailure(ctx as never, config, state, job, {
      outcome: "failed",
      reason: "clarify_dispatch_failed",
      docIndex: index,
    });
    return true;
  }
  // Auto resumes this freeze through freezePolicy (default resume) — freeze is the
  // retry TRIGGER; the per-doc stall limit is the cap.
  await freezeClarify(ctx, config, meta, "clarify_dispatch_failed", docState.decision, deps);
  return true;
}

/**
 * startup/resume channel: resolve the ACTIVE doc by index, rebuild the SAME
 * doc state the settle side would have used, then share the accounting above.
 * `docIndex` is REQUIRED semantics: without it the startup's lagging
 * `state.docIndex` would silently charge the PREVIOUS document (226 B-#4).
 *
 * `deps` (optional): injection for tests, exactly like `ClarifyEntryDeps`
 * everywhere else. Production callers omit it and get `DEFAULT_CLARIFY_DEPS`.
 */
export async function noteClarifyStartupChannelFailure(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  input: { channel: "startup" | "resume"; docIndex?: number },
  deps: ClarifyEntryDeps = DEFAULT_CLARIFY_DEPS,
): Promise<boolean> {
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active || active.state.status !== "running") return false;
  const doc = meta.requirementDoc;
  if (!doc) return false;
  const docState = await buildClarifyDocState({
    config, state: active.state, job: active.job, doc,
    ...(input.docIndex !== undefined ? { docIndex: input.docIndex } : {}),
    now: Date.now(),
  });
  if (!docState) return false;
  await noteClarifyDispatchFailure(ctx, config, meta, active.state, active.job, docState, deps, input);
  return true;
}
