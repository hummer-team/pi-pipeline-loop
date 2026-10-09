/**
 * @module design-review/update-preparation
 * 194 Phase 1 (task 1): ONE preparation path shared by the FAIL consumption,
 * the `update_ready` dispatch and later recovery, so a plan revision can never
 * be dispatched from a half-built contract.
 *
 * Ordering is the whole point (acceptance: "配置错零RPC/零visit"):
 *   1. read the baseline plan bytes (needed to pin the C1 digest);
 *   2. build the candidate operation and PIN its standalone output descriptor
 *      (plugin-derived receipt path + baseline sections digest) — never model
 *      supplied, never derived from "the newest file in the directory";
 *   3. select + render the update prompt WITH the externalized receipt token;
 *   4. preflight the exact write scope (plan + receipt) against the protection
 *      chain, so an unavoidable conflict blocks BEFORE dispatching;
 *   5. ONLY THEN does the caller record a visit / write a send intent / RPC.
 *
 * Any failure before step 5 returns a reason and leaves the persisted state
 * untouched: no stage visit consumed, no intent marker, zero RPCs — the loop
 * stays where it is and a later settle/advance/retry can prepare again.
 *
 * A custom YAML template that still asks the model to write the receipt INTO
 * the plan is a configuration error under C2: `prompt.ts` reports the offending
 * key and file path and the dispatch blocks — the built-in default is never
 * silently substituted.
 */

import fs from "node:fs/promises";
import type {
  DesignReviewOperation,
  DesignReviewState,
  PipelineConfig,
  SessionMeta,
} from "../../types";
import {
  createStandaloneUpdateArtifact,
  extractLegacyUpdateSections,
  type StandaloneUpdateArtifact,
} from "./update-artifact";
import {
  buildDesignReviewUpdatePrompt,
  DesignReviewUpdateConfigError,
  type DesignReviewUpdateTemplateSelection,
} from "./prompt";
import { computeUpdateInputHash } from "./state";
import { prepareDesignReviewOperation } from "./dispatch";
import { findWriteScopeConflicts } from "./write-policy";
import { resolveProtectConfig } from "../../utils/protect";
import { loadGitignoreInfo } from "../../utils/gitignore";
import { safeWriteAuditLog } from "../../utils/auditLog";

/** A prepared, dispatchable update candidate (nothing persisted yet). */
export interface UpdateDispatchCandidate {
  /** Operation carrying the pinned C1 descriptor and not-sent evidence. */
  operation: DesignReviewOperation;
  /** Rendered task prompt (externalized-receipt contract). */
  prompt: string;
  /** Input hash bound to the candidate (baseline plan + report + issue ids). */
  inputHash: string;
  /** Plugin-derived absolute receipt document this update must produce. */
  receiptDoc: string;
  /** The pinned descriptor itself (for commit + audit). */
  artifact: StandaloneUpdateArtifact;
  /** Which template produced `prompt` (audit provenance). */
  selection: DesignReviewUpdateTemplateSelection;
}

export type UpdatePreparationResult =
  | { ok: true; candidate: UpdateDispatchCandidate }
  | { ok: false; reason: string; detail: string };

/** Inputs the caller must already have bound from the consumed report. */
export interface UpdatePreparationRequest {
  config: PipelineConfig;
  meta: SessionMeta;
  /**
   * State used for operation preparation and transition validation. The FAIL
   * path passes the intermediate `update_ready` view (review_running →
   * update_ready → update_running is the legal route) because the unified
   * commit lands in `update_running` in one step.
   */
  baseState: DesignReviewState;
  /** Consumed report path (exact snapshot, never re-derived). */
  reportDoc: string;
  /** Hash of that consumed report. */
  reportHash: string;
  /** Issue texts handed to the update agent (from the SAME snapshot). */
  issues: readonly string[];
  /** Issue ids bound to those texts (identity material for the receipt). */
  issueIds: readonly string[];
  /** Stage visit the candidate operation is bound to (fresh plan visit). */
  stageVisitId: number;
}

/** Step 1+2: baseline read + C1 descriptor pinning. */
async function pinUpdateCandidate(
  req: UpdatePreparationRequest,
): Promise<{ ok: true; operation: DesignReviewOperation; artifact: StandaloneUpdateArtifact; inputHash: string } | { ok: false; reason: string; detail: string }> {
  const { baseState } = req;

  // The baseline digest must describe the plan as it is RIGHT NOW: the
  // historical protocol sections are frozen, so the verifier can prove later
  // that this update neither added nor edited a plan-body receipt.
  let planContent: string;
  try {
    planContent = await fs.readFile(baseState.planDoc, "utf-8");
  } catch (error) {
    return {
      ok: false,
      reason: "update_plan_baseline_unreadable",
      detail: `${baseState.planDoc}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const inputHash = computeUpdateInputHash({
    baselinePlanHash: baseState.planHash ?? "",
    reportHash: req.reportHash,
    issueIds: req.issueIds,
  });

  const operation = prepareDesignReviewOperation(
    baseState,
    "update",
    req.stageVisitId,
    inputHash,
  );
  if (!operation) {
    return { ok: false, reason: "operation_creation_failed", detail: "prepareDesignReviewOperation returned undefined" };
  }

  const artifact = createStandaloneUpdateArtifact(
    baseState.planDoc,
    baseState.round,
    operation.operationId,
    extractLegacyUpdateSections(planContent),
  );
  if (!artifact) {
    return {
      ok: false,
      reason: "update_artifact_identity_invalid",
      detail: `cannot derive a safe receipt path for round ${String(baseState.round)} / operation ${operation.operationId}`,
    };
  }

  // Evidence says "prepared, not sent": an abort before the intent marker must
  // never look like a dispatch of an operation the model may already know.
  return {
    ok: true,
    inputHash,
    artifact,
    operation: {
      ...operation,
      dispatchEvidence: operation.dispatchEvidence ?? "confirmed_not_sent",
      dispatchReason: operation.dispatchReason ?? "prepared_not_dispatched",
      updateArtifact: artifact,
    },
  };
}

/** Step 3: select + render the update prompt over the pinned receipt path. */
async function renderUpdatePrompt(
  req: UpdatePreparationRequest,
  operation: DesignReviewOperation,
  artifact: StandaloneUpdateArtifact,
): Promise<{ ok: true; prompt: string; selection: DesignReviewUpdateTemplateSelection } | { ok: false; reason: string; detail: string }> {
  try {
    const built = await buildDesignReviewUpdatePrompt(req.config, {
      pipelineId: req.meta.pipelineId ?? "unknown",
      planDoc: req.baseState.planDoc,
      reviewDoc: req.reportDoc,
      round: req.baseState.round,
      operationId: operation.operationId,
      baselinePlanHash: req.baseState.planHash ?? "",
      issues: [...req.issues],
      // C1/C2: the receipt is an EXTERNAL document — the prompt names it.
      updateReceiptDoc: artifact.receiptDoc,
      ...(req.baseState.requirementDoc !== undefined ? { requirementDoc: req.baseState.requirementDoc } : {}),
    });
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_prompt_source",
      source: built.selection.source,
      ...(built.selection.path !== undefined ? { path: built.selection.path } : {}),
      key: built.selection.key,
      contentHash: built.selection.contentHash.substring(0, 12),
      operationId: operation.operationId,
    });
    return { ok: true, prompt: built.prompt, selection: built.selection };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof DesignReviewUpdateConfigError) {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "update_prompt_render_failed",
        error: detail,
        ...(error.stack !== undefined ? { stack: error.stack } : {}),
        code: error.code,
        file: error.filePath ?? "",
        key: error.key ?? "",
      });
    } else {
      await safeWriteAuditLog("design_review_coordinator", {
        action: "update_prompt_render_failed",
        error: detail,
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      });
    }
    return { ok: false, reason: "update_prompt_render_failed", detail };
  }
}

/** Step 4: would the guard refuse this update's own deliverables? */
async function preflightUpdateScope(
  req: UpdatePreparationRequest,
  artifact: StandaloneUpdateArtifact,
): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
  const gitignore = await loadGitignoreInfo(req.config.projectRoot);
  const protectState = resolveProtectConfig(req.config, gitignore);
  const conflicts = findWriteScopeConflicts(
    req.config,
    "plan",
    req.config.projectRoot,
    [req.baseState.planDoc, artifact.receiptDoc],
    protectState,
  );
  if (conflicts.length === 0) return { ok: true };
  const detail = conflicts
    .map((c) => `${c.relPath ?? c.absPath} (${c.reason})`)
    .join("; ");
  await safeWriteAuditLog("design_review_coordinator", {
    action: "update_scope_conflict",
    conflicts: detail,
    round: String(req.baseState.round),
  }, "warn");
  return {
    ok: false,
    reason: "update_scope_conflict",
    detail: `plan/receipt deliverables collide with protection or read-only paths: ${detail}`,
  };
}

/**
 * Prepare a dispatchable update candidate. Performs NO state commit, records NO
 * stage visit, writes NO send intent and issues NO RPC — the caller advances
 * only on `ok:true`. See module docs for the ordering guarantees.
 */
export async function prepareUpdateDispatch(
  req: UpdatePreparationRequest,
): Promise<UpdatePreparationResult> {
  const pinned = await pinUpdateCandidate(req);
  if (!pinned.ok) {
    await safeWriteAuditLog("design_review_coordinator", {
      action: "update_preparation_failed",
      reason: pinned.reason,
      detail: pinned.detail,
      round: String(req.baseState.round),
    }, "warn");
    return { ok: false, reason: pinned.reason, detail: pinned.detail };
  }

  const rendered = await renderUpdatePrompt(req, pinned.operation, pinned.artifact);
  if (!rendered.ok) {
    return { ok: false, reason: rendered.reason, detail: rendered.detail };
  }

  const scope = await preflightUpdateScope(req, pinned.artifact);
  if (!scope.ok) {
    return { ok: false, reason: scope.reason, detail: scope.detail };
  }

  return {
    ok: true,
    candidate: {
      operation: pinned.operation,
      prompt: rendered.prompt,
      inputHash: pinned.inputHash,
      receiptDoc: pinned.artifact.receiptDoc,
      artifact: pinned.artifact,
      selection: rendered.selection,
    },
  };
}
