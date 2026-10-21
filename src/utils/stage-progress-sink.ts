/**
 * @module stage-progress-sink
 * 210 Phase 2 — dependency-inversion sink for stage progress events.
 *
 * Requirement 5.4 whitelists the event sources that may renew the stage idle
 * clock. Two of them (`spawn`, and the child-side half of `settle`) are
 * detected inside `utils/` modules, which MUST NOT import `core/` at runtime
 * (enforced by the static guard in `src/__tests__/utils/subagent-rpc.test.ts`:
 * "no runtime imports from ../core/", Phase 0 / 189). This leaf module is the
 * inversion point: `utils/` reports through it, `core/stage-watchdog` is wired
 * in as the consumer from the composition root (`createPipeline`).
 *
 * Contract:
 * - `setStageProgressReporter` is idempotent (the same function pointer) and is
 *   never called more than once per process by the plugin itself.
 * - `reportStageProgress` is a NO-OP while no reporter is registered, so a
 *   standalone `utils/` consumer (or a unit test that only loads `subagent-rpc`)
 *   behaves exactly like the baseline.
 * - The sink never throws: renewal is an advisory channel, so a consumer that
 *   throws is contained here and only logged (never propagated to the caller).
 */

import type { StageProgressSource } from "../types";

/**
 * Reporter signature — identical to `core/stage-watchdog.touchStageProgress`,
 * kept structurally here so `utils/` stays free of any `core/` type import.
 */
export type StageProgressReporter = (
  pipelineId: string | undefined,
  source: StageProgressSource,
) => void;

/** Registered consumer; `null` means "watchdog not wired" (baseline behaviour). */
let reporter: StageProgressReporter | null = null;

/**
 * Registers (or clears, with `null`) the stage progress consumer.
 *
 * @param next - Consumer to receive every whitelisted progress event
 */
export function setStageProgressReporter(next: StageProgressReporter | null): void {
  reporter = next;
}

/**
 * Reports one whitelisted stage progress event.
 *
 * @param pipelineId - Pipeline the event belongs to; `undefined` is ignored
 *   (a caller without meta must not touch another pipeline's clock)
 * @param source - Whitelisted source of the event (requirement 5.4)
 */
export function reportStageProgress(
  pipelineId: string | undefined,
  source: StageProgressSource,
): void {
  if (!reporter || !pipelineId) return;
  try {
    reporter(pipelineId, source);
  } catch (err) {
    // Advisory channel: a renewal failure must never break the caller's flow.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[pi-pipeline] stage progress reporter failed (${source}): ${errMsg}`);
  }
}

/**
 * Test-only helper: whether a consumer is registered.
 * @internal
 */
export function __hasStageProgressReporter(): boolean {
  return reporter !== null;
}
