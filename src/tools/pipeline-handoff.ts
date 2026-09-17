/**
 * @module pipeline-handoff
 * Factory for the `pipeline_handoff` tool.
 * Handles stage transitions with validated summary context passing,
 * model switching, and audit logging.
 */

import type { PipelineConfig, Tool, SessionMeta, PipelineStage } from "../types";
import { writeAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "../core/pipeline-ui";
import { freezeAndPrompt } from "../core/flow-state";
import { checkStageSummaryHash } from "../utils/summary-hash";
// Phase 0 (182): dispatch stage executor after choose_stage from frozen menu
import { buildOnStageChangedCallback } from "../commands/pipeline-start";
import { recordStageVisit } from "../utils/stage-visit";
import { toProjectRelative } from "../utils/path-display";
import { isDormant } from "../core/dormancy";
import { spawnStageSubagent } from "../utils/subagent-rpc";
import { maybeHandleConfirmGate, formatConfirmGatePendingCopy } from "../core/stage-advancer";
import { detectSessionRole } from "../core/session-role";

/**
 * Creates the `pipeline_handoff` tool.
 *
 * Transitions the pipeline from the current stage to a specified next stage.
 * Enforces a critical precondition: the current stage's summary must have
 * `status === "valid"` before handoff is allowed.
 *
 * On successful handoff:
 * - Updates SessionMeta (previousStage, currentStage, resets loopCount/stepIndex)
 * - Passes the validated summary path as context for the next stage
 * - Switches the model to the next stage's configured model
 * - Writes a "handoff" audit log entry
 *
 * @param config - The pipeline configuration
 * @returns A Tool object for the "pipeline_handoff" tool
 */
export function createPipelineHandoff(config: PipelineConfig): Tool {
  const ui = createPipelineUI(config);
  return {
    name: "pipeline_handoff",
    description:
      "Handoff to the next pipeline stage. " +
      "Requires the current stage's summary to be validated (status=valid). " +
      "Switches model, resets loop counters, and passes summary context.",
    parameters: {
      type: "object",
      properties: {
        nextStage: {
          type: "string",
          description: "The pipeline stage to transition to",
        },
        note: {
          type: "string",
          description: "Optional handoff note",
        },
      },
      required: ["nextStage"],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const rawMeta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 2b (173) C3: dormant guard — guidance message
      if (!rawMeta || isDormant(rawMeta)) {
        return { message: "No active pipeline. Run /pipeline-start <doc>." };
      }
      const meta: SessionMeta = rawMeta;
      const currentStage = meta.currentStage;
      const nextStage = args.nextStage as PipelineStage;
      const note = (args.note as string) ?? "";

      // Precondition: current stage summary must be validated
      const currentSummary = meta.summaries[currentStage];
      if (!currentSummary || currentSummary.status !== "valid") {
        return {
          error:
            `Cannot handoff. Current stage summary is ` +
            `'${currentSummary?.status || "missing"}'. ` +
            `Please generate and validate summary first.`,
          help: "Run: generate_stage_summary, then validate_summary",
        };
      }

      // Phase 4 (143): Hash integrity check — detect manual summary modifications.
      // Check the current stage's summary (the one being passed as context for next stage).
      const currentHashCheck = checkStageSummaryHash(meta, currentStage);
      if (currentHashCheck && !currentHashCheck.match) {
        const mismatchedStage = currentHashCheck.stage;
        return {
          success: false,
          error:
            `Summary '${mismatchedStage}' has been modified manually (hash mismatch). ` +
            `Confirm to re-enter stage via stage_advance({ nextStage: "${mismatchedStage}" }).`,
          mismatchedStage,
        };
      }

      const nextStageConfig = config.stages[nextStage];
      if (!nextStageConfig) {
        return { error: `Unknown stage: "${nextStage}"` };
      }

      // Phase 3 / 177 (D6): handoff must pass the stage confirm gate when configured.
      // Previously handoff bypassed the gate by only checking summary validity.
      // The gate is presented by the owner only — child sessions never show it
      // in place (their agent_settled re-ask routes presentation to the owner).
      const confirmMode = config.stages[currentStage]?.confirm?.mode;
      if (confirmMode && confirmMode !== "auto") {
        // Phase 1 / 181: pass the real session role. Child sessions take the
        // gate's zero-side-effect bypass (no ui.select stripping wrapper needed).
        const role = detectSessionRole(ctx as Parameters<typeof detectSessionRole>[0]);
        const gate = await maybeHandleConfirmGate(config, ctx, meta, ui, {
          mode: confirmMode,
          isChild: role.isChild,
          sessionFile: role.sessionFile,
        });
        if (gate.result === "handled") {
          if (gate.action === "advanced") {
            // Gate approved and advanced (marker written) — handoff contract satisfied.
            return {
              success: true,
              message: `Confirm gate approved; advanced to "${gate.toStage ?? nextStage}".`,
              currentStage: (ctx.session.getMeta() as SessionMeta).currentStage,
            };
          }
          // pending / routed / aborted → do NOT handoff (closes the bypass path).
          return {
            success: false,
            pending: gate.action === "pending",
            error: `Handoff blocked: confirm gate not approved (${gate.action}).`,
            message: formatConfirmGatePendingCopy(config, currentStage),
          };
        }
        // no-gate (confirm marker already present) → fall through to the normal handoff.
      }

      // Cycle detection: unified via recordStageVisit helper (DRY with stage-advancer,
      // routeConfirmReject, verify-advance). Preserves original handoff semantics.
      const maxCycles = meta.maxLoopCycles ?? config.maxLoopCycles ?? 3;
      const visitResult = recordStageVisit(meta, nextStage, maxCycles);

      if (!visitResult.ok) {
        // Max loop cycles reached — freeze pipeline and prompt for user decision
        ctx.session.updateMeta(visitResult.patch);
        await freezeAndPrompt(ctx, meta, "max_loop_cycles", config, {
          onStageChanged: buildOnStageChangedCallback(ctx, config),
        });

        return {
          error:
            `Max loop cycles (${maxCycles}) reached. ` +
            `Pipeline cannot cycle back to "${nextStage}". ` +
            `Pipeline frozen. Use the decision menu to continue.`,
        };
      }

      // Merge visit patch (loopCycleCount + stageVisitOrder) into updateMeta
      ctx.session.updateMeta(visitResult.patch);

      // Get updated metadata for the actual stage transition
      const updatedMeta = ctx.session.getMeta() as SessionMeta;

      // Update metadata: transition stage, reset counters, pass context
      // Pass only the delta (not a full snapshot) to avoid overwriting concurrent writes.
      const contextFiles = updatedMeta.contextFiles || {};
      ctx.session.updateMeta({
        previousStage: currentStage,
        currentStage: nextStage,
        stageStartTime: Date.now(),
        loopCount: 0,
        currentStepIndex: 0,
        contextFiles: {
          ...contextFiles,
          [nextStage]: [currentSummary.path],
        },
      });

      // NOTE: model management removed (Q4-A) — model is managed by user via /model command.

      // Write audit log
      await writeAuditLog("handoff", {
        pipelineId: meta.pipelineId,
        from: currentStage,
        to: nextStage,
        model: meta.currentModel?.modelId ?? "default",
        summaryHash: currentSummary.hash,
        note,
      });

      // TUI stage transition output
      if (nextStage === "completed") {
        ui.clearStage(ctx);
      } else {
        ui.transition(ctx, currentStage, nextStage);
      }

      // Phase 1 (169): Spawn subagent for the target stage after handoff
      if (nextStage !== "completed") {
        const freshMetaForSpawn = ctx.session.getMeta() as SessionMeta;
        const result = await spawnStageSubagent(
          (ctx as { pi?: unknown }).pi,
          config,
          nextStage,
          freshMetaForSpawn,
          {
            ui: { notify: (msg: string) => { ui.notify(ctx, msg); } },
            session: ctx.session,
            runtimeCtx: ctx,
          },
        );
        // Phase 2 / 179 (G3): consume deferred result for observability.
        // When deferred, the spawn is queued behind a live same-agent twin and
        // will dequeue automatically — no user prompt needed.
        if (result.deferred) {
          await writeAuditLog("pipeline_handoff_deferred", {
            pipelineId: freshMetaForSpawn.pipelineId,
            stage: nextStage,
            reason: "subagent_deferred",
          });
        }
      }

      return {
        success: true,
        message: `Switched to "${nextStage}". Loaded summary: ${toProjectRelative(config.projectRoot, currentSummary.path)}`,
      };
    },
  };
}
