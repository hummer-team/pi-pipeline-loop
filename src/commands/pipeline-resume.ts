/**
 * @module pipeline-resume
 * Factory for the `/pipeline-resume` command.
 * Provides a deterministic recovery path for frozen pipelines.
 *
 * Behavior matrix (213 Phase 3: every state has an actionable exit):
 * - No meta → error message (D7)
 * - design-review blocked (identity incomplete) → rebuild menu (D6);
 *   without an interactive UI → honest no-UI exit + resume_skipped_no_menu
 * - design-review authorized → coordinator result matrix; only a genuinely
 *   PENDING human decision ends the run with the exit sentence (D8/D10) — a
 *   "pending" without a menu to open (review_running etc.) continues down to
 *   the lifecycle skeleton
 * - Aborted → skeleton: Restore stage (default) / new pipeline / Cancel (D5)
 * - Not frozen (running): a pending manual confirm gate (owner-only) keeps
 *   priority and re-enters the existing dialog via maybeHandleConfirmGate;
 *   otherwise the skeleton: Continue current stage (default, ZERO writes, D4)
 *   / new pipeline / Cancel
 * - Blocked/awaiting_human (frozen):
 *   - Without --force-resume → requestDecision (208 Phase 3, source="command";
 *     210 review issue 3: the chain wrapper, so a reload-leftover freeze gets
 *     its decision-wait deadline re-armed when decisionPolicy is enabled):
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
import { isFrozen, getFlowState, executeDecision, formatFrozenReason, requestDecision, resolveDecisionReason, formatDecisionMenuHint } from "../core/flow-state";
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
// 213 Phase 3 (D1–D7): every lifecycle state gets an actionable menu exit.
// The command keeps ONLY dispatch; the menus and the destructive executors
// live in pipeline-resume-menu.ts (single source with /pipeline-start).
import { hasInteractiveUI } from "../core/ui-capability";
import { isDesignReviewDecisionPending } from "../core/design-review/decision-guard";
import {
  noUiExit,
  runResumeSkeleton,
  runningStatusMessage,
  type ResumeMenuDeps,
} from "./pipeline-resume-menu";

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

      // 213 Phase 3 (D18): the interactive-capability verdict is computed ONCE
      // here (the second and last 213 call site of `hasInteractiveUI`; the
      // first is the decision-menu presenter in P0). Declared host capability
      // wins; the legacy `typeof ui.select` inference is only the undeclared
      // fallback. The frozen channel deliberately does NOT route through this
      // gate — 208's `no-menu` attribution stays as-is (plan D1/D13).
      const menuCapable = hasInteractiveUI(ctx);
      // 213 Phase 3: the lifecycle dispatch below runs on the FRESHEST meta.
      // Identical to `meta` on every path except a continued `authorized`
      // pending WITHOUT a decision menu (the coordinator may have moved the
      // state — D10 result matrix row 6).
      let lifecycleMeta = meta;
      // 213 review (issue 6): the D2 row-6 continuation keeps the coordinator's
      // pending reason (e.g. `report_hash_drift`) so the running skeleton title
      // can display the fact instead of losing it.
      let recoveryPendingReason: string | undefined;
      const makeMenuDeps = (m: SessionMeta): ResumeMenuDeps => ({
        ctx: ctx as ResumeMenuDeps["ctx"],
        config,
        ui,
        meta: m,
        forwardArgs,
      });

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
        // D6: keep the existing takeover audit; when a menu genuinely follows,
        // the record gains `action: "menu_presented"` (audit = fact).
        await safeWriteAuditLog("design_review_blocked_takeover", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: drResume.reason ?? "identity_incomplete",
          trigger: "pipeline_resume",
          ...(menuCapable ? { action: "menu_presented" } : {}),
        }, "warn");
        syncStageStatusBar(ui, ctx);
        // 213 Phase 3: the blocked state gets its OWN actionable rebuild menu
        // (positive actions all run through the new-pipeline branch —
        // buildStartMeta clears the corrupted `designReview` in one fresh-
        // period write; no strict commit on a broken state).
        const blockedDeps = makeMenuDeps(meta);
        const outcome = menuCapable
          ? await runResumeSkeleton(blockedDeps, "identity-incomplete")
          : await noUiExit(blockedDeps, "identity-incomplete");
        return { message: outcome.message };
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
            // 213 Phase 3 (D10 result matrix, rows 5/6). The coordinator may
            // have written — re-read before narrowing the pending kind.
            const freshMeta = (ctx.session.getMeta() as SessionMeta | undefined) ?? meta;
            // Row 5 in its FULL honest scope: the domain still OWNS this wait —
            // an awaiting human decision (`paused(decision-pending)`, the 193
            // predicate) OR a PERSISTED choice whose application is retryable
            // (194: "never a silent fallthrough to generic resume"). A chosen
            // decision behind a generic "Continue current stage" skeleton would
            // claim "No resume needed" while the applied human choice still
            // dangles un-acted — the recovery-pending sentence stays the only
            // honest surface for both.
            const pendingDecision = freshMeta.designReview?.decision;
            const domainOwnedPending =
              isDesignReviewDecisionPending(freshMeta) ||
              (pendingDecision !== undefined && pendingDecision.state !== "pending");
            if (domainOwnedPending) {
              // Ends the run with the honest exit sentence (213 Phase 0 /
              // D17-②): takeover via this command, re-authorization, or
              // /pipeline-quit. A declined takeover or a cancelled menu stays
              // zero-write and NEVER opens a second menu (D10) — this return
              // IS that exit.
              const pendingMsg =
                `Design-review recovery pending: ${coordResult.reason}. ` +
                `Run /pipeline-resume again to take over this decision, ` +
                `re-authorize this design-review round, or /pipeline-quit.`;
              ui.notify(ctx, pendingMsg);
              return { message: pendingMsg };
            }
            // Row 6: a "pending" with NO decision record at all (`review_running`,
            // `update_*`, `verification_outcome_missing`, drifted evidence) is a
            // wait with no menu to open. Continue the lifecycle dispatch with
            // the FRESHEST meta — the skeleton below gives this state its own
            // actionable exit instead of a dead-end notice (213 D2).
            // 213 review (issue 6): the coordinator's reason is carried into the
            // skeleton title — the drift fact must stay user-visible.
            recoveryPendingReason = coordResult.reason;
            lifecycleMeta = freshMeta;
          } else if (coordResult.action === "frozen") {
            ui.notify(ctx, `Design-review frozen: ${coordResult.reason}`);
            return { message: `Design-review frozen: ${coordResult.reason}` };
          } else {
            // Fail-closed honesty: any other handled action still never falls
            // through to generic resume recovery (the union is exhaustive —
            // defensive branch for future actions).
            const unknownMsg = "Design-review recovery: unrecognized handled action.";
            ui.notify(ctx, unknownMsg);
            return { message: unknownMsg };
          }
        }
        // not-applicable → continue with normal resume logic
      }

      const flowState = getFlowState(lifecycleMeta);

      // 213 Phase 3 (D5, dispatch step 3): an aborted run is NOT a dead end —
      // it gets the skeleton whose default restores THIS stage in place
      // (pipelineId/stage kept, `terminateReason` cleared by resumePipeline).
      // Without an interactive UI the state exits through the honest no-UI
      // sentence; the "run /pipeline-start" hint lives inside that sentence
      // (212's bare redirect is retired).
      if (flowState === "aborted") {
        // Restore the persistent status bar BEFORE presenting the menu
        // (parity with /pipeline-start; unchanged pre-menu side-effect).
        syncStageStatusBar(ui, ctx);
        const outcome = menuCapable
          ? await runResumeSkeleton(makeMenuDeps(lifecycleMeta), "aborted")
          : await noUiExit(makeMenuDeps(lifecycleMeta), "aborted");
        return { message: outcome.message };
      }

      // Not frozen (dispatch step 5): running.
      // Phase 3 / 180: if a manual confirm gate is pending, re-enter the EXISTING
      // confirm dialog (maybeHandleConfirmGate) — the deterministic recovery path
      // for a dismissed gate. The gate keeps priority over the 213 skeleton: a
      // pending owner confirmation is the one dialog that must answer first.
      if (!isFrozen(lifecycleMeta)) {
        // Restore the persistent status bar (parity with /pipeline-start).
        syncStageStatusBar(ui, ctx);

        const statusMsg = runningStatusMessage(lifecycleMeta);

        // Owner-only: child sessions must not present the dialog. Role-detection
        // failure is fail-open to owner (consistent with session-role.ts).
        let isChild = false;
        try {
          isChild = detectSessionRole(ctx).isChild;
        } catch {
          // Fail-open: treat as owner
        }

        if (!isChild && await detectPendingConfirmGate(config, lifecycleMeta)) {
          // Reuse the persisted session/ui/pi context shape (same as the
          // pipeline-handoff and stage-advancer tool call sites). No new UI
          // primitive: `ui.select` is the SDK UI passed straight through.
          const gateCtx = { session: ctx.session, ui: ctx.ui, pi: ctx.pi };
          // Review stage: no `defaultReject` — use the default option order.
          const gate = await maybeHandleConfirmGate(config, gateCtx, lifecycleMeta, ui, {
            mode: "manual",
            source: "resume",
          });
          // Share the re-ask / cleanup accounting with the owner auto re-ask chain.
          // 194 C5: pass the raw entry ctx so a bound count goes through the
          // strict anchored write (resume's ctx IS the ExtensionContext).
          recordConfirmGateOutcome(ctx.session, lifecycleMeta, gate, false, { _ctx: ctx });

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
          // the 213 running skeleton.
        }

        // 213 Phase 3 (D4): the read-only "No resume needed." notice is
        // REPLACED by the actionable skeleton. The status bar is already
        // synced above; a declined/cancelled menu writes nothing.
        // 213 review (issues 3/6): a CHILD gets the role-safe skeleton
        // (continue/cancel only); a row-6 continuation shows its pending
        // reason in the title.
        const outcome = menuCapable
          ? await runResumeSkeleton(makeMenuDeps(lifecycleMeta), "running", { isChild, recoveryPendingReason })
          : await noUiExit(makeMenuDeps(lifecycleMeta), "running");
        return { message: outcome.message };
      }

      // Blocked or awaiting_human: frozen recovery path
      try {
        // 208 Phase 3 (G1/G2/G3): the decision menu is owned by the unified
        // ensureDecisionMenu scheduler — interrupted auto-retry, timer mutex
        // and accurate no-menu attribution all live there. The command owns
        // the single user-facing no-menu message (notifyOnUnavailable: false),
        // avoiding the contradictory "run in owner session" double-hint.
        // 210 review issue 3: the entry goes through `requestDecision` (the one
        // provider-chain wrapper) instead of `ensureDecisionMenu` directly, so a
        // freeze left over by a PREVIOUS process gets its decision-wait deadline
        // re-armed (and, headless, converges policy → abort) whenever
        // `decisionPolicy` is enabled. Policy-disabled projects keep the exact
        // baseline passthrough.
        if (!forceResume) {
          const onStageChangedForResume = async (freshMeta: SessionMeta): Promise<void> => {
            const doc = freshMeta.requirementDoc ?? "";
            await dispatchAfterResume(ctx, config, ui, freshMeta, doc, forwardArgs || undefined);
          };
          const menu = await requestDecision(
            { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx },
            lifecycleMeta,
            config,
            resolveDecisionReason(lifecycleMeta),
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

          // `null` = the chain resolved WITHOUT presenting a menu (policy
          // applied, or the pipeline converged to abort). Same post-actions as
          // an applied human decision, so the command stays honest about where
          // the pipeline ended up.
          if (menu === null) {
            syncStageStatusBar(ui, ctx);
            if (getFlowState(current) === "aborted") {
              const message =
                `Decision provider chain aborted the pipeline at "${current.currentStage}" ` +
                `(${current.terminateReason ?? "decision_policy"}).`;
              ui.notify(ctx, message);
              return { message };
            }
            if (isFrozen(current)) {
              const message = `Pipeline remains frozen at "${current.currentStage}". ${formatDecisionMenuHint()}`;
              ui.notify(ctx, message);
              return { message };
            }
            const message = `Decision policy resolved the freeze. Pipeline at stage "${current.currentStage}".`;
            ui.notify(ctx, message);
            await idempotentStageDispatch(ctx, config, ui, current, forwardArgs);
            return { message };
          }
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
                pipelineId: lifecycleMeta.pipelineId,
                stage: lifecycleMeta.currentStage,
                reason: unavailable,
                blockedReason: lifecycleMeta.blockedReason ?? "unknown",
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
        const result = await executeDecision(ctx, lifecycleMeta, "resume", config, { source: "force-resume" });

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
