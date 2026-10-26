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
  DesignReviewOperationKind,
  DesignReviewIdentity,
  DesignReviewInputReceipt,
  ReviewIssue,
  SpawnOperationContext,
  VerifyFailureItem,
  ConfirmMode,
  DesignReviewVerificationOutcome,
} from "../../types";
import { extractReportIssues } from "./report";
import { runVerification, type VerificationRunResult } from "../auto-verifier";
import type { RunVerificationOptions } from "../auto-verifier";
import type { DesignReviewPauseReason } from "../../types";
import {
  buildDesignReviewSmartPrompt,
  DesignReviewSmartPromptError,
} from "./smart-prompt";
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
  buildDesignReviewIdentity,
} from "./state";
import {
  commitDesignReviewState,
  strictCommitMeta,
  type MetaCommitExpectation,
  type StrictCommitSession,
} from "../session-state";
import { prepareDesignReviewOperation, commitDesignReviewOperation, writebackDesignReviewResult } from "./dispatch";
import { buildDesignReviewDispatchTask } from "./dispatch-task";
import {
  preflightDesignReviewDispatchResources,
  type DesignReviewResourcePreflightOk,
} from "./resource-preflight";
import {
  narrowDesignReviewState,
  resolveDesignReviewConfirmMode,
  deriveDomainVerificationContext,
  type TrustedDomainVerificationContext,
} from "./verification-context";
import {
  checkUpdateDeliverableDrift,
  type UpdateDriftResult,
} from "./verification-snapshot";
import { prepareUpdateDispatch } from "./update-preparation";
import { decideDesignReviewRoute } from "./decision-policy";
import { isPausedReportEditable } from "./write-policy";
import {
  applyHumanDecisionChoice,
  beginHumanDecisionMenu,
  buildPendingHumanDecision,
  endHumanDecisionMenu,
  presentHumanDecisionMenu,
  resolveDesignReviewActorEvidence,
  type HumanDecisionSelectFn,
} from "./human-decision";
import {
  buildHumanOverrideBasis,
  prepareDevelopTransition,
} from "./develop-transition";
import type {
  DesignReviewActorInput,
  DesignReviewInteractionSource,
  HumanDecision,
  HumanDecisionReviewIdentity,
} from "./decision-types";
// 212 Phase 0: the ONE evidence-resolution point (owner binding, read-side
// normalization, blocked-child predicate). No scattered `??`/`||` fallbacks.
import {
  isBlockedChildWithoutOwnerEvidence,
  normalizeSessionFile,
  resolveDecisionOwnerFile,
  resolveOwnerSessionFile,
} from "./owner-evidence";
import { recordStageVisit, effectiveMax } from "../../utils/stage-visit";
import { spawnStageSubagent, type DesignReviewTerminalEvent, type StageDispatchOutcome } from "../../utils/subagent-rpc";
// 194 Phase 3 (tasks 2/3): closed-loop executor run lifecycle + trusted wake.
import { issueExecutorRunOnDispatch, applyExecutorTerminal, isHandoffReceiptFinal } from "../stage-executor/terminal";
import { parkExecutorFailure } from "../stage-executor/recovery";
import { sendTrustedOwnerWake } from "../stage-executor/turn-source";
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
  /** 192 Phase 3: invalid deliverable → caller applies the normal verify-fail budget */
  | { status: "handled"; action: "verify_failed"; failures: readonly VerifyFailureItem[] }
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
  /**
   * 192 Phase 3: outcome produced by the SHARED runVerification entry when
   * the caller already verified this turn (agent-settled / tools). Consumed
   * instead of re-parsing; absent consumers invoke the same service.
   */
  verificationResult?: VerificationRunResult | undefined;
  /** Optional passthrough verification options (execFn/logError DI). */
  verificationOptions?: RunVerificationOptions | undefined;
  ui?: {
    notify: (msg: string) => void;
    transition?: (ctx: unknown, from: string, to: string) => void;
    /**
     * 193 Phase 2 (task 7): the human decision menu control. Absent (or any
     * failure/unknown selection) keeps the decision `pending` — never a
     * guessed human choice.
     */
    select?: HumanDecisionSelectFn;
  };
  /**
   * 193 Phase 2 (task 8): raw role evidence from the entry point. Phase 3
   * wires every entry through runtime-context; Phase 2 resolves it
   * conservatively — anything but a verified non-child owner stays pending.
   */
  actor?: DesignReviewActorInput;
  /**
   * 193 Phase 3 (tasks 1/4): interaction provenance assigned by the PLUGIN
   * ENTRY (never a model tool argument). Only "resume" may re-present a
   * pending decision menu; all other sources keep the pause read-only.
   * Absent = treated as "auto" (the most conservative interactive policy).
   */
  interactionSource?: DesignReviewInteractionSource;
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
 * 194 Phase 2 (tasks 2/3): shared resource gate for the closed-loop kinds.
 *
 * MUST run at the preparation points — BEFORE a stage visit, send intent or
 * RPC — so an undeployed agent/skill/template blocks with zero side effects
 * and the loop stays retryable after the operator fixes the config.
 *
 * When `ctx.spawnOverride` is present the gate is ADVISORY: the mocked spawn
 * never touches the deployed assets, so dispatch assertions must not hinge on
 * files inside a temp project root. Production contexts have no override and
 * the gate is always enforcing.
 */
async function gateDesignReviewDispatchResources(
  ctx: CoordinatorContext,
  kind: DesignReviewOperationKind,
  docs: { writeDocs: readonly string[]; readOnlyDocs: readonly string[] },
): Promise<{ ok: true; resources: DesignReviewResourcePreflightOk | null } | { ok: false; reason: string }> {
  const preflight = await preflightDesignReviewDispatchResources({
    config: ctx.config,
    kind,
    writeDocs: docs.writeDocs,
    readOnlyDocs: docs.readOnlyDocs,
  });
  if (preflight.ok) {
    return { ok: true, resources: preflight };
  }
  if (ctx.spawnOverride) {
    // Test seam: dispatch proceeds, prompt omits the unavailable resources.
    return { ok: true, resources: null };
  }
  await safeWriteAuditLog("design_review_coordinator", {
    action: "dispatch_resource_preflight_blocked",
    operationKind: kind,
    issues: preflight.issues.map((i) => `${i.resource}@${i.path || "unset"}: ${i.reason}`).join("; "),
  }, "warn");
  return { ok: false, reason: "resource_preflight_failed" };
}

/**
 * 193 Phase 1 (tasks 1/3): the SINGLE review-dispatch preparation used by
 * BOTH the first review and the next-round review after a plan update.
 *
 * - Resolves the confirmation mode from the SAME stage config the confirm
 *   gate uses (`stages["design-review"].confirm.mode`, loader-normalized,
 *   default "auto") and pins it on the operation candidate.
 * - In SMART mode renders the plan-revision decision guidance from the
 *   strict YAML/default source BEFORE any commit or send intent; the
 *   selection source (yaml/default + hash) is audited for provenance.
 * - An explicit configuration problem returns a blocking reason with ZERO
 *   meta changes, ZERO RPCs and NO consumed visit — the state stays
 *   recoverable and the next attempt re-reads the config (cache invalidated
 *   per actual file path), so a fixed file recovers without a restart.
 * - 194 Phase 2 (task 2): the resource gate runs FIRST for every mode, so a
 *   missing agent/skill/template blocks before any visit is even recorded.
 */
async function prepareReviewDispatchContext(
  ctx: CoordinatorContext,
  candidate: {
    pipelineId: string;
    planDoc: string;
    round: number;
    operationId: string;
    inputHash: string;
    reportDoc: string;
  },
): Promise<{ ok: true; mode: ConfirmMode; guidance?: string } | { ok: false; reason: string }> {
  // 194 Phase 2 (task 2): review reads the plan, writes ONLY the report.
  const gate = await gateDesignReviewDispatchResources(ctx, "review", {
    writeDocs: [candidate.reportDoc],
    readOnlyDocs: [candidate.planDoc],
  });
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  const stageMode = ctx.config.stages?.["design-review"]?.confirm?.mode;
  const mode: ConfirmMode = stageMode === "smart" || stageMode === "manual" ? stageMode : "auto";
  if (mode !== "smart") {
    return { ok: true, mode };
  }
  try {
    const built = await buildDesignReviewSmartPrompt(ctx.config, {
      pipelineId: candidate.pipelineId,
      planDoc: candidate.planDoc,
      round: candidate.round,
      operationId: candidate.operationId,
      inputHash: candidate.inputHash,
      reportDoc: candidate.reportDoc,
    }, { reloadFile: true });
    await safeWriteAuditLog("design_review_coordinator", {
      action: "smart_prompt_source",
      source: built.selection.source,
      ...(built.selection.path !== undefined ? { path: built.selection.path } : {}),
      key: built.selection.key,
      contentHash: built.selection.contentHash.substring(0, 12),
      operationId: candidate.operationId,
      round: String(candidate.round),
    });
    return { ok: true, mode, guidance: built.guidance };
  } catch (error) {
    // Fail-closed: explicit smart-config problems BLOCK the real dispatch.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "smart_prompt_blocked",
      reason: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      ...(error instanceof DesignReviewSmartPromptError
        ? { code: error.code, file: error.filePath ?? "", key: error.key ?? "" }
        : {}),
      operationId: candidate.operationId,
      round: String(candidate.round),
    }, "warn");
    return { ok: false, reason: "smart_decision_config_invalid" };
  }
}

async function handleReviewReady(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  // 192 Phase 3 (task 10 / F05): an active authorized loop must never fall
  // back to ordinary branches for ANY trigger. In review_ready only
  // settle/advance may dispatch; verify/handoff are explicitly handled as
  // pending — zero dispatch, zero advancement — so pipeline_verify /
  // pipeline_handoff cannot run their normal-stage flow.
  if (trigger !== "settle" && trigger !== "advance") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "review_ready_gate_blocked",
      trigger,
      round: String(drState.round),
    });
    return { status: "handled", action: "pending", reason: "review_ready_settle_or_advance_only" };
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
  const baseOp: DesignReviewOperation = operation.dispatchEvidence
    ? operation
    : { ...operation, dispatchEvidence: "confirmed_not_sent", dispatchReason: "prepared_not_dispatched" };

  // 193 Phase 1 (tasks 1/3): pin the resolved confirmation mode and (smart
  // only) render the plan-revision decision guidance BEFORE any commit or
  // send intent. A blocked config keeps review_ready recoverable with zero
  // meta changes, zero RPCs and no consumed visit.
  const prep = await prepareReviewDispatchContext(ctx, {
    pipelineId: meta.pipelineId ?? "unknown",
    planDoc: drState.planDoc,
    round: drState.round,
    operationId: baseOp.operationId,
    inputHash: baseOp.inputHash ?? drState.planHash ?? "",
    reportDoc: drState.reportDoc ?? deriveReportPath(drState.planDoc, drState.round),
  });
  if (!prep.ok) {
    return { status: "handled", action: "pending", reason: prep.reason };
  }
  const preparedOp: DesignReviewOperation = { ...baseOp, reviewConfirmMode: prep.mode };

  // Commit operation to state (this also transitions to review_running) —
  // STRICT commit; failure means zero external calls happened.
  const committedState = commitDesignReviewOperation(ctx.session, preparedOp, drState);
  if (!committedState) {
    return { status: "handled", action: "pending", reason: "operation_commit_failed" };
  }

  const outcome = await dispatchOperation(ctx, meta, committedState, preparedOp, undefined, prep.guidance);

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
 * Handle review_running phase: consume the TRUSTED verification outcome from
 * the shared entry (runVerification → design-review verifier).
 *
 * 192 Phase 3 (K02/F02/F05):
 * - No second report parser here: loadVerifyContractAnchors +
 *   verifyDesignReviewReport self-parsing is removed. The consumer receives
 *   the outcome produced by the shared engine over one snapshot; if the
 *   caller (a tool entry) has none, the SAME shared runVerification service
 *   is invoked first. There is never a hook-vs-coordinator dual consumption
 *   path.
 * - ALL triggers are handled (settle/advance/verify/handoff): an active
 *   authorized loop must not fall back to ordinary branches (F05).
 * - invalid → verify_failed (the normal verification-failure budget is
 *   applied by the hook/tools); valid FAIL is NOT a verify failure.
 */
async function handleReviewRunning(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  // Obtain the trusted outcome through the SHARED verification service.
  let outcome = ctx.verificationResult?.designReviewOutcome;
  if (!outcome) {
    const vr = await runVerification(ctx.config, meta, [], ctx.verificationOptions);
    outcome = vr.designReviewOutcome;
  }
  const reportPath = drState.reportDoc ?? deriveReportPath(drState.planDoc, drState.round);

  if (!outcome) {
    // Active review_running must produce a domain outcome; absence means the
    // context narrowed away (identity lost) — stay pending, never ordinary.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "verification_outcome_missing",
      trigger,
      round: String(drState.round),
    }, "error");
    return { status: "handled", action: "pending", reason: "verification_outcome_missing" };
  }

  if (outcome.kind === "invalid") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "report_invalid",
      reportPath,
      reason: outcome.failures.map((f) => f.detail).join("; "),
    });
    // Route through the NORMAL verification-failure budget (task 9).
    return { status: "handled", action: "verify_failed", failures: outcome.failures };
  }

  if (outcome.kind === "paused") {
    return await pauseDomainOutcome(ctx, meta, drState, outcome.reason, `paused:${outcome.reason}`);
  }

  if (outcome.kind !== "report") {
    // update outcome cannot occur in review_running; treat as unverified.
    return { status: "handled", action: "pending", reason: "unexpected_domain_outcome" };
  }

  // Fresh-identity guard: the outcome must bind to the CURRENT operation.
  if (
    outcome.identity.operationId !== drState.operation?.operationId
    || outcome.identity.round !== drState.round
    || outcome.identity.authorizationId !== drState.authorizationId
  ) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "report_identity_stale",
      outcomeOp: outcome.identity.operationId,
      currentOp: drState.operation?.operationId ?? "none",
    }, "warn");
    return { status: "handled", action: "pending", reason: "report_identity_stale" };
  }

  // Check budget before transition
  const budgetCheck = checkBudget(meta, ctx.config);
  if (!budgetCheck.ok) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "budget_exceeded_before_routing",
      verdict: outcome.verdict,
      currentCycle: String(meta.loopCycleCount ?? 0),
      maxCycles: String(budgetCheck.max),
    });
    return { status: "handled", action: "frozen", reason: "budget_exceeded" };
  }

  // 193 Phase 2 (task 5): ONE pure routing decision over the TRUSTED,
  // contract-valid snapshot. The coordinator only executes the returned
  // route with its existing receipts/visits/dispatch machinery.
  const mode = resolveDesignReviewConfirmMode(meta, ctx.config);
  const route = decideDesignReviewRoute({
    mode,
    verdict: outcome.verdict,
    ...(outcome.smartDecision !== undefined ? { smartAction: outcome.smartDecision.action } : {}),
  });

  if (route === "pass-develop") {
    return await handlePass(ctx, meta, drState, outcome.reportHash);
  }
  if (route === "revise-plan") {
    return await handleFail(ctx, meta, drState, outcome.reportHash, reportPath, outcome.issues);
  }
  if (route === "request-human") {
    return await handleHumanDecisionRequest(
      ctx,
      meta,
      drState,
      outcome,
      reportPath,
      mode === "smart" ? "smart" : "manual",
    );
  }
  // Defensive `invalid` route: a smart FAIL without a usable binary decision
  // is correction-only (the Phase-1 contract gate normally prevents this at
  // verification time). Never routed to develop, never silently revised.
  await safeWriteAuditLog("design_review_coordinator", {
    action: "route_invalid_no_decision",
    round: String(drState.round),
    operationId: drState.operation?.operationId ?? "none",
  }, "warn");
  return {
    status: "handled",
    action: "verify_failed",
    failures: [{
      ruleType: "designReviewReport",
      detail: "smart-mode FAIL without a usable Plan Revision Decision — correction only",
      timestamp: Date.now(),
    }],
  };
}

/**
 * Commit a domain `paused` outcome (drift/no-change/new-decision) and return
 * pending. pauseReason comes from the trusted outcome, never guessed here.
 */
async function pauseDomainOutcome(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  reason: DesignReviewPauseReason,
  resultReason: string,
): Promise<CoordinatorResult> {
  if (drState.phase === "paused" && drState.pauseReason === reason) {
    return { status: "handled", action: "pending", reason: resultReason };
  }
  try {
    const pausedState = transitionPhase(drState, "paused", undefined, reason);
    const commit = commitDesignReviewState(ctx.session, pausedState);
    if (!commit.ok) {
      return { status: "handled", action: "pending", reason: `state_commit_failed: ${commit.reason}` };
    }
    await safeWriteAuditLog("design_review_coordinator", {
      action: "paused_domain_outcome",
      pauseReason: reason,
      round: String(drState.round),
    });
    return { status: "handled", action: "pending", reason: resultReason };
  } catch {
    return { status: "handled", action: "pending", reason: resultReason };
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

  // 193 Phase 2 (task 10): the develop-transition preparation (availability
  // check, fresh visit, approval milestone, NEW develop-handoff operation and
  // the single strict commit) is SHARED with a persisted human FAIL override.
  // PASS keeps the explicit report-pass basis.
  const prep = await prepareDevelopTransition({
    ctx,
    meta,
    drState,
    reportHash,
    planHash: currentPlanHash,
  });
  if (!prep.ok) {
    return prep.result;
  }

  // Milestone 3: dispatch the handoff exactly once, persist the trusted
  // receipt, THEN finish. Any failure keeps pass_ready takeover (recoverable).
  return await dispatchHandoffOnce(ctx, prep.meta, prep.state, prep.handoffOp);
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
  // 193 Phase 2 (task 4): anchor the claim on the PERSISTED revision (the
  // in-lock bump can stale the proposal), same rule as dispatchOperation.
  const freshMeta = ctx.session.getMeta() ?? meta;
  const anchorState = freshMeta.designReview ?? state;
  // 194 Phase 2 (task 2): the develop executor's agent/skill must be deployed
  // BEFORE the intent is written — a blocked handoff performs zero RPCs and
  // leaves the approved state intact for a fixed-config retry.
  const gate = await gateDesignReviewDispatchResources(ctx, "develop-handoff", {
    writeDocs: [],
    readOnlyDocs: anchorState.reportDoc
      ? [anchorState.planDoc, anchorState.reportDoc]
      : [anchorState.planDoc],
  });
  if (!gate.ok) {
    return { status: "handled", action: "pending", reason: gate.reason };
  }
  // Reliable send-intent BEFORE the external call; failure → zero RPC.
  const intent = markSendIntent(ctx, freshMeta, anchorState, handoffOp.operationId);
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
      // 194 Phase 3 (task 2): the trusted reply pair (full agentId + persisted
      // dispatched receipt) establishes the develop executor's run BEFORE the
      // finished commit — the run outlives the closed domain loop (C3).
      await issueBoundExecutorRun(ctx, {
        agentId: spawnResult.agentId,
        operationContext: spawnResult.operationContext,
      });
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
    // Terminal: the handoff operation itself reaches "completed" alongside
    // finished, so takeover predicates (isDevelopHandoffOperation) and any
    // later inspection see ONE coherent terminal record.
    if (finishedState.operation?.kind === "develop-handoff") {
      finishedState = {
        ...finishedState,
        operation: {
          ...finishedState.operation,
          dispatchState: "completed",
          settledAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }
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
  verifiedIssues?: readonly ReviewIssue[],
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

  // 193 Phase 2 (task 5): the pure decision policy already filtered smart
  // `request-human` and manual FAILs to handleHumanDecisionRequest. Reaching
  // this function IS the authorized revise-plan route — it reuses this
  // report-receipt/visit/dispatch closed loop for BOTH auto mode and a
  // persisted human `revise-plan` choice (never a copied loop).

  // Issues come from the SAME trusted snapshot (verifiedIssues) whenever the
  // shared verification produced them; re-extraction is only a legacy
  // fallback for callers without a domain outcome. No second file read of a
  // different report (task 6: same snapshot feeds the FAIL update).
  const issues = verifiedIssues
    ? verifiedIssues.map((i) => i.text)
    : extractReportIssues(reportPath);
  const issueIds = verifiedIssues
    ? verifiedIssues.map((i) => i.issueId)
    : issues.map((_issue, idx) => String(idx + 1));

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

  // 194 Phase 2 (task 2): the plan-revision agent/skill must be deployed
  // before ANY preparation; a missing resource blocks with zero visits, zero
  // intents and zero RPCs, same recoverability as a configuration error.
  const gate = await gateDesignReviewDispatchResources(ctx, "update", {
    writeDocs: [drState.planDoc],
    readOnlyDocs: [reportPath],
  });
  if (!gate.ok) {
    return { status: "handled", action: "pending", reason: gate.reason };
  }

  // 194 Phase 1 (task 1): ONE shared preparation path builds the dispatch
  // candidate — baseline read, C1 descriptor pinning, prompt render and the
  // write-scope preflight. A configuration error here consumes NO stage visit,
  // writes NO intent and performs ZERO RPCs: the FAIL report stays unconsumed
  // in review_running, so repairing the config and settling again retries the
  // exact same consumption (mirrors the 193 review-preparation precedent).
  const updateBaseState: DesignReviewState = { ...drState, phase: "update_ready" };
  const prepared = await prepareUpdateDispatch({
    config: ctx.config,
    meta,
    baseState: updateBaseState,
    reportDoc: reportPath,
    reportHash,
    issues,
    issueIds,
    stageVisitId: newVisit,
  });
  if (!prepared.ok) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "fail_preparation_blocked",
      reason: prepared.reason,
      detail: prepared.detail,
      round: String(drState.round),
      reportHash,
    }, "warn");
    if (ctx.ui?.notify) {
      ctx.ui.notify(`Design review FAIL: update preparation blocked (${prepared.reason}). Report left unconsumed for retry.`);
    }
    return { status: "handled", action: "pending", reason: prepared.reason };
  }
  const preparedUpdateOp = prepared.candidate.operation;
  const updatePrompt = prepared.candidate.prompt;

  // Record transition ONLY now that the dispatch is proven possible.
  const visitResult = recordStageVisit(meta, "plan", effectiveMax(meta, ctx.config), ctx.config);
  if (!visitResult.ok) {
    ctx.session.updateMeta(visitResult.patch);
    return { status: "handled", action: "frozen", reason: "max_loop_cycles" };
  }

  // One consistent target state: review op consumed (terminal evidence in the
  // receipt), update op created, dispatch phase. The consumed review operation
  // is REMOVED from the current-operation slot (its attribution travels with
  // the bounded input receipt) so no path can treat it as still-running.
  const failState: DesignReviewState = {
    ...drState,
    phase: "update_running",
    operation: preparedUpdateOp,
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

// ─── 193 Phase 2: human plan-revision decision flow (tasks 6-10) ────────────

/**
 * 193 Phase 2 (task 6): persist the PENDING decision for a valid FAIL routed
 * `request-human`, then — only for a verified owner with a real select
 * control — present the English menu EXACTLY once, persist the chosen record
 * through the exclusive strict commit (full-field read-back), and only then
 * act. Before creation and before every action the report/plan snapshots are
 * re-checked through the SHARED verification engine (task 8): drift,
 * unreadable reports, verdict flips or stale authorization park the state
 * with zero stage-action visits and zero RPCs.
 *
 * Guarantees:
 * - the pending commit keeps the CURRENT review operation and
 *   currentStage=design-review; it records the REAL FAIL outcome and adds NO
 *   visit, update operation, handoff or budget increment;
 * - Cancel / Esc / unknown / exceptions / absent select / unknown role /
 *   child: the decision stays pending, nothing else changes, no re-popup;
 * - a concurrent writer that lands first makes our expectation conflict —
 *   the persisted choice of the winner is never overwritten (task 8).
 */
async function handleHumanDecisionRequest(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  outcome: Extract<DesignReviewVerificationOutcome, { kind: "report" }>,
  reportPath: string,
  mode: "manual" | "smart",
): Promise<CoordinatorResult> {
  const op = drState.operation;
  if (!op) {
    // Defensive: a routed FAIL must carry the current review operation.
    return { status: "handled", action: "pending", reason: "decision_no_operation" };
  }
  const reviewIdentity: HumanDecisionReviewIdentity = {
    pipelineId: meta.pipelineId ?? "unknown",
    planDoc: drState.planDoc,
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: op.operationId,
    stageVisitId: op.stageVisitId,
  };
  // 212 Phase 0: bind the pending decision to the PROVABLE owner — a child
  // creator records its nearest known ancestor (never its own file), missing
  // evidence stays absent (never ""). `armedBySessionFile` records WHO created
  // the record for audit/copy only and grants no authority.
  const ownerSessionFile = resolveOwnerSessionFile(ctx.actor);
  const armedBySessionFile = normalizeSessionFile(ctx.actor?.sessionFile);
  const pending = buildPendingHumanDecision({
    reviewIdentity,
    reportDoc: reportPath,
    reportHash: outcome.reportHash,
    planHash: drState.planHash ?? outcome.planHash,
    issues: outcome.issues,
    mode,
    ...(ownerSessionFile !== undefined ? { ownerSessionFile } : {}),
    ...(armedBySessionFile !== undefined ? { armedBySessionFile } : {}),
  });

  // Real FAIL outcome + paused(decision-pending) + pending record in ONE
  // strict commit. The review operation stays the current operation; NO
  // visit/stage/update/handoff side effects happen before this save.
  const pendingState: DesignReviewState = {
    ...transitionPhase(drState, "paused", undefined, "decision-pending"),
    outcome: {
      reportHash: outcome.reportHash,
      verdict: "fail",
      verdictReason: mode === "smart" ? "smart_fail_request_human" : "report_fail_awaiting_human_decision",
      recordedAt: Date.now(),
    },
    decision: pending,
  };
  const createCommit = strictCommitMeta(ctx.session, { designReview: pendingState }, {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: op.operationId,
    phase: drState.phase,
    stateUpdatedAt: drState.updatedAt,
    ...(drState.decision === undefined ? { decisionState: "absent" as const } : {}),
  });
  if (createCommit.status !== "persisted") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "decision_pending_commit_failed",
      status: createCommit.status,
      reason: createCommit.reason,
      decisionId: pending.decisionId,
      round: String(drState.round),
    }, "error");
    return {
      status: "handled",
      action: "pending",
      reason: `decision_commit_failed:${createCommit.status}:${createCommit.reason}`,
    };
  }
  const pendingDr = createCommit.meta.designReview!;
  await safeWriteAuditLog("design_review_coordinator", {
    action: "decision_pending_created",
    decisionId: pending.decisionId,
    mode,
    round: String(drState.round),
    operationId: op.operationId,
    reportHash: outcome.reportHash,
    // 212 Phase 0: honest audit of who owns and who armed this decision
    // (missing values are "unknown", never an empty string).
    ownerSessionFile: ownerSessionFile ?? "unknown",
    armedBySessionFile: armedBySessionFile ?? "unknown",
  });

  return await presentHumanDecisionForPendingState(ctx, createCommit.meta, pendingDr, pending);
}

/**
 * 193 Phase 3 (task 4): ONE shared present-menu-and-act flow over an ALREADY
 * PERSISTED pending decision. Used by the creation path (right after the
 * pending commit) and by an EXPLICIT resume entry re-presenting a pending
 * pause. Eligibility, single-flight, snapshot revalidation (before AND after
 * the menu) and the decision-pinned strict choice commit are identical in
 * both cases — a stale/drifted snapshot can never be acted on, and any
 * non-affirmative outcome keeps the decision pending with ZERO side effects.
 */
async function presentHumanDecisionForPendingState(
  ctx: CoordinatorContext,
  baseMeta: SessionMeta,
  drState: DesignReviewState,
  decision: HumanDecision,
): Promise<CoordinatorResult> {
  // ── interaction eligibility (task 8): verified non-child owner only ──────
  // 212 Phase 0: empty/blank recorded owner strings normalize to ABSENT —
  // the old `??` fallback was masked by persisted "" values.
  const ownerFile = resolveDecisionOwnerFile(drState.ownerSessionFile, decision.ownerSessionFile);
  const evidence = resolveDesignReviewActorEvidence(ctx.actor, ownerFile);
  if (ownerFile === undefined) {
    // 212 Phase 0 (task 11): read-only self-check audit for legacy/absent
    // owner evidence — "still unanswerable after the upgrade" must be visible
    // in the log. No state mutation, no extra authority granted or removed.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "decision_owner_evidence_insufficient",
      stage: ctx.interactionSource === "resume" ? "resume" : "settle",
      decisionId: decision.decisionId,
      round: String(drState.round),
    }, "warn");
  }
  const select = ctx.ui?.select;
  if (evidence.role !== "owner") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "decision_menu_skipped",
      decisionId: decision.decisionId,
      role: evidence.role,
      source: evidence.source,
      reason: evidence.reason ?? "role not verified",
    }, "warn");
    return { status: "handled", action: "pending", reason: "decision_pending" };
  }
  if (typeof select !== "function") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "decision_menu_skipped",
      decisionId: decision.decisionId,
      role: "owner",
      source: "absent",
      reason: "no select control available",
    }, "warn");
    return { status: "handled", action: "pending", reason: "decision_pending" };
  }
  // In-process single-flight: never two overlapping menus for one decision.
  if (!beginHumanDecisionMenu(decision.decisionId)) {
    return { status: "handled", action: "pending", reason: "decision_menu_in_flight" };
  }
  try {
    // Re-check the snapshot THROUGH the shared engine before presenting.
    const before = await revalidateHumanDecisionSnapshot(ctx, baseMeta, decision);
    if (!before.ok) {
      return await parkHumanDecisionDrift(
        ctx, baseMeta, drState, decision, "pending", before.reason, "before_menu",
      );
    }
    // ONE menu presentation.
    const choice = await presentHumanDecisionMenu(select, ctx.ui?.notify, decision);
    if (!choice) {
      // Cancel / unknown / exception: stay pending. Zero visit/retry/RPC and
      // NO automatic re-popup — an explicit resume re-opens it (Phase 3).
      await safeWriteAuditLog("design_review_coordinator", {
        action: "decision_menu_cancelled",
        decisionId: decision.decisionId,
        round: String(drState.round),
      });
      return { status: "handled", action: "pending", reason: "decision_pending" };
    }
    // After the menu: meta MUST still hold OUR pending record (another
    // process may have committed a choice or cleared the pause meanwhile).
    const after = ctx.session.getMeta();
    const afterDr = after?.designReview;
    if (
      !after
      || !afterDr
      || afterDr.phase !== "paused"
      || afterDr.pauseReason !== "decision-pending"
      || afterDr.decision?.decisionId !== decision.decisionId
      || afterDr.decision.state !== "pending"
    ) {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "decision_state_changed_after_menu",
        decisionId: decision.decisionId,
        currentDecisionId: afterDr?.decision?.decisionId ?? "none",
        currentDecisionState: afterDr?.decision?.state ?? "none",
      }, "warn");
      return { status: "handled", action: "pending", reason: "decision_pending" };
    }
    const afterPending = afterDr.decision;
    const again = await revalidateHumanDecisionSnapshot(ctx, after, afterPending);
    if (!again.ok) {
      return await parkHumanDecisionDrift(
        ctx, after, afterDr, afterPending, "pending", again.reason, "after_menu",
      );
    }
    // Persist the choice through the exclusive strict commit. The in-lock
    // expectation (identity/revision + decisionId + pending) plus the
    // full-field decision read-back decide whether we may act.
    const chosen = applyHumanDecisionChoice(afterPending, choice, Date.now());
    const chosenState: DesignReviewState = { ...afterDr, decision: chosen };
    const chosenCommit = strictCommitMeta(ctx.session, { designReview: chosenState }, {
      pipelineId: after.pipelineId ?? "unknown",
      authorizationId: afterDr.authorizationId,
      round: afterDr.round,
      operationId: afterDr.operation?.operationId ?? null,
      phase: "paused",
      stateUpdatedAt: afterDr.updatedAt,
      decisionId: decision.decisionId,
      decisionState: "pending",
    });
    if (chosenCommit.status !== "persisted") {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "decision_choice_commit_failed",
        decisionId: decision.decisionId,
        choice,
        status: chosenCommit.status,
        reason: chosenCommit.reason,
      }, "error");
      return {
        status: "handled",
        action: "pending",
        reason: `decision_choice_commit_failed:${chosenCommit.status}:${chosenCommit.reason}`,
      };
    }
    await safeWriteAuditLog("design_review_coordinator", {
      action: "decision_choice_persisted",
      decisionId: decision.decisionId,
      choice,
      round: String(afterDr.round),
      operationId: afterDr.operation?.operationId ?? "none",
    });
    // Act ONLY on the read-back-verified persisted record.
    const persistedDecision = chosenCommit.meta.designReview?.decision;
    if (!persistedDecision || persistedDecision.state !== "chosen") {
      // Read-back proved fields, but stay defensive: no action without a
      // verified chosen record.
      return { status: "handled", action: "pending", reason: "decision_readback_missing" };
    }
    return await actOnHumanDecision(
      ctx, chosenCommit.meta, chosenCommit.meta.designReview!, persistedDecision,
    );
  } finally {
    endHumanDecisionMenu(decision.decisionId);
  }
}

/**
 * 193 Phase 2 (task 8): re-check the decision's report/plan snapshot through
 * the SAME shared verification engine (runVerification → the legal
 * paused/decision-pending review context from verification-context). A verdict
 * flip (new PASS), a report hash change, identity drift, an unreadable report
 * or plan, or a plan content change are ALL refusals — the old choice never
 * approves a different snapshot.
 */
/**
 * 200 Bug Phase 4: exported for direct unit verification of the lazy
 * re-anchor contract — public routing currently reaches this engine only
 * inside decision-anchor windows (where the exemption keeps it strict).
 */
export async function revalidateHumanDecisionSnapshot(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  decision: HumanDecision,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // 200 Bug Phase 4: the shared verification engine builds a review context
  // only for review_running and paused("decision-pending") (193 Phase 2,
  // task 9). A decision that survives into a NON-exempt editable paused
  // window (Phase 3's scoped report release) therefore has no context to be
  // re-measured in — yet that is exactly where a legal rewrite must be
  // observed so the lazy re-anchor below can converge the anchor. Normalize
  // the VERIFICATION VIEW ONLY (never persisted): the full 193 decision-
  // binding gate (current review operation + decision bound to it + non-
  // empty hash) still has to hold; `new-decision`/`drift`-style unknown
  // pauses that are NOT editable windows stay context-free exactly as before.
  const drStateForView = meta.designReview;
  const verifyMeta: SessionMeta =
    drStateForView &&
    isPausedReportEditable(drStateForView) &&
    drStateForView.operation &&
    drStateForView.operation.kind === "review" &&
    drStateForView.decision &&
    drStateForView.decision.reviewIdentity.operationId === drStateForView.operation.operationId &&
    drStateForView.decision.reportHash !== ""
      ? {
          ...meta,
          designReview: {
            ...drStateForView,
            // Purely a context-gate key: the decision-pending window and the
            // editable decision windows share the SAME binding requirements;
            // re-anchor eligibility is re-checked against the REAL reason.
            pauseReason: "decision-pending",
          },
        }
      : meta;
  const vr = await runVerification(ctx.config, verifyMeta, [], ctx.verificationOptions);
  const outcome = vr.designReviewOutcome;
  if (!outcome) return { ok: false, reason: "verification_unavailable" };
  if (outcome.kind === "invalid") return { ok: false, reason: "report_invalid" };
  if (outcome.kind === "paused") return { ok: false, reason: `domain_paused_${outcome.reason}` };
  if (outcome.kind !== "report") return { ok: false, reason: "unexpected_domain_outcome" };
  // The decision binds a FAIL. A PASS now means the snapshot changed — and a
  // fresh PASS must NOT be treated as the old choice having been granted.
  if (outcome.verdict !== "fail") return { ok: false, reason: "verdict_not_fail" };
  if (outcome.reportHash !== decision.reportHash) {
    // 200 Bug Phase 4 (G3-1): lazy re-anchor. A report rewritten inside a
    // NON-exempt paused window is a LEGAL edit (exactly the scoped release
    // Phase 3 opened), not snapshot drift — pin the decision to the measured
    // hash and continue the ok flow. Everything else (decision-anchor
    // windows, identity mismatch, commit conflict) keeps the original
    // `report_hash_drift` refusal with zero behavior change.
    if (!(await tryReanchorDecisionReportHash(ctx, meta, decision, outcome))) {
      return { ok: false, reason: "report_hash_drift" };
    }
  }
  const id = outcome.identity;
  if (
    id.operationId !== decision.reviewIdentity.operationId
    || id.round !== decision.reviewIdentity.round
    || id.authorizationId !== decision.reviewIdentity.authorizationId
    || id.pipelineId !== decision.reviewIdentity.pipelineId
  ) {
    return { ok: false, reason: "identity_drift" };
  }
  try {
    const planContent = await fs.readFile(decision.reviewIdentity.planDoc, "utf-8");
    if (computeHash(planContent) !== decision.planHash) return { ok: false, reason: "plan_drift" };
  } catch {
    return { ok: false, reason: "plan_unreadable" };
  }
  return { ok: true };
}

/**
 * 200 Bug Phase 4 (G3-1): re-anchor the decision's reportHash to the CURRENT
 * measured hash when the report was edited through the paused scoped release.
 *
 * Guards (ALL must hold, otherwise this returns false and the caller keeps
 * the strict `report_hash_drift` refusal):
 * - `isPausedReportEditable(state)` — the SAME single predicate source that
 *   opened the scoped write in Phase 3 (paused, not a decision-anchor reason);
 * - the current operation is a bound `review`;
 * - identity fields `operationId` / `reportDoc` still match the decision
 *   (a different round/operation is real drift, never a legal edit);
 * - the strict commit PERSISTS (conflict/unavailable ⇒ refuse, fail-closed).
 *
 * Persistence goes through the existing `strictCommitMeta` dual-write channel,
 * pinned on the decision id/state so a racing chooser can never be clobbered.
 * No write-time hook is introduced (YAGNI): the only moment the anchor must
 * converge is before the decision executes — the revalidation itself.
 */
async function tryReanchorDecisionReportHash(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  decision: HumanDecision,
  outcome: Extract<DesignReviewVerificationOutcome, { kind: "report" }>,
): Promise<boolean> {
  const drState = meta.designReview;
  if (!drState || !isPausedReportEditable(drState)) return false;
  const operation = drState.operation;
  if (!operation || operation.kind !== "review") return false;
  if (outcome.identity.operationId !== decision.reviewIdentity.operationId) return false;
  const bound = typeof drState.reportDoc === "string" ? drState.reportDoc : "";
  if (!bound || path.resolve(bound) !== path.resolve(decision.reportDoc)) return false;
  const reanchoredState: DesignReviewState = {
    ...drState,
    decision: { ...decision, reportHash: outcome.reportHash },
    updatedAt: Date.now(),
  };
  const res = strictCommitMeta(ctx.session, { designReview: reanchoredState }, {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: operation.operationId,
    phase: "paused",
    stateUpdatedAt: drState.updatedAt,
    decisionId: decision.decisionId,
    decisionState: decision.state,
  });
  if (res.status !== "persisted") {
    // The commit did not land: refuse exactly like before (drift park).
    await safeWriteAuditLog("design_review_coordinator", {
      action: "decision_report_reanchor_refused",
      decisionId: decision.decisionId,
      commitStatus: res.status,
      reason: res.reason,
    }, "warn");
    return false;
  }
  await safeWriteAuditLog("design_review_coordinator", {
    action: "decision_report_reanchored",
    decisionId: decision.decisionId,
    operationId: outcome.identity.operationId,
    oldHash: decision.reportHash,
    newHash: outcome.reportHash,
  });
  return true;
}

/**
 * 193 Phase 2 (task 8): drift/unreadable/invalid revalidation parks the state
 * to paused("drift") and CLEARS the stale decision (guidance: run a new
 * review round). The clear is itself a strict commit pinned on the decision
 * id/state — a racing writer makes it conflict instead of clobbering.
 */
async function parkHumanDecisionDrift(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  decision: HumanDecision,
  decisionState: "pending" | "chosen",
  driftReason: string,
  stage: string,
): Promise<CoordinatorResult> {
  // SAME phase (paused), only the pause reason flips to "drift" and the
  // stale decision is cleared: transitionPhase would reject paused→paused,
  // so the drift state is built directly (immutable update, fresh revision).
  const driftState: DesignReviewState = {
    ...drState,
    pauseReason: "drift",
    decision: undefined,
    updatedAt: Date.now(),
  };
  const res = strictCommitMeta(ctx.session, { designReview: driftState }, {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: drState.operation?.operationId ?? null,
    phase: "paused",
    stateUpdatedAt: drState.updatedAt,
    decisionId: decision.decisionId,
    decisionState,
  });
  await safeWriteAuditLog("design_review_coordinator", {
    action: "decision_revalidation_failed",
    stage,
    reason: driftReason,
    decisionId: decision.decisionId,
    commitStatus: res.status,
    ...(res.status !== "persisted" ? { commitReason: res.reason } : {}),
  }, "warn");
  if (ctx.ui?.notify) {
    try {
      ctx.ui.notify(
        `Design-review human decision paused (${driftReason}) at ${stage}. The report/plan no longer matches the reviewed snapshot — run a new review round.`,
      );
    } catch {
      // Notification is best-effort; the pause decision stands either way.
    }
  }
  return { status: "handled", action: "pending", reason: `decision_drift:${driftReason}` };
}

/**
 * 193 Phase 2 (tasks 5/10): execute a PERSISTED, read-back-verified choice.
 * - `revise-plan` REUSES handleFail's receipt/visit/dispatch loop (no copied
 *   closed loop, at most one action visit);
 * - `proceed-develop` goes through the SHARED develop-transition preparation
 *   with a human-override basis bound into the handoff hash, then the normal
 *   dispatchHandoffOnce/receipt/finished machinery. The real FAIL outcome and
 *   issues stay persisted; nothing here fabricates a PASS.
 */
async function actOnHumanDecision(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  decision: HumanDecision & { state: "chosen" },
): Promise<CoordinatorResult> {
  if (decision.choice === "revise-plan") {
    return await handleFail(
      ctx,
      meta,
      drState,
      decision.reportHash,
      decision.reportDoc,
      decision.issues,
    );
  }
  const prep = await prepareDevelopTransition({
    ctx: { config: ctx.config, session: ctx.session },
    meta,
    drState,
    reportHash: decision.reportHash,
    planHash: decision.planHash,
    approvalBasis: buildHumanOverrideBasis(decision),
    decisionAnchor: { decisionId: decision.decisionId },
  });
  if (!prep.ok) {
    return prep.result;
  }
  return await dispatchHandoffOnce(ctx, prep.meta, prep.state, prep.handoffOp);
}

/**
 * 193 Phase 2 (tasks 8/9): consume the paused/decision-pending state.
 * - pending: throttled "awaiting human decision" notice ONLY — no
 *   re-verification, no menu re-popup, no budget counting;
 * - chosen: recovery after a crash/failure — revalidate, then act on the
 *   SAME persisted operation without re-approving or showing the menu again.
 */
async function handleDecisionPending(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  drState: DesignReviewState,
  trigger: string,
): Promise<CoordinatorResult> {
  const decision = drState.decision;
  if (!decision) {
    // Malformed decision-pending pause (no record): NEVER fall through to
    // ordinary flows — stay paused and tell the operator.
    const throttleKey = `${meta.pipelineId ?? "unknown"}:decision_missing`;
    if (shouldEmitWithinWindow(throttleKey, 5000)) {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "decision_record_missing",
        trigger,
        round: String(drState.round),
      }, "warn");
      if (ctx.ui?.notify) {
        ctx.ui.notify("Design-review is paused for a human decision but no decision record exists. Re-run authorization or use /pipeline-resume.");
      }
    }
    return { status: "handled", action: "pending", reason: "decision_record_missing" };
  }
  if (decision.state === "pending") {
    // 193 Phase 3 (task 4): an EXPLICIT resume (/pipeline-resume, source
    // assigned by the entry via runtime-context — never a model parameter)
    // re-presents the menu through the SAME shared present-and-act flow:
    // eligibility, single-flight, pre/post-menu revalidation and the
    // decision-pinned strict choice commit. Every other source (ordinary
    // settle, tools, startup) stays a read-only wait — no popup, no
    // re-verification, no budget.
    if (ctx.interactionSource === "resume") {
      return await presentHumanDecisionForPendingState(ctx, meta, drState, decision);
    }
    // 212 Phase 0 (task 11): on the settle channel the pending decision is
    // still wait-only, but a MISSING recorded owner evidence must be visible
    // — the same eligibility refusal the resume path logs, so "unanswerable
    // even by the owner" is auditable. Pure audit: no state change, no menu.
    if (trigger === "settle") {
      const ownerFile = resolveDecisionOwnerFile(drState.ownerSessionFile, decision.ownerSessionFile);
      if (ownerFile === undefined) {
        const evidenceKey = `${meta.pipelineId ?? "unknown"}:decision_owner_evidence`;
        if (shouldEmitWithinWindow(evidenceKey, 5000)) {
          const settleEvidence = resolveDesignReviewActorEvidence(ctx.actor, ownerFile);
          await safeWriteAuditLog("design_review_coordinator", {
            action: "decision_menu_skipped",
            decisionId: decision.decisionId,
            role: settleEvidence.role,
            source: settleEvidence.source,
            reason: settleEvidence.reason ?? "role not verified",
          }, "warn");
          await safeWriteAuditLog("design_review_coordinator", {
            action: "decision_owner_evidence_insufficient",
            stage: "settle",
            decisionId: decision.decisionId,
            round: String(drState.round),
          }, "warn");
        }
      }
    }
    // Waiting notice only (task 9): no re-verification, no popup, no budget.
    const throttleKey = `${meta.pipelineId ?? "unknown"}:decision_wait`;
    if (shouldEmitWithinWindow(throttleKey, 5000)) {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "decision_awaiting_human",
        decisionId: decision.decisionId,
        mode: decision.mode,
        trigger,
        round: String(drState.round),
      });
      if (ctx.ui?.notify) {
        ctx.ui.notify(
          `Design review FAILED and awaits a human plan-revision decision (report: ${decision.reportDoc}). Use /pipeline-resume to present the decision menu.`,
        );
      }
    }
    return { status: "handled", action: "pending", reason: "decision_pending" };
  }
  // chosen → recovery: revalidate first, act only on a matching snapshot.
  const rv = await revalidateHumanDecisionSnapshot(ctx, meta, decision);
  if (!rv.ok) {
    return await parkHumanDecisionDrift(ctx, meta, drState, decision, "chosen", rv.reason, "recovery");
  }
  await safeWriteAuditLog("design_review_coordinator", {
    action: "decision_chosen_recovery_acting",
    decisionId: decision.decisionId,
    choice: decision.choice,
    trigger,
    round: String(drState.round),
  });
  // 200 Bug Phase 4: the re-anchor above may have committed a newer decision
  // snapshot (re-anchored reportHash) than this handler's local copies. Act
  // on the LIVE record when it still carries OUR decision, so the
  // develop-transition hashes and strict-commit anchors match the store.
  const live = ctx.session.getMeta();
  const liveState = live?.designReview;
  const liveDecision = liveState?.decision;
  const act =
    live && liveState && liveDecision &&
    liveDecision.state === "chosen" && liveDecision.decisionId === decision.decisionId
      ? { meta: live, drState: liveState, decision: liveDecision }
      : { meta, drState, decision };
  return await actOnHumanDecision(ctx, act.meta, act.drState, act.decision);
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
  // 192 Phase 3 (task 10 / F05): mirror of review_ready gating — active
  // update_ready consumes verify/handoff triggers as pending so the normal
  // verification/handoff branches can never bypass the design-review loop.
  if (trigger !== "settle" && trigger !== "advance") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_ready_gate_blocked",
      trigger,
      round: String(drState.round),
    });
    return { status: "handled", action: "pending", reason: "update_ready_settle_or_advance_only" };
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

  // 194 Phase 2 (task 2): same resource gate as the FAIL consumption path —
  // update_ready stays intact with zero side effects when blocked.
  const gate = await gateDesignReviewDispatchResources(ctx, "update", {
    writeDocs: [drState.planDoc],
    readOnlyDocs: [reportPath],
  });
  if (!gate.ok) {
    return { status: "handled", action: "pending", reason: gate.reason };
  }

  // 194 Phase 1 (task 1): the SAME preparation the FAIL path uses. Nothing is
  // committed and no RPC happens unless candidate + prompt + write-scope
  // preflight all succeed; a configuration error keeps update_ready intact with
  // ZERO visits and ZERO dispatches (the operation is not even created yet).
  const prepared = await prepareUpdateDispatch({
    config: ctx.config,
    meta,
    baseState: drState,
    reportDoc: reportPath,
    reportHash,
    issues,
    issueIds,
    stageVisitId: visitId,
  });
  if (!prepared.ok) {
    if (ctx.ui?.notify) {
      ctx.ui.notify(`Design review update dispatch blocked (${prepared.reason}). Nothing was dispatched.`);
    }
    return { status: "handled", action: "pending", reason: prepared.reason };
  }
  const preparedOp = prepared.candidate.operation;
  const updatePrompt = prepared.candidate.prompt;

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
 * 194 Phase 1 (C2): turn a failed pre-advance revalidation into the existing
 * pause / invalid classes, keeping the 192 budget semantics intact:
 *
 * - `plan_unreadable` / an unprovable OUTPUT binding ⇒ invalid (verify_failed):
 *   the contract or the deliverable itself cannot be proven, which is a
 *   verification outcome the attempt budget governs.
 * - a drifted plan/report/receipt hash, or a consumed report that vanished after
 *   consumption ⇒ paused (`drift`, or `update-invalid` for the 192 unreadable-
 *   report class): a storage race is not the model's contract violation, so no
 *   budget is burned and nothing advances.
 */
async function parkUpdateAfterFailedRevalidation(
  ctx: CoordinatorContext,
  drState: DesignReviewState,
  updateCtx: Extract<TrustedDomainVerificationContext, { kind: "update" }>,
  drift: Extract<UpdateDriftResult, { ok: false }>,
): Promise<CoordinatorResult> {
  if (drift.reason === "plan_unreadable" || drift.reason === "output_binding_unprovable") {
    const detail = drift.reason === "plan_unreadable"
      ? `plan snapshot unreadable: ${updateCtx.planDoc}${drift.detail !== undefined ? ` (${drift.detail})` : ""}`
      : `update output binding is not provable (${drift.detail ?? "unknown"})`;
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_invalid",
      reasons: detail,
      revalidation: drift.reason,
    });
    return {
      status: "handled",
      action: "verify_failed",
      failures: [{ ruleType: "designReviewUpdate", detail, timestamp: Date.now() }],
    };
  }

  const pauseReason: DesignReviewPauseReason = drift.reason === "report_unreadable"
    ? "update-invalid"
    : "drift";
  await safeWriteAuditLog("design_review_coordinator", {
    action: drift.reason === "report_hash_drift" ? "report_drift_after_consume" : "update_revalidation_drift",
    reason: drift.reason,
    ...(drift.detail !== undefined ? { detail: drift.detail } : {}),
    round: String(drState.round),
  }, "warn");

  const pausedState = transitionPhase(drState, "paused", undefined, pauseReason);
  const commitResult = commitDesignReviewState(ctx.session, pausedState);
  if (!commitResult.ok) {
    return { status: "handled", action: "pending", reason: `state_commit_failed: ${commitResult.reason}` };
  }
  return { status: "handled", action: "pending", reason: `paused:${pauseReason}` };
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
  // 192 Phase 3 (F05): ALL triggers are consumed through the shared
  // verification outcome — advance/verify/handoff must not fall back to the
  // ordinary plan-confirm/auto-advance branches for an authorized update.
  let outcome = ctx.verificationResult?.designReviewOutcome;
  if (!outcome) {
    const vr = await runVerification(ctx.config, meta, [], ctx.verificationOptions);
    outcome = vr.designReviewOutcome;
  }

  if (outcome && outcome.kind === "paused") {
    return await pauseDomainOutcome(ctx, meta, drState, outcome.reason, `paused:${outcome.reason}`);
  }
  if (outcome && outcome.kind === "invalid") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_invalid",
      reasons: outcome.failures.map((f) => f.detail).join("; "),
    });
    return { status: "handled", action: "verify_failed", failures: outcome.failures };
  }

  // 194 Phase 1 (task 4): the SHARED verification outcome is the ONLY verdict
  // source. The coordinator never runs a second `validateDesignReviewUpdate`
  // over its own reads — that double validation was exactly the window where
  // the engine and the coordinator could disagree about which bytes counted.
  // What it DOES do is revalidate the deliverable HASHES immediately before
  // the round transition, so a plan/receipt replaced after verification cannot
  // be advanced on.
  if (!outcome) {
    // No trusted domain context (identity incomplete, operation replaced, or a
    // non-design-review flow): stay put instead of validating ad hoc.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_outcome_absent",
      round: String(drState.round),
      operationId: drState.operation?.operationId ?? "none",
    }, "warn");
    return { status: "handled", action: "pending", reason: "update_no_trusted_outcome" };
  }
  if (outcome.kind !== "update") {
    // A report/invalid/paused outcome cannot govern this consumption: fail
    // closed, never advance on borrowed evidence.
    return {
      status: "handled",
      action: "pending",
      reason: `update_outcome_kind_mismatch:${outcome.kind}`,
    };
  }
  const currentPlanHash = outcome.newPlanHash;

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

  // 194 Phase 1 (task 4) + C2: revalidate the hashes the READY verdict consumed
  // — plan, consumed report and (standalone) receipt — from ONE fresh capture
  // each, immediately before the round transition. A hash that no longer
  // matches proves the verdict speaks for bytes that are gone: park instead of
  // advancing on evidence the run no longer owns.
  const updateCtx = deriveDomainVerificationContext(meta);
  if (!updateCtx || updateCtx.kind !== "update") {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_revalidation_context_lost",
      round: String(drState.round),
      operationId: drState.operation?.operationId ?? "none",
    }, "warn");
    return { status: "handled", action: "pending", reason: "update_context_lost_before_revalidation" };
  }
  const drift = await checkUpdateDeliverableDrift(
    updateCtx,
    outcome.newPlanHash,
    outcome.receiptHash,
  );
  if (!drift.ok) {
    return await parkUpdateAfterFailedRevalidation(ctx, drState, updateCtx, drift);
  }

  // Allocate next round
  const nextRound = allocateNextRound(drState);

  // 192 Phase 1: the next-round review operation is bound to the FRESH
  // design-review visit and the NEW plan hash (inputHash), replacing the
  // consumed update operation. Receipt/outcome stay finite per round.
  const newVisit = Date.now();
  const reviewOperation = createOperation("review", newVisit, 1, currentPlanHash, nextRound);
  const baseReviewOp: DesignReviewOperation = {
    ...reviewOperation,
    dispatchEvidence: "confirmed_not_sent",
    dispatchReason: "prepared_not_dispatched",
  };

  // 193 Phase 1 (task 3): the SAME preparation as the first review — the
  // guidance renders against the CANDIDATE next-round operation/round/
  // planHash/reportDoc (never old meta) and runs BEFORE the visit is
  // recorded, so a blocked smart config consumes no visit and leaves the
  // state recoverable with zero RPCs.
  const reviewPrep = await prepareReviewDispatchContext(ctx, {
    pipelineId: meta.pipelineId ?? "unknown",
    planDoc: drState.planDoc,
    round: nextRound,
    operationId: baseReviewOp.operationId,
    inputHash: currentPlanHash,
    reportDoc: deriveReportPath(drState.planDoc, nextRound),
  });
  if (!reviewPrep.ok) {
    return { status: "handled", action: "pending", reason: reviewPrep.reason };
  }
  const preparedReviewOp: DesignReviewOperation = {
    ...baseReviewOp,
    reviewConfirmMode: reviewPrep.mode,
  };

  // Record transition
  const visitResult = recordStageVisit(meta, "design-review", effectiveMax(meta, ctx.config), ctx.config);
  if (!visitResult.ok) {
    ctx.session.updateMeta(visitResult.patch);
    return { status: "handled", action: "frozen", reason: "max_loop_cycles" };
  }

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
    // 193 Phase 2 (task 10): a NEW round invalidates any previous human
    // decision record — old choices never carry across rounds.
    decision: undefined,
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
    // 194 C2: the receipt hash the READY verdict consumed rides along in the
    // round-transition audit (standalone updates only).
    ...(outcome.receiptHash !== undefined ? { receiptHash: outcome.receiptHash } : {}),
    round: String(nextRound),
    operationId: preparedReviewOp.operationId,
  });

  // Dispatch the next-round review exactly once (intent → spawn → receipt).
  const dispatchResult = await dispatchOperation(
    ctx,
    commitRes.meta,
    stateWithOperation,
    preparedReviewOp,
    undefined,
    reviewPrep.guidance,
  );

  await safeWriteAuditLog("design_review_coordinator", {
    action: "review_dispatch_attempted",
    operationId: preparedReviewOp.operationId,
    round: String(nextRound),
    outcome: dispatchResult,
  });

  if (dispatchResult === "blocked") {
    return { status: "handled", action: "pending", reason: "operation_state_commit_failed" };
  }
  if (dispatchResult === "unknown") {
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
  // 193 Phase 2 (tasks 8/9): a paused design-review WAITING ON the human
  // plan-revision decision is consumed HERE — it must never behave like an
  // ordinary pause. Once the chosen action has committed, the phase is no
  // longer decision-pending, so a completed revise/update never re-fires.
  if (drState.pauseReason === "decision-pending") {
    return await handleDecisionPending(ctx, meta, drState, trigger);
  }
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

  // 194 Phase 3 (task 2): maintain the closed-loop run FIRST. A develop
  // executor's terminal legitimately arrives while the handoff operation is
  // already "completed" — the dispatch-receipt gate below is about DISPATCH
  // evidence and must never swallow run bookkeeping for a bound run.
  const terminal = await applyExecutorTerminal({ session, config, evt });

  // 194 Phase 3 (task 5, D4): park a trusted failed/aborted terminal BEFORE
  // any wake — review/update pauses with `executor-failed`, develop blocks the
  // flow (recovery awaits the owner's explicit decision; registry evidence
  // decides, a still-live executor is never parked or re-dispatched).
  if (terminal.action === "applied" && (terminal.run.status === "failed" || terminal.run.status === "aborted")) {
    await parkExecutorFailure({ session, config, run: terminal.run });
  }

  // A REAL terminal never rewrites the finished handoff receipt (C3): the
  // run above carries the outcome and the owner is woken to consume it.
  if (isHandoffReceiptFinal(state)) {
    await safeWriteAuditLog("design_review_terminal", {
      action: "handoff_receipt_final",
      operationId: op.operationId,
      event: evt.event,
      runTerminal: terminal.action,
    });
    if (terminal.action === "applied") {
      await sendTrustedOwnerWake({
        pi,
        session,
        config,
        run: terminal.run,
        status: terminal.run.status,
      });
    }
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
  const max = effectiveMax(meta, config);
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
    // 194 Phase 3 (C3): one plugin-issued run id per dispatch ATTEMPT —
    // rides the reserved entry, the terminal event and the trusted receipt,
    // so a superseded run's listener can never be mistaken for the current.
    runId: crypto.randomUUID(),
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
    // 193 Phase 2 (task 4): the claim itself is checked INSIDE the exclusive
    // lock — only a still-pending, provably-not-sent operation can be
    // claimed. send_intent / unknown / trusted_id windows can NEVER be
    // re-claimed by a second dispatcher (no blind re-dispatch).
    operationClaimable: true,
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
  // 193 Phase 2 (task 4): callers MUST continue from the PERSISTED state —
  // the in-lock revision bump (max(now, auth+1)) makes the old proposal's
  // updatedAt stale, and every later expectation anchors on the persisted
  // revision.
  return { ok: true, state: res.meta.designReview ?? nextState };
}

/**
 * Record the dispatch outcome against the operation identity (task 9):
 * - trusted agentId → strict "dispatched" receipt writeback;
 * - fallback/ambiguous → evidence "unknown" (verify on resume, no re-dispatch);
 * - provably not sent → evidence "confirmed_not_sent" (retryable);
 * - strict_blocked (the PRE-RPC strict reserved write refused: adapter lacks
 *   the strict interface / stale operation identity / reserved commit not
 *   persisted) is ALSO provably not sent — subagent-rpc.ts:908-913 returns it
 *   only when ZERO external calls happened, so the same operation stays
 *   retryable (plan Phase 1 tasks 9/10) instead of an unnecessary unknown
 *   pause; a failed not-sent writeback still falls through to "unknown";
 * - owner-queued/deferred → the send-intent marker remains.
 */
async function recordDispatchOutcome(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  state: DesignReviewState,
  operationId: string,
  outcome: StageDispatchOutcome | undefined,
  agentId?: string,
): Promise<"trusted" | "unknown" | "not_sent" | "pending_queue" > {
  if (outcome === "spawned_id" && agentId) {
    const wb = writebackDesignReviewResult(ctx.session, operationId, agentId, "dispatched", "trusted_id");
    if (wb) return "trusted";
    // Receipt write failed → fall through to unknown marking below: the child
    // MAY exist; never claim success.
  }
  if (outcome === "not_sent" || outcome === "strict_blocked" || outcome === "conflict_blocked") {
    // Provable not-sent: mark evidence so a same-operation retry is permitted.
    // 192 issue 9: "strict_blocked" is returned by the pre-RPC strict reserved
    // write ONLY when zero external calls happened (subagent-rpc.ts:908-913),
    // which is exactly as provable as a transport rejection — classifying it
    // as unknown would needlessly pause a recoverable operation (Phase 1
    // tasks 9/10). If the evidence write itself fails, fall through honestly
    // to "unknown" below (persisted not-sent cannot be claimed).
    const notSentReason =
      outcome === "conflict_blocked"
        ? "dispatch_config_conflict"
        : outcome === "strict_blocked"
          ? "strict_blocked_before_send"
          : "transport_confirmed_not_sent";
    const cur = ctx.session.getMeta();
    const st = cur?.designReview;
    if (st?.operation?.operationId === operationId) {
      const nextState: DesignReviewState = {
        ...st,
        operation: {
          ...st.operation,
          dispatchEvidence: "confirmed_not_sent",
          dispatchReason: notSentReason,
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
  // fallback_no_id / unknown / skipped_duplicate / receipt-write-failure:
  // outcome unverifiable → evidence "unknown". (strict_blocked is handled as
  // provable not-sent above, 192 issue 9.)
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
 * 194 Phase 3 (C3, task 2): establish the closed-loop executor RUN from a
 * trusted dispatch — the full agent id from the RPC reply plus the exact
 * operation context (including the pre-issued runId) the lifecycle watcher
 * carries. Entries without EITHER half never create a run: intent/prepared
 * state stays on the operation, and an owner session file the entry point
 * could not prove fail-closes to "no run" (recovery stays owner-driven).
 */
async function issueBoundExecutorRun(
  ctx: CoordinatorContext,
  dispatch: { agentId?: string; operationContext?: SpawnOperationContext },
): Promise<void> {
  const oc = dispatch.operationContext;
  if (!oc || !dispatch.agentId) return;
  const ownerSessionFile = ctx.actor && !ctx.actor.isChild ? ctx.actor.sessionFile : undefined;
  if (ownerSessionFile === undefined || ownerSessionFile.length === 0) {
    void safeWriteAuditLog("executor_run_issue", {
      action: "run_skip_no_owner_evidence",
      operationId: oc.operationId,
    }, "warn");
    return;
  }
  const issued = await issueExecutorRunOnDispatch({
    session: ctx.session,
    config: ctx.config,
    identity: { ownerSessionFile, agentId: dispatch.agentId, operationContext: oc },
  });
  if (!issued.ok) {
    void safeWriteAuditLog("executor_run_issue", {
      action: "run_issue_skipped",
      operationId: oc.operationId,
      reason: issued.reason,
    }, "warn");
  }
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
  /** 193 Phase 2: smart plan-revision decision guidance (REVIEW dispatches only) */
  reviewGuidance?: string,
): Promise<"trusted" | "unknown" | "not_sent" | "pending_queue" | "blocked"> {
  // 193 Phase 2 (task 4): the in-lock revision bump makes the CALLER'S
  // proposal potentially stale; the claim must anchor on the PERSISTED
  // authoritative record, so re-read before marking send-intent.
  const freshMeta = ctx.session.getMeta() ?? meta;
  const anchorState = freshMeta.designReview ?? committedState;
  const intent = markSendIntent(ctx, freshMeta, anchorState, operation.operationId);
  if (!intent.ok) {
    // Intent commit failed → NO external call may happen (F04/D04).
    return "blocked";
  }
  const spawnResult = await spawnDesignReviewAgent(
    ctx,
    freshMeta,
    intent.state,
    operation,
    updatePrompt,
    reviewGuidance,
  );
  const recorded = await recordDispatchOutcome(
    ctx,
    freshMeta,
    intent.state,
    operation.operationId,
    spawnResult.outcome,
    spawnResult.agentId,
  );
  // 194 Phase 3 (task 2): a trusted reply pair establishes the run right
  // after the dispatched receipt was persisted — never before.
  if (recorded === "trusted") {
    await issueBoundExecutorRun(ctx, spawnResult);
  }
  return recorded;
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
  /** 193 Phase 1: smart plan-revision decision guidance (REVIEW dispatches only) */
  reviewGuidance?: string,
): Promise<{
  ok: boolean;
  error?: string;
  agentId?: string;
  outcome?: import("../../utils/subagent-rpc").StageDispatchOutcome;
  /** 194 Phase 3 (task 2): the identity the spawn was dispatched under —
   * returned so the caller can establish the run from the SAME context the
   * lifecycle watcher will report back (runId included). */
  operationContext?: SpawnOperationContext;
}> {
  const freshMeta = ctx.session.getMeta() ?? meta;

  // 194 Phase 2 (task 1): the task input is built PER KIND, from persisted
  // state only. A develop handoff must receive the ORIGINAL PLAN as its task
  // (the previous shared producer handed it the review report), and every
  // dispatch names its own identities so the turn is recognisable as
  // plugin-dispatched work rather than ordinary chat.
  const reportDoc = drState.reportDoc ?? deriveReportPath(drState.planDoc, drState.round);
  // 194 Phase 2 (tasks 2/3): last-line resource check at RPC time (the prep
  // gate already protects zero-visit; this catches a config that broke AFTER
  // the visit). Verified assets also feed the prompt: absolute template path,
  // the agent's REAL tool list and the project-root search boundary.
  const gateDocs =
    operation.kind === "review"
      ? { writeDocs: [reportDoc], readOnlyDocs: [drState.planDoc] }
      : operation.kind === "update"
        ? { writeDocs: [drState.planDoc], readOnlyDocs: [reportDoc] }
        : { writeDocs: [], readOnlyDocs: [drState.planDoc, reportDoc] };
  const gate = await gateDesignReviewDispatchResources(ctx, operation.kind, gateDocs);
  if (!gate.ok) {
    return { ok: false, error: gate.reason, outcome: "not_sent" };
  }
  const resources = gate.resources;
  const task = buildDesignReviewDispatchTask({
    kind: operation.kind,
    pipelineId: freshMeta.pipelineId ?? drState.pipelineId ?? "unknown",
    planDoc: drState.planDoc,
    reportDoc,
    round: drState.round,
    operationId: operation.operationId,
    ...(operation.updateArtifact !== undefined
      ? { receiptDoc: operation.updateArtifact.receiptDoc }
      : {}),
    ...(resources !== null && resources.templateDoc !== null ? { templateDoc: resources.templateDoc } : {}),
    ...(resources !== null && resources.tools.length > 0 ? { agentTools: resources.tools } : {}),
    ...(resources !== null ? { searchRoot: path.resolve(ctx.config.projectRoot) } : {}),
    ...(updatePrompt !== undefined ? { updatePrompt } : {}),
    ...(reviewGuidance !== undefined ? { reviewGuidance } : {}),
  });
  if (task === null) {
    // An unrecognised kind must NOT be dispatched with a guessed task.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "dispatch_task_unsupported_kind",
      operationKind: String(operation.kind),
      operationId: operation.operationId,
      round: String(drState.round),
    }, "error");
    return { ok: false, error: "unsupported_operation_kind", outcome: "not_sent" };
  }
  const stage = task.stage;
  const finalPrompt = task.prompt;
  const spawnDescription = task.description;

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
    return { ok: true, agentId: spawnResult.agentId, outcome, operationContext };
  }

  await safeWriteAuditLog("design_review_coordinator", {
    action: "agent_spawn_not_dispatched",
    operationKind: operation.kind,
    operationId: operation.operationId,
    dispatchOutcome: outcome,
  }, "warn");
  return { ok: false, error: "spawn_failed", outcome };
}
