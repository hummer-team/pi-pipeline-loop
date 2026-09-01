/**
 * @module audit-throttle
 * Shared throttle helpers for audit/notification deduplication.
 *
 * Provides two flavours used across the pipeline:
 * 1. Meta-based throttle (`shouldNotifyAndStamp`) — persists the last-fire timestamp
 *    inside SessionMeta so it survives across handler invocations within the same
 *    pipeline session. Used for user-facing notifications (e.g. unbound-doc hint).
 * 2. In-memory throttle (`shouldEmitWithinWindow`) — process-local, keyed by an
 *    arbitrary string. Used for high-frequency audit events that should not flood
 *    the log (e.g. frozen-tool rejection). Dies with the process.
 *
 * Both are fail-open: any exception returns a safe default and never blocks the
 * caller's main flow.
 */

import type { SessionMeta } from "../types";
import { safeWriteAuditLog } from "./auditLog";

// ─── Meta-based throttle (Phase 1 / 170) ─────────────────────────────────────

/**
 * Determine whether a notification should fire now, and if so, stamp
 * `meta[fieldKey]` with the current timestamp.
 *
 * Returns true when:
 * - The field is absent, OR
 * - The elapsed time since the stored timestamp exceeds `windowMs`.
 *
 * Returns false (suppressed) when called again within the window.
 * Fail-open: any type mismatch or unexpected value returns true (permit emit).
 *
 * @param meta     - Current session metadata (mutated via updateMeta when firing)
 * @param fieldKey - SessionMeta field storing the last-fire timestamp (e.g. "lastUnboundNotifiedAt")
 * @param windowMs - Minimum interval in milliseconds between two emissions
 */
export function shouldNotifyAndStamp(
  meta: SessionMeta,
  fieldKey: "lastUnboundNotifiedAt",
  windowMs: number,
): boolean {
  try {
    const lastFired = meta[fieldKey];
    if (typeof lastFired !== "number") {
      return true; // Never fired before
    }
    return (Date.now() - lastFired) >= windowMs;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeWriteAuditLog("throttle_error", { fieldKey, error: errMsg }, "warn");
    return true; // Fail-open: permit emit on unexpected error
  }
}

// ─── In-memory throttle (Phase 3 / 170) ──────────────────────────────────────

/**
 * Process-local throttle map for audit event deduplication.
 * Maps a composite key to the timestamp (ms) of the last emission.
 * Exposed as module-level so the throttle state persists across calls
 * within the same process lifecycle.
 *
 * Test isolation: call `__resetMemoryThrottle()` between tests.
 */
const memoryThrottleMap = new Map<string, number>();

/**
 * Test-only reset hook — clears all in-memory throttle entries.
 */
export function __resetMemoryThrottle(): void {
  memoryThrottleMap.clear();
}

/**
 * Check whether an event identified by `key` should be emitted within the
 * given `windowMs`. If the key has not been seen recently (or the window
 * has elapsed), records the current timestamp and returns true.
 * Otherwise returns false (suppressed).
 *
 * Fail-open: never throws.
 *
 * @param key      - Unique identifier for the event (e.g. `${pipelineId}:${tool}:${flowState}`)
 * @param windowMs - Minimum interval in milliseconds between two emissions
 */
export function shouldEmitWithinWindow(key: string, windowMs: number): boolean {
  try {
    const lastFired = memoryThrottleMap.get(key);
    if (lastFired === undefined || (Date.now() - lastFired) >= windowMs) {
      memoryThrottleMap.set(key, Date.now());
      return true;
    }
    return false;
  } catch {
    return true; // Fail-open
  }
}
