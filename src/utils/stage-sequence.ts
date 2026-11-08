/**
 * @module stage-sequence
 * Shared utility for computing the forward stage sequence from a given stage
 * by following `config.stages[s].nextStage` links until null (completed) or
 * a visited-set cycle guard triggers.
 *
 * Used by:
 * - `pipeline-state` tool (sequence snapshot)
 * - `writeStageAudit` helper (audit log sequence field)
 */

import type { PipelineConfig, PipelineStage } from "../types";
import { MAX_STAGE_CHAIN_LENGTH } from "../constants";

/**
 * Builds an ordered array of stage names starting from `fromStage` and
 * following `config.stages[s].nextStage` links until the chain terminates
 * (nextStage === null) or a cycle is detected via visited-set.
 *
 * A hard cap of MAX_STAGE_CHAIN_LENGTH (16) iterations prevents runaway loops
 * from misconfigured chains (see constants.ts).
 *
 * @param config    - The pipeline configuration containing stage definitions
 * @param fromStage - The starting stage for sequence computation
 * @returns An ordered array of stage name strings
 */
export function buildStageSequence(
  config: PipelineConfig,
  fromStage: PipelineStage,
): PipelineStage[] {
  const sequence: PipelineStage[] = [];
  let s: PipelineStage | null = fromStage;
  const visited = new Set<string>();

  for (let i = 0; i < MAX_STAGE_CHAIN_LENGTH && s && !visited.has(s); i++) {
    sequence.push(s);
    visited.add(s);
    const stageConf: import("../types").StageConfig | undefined = config.stages[s];
    if (!stageConf) break;
    const next: PipelineStage | null = stageConf.nextStage;
    if (next === null) break;
    s = next;
  }

  return sequence;
}

/** 227 Phase 3 (D-4/D-5/D-17): result of the forward-target whitelist. */
export type LegalNextStage =
  | { ok: true; target: PipelineStage | null }
  | {
      ok: false;
      reason: "unknown_stage" | "not_successor" | "same_stage" | "terminal_reserved" | "awaiting_human_in_auto";
      legal: PipelineStage[];
    };

/**
 * D-4/D-17: the ONLY legal forward target is the configured `nextStage`.
 *
 * - `completed` is plugin-exclusive (written after the completion gate);
 * - `awaiting_human` survives on the human track only;
 * - `nextStage === currentStage` is rejected with a `reenter` hint (D-5) — the
 *   old same-stage "re-entry" never actually worked (the same-stage check fired
 *   before any reset).
 */
export function resolveLegalNextStage(input: {
  config: PipelineConfig;
  currentStage: PipelineStage;
  requested?: string;
  isAutoJob: boolean;
}): LegalNextStage {
  const { config, currentStage, isAutoJob } = input;
  const legal = buildStageSequence(config, currentStage);
  const configured = config.stages[currentStage]?.nextStage ?? null;
  const requested = input.requested?.trim();

  if (!requested) return { ok: true, target: configured };
  if (!(requested in config.stages)) return { ok: false, reason: "unknown_stage", legal };
  const target = requested as PipelineStage;
  if (target === currentStage) return { ok: false, reason: "same_stage", legal };
  if (target === "completed") return { ok: false, reason: "terminal_reserved", legal };
  if (target === "awaiting_human") {
    return isAutoJob
      ? { ok: false, reason: "awaiting_human_in_auto", legal }
      : { ok: true, target };
  }
  if (target !== configured) return { ok: false, reason: "not_successor", legal };
  return { ok: true, target };
}
