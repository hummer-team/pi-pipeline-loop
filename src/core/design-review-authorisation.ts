/**
 * @module design-review-authorisation
 * Phase 4 / 191: Owner authorisation gate for design-review direct entry.
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

import type { PipelineConfig, SessionMeta, DesignReviewState } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import { safeWriteAuditLog } from "../utils/auditLog";
import { detectSessionRole } from "./session-role";
import { createInitialState, computeHash } from "./design-review-state";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Result of authorisation gate check.
 */
export type AuthorisationGateResult =
  | { ok: true; state: DesignReviewState }
  | { ok: false; reason: string };

/**
 * Validates prerequisites for design-review authorisation.
 *
 * Checks:
 * - Requirement document exists
 * - Plan document exists (derived from requirement doc)
 * - Config has design-review stage enabled with agentPath and skillPath
 *
 * @param config - Pipeline configuration
 * @param requirementDoc - Path to requirement document
 * @returns Validation result with error message if failed
 */
async function validateDesignReviewPrerequisites(
  config: PipelineConfig,
  requirementDoc: string,
): Promise<{ valid: boolean; error?: string; planDoc?: string }> {
  // Check requirement doc exists
  try {
    const reqPath = path.isAbsolute(requirementDoc)
      ? requirementDoc
      : path.join(config.projectRoot, requirementDoc);
    await fs.access(reqPath);
  } catch {
    return { valid: false, error: "requirement_doc_missing" };
  }

  // Derive plan document path (same logic as plan stage)
  const planDoc = requirementDoc.replace(/\.md$/, "_plan.md");
  try {
    const planPath = path.isAbsolute(planDoc)
      ? planDoc
      : path.join(config.projectRoot, planDoc);
    await fs.access(planPath);
  } catch {
    return { valid: false, error: "plan_doc_missing" };
  }

  // Check design-review stage configuration
  const drStage = config.stages["design-review"];
  if (!drStage || drStage.disabled) {
    return { valid: false, error: "design_review_disabled" };
  }
  if (!drStage.agentPath || !drStage.skillPath) {
    return { valid: false, error: "design_review_config_invalid" };
  }

  return { valid: true, planDoc };
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

  const validation = await validateDesignReviewPrerequisites(config, requirementDoc);
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

  // Step 5: Compute plan hash and create new authorisation
  const planDoc = validation.planDoc!;
  const planPath = path.isAbsolute(planDoc)
    ? planDoc
    : path.join(config.projectRoot, planDoc);
  const planContent = await fs.readFile(planPath, "utf-8");
  const planHash = computeHash(planContent);

  const newState = createInitialState(
    planDoc,
    "direct-entry",
    planHash,
    role.sessionFile,
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
