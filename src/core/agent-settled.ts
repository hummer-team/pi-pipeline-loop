/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state,
 * and optionally runs auto-verification if the stage has a verify block.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { runVerification, precheckCompletionMarker, precheckRequiredFiles } from "./auto-verifier";
import type { RunVerificationOptions } from "./auto-verifier";
import { writeAuditLog } from "../utils/auditLog";
import { applyVerifyFail, autoAdvanceAfterVerify } from "./verify-advance";
import { createPipelineUI } from "./pipeline-ui";
import { extractAssistantMessages, extractToolCallRecords } from "./session-state";
import { isFrozen, formatFrozenReason, promptDecisionMenu } from "./flow-state";
import type { RuntimeCtx } from "./runtime-ctx";
import {
  PLAN_CONFIRM_MARKER_RULE,
  shouldDeferPlanMarkerRule,
  autoWriteConfirmMarker,
  maybeHandleConfirmGate,
  routeReviewFailAuto,
} from "./stage-advancer";
import { parseReviewConclusion } from "../utils/review-conclusion";
import { maybeCompactOnPipelineCompleted } from "./terminal-compact";

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
      const meta = ctx.session.getMeta() as SessionMeta;

      // 1. Write audit log
      await writeAuditLog("agent_settled", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
      });

      ui.notify(ctx, `Agent settled in "${meta.currentStage}" stage`);

      // Phase 4 (169) W1: Terminal compaction check — BEFORE frozen and advancedThisTurn
      // short-circuits, so that T1 settle (carrying advancedThisTurn=true) still triggers compact.
      // The helper internally guards against non-completed, already-consumed, and busy states.
      await maybeCompactOnPipelineCompleted(
        { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx } as Parameters<typeof maybeCompactOnPipelineCompleted>[0],
        config,
      );

      // 1b. Frozen short-circuit: skip verification when pipeline is frozen
      if (isFrozen(meta)) {
        await writeAuditLog("agent_settled_skipped_frozen", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
        });
        ui.notify(ctx, `Pipeline frozen: ${formatFrozenReason(meta)}. Open the decision menu to proceed.`);
        // 168 Phase 2: auto re-popup decision menu while frozen
        // Phase 4 (169) P2-5 fix: pass `_ctx` so W3 skip→completed decisions
        // triggered from the frozen menu can invoke terminal compaction. Without
        // _ctx, the skip→completed path in flow-state.ts:224 early-returns
        // (short-cut key entry remains unaffected — it passes _ctx directly).
        await promptDecisionMenu(
          { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx } as Parameters<typeof promptDecisionMenu>[0],
          meta,
          config,
        );
        return;
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
          const reviewVerdict = await parseReviewConclusion(config.projectRoot);

          if (confirmMode !== "manual") {
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

      // CompletionMarker precheck: if configured, verify the marker has been
      // written to the requirement doc before running verification.
      // When marker is not found: skip verification, do NOT advance, do NOT
      // increment verifyAttempts (prevents freeze loop on interactive stages).
      const marker = stageConfig.verify.completionMarker;
      if (marker && !await precheckCompletionMarker(meta, marker, config.projectRoot)) {
        await writeAuditLog("verify_completion_marker_pending", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          marker,
        });
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
          const gate = await maybeHandleConfirmGate(config, ctxWithPi, meta, ui, {
            mode: "manual",
            ...(reviewDefaultReject !== undefined ? { defaultReject: reviewDefaultReject } : {}),
          });
          if (gate.result === "handled") {
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
