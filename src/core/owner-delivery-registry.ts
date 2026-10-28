/**
 * @module owner-delivery-registry
 * 217 Phase 0 (T0.1, F1): in-process registry of per-session wake-delivery
 * channels.
 *
 * Problem (217 incident `pipe-1792915432897-hxekq4`): `terminalWake` was
 * stamped BEFORE delivery and `sendFollowUp` went to whoever ran the most
 * recent hook — the review CHILD — so the owner was never woken
 * (`owner_wake_skipped reason=dedup` × 10) and the fix executor never started.
 *
 * Fix: every session registers its OWN handle (`sessionFile → handle`).
 * Delivery targets are resolved from runtime evidence:
 * 1. `meta.stageExecutorRun?.binding.ownerSessionFile` (194 C3 run binding) —
 *    the runtime-proven owner;
 * 2. fallback: the most recently registered NON-child session.
 * A child handle is never guessed as the target.
 *
 * Same-process assumption (R3-Q4=A): the registry is process-local, keyed by
 * `sessionFile`. `session_shutdown` unregisters explicitly (T0.5) so a dead
 * session cannot stay the last non-child fallback.
 */

import type { SessionMeta } from "../types";

/** One session's own wake-delivery channel (never shared across sessions). */
export interface OwnerDeliveryHandle {
  /** Absolute/relative session file of the REGISTERING session. */
  sessionFile: string;
  /** Child sessions never become fallback targets. */
  isChild: boolean;
  /** Live meta reader for the registering session. */
  getMeta: () => SessionMeta | undefined;
  /** RAW sender bound to THIS session's pi handle (must not re-enter resolution). */
  sendFollowUp: (summary: string) => boolean;
  /** Visible-notification channel for THIS session (fail-open caller side). */
  notify: (message: string) => void;
  /** Audit writer for THIS session. */
  audit: (event: string, payload: Record<string, unknown>) => void;
}

export type OwnerDeliveryVia = "run_binding" | "non_child_fallback" | "none";

/** Result of resolving a delivery target from runtime evidence. */
export interface OwnerDeliveryResolution {
  /** Resolved handle, when a registered session can receive the wake. */
  handle?: OwnerDeliveryHandle;
  /** Session file the wake was aimed at (registry hit or binding target). */
  targetSessionFile?: string;
  via: OwnerDeliveryVia;
  /** Why no handle was found (only when `via === "none"`). */
  reason?: string;
}

/** Module-level registry: `sessionFile → handle`, insertion order = recency. */
const handles = new Map<string, OwnerDeliveryHandle>();

/**
 * Register/replace THIS session's handle; re-registration refreshes recency
 * (delete-then-set keeps the most recent session last in the map).
 */
export function registerOwnerDelivery(handle: OwnerDeliveryHandle): void {
  if (!handle.sessionFile) return;
  handles.delete(handle.sessionFile);
  handles.set(handle.sessionFile, handle);
}

/** Remove a closed session (called from session_shutdown BEFORE any early return). */
export function unregisterOwnerDelivery(sessionFile: string): void {
  if (!sessionFile) return;
  handles.delete(sessionFile);
}

/**
 * Resolve the delivery target: runtime-proven run owner first (194 C3 binding),
 * then the most recently registered non-child session. Never guesses a child.
 */
export function resolveOwnerDelivery(meta: SessionMeta | undefined): OwnerDeliveryResolution {
  const target = meta?.stageExecutorRun?.binding.ownerSessionFile;
  if (target) {
    const handle = handles.get(target);
    if (handle) return { handle, targetSessionFile: target, via: "run_binding" };
  }
  for (const [sessionFile, handle] of handles) {
    if (!handle.isChild) return { handle, targetSessionFile: sessionFile, via: "non_child_fallback" };
  }
  return {
    via: "none",
    reason: target ? "owner_target_not_registered" : "no_owner_target",
    ...(target ? { targetSessionFile: target } : {}),
  };
}

/** Test-only: clear the registry (no production caller). */
export function __resetOwnerDeliveryRegistry(): void {
  handles.clear();
}
