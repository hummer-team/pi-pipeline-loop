/**
 * @module design-review-coordinator
 * Phase 3 / 191: Unified decision/routing/authorization/recovery entry point for design-review stage.
 * 
 * Coordinates all design-review transitions:
 * - PASS: validate plan/report hash, develop availability, record approval receipt, advance to develop
 * - FAIL: save report/update operation, check budget, route to plan for update
 * - UPDATE complete: validate new hash, structure, budget, commit next round, re-review
 * 
 * Returns handled/pending/transitioned/not-applicable. Only not-applicable proceeds to original logic.
 */

import type { PipelineConfig, SessionMeta, DesignReviewState, DesignReviewOperation, DesignReviewPhase } from "../types";
import { verifyDesignReviewReport, extractReportIssues } from "./design-review-report";
import { loadVerifyContractAnchors } from "../utils/contract-loader";
import { validatePlanUpdate, renderDesignReviewUpdatePrompt, type DesignReviewUpdatePromptParams } from "./design-review-prompt";
import {
  isValidTransition,
  transitionPhase,
  createOperation,
  canDispatch,
  isAuthorizationValid,
  hasPlanDrifted,
  computeHash,
  deriveReportPath,
  allocateNextRound,
} from "./design-review-state";
import { commitDesignReviewState } from "./session-state";
import { prepareDesignReviewOperation, commitDesignReviewOperation, writebackDesignReviewResult, formatDesignReviewSpawnPrompt } from "../utils/design-review-dispatch";
import { recordStageVisit } from "../utils/stage-visit";
import { spawnStageSubagent } from "../utils/subagent-rpc";
import { safeWriteAuditLog } from "../utils/auditLog";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Coordinator result type.
 * - handled: coordinator took action, caller should stop
 * - pending: waiting for external action (report/update completion)
 * - transitioned: stage transition completed successfully
 * - not-applicable: design-review not active or no authorization, caller should use original flow
 */
export type CoordinatorResult =
  | { status: "handled"; action: "advanced"; toStage: string }
  | { status: "handled"; action: "routed"; toStage: string }
  | { status: "handled"; action: "pending"; reason: string }
  | { status: "handled"; action: "frozen"; reason: string }
  | { status: "not-applicable" };

/**
 * Context required for coordinator operations.
 */
export interface CoordinatorContext {
  config: PipelineConfig;
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: {
    notify: (msg: string) => void;
    transition?: (ctx: unknown, from: string, to: string) => void;
  };
  pi?: {
    sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void;
  };
}

/**
 * Main coordinator entry point.
 * Called by stage-advancer, agent-settled, pipeline-verify, pipeline-handoff.
 * 
 * @param ctx - Coordinator context
 * @param meta - Current session metadata
 * @param trigger - What triggered this call ("settle", "advance", "verify", "handoff")
 * @returns CoordinatorResult indicating action taken or not-applicable
 */
export async function coordinateDesignReview(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  trigger: "settle" | "advance" | "verify" | "handoff",
): Promise<CoordinatorResult> {
  const drState = meta.designReview;
  
  // Not in design-review flow
  if (!drState) {
    return { status: "not-applicable" };
  }

  // Authorization invalid
  if (!isAuthorizationValid(drState)) {
    await safeWriteAuditLog("design_review_coordinator", {
      trigger,
      action: "authorization_invalid",
      phase: drState.phase,
    });
    return { status: "not-applicable" };
  }

  // Handle based on current phase and trigger
  switch (drState.phase) {
    case "review_ready":
      return await handleReviewReady(ctx, meta, drState, trigger);
    
    case "review_running":
      return await handleReviewRunning(ctx, meta, drState, trigger);
    
    case "update_ready":
      return await handleUpdateReady(ctx, meta, drState, trigger);
    
    case "update_running":
      return await handleUpdateRunning(ctx, meta, drState, trigger);
    
    case "pass_ready":
      return await handlePassReady(ctx, meta, drState, trigger);
    
    case "paused":
      return await handlePaused(ctx, meta, drState, trigger);
    
    case "finished":
      return { status: "not-applicable" };
    
    default:
      return { status: "not-applicable" };
  }
}

/**
 * Handle review_ready phase: dispatch review agent.
 */
async function handleReviewReady(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  if (trigger !== "settle" && trigger !== "advance") {
    return { status: "not-applicable" };
  }

  // Check budget before dispatch
  const budgetCheck = checkBudget(meta, ctx.config);
  if (!budgetCheck.ok) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "budget_exceeded_before_review",
      currentCycle: String(meta.loopCycleCount ?? 0),
      maxCycles: String(budgetCheck.max),
    });
    return { status: "handled", action: "frozen", reason: "budget_exceeded" };
  }

  // Check if can dispatch
  if (!canDispatch(drState)) {
    return { status: "handled", action: "pending", reason: "already_dispatched" };
  }

  // Create operation
  const operation = prepareDesignReviewOperation(drState, "review", meta.stageStartTime ?? Date.now());
  if (!operation) {
    return { status: "handled", action: "pending", reason: "operation_creation_failed" };
  }

  // Commit operation to state (this also transitions to review_running)
  const committedState = commitDesignReviewOperation(ctx.session, operation, drState);
  if (!committedState) {
    return { status: "handled", action: "pending", reason: "operation_commit_failed" };
  }

  // Spawn review agent
  const spawnResult = await spawnDesignReviewAgent(ctx, meta, committedState, operation);
  if (!spawnResult.ok) {
    // Spawn failed, writeback failure
    writebackDesignReviewResult(ctx.session, operation.operationId, undefined, "failed");
    return { status: "handled", action: "pending", reason: spawnResult.error ?? "spawn_failed" };
  }

  // Writeback success
  writebackDesignReviewResult(ctx.session, operation.operationId, undefined, "dispatched");

  await safeWriteAuditLog("design_review_coordinator", {
    action: "review_dispatched",
    operationId: operation.operationId,
    round: String(drState.round),
  });

  return { status: "handled", action: "routed", toStage: "design-review" };
}

/**
 * Handle review_running phase: verify report and route based on verdict.
 */
async function handleReviewRunning(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  if (trigger !== "settle") {
    return { status: "not-applicable" };
  }

  // Load contract anchors from verify.md (Phase 3 / 191 fix #15)
  // This ensures the coordinator consumes the verify.md groups contract as the single source
  // of truth for verdict parsing, eliminating the dual source of truth problem.
  const contractResult = await loadVerifyContractAnchors(ctx.config, "design-review");
  const verdictPatterns = contractResult.anchors.verdict?.patterns;
  
  if (contractResult.issues.length > 0) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "contract_load_warning",
      issues: contractResult.issues.join("; "),
    });
  }

  // Verify report exists and is valid
  const reportPath = deriveReportPath(drState.planDoc, drState.round);
  const verification = verifyDesignReviewReport(
    reportPath, 
    drState.planDoc, 
    drState.round,
    verdictPatterns // Pass contract patterns for verdict extraction
  );

  if (verification.verdict === "invalid") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "report_invalid",
      reportPath,
      reason: verification.reason,
    });
    return { status: "handled", action: "pending", reason: "report_invalid" };
  }

  // Check budget before transition
  const budgetCheck = checkBudget(meta, ctx.config);
  if (!budgetCheck.ok) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "budget_exceeded_before_routing",
      verdict: verification.verdict,
      currentCycle: String(meta.loopCycleCount ?? 0),
      maxCycles: String(budgetCheck.max),
    });
    return { status: "handled", action: "frozen", reason: "budget_exceeded" };
  }

  if (verification.verdict === "pass") {
    return await handlePass(ctx, meta, drState, verification.reportHash ?? "");
  } else {
    // fail
    return await handleFail(ctx, meta, drState, verification.reportHash ?? "", reportPath);
  }
}

/**
 * Handle PASS verdict: validate and advance to develop.
 */
async function handlePass(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  reportHash: string,
): Promise<CoordinatorResult> {
  // Validate plan hash hasn't drifted
  const planContent = await fs.readFile(drState.planDoc, "utf-8");
  const currentPlanHash = computeHash(planContent);
  
  if (hasPlanDrifted(drState, currentPlanHash)) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "plan_drift_detected",
      expectedHash: drState.planHash ?? "",
      currentHash: currentPlanHash,
    });
    
    // Fix for Issue #14: Transition to paused state with proper pauseReason
    const pausedState = transitionPhase(drState, "paused", undefined, "drift");
    const commitResult = commitDesignReviewState(ctx.session, pausedState);
    if (!commitResult.ok) {
      return { status: "handled", action: "pending", reason: `state_commit_failed: ${commitResult.reason}` };
    }
    
    await safeWriteAuditLog("design_review_coordinator", {
      action: "paused_drift",
      pauseReason: "drift",
      round: String(drState.round),
    });
    
    return { status: "handled", action: "pending", reason: "paused:plan_drifted" };
  }

  // Check develop stage availability
  const developConfig = ctx.config.stages["develop"];
  if (!developConfig || !developConfig.agentPath || !developConfig.skillPath) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "develop_unavailable",
    });
    return { status: "handled", action: "pending", reason: "develop_stage_unavailable" };
  }

  // Record transition
  const visitResult = recordStageVisit(meta, "develop", ctx.config.maxLoopCycles ?? 3);
  if (!visitResult.ok) {
    ctx.session.updateMeta(visitResult.patch);
    return { status: "handled", action: "frozen", reason: "max_loop_cycles" };
  }

  // Update state to pass_ready with approval receipt
  const passReadyState = transitionPhase(drState, "pass_ready");
  const stateWithReceipt = {
    ...passReadyState,
    receipt: {
      authorizationId: drState.authorizationId,
      round: drState.round,
      operationId: drState.operation?.operationId ?? "unknown",
      transition: "advance-develop" as const,
      at: Date.now(),
    },
  };
  const commitResult = commitDesignReviewState(ctx.session, stateWithReceipt);
  
  if (!commitResult.ok) {
    return { status: "handled", action: "pending", reason: `state_commit_failed: ${commitResult.reason}` };
  }

  // Update meta for stage transition
  ctx.session.updateMeta({
    ...visitResult.patch,
    previousStage: "design-review",
    currentStage: "develop",
    stageStartTime: Date.now(),
    loopCount: 0,
    currentStepIndex: 0,
    verifyFailures: [],
    verifyAttempts: 0,
    violations: [],
    advancedThisTurn: undefined,
  });

  await safeWriteAuditLog("design_review_coordinator", {
    action: "pass_approved",
    reportHash,
    planHash: currentPlanHash,
    round: String(drState.round),
  });

  // Transition designReview state to finished after successful advance
  const currentState = ctx.session.getMeta()?.designReview;
  if (currentState && currentState.phase === "pass_ready") {
    const finishedState = transitionPhase(currentState, "finished");
    commitDesignReviewState(ctx.session, finishedState);
    await safeWriteAuditLog("design_review_coordinator", {
      action: "state_finished",
      reason: "pass_advanced_to_develop",
      round: String(drState.round),
    });
  }

  // Spawn develop agent
  const freshMeta = ctx.session.getMeta() ?? meta;
  const spawnResult = await spawnStageSubagent(ctx.pi, ctx.config, "develop", freshMeta, {
    ui: { notify: (msg: string) => { ctx.ui?.notify?.(msg); } },
    session: ctx.session,
    runtimeCtx: ctx,
  });

  if (!spawnResult.spawned && !spawnResult.fallback && !spawnResult.deferred) {
    ctx.session.updateMeta({ advancedThisTurn: true });
    if (ctx.pi?.sendUserMessage) {
      ctx.pi.sendUserMessage(
        `Design review PASS. Routing to "develop" stage.`,
        { deliverAs: "followUp" },
      );
    }
  }

  if (ctx.ui?.transition) {
    ctx.ui.transition(ctx, "design-review", "develop");
  }

  return { status: "handled", action: "advanced", toStage: "develop" };
}

/**
 * Handle FAIL verdict: route to plan for update.
 */
async function handleFail(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  reportHash: string,
  reportPath: string,
): Promise<CoordinatorResult> {
  // Check budget before proceeding
  const budgetCheck = checkBudget(meta, ctx.config);
  if (!budgetCheck.ok) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "fail_budget_exceeded",
      reportHash,
      reportPath,
      round: String(drState.round),
      current: String(budgetCheck.current),
      max: String(budgetCheck.max),
    });
    return { status: "handled", action: "frozen", reason: "budget_exceeded" };
  }

  // Record transition
  const visitResult = recordStageVisit(meta, "plan", ctx.config.maxLoopCycles ?? 3);
  if (!visitResult.ok) {
    ctx.session.updateMeta(visitResult.patch);
    return { status: "handled", action: "frozen", reason: "max_loop_cycles" };
  }

  // Update state to update_ready
  const newState = transitionPhase(drState, "update_ready");
  const commitResult = commitDesignReviewState(ctx.session, newState);
  
  if (!commitResult.ok) {
    return { status: "handled", action: "pending", reason: `state_commit_failed: ${commitResult.reason}` };
  }

  // Update meta for stage transition
  ctx.session.updateMeta({
    ...visitResult.patch,
    previousStage: "design-review",
    currentStage: "plan",
    stageStartTime: Date.now(),
    loopCount: 0,
    currentStepIndex: 0,
    verifyFailures: [],
    verifyAttempts: 0,
    violations: [],
    advancedThisTurn: undefined,
  });

  await safeWriteAuditLog("design_review_coordinator", {
    action: "fail_routed",
    reportHash,
    reportPath,
    round: String(drState.round),
  });

  // Fix for Issue #10: Deterministically dispatch plan agent after FAIL
  // Create operation and spawn agent immediately to ensure update happens
  // If dispatch fails, we still route to plan (dispatch can be retried)
  try {
    const operation = prepareDesignReviewOperation(
      newState,
      "update",
      meta.stageStartTime ?? Date.now()
    );
    
    if (operation) {
      // Commit operation (this also transitions to update_running)
      const committedState = commitDesignReviewOperation(ctx.session, operation, newState);
      if (committedState) {
        // Fix for Issue #7: Render specialized update prompt for FAIL-triggered update
        const templatePath = path.join(ctx.config.projectRoot, ".pi", "references", "pipeline-stage-prompt.yml");
        let updatePrompt: string | undefined;
        try {
          const issues = extractReportIssues(reportPath);
          const promptParams: DesignReviewUpdatePromptParams = {
            pipelineId: meta.pipelineId ?? "unknown",
            planDoc: drState.planDoc,
            reviewDoc: reportPath,
            round: drState.round,
            operationId: operation.operationId,
            baselinePlanHash: drState.planHash ?? "",
            issues: issues,
          };
          updatePrompt = renderDesignReviewUpdatePrompt(templatePath, promptParams);
        } catch (error) {
          // Fail-closed: if template is missing/broken, log but continue without prompt
          await safeWriteAuditLog("design_review_coordinator", {
            action: "update_prompt_render_failed_from_fail",
            error: String(error),
          });
        }
        
        const spawnResult = await spawnDesignReviewAgent(ctx, meta, committedState, operation, updatePrompt);
        if (spawnResult.ok) {
          writebackDesignReviewResult(ctx.session, operation.operationId, undefined, "dispatched");
          await safeWriteAuditLog("design_review_coordinator", {
            action: "update_dispatched_from_fail",
            operationId: operation.operationId,
            round: String(drState.round),
          });
        } else {
          // Dispatch failed but we still route - agent can be spawned later
          await safeWriteAuditLog("design_review_coordinator", {
            action: "update_dispatch_failed_from_fail",
            operationId: operation.operationId,
            reason: spawnResult.error ?? "unknown",
          });
        }
      }
    }
  } catch (error) {
    // Log but don't block routing - dispatch can be retried
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_dispatch_exception_from_fail",
      error: String(error),
    });
  }

  if (ctx.ui?.notify) {
    ctx.ui.notify(`Design review FAIL. Routing to "plan" for update.`);
  }

  return { status: "handled", action: "routed", toStage: "plan" };
}

/**
 * Handle update_ready phase: dispatch update agent.
 */
async function handleUpdateReady(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  if (trigger !== "settle" && trigger !== "advance") {
    return { status: "not-applicable" };
  }

  // Check budget before dispatch
  const budgetCheck = checkBudget(meta, ctx.config);
  if (!budgetCheck.ok) {
    return { status: "handled", action: "frozen", reason: "budget_exceeded" };
  }

  // Check if can dispatch
  if (!canDispatch(drState)) {
    return { status: "handled", action: "pending", reason: "already_dispatched" };
  }

  // Extract issues from report
  const reportPath = deriveReportPath(drState.planDoc, drState.round);
  const issues = extractReportIssues(reportPath);

  // Create operation
  const operation = prepareDesignReviewOperation(drState, "update", meta.stageStartTime ?? Date.now());
  if (!operation) {
    return { status: "handled", action: "pending", reason: "operation_creation_failed" };
  }

  // Commit operation (this also transitions to update_running)
  const committedState = commitDesignReviewOperation(ctx.session, operation, drState);
  if (!committedState) {
    return { status: "handled", action: "pending", reason: "operation_commit_failed" };
  }

  // Fix for Issue #7: Render specialized update prompt using the YAML template
  // This provides authorized update mode instructions to the plan agent
  const templatePath = path.join(ctx.config.projectRoot, ".pi", "references", "pipeline-stage-prompt.yml");
  let updatePrompt: string | undefined;
  try {
    const promptParams: DesignReviewUpdatePromptParams = {
      pipelineId: meta.pipelineId ?? "unknown",
      planDoc: drState.planDoc,
      reviewDoc: reportPath,
      round: drState.round,
      operationId: operation.operationId,
      baselinePlanHash: drState.planHash ?? "",
      issues: issues,
    };
    updatePrompt = renderDesignReviewUpdatePrompt(templatePath, promptParams);
  } catch (error) {
    // Fail-closed: if template is missing/broken, we cannot dispatch safely
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_prompt_render_failed",
      error: String(error),
    });
    return { status: "handled", action: "pending", reason: "update_prompt_render_failed" };
  }

  // Spawn update agent with the rendered prompt
  const spawnResult = await spawnDesignReviewAgent(ctx, meta, committedState, operation, updatePrompt);
  if (!spawnResult.ok) {
    writebackDesignReviewResult(ctx.session, operation.operationId, undefined, "failed");
    return { status: "handled", action: "pending", reason: spawnResult.error ?? "spawn_failed" };
  }

  writebackDesignReviewResult(ctx.session, operation.operationId, undefined, "dispatched");

  await safeWriteAuditLog("design_review_coordinator", {
    action: "update_dispatched",
    operationId: operation.operationId,
    round: String(drState.round),
  });

  return { status: "handled", action: "routed", toStage: "plan" };
}

/**
 * Handle update_running phase: validate update and prepare for re-review.
 */
async function handleUpdateRunning(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  if (trigger !== "settle") {
    return { status: "not-applicable" };
  }

  // Validate plan update
  const planContent = await fs.readFile(drState.planDoc, "utf-8");
  const currentPlanHash = computeHash(planContent);
  
  // Check if plan actually changed first (before validation)
  if (currentPlanHash === drState.planHash) {
    // Throttle non-critical repeated event: no actual plan change
    const throttleKey = `${meta.pipelineId ?? "unknown"}:update_no_change`;
    if (shouldEmitWithinWindow(throttleKey, 5000)) {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "update_no_change",
      });
    }
    
    // Fix for Issue #14: Transition to paused state with proper pauseReason
    const pausedState = transitionPhase(drState, "paused", undefined, "no-change");
    const commitResult = commitDesignReviewState(ctx.session, pausedState);
    if (!commitResult.ok) {
      return { status: "handled", action: "pending", reason: `state_commit_failed: ${commitResult.reason}` };
    }
    
    await safeWriteAuditLog("design_review_coordinator", {
      action: "paused_no_change",
      pauseReason: "no-change",
      round: String(drState.round),
    });
    
    return { status: "handled", action: "pending", reason: "paused:no_actual_change" };
  }

  // Check budget before next round (before validation, as frozen takes precedence)
  const budgetCheck = checkBudget(meta, ctx.config);
  if (!budgetCheck.ok) {
    return { status: "handled", action: "frozen", reason: "budget_exceeded" };
  }

  // Extract issues from the review report
  const reportPath = deriveReportPath(drState.planDoc, drState.round);
  const issues = extractReportIssues(reportPath);
  
  const validation = validatePlanUpdate(drState.planDoc, drState.planHash ?? "", issues);
  
  if (!validation.valid) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_invalid",
      reasons: validation.reasons.join("; "),
    });
    
    // Fix for Issue #14: Transition to paused state with proper pauseReason
    const pausedState = transitionPhase(drState, "paused", undefined, "new-decision");
    const commitResult = commitDesignReviewState(ctx.session, pausedState);
    if (!commitResult.ok) {
      return { status: "handled", action: "pending", reason: `state_commit_failed: ${commitResult.reason}` };
    }
    
    await safeWriteAuditLog("design_review_coordinator", {
      action: "paused_update_invalid",
      pauseReason: "new-decision",
      round: String(drState.round),
      reasons: validation.reasons.join("; "),
    });
    
    return { status: "handled", action: "pending", reason: "paused:update_invalid" };
  }

  // Record transition
  const visitResult = recordStageVisit(meta, "design-review", ctx.config.maxLoopCycles ?? 3);
  if (!visitResult.ok) {
    ctx.session.updateMeta(visitResult.patch);
    return { status: "handled", action: "frozen", reason: "max_loop_cycles" };
  }

  // Allocate next round
  const nextRound = allocateNextRound(drState);
  
  // Update state to review_ready with new round
  const newState = transitionPhase(drState, "review_ready");
  newState.round = nextRound;
  newState.planHash = currentPlanHash;
  // Fix for Issue #4: Update reportDoc for the new round
  newState.reportDoc = deriveReportPath(drState.planDoc, nextRound);
  
  const commitResult = commitDesignReviewState(ctx.session, newState);
  
  if (!commitResult.ok) {
    return { status: "handled", action: "pending", reason: `state_commit_failed: ${commitResult.reason}` };
  }

  // Update meta for stage transition
  ctx.session.updateMeta({
    ...visitResult.patch,
    previousStage: "plan",
    currentStage: "design-review",
    stageStartTime: Date.now(),
    loopCount: 0,
    currentStepIndex: 0,
    verifyFailures: [],
    verifyAttempts: 0,
    violations: [],
    advancedThisTurn: undefined,
  });

  await safeWriteAuditLog("design_review_coordinator", {
    action: "update_complete_rerun",
    previousPlanHash: drState.planHash ?? "",
    newPlanHash: currentPlanHash,
    round: String(nextRound),
  });

  // Create and commit review operation for the next round
  const reviewOperation = createOperation("review", meta.stageStartTime ?? Date.now(), 1);
  const stateWithOperation = transitionPhase(newState, "review_running", reviewOperation);
  const operationCommitResult = commitDesignReviewState(ctx.session, stateWithOperation);
  
  if (!operationCommitResult.ok) {
    return { status: "handled", action: "pending", reason: `operation_commit_failed: ${operationCommitResult.reason}` };
  }

  // Spawn the design-review agent for the next round
  const spawnResult = await spawnDesignReviewAgent(ctx, meta, stateWithOperation, reviewOperation);
  if (!spawnResult.ok) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "review_spawn_failed",
      round: String(nextRound),
      error: spawnResult.error ?? "unknown",
    });
    return { status: "handled", action: "pending", reason: spawnResult.error ?? "spawn_failed" };
  }

  await safeWriteAuditLog("design_review_coordinator", {
    action: "review_dispatched",
    operationId: reviewOperation.operationId,
    round: String(nextRound),
  });

  if (ctx.ui?.transition) {
    ctx.ui.transition(ctx, "plan", "design-review");
  }

  return { status: "handled", action: "routed", toStage: "design-review" };
}

/**
 * Handle pass_ready phase: should not reach here in normal flow.
 */
async function handlePassReady(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  // Throttle non-critical repeated event: unexpected pass_ready state
  const throttleKey = `${meta.pipelineId ?? "unknown"}:unexpected_pass_ready`;
  if (shouldEmitWithinWindow(throttleKey, 5000)) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "unexpected_pass_ready",
      trigger,
    });
  }
  return { status: "handled", action: "pending", reason: "unexpected_state" };
}

/**
 * Handle paused phase: wait for external intervention.
 */
async function handlePaused(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  // Throttle non-critical repeated event: paused state check
  const throttleKey = `${meta.pipelineId ?? "unknown"}:paused_state`;
  if (shouldEmitWithinWindow(throttleKey, 5000)) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "paused_state",
      trigger,
      pauseReason: drState.pauseReason ?? "unknown",
    });
  }
  return { status: "handled", action: "pending", reason: drState.pauseReason ?? "paused" };
}

/**
 * Check budget against maxLoopCycles.
 */
function checkBudget(
  meta: SessionMeta,
  config: PipelineConfig,
): { ok: boolean; current: number; max: number } {
  const current = meta.loopCycleCount ?? 0;
  const max = config.maxLoopCycles ?? 3;
  return { ok: current < max, current, max };
}

/**
 * Spawn design-review agent (review or update).
 */
async function spawnDesignReviewAgent(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  operation: DesignReviewOperation,
  updatePrompt?: string,
): Promise<{ ok: boolean; error?: string }> {
  const stage = operation.kind === "review" ? "design-review" : "plan";
  const freshMeta = ctx.session.getMeta() ?? meta;
  
  // Generate spawn prompt with plan/report path and round
  const inputPath = operation.kind === "review" ? drState.planDoc : (drState.reportDoc ?? drState.planDoc);
  const spawnKind = operation.kind as "review" | "update";
  const spawnPrompt = formatDesignReviewSpawnPrompt(spawnKind, inputPath, drState.round);
  const spawnDescription = `Design review ${operation.kind}: ${inputPath} round ${drState.round}`;
  
  // For update operations with a rendered prompt, append it to provide authorized update context
  const finalPrompt = updatePrompt 
    ? `${spawnPrompt}\n\n---\n\n${updatePrompt}`
    : spawnPrompt;
  
  const spawnResult = await spawnStageSubagent(ctx.pi, ctx.config, stage, freshMeta, {
    ui: { notify: (msg: string) => { ctx.ui?.notify?.(msg); } },
    session: ctx.session,
    runtimeCtx: ctx,
    extraArgs: finalPrompt,
  });

  if (spawnResult.spawned || spawnResult.fallback || spawnResult.deferred) {
    // Audit the spawn with description for traceability
    await safeWriteAuditLog("design_review_coordinator", {
      action: "agent_spawned",
      operationKind: operation.kind,
      description: spawnDescription,
      round: String(drState.round),
    });
    return { ok: true };
  }

  return { ok: false, error: "spawn_failed" };
}
