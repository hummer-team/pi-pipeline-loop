/**
 * @module design-review/coordinator
 * Phase 3 / 191: Unified decision/routing/authorization/recovery entry point for design-review stage.
 * 
 * Coordinates all design-review transitions:
 * - PASS: validate plan/report hash, develop availability, record approval receipt, advance to develop
 * - FAIL: save report/update operation, check budget, route to plan for update
 * - UPDATE complete: validate new hash, structure, budget, commit next round, re-review
 * 
 * Returns handled/pending/transitioned/not-applicable. Only not-applicable proceeds to original logic.
 */

import type {
  PipelineConfig,
  SessionMeta,
  DesignReviewState,
  DesignReviewOperation,
  DesignReviewPhase,
  DesignReviewIdentity,
  DesignReviewInputReceipt,
  SpawnOperationContext,
} from "../../types";
import { verifyDesignReviewReport, extractReportIssues } from "./report";
import { loadVerifyContractAnchors } from "../../utils/contract-loader";
import {
  buildDesignReviewUpdatePrompt,
  DesignReviewUpdateConfigError,
  type DesignReviewUpdatePromptParams,
} from "./prompt";
import { validateDesignReviewUpdate } from "../verifiers/design-review-update-verifier";
import {
  isValidTransition,
  transitionPhase,
  createOperation,
  canDispatch,
  isAuthorizationValid,
  hasPlanDrifted,
  computeHash,
  computeUpdateInputHash,
  computeHandoffInputHash,
  deriveReportPath,
  allocateNextRound,
  buildDesignReviewIdentity,
} from "./state";
import {
  commitDesignReviewState,
  strictCommitMeta,
  type MetaCommitExpectation,
  type StrictCommitSession,
} from "../session-state";
import { prepareDesignReviewOperation, commitDesignReviewOperation, writebackDesignReviewResult, formatDesignReviewSpawnPrompt } from "./dispatch";
import { narrowDesignReviewState } from "./verification-context";
import { recordStageVisit } from "../../utils/stage-visit";
import { spawnStageSubagent, type DesignReviewTerminalEvent } from "../../utils/subagent-rpc";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { shouldEmitWithinWindow } from "../../utils/audit-throttle";
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
 *
 * 192 Phase 1: `session` is a StrictCommitSession — production passes the
 * real createSessionState adapter (which exposes updateMetaVerified); the
 * domain commit paths are fail-closed without it.
 */
export interface CoordinatorContext {
  config: PipelineConfig;
  session: StrictCommitSession;
  ui?: {
    notify: (msg: string) => void;
    transition?: (ctx: unknown, from: string, to: string) => void;
  };
  pi?: {
    sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void;
  };
  /**
   * Optional spawn override for testing (Issue #25).
   * Allows tests to provide a controllable spawn substitute without mock.module.
   * When provided, this function is called instead of the real spawnStageSubagent.
   * 192 Phase 1: the override may return a trusted agentId + dispatchOutcome;
   * a success WITHOUT agentId is recorded as an unknown outcome, never a
   * fabricated dispatched receipt.
   */
  spawnOverride?: (
    config: PipelineConfig,
    stage: string,
    meta: SessionMeta,
    extraArgs?: string,
  ) => Promise<{
    spawned: boolean;
    fallback: boolean;
    deferred?: boolean;
    agentId?: string;
    dispatchOutcome?: import("../../utils/subagent-rpc").StageDispatchOutcome;
  }>;
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
  // 192 Phase 0: strict narrowing distinguishes "not this feature" (absent)
  // from "this feature present but identity invalid" (blocked). A blocked
  // loop must never fall back to ordinary branches.
  const narrowed = narrowDesignReviewState(meta);
  if (!narrowed.ok) {
    if (narrowed.reason === "absent") {
      return { status: "not-applicable" };
    }
    await safeWriteAuditLog("design_review_coordinator", {
      trigger,
      action: "identity_incomplete",
    });
    return { status: "handled", action: "pending", reason: "identity_incomplete" };
  }
  const drState = narrowed.state;

  // Authorization invalid (finished / authorization-lost)
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

  // Check if can dispatch (blocks dispatched AND unknown-window operations)
  if (!canDispatch(drState)) {
    // 192 Phase 1: an operation stuck in the send-intent/unknown window must
    // pause for outcome verification — never re-dispatch blindly (K09/D04).
    if (
      drState.operation?.dispatchEvidence === "send_intent" ||
      drState.operation?.dispatchEvidence === "unknown"
    ) {
      return await pauseForUnknownDispatch(ctx, meta, drState, "review_dispatch_unverified");
    }
    return { status: "handled", action: "pending", reason: "already_dispatched" };
  }

  // 192 Phase 1 (F01): review inputHash is the SHA-256 of the authorized plan
  // content — the same value planHash was derived from at authorization.
  const operation = prepareDesignReviewOperation(
    drState,
    "review",
    meta.stageStartTime ?? Date.now(),
    drState.planHash,
  );
  if (!operation) {
    return { status: "handled", action: "pending", reason: "operation_creation_failed" };
  }

  // New/prepared operations carry explicit not-sent evidence until proven.
  const preparedOp: DesignReviewOperation = operation.dispatchEvidence
    ? operation
    : { ...operation, dispatchEvidence: "confirmed_not_sent", dispatchReason: "prepared_not_dispatched" };

  // Commit operation to state (this also transitions to review_running) —
  // STRICT commit; failure means zero external calls happened.
  const committedState = commitDesignReviewOperation(ctx.session, preparedOp, drState);
  if (!committedState) {
    return { status: "handled", action: "pending", reason: "operation_commit_failed" };
  }

  const outcome = await dispatchOperation(ctx, meta, committedState, preparedOp);

  await safeWriteAuditLog("design_review_coordinator", {
    action: "review_dispatch_attempted",
    operationId: preparedOp.operationId,
    round: String(drState.round),
    outcome,
  });

  if (outcome === "blocked") {
    return { status: "handled", action: "pending", reason: "operation_state_commit_failed" };
  }
  if (outcome === "unknown") {
    return await pauseForUnknownDispatch(ctx, meta, committedState, "review_dispatch_unverified");
  }

  return { status: "handled", action: "routed", toStage: "design-review" };
}

/**
 * 192 Phase 1 (task 9): an unverifiable dispatch window parks the loop in
 * paused/unknown-dispatch so no entry point blindly re-dispatches.
 */
async function pauseForUnknownDispatch(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  state: DesignReviewState,
  reason: string,
): Promise<CoordinatorResult> {
  // Re-read fresh state: an earlier outcome-write may already have advanced
  // the revision; committing against the stale snapshot would conflict.
  const freshMeta = ctx.session.getMeta() ?? meta;
  const currentState = freshMeta.designReview ?? state;
  if (currentState.phase === "paused" && currentState.pauseReason === "unknown-dispatch") {
    // Already paused for this reason — stay pending, do not rewrite.
    return { status: "handled", action: "pending", reason };
  }
  let pausedState: DesignReviewState | undefined;
  try {
    if (isValidTransition(currentState.phase, "paused")) {
      pausedState = transitionPhase(currentState, "paused", undefined, "unknown-dispatch");
    }
  } catch {
    pausedState = undefined;
  }
  if (!pausedState) {
    return { status: "handled", action: "pending", reason };
  }
  const res = strictCommitOperationState(ctx, freshMeta, pausedState, {
    pipelineId: freshMeta.pipelineId ?? "unknown",
    authorizationId: currentState.authorizationId,
    round: currentState.round,
    operationId: currentState.operation?.operationId ?? null,
    phase: currentState.phase,
    stateUpdatedAt: currentState.updatedAt,
  });
  await safeWriteAuditLog("design_review_coordinator", {
    action: "paused_unknown_dispatch",
    reason,
    commit: res.ok ? "persisted" : res.reason,
    round: String(state.round),
  }, "warn");
  return { status: "handled", action: "pending", reason };
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
 * Handle PASS verdict — 192 Phase 1 (DR192-01): three separate milestones.
 *
 * Order (fixed): verify → approval → create NEW develop-handoff operation +
 * reliable transition to develop (phase stays pass_ready, takeover retained)
 * → dispatch handoff once under the Phase 1 intent/receipt protocol → ONLY
 * after the trusted success receipt is persisted may finished be committed.
 * Never: stage=develop alone, or a finished written before the receipt.
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
  if (!developConfig || !developConfig.agentPath || !developConfig.skillPath || developConfig.disabled) {
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

  // Milestone 1: approval bound to the CONSUMED review identity + hashes.
  const reviewOpId = drState.operation?.operationId ?? "unknown";
  const approval: NonNullable<DesignReviewState["approval"]> = {
    reviewOperationId: reviewOpId,
    round: drState.round,
    planHash: currentPlanHash,
    reportHash,
    authorizedAt: Date.now(),
  };

  // Milestone 2 preparation: NEW develop-handoff operation (its own id),
  // bound to the FRESH develop visit. Evidence starts as confirmed not-sent.
  const newVisit = Date.now();
  const handoffOp = createOperation(
    "develop-handoff",
    newVisit,
    1,
    computeHandoffInputHash({
      reviewOperationId: reviewOpId,
      round: drState.round,
      planHash: currentPlanHash,
      reportHash,
    }),
    drState.round,
  );
  const preparedHandoff: DesignReviewOperation = {
    ...handoffOp,
    dispatchEvidence: "confirmed_not_sent",
    dispatchReason: "prepared_not_dispatched",
  };

  // SINGLE strict commit: approval + handoff + currentStage=develop + visit.
  // The design-review phase REMAINS pass_ready: takeover is retained until
  // the trusted receipt + finished are both persisted (DR192-01).
  const passReadyState: DesignReviewState = {
    ...transitionPhase(drState, "pass_ready"),
    approval,
    operation: preparedHandoff,
    receipt: {
      authorizationId: drState.authorizationId,
      round: drState.round,
      operationId: preparedHandoff.operationId,
      transition: "advance-develop",
      at: Date.now(),
    },
  };
  const stagePatch: Partial<SessionMeta> = {
    ...visitResult.patch,
    previousStage: "design-review",
    currentStage: "develop",
    stageStartTime: newVisit,
    loopCount: 0,
    currentStepIndex: 0,
    verifyFailures: [],
    verifyAttempts: 0,
    violations: [],
    advancedThisTurn: undefined,
    designReview: passReadyState,
  };
  const commitRes = strictCommitMeta(ctx.session, stagePatch, {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: drState.operation?.operationId ?? null,
    phase: drState.phase,
    stateUpdatedAt: drState.updatedAt,
  });
  if (commitRes.status !== "persisted") {
    // Handoff intent NOT reliably persisted → zero external calls (row 1 of
    // the DR192-01 matrix): stay pass_ready/developable-safe, retry later.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "handoff_transition_commit_failed",
      status: commitRes.status,
      reason: commitRes.reason,
      round: String(drState.round),
    }, "error");
    return {
      status: "handled",
      action: "pending",
      reason: `pass_commit_failed:${commitRes.status}:${commitRes.reason}`,
    };
  }

  await safeWriteAuditLog("design_review_coordinator", {
    action: "pass_approved",
    reportHash,
    planHash: currentPlanHash,
    round: String(drState.round),
    reviewOperationId: reviewOpId,
    handoffOperationId: preparedHandoff.operationId,
  });

  // Milestone 3: dispatch the handoff exactly once, persist the trusted
  // receipt, THEN finish. Any failure keeps pass_ready takeover (recoverable).
  return await dispatchHandoffOnce(ctx, commitRes.meta, passReadyState, preparedHandoff);
}

/**
 * 192 Phase 1 (DR192-01): dispatch (or re-dispatch when provably not sent)
 * the CURRENT develop-handoff operation exactly once, then persist receipt,
 * then finish. Never re-approves, never records a second visit, never
 * increments round.
 */
async function dispatchHandoffOnce(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  state: DesignReviewState,
  handoffOp: DesignReviewOperation,
): Promise<CoordinatorResult> {
  // Reliable send-intent BEFORE the external call; failure → zero RPC.
  const intent = markSendIntent(ctx, meta, state, handoffOp.operationId);
  if (!intent.ok) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "handoff_blocked_no_intent",
      operationId: handoffOp.operationId,
      reason: intent.reason,
    }, "error");
    return { status: "handled", action: "pending", reason: "handoff_intent_commit_failed" };
  }

  const spawnResult = await spawnDesignReviewAgent(ctx, meta, intent.state, handoffOp);

  if (spawnResult.outcome === "spawned_id" && spawnResult.agentId) {
    // Persist the trusted dispatch success receipt for THIS handoff.
    const receiptState = writebackDesignReviewResult(
      ctx.session,
      handoffOp.operationId,
      spawnResult.agentId,
      "dispatched",
      "trusted_id",
    );
    if (receiptState) {
      // Milestone 4: only now may finished be committed.
      const finish = await finishCurrentHandoffReliably(ctx);
      if (finish) {
        if (ctx.ui?.transition) {
          ctx.ui.transition(ctx, "design-review", "develop");
        }
        return { status: "handled", action: "advanced", toStage: "develop" };
      }
      // Receipt persisted but finished failed → still takeover-able; resume
      // completes ONLY the terminal commit (RPC delta 0).
      await safeWriteAuditLog("design_review_coordinator", {
        action: "handoff_finish_deferred",
        operationId: handoffOp.operationId,
      }, "warn");
      return { status: "handled", action: "pending", reason: "handoff_finish_pending" };
    }
    await safeWriteAuditLog("design_review_coordinator", {
      action: "handoff_receipt_write_failed",
      operationId: handoffOp.operationId,
    }, "error");
  }

  // Any other outcome: unknown/not-sent/queued — NO second channel dispatch.
  const recorded = await recordDispatchOutcome(
    ctx,
    meta,
    intent.state,
    handoffOp.operationId,
    spawnResult.outcome,
    spawnResult.agentId,
  );
  if (recorded === "not_sent") {
    return { status: "handled", action: "pending", reason: "handoff_not_sent_retryable" };
  }
  if (recorded === "pending_queue") {
    return { status: "handled", action: "pending", reason: "handoff_owner_queued" };
  }
  return await pauseForUnknownDispatch(ctx, meta, intent.state, "handoff_dispatch_unverified");
}

/**
 * 192 Phase 1 (DR192-01): reliable finished terminal commit for the CURRENT
 * handoff. Requires FRESH state re-read, a persisted trusted receipt on the
 * CURRENT handoff operation, and a strict commit. No spawn, no approval,
 * no visit.
 */
async function finishCurrentHandoffReliably(ctx: CoordinatorContext): Promise<boolean> {
  const freshMeta = ctx.session.getMeta();
  const state = freshMeta?.designReview;
  if (!freshMeta || !state) return false;
  if (state.phase === "finished") return true;
  if (state.phase !== "pass_ready") return false;
  if (!hasPersistedHandoffSuccess(state)) return false;

  let finishedState: DesignReviewState;
  try {
    finishedState = transitionPhase(state, "finished");
  } catch {
    return false;
  }
  const res = strictCommitMeta(ctx.session, { designReview: finishedState }, {
    pipelineId: freshMeta.pipelineId ?? "unknown",
    authorizationId: state.authorizationId,
    round: state.round,
    operationId: state.operation?.operationId ?? null,
    phase: state.phase,
    stateUpdatedAt: state.updatedAt,
  });
  if (res.status !== "persisted") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "handoff_finish_commit_failed",
      status: res.status,
      reason: res.reason,
      round: String(state.round),
    }, "error");
    return false;
  }
  await safeWriteAuditLog("design_review_coordinator", {
    action: "state_finished",
    reason: "pass_handoff_completed",
    round: String(state.round),
    handoffOperationId: state.operation?.operationId ?? "none",
  });
  return true;
}

/**
 * Handle pass_ready — 192 Phase 1 (DR192-01 recovery matrix).
 * pass_ready + develop-handoff is ALWAYS takeover (never ordinary), even
 * when currentStage already equals develop. Recovery actions are strictly
 * bounded by the persisted evidence:
 * - trusted receipt persisted, not finished → finish ONLY (RPC delta 0);
 * - confirmed not-sent → re-dispatch the SAME handoff once;
 * - send-intent only / unknown → pause for verification (no blind RPC).
 */
async function handlePassReady(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  const op = drState.operation;

  if (!op || op.kind !== "develop-handoff") {
    // No handoff operation recorded: if the approval milestone exists we can
    // rebuild the handoff operation WITHOUT re-approving/re-visiting (the
    // visit is proven by currentStage=develop + unchanged round).
    if (drState.approval && meta.currentStage === "develop") {
      // 191-legacy or partially-committed PASS: cannot prove dispatch state;
      // pause for owner verification instead of guessing.
      if (op?.dispatchEvidence !== "trusted_id") {
        return await pauseForUnknownDispatch(ctx, meta, drState, "handoff_evidence_missing");
      }
    }
    const throttleKey = `${meta.pipelineId ?? "unknown"}:unexpected_pass_ready`;
    if (shouldEmitWithinWindow(throttleKey, 5000)) {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "unexpected_pass_ready",
        trigger,
      });
    }
    return { status: "handled", action: "pending", reason: "unexpected_state" };
  }

  // Row: success receipt persisted but finished missing → terminal-only fix.
  if (hasPersistedHandoffSuccess(drState)) {
    const done = await finishCurrentHandoffReliably(ctx);
    if (done) {
      return { status: "handled", action: "advanced", toStage: "develop" };
    }
    return { status: "handled", action: "pending", reason: "handoff_finish_pending" };
  }

  // Row: unambiguous intent/unknown → pause & verify (zero RPC).
  if (
    op.dispatchEvidence === "send_intent" ||
    op.dispatchEvidence === "unknown" ||
    op.dispatchEvidence === undefined
  ) {
    return await pauseForUnknownDispatch(ctx, meta, drState, "handoff_dispatch_unverified");
  }

  // Row: confirmed not-sent → re-dispatch the SAME handoff once
  // (no new approval, no extra round/visit).
  if (op.dispatchEvidence === "confirmed_not_sent" && op.dispatchState === "pending") {
    return await dispatchHandoffOnce(ctx, meta, drState, op);
  }

  return { status: "handled", action: "pending", reason: "handoff_state_unhandled" };
}

/**
 * Handle FAIL verdict: consume the report, keep its attribution, create the
 * UPDATE operation (new kind, fresh visit) and dispatch it exactly once.
 *
 * 192 Phase 1 (F01):
 * - The consumed review operation is marked terminal and its bounded receipt
 *   (identity/reportDoc/reportHash/inputPlanHash/issueIds) is persisted; the
 *   update operation gets its OWN operationId — kinds are never conflated.
 * - The update operation binds a fresh stage visit (the new plan-stage
 *   stageStartTime), never the old review meta.stageStartTime.
 * - Stage/count/operation/receipt travel in ONE strict commit.
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

  // Extract issues from the consumed report (bounded receipt ids).
  const issues = extractReportIssues(reportPath);
  const issueIds = issues.map((_issue, idx) => String(idx + 1));

  const newVisit = Date.now();
  const reviewOp = drState.operation;
  const reviewIdentity: DesignReviewIdentity | undefined = reviewOp
    ? buildDesignReviewIdentity(meta, drState, reviewOp)
    : undefined;

  const inputReceipt: DesignReviewInputReceipt = {
    reviewIdentity: reviewIdentity ?? {
      // review op missing (legacy meta): record what IS known without guessing
      // a valid identity — consumers still validate against this receipt.
      pipelineId: meta.pipelineId ?? "unknown",
      planDoc: drState.planDoc,
      authorizationId: drState.authorizationId,
      round: drState.round,
      kind: "review",
      operationId: "unknown",
      stageVisitId: 0,
    },
    reportDoc: reportPath,
    reportHash,
    inputPlanHash: drState.planHash ?? "",
    issueIds,
  };

  // Build the update operation bound to the FRESH plan visit (identity
  // material; attempt/operationId fixed here, persisted only after the
  // prompt renders successfully).
  // NOTE: the FAIL path is review_running → update_ready → dispatch; prepare()
  // validates against the intermediate update_ready phase because the unified
  // commit lands in dispatchPhase in ONE step.
  const updateBaseState: DesignReviewState = { ...drState, phase: "update_ready" };
  const updateInputHash = computeUpdateInputHash({
    baselinePlanHash: drState.planHash ?? "",
    reportHash,
    issueIds,
  });
  const updateOp = prepareDesignReviewOperation(updateBaseState, "update", newVisit, updateInputHash);
  if (!updateOp) {
    return { status: "handled", action: "pending", reason: "operation_creation_failed" };
  }
  const preparedUpdateOp: DesignReviewOperation = {
    ...updateOp,
    dispatchEvidence: "confirmed_not_sent",
    dispatchReason: "prepared_not_dispatched",
  };

  // Render the update prompt BEFORE marking update_running: a render failure
  // routes to plan in update_ready (dispatchable later) and performs ZERO
  // dispatch — never a fake update_running that could be misread as no-change.
  let updatePrompt: string;
  {
    // 192 Phase 2 (K04/K05): BOTH dispatch paths call the SAME
    // select+render function. Only missing-file/missing-key falls back to the
    // constants default; empty/broken/param/token errors block dispatch
    // (renderFailed below keeps update_ready and performs ZERO RPC).
    try {
      const built = await buildDesignReviewUpdatePrompt(ctx.config, {
        pipelineId: meta.pipelineId ?? "unknown",
        planDoc: drState.planDoc,
        reviewDoc: reportPath,
        round: drState.round,
        operationId: preparedUpdateOp.operationId,
        baselinePlanHash: drState.planHash ?? "",
        issues: issues,
        ...(drState.requirementDoc !== undefined ? { requirementDoc: drState.requirementDoc } : {}),
      });
      updatePrompt = built.prompt;
      await safeWriteAuditLog("design_review_coordinator", {
        action: "update_prompt_source",
        source: built.selection.source,
        ...(built.selection.path !== undefined ? { path: built.selection.path } : {}),
        key: built.selection.key,
        contentHash: built.selection.contentHash.substring(0, 12),
        operationId: preparedUpdateOp.operationId,
      });
    } catch (error) {
      // Fail-closed: prompt not rendered → commit routing WITHOUT operation
      // dispatch below (update_ready), zero external calls.
      updatePrompt = "";
      await safeWriteAuditLog("design_review_coordinator", {
        action: "update_prompt_render_failed_from_fail",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        ...(error instanceof DesignReviewUpdateConfigError ? { code: error.code, file: error.filePath ?? "", key: error.key ?? "" } : {}),
      });
    }
  }
  const renderFailed = updatePrompt === "";
  const dispatchPhase: DesignReviewPhase = renderFailed ? "update_ready" : "update_running";

  // One consistent target state: review op consumed (terminal evidence in the
  // receipt), update op created, dispatch phase. The consumed review operation
  // is REMOVED from the current-operation slot (its attribution travels with
  // the bounded input receipt) so no path can treat it as still-running.
  const failState: DesignReviewState = {
    ...drState,
    phase: dispatchPhase,
    ...(renderFailed ? { operation: undefined } : { operation: preparedUpdateOp }),
    outcome: {
      reportHash,
      verdict: "fail",
      verdictReason: "report_consumed_for_update",
      recordedAt: Date.now(),
    },
    reviewInputReceipt: inputReceipt,
    updatedAt: Date.now(),
  };

  // SINGLE strict commit: design-review state + stage switch + visit counters.
  const stagePatch: Partial<SessionMeta> = {
    ...visitResult.patch,
    previousStage: "design-review",
    currentStage: "plan",
    stageStartTime: newVisit,
    loopCount: 0,
    currentStepIndex: 0,
    verifyFailures: [],
    verifyAttempts: 0,
    violations: [],
    advancedThisTurn: undefined,
    designReview: failState,
  };
  const commitRes = strictCommitMeta(ctx.session, stagePatch, {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: reviewOp?.operationId ?? null,
    phase: drState.phase,
    stateUpdatedAt: drState.updatedAt,
  });
  if (commitRes.status !== "persisted") {
    // Stage/operation/receipt NOT reliably persisted → no dispatch happened.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "fail_routing_commit_failed",
      status: commitRes.status,
      reason: commitRes.reason,
      round: String(drState.round),
    }, "error");
    return {
      status: "handled",
      action: "pending",
      reason: `fail_commit_failed:${commitRes.status}:${commitRes.reason}`,
    };
  }

  await safeWriteAuditLog("design_review_coordinator", {
    action: "fail_routed",
    reportHash,
    reportPath,
    round: String(drState.round),
    reviewOperationId: reviewOp?.operationId ?? "none",
    updateOperationId: preparedUpdateOp.operationId,
  });

  if (renderFailed) {
    // Routing persisted; dispatch deferred to update_ready handling.
    if (ctx.ui?.notify) {
      ctx.ui.notify(`Design review FAIL. Routing to "plan" for update.`);
    }
    return { status: "handled", action: "pending", reason: "update_prompt_render_failed" };
  }

  // Deterministically dispatch the plan update exactly once.
  const failMeta = commitRes.meta;
  const outcome = await dispatchOperation(ctx, failMeta, failState, preparedUpdateOp, updatePrompt);

  await safeWriteAuditLog("design_review_coordinator", {
    action: "update_dispatch_attempted_from_fail",
    operationId: preparedUpdateOp.operationId,
    round: String(drState.round),
    outcome,
  });

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

  // Check if can dispatch (also blocks unknown-window operations)
  if (!canDispatch(drState)) {
    if (
      drState.operation?.dispatchEvidence === "send_intent" ||
      drState.operation?.dispatchEvidence === "unknown"
    ) {
      return await pauseForUnknownDispatch(ctx, meta, drState, "update_dispatch_unverified");
    }
    return { status: "handled", action: "pending", reason: "already_dispatched" };
  }

  // Extract issues from report
  const reportPath = drState.reviewInputReceipt?.reportDoc ?? deriveReportPath(drState.planDoc, drState.round);
  const issues = extractReportIssues(reportPath);
  const issueIds = issues.map((_issue, idx) => String(idx + 1));
  const reportHash = drState.reviewInputReceipt?.reportHash ?? "";

  // Fresh visit = the CURRENT plan-stage visit (never a stale review stamp).
  const visitId = meta.stageStartTime ?? Date.now();
  const updateInputHash = computeUpdateInputHash({
    baselinePlanHash: drState.planHash ?? "",
    reportHash,
    issueIds,
  });

  // Create operation (same-identity retry only increments attempt)
  const operation = prepareDesignReviewOperation(drState, "update", visitId, updateInputHash);
  if (!operation) {
    return { status: "handled", action: "pending", reason: "operation_creation_failed" };
  }
  const preparedOp: DesignReviewOperation = operation.dispatchEvidence
    ? operation
    : { ...operation, dispatchEvidence: "confirmed_not_sent", dispatchReason: "prepared_not_dispatched" };

  // 192 Phase 2: SAME select+render function as the FAIL-consumption path.
  // Rendering happens BEFORE the operation commit: a configuration error
  // keeps update_ready and performs ZERO dispatch — never a fake
  // update_running later misread as no-change.
  let updatePrompt: string;
  try {
    const built = await buildDesignReviewUpdatePrompt(ctx.config, {
      pipelineId: meta.pipelineId ?? "unknown",
      planDoc: drState.planDoc,
      reviewDoc: reportPath,
      round: drState.round,
      operationId: preparedOp.operationId,
      baselinePlanHash: drState.planHash ?? "",
      issues: issues,
      ...(drState.requirementDoc !== undefined ? { requirementDoc: drState.requirementDoc } : {}),
    });
    updatePrompt = built.prompt;
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_prompt_source",
      source: built.selection.source,
      ...(built.selection.path !== undefined ? { path: built.selection.path } : {}),
      key: built.selection.key,
      contentHash: built.selection.contentHash.substring(0, 12),
      operationId: preparedOp.operationId,
    });
  } catch (error) {
    // Fail-closed: empty/broken YAML, unknown token or missing param blocks
    // the dispatch (spawn=0); the operation was NOT marked running.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_prompt_render_failed",
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      ...(error instanceof DesignReviewUpdateConfigError ? { code: error.code, file: error.filePath ?? "", key: error.key ?? "" } : {}),
    });
    if (ctx.ui?.notify) {
      ctx.ui.notify(`Design review update prompt render failed. Cannot dispatch update agent.`);
    }
    return { status: "handled", action: "pending", reason: "update_prompt_render_failed" };
  }

  // Commit operation (this also transitions to update_running)
  const committedState = commitDesignReviewOperation(ctx.session, preparedOp, drState);
  if (!committedState) {
    return { status: "handled", action: "pending", reason: "operation_commit_failed" };
  }

  // Spawn update agent with the rendered prompt (intent → dispatch → receipt)
  const outcome = await dispatchOperation(ctx, meta, committedState, preparedOp, updatePrompt);

  await safeWriteAuditLog("design_review_coordinator", {
    action: "update_dispatch_attempted",
    operationId: preparedOp.operationId,
    round: String(drState.round),
    outcome,
  });

  if (outcome === "blocked") {
    return { status: "handled", action: "pending", reason: "operation_state_commit_failed" };
  }
  if (outcome === "unknown") {
    return await pauseForUnknownDispatch(ctx, meta, committedState, "update_dispatch_unverified");
  }

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

  // 192 Phase 2 (K08/F03): validate the update against the CURRENT update
  // identity and the bounded input receipt. NO old heuristic (first-20-chars
  // / 500-char window) and NO second report extraction: the same receipt
  // that was consumed is the expected input. Any structural failure is
  // invalid (no reason-prefix leniency).
  const receipt = drState.reviewInputReceipt;
  const reportPath = receipt?.reportDoc ?? deriveReportPath(drState.planDoc, drState.round);
  let expectedIssueIds: readonly string[];
  let expectedReportHash: string;
  let consumedReviewOpId: string;

  if (receipt) {
    expectedIssueIds = receipt.issueIds;
    expectedReportHash = receipt.reportHash;
    consumedReviewOpId = receipt.reviewIdentity.operationId;
    // The consumed report must still be the exact snapshot we bound inputs
    // to; a changed file after consumption is drift, not a validation pass.
    try {
      const reportNow = await fs.readFile(receipt.reportDoc, "utf-8");
      if (computeHash(reportNow) !== receipt.reportHash) {
        const driftState = transitionPhase(drState, "paused", undefined, "drift");
        const driftCommit = commitDesignReviewState(ctx.session, driftState);
        await safeWriteAuditLog("design_review_coordinator", {
          action: "report_drift_after_consume",
          reportPath: receipt.reportDoc,
          committed: driftCommit.ok,
        }, "warn");
        return { status: "handled", action: "pending", reason: "paused:report_drift" };
      }
    } catch (error) {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "update_invalid",
        failures: "consumed report unreadable: " + (error instanceof Error ? error.message : String(error)),
      }, "warn");
      const invalidState = transitionPhase(drState, "paused", undefined, "update-invalid");
      const invalidCommit = commitDesignReviewState(ctx.session, invalidState);
      if (!invalidCommit.ok) {
        return { status: "handled", action: "pending", reason: `state_commit_failed: ${invalidCommit.reason}` };
      }
      return { status: "handled", action: "pending", reason: "paused:update_invalid" };
    }
  } else {
    // 191-legacy compat read (no receipt on older meta): derive attribution
    // from the strict-named current report. Never guess an authorization.
    let legacyIssues: string[] = [];
    let legacyHash = "";
    try {
      const legacyContent = await fs.readFile(reportPath, "utf-8");
      legacyHash = computeHash(legacyContent);
      legacyIssues = extractReportIssues(reportPath);
    } catch {
      legacyIssues = [];
    }
    expectedIssueIds = legacyIssues.map((_issue, idx) => String(idx + 1));
    expectedReportHash = legacyHash;
    consumedReviewOpId = "unknown";
  }

  const verdict = validateDesignReviewUpdate({
    planContent,
    baselinePlanHash: drState.planHash ?? "",
    reportDoc: reportPath,
    reportHash: expectedReportHash,
    round: drState.round,
    reviewOperationId: consumedReviewOpId,
    updateOperationId: drState.operation?.operationId ?? "",
    issueIds: expectedIssueIds,
  });

  if (verdict.status !== "ready") {
    const pauseReason = verdict.status === "paused"
      ? (verdict.reason === "new-decision" ? "new-decision" as const : "no-change" as const)
      : "update-invalid" as const;
    const failuresText = verdict.status === "invalid" ? verdict.failures.join("; ")
      : verdict.status === "paused" && verdict.detail !== undefined ? verdict.detail : "";

    if (pauseReason === "no-change") {
      // Throttle mirrors the pre-existing no-change audit path
      const throttleKey = `${meta.pipelineId ?? "unknown"}:update_no_change`;
      if (shouldEmitWithinWindow(throttleKey, 5000)) {
        await safeWriteAuditLog("design_review_coordinator", { action: "update_no_change" });
      }
    } else {
      await safeWriteAuditLog("design_review_coordinator", {
        action: pauseReason === "update-invalid" ? "update_invalid" : "paused_update_invalid",
        reasons: failuresText,
      });
    }

    const pausedState = transitionPhase(drState, "paused", undefined, pauseReason);
    const commitResult = commitDesignReviewState(ctx.session, pausedState);
    if (!commitResult.ok) {
      return { status: "handled", action: "pending", reason: `state_commit_failed: ${commitResult.reason}` };
    }
    await safeWriteAuditLog("design_review_coordinator", {
      action: "paused_update_verdict",
      pauseReason,
      round: String(drState.round),
    });
    return { status: "handled", action: "pending", reason: `paused:${pauseReason}` };
  }

  // Record transition
  const visitResult = recordStageVisit(meta, "design-review", ctx.config.maxLoopCycles ?? 3);
  if (!visitResult.ok) {
    ctx.session.updateMeta(visitResult.patch);
    return { status: "handled", action: "frozen", reason: "max_loop_cycles" };
  }

  // Allocate next round
  const nextRound = allocateNextRound(drState);

  // 192 Phase 1: the next-round review operation is bound to the FRESH
  // design-review visit and the NEW plan hash (inputHash), replacing the
  // consumed update operation. Receipt/outcome stay finite per round.
  const newVisit = Date.now();
  const reviewOperation = createOperation("review", newVisit, 1, currentPlanHash, nextRound);
  const preparedReviewOp: DesignReviewOperation = {
    ...reviewOperation,
    dispatchEvidence: "confirmed_not_sent",
    dispatchReason: "prepared_not_dispatched",
  };

  // One consistent target state: next round, new plan hash, new report doc,
  // review_running with the fresh operation. The consumed update operation is
  // replaced; its terminal fact is the plan change (newPlanHash) itself.
  const stateWithOperation: DesignReviewState = {
    ...drState,
    phase: "review_running",
    round: nextRound,
    planHash: currentPlanHash,
    reportDoc: deriveReportPath(drState.planDoc, nextRound),
    operation: preparedReviewOp,
    // Round-scoped transients cleared for the NEW round; authorization and
    // budget are preserved (Phase 4 task 8 semantics).
    outcome: undefined,
    reviewInputReceipt: undefined,
    pauseReason: undefined,
    updatedAt: Date.now(),
  };

  // SINGLE strict commit: state + stage switch + visit counters + operation.
  const stagePatch: Partial<SessionMeta> = {
    ...visitResult.patch,
    previousStage: "plan",
    currentStage: "design-review",
    stageStartTime: newVisit,
    loopCount: 0,
    currentStepIndex: 0,
    verifyFailures: [],
    verifyAttempts: 0,
    violations: [],
    advancedThisTurn: undefined,
    designReview: stateWithOperation,
  };
  const commitRes = strictCommitMeta(ctx.session, stagePatch, {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: drState.operation?.operationId ?? null,
    phase: drState.phase,
    stateUpdatedAt: drState.updatedAt,
  });
  if (commitRes.status !== "persisted") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_complete_commit_failed",
      status: commitRes.status,
      reason: commitRes.reason,
      round: String(nextRound),
    }, "error");
    return {
      status: "handled",
      action: "pending",
      reason: `state_commit_failed:${commitRes.status}:${commitRes.reason}`,
    };
  }

  await safeWriteAuditLog("design_review_coordinator", {
    action: "update_complete_rerun",
    previousPlanHash: drState.planHash ?? "",
    newPlanHash: currentPlanHash,
    round: String(nextRound),
    operationId: preparedReviewOp.operationId,
  });

  // Dispatch the next-round review exactly once (intent → spawn → receipt).
  const outcome = await dispatchOperation(ctx, commitRes.meta, stateWithOperation, preparedReviewOp);

  await safeWriteAuditLog("design_review_coordinator", {
    action: "review_dispatch_attempted",
    operationId: preparedReviewOp.operationId,
    round: String(nextRound),
    outcome,
  });

  if (outcome === "blocked") {
    return { status: "handled", action: "pending", reason: "operation_state_commit_failed" };
  }
  if (outcome === "unknown") {
    return await pauseForUnknownDispatch(ctx, commitRes.meta, stateWithOperation, "review_dispatch_unverified");
  }

  if (ctx.ui?.transition) {
    ctx.ui.transition(ctx, "plan", "design-review");
  }

  return { status: "handled", action: "routed", toStage: "design-review" };
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

// ─── 192 Phase 1: operation terminal evidence consumer (task 8) ─────────────

/**
 * Record lifecycle terminal evidence for a design-review operation.
 * Registered at the composition root and invoked from the subagent-RPC
 * lifecycle watcher when a spawn bound to an operation completes/fails.
 *
 * Guarantees:
 * - Fresh identity check: only the CURRENT operation receives terminal
 *   evidence; late events of superseded operations are ignored.
 * - Requires a trusted dispatched receipt (agentId match) — pure chat or
 *   untracked completions never fabricate completion.
 * - Records evidence only: the CHILD never advances stages; the OWNER's
 *   normal settle/verification path consumes the result afterwards. A
 *   followUp wake is sent through the existing owner wake channel.
 */
export async function handleDesignReviewOperationTerminal(
  pi: unknown,
  config: PipelineConfig,
  session: StrictCommitSession,
  evt: DesignReviewTerminalEvent,
): Promise<void> {
  const meta = session.getMeta();
  const state = meta?.designReview;
  const oc = evt.operationContext;
  if (!meta || !state || !state.operation) {
    return;
  }
  const op = state.operation;
  if (
    op.operationId !== oc.operationId
    || op.kind !== oc.kind
    || state.authorizationId !== oc.authorizationId
    || state.round !== oc.round
  ) {
    await safeWriteAuditLog("design_review_terminal", {
      action: "late_event_ignored",
      eventOperationId: oc.operationId,
      currentOperationId: op.operationId,
      event: evt.event,
    }, "warn");
    return;
  }

  // Terminal evidence may only attach to a TRUSTED dispatched operation with
  // the SAME agent id. An operation with unknown dispatch stays unverifiable.
  if (op.dispatchState !== "dispatched" || !op.agentId || (evt.agentId && op.agentId !== evt.agentId)) {
    await safeWriteAuditLog("design_review_terminal", {
      action: "event_unverified",
      operationId: op.operationId,
      event: evt.event,
      dispatchState: op.dispatchState,
      reason: "no_trusted_dispatch_receipt",
    }, "warn");
    return;
  }

  const updated = writebackDesignReviewResult(
    session,
    op.operationId,
    evt.agentId ?? op.agentId,
    evt.event === "completed" ? "completed" : "failed",
    "trusted_id",
  );
  await safeWriteAuditLog("design_review_terminal", {
    action: updated ? "operation_terminal_recorded" : "operation_terminal_write_failed",
    operationId: op.operationId,
    kind: op.kind,
    event: evt.event,
    agentId: op.agentId,
    round: String(state.round),
  }, updated ? undefined : "error");

  // Wake the OWNER through the existing followUp channel so the settle chain
  // re-verifies via the shared entry points. Never spawn a second review.
  const sendUserMessage = (pi as {
    sendUserMessage?: (msg: string, opts?: { deliverAs?: string }) => void;
  })?.sendUserMessage;
  if (typeof sendUserMessage === "function" && op.kind !== "develop-handoff") {
    try {
      sendUserMessage(
        `[plugin auto-settle] Design-review ${op.kind} round ${state.round} finished (${evt.event}). Re-verify the stage result now.`,
        { deliverAs: "followUp" },
      );
    } catch {
      // Wake is best-effort; the settle path still verifies on next turn.
    }
  }
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

// ─── 192 Phase 1: operation-aware dispatch protocol helpers (F01/F04, DR192-01) ──

/**
 * Build the SpawnOperationContext that binds an external dispatch to the
 * CURRENT design-review operation identity.
 */
function makeOperationContext(
  meta: SessionMeta,
  state: DesignReviewState,
  operation: DesignReviewOperation,
): SpawnOperationContext {
  return {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: state.authorizationId,
    round: state.round,
    kind: operation.kind,
    operationId: operation.operationId,
    stageVisitId: operation.stageVisitId,
    ...(operation.inputHash !== undefined ? { inputHash: operation.inputHash } : {}),
  };
}

/**
 * Reliable operation-state commit through the strict path.
 * Returns the persisted meta on success; failure returns the reason.
 */
function strictCommitOperationState(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  nextState: DesignReviewState,
  expected: MetaCommitExpectation,
): { ok: true; meta: SessionMeta } | { ok: false; reason: string } {
  const res = strictCommitMeta(ctx.session, { designReview: nextState }, expected);
  if (res.status === "persisted") {
    return { ok: true, meta: res.meta };
  }
  return { ok: false, reason: `${res.status}:${res.reason}` };
}

/**
 * 192 Phase 1 (task 10): reliably mark send-intent BEFORE any external
 * RPC/followUp boundary. A failed intent commit means ZERO external calls.
 */
function markSendIntent(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  state: DesignReviewState,
  operationId: string,
): { ok: true; state: DesignReviewState } | { ok: false; reason: string } {
  const op = state.operation;
  if (!op || op.operationId !== operationId) {
    return { ok: false, reason: "intent_operation_mismatch" };
  }
  const intentOp: DesignReviewOperation = {
    ...op,
    dispatchEvidence: "send_intent",
    updatedAt: Date.now(),
  };
  const nextState: DesignReviewState = {
    ...state,
    operation: intentOp,
    updatedAt: Date.now(),
  };
  const expected: MetaCommitExpectation = {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: state.authorizationId,
    round: state.round,
    operationId,
    phase: state.phase,
    stateUpdatedAt: state.updatedAt,
  };
  const res = strictCommitOperationState(ctx, meta, nextState, expected);
  if (!res.ok) {
    void safeWriteAuditLog("design_review_coordinator", {
      action: "send_intent_commit_failed",
      operationId,
      reason: res.reason,
    }, "error");
    return { ok: false, reason: res.reason };
  }
  return { ok: true, state: nextState };
}

/**
 * Record the dispatch outcome against the operation identity (task 9):
 * - trusted agentId → strict "dispatched" receipt writeback;
 * - fallback/ambiguous → evidence "unknown" (verify on resume, no re-dispatch);
 * - provably not sent → evidence "confirmed_not_sent" (retryable);
 * - owner-queued/deferred/strict-blocked → the send-intent marker remains.
 */
async function recordDispatchOutcome(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  state: DesignReviewState,
  operationId: string,
  outcome: "spawned_id" | "fallback_no_id" | "deferred" | "queued_owner" | "not_sent" | "unknown" | "strict_blocked" | "skipped_duplicate" | undefined,
  agentId?: string,
): Promise<"trusted" | "unknown" | "not_sent" | "pending_queue" > {
  if (outcome === "spawned_id" && agentId) {
    const wb = writebackDesignReviewResult(ctx.session, operationId, agentId, "dispatched", "trusted_id");
    if (wb) return "trusted";
    // Receipt write failed → fall through to unknown marking below: the child
    // MAY exist; never claim success.
  }
  if (outcome === "not_sent") {
    // Provable not-sent: mark evidence so a same-operation retry is permitted.
    const cur = ctx.session.getMeta();
    const st = cur?.designReview;
    if (st?.operation?.operationId === operationId) {
      const nextState: DesignReviewState = {
        ...st,
        operation: {
          ...st.operation,
          dispatchEvidence: "confirmed_not_sent",
          dispatchReason: "transport_confirmed_not_sent",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      const res = strictCommitOperationState(ctx, meta, nextState, {
        pipelineId: meta.pipelineId ?? "unknown",
        authorizationId: st.authorizationId,
        round: st.round,
        operationId,
        phase: st.phase,
        stateUpdatedAt: st.updatedAt,
      });
      if (!res.ok) return "unknown";
    }
    return "not_sent";
  }
  if (outcome === "deferred" || outcome === "queued_owner") {
    // Owner queue / deferred watcher holds the record; the send-intent
    // evidence remains and blocks blind re-dispatch (canDispatch).
    return "pending_queue";
  }
  // fallback_no_id / unknown / strict_blocked / receipt-write-failure:
  // outcome unverifiable → evidence "unknown".
  const cur = ctx.session.getMeta();
  const st = cur?.designReview;
  if (st?.operation?.operationId === operationId) {
    const nextState: DesignReviewState = {
      ...st,
      operation: {
        ...st.operation,
        dispatchEvidence: "unknown",
        dispatchReason: outcome ?? "receipt_write_failed",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
    const res = strictCommitOperationState(ctx, meta, nextState, {
      pipelineId: meta.pipelineId ?? "unknown",
      authorizationId: st.authorizationId,
      round: st.round,
      operationId,
      phase: st.phase,
      stateUpdatedAt: st.updatedAt,
    });
    if (!res.ok) {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "dispatch_outcome_unknown_commit_failed",
        operationId,
        reason: res.reason,
      }, "error");
    }
  }
  return "unknown";
}

/**
 * Shared dispatch for review/update operations:
 * commit operation → send-intent → dispatch → record outcome.
 * A failed operation commit or intent commit performs ZERO external calls.
 */
async function dispatchOperation(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  committedState: DesignReviewState,
  operation: DesignReviewOperation,
  updatePrompt?: string,
): Promise<"trusted" | "unknown" | "not_sent" | "pending_queue" | "blocked"> {
  const intent = markSendIntent(ctx, meta, committedState, operation.operationId);
  if (!intent.ok) {
    // Intent commit failed → NO external call may happen (F04/D04).
    return "blocked";
  }
  const spawnResult = await spawnDesignReviewAgent(ctx, meta, intent.state, operation, updatePrompt);
  return recordDispatchOutcome(
    ctx,
    meta,
    intent.state,
    operation.operationId,
    spawnResult.outcome,
    spawnResult.agentId,
  );
}

/**
 * 192 Phase 1 (DR192-01): True when the CURRENT handoff operation already
 * carries a reliably persisted trusted dispatch receipt.
 */
function hasPersistedHandoffSuccess(state: DesignReviewState): boolean {
  const op = state.operation;
  return (
    !!op
    && op.kind === "develop-handoff"
    && op.dispatchState === "dispatched"
    && !!op.agentId
    && op.dispatchEvidence === "trusted_id"
  );
}

/**
 * Spawn design-review agent (review or update).
 *
 * 192 Phase 1: returns the explicit dispatch outcome + trusted agentId when
 * available. The real spawn path receives exactPrompt/description and the
 * operation identity; the test override may emulate any outcome shape.
 */
async function spawnDesignReviewAgent(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  operation: DesignReviewOperation,
  updatePrompt?: string,
): Promise<{
  ok: boolean;
  error?: string;
  agentId?: string;
  outcome?: import("../../utils/subagent-rpc").StageDispatchOutcome;
}> {
  const stage: "design-review" | "plan" | "develop" =
    operation.kind === "review" ? "design-review" : operation.kind === "update" ? "plan" : "develop";
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

  const operationContext = makeOperationContext(freshMeta, drState, operation);

  // Use spawnOverride if provided (for testing - Issue #25)
  // Otherwise use the real spawnStageSubagent with the operation identity and
  // the exact rendered prompt (never re-composed on top of the generic text).
  const spawnResult = ctx.spawnOverride
    ? await ctx.spawnOverride(ctx.config, stage, freshMeta, finalPrompt)
    : await spawnStageSubagent(ctx.pi, ctx.config, stage, freshMeta, {
        ui: { notify: (msg: string) => { ctx.ui?.notify?.(msg); } },
        session: ctx.session,
        runtimeCtx: ctx,
        exactPrompt: finalPrompt,
        description: spawnDescription,
        operationContext,
      });

  const outcome = spawnResult.dispatchOutcome ?? (
    spawnResult.spawned && !spawnResult.fallback
      ? "spawned_id"
      : spawnResult.spawned && spawnResult.fallback
        ? "fallback_no_id"
        : spawnResult.deferred
          ? "deferred"
          : "not_sent"
  );

  if (spawnResult.spawned || spawnResult.fallback || spawnResult.deferred) {
    // Audit the spawn with description for traceability
    await safeWriteAuditLog("design_review_coordinator", {
      action: "agent_spawned",
      operationKind: operation.kind,
      operationId: operation.operationId,
      description: spawnDescription,
      dispatchOutcome: outcome,
      agentId: spawnResult.agentId ?? "none",
      round: String(drState.round),
    });
    return { ok: true, agentId: spawnResult.agentId, outcome };
  }

  await safeWriteAuditLog("design_review_coordinator", {
    action: "agent_spawn_not_dispatched",
    operationKind: operation.kind,
    operationId: operation.operationId,
    dispatchOutcome: outcome,
  }, "warn");
  return { ok: false, error: "spawn_failed", outcome };
}
