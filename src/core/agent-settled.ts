/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state,
 * and optionally runs auto-verification if the stage has a verify block.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { runVerification, precheckCompletionMarker, precheckRequiredFiles, precheckClarifyAwaitAnswer } from "./auto-verifier";
import type { RunVerificationOptions } from "./auto-verifier";
import { safeWriteAuditLog, writeAuditLog, setAuditPipelineContext } from "../utils/auditLog";
import { applyVerifyFail, autoAdvanceAfterVerify } from "./verify-advance";
import { createPipelineUI, syncStageStatusBar } from "./pipeline-ui";
import { extractAssistantMessages, extractToolCallRecords, detectLastRunHealth } from "./session-state";
import { isFrozen, getFlowState, formatFrozenReason, promptDecisionMenu, formatAbortedNotifyText, scheduleDecisionRetry, formatDecisionMenuHint, freezeAndPrompt } from "./flow-state";
import { isDormant } from "./dormancy";
import type { RuntimeCtx } from "./runtime-ctx";
import {
  PLAN_CONFIRM_MARKER_RULE,
  shouldDeferPlanMarkerRule,
  autoWriteConfirmMarker,
  maybeHandleConfirmGate,
  recordConfirmGateOutcome,
  routeReviewFailAuto,
  formatConfirmGatePendingCopy,
} from "./stage-advancer";
import { parseReviewConclusion } from "../utils/review-conclusion";
import { maybeCompactOnPipelineCompleted } from "./terminal-compact";
import { shouldNotifyAndStamp, shouldEmitWithinWindow } from "../utils/audit-throttle";
import { loadVerifyContractAnchors } from "../utils/contract-loader";
import { AUDIT_THROTTLE_WINDOW_MS, CONFIRM_GATE_REASK_MAX, PIPELINE_TURN_SIGNATURES, TRANSIENT_RETRY_MAX } from "../constants";
import { parseRequirementDocPath } from "../utils/doc-path";
import { extractFirstUserMessageText, extractLastUserMessageText } from "./session-state";
import { consumePendingSpawns, resolveAgentMention, spawnStageSubagent, isChildRuntimeCtx } from "../utils/subagent-rpc";
import { scanActiveSpawnEvidence } from "../utils/spawn-evidence";
// Phase 0 (182) G5: name-probe for advance liveness guard
import { findLiveAgentByName } from "../utils/subagents-introspect";
import { detectSessionRole } from "./session-role";
import { escapeRegExp } from "../utils/regex-utils";
// Phase 0 (182): dispatch stage executor after choose_stage from frozen re-popup
import { dispatchAfterResume, buildOnStageChangedCallback } from "../commands/pipeline-start";
import type { SessionMeta as AgentSettledSessionMeta } from "../types";
import { coordinateDesignReview } from "./design-review/coordinator";
// 193 Phase 0: single honest consumer for design-review coordinator results
import { consumeDesignReviewResult } from "./design-review/entry-result";
// 193 Phase 3 (task 1): ONE safe builder for coordinator ctx at every entry
import { createDesignReviewRuntimeContext } from "./design-review/runtime-context";
// 192 Phase 3: flow classification for the shared verification wiring (K02)
import { classifyDesignReviewFlow } from "./design-review/state";
// 194 Phase 3 (task 3): trusted wake-source gate + visible C5 waiting state
import { verifyOwnerWakeTurn, recordAwaitingOwnerConsumption } from "./stage-executor/turn-source";
// 194 Phase 3 (task 7): closed-loop executor ownership gate for the 189 bypass
import { hasLiveExecutorRun } from "./stage-executor/commit-guard";

/**
 * Creates the `agent_settled` hook that logs when the agent stabilizes
 * and optionally runs automatic verification for the current stage.
 *
 * 1. Writes a JSON-lines audit entry (action: "agent_settled")
 * 2. If the current stage has verify.require enabled:
 *    a. Reads verify.md (YAML frontmatter rules + Markdown body prompt)
 *    b. Runs structured rule verification + optional LLM verification
 *    c. If rules pass → auto-advance; if fail → write verifyFailures, do NOT advance
 *    d. Stores verification result in SessionMeta for the next agent cycle
 *
 * @param config - The pipeline configuration
 * @param verifyOptions - Optional LLM verification options
 * @returns A Hook object for the "agent_settled" event
 */
export function createAgentSettled(
  config: PipelineConfig,
  verifyOptions?: RunVerificationOptions,
): Hook<"agent_settled"> {
  const ui = createPipelineUI(config);
  return {
    event: "agent_settled",
    handler: async (ctx: RuntimeCtx): Promise<void> => {
      const rawMeta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 1 (197): refresh audit routing context on every hook entry
      setAuditPipelineContext(rawMeta?.pipelineId);

      // Phase 2b (173) C3: Terminal compaction exemption runs BEFORE dormant guard.
      // Completed (dormant) T1 settle must still trigger compact — the helper's
      // internal isIdle/consumed guards ensure it fires exactly once.
      // For aborted dormant, the helper's internal guard self-exempts (no compact needed).
      await maybeCompactOnPipelineCompleted(
        { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx } as Parameters<typeof maybeCompactOnPipelineCompleted>[0],
        config,
      );

      // Phase 2b (173) C3: dormant guard — short-circuit
      // Covers: no meta, aborted (user_quit/abort/stale_startup), completed
      // No agent_settled audit, no notify, no frozen block, no verify
      if (!rawMeta || isDormant(rawMeta)) return;
      const meta: SessionMeta = rawMeta;

      // 192 Phase 3 (K02/F05): the design-review coordinator delegation is NO
      // LONGER executed before the ordinary guards. It now runs AFTER the
      // frozen/pending-spawn/source/health/liveness guards and BEFORE the
      // confirm-marker/menu/ordinary-advance branches, consuming the SAME
      // shared runVerification service (no pre-hook report bypass).

      // 1. Write audit log
      await writeAuditLog("agent_settled", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
      });

      ui.notify(ctx, `Agent settled in "${meta.currentStage}" stage`);

      // 1b. Frozen short-circuit: skip verification when pipeline is frozen
      if (isFrozen(meta)) {
        // Phase 3 (170) ②: enriched frozen audit with flowState + frozenReason
        const flowState = getFlowState(meta);
        await writeAuditLog("agent_settled_skipped_frozen", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          flowState,
          frozenReason: formatFrozenReason(meta),
        });
        // Phase 3 (170) ④: distinct notify text for aborted vs blocked
        if (flowState === "aborted") {
          ui.notify(ctx, formatAbortedNotifyText(
            meta.currentStage,
            meta.terminateReason ?? "session_quit",
            meta.requirementDoc,
          ));
        } else {
          ui.notify(ctx, `Pipeline frozen: ${formatFrozenReason(meta)}. ${formatDecisionMenuHint()}`);
        }
        // 168 Phase 2: auto re-popup decision menu while frozen
        // Phase 4 (169) P2-5 fix: pass `_ctx` so W3 skip→completed decisions
        // triggered from the frozen menu can invoke terminal compaction. Without
        // _ctx, the skip→completed path in flow-state.ts:224 early-returns
        // (short-cut key entry remains unaffected — it passes _ctx directly).
        // Fix #1: if prompt returns "interrupted" (streaming dismiss), arm retry scheduler.
        // Phase 0 (182): inject onStageChanged callback so choose_stage dispatches the
        // stage executor automatically (parity with shortcut / pipeline-resume paths).
        const onStageChangedForSettled = async (freshMeta: AgentSettledSessionMeta): Promise<void> => {
          const doc = freshMeta.requirementDoc ?? "";
          await dispatchAfterResume(
            { session: ctx.session, ui, pi: ctx.pi, _ctx: ctx._ctx } as Parameters<typeof dispatchAfterResume>[0],
            config,
            ui,
            freshMeta,
            doc,
          );
        };
        const promptOutcome = await promptDecisionMenu(
          { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx } as Parameters<typeof promptDecisionMenu>[0],
          meta,
          config,
          { onStageChanged: onStageChangedForSettled },
        );
        if (promptOutcome === "interrupted") {
          scheduleDecisionRetry(
            { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx } as Parameters<typeof promptDecisionMenu>[0],
            meta,
            config,
            1,
            { onStageChanged: onStageChangedForSettled },
          );
        }
        return;
      }

      // Phase 0 (186): consume pending spawns BEFORE source gate so that
      // child-routed spawns are dispatched even on non-pipeline turns.
      try {
        const { isChild } = detectSessionRole(ctx);
        if (!isChild && meta.pendingSpawns && Object.keys(meta.pendingSpawns).length > 0) {
          await consumePendingSpawns(ctx.pi, config, meta, {
            ui: { notify: (msg: string) => { ui.notify(ctx, msg); } },
            session: ctx.session,
            runtimeCtx: ctx,
          });
        }
      } catch (err) {
        // Fail-open: pending-spawn consumption must never block the settle flow
        const errMsg = err instanceof Error ? err.message : String(err);
        await writeAuditLog("pending_spawn_consume_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          error: errMsg,
        }, "warn");
      }

      // Phase 0 (186): refresh TUI status bar on every owner settle.
      // Covers the child-session UI isolation gap (Bug 5).
      try {
        const { isChild } = detectSessionRole(ctx);
        if (!isChild) {
          syncStageStatusBar(ui, ctx);
        }
      } catch (err) {
        // Fail-open: status bar sync must never block the settle flow
        const errMsg = err instanceof Error ? err.message : String(err);
        await writeAuditLog("sync_stage_status_bar_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          error: errMsg,
        }, "warn");
      }

      // Phase 2 (172) G2: Pipeline-turn source gate.
      // Pure chat settle (non-pipeline user turn) must NOT trigger verify/wake/counting/freeze.
      // Checks the last user message against known pipeline turn signatures.
      // Fail-open: extraction failure or empty message → treat as pipeline turn (conservative).
      try {
        const lastUserMsg = extractLastUserMessageText(ctx._ctx as Parameters<typeof extractLastUserMessageText>[0]);
        if (lastUserMsg.length > 0) {
          // 194 Phase 3 (task 3): the trusted WAKE SOURCE is verified BEFORE
          // the ordinary-chat signature gate. A marker that does not equal
          // the current run's persisted pendingWakeId is a replay of an
          // already-consumed or superseded wake — zero side effects, exactly
          // once per binding.
          const wakeVerdict = verifyOwnerWakeTurn(lastUserMsg, meta);
          if (wakeVerdict.matched && !wakeVerdict.trusted) {
            // Safe wrapper: a replay rejection must never be downgraded to
            // "fall through as pipeline turn" by a failing diagnostic write.
            await safeWriteAuditLog("agent_settled_owner_wake_replay_skipped", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              wakeId: wakeVerdict.wakeId ?? "malformed",
            }, "warn");
            return;
          }
          const isPipelineTurn = wakeVerdict.trusted || PIPELINE_TURN_SIGNATURES.some((sig) => {
            if (typeof sig === "string") {
              return lastUserMsg.startsWith(sig);
            }
            return sig.test(lastUserMsg);
          });
          if (!isPipelineTurn) {
            // Phase 1 / 179 (G2 layer ①): dynamic bare-form relaxation.
            // The static signatures require an "@agent" prefix, but under
            // agentMentions:"model" the mention is rewritten and the on-disk user
            // message loses the prefix (bare "docs/x.md 2 答"). Only relax when
            // requirementDoc is bound and the message starts with that exact path —
            // precise prefix matching keeps pure chat from false-hitting.
            if (!isBarePipelineTurn(lastUserMsg, meta.requirementDoc)) {
              await writeAuditLog("agent_settled_non_pipeline_turn", {
                pipelineId: meta.pipelineId,
                stage: meta.currentStage,
                messagePreview: lastUserMsg.substring(0, 100),
              });
              return;
            }
            await writeAuditLog("agent_settled_bare_turn_matched", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              messagePreview: lastUserMsg.substring(0, 100),
            });
          }
        }
        // Empty message or extraction failure → fail-open (treat as pipeline turn)
      } catch (err) {
        // Fail-open: gate error must not block settle flow
        const errMsg = err instanceof Error ? err.message : String(err);
        await writeAuditLog("agent_settled_gate_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          error: errMsg,
        }, "warn");
      }

      // Phase 5 (170): Detect and audit run truncation / transient failure.
      // Single shared implementation (detectLastRunHealth) consumed here for audit
      // and by prompt_injector for next-turn warning injection (DRY).
      try {
        const health = detectLastRunHealth(ctx._ctx as Parameters<typeof detectLastRunHealth>[0]);
        if (health.kind === "truncated" && health.messageId && health.messageId !== meta.lastTruncatedAuditMsgId) {
          await writeAuditLog("run_truncated", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
            messageId: health.messageId,
          }, "warn");
          ctx.session.updateMeta({ lastTruncatedAuditMsgId: health.messageId });
        } else if (health.kind === "failed_transient" && health.messageId) {
          await writeAuditLog("run_failed_transient", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
            messageId: health.messageId,
          }, "warn");
          // 189 Bug 1: auto re-spawn on transient failure for develop/fix stages
          await maybeRespawnAfterTransientFailure(ctx, config, meta, health, ui);
        }
      } catch (err) {
        // Fail-open: truncation detection must never block the settle flow
        const errMsg = err instanceof Error ? err.message : String(err);
        await writeAuditLog("run_health_detect_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          error: errMsg,
        }, "warn");
      }

      // C2: Idempotent guard — skip verification if stage_advance already ran this turn
      // This prevents duplicate verification noise after manual advance via tool.
      if (meta.advancedThisTurn === true) {
        await writeAuditLog("hook_skip_after_manual_advance", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: "advancedThisTurn=true, stage_advance already verified this turn",
        });
        // Clear the flags to prevent residual state
        ctx.session.updateMeta({ advancedThisTurn: undefined, reviewConclusionDeclared: undefined });
        return;
      }

      // Phase 0 (182) G5: Advance liveness guard.
      // While the expected stage executor (any source — plugin-dispatched or
      // manual/out-of-band) is live, the owner settle must NOT trigger auto-advance.
      // This prevents the race condition where the owner settle fires before the
      // child executor has finished, causing premature stage advancement.
      //
      // Fail-open: when both probes return null/miss (unknown), advance is allowed
      // to proceed (preserves existing automation behavior).
      // Child sessions skip this guard (they have their own settle semantics).
      try {
        const { isChild } = detectSessionRole(ctx);
        if (!isChild) {
          const expectedAgent = resolveAgentMention(config, meta.currentStage);
          if (expectedAgent) {
            const evidenceHit = scanActiveSpawnEvidence(meta.activeSpawns, expectedAgent);
            const nameProbeHit = !evidenceHit ? findLiveAgentByName(expectedAgent) : null;
            const liveEvidence = evidenceHit ?? (nameProbeHit ? { basis: "manual_live_probe" as const, agentId: nameProbeHit.agentId, stage: meta.currentStage } : null);
            if (liveEvidence) {
              // Phase 8 (195 Bug T2): the deferral cap applies ONLY to
              // probe-unavailable deferrals. A "reserved" basis means the spawn
              // registry holds a reservation the probe could not confirm as a
              // live executor — deferring on it forever would strand the
              // pipeline on a stale entry (issue-20-D). Positive evidence
              // ("probe_live" / "manual_live_probe") keeps G5's unbounded
              // deferral: the owner MUST wait while the executor verifiably
              // runs (194 handoff-ledger contract depends on this).
              if (liveEvidence.basis !== "reserved") {
                if (meta.probeDeferralCount !== undefined || meta.probeDeferralStage !== undefined) {
                  ctx.session.updateMeta({ probeDeferralCount: undefined, probeDeferralStage: undefined });
                }
                await writeAuditLog("advance_deferred_stage_agent_live", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                  expectedAgent,
                  basis: liveEvidence.basis,
                  ...(liveEvidence.agentId ? { agentId: liveEvidence.agentId } : {}),
                });
                return;
              }
              // Reserved-basis deferral: count consecutively per stage
              // (counter resets when currentStage changes — plan Phase 8 boundary).
              const baseCount = meta.probeDeferralStage === meta.currentStage ? (meta.probeDeferralCount ?? 0) : 0;
              const deferralCount = baseCount + 1;
              if (deferralCount >= 2) {
                // Phase 8 (195 Bug): idempotent dedup — check if this pipelineId+stage has already been dispatched
                const dedupeKey = `${meta.pipelineId}:${meta.currentStage}`;
                const alreadyDispatched = meta.dispatchedProbeDeferrals?.[dedupeKey];
                
                if (alreadyDispatched) {
                  // Already dispatched — skip to prevent double-dispatch (N1 closure: reuses the sanctioned replay-skip event; path distinguished by reason=duplicate_dispatch_prevented)
                  await writeAuditLog("agent_settled_owner_wake_replay_skipped", {
                    pipelineId: meta.pipelineId,
                    stage: meta.currentStage,
                    expectedAgent,
                    basis: liveEvidence.basis,
                    deferralCount: String(deferralCount),
                    reason: "duplicate_dispatch_prevented",
                    previousDispatchAt: String(alreadyDispatched),
                    ...(liveEvidence.agentId ? { agentId: liveEvidence.agentId } : {}),
                  });
                  // Reset the counter and return (skip dispatch)
                  ctx.session.updateMeta({ probeDeferralCount: 0, probeDeferralStage: undefined });
                  return;
                }
                
                // Give up deferring after 2 consecutive deferrals
                await writeAuditLog("probe_gave_up_after_delay", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                  expectedAgent,
                  basis: liveEvidence.basis,
                  deferralCount: String(deferralCount),
                  reason: "max_deferral_cap_reached",
                  ...(liveEvidence.agentId ? { agentId: liveEvidence.agentId } : {}),
                });
                // Mark as dispatched and reset the counter
                ctx.session.updateMeta({
                  probeDeferralCount: 0,
                  probeDeferralStage: undefined,
                  dispatchedProbeDeferrals: {
                    ...(meta.dispatchedProbeDeferrals ?? {}),
                    [dedupeKey]: Date.now(),
                  },
                });
                // Proceed with dispatch/report (don't return, let the flow continue)
              } else {
                // Defer as usual, increment counter
                await writeAuditLog("advance_deferred_stage_agent_live", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                  expectedAgent,
                  basis: liveEvidence.basis,
                  deferralCount: String(deferralCount),
                  ...(liveEvidence.agentId ? { agentId: liveEvidence.agentId } : {}),
                });
                ctx.session.updateMeta({ probeDeferralCount: deferralCount, probeDeferralStage: meta.currentStage });
                return;
              }
            } else {
              // No live evidence — reset the deferral counter
              if (meta.probeDeferralCount !== undefined || meta.probeDeferralStage !== undefined) {
                ctx.session.updateMeta({ probeDeferralCount: undefined, probeDeferralStage: undefined });
              }
            }
          }
        }
      } catch (err) {
        // Fail-open: liveness guard error must not block the settle flow
        const errMsg = err instanceof Error ? err.message : String(err);
        await writeAuditLog("advance_guard_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          error: errMsg,
        }, "warn");
      }

      // ─── 192 Phase 3: authorized design-review flow — shared verification
      // then domain consumption. ready/running/pass_ready/paused are ALL
      // handled here (never fall back to ordinary branches, F05). Ordinary
      // flows continue untouched below (K06).
      try {
        const freshMeta = (ctx.session.getMeta() as SessionMeta | undefined) ?? meta;
        const drFlow = classifyDesignReviewFlow(freshMeta);
        if (drFlow.kind === "blocked") {
          // Feature present but identity invalid → pending takeover, never ordinary.
          await writeAuditLog("design_review_blocked_takeover", {
            pipelineId: freshMeta.pipelineId,
            stage: freshMeta.currentStage,
            reason: drFlow.reason ?? "identity_incomplete",
          }, "warn");
          ui.notify(ctx, `Design-review loop identity incomplete — awaiting owner takeover.`);
          return;
        }
        if (drFlow.kind === "authorized") {
          // child sessions NEVER consume reports or change phases (D11/F05)
          const { isChild } = detectSessionRole(ctx);
          if (isChild) {
            await writeAuditLog("design_review_child_settle_deferred", {
              pipelineId: freshMeta.pipelineId,
              stage: freshMeta.currentStage,
              round: String(drFlow.state?.round ?? 0),
            });
            return;
          }
          const coordinatorCtx = createDesignReviewRuntimeContext({
            config,
            session: ctx.session,
            // 193 Phase 3 (task 1): UI/actor assembly lives in ONE builder —
            // receiver-preserving notify/select binding + role evidence.
            interactionSource: "auto",
            roleCtx: ctx,
            rawUi: ctx.ui,
            pi: ctx.pi,
          });
          const runningPhase = drFlow.state?.phase === "review_running" || drFlow.state?.phase === "update_running";
          let vrForCoordinator: Awaited<ReturnType<typeof runVerification>> | undefined;
          if (runningPhase) {
            // Hook-level shared verification: agent-settled → runVerification
            // → domain consumption (the ONLY consumption path).
            const assistantMessages = extractAssistantMessages(ctx._ctx);
            const toolCallRecords = extractToolCallRecords(ctx._ctx);
            vrForCoordinator = await runVerification(config, freshMeta, assistantMessages, {
              ...verifyOptions,
              toolCallRecords,
            });
          }
          const coordinatorResult = await coordinateDesignReview(
            { ...coordinatorCtx, ...(vrForCoordinator ? { verificationResult: vrForCoordinator } : {}) },
            freshMeta,
            "settle",
          );
          if (coordinatorResult.status === "handled") {
            if (coordinatorResult.action === "frozen") {
              // 192 Phase 4 (task 8): budget exhaustion must ACTUALLY freeze
              // the pipeline (flowState blocked + decision menu) — a returned
              // "frozen" string alone leaves the loop running.
              await freezeAndPrompt(
                { session: ctx.session, ui: ctx.ui, pi: ctx.pi, _ctx: ctx._ctx } as Parameters<typeof freezeAndPrompt>[0],
                ctx.session.getMeta() ?? freshMeta,
                coordinatorResult.reason,
                config,
                { ui: ctx.ui },
              );
            }
            if (coordinatorResult.action === "verify_failed" && runningPhase) {
              // 193 Phase 0 (task 5): ONE shared, honest consumer. The hook entry
              // consumes with method="rule" (ordinary retry budget + wake policy)
              // and never reports success for a non-advanced action. Report-domain
              // failures carry the complete corrective template; every other
              // failure keeps its existing feedback text.
              await consumeDesignReviewResult({
                result: coordinatorResult,
                meta: ctx.session.getMeta() ?? freshMeta,
                entry: "hook",
                ctx: {
                  session: ctx.session,
                  ui: ctx.ui,
                  pi: ctx.pi,
                  _ctx: ctx._ctx,
                  config,
                } as Parameters<typeof applyVerifyFail>[0],
                config,
                ui,
                runtimeCtx: ctx,
              });
            }
            return;
          }
          // not-applicable (identity released/terminal) → continue ordinary path
        }
      } catch (err) {
        // 193 Phase 3 (task 3): the error is audited against the taken-over
        // domain first; then the ownership of the CURRENT authoritative
        // state decides the boundary:
        // - domain still owns the flow (active/blocked design-review loop):
        //   FAIL CLOSED — fall through to the ordinary settle could advance
        //   or re-verify stages the loop owes, so the handler RETURNS.
        // - no domain involvement: keep the historical fail-open boundary
        //   (an unexpected wiring error must not kill ordinary settles;
        //   frozen decisions for other features stay unchanged).
        const errMsg = err instanceof Error ? err.message : String(err);
        await writeAuditLog("design_review_hook_flow_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          error: errMsg,
          stack: err instanceof Error && err.stack !== undefined ? err.stack : "",
        }, "error");
        let domainOwnsFlow = false;
        try {
          const latestMeta = (ctx.session.getMeta() as SessionMeta | undefined) ?? meta;
          domainOwnsFlow = classifyDesignReviewFlow(latestMeta).kind !== "ordinary";
        } catch {
          // Unreadable state: preserve the pre-existing fail-open boundary.
          domainOwnsFlow = false;
        }
        if (domainOwnsFlow) {
          return;
        }
      }

      // 163 Goal 2: audit when review stage settles without a reviewConclusion declaration.
      // The model should have called stage_advance({ reviewConclusion }) explicitly.
      // Falling back to verify + manual confirm gate is safe (no deadlock) but suboptimal.
      // When reviewConclusionDeclared=true, the declaration was made but the stage did not
      // advance (verify fail / confirm gate pending / overflow pending) — skip the
      // false-positive "missing" audit and clear the flag.
      // Bug 4: Review decision chain — parse review report for auto/manual routing
      let reviewDefaultReject: boolean | undefined;
      if (meta.currentStage === "review") {
        const reviewStageConfig = config.stages[meta.currentStage];
        if (meta.reviewConclusionDeclared === true) {
          // Declaration was made but stage did not advance — clear the consumed flag
          ctx.session.updateMeta({ reviewConclusionDeclared: undefined });
        } else {
          const confirmMode = reviewStageConfig?.confirm?.mode ?? "auto";

          // Phase 2 / 176: load verdict anchors from the deployed verify.md.
          const { anchors: reviewAnchors, issues: reviewAnchorIssues } =
            await loadVerifyContractAnchors(config, "review");
          const reviewVerdict = await parseReviewConclusion(config.projectRoot, reviewAnchors);

          if (reviewVerdict?.source === "contract-unavailable") {
            // Fail-open: verdict anchor unavailable → fall back to the undeclared
            // branch (audit + notify), then continue to verify + confirm gate.
            await writeAuditLog("contract_anchor_unavailable", {
              pipelineId: meta.pipelineId,
              stage: "review",
              missingKeys: "verdict",
              issues: reviewAnchorIssues.join("; "),
            }, "error");
            await writeAuditLog("review_declaration_missing", {
              pipelineId: meta.pipelineId,
              stage: "review",
              reason: "contract_anchor_unavailable",
            }, "warn");
            if (shouldEmitWithinWindow(`contract_anchor_unavailable:review:${meta.pipelineId}`, AUDIT_THROTTLE_WINDOW_MS)) {
              ui.notify(ctx, "Review verdict runtime contract anchor unavailable in verify.md. Falling back to the undeclared reviewConclusion branch. Run /pipeline-init to restore the default declarations.");
            }
            if (confirmMode === "manual") {
              reviewDefaultReject = true;
            }
          } else if (confirmMode !== "manual") {
            // Auto mode (or unconfigured): parse report → route directly
            if (reviewVerdict && reviewVerdict.verdict === "fail") {
              await routeReviewFailAuto(config, ctx, meta, ui, {
                reason: `review report parsed as fail (source: ${reviewVerdict.source})`,
              });
              if (reviewVerdict.warn) {
                await writeAuditLog("review_auto_route_warn", {
                  pipelineId: meta.pipelineId,
                  stage: "review",
                  warn: reviewVerdict.warn,
                }, "warn");
              }
              return;
            }
            // pass or null→already covered by fail → fall through to verify + autoAdvance
          } else {
            // Manual mode: parse report for preselect
            // preselect: fail → defaultReject=true, pass → defaultReject=false, null → defaultReject=true
            reviewDefaultReject = reviewVerdict
              ? reviewVerdict.verdict === "fail"
              : true; // No report → conservative reject default
          }
        }
      }

      // Phase 4 (162): confirm gate wiring.
      const ctxWithPi = { ...ctx, pi: ctx.pi, config };

      // 2. Auto-verification
      const stageConfig = config.stages[meta.currentStage];
      if (!stageConfig.verify?.require) {
        return;
      }

      // Tool mode: skip hook-based verification — agent calls pipeline_verify tool explicitly
      if (stageConfig.verify.mode === "tool") {
        // 194 Phase 3 (task 3): a bound closed-loop run records its VISIBLE
        // waiting state before the skip, so "deferred to the owner tool" is
        // persisted truth instead of silence.
        await recordBoundConsumptionWait(ctx, meta, "awaiting-owner-tool");
        await writeAuditLog("verify_mode_tool_skip", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: "verify.mode=tool, verification deferred to pipeline_verify tool",
        });
        return;
      }

      // Phase 4 (162): Smart confirm short-circuit — defer to stage_advance tool.
      // Smart mode uses the stage_advance tool's needConfirm parameter to declare complexity,
      // so the hook should not run verification or auto-advance.
      if (stageConfig.confirm?.mode === "smart") {
        // 194 Phase 3 (task 3): record the visible waiting state BEFORE the
        // skip — a bound run awaiting the owner's confirm path must never
        // settle into silence (the exact "silent running" this plan removes).
        await recordBoundConsumptionWait(ctx, meta, "awaiting-confirmation");
        await writeAuditLog("confirm_smart_defer_to_tool", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: "smart confirm defers verification+advance to stage_advance tool",
        });
        return;
      }

      // 168 Phase 0: Pre-check required files before running full verification.
      // If required deliverables are not yet produced, skip verification silently
      // (no counting, no freezing, no notify — same semantic as completionMarker pending).
      // Aligns with pipeline-verify.ts L120 and stage-advancer.ts L849 precheck pattern.
      const precheck = await precheckRequiredFiles(config, meta);
      if (!precheck.passed) {
        await writeAuditLog("verify_precheck_deferred", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          missing: precheck.missing.join(", "),
        });
        // Lightweight hint via ui.notify — does NOT count, freeze, or wake;
        // only surfaces to the in-turn context so the model knows why verification
        // was skipped and is nudged to produce the missing deliverable first.
        ui.notify(ctx, `Required deliverables not yet produced (${precheck.missing.join(", ")}). Please generate them before the pipeline can verify this stage.`);
        return;
      }

      // Phase 1 (172) G3: await-answer defer for clarify stage.
      // If the latest clarification round is waiting for a user answer, defer verification
      // entirely — no counting, no freezing, no wake. This prevents the 88_Feat accident
      // where the model settles before the user has written the answer, triggering
      // auto_verify_fail cascading to verify_attempt_overflow freeze.
      if (meta.currentStage === "clarify") {
        try {
          const awaitCheck = await precheckClarifyAwaitAnswer(config, meta);
          if (awaitCheck.awaiting) {
            await writeAuditLog("verify_await_answer_deferred", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              round: String(awaitCheck.round ?? 0),
            });
            // Phase 1 / 179 (G2 layer ②): interpolate the real document path and
            // agent name so the hint is a copy-pasteable command line (the old text
            // emitted the literal "{file}" placeholder and a generic "@agent").
            const clarifyAgent = resolveAgentMention(config, "clarify") ?? "agent";
            const clarifyDoc = meta.requirementDoc ?? "<requirement-doc>";
            ui.notify(
              ctx,
              `Clarify round ${awaitCheck.round} is awaiting your answer. ` +
                `Please write your answer in the requirement document (答：...) then re-mention ` +
                `@${clarifyAgent} ${clarifyDoc} ${awaitCheck.round} 答 ` +
                `(or @${clarifyAgent} ${clarifyDoc} full-und? to finalize).`,
            );
            return;
          }
        } catch {
          // Fail-open: defer check failure must not block the settle flow
        }
      }

      // CompletionMarker precheck: if configured, verify the marker has been
      // written to the requirement doc before running verification.
      // Phase 1 (170): Distinguish "doc unbound" from "doc bound but marker not yet written".
      // - Unbound: audit `verify_completion_marker_unbound` + throttled ui.notify with escape hatch.
      // - Bound but pending: maintain existing silent semantics (168 decision).
      const marker = stageConfig.verify.completionMarker;
      if (marker && !await precheckCompletionMarker(meta, marker, config.projectRoot)) {
        if (!meta.requirementDoc) {
          // Phase 3 (171): settle-retry binding — at settle time, first user message
          // must be on disk. Try to extract and bind the requirement doc path.
          // This recovers from JOIN bind-miss (Phase 0 audit) without user intervention.
          try {
            const firstUserMsg = extractFirstUserMessageText(ctx._ctx as Parameters<typeof extractFirstUserMessageText>[0]);
            const parsedPath = parseRequirementDocPath(firstUserMsg);
            if (parsedPath) {
              ctx.session.updateMeta({ requirementDoc: parsedPath });
              await writeAuditLog("requirement_doc_bound", {
                pipelineId: meta.pipelineId,
                stage: meta.currentStage,
                requirementDoc: parsedPath,
                source: "settle_retry",
              });
              // Doc now bound — continue to marker check below (do not return)
              // Fall through to the normal verification flow
            } else {
              // Still no doc — audit + notify as before
              await writeAuditLog("verify_completion_marker_unbound", {
                pipelineId: meta.pipelineId,
                stage: meta.currentStage,
                marker,
              });
              if (shouldNotifyAndStamp(meta, "lastUnboundNotifiedAt", AUDIT_THROTTLE_WINDOW_MS)) {
                ctx.session.updateMeta({ lastUnboundNotifiedAt: Date.now() });
                ui.notify(ctx, `Requirement document not bound. Run /pipeline-start <requirement-doc> to bind and resume.`);
              }
              return;
            }
          } catch {
            // Fail-open: binding error must not block settle
            await writeAuditLog("verify_completion_marker_unbound", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              marker,
            });
            return;
          }
        } else {
          // Doc is bound but marker not yet written — silent skip (existing semantics)
          await writeAuditLog("verify_completion_marker_pending", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
            marker,
          });
        }
        return;
      }

      // Phase 4 (162): auto-write confirm marker for plan stage (auto mode).
      // This writes the bilingual marker before verify runs, so the verify rule
      // passes naturally without needing deferral.
      await autoWriteConfirmMarker(config, ctxWithPi, meta, ui);

      // Extract assistant messages from session branch for verification
      const assistantMessages = extractAssistantMessages(ctx._ctx);
      // Extract tool call records for selfVerifySkip (model self-verified commands)
      const toolCallRecords = extractToolCallRecords(ctx._ctx);

      // Phase 4 (162): defer plan marker rule when confirm mode is manual (C2 fix).
      // Smart mode is already handled above (returns early).
      const deferPatterns = shouldDeferPlanMarkerRule(meta.currentStage, stageConfig) ? [PLAN_CONFIRM_MARKER_RULE] : [];

      const vr = await runVerification(
        config,
        meta,
        assistantMessages,
        { ...verifyOptions, toolCallRecords, deferContentPatterns: deferPatterns },
      );

      // Build the shared result shape consumed by applyVerifyPass/applyVerifyFail
      const sharedResult = {
        structuredResult: vr.structuredResult,
        ruleMissing: vr.ruleMissing,
        verifyResult: vr.verifyResult ?? null,
        // Phase 9: pass rule set identity fields for audit and owner-visible messages
        rulesSource: vr.rulesSource,
        rulesParsed: vr.rulesParsed,
        selfVerifySkip: vr.selfVerifySkip,
        parseError: vr.parseError,
      };

      // 148 Phase 3: Config-error skip → treat as pass with notify/audit
      if (vr.skipped) {
        const errorSummary = vr.configErrors?.join("; ") ?? "unknown config error";
        ui.notify(ctx, `Verification config error: ${errorSummary}. Verification skipped. See guide.md for correct rule syntax.`);
        await writeAuditLog("verify_config_skip", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          errorCount: String(vr.configErrors?.length ?? 0),
          errors: errorSummary,
        }, "warn");
        // Treat as pass → auto-advance (reuse pass channel with ctxWithPi for wake)
        // M1 fix: skipPassAudit=true — skipped must NOT write auto_verify_pass audit
        const fromStage = meta.currentStage;
        const toStage = stageConfig.nextStage;
        await autoAdvanceAfterVerify(config, ctxWithPi, meta, fromStage, toStage, sharedResult, ui, { skipPassAudit: true });
        // Phase 4 (169) P2-6 fix: after autoAdvance, if we landed on completed, invoke
        // terminal compact helper. Covers the verify_config_skip→completed path where
        // neither W1 (pre-advance) nor W2 (gate-handled) fires. Without this, compaction
        // is deferred until the next user interaction (or never, if the session idles).
        await compactIfTerminal(ctx, config);
        return;
      }

      if (vr.rulePassed) {
        // Phase 4 (162): manual confirm gate — intercept verify-pass to show TUI dialog.
        if (stageConfig.confirm?.mode === "manual") {
          // Phase 1 / 181: capture the role once; sessionFile feeds the child
          // suppression audit, isChild drives the zero-side-effect bypass.
          const { isChild, sessionFile } = detectSessionRole(ctx);
          const reask = meta.confirmGateReask;
          // Phase 4 / 179 (G5/G7): bounded re-ask raised 1 → 3 so a collateral
          // Esc from a subagent window does not deadlock the gate on first miss.
          const reaskExhausted = reask?.stage === meta.currentStage && reask.count >= CONFIRM_GATE_REASK_MAX;
          // Phase 3 / 177 (D5b): owner-only bounded auto re-ask. After the cap,
          // only notify (no popup) to avoid a dialog storm (173-C11 semantics).
          if (!isChild && reaskExhausted) {
            ui.notify(ctx, formatConfirmGatePendingCopy(config, meta.currentStage));
            return;
          }
          const gate = await maybeHandleConfirmGate(config, ctxWithPi, meta, ui, {
            mode: "manual",
            isChild,
            sessionFile,
            ...(reviewDefaultReject !== undefined ? { defaultReject: reviewDefaultReject } : {}),
          });
          if (gate.result === "handled") {
            // Phase 3 / 180: shared accounting helper (extracted from this block).
            // Phase 4 / 179 fix semantics preserved: only real dismisses (Esc / no UI)
            // count towards the re-ask budget. System deferrals (subagent still live)
            // must NOT consume the bounded re-arm count — otherwise the timeout
            // fallback ("pop anyway + hint" after spawnWaitTimeoutMs) becomes
            // unreachable (fb9822d).
            recordConfirmGateOutcome(ctx.session, meta, gate, isChild, ctx);
            // Phase 4 (169) W2: After confirm gate handled, re-read meta and check if completed.
            // Covers T2 (hook path with no subsequent settle) — same dispatch, idle-safe.
            // P2-6 fix: also covers the "routed" action defensively (routeConfirmReject
            // currently targets clarify/fix, not completed, but the helper is a no-op
            // on non-completed meta, so including it is safe and future-proof).
            if (gate.action === "advanced") {
              await compactIfTerminal(ctx, config);
            }
            // advanced / routed / pending / aborted — all handled by confirm gate, skip autoAdvance
            return;
          }
          // no-gate (marker already present) — fall through to autoAdvanceAfterVerify
        }

        // Capture stage names BEFORE advance mutates meta.currentStage
        const fromStage = meta.currentStage;
        const toStage = stageConfig.nextStage;

        // Reuse ctxWithPi (declared above for gate) for autoAdvanceAfterVerify wake message
        await autoAdvanceAfterVerify(config, ctxWithPi, meta, fromStage, toStage, sharedResult, ui);
        // Phase 4 (169) P2-6 fix: after autoAdvance, if we landed on completed, invoke
        // terminal compact helper. Covers the no-gate→completed path where neither
        // W1 (pre-advance) nor W2 (gate-handled) fires.
        await compactIfTerminal(ctx, config);
      } else {
        // 148 Phase 4: pass ctxWithPi so applyVerifyFail can send wake message via pi.sendUserMessage
        await applyVerifyFail(ctxWithPi, meta, meta.currentStage, sharedResult, "rule", ui, config);
      }
    },
  };
}

/**
 * Phase 1 / 179 (G2 layer ①): Detects a "bare" pipeline turn — a user message
 * that starts with the bound requirement document path followed by a round
 * argument, but lacks the `@agent` prefix the static signatures require.
 *
 * This covers the `agentMentions:"model"` deployment where pi-subagents rewrites
 * the @mention and the on-disk user message degrades to bare text.
 *
 * Examples (requirementDoc = "docs/design/x.md"):
 *   "docs/design/x.md 2 答"      → true
 *   "docs/design/x.md full-und?" → true
 *   "docs/design/x.md 1"         → true
 *   "docs/design/other.md 2 答"  → false (different doc — no false hit)
 *
 * Returns false when requirementDoc is unbound, preserving the existing
 * fail-open-to-non-pipeline behavior.
 *
 * @param message - The last user message text
 * @param requirementDoc - The bound requirement document path (if any)
 */
function isBarePipelineTurn(message: string, requirementDoc: string | undefined): boolean {
  if (!requirementDoc) return false;
  const pattern = new RegExp(
    `^${escapeRegExp(requirementDoc)}\\s*(\\d+\\s*答|full-und\\?|\\d+$)`,
  );
  return pattern.test(message);
}

/**
 * 194 Phase 3 (task 3): record the VISIBLE C5 waiting state on the current
 * closed-loop run BEFORE a tool/smart skip returns. Applies only when the
 * session's CURRENT stage is the one bound to an un-consumed run; every
 * failure is audited and never blocks the settle flow (the skip itself is
 * the pre-existing behavior).
 */
async function recordBoundConsumptionWait(
  ctx: RuntimeCtx,
  meta: SessionMeta,
  state: "awaiting-owner-tool" | "awaiting-confirmation",
): Promise<void> {
  const run = meta.stageExecutorRun;
  if (!run || run.terminalConsumed || run.binding.stage !== meta.currentStage) return;
  try {
    await recordAwaitingOwnerConsumption({ session: ctx.session, run, state });
  } catch (err) {
    // The wait record is a diagnostic C5 convenience: its failure must never
    // convert the benign skip below into an error path.
    await safeWriteAuditLog("owner_consumption_wait_error", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      state,
      error: err instanceof Error ? err.message : String(err),
    }, "warn");
  }
}

/**
 * Phase 4 (169) P2-6 helper: re-read fresh meta and, if the pipeline is now
 * at "completed", invoke the terminal compaction helper exactly once.
 *
 * Shared across the vr.skipped / no-gate / gate-advanced paths so that every
 * "autoAdvance landed on completed" scenario is covered (W2 generalization).
 * The helper's internal consumed-flag guard ensures no double-compact even if
 * W1 or an earlier invocation already ran.
 */
async function compactIfTerminal(
  ctx: { session: { getMeta: () => SessionMeta | undefined }; ui: { notify?: (msg: string) => void }; _ctx?: Parameters<typeof maybeCompactOnPipelineCompleted>[0]["_ctx"] },
  config: PipelineConfig,
): Promise<void> {
  const freshMeta = ctx.session.getMeta() as SessionMeta | undefined;
  if (freshMeta?.currentStage === "completed") {
    await maybeCompactOnPipelineCompleted(
      { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx } as Parameters<typeof maybeCompactOnPipelineCompleted>[0],
      config,
    );
  }
}

/**
 * 189 Bug 1: Auto re-spawn stage executor after transient failure.
 *
 * Guards (all must pass):
 * - Stage is develop or fix (re-spawn timing)
 * - 194 Phase 3 task 7: no UNCONSUMED closed-loop executor run (a live run
 *   must never be re-dispatched; a failed run parks on the owner's explicit
 *   D4 recovery instead of the automatic respawn)
 * - Pipeline not aborted and user did not quit
 * - Dedup: messageId !== lastTransientRespawnMsgId
 * - Precheck fails (stage genuinely incomplete)
 *
 * Retry budget: transientRetryCount <= TRANSIENT_RETRY_MAX (2).
 * Over limit → freezeAndPrompt with reason "transient_retry_overflow".
 * Otherwise: increment count, clear stale spawns, spawn with breakpoint prompt.
 *
 * Fail-open: all logic wrapped in try/catch to never block settle flow.
 *
 * @internal Exported for unit testing
 */
export async function maybeRespawnAfterTransientFailure(
  ctx: RuntimeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  health: { messageId?: string },
  ui: ReturnType<typeof createPipelineUI>,
): Promise<void> {
  try {
    const stage = meta.currentStage;

    // Guard 1: only develop/fix stages
    if (stage !== "develop" && stage !== "fix") {
      return;
    }

    // Guard 1.5 (194 Phase 3 task 7, C3/D4): closed-loop executor ownership
    // takes precedence over the 189 auto-respawn bypass. While the latest
    // executor run is live (running/unknown) any re-dispatch is forbidden;
    // while a terminal run still awaits owner consumption or recovery
    // (terminalConsumed=false) the owner-side C5/D4 paths decide the next
    // step. Auto-respawning here would clear spawn records and bypass the
    // failure budget. Ordinary develop/fix without an executor run is
    // unchanged.
    const executorRun = meta.stageExecutorRun;
    if (executorRun && !executorRun.terminalConsumed) {
      await writeAuditLog("transient_respawn_closed_loop_gated", {
        pipelineId: meta.pipelineId,
        stage,
        runId: executorRun.binding.runId,
        runStage: executorRun.binding.stage,
        status: executorRun.status,
        recovery: executorRun.recovery,
        live: String(hasLiveExecutorRun(meta)),
      }, "warn");
      return;
    }

    // Guard 2: not aborted and user did not quit
    const flowState = getFlowState(meta);
    if (flowState === "aborted" || meta.terminateReason === "user_quit") {
      return;
    }

    // Guard 3: dedup by messageId
    if (!health.messageId || health.messageId === meta.lastTransientRespawnMsgId) {
      return;
    }

    // Guard 4: precheck must fail (stage genuinely incomplete)
    const precheck = await precheckRequiredFiles(config, meta);
    if (precheck.passed) {
      // Stage is complete, let normal verification flow continue
      return;
    }

    // Check retry budget
    const retryCount = meta.transientRetryCount ?? 0;
    if (retryCount >= TRANSIENT_RETRY_MAX) {
      // Over limit → freeze pipeline via freezeAndPrompt (reuses blocked machinery)
      await writeAuditLog("transient_retry_overflow_frozen", {
        pipelineId: meta.pipelineId,
        stage,
        attempt: String(retryCount),
      }, "warn");
      await freezeAndPrompt(ctx, meta, "transient_retry_overflow", config, {
        onStageChanged: buildOnStageChangedCallback(ctx, config),
      });
      return;
    }

    // Increment retry count and stamp messageId
    const newCount = retryCount + 1;
    ctx.session.updateMeta({
      transientRetryCount: newCount,
      lastTransientRespawnMsgId: health.messageId,
    });

    // Clear stale spawn guards so re-spawn is not blocked by duplicate guard
    ctx.session.updateMeta({
      spawnedStages: { ...meta.spawnedStages, [stage]: undefined },
      activeSpawns: { ...meta.activeSpawns, [stage]: undefined },
    });

    // Compose breakpoint prompt from missing files
    const missingList = precheck.missing.join(", ");
    const extraArgs = `\n\n[plugin auto-respawn] Previous run terminated unexpectedly (transient failure). Read ${missingList} first: phases whose commit ids are already registered are DONE — resume from the first unregistered phase; never re-execute completed phases.`;

    // Spawn the stage executor with breakpoint prompt
    const freshMeta = ctx.session.getMeta() as SessionMeta;
    const spawnResult = await spawnStageSubagent(
      (ctx as { pi?: unknown }).pi,
      config,
      stage,
      freshMeta,
      {
        ui: { notify: (msg: string) => ui.notify(ctx, msg) },
        session: ctx.session,
        runtimeCtx: ctx,
        extraArgs,
      },
    );

    // Determine basis for audit: rpc (normal spawn), fallback (followUp), or pending_queued (child→owner route)
    const basis = isChildRuntimeCtx(ctx)
      ? "pending_queued"
      : spawnResult.fallback
        ? "fallback"
        : "rpc";

    // Audit the re-spawn
    await writeAuditLog("transient_auto_respawn", {
      pipelineId: meta.pipelineId,
      stage,
      attempt: String(newCount),
      basis,
      missing: missingList,
    });
  } catch (err) {
    // Fail-open: re-spawn error must never block settle flow
    const errMsg = err instanceof Error ? err.message : String(err);
    await writeAuditLog("transient_respawn_error", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      error: errMsg,
    }, "warn");
  }
}
