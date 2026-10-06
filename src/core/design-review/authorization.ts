/**
 * @module design-review/authorization
 * Phase 4 / 191 + 192 Phase 0: Owner authorisation gate for design-review direct entry.
 *
 * Implements the authorisation requirements from Task 6:
 * - Old authorisation must be invalidated before new entry
 * - Clear prompt: "FAIL automatically updates and re-reviews, PASS automatically proceeds to development"
 * - Only establish new authorisation after confirmation AND validation
 * - Cancel/no UI/missing docs → don't spawn
 * - child/tool sessions cannot authorise
 * - Same-run trusted owner recovery CAN take over
 * - New run/quit/manual stage change CANNOT inherit authorisation
 */

import type { PipelineConfig, SessionMeta, DesignReviewState } from "../../types";
import type { RuntimeCtx } from "../runtime-ctx";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { detectSessionRole } from "../session-role";
import { createInitialState, computeHash } from "./state";
import { validateDesignReviewStageAssets, resolveDesignReviewEntryDocs, pickSafeNextRound } from "./entry";
import fs from "node:fs/promises";

/**
 * Result of authorisation gate check.
 */
export type AuthorisationGateResult =
  | { ok: true; state: DesignReviewState }
  | { ok: false; reason: string };

/**
 * Validates prerequisites for design-review authorisation.
 *
 * Delegates shared document/asset resolution to `entry.ts` so the menu path
 * and this direct-entry gate cannot diverge. Checks:
 * - Requirement document exists
 * - Plan document exists (derived from requirement doc)
 * - Config has design-review stage enabled with agentPath and skillPath
 */
async function validateDesignReviewPrerequisites(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<{ valid: boolean; error?: string; planDoc?: string; requirementDoc?: string }> {
  const docs = resolveDesignReviewEntryDocs(config, meta);
  if (!docs.requirementDoc || !docs.requirementExists) {
    return { valid: false, error: "requirement_doc_missing" };
  }
  if (!docs.planDoc || !docs.planExists) {
    return { valid: false, error: "plan_doc_missing" };
  }

  const stageCheck = validateDesignReviewStageAssets(config);
  if (!stageCheck.ok) {
    return { valid: false, error: stageCheck.error };
  }

  return { valid: true, planDoc: docs.planDoc, requirementDoc: docs.requirementDoc };
}

/**
 * Owner authorisation gate for design-review direct entry.
 *
 * This gate enforces:
 * 1. Child/tool sessions cannot authorise
 * 2. Prerequisites must be valid (requirement doc, plan doc, config)
 * 3. User must be prompted with clear PASS/FAIL behavior
 * 4. User must confirm
 * 5. New authorisation is created only after confirmation
 *
 * @param ctx - Runtime context
 * @param config - Pipeline configuration
 * @param meta - Current session metadata
 * @returns Authorisation gate result
 */
export async function designReviewAuthorisationGate(
  ctx: RuntimeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<AuthorisationGateResult> {
  const pipelineId = meta.pipelineId ?? "unknown";

  // Step 1: Reject child/tool sessions
  const role = detectSessionRole(ctx);
  if (role.isChild) {
    await safeWriteAuditLog("design_review_authorisation_gate", {
      pipelineId,
      result: "rejected_child_session",
      sessionFile: role.sessionFile ?? "unknown",
    }, "warn");
    return { ok: false, reason: "child_session_cannot_authorise" };
  }

  // Step 2: Validate prerequisites
  const requirementDoc = meta.requirementDoc;
  if (!requirementDoc) {
    await safeWriteAuditLog("design_review_authorisation_gate", {
      pipelineId,
      result: "rejected_no_requirement_doc",
    }, "warn");
    return { ok: false, reason: "requirement_doc_missing" };
  }

  const validation = await validateDesignReviewPrerequisites(config, meta);
  if (!validation.valid) {
    await safeWriteAuditLog("design_review_authorisation_gate", {
      pipelineId,
      result: `rejected_${validation.error}`,
      requirementDoc,
    }, "warn");
    return { ok: false, reason: validation.error! };
  }

  // Step 3: Check for TUI availability
  const hasTui = typeof ctx.ui?.select === "function" && typeof ctx.ui?.confirm === "function";
  if (!hasTui) {
    await safeWriteAuditLog("design_review_authorisation_gate", {
      pipelineId,
      result: "rejected_no_tui",
    }, "warn");
    return { ok: false, reason: "tui_unavailable" };
  }

  // Step 4: Prompt user with clear PASS/FAIL behavior
  const promptTitle = "Design Review Stage Entry";
  const promptMessage = [
    "You are about to enter the design-review stage.",
    "",
    "Behaviour:",
    "• PASS: Review report passes → automatically proceed to develop stage",
    "• FAIL: Review report fails → automatically update plan and re-review",
    "",
    "This process will loop until the design is approved or budget is exhausted.",
    "",
    "Do you want to proceed?",
  ].join("\n");

  const confirmed = await ctx.ui.confirm(promptTitle, promptMessage);
  if (!confirmed) {
    await safeWriteAuditLog("design_review_authorisation_gate", {
      pipelineId,
      result: "user_cancelled",
    });
    return { ok: false, reason: "user_cancelled" };
  }

  // Step 5: Compute plan hash and create new authorisation.
  // validation.planDoc is already absolute (entry.ts canonicalizes paths).
  // Round allocation must not overwrite any strictly-named historical report
  // (F02/K07): scan the plan directory and take a safe next round.
  const planDoc = validation.planDoc!;
  const planContent = await fs.readFile(planDoc, "utf-8");
  const planHash = computeHash(planContent);
  const safeRound = pickSafeNextRound(planDoc);

  const newState = createInitialState(
    planDoc,
    "direct-entry",
    planHash,
    role.sessionFile,
    {
      pipelineId: meta.pipelineId,
      requirementDoc: validation.requirementDoc,
      round: safeRound,
    },
  );

  await safeWriteAuditLog("design_review_authorisation_gate", {
    pipelineId,
    result: "authorised",
    authorizationId: newState.authorizationId,
    planDoc,
    planHash: planHash.substring(0, 12),
    round: String(newState.round),
    sessionFile: role.sessionFile ?? "unknown",
  });

  return { ok: true, state: newState };
}
