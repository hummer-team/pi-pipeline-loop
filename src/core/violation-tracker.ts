/**
 * @module violation-tracker
 * Violation recording, prompt feedback, and overflow circuit-breaker.
 *
 * Design (Phase 7 - 195_Bug):
 * - recordViolation: appends a ViolationItem to meta.violations and writes audit.
 *   Pure recording — no freeze or side effects.
 * - checkViolationBreaker: checks each bucket against DEFAULT_MAX_VIOLATIONS,
 *   and triggers freezeAndPrompt("violation_overflow") when exceeded.
 *   Exception: bash_destructive bucket NEVER triggers freeze (advisory-only).
 *
 * These two functions are independent: recording never freezes, and the breaker
 * is a separate gate called after each record.
 */

import type { PipelineConfig, SessionMeta, ViolationItem } from "../types";
import { DEFAULT_MAX_VIOLATIONS, DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX } from "../constants";
import { safeWriteAuditLog, encodeAuditValue } from "../utils/auditLog";
import { freezeAndPrompt, type FlowStateCtx } from "./flow-state";
// Phase 0 (182): dispatch stage executor after choose_stage from frozen menu
import { buildOnStageChangedCallback } from "../commands/pipeline-start";

/**
 * Phase 7 (195_Bug): Guard source type for bucket-based violation counting.
 */
export type GuardSource = "read_only_path" | "dynamic_write_scope" | "git_policy" | "bash_destructive" | "legacy";

/**
 * Phase 7 (195_Bug): Group violations by guardSource for bucket-based counting.
 * Items without guardSource are counted as "legacy" for backward compatibility.
 *
 * @param violations - Array of violation items
 * @returns Map of guardSource to count
 */
export function groupViolationsByGuardSource(
  violations: ViolationItem[]
): Record<GuardSource, number> {
  const buckets: Record<GuardSource, number> = {
    read_only_path: 0,
    dynamic_write_scope: 0,
    git_policy: 0,
    bash_destructive: 0,
    legacy: 0,
  };

  for (const item of violations) {
    const source = item.guardSource ?? "legacy";
    buckets[source]++;
  }

  return buckets;
}

/**
 * Records a violation item into SessionMeta.violations and writes an audit entry.
 * Pure recording — no freeze, no counting side effects.
 *
 * Phase 7 (195_Bug): Audit log now includes guardSource, bucketCount, and bucketLimit.
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

  // Phase 7 (195_Bug): compute bucket count and limit for audit
  const buckets = groupViolationsByGuardSource(violations);
  const guardSource = item.guardSource ?? "legacy";
  const bucketCount = buckets[guardSource];
  const bucketLimit = guardSource === "bash_destructive"
    ? DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX
    : DEFAULT_MAX_VIOLATIONS;

  await safeWriteAuditLog("pipeline_violation", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    type: item.type,
    tool: item.tool ?? "",
    detail: encodeAuditValue(item.detail),
    count: String(violations.length),
    // Phase 7 (195_Bug): bucket-based fields
    guardSource,
    bucketCount: String(bucketCount),
    bucketLimit: String(bucketLimit),
  }, "warn");
}

/**
 * Checks the violation count against DEFAULT_MAX_VIOLATIONS and triggers
 * freezeAndPrompt("violation_overflow") when the threshold is reached.
 *
 * Phase 7 (195_Bug): Checks each bucket independently. bash_destructive bucket
 * NEVER triggers freeze (advisory-only, governed by DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX).
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
  const violations = meta.violations || [];
  const buckets = groupViolationsByGuardSource(violations);

  // Phase 7 (195_Bug): check each bucket except bash_destructive
  // bash_destructive is advisory-only, never triggers freeze
  for (const [source, count] of Object.entries(buckets)) {
    if (source === "bash_destructive") continue;
    if (count >= DEFAULT_MAX_VIOLATIONS) {
      // Phase 0 (182): inject onStageChanged so choose_stage dispatches the executor
      await freezeAndPrompt(ctx, meta, "violation_overflow", config, {
        onStageChanged: buildOnStageChangedCallback(ctx, config),
      });
      return; // Only freeze once
    }
  }
}
