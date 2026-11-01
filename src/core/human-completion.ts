/**
 * @module human-completion
 * 221 Phase 2: release the session-level resources when a HUMAN pipeline
 * reaches the terminal `completed` stage.
 *
 * Facts:
 * - `completed` is still the terminal state: this helper never writes
 *   `flowState` / `terminateReason`, and `/pipeline-status` keeps showing
 *   `completed`.
 * - The release itself is the SHARED implementation (`releaseSessionResources`,
 *   the same one `/pipeline-quit` and every auto termination use) — authorisation,
 *   executor binding, allowlists, verify counters, approval queue and the TUI
 *   stage bar are cleared in one place.
 * - Auto jobs are excluded (INV-2): their documents are finalized by
 *   `finalizeCurrentDoc`, never by this helper.
 * - Idempotent by a ONE-SHOT meta stamp written BEFORE the release, so a
 *   concurrent settle/tool-advance cannot release twice.
 * - Every API call is guarded/fail-open: a release failure is audited and
 *   notified, never thrown into the caller.
 */

import type { PipelineConfig } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import type { FinalizeCtx } from "./auto-pipeline/finalize";
import { isAutoJobActive } from "./auto-pipeline/config-overlay";
import { releaseSessionResources } from "./auto-pipeline/cleanup";
import { safeWriteAuditLog } from "../utils/auditLog";

/**
 * Release session resources once for a human-completed pipeline.
 *
 * @returns TRUE when this call performed the cleanup; FALSE when the pipeline
 *   is not completed, the cleanup already ran, or an auto job owns the session.
 */
export async function finalizeHumanPipelineCompletion(
  ctx: FinalizeCtx,
  config: PipelineConfig,
): Promise<boolean> {
  const meta = ctx.session.getMeta();
  if (!meta || meta.currentStage !== "completed") return false;
  if (meta.terminalCleanupAt !== undefined) return false;
  // INV-2: auto documents complete through `finalizeCurrentDoc`.
  if (meta.autoJob !== undefined || isAutoJobActive()) return false;

  // Stamp FIRST: a second entry (settle + tool advance, or two settles) must
  // see the marker even if the release below is still running.
  ctx.session.updateMeta({ terminalCleanupAt: Date.now() });

  const release = await releaseSessionResources(ctx as unknown as RuntimeCtx, config, {
    reason: "human_completed",
  });
  ctx.ui?.notify?.(
    "Pipeline completed. Run /pipeline-start <doc> to start a new round.",
    release.criticalFailed ? "warning" : "info",
  );
  await safeWriteAuditLog(
    "pipeline_human_cleanup",
    {
      pipelineId: meta.pipelineId ?? "",
      stage: meta.currentStage,
      criticalFailed: String(release.criticalFailed),
      failedSteps: release.failedSteps.join(","),
    },
    release.criticalFailed ? "warn" : undefined,
  );
  return true;
}
