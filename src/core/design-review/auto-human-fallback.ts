/**
 * @module design-review/auto-human-fallback
 * 227 Phase 2 (D-14): in an auto job, `request-human` is never a menu.
 *
 * The FAIL matrix:
 * - `manual` (auto job) ⇒ `stop` — stop-and-report; `onFail` never rewrites it
 *   (there is nobody to answer a menu under unattended execution);
 * - `smart` + `request-human` ⇒ `onFail` decides (`auto-revise` → plan revision,
 *   `stop` → hard stop);
 * - `auto` never routes here (a FAIL releases the plan revision directly).
 *
 * The human track keeps its existing menu verbatim (`null`).
 */

import type { ConfirmMode, SessionMeta } from "../../types";
import type { DesignReviewOnFail } from "../auto-pipeline/job-schema";
import type { CoordinatorContext, CoordinatorResult } from "./coordinator";
import { stopAutoDocOnHardFailure } from "../auto-pipeline/stop-policy";

/** The routing decision for a `request-human` FAIL, or null (human track). */
export function resolveAutoHumanFallback(
  meta: SessionMeta,
  mode: ConfirmMode,
  onFail: DesignReviewOnFail,
): "revise-plan" | "stop" | null {
  if (!meta.autoJob) return null; // human track: existing menu
  if (mode === "manual") return "stop"; // manual ⇒ stop-and-report, onFail never rewrites
  return onFail === "stop" ? "stop" : "revise-plan";
}

/**
 * Apply the `stop` leg: the shared 227 hard-stop transaction (owner executes,
 * child forwards). The caller routes `revise-plan` through the EXISTING
 * `handleFail`, so this helper never re-implements plan revision.
 */
export async function applyAutoHumanFallback(
  ctx: CoordinatorContext,
  meta: SessionMeta,
  decision: "revise-plan" | "stop",
): Promise<CoordinatorResult> {
  if (decision === "revise-plan") {
    // Defensive: the coordinator calls `handleFail` itself for this leg.
    return { status: "handled", action: "pending", reason: "auto_revise_plan" };
  }
  await stopAutoDocOnHardFailure({
    ctx,
    config: ctx.config,
    meta,
    reason: "design_review_manual_fail",
    auditEvent: "design_review_auto_human_stop",
    // 227 review fix (issue 2): `CoordinatorContext` drops `_ctx`, so role
    // detection would degrade a CHILD to owner and finalize the job in the
    // child process. Forward the entry's explicit role evidence instead.
    isChild: ctx.roleIsChild,
  });
  return { status: "handled", action: "pending", reason: "design_review_manual_fail" };
}
