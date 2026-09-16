/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state,
 * and optionally runs auto-verification if the stage has a verify block.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { runVerification, precheckCompletionMarker, precheckRequiredFiles, precheckClarifyAwaitAnswer } from "./auto-verifier";
import type { RunVerificationOptions } from "./auto-verifier";
import { writeAuditLog } from "../utils/auditLog";
import { applyVerifyFail, autoAdvanceAfterVerify } from "./verify-advance";
import { createPipelineUI } from "./pipeline-ui";
import { extractAssistantMessages, extractToolCallRecords, detectLastRunHealth } from "./session-state";
import { isFrozen, getFlowState, formatFrozenReason, promptDecisionMenu, formatAbortedNotifyText, scheduleDecisionRetry, formatDecisionMenuHint } from "./flow-state";
import { isDormant } from "./dormancy";
import type { RuntimeCtx } from "./runtime-ctx";
import {
  PLAN_CONFIRM_MARKER_RULE,
  shouldDeferPlanMarkerRule,
  autoWriteConfirmMarker,
  maybeHandleConfirmGate,
  routeReviewFailAuto,
  formatConfirmGatePendingCopy,
} from "./stage-advancer";
import { parseReviewConclusion } from "../utils/review-conclusion";
import { maybeCompactOnPipelineCompleted } from "./terminal-compact";
import { shouldNotifyAndStamp, shouldEmitWithinWindow } from "../utils/audit-throttle";
import { loadVerifyContractAnchors } from "../utils/contract-loader";
import { AUDIT_THROTTLE_WINDOW_MS, CONFIRM_GATE_REASK_MAX, PIPELINE_TURN_SIGNATURES } from "../constants";
import { parseRequirementDocPath } from "../utils/doc-path";
import { extractFirstUserMessageText, extractLastUserMessageText } from "./session-state";
import { consumePendingSpawns, resolveAgentMention } from "../utils/subagent-rpc";
import { detectSessionRole } from "./session-role";
import { escapeRegExp } from "../utils/regex-utils";

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
          ui.notify(ctx, `Pipeline frozen: ${formatFrozenReason(meta)}. ${formatDecisionMenuHint(config)}`);
        }
        // 168 Phase 2: auto re-popup decision menu while frozen
        // Phase 4 (169) P2-5 fix: pass `_ctx` so W3 skip→completed decisions
        // triggered from the frozen menu can invoke terminal compaction. Without
        // _ctx, the skip→completed path in flow-state.ts:224 early-returns
        // (short-cut key entry remains unaffected — it passes _ctx directly).
        // Fix #1: if prompt returns "interrupted" (streaming dismiss), arm retry scheduler.
        const promptOutcome = await promptDecisionMenu(
          { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx } as Parameters<typeof promptDecisionMenu>[0],
          meta,
          config,
        );
        if (promptOutcome === "interrupted") {
          scheduleDecisionRetry(
            { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx } as Parameters<typeof promptDecisionMenu>[0],
            meta,
            config,
          );
        }
        return;
      }

      // Phase 2 (172) G2: Pipeline-turn source gate.
      // Pure chat settle (non-pipeline user turn) must NOT trigger verify/wake/counting/freeze.
      // Checks the last user message against known pipeline turn signatures.
      // Fail-open: extraction failure or empty message → treat as pipeline turn (conservative).
      try {
        const lastUserMsg = extractLastUserMessageText(ctx._ctx as Parameters<typeof extractLastUserMessageText>[0]);
        if (lastUserMsg.length > 0) {
          const isPipelineTurn = PIPELINE_TURN_SIGNATURES.some((sig) => {
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

      // Phase 2 / 177 (D4③/D4④): owner consumes child-routed pending spawns.
      // Child sessions enqueue `pendingSpawns[stage]` instead of spawning in place;
      // the owner performs the spawn with its own `pi`. Bounded to one attempt per
      // stage and coordinated with the 3c duplicate-spawn guard.
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
              // Fail → route to fix (no count, no select, no verify)
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
      const ctxWithPi = { ...ctx, pi: ctx.pi };

      // 2. Auto-verification
      const stageConfig = config.stages[meta.currentStage];
      if (!stageConfig.verify?.require) {
        return;
      }

      // Tool mode: skip hook-based verification — agent calls pipeline_verify tool explicitly
      if (stageConfig.verify.mode === "tool") {
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
          const isChild = detectSessionRole(ctx).isChild;
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
            ...(reviewDefaultReject !== undefined ? { defaultReject: reviewDefaultReject } : {}),
          });
          if (gate.result === "handled") {
            if (!isChild && gate.action === "pending") {
              // Record the re-ask so the next settle only hints.
              ctx.session.updateMeta({
                confirmGateReask: {
                  stage: meta.currentStage,
                  count: (reask?.stage === meta.currentStage ? reask.count : 0) + 1,
                },
              });
            } else if (!isChild && (gate.action === "advanced" || gate.action === "routed")) {
              // Gate resolved — clear the bounded re-ask bookkeeping.
              ctx.session.updateMeta({ confirmGateReask: undefined });
            }
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
