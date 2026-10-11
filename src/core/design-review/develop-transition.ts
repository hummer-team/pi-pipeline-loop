/**
 * @module design-review/develop-transition
 * 193 Phase 2 (task 10): the SINGLE develop-transition preparation shared by
 * a verified PASS and by a persisted human `proceed-develop` override of a
 * REAL FAIL. Extraction keeps one truth: stage/visit/operation/approval and
 * the strict commit land in exactly ONE place, then the caller continues with
 * the existing dispatchHandoffOnce / receipt / finished machinery.
 *
 * Authorization basis rules (locked semantics):
 * - PASS writes `basis: { kind: "report-pass" }` explicitly.
 * - A FAIL released by a human writes
 *   `basis: { kind: "human-override", decisionId, issueIds, decidedAt }` and
 *   binds that basis into the handoff inputHash via `authorizationBasisHash`
 *   (optional field — a PASS payload hashes exactly like pre-193).
 * - Legacy approvals WITHOUT basis are readable and compatible as PASS
 *   certifications only; they never authorize a FAIL release.
 * - The FAIL path NEVER touches the PASS drift/verdict machinery: the real
 *   FAIL outcome and its issues stay persisted (the caller commits them).
 */

import type {
  DesignReviewApproval,
  DesignReviewApprovalBasis,
  DesignReviewOperation,
  DesignReviewState,
  HumanDecision,
  PipelineConfig,
  SessionMeta,
} from "../../types";
import {
  strictCommitMeta,
  type MetaCommitExpectation,
  type StrictCommitSession,
} from "../session-state";
import { computeHash, createOperation, computeHandoffInputHash, transitionPhase } from "./state";
import { recordStageVisit, effectiveMax } from "../../utils/stage-visit";
import { safeWriteAuditLog } from "../../utils/auditLog";

/** Minimal context the transition preparation needs (structurally satisfied by CoordinatorContext). */
export interface DevelopTransitionCtx {
  config: PipelineConfig;
  session: StrictCommitSession;
}

export type DevelopTransitionPrep =
  | {
      ok: true;
      /** Persisted (read-back) meta — callers MUST use this revision */
      meta: SessionMeta;
      /** Persisted pass_ready state (read-back) */
      state: DesignReviewState;
      /** The created develop-handoff operation (evidence: confirmed_not_sent) */
      handoffOp: DesignReviewOperation;
    }
  | { ok: false; result: { status: "handled"; action: "pending" | "frozen"; reason: string } };

/**
 * Key-sorted canonical JSON — the approval basis hash must be stable across
 * processes regardless of object key insertion order.
 */
function canonicalBasisJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalBasisJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalBasisJson(obj[k])}`)
    .join(",")}}`;
}

/**
 * 193 Phase 2 (task 10): the hash binding a human-override approval basis to
 * the develop-handoff operation. PASS transitions never call this (the field
 * stays absent and the payload hashes as before).
 */
export function computeAuthorizationBasisHash(basis: DesignReviewApprovalBasis): string {
  return computeHash(canonicalBasisJson(basis));
}

/** Build the human-override basis for a persisted chosen decision. */
export function buildHumanOverrideBasis(decision: HumanDecision): DesignReviewApprovalBasis {
  if (decision.state !== "chosen" || decision.choice !== "proceed-develop") {
    // Defensive: only a chosen proceed-develop decision can authorize.
    throw new Error("human-override basis requires a chosen proceed-develop decision");
  }
  return {
    kind: "human-override",
    decisionId: decision.decisionId,
    issueIds: decision.issues.map((i) => i.issueId),
    decidedAt: decision.decidedAt,
  };
}

/**
 * Shared transition preparation (extracted 1:1 from the former handlePass
 * body between the drift check and dispatchHandoffOnce):
 *
 * 1. develop stage availability (audit `develop_unavailable` → pending);
 * 2. recordStageVisit("develop") (frozen + visit patch on exhaustion);
 * 3. approval milestone with explicit basis;
 * 4. NEW develop-handoff operation bound to the fresh visit (inputHash over
 *    review op/round/planHash/reportHash, plus optional authorizationBasisHash);
 * 5. ONE strict commit (approval + handoff + stage + counters, phase
 *    pass_ready — takeover retained until the trusted receipt + finished);
 *    for a human override the expectation ALSO pins decisionId + chosen.
 *
 * Failure paths persist NOTHING and perform ZERO external calls — identical
 * to the pre-193 handlePass guarantees (same audit actions, same reasons).
 */
export async function prepareDevelopTransition(args: {
  ctx: DevelopTransitionCtx;
  meta: SessionMeta;
  drState: DesignReviewState;
  /** Hash of the report snapshot the transition is bound to (FAIL hash for overrides) */
  reportHash: string;
  /** CURRENT plan hash (caller drift-checked it for PASS; override revalidated it) */
  planHash: string;
  /** Approval authorization basis. Default: report-pass certification. */
  approvalBasis?: DesignReviewApprovalBasis;
  /** 193 Phase 2: human-decision anchor for the commit expectation (override only) */
  decisionAnchor?: { decisionId: string };
}): Promise<DevelopTransitionPrep> {
  const { ctx, meta, drState, reportHash, planHash, decisionAnchor } = args;
  const approvalBasis: DesignReviewApprovalBasis = args.approvalBasis ?? { kind: "report-pass" };

  // Develop stage availability (same check & audit as the former handlePass).
  const developConfig = ctx.config.stages["develop"];
  if (!developConfig || !developConfig.agentPath || !developConfig.skillPath || developConfig.disabled) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "develop_unavailable",
    });
    return { ok: false, result: { status: "handled", action: "pending", reason: "develop_stage_unavailable" } };
  }

  // Record transition (fresh develop visit material).
  const visitResult = recordStageVisit(meta, "develop", effectiveMax(meta, ctx.config), ctx.config);
  if (!visitResult.ok) {
    ctx.session.updateMeta(visitResult.patch);
    return { ok: false, result: { status: "handled", action: "frozen", reason: "max_loop_cycles" } };
  }

  // Milestone 1: approval bound to the CONSUMED review identity + hashes,
  // with the EXPLICIT authorization basis (193 Phase 2).
  const reviewOpId = drState.operation?.operationId ?? "unknown";
  const approval: DesignReviewApproval = {
    reviewOperationId: reviewOpId,
    round: drState.round,
    planHash,
    reportHash,
    authorizedAt: Date.now(),
    basis: approvalBasis,
  };

  // Milestone 2 preparation: NEW develop-handoff operation (its own id),
  // bound to the FRESH develop visit. Evidence starts as confirmed not-sent.
  // For a human override the approval basis is HASH-BOUND into the operation
  // inputHash; PASS omits the field so the payload stays byte-compatible.
  const newVisit = Date.now();
  const basisHash =
    approvalBasis.kind === "human-override" ? computeAuthorizationBasisHash(approvalBasis) : undefined;
  const handoffOp = createOperation(
    "develop-handoff",
    newVisit,
    1,
    computeHandoffInputHash({
      reviewOperationId: reviewOpId,
      round: drState.round,
      planHash,
      reportHash,
      ...(basisHash !== undefined ? { authorizationBasisHash: basisHash } : {}),
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
  const expected: MetaCommitExpectation = {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: drState.authorizationId,
    round: drState.round,
    operationId: drState.operation?.operationId ?? null,
    phase: drState.phase,
    stateUpdatedAt: drState.updatedAt,
    // 193 Phase 2: an override migration ALSO pins the persisted human
    // choice — a changed decision (another writer cleared/replaced it) makes
    // this commit conflict with ZERO effect.
    ...(decisionAnchor
      ? { decisionId: decisionAnchor.decisionId, decisionState: "chosen" as const }
      : {}),
  };
  const commitRes = strictCommitMeta(ctx.session, stagePatch, expected);
  if (commitRes.status !== "persisted") {
    // Handoff intent NOT reliably persisted → zero external calls (row 1 of
    // the DR192-01 matrix): stay in the previous phase, retry later.
    await safeWriteAuditLog("design_review_coordinator", {
      action: "handoff_transition_commit_failed",
      status: commitRes.status,
      reason: commitRes.reason,
      round: String(drState.round),
      basis: approvalBasis.kind,
    }, "error");
    return {
      ok: false,
      result: {
        status: "handled",
        action: "pending",
        reason: `pass_commit_failed:${commitRes.status}:${commitRes.reason}`,
      },
    };
  }

  await safeWriteAuditLog("design_review_coordinator", {
    action: approvalBasis.kind === "human-override" ? "override_approved" : "pass_approved",
    reportHash,
    planHash,
    round: String(drState.round),
    reviewOperationId: reviewOpId,
    handoffOperationId: preparedHandoff.operationId,
  });

  return {
    ok: true,
    meta: commitRes.meta,
    state: commitRes.meta.designReview ?? passReadyState,
    handoffOp: preparedHandoff,
  };
}
