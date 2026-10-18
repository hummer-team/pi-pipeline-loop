/**
 * @module pi-event-bus
 * 203_Bug Phase 0: Shared accessor for the pi SDK event bus.
 *
 * Single source for the structural `EventBus` interface and the
 * `hasEventBus`/`getEventBus` type guards, so that all modules that
 * broadcast or subscribe on `pi.events` share one definition
 * (previously duplicated as private helpers in `subagent-rpc`).
 *
 * Fail-safe: never throws; returns `null` when the bus is unavailable.
 */

/**
 * Minimal EventBus interface expected from pi.events.
 * Uses structural typing to avoid importing the SDK type.
 */
export interface EventBus {
  emit(event: string, payload: Record<string, unknown>): void;
  on(event: string, handler: (payload: unknown) => void): void;
  off?(event: string, handler: (payload: unknown) => void): void;
}

/** Structural shape of a pi ExtensionAPI that exposes an events bus. */
interface PiWithEvents {
  events: EventBus;
}

/**
 * Type guard to check if a pi-like object has an events property
 * with `emit`/`on` methods.
 */
export function hasEventBus(pi: unknown): pi is PiWithEvents {
  // `typeof null === "object"` — the explicit null check is required so that
  // `{ events: null }` cannot pass the guard and blow up on `.emit` later.
  const events = (pi as Partial<PiWithEvents> | null | undefined)?.events;
  return events !== null
    && typeof events === "object"
    && typeof events.emit === "function"
    && typeof events.on === "function";
}

/**
 * Returns the pi event bus, or null when unavailable (fail-safe).
 *
 * @param pi - Raw pi ExtensionAPI (structural)
 */
export function getEventBus(pi: unknown): EventBus | null {
  return hasEventBus(pi) ? pi.events : null;
}
