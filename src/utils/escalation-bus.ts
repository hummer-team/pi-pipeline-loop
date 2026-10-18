/**
 * @module escalation-bus
 * 203_Bug Phase 0 (RC1): Child-side freeze escalation broadcast/subscribe.
 *
 * When a child session freezes (threshold hit: maxLoops / maxVerifyAttempts /
 * max_loop_cycles), the child previously only set `menuEscalationPending`
 * and returned — the owner had no wake-up channel, leaving the pipeline
 * frozen silently for hours.
 *
 * This module provides a fail-safe event-bus channel:
 * - child (freeze side): `broadcastEscalation` publishes on the shared bus
 * - owner (wake side):   `registerEscalationObserver` subscribes a handler
 *
 * `broadcastEscalation` and listener errors are absorbed (never throw) so
 * escalation failures can never alter freeze semantics (RC1 hardening).
 */

import { getEventBus } from "./pi-event-bus";
import type { PipelineStage } from "../types";

/** Event name broadcast when a child freeze arms a menu escalation. */
export const PIPELINE_ESCALATION_EVENT = "pipeline:escalation-armed";

/** Payload published on {@link PIPELINE_ESCALATION_EVENT}. */
export interface EscalationPayload {
  pipelineId: string;
  stage: PipelineStage;
  reason: string;
  at: number;
}

/**
 * Broadcast a child-side freeze escalation.
 * Fail-safe: never throws — a broadcast failure must not affect freeze semantics.
 *
 * @param pi - Raw pi ExtensionAPI (structural)
 * @param payload - Escalation payload (pipeline/stage/reason/timestamp)
 */
export function broadcastEscalation(pi: unknown, payload: EscalationPayload): void {
  try {
    const bus = getEventBus(pi);
    if (!bus) return;
    bus.emit(PIPELINE_ESCALATION_EVENT, payload as unknown as Record<string, unknown>);
  } catch {
    // Fail-safe: broadcast errors must not affect freeze semantics
  }
}

/**
 * Subscribe to escalation events.
 * Fail-safe: handler errors are absorbed; missing bus yields a no-op cleanup.
 *
 * @param pi - Raw pi ExtensionAPI (structural)
 * @param handler - Called with the escalation payload on each broadcast
 * @returns Cleanup function that removes the subscription
 */
export function registerEscalationObserver(
  pi: unknown,
  handler: (payload: EscalationPayload) => void,
): () => void {
  try {
    const bus = getEventBus(pi);
    if (!bus) return () => {};

    const wrapped = (payload: unknown) => {
      try {
        handler(payload as EscalationPayload);
      } catch {
        // Fail-safe: observer errors must not crash the bus
      }
    };

    bus.on(PIPELINE_ESCALATION_EVENT, wrapped);
    return () => {
      try {
        bus.off?.(PIPELINE_ESCALATION_EVENT, wrapped);
      } catch {
        // Fail-safe: unsubscribe errors are non-fatal
      }
    };
  } catch {
    return () => {};
  }
}
