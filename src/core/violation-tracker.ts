/**
 * @module violation-tracker
 * Violation recording, prompt feedback, and overflow circuit-breaker.
 *
 * Design (R4Q2):
 * - recordViolation: appends a ViolationItem to meta.violations and writes audit.
 *   Pure recording — no freeze or side effects.
 * - checkViolationBreaker: checks if violations.length >= DEFAULT_MAX_VIOLATIONS,
 *   and triggers freezeAndPrompt("violation_overflow") when exceeded.
 *
 * These two functions are independent: recording never freezes, and the breaker
 * is a separate gate called after each record.
 */

import type { PipelineConfig, SessionMeta, ViolationItem } from "../types";
import { DEFAULT_MAX_VIOLATIONS } from "../constants";
import { safeWriteAuditLog, encodeAuditValue } from "../utils/auditLog";
import { freezeAndPrompt, type FlowStateCtx } from "./flow-state";

/**
 * Records a violation item into SessionMeta.violations and writes an audit entry.
 * Pure recording — no freeze, no counting side effects.
 *
 * @param ctx - Context with session access
 * @param meta - Current SessionMeta snapshot
 * @param item - The ViolationItem to record
 */
export async function recordViolation(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  item: ViolationItem,
): Promise<void> {
  const violations = [...(meta.violations || []), item];
  ctx.session.updateMeta({ violations });

  await safeWriteAuditLog("pipeline_violation", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    type: item.type,
    tool: item.tool ?? "",
    detail: encodeAuditValue(item.detail),
    count: String(violations.length),
  }, "warn");
}

/**
 * Checks the violation count against DEFAULT_MAX_VIOLATIONS and triggers
 * freezeAndPrompt("violation_overflow") when the threshold is reached.
 *
 * Idempotent: freezeAndPrompt is itself idempotent (only transitions running → blocked).
 *
 * @param ctx - Context with session and optional UI
 * @param meta - Current SessionMeta snapshot (must include latest violations)
 * @param config - PipelineConfig for freezeAndPrompt
 */
export async function checkViolationBreaker(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
): Promise<void> {
  const count = (meta.violations || []).length;
  if (count >= DEFAULT_MAX_VIOLATIONS) {
    await freezeAndPrompt(ctx, meta, "violation_overflow", config);
  }
}
