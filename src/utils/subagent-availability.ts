/**
 * @module subagent-availability
 * Phase 2 / 177 (D4): Event-driven availability latch for the pi-subagents RPC.
 *
 * Replaces timeout-based probing (`pingSubagents` with 500ms/2000ms/5000ms
 * tuning) with a boolean latch driven by the `subagents:ready` announcement:
 * - `subagents:ready` observed → latch = true → spawn paths use RPC directly
 *   (the event bus is in-process and synchronous, so no ping round-trip).
 * - Latch = false → spawn paths skip the ping entirely and fall back
 *   immediately (zero dead wait), avoiding the "no responder" failures.
 * - `session_shutdown` → latch = false (re-armed on the next ready event).
 *
 * The latch is process-scoped: one extension runtime per process owns one
 * event bus, so a single boolean is the correct granularity.
 */

let subagentsReady = false;

/** Marks pi-subagents as available (called on `subagents:ready`). */
export function markSubagentsReady(): void {
  subagentsReady = true;
}

/** Marks pi-subagents as unavailable (called on session shutdown). */
export function markSubagentsUnavailable(): void {
  subagentsReady = false;
}

/**
 * Returns whether pi-subagents has announced readiness for this process.
 *
 * @returns true when the latch has been set by a `subagents:ready` event
 */
export function isSubagentsReady(): boolean {
  return subagentsReady;
}

/** Test-only reset for the latch. */
export function __resetSubagentsReady(): void {
  subagentsReady = false;
}

/** Minimal event-bus surface used to subscribe to the ready announcement. */
interface ReadyEventBus {
  on?: (event: string, handler: (payload: unknown) => void) => unknown;
}

/**
 * Subscribes to the `subagents:ready` announcement and flips the latch.
 *
 * Fail-safe: a missing/!function event bus is a no-op, so the latch simply
 * stays false and spawn paths degrade to the fallback channel.
 *
 * @param pi - Extension API handle (structural: needs `events.on`)
 * @returns Unsubscribe function (no-op when the bus is unavailable)
 */
export function wireSubagentsReadyListener(pi: unknown): () => void {
  const bus = (pi as { events?: ReadyEventBus } | undefined)?.events;
  if (!bus || typeof bus.on !== "function") return () => {};
  try {
    const off = bus.on("subagents:ready", () => markSubagentsReady());
    return typeof off === "function" ? (off as () => void) : () => {};
  } catch {
    return () => {};
  }
}
