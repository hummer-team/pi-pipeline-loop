/**
 * @module stage-migration
 * 229 Phase 5 (B12/问题 3): the SHARED forward stage-migration patch — built
 * once and used by BOTH the legacy `skip` decision and the 229 `advance`
 * exit, so a new stage visit is migration-clean in the exact same way.
 *
 * Facts the patch guarantees (measured off the `skip` migration):
 * - `previousStage` = the stage being left; `stageStartTime` = NOW;
 * - loop/step counters and the stage-migration counter resets reset;
 * - verification debt (`verifyFailures`), config-error flag, violations,
 *   hard-stop marker, retry counter and the confirm-gate deferral stamp
 *   clear;
 * - the left stage's summary is marked `skipped` (保留历史 summaries).
 */

import type { PipelineStage, SessionMeta } from "../types";
import { stageMigrationResetCounters } from "./stage-exit/migration-reset";

/** One forward-migration request (same inputs both callers have). */
export interface ForwardStageMigrationInput {
  meta: SessionMeta;
  prevStage: PipelineStage;
  /** The stage being entered (used for the running clock/summary shape). */
  toStage: PipelineStage | "completed" | "awaiting_human";
}

/**
 * Build the migration-clean forward patch. The caller EXTENDS this patch
 * (visit counters, domain payloads) and commits it ONCE — the helper writes
 * NOTHING itself.
 */
export function buildForwardStagePatch(input: ForwardStageMigrationInput): Partial<SessionMeta> {
  const { meta, prevStage } = input;
  const summariesPatch = meta.summaries[prevStage]
    ? {
        summaries: {
          ...meta.summaries,
          [prevStage]: { ...meta.summaries[prevStage], status: "skipped" as const },
        },
      }
    : {};
  return {
    previousStage: prevStage,
    currentStage: input.toStage,
    stageStartTime: Date.now(),
    flowState: "running",
    blockedReason: undefined,
    loopCount: 0,
    currentStepIndex: 0,
    ...stageMigrationResetCounters(),
    verifyFailures: [],
    verifyConfigError: undefined,
    violations: [],
    precheckBlocked: undefined,
    transientRetryCount: undefined,
    confirmGateDeferredAt: undefined,
    ...summariesPatch,
  };
}
