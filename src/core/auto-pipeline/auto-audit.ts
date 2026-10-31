/**
 * @module auto-pipeline/auto-audit
 * 219 Phase 3 §8: the audit switch whitelist.
 *
 * `audit.autoDecisions` (config) / `audit.recordAutoDecisions` (job) control
 * EXACTLY ONE event: `pipeline_auto_decision` (the per-gate decision rows —
 * the largest volume, and the only ones that are pure noise when disabled).
 *
 * Every lifecycle / safety event (`pipeline_auto_start`, `_job_overlay`,
 * `_overlay_replay`, `_overlay_restore`, `_overlay_kept`, `_cleanup`, `_stop`,
 * `_chain`, `_continuity`, `_lock`, `whitelist_allow_exempt`) is ALWAYS
 * written — those calls deliberately do NOT go through this helper.
 */

import type { AuditLogLevel, PipelineConfig } from "../../types";
import { safeWriteAuditLog } from "../../utils/auditLog";

/** Audit payload shape accepted by `safeWriteAuditLog`. */
export type AutoAuditPayload = Record<string, string | boolean>;

/**
 * TRUE when per-gate auto decisions should be recorded. Reads the RESOLVED
 * `audit.autoDecisions` (default `true`), so a config that never went through
 * `resolvePipelineConfig` (test fixtures) keeps recording.
 */
export function shouldRecordAutoDecision(config: PipelineConfig): boolean {
  return config.audit?.autoDecisions !== false;
}

/**
 * Write ONE `pipeline_auto_decision` row when the whitelist allows it.
 * Fail-open (audit failure never changes control flow) and never throws.
 */
export async function auditAutoDecision(
  config: PipelineConfig,
  payload: AutoAuditPayload,
  level: AuditLogLevel = "info",
): Promise<void> {
  if (!shouldRecordAutoDecision(config)) return;
  try {
    await safeWriteAuditLog("pipeline_auto_decision", { source: "auto_pipeline", ...payload }, level);
  } catch {
    // Audit failure must never change control flow (same contract as
    // `safeWriteAuditLog`; the test override can still throw).
  }
}
