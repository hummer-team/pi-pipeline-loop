/**
 * @module owner-delivery
 * 217 Phase 0 (T0.3, F2): target-resolving wake delivery + its outcome type.
 *
 * `deliverOwnerWake` sends the wake through the handle resolved from runtime
 * evidence (registry: run binding → non-child fallback) and reports exactly
 * what happened (`DeliveryOutcome`) so the caller can decide whether the dedup
 * stamp may be written — a FAILED delivery must stay retryable.
 */

import type { SessionMeta } from "../types";
import { resolveOwnerDelivery } from "./owner-delivery-registry";

export interface DeliveryOutcome {
  /** Whether the wake message was accepted by ANY channel. */
  delivered: boolean;
  /** Which channel carried (or failed to carry) the message. */
  via: "registry_run_binding" | "registry_non_child" | "deps_fallback" | "none";
  /** Session file the wake was aimed at (binding target or registry key). */
  targetSessionFile?: string;
  /** Session file of the handle that actually accepted the message. */
  actualSessionFile?: string;
  /** Why delivery failed (only when `delivered === false`). */
  reason?: string;
}

/** Deliver through the resolved owner handle; fall back to the legacy sender. */
export function deliverOwnerWake(
  summary: string,
  meta: SessionMeta | undefined,
  fallback: () => boolean,
): DeliveryOutcome {
  const resolution = resolveOwnerDelivery(meta);
  const base = resolution.targetSessionFile ? { targetSessionFile: resolution.targetSessionFile } : {};
  if (resolution.handle) {
    try {
      return resolution.handle.sendFollowUp(summary)
        ? { delivered: true, via: resolution.via === "run_binding" ? "registry_run_binding" : "registry_non_child",
            ...base, actualSessionFile: resolution.handle.sessionFile }
        : { delivered: false, via: "none", ...base, reason: "send_failed" };
    } catch (err) {
      return { delivered: false, via: "none", ...base,
               reason: `send_threw:${err instanceof Error ? err.message : String(err)}` };
    }
  }
  try {
    if (fallback()) return { delivered: true, via: "deps_fallback", ...base };
  } catch (err) {
    return { delivered: false, via: "none", ...base,
             reason: `fallback_threw:${err instanceof Error ? err.message : String(err)}` };
  }
  return { delivered: false, via: "none", ...base, reason: resolution.reason ?? "delivery_failed" };
}
