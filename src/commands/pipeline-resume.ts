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
 *   - Without --force-resume → ensureDecisionMenu (208 Phase 3, source="command"):
 *     unified scheduler with interrupted auto-retry / timer mutex / accurate
 *     no-menu attribution.
 *     - decided && applied → return decision result (status bar synced + dispatch)
 *     - decided but not applied → "Decision not applied: …" (+ reopen note)
 *     - cancelled/interrupted → keep frozen, return hint (retry armed → auto reopen)
 *     - no-menu (child session / no UI / select error) → notify + audit
 *       resume_skipped_no_menu with the runtime's unavailableReason, DO NOT resume
 *   - With --force-resume → explicit skip, executeDecision("resume") + dispatch (Phase 6 / 195)
 */

import type { PipelineConfig, Command, SessionMeta } from "../types";
import { isFrozen, getFlowState, executeDecision, formatFrozenReason, formatAbortedNotifyText, ensureDecisionMenu, formatDecisionMenuHint } from "../core/flow-state";
import { dispatchAfterResume } from "./pipeline-start";
import { createPipelineUI, syncStageStatusBar } from "../core/pipeline-ui";
import { detectPendingConfirmGate, maybeHandleConfirmGate, recordConfirmGateOutcome } from "../core/stage-advancer";
import { detectSessionRole } from "../core/session-role";
import { safeWriteAuditLog, setAuditPipelineContext } from "../utils/auditLog";
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
      // Phase 1 (197): refresh audit routing context on command entry
      setAuditPipelineContext(meta?.pipelineId);
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
                config,
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
          // 194 C5: pass the raw entry ctx so a bound count goes through the
          // strict anchored write (resume's ctx IS the ExtensionContext).
          recordConfirmGateOutcome(ctx.session, meta, gate, false, { _ctx: ctx });

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
        // 208 Phase 3 (G1/G2/G3): the decision menu is owned by the unified
        // ensureDecisionMenu scheduler — interrupted auto-retry, timer mutex
        // and accurate no-menu attribution all live there. The command owns
        // the single user-facing no-menu message (notifyOnUnavailable: false),
        // avoiding the contradictory "run in owner session" double-hint.
        if (!forceResume) {
          const onStageChangedForResume = async (freshMeta: SessionMeta): Promise<void> => {
            const doc = freshMeta.requirementDoc ?? "";
            await dispatchAfterResume(ctx, config, ui, freshMeta, doc, forwardArgs || undefined);
          };
          const menu = await ensureDecisionMenu(
            { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx },
            meta,
            config,
            {
              source: "command",
              onStageChanged: onStageChangedForResume,
              // Commands own the single user-facing no-menu message (no second notify).
              notifyOnUnavailable: false,
              // Same rule for Esc/cancelled input: the returned message is the
              // only channel, so the runtime must not notify as well.
              notifyOnCancel: false,
            },
          );
          const current = (ctx.session.getMeta() as SessionMeta | undefined) ?? meta;
          const retrySeconds = Math.max(1, Math.round((menu.retryDelayMs ?? 5000) / 1000));

          switch (menu.outcome) {
            case "decided": {
              if (!menu.applied) {
                const retryNote = menu.retryArmed
                  ? ` The menu will reopen automatically in ~${retrySeconds}s.`
                  : " Run /pipeline-resume to try again.";
                return { message: `Decision not applied: ${menu.message ?? "unknown reason"}.${retryNote} ${formatDecisionMenuHint()}` };
              }
              // Status bar sync is unconditional here because executeDecision
              // only syncs for choose_stage decisions (flow-state.ts); for
              // resume/skip/rollback/restart, we must sync explicitly to keep
              // the bar reflecting the post-decision stage (Phase 0 / 182).
              syncStageStatusBar(ui, ctx);
              // Idempotent dispatch guard: if the decision did NOT involve
              // choose_stage (e.g. "resume"), the onStageChanged callback was
              // not invoked, so we still need the dispatch. Check if the
              // pipeline is still frozen — if not, the decision resolved it
              // and dispatch is needed.
              if (!isFrozen(current)) {
                ui.notify(ctx, `Decision executed. Pipeline at stage "${current.currentStage}".`);
                // Shared idempotent dispatch helper (probe-live skip + spawn)
                await idempotentStageDispatch(ctx, config, ui, current, forwardArgs);
              }
              return { message: "Decision executed." };
            }
            case "cancelled":
              // Keep frozen — do not silently unfreeze
              return {
                message: `Pipeline remains frozen at "${current.currentStage}". ${formatDecisionMenuHint()}`,
              };
            case "interrupted": {
              // Only promise an automatic reopen when a retry timer was actually armed.
              const reopen = menu.retryArmed
                ? `it will reopen automatically in ~${retrySeconds}s.`
                : "run /pipeline-resume to reopen it.";
              return {
                message: `Decision menu interrupted; ${reopen} Pipeline remains frozen at "${current.currentStage}".`,
              };
            }
            case "no-menu": {
              // Phase 6 (195) / 208 G3: accurate attribution from the runtime —
              // no more reverse-inference from `typeof ui.select`.
              const unavailable = menu.unavailableReason ?? "unknown";
              await safeWriteAuditLog("resume_skipped_no_menu", {
                pipelineId: meta.pipelineId,
                stage: meta.currentStage,
                reason: unavailable,
                blockedReason: meta.blockedReason ?? "unknown",
              });
              // Single notify: `notifyOnUnavailable: false` suppresses the runtime's
              // own no-UI notify, so the user sees exactly one consistent message.
              const message = `Pipeline frozen at "${current.currentStage}" (${formatFrozenReason(current)}). No decision menu is available (${unavailable}); use /pipeline-resume --force-resume to resume directly.`;
              ui.notify(ctx, message);
              return { message };
            }
          }
        }

        // --force-resume path: explicit skip, proceed with resume
        const result = await executeDecision(ctx, meta, "resume", config, { source: "force-resume" });

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
