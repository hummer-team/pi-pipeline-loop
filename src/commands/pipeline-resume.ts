/**
 * @module pipeline-resume
 * Factory for the `/pipeline-resume` command.
 * Provides a deterministic recovery path for frozen pipelines without
 * requiring the TUI decision menu (Phase 5 / 172 G6b).
 *
 * Behavior matrix:
 * - No meta → error message
 * - Not frozen (running) → restore the persistent status bar; if a manual
 *   confirm gate is pending (owner-only) re-enter the existing dialog via
 *   maybeHandleConfirmGate, otherwise a read-only status hint
 * - Aborted → restore status bar + points to /pipeline-start (no menu available)
 * - Blocked/awaiting_human → executeDecision("resume") + status bar + stage dispatch
 */

import type { PipelineConfig, Command, SessionMeta } from "../types";
import { isFrozen, getFlowState, executeDecision, formatFrozenReason, formatAbortedNotifyText } from "../core/flow-state";
import { dispatchAfterResume } from "./pipeline-start";
import { createPipelineUI, syncStageStatusBar } from "../core/pipeline-ui";
import { detectPendingConfirmGate, maybeHandleConfirmGate, recordConfirmGateOutcome } from "../core/stage-advancer";
import { detectSessionRole } from "../core/session-role";
import { safeWriteAuditLog } from "../utils/auditLog";
import { probeAgentState } from "../utils/subagents-introspect";
import { isSpawnableStage } from "../utils/subagent-rpc";
import { staleConfigNotice } from "../utils/config-staleness";

/**
 * Creates the `/pipeline-resume` command.
 *
 * @param config - The pipeline configuration
 * @returns A Command object for the "pipeline-resume" slash command
 */
export function createPipelineResumeCommand(config: PipelineConfig): Command {
  const ui = createPipelineUI(config);

  return {
    name: "pipeline-resume",
    description: "Resume a frozen pipeline in this session",
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      // Phase 1 / 175 (R1Q7A): forwardArgs from /pipeline-resume are transparently
      // passed through to the stage subagent spawn prompt.
      const forwardArgs = (args.forwardArgs as string) || "";

      // Phase 3 / 175 (R2Q6A): stale config check at command entry point.
      const staleNotice = staleConfigNotice(config);
      if (staleNotice) {
        ui.notify(ctx, staleNotice);
      }

      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMeta() as SessionMeta | undefined;
      if (!meta || !meta.pipelineId) {
        return { error: "No active pipeline. Run /pipeline-start <doc_file> to begin." };
      }

      const flowState = getFlowState(meta);

      // Aborted: no decision menu available — redirect to /pipeline-start
      if (flowState === "aborted") {
        // Restore the persistent status bar (parity with /pipeline-start).
        syncStageStatusBar(ui, ctx);
        const abortMsg = formatAbortedNotifyText(
          meta.currentStage,
          meta.terminateReason ?? "session_quit",
          meta.requirementDoc,
        );
        ui.notify(ctx, `${abortMsg} Use /pipeline-start to begin a new run.`);
        return { message: abortMsg };
      }

      // Not frozen: running (no state change).
      // Phase 3 / 180: if a manual confirm gate is pending, re-enter the EXISTING
      // confirm dialog (maybeHandleConfirmGate) — the deterministic recovery path
      // for a dismissed gate. Otherwise keep the read-only status hint.
      if (!isFrozen(meta)) {
        // Restore the persistent status bar (parity with /pipeline-start).
        syncStageStatusBar(ui, ctx);

        const statusMsg = `Pipeline is running (pipelineId: ${meta.pipelineId}, stage: ${meta.currentStage}, flowState: ${flowState}). No resume needed.`;

        // Owner-only: child sessions must not present the dialog. Role-detection
        // failure is fail-open to owner (consistent with session-role.ts).
        let isChild = false;
        try {
          isChild = detectSessionRole(ctx).isChild;
        } catch {
          // Fail-open: treat as owner
        }

        if (!isChild && await detectPendingConfirmGate(config, meta)) {
          // Reuse the persisted session/ui/pi context shape (same as the
          // pipeline-handoff and stage-advancer tool call sites). No new UI
          // primitive: `ui.select` is the SDK UI passed straight through.
          const gateCtx = { session: ctx.session, ui: ctx.ui, pi: ctx.pi };
          // Review stage: no `defaultReject` — use the default option order.
          const gate = await maybeHandleConfirmGate(config, gateCtx, meta, ui, {
            mode: "manual",
            source: "resume",
          });
          // Share the re-ask / cleanup accounting with the owner auto re-ask chain.
          recordConfirmGateOutcome(ctx.session, meta, gate, false);

          if (gate.result === "handled") {
            if (gate.action === "advanced") {
              return { message: `Confirm gate approved; advanced to "${gate.toStage ?? "next"}".` };
            }
            if (gate.action === "routed" || gate.action === "aborted") {
              const resolvedMeta = ctx.session.getMeta() as SessionMeta;
              return {
                message:
                  `Confirm gate resolved; pipeline is now at "${resolvedMeta.currentStage}" ` +
                  `(flowState: ${getFlowState(resolvedMeta)}).`,
              };
            }
            // pending (including deferred): the gate already emitted the deferral /
            // pending guidance — return the running status text without repeating.
            return { message: statusMsg };
          }
          // no-gate (marker written between predicate and call): fall through to
          // the read-only status hint.
        }

        ui.notify(ctx, statusMsg);
        return { message: statusMsg };
      }

      // Blocked or awaiting_human: execute resume decision
      try {
        const result = await executeDecision(ctx, meta, "resume", config, { source: "command" });

        if (!result.success) {
          return { error: `Resume failed: ${result.message}` };
        }

        // Restore the persistent status bar after the decision (awaiting_human
        // resolves back to previousStage — read the freshest meta).
        syncStageStatusBar(ui, ctx);

        // Phase 0 (182): use fresh meta for the notify text — awaiting_human resume
        // transitions to previousStage, so the stale `meta.currentStage` would show
        // the wrong stage name.
        const freshMeta = ctx.session.getMeta() as SessionMeta;
        ui.notify(ctx, `Pipeline resumed at stage "${freshMeta.currentStage}". ${result.message}`);

        // Stage-aware dispatch: re-spawn the stage subagent if not already live
        const stage = freshMeta.currentStage;

        if (isSpawnableStage(config, stage)) {
          // Check if there's already a live agent for this stage
          const activeSpawns = freshMeta.activeSpawns ?? {};
          const existingSpawn = activeSpawns[stage];
          let shouldSpawn = true;

          if (existingSpawn?.agentId || existingSpawn?.agentName) {
            try {
              const probe = probeAgentState(existingSpawn.agentId ?? existingSpawn.agentName!);
              if (probe === "live") {
                shouldSpawn = false;
                ui.notify(ctx, `Agent "${existingSpawn.agentName}" is already running for stage "${stage}". Skipping duplicate spawn.`);
              }
            } catch {
              // Probe failure → fail-open, proceed with spawn
            }
          }

          if (shouldSpawn) {
            const doc = freshMeta.requirementDoc ?? "";
            await dispatchAfterResume(ctx, config, ui, freshMeta, doc, forwardArgs || undefined);
          }
        }

        return { message: result.message };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await safeWriteAuditLog("pipeline_resume_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          error: errMsg,
        }, "error");
        return { error: `Resume error: ${errMsg}` };
      }
    },
  };
}
