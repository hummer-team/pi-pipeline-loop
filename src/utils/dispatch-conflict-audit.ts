/**
 * Shared audit log helper for dispatch conflict blocked events.
 * Task 8 (195 review): Consolidates 4 unauthorized event names into a single
 * sanctioned event "dispatch_conflict_blocked" with a site field.
 *
 * Site identifiers:
 * - "pending_spawn" (subagent-rpc.ts)
 * - "pipeline_resume" (pipeline-start.ts)
 * - "auto_advance" (verify-advance.ts)
 * - "confirm_reject" (stage-advancer.ts)
 */

import { safeWriteAuditLog } from "./auditLog";

/**
 * Emits a consolidated "dispatch_conflict_blocked" audit event.
 *
 * @param site - One of: "pending_spawn", "pipeline_resume", "auto_advance", "confirm_reject"
 * @param fields - Additional audit fields (pipelineId, stage, reason, etc.)
 */
export async function emitDispatchConflictBlocked(
  site: "pending_spawn" | "pipeline_resume" | "auto_advance" | "confirm_reject",
  fields: Record<string, string | undefined>,
): Promise<void> {
  await safeWriteAuditLog("dispatch_conflict_blocked", {
    site,
    ...fields,
  });
}
