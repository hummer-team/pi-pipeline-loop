/**
 * @module pipeline-resume
 * Factory for the `/pipeline-resume` command.
 * Provides a deterministic recovery path for frozen pipelines.
 *
 * Behavior matrix:
 * - No meta → error message
 * - Not frozen (running) → restore the persistent status bar; if a manual
 *   confirm gate is pending (owner-only) re-enter the existing dialog via
 *   maybeHandleConfirmGate, otherwise a read-only status hint
 * - Aborted → restore status bar + points to /pipeline-start (no menu available)
 * - Blocked/awaiting_human (frozen):
 *   - With UI + no --force-resume → present decision menu (Phase 0 / 182)
 *     - decided → return decision result (status bar synced by Phase 0)
 *     - cancelled/interrupted → keep frozen, return frozen hint
 *     - no-menu (child session) → fall through to legacy resume
 *   - With --force-resume or no UI → legacy executeDecision("resume") + dispatch
 */

import type { PipelineConfig, Command, SessionMeta } from "../types";
import { isFrozen, getFlowState, executeDecision, formatFrozenReason, formatAbortedNotifyText, promptDecisionMenu, formatDecisionMenuHint } from "../core/flow-state";
import { dispatchAfterResume } from "./pipeline-start";
import { createPipelineUI, syncStageStatusBar } from "../core/pipeline-ui";
import { detectPendingConfirmGate, maybeHandleConfirmGate, recordConfirmGateOutcome } from "../core/stage-advancer";
import { detectSessionRole } from "../core/session-role";
import { safeWriteAuditLog } from "../utils/auditLog";
import { probeAgentState } from "../utils/subagents-introspect";
import { isSpawnableStage } from "../utils/subagent-rpc";
import { staleConfigNotice } from "../utils/config-staleness";
import { coordinateDesignReview, type CoordinatorResult } from "../core/design-review/coordinator";
// 193 Phase 3 (tasks 1/2/4): shared safe builder, flow classification and the
// ONE honest consumer at the explicit-resume entry.
import { classifyDesignReviewFlow } from "../core/design-review/state";
import { createDesignReviewRuntimeContext } from "../core/design-review/runtime-context";
import { consumeDesignReviewResult, type DesignReviewConsumeCtx } from "../core/design-review/entry-result";

/**
 * Idempotent stage dispatch helper (Phase 1 / 182).
 *
 * Checks if the current stage has a live agent; if not, calls
 * dispatchAfterResume to spawn the stage executor. This deduplicates the
 * dispatch logic shared by the "decided" branch and the legacy resume path.
 *
 * @param ctx - Runtime context for dispatch
 * @param config - Pipeline configuration
 * @param ui - Pipeline UI adapter
 * @param currentMeta - Fresh session meta (post-decision)
 * @param forwardArgs - Optional forwarded user args
 */
async function idempotentStageDispatch(
  ctx: any,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  currentMeta: SessionMeta,
  forwardArgs?: string,
): Promise<void> {
  const stage = currentMeta.currentStage;
  if (!isSpawnableStage(config, stage)) return;

  const activeSpawns = currentMeta.activeSpawns ?? {};
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
    const doc = currentMeta.requirementDoc ?? "";
    await dispatchAfterResume(ctx, config, ui, currentMeta, doc, forwardArgs || undefined);
  }
}

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
    description: "Resume a frozen pipeline. Use --force-resume to bypass the decision menu and resume directly.",
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      // Phase 1 / 175 (R1Q7A): forwardArgs from /pipeline-resume are transparently
      // passed through to the stage subagent spawn prompt.
      const forwardArgs = (args.forwardArgs as string) || "";
      // Phase 0 (182): --force-resume flag bypasses the frozen decision menu
      const forceResume = args.forceResume === true;

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

      // Phase 4 (191): design-review recovery on resume.
      // 193 Phase 3 (tasks 1/2/4): explicit resume is the ONLY entry allowed
      // to re-present a pending decision menu (provenance "resume", assigned
      // here — never a model parameter). A obtained `verify_failed` is
      // consumed EXACTLY ONCE through the shared honest consumer (tool
      // method: concrete guidance shown proactively, no followUp wake, and
      // NO fallthrough into generic running/force recovery). An identity-
      // blocked domain never leaks into generic resume either —
      // --force-resume cannot replace a human choice or domain verification.
      const drResume = classifyDesignReviewFlow(meta);
      if (drResume.kind === "blocked") {
        await safeWriteAuditLog("design_review_blocked_takeover", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: drResume.reason ?? "identity_incomplete",
          trigger: "pipeline_resume",
        }, "warn");
        syncStageStatusBar(ui, ctx);
        const blockedMsg =
          `Design-review loop identity incomplete — awaiting owner takeover. ` +
          `Generic resume/--force-resume do not replace domain verification or the human decision.`;
        ui.notify(ctx, blockedMsg);
        return { message: blockedMsg };
      }
      if (drResume.kind === "authorized") {
        const coordCtx = createDesignReviewRuntimeContext({
          config,
          session: ctx.session,
          interactionSource: "resume",
          roleCtx: ctx,
          rawUi: ctx.ui,
          pipelineUi: ui,
          pipelineUiCtx: ctx,
          pi: ctx.pi,
        });
        const coordResult: CoordinatorResult = await coordinateDesignReview(coordCtx, meta, "settle");
        if (coordResult.status === "handled") {
          syncStageStatusBar(ui, ctx);
          if (coordResult.action === "advanced" || coordResult.action === "routed") {
            ui.notify(ctx, `Design-review recovered: ${coordResult.action} to "${coordResult.toStage}".`);
            return { message: `Design-review recovered: ${coordResult.action} to "${coordResult.toStage}".` };
          }
          if (coordResult.action === "verify_failed") {
            // ONE shared honest consumption; the command only displays/returns
            // the already-consumed result (never a second applyVerifyFail).
            const freshMeta = (ctx.session.getMeta() as SessionMeta | undefined) ?? meta;
            const outcome = await consumeDesignReviewResult({
              result: coordResult,
              meta: freshMeta,
              entry: "command",
              ctx: {
                session: ctx.session,
                ui: ctx.ui,
                pi: ctx.pi,
                _ctx: ctx._ctx,
              } as DesignReviewConsumeCtx,
              config,
              ui,
              runtimeCtx: ctx,
            });
            const failMsg = outcome.message || "Design-review verification failed — see the corrective guidance.";
            ui.notify(ctx, failMsg);
            return { message: failMsg };
          }
          if (coordResult.action === "pending") {
            ui.notify(ctx, `Design-review recovery pending: ${coordResult.reason}`);
            return { message: `Design-review recovery pending: ${coordResult.reason}` };
          }
          if (coordResult.action === "frozen") {
            ui.notify(ctx, `Design-review frozen: ${coordResult.reason}`);
            return { message: `Design-review frozen: ${coordResult.reason}` };
          }
          // Fail-closed honesty: any other handled action still never falls
          // through to generic resume recovery (the union is exhaustive —
          // defensive branch for future actions).
          const unknownMsg = "Design-review recovery: unrecognized handled action.";
          ui.notify(ctx, unknownMsg);
          return { message: unknownMsg };
        }
        // not-applicable → continue with normal resume logic
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

      // Blocked or awaiting_human: frozen recovery path
      try {
        // Phase 0 (182): present decision menu on frozen resume (unless --force-resume).
        // When the UI select is available and force-resume is not requested, show the
        // 6-item decision menu so the user can choose the appropriate action.
        // - decided → status bar synced by Phase 0; dispatch if needed (idempotent)
        // - cancelled/interrupted → keep frozen, return hint
        // - no-menu (child session / no UI) → fall through to legacy resume
        if (!forceResume && typeof ctx?.ui?.select === "function") {
          const onStageChangedForResume = async (freshMeta: SessionMeta): Promise<void> => {
            const doc = freshMeta.requirementDoc ?? "";
            await dispatchAfterResume(ctx, config, ui, freshMeta, doc, forwardArgs || undefined);
          };
          const menuOutcome = await promptDecisionMenu(
            { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx },
            meta,
            config,
            { source: "command", onStageChanged: onStageChangedForResume },
          );

          if (menuOutcome === "decided") {
            // Decision executed. Status bar sync is unconditional here because
            // executeDecision only syncs for choose_stage decisions (flow-state.ts);
            // for resume/skip/rollback/restart, we must sync explicitly to keep
            // the bar reflecting the post-decision stage (Phase 0 / 182).
            syncStageStatusBar(ui, ctx);

            // Idempotent dispatch guard: if the decision did NOT involve choose_stage
            // (e.g. "resume"), the onStageChanged callback was not invoked, so we
            // still need the dispatch. Check if the pipeline is still frozen — if
            // not, the decision resolved it and dispatch is needed.
            const postDecisionMeta = ctx.session.getMeta() as SessionMeta;
            if (!isFrozen(postDecisionMeta)) {
              ui.notify(ctx, `Decision executed. Pipeline at stage "${postDecisionMeta.currentStage}".`);
              // Shared idempotent dispatch helper (probe-live skip + spawn)
              await idempotentStageDispatch(ctx, config, ui, postDecisionMeta, forwardArgs);
            }
            return { message: "Decision executed." };
          }

          if (menuOutcome === "cancelled" || menuOutcome === "interrupted") {
            // Keep frozen — do not silently unfreeze
            const currentMeta = ctx.session.getMeta() as SessionMeta;
            return {
              message: `Pipeline remains frozen at "${currentMeta.currentStage}". ${formatDecisionMenuHint()}`,
            };
          }

          // "no-menu" (child session) → fall through to legacy resume path
        }

        // Legacy path: --force-resume, no UI, or child session fallback
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
        await idempotentStageDispatch(ctx, config, ui, freshMeta, forwardArgs);

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
