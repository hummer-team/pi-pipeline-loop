/**
 * @module pipeline-state
 * Factory for the `pipeline_state` tool.
 * Returns the full current pipeline state for agent visibility.
 */

import type { PipelineConfig, Tool, SessionMeta } from "../types";
import { buildStageSequence } from "../utils/stage-sequence";
import { safeWriteStageAudit } from "../utils/auditLog";
import { verifySummaryHash } from "../utils/summary-hash";
import { isDormant, DORMANT_NO_PIPELINE_MESSAGE } from "./dormancy";
// 193 Phase 3 (task 8): read-only pending-decision display (shared view).
import {
  buildDesignReviewPendingDecisionView,
  DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION,
} from "./design-review/decision-display";
// 213 Phase 0 (D17-③): the ONE shared display-actor reader (read-only identity
// evidence, never an authority) so the JSON surface gets the honest three-state
// owner-evidence view whenever the caller's identity is resolvable.
import { resolveDisplayActor } from "./design-review/runtime-context";

/**
 * Creates the `pipeline_state` tool.
 *
 * Returns the complete pipeline state including current stage,
 * domain, loop count, stage configuration summary, and summary artifacts.
 * Useful for the agent to understand its position in the pipeline.
 *
 * @param config - The pipeline configuration
 * @returns A Tool object for the "pipeline_state" tool
 */
export function createPipelineState(config: PipelineConfig): Tool {
  return {
    name: "pipeline_state",
    description:
      "Get the current pipeline state: stage, domain, loop count, " +
      "stage transitions, and summary status.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (_args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const rawMeta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 2b (173) C3: dormant guard — guidance message
      if (!rawMeta || isDormant(rawMeta)) {
        return { message: DORMANT_NO_PIPELINE_MESSAGE };
      }
      const meta: SessionMeta = rawMeta;
      const currentStage = meta.currentStage;
      const stageConfig = config.stages[currentStage];
      const nextStage = stageConfig.nextStage;

      const stageSequence = buildStageSequence(config, meta.currentStage);

      // 193 Phase 3 (task 8): while a human plan-revision decision is pending,
      // this tool shows ONLY the pending/mode/report/resume guidance below —
      // the automatic next step is deliberately suppressed (READ-ONLY window;
      // advertising "develop" here would encourage self-execution).
      // 213 Phase 0 (D17-③): the read-only caller identity enables the honest
      // three-state owner-evidence copy; absent evidence keeps two states.
      const pendingDecision = buildDesignReviewPendingDecisionView(meta, resolveDisplayActor(ctx));

      // 194 Phase 3 (C5): read-only executor-run view. The plan requires the
      // display to show the requesting TOOL, the bound stage and the stored
      // `needConfirm` (never inferred), plus whether the plugin wake is still
      // outstanding (`pendingWakeId` is sent at most ONCE — the raw id stays
      // internal, only its presence is shown).
      const executorRun = meta.stageExecutorRun;
      const executorView = executorRun
        ? {
            stage: executorRun.binding.stage,
            status: executorRun.status,
            recovery: executorRun.recovery,
            terminalConsumed: executorRun.terminalConsumed,
            consumptionState: executorRun.consumption?.state ?? null,
            declaration: executorRun.declaration
              ? {
                  requestedBy: executorRun.declaration.requestedBy,
                  revision: executorRun.declaration.revision,
                  nextStage: executorRun.declaration.nextStage ?? null,
                  needConfirm: executorRun.declaration.needConfirm === true,
                  verificationRequested: executorRun.declaration.verificationRequested === true,
                }
              : null,
            wakeOutstanding: executorRun.pendingWakeId !== undefined,
          }
        : null;

      const result = {
        pipelineId: meta.pipelineId,
        stage: {
          current: currentStage,
          previous: meta.previousStage ?? null,
          next: pendingDecision !== null ? null : nextStage,
          sequence: stageSequence,
        },
        domain: {
          id: meta.domain.id,
          version: meta.domain.version,
        },
        loop: {
          count: meta.loopCount,
          stepIndex: meta.currentStepIndex,
          maxLoops: meta.maxLoops,
        },
        // 194 Phase 3 (C5): closed-loop executor run status (read-only)
        executor: executorView,
        summaries: meta.summaries,
        stageStartTime: new Date(meta.stageStartTime).toISOString(),
        // Phase 4 (143): Hash integrity check results for all tracked summaries
        summaryIntegrity: verifySummaryHash(meta),
        // Phase 4-4 (191): Include design-review state for display
        designReview: meta.designReview ? {
          phase: meta.designReview.phase,
          round: meta.designReview.round,
          operation: meta.designReview.operation?.kind ?? null,
          planDoc: meta.designReview.planDoc,
          reportDoc: meta.designReview.reportDoc ?? null,
          pauseReason: meta.designReview.pauseReason ?? null,
          // 193 Phase 3 (task 8): pending human decision — read-only mode,
          // decision (state/mode/report/issues) and the resume instruction.
          ...(pendingDecision !== null ? {
            readOnly: true,
            decision: {
              state: pendingDecision.state,
              choice: pendingDecision.choice,
              mode: pendingDecision.mode,
              reportDoc: pendingDecision.reportDoc,
              issueCount: pendingDecision.issueCount,
              // 212 Phase 3: this surface renders NO formatter — the read-only
              // owner-evidence fact must be carried explicitly here too.
              ownerEvidence: pendingDecision.ownerEvidence,
            },
            resume: DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION,
          } : {}),
        } : null,
        // 218 review #7 (Q23-A observability): the queued-spawn ledger with
        // its FULL authorization lifecycle — `dispatchAuthorizedAt` is written
        // by the stall watchdog and consumed by the 3f manual gate, so the
        // status surface shows stage, request age, and both authorization
        // timestamps (null when a step never happened).
        spawnQueue: Object.entries(meta.pendingSpawns ?? {}).flatMap(
          ([qStage, entry]) => entry
            ? [{
                stage: qStage,
                agentName: entry.agentName,
                attempts: entry.attempts,
                requestedAt: new Date(entry.requestedAt).toISOString(),
                stalledAt: entry.stalledAt !== undefined ? new Date(entry.stalledAt).toISOString() : null,
                dispatchAuthorizedAt: entry.dispatchAuthorizedAt !== undefined
                  ? new Date(entry.dispatchAuthorizedAt).toISOString()
                  : null,
                dispatchConsumedAt: entry.dispatchConsumedAt !== undefined
                  ? new Date(entry.dispatchConsumedAt).toISOString()
                  : null,
              }]
            : [],
        ),
      };

      // Audit pipeline_state query with full snapshot
      await safeWriteStageAudit(config, "pipeline_state", meta, {
        snapshot: JSON.stringify(result),
      });

      return result;
    },
  };
}
