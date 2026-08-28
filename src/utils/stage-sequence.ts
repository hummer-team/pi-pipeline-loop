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
