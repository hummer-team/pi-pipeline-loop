/**
 * @module auto-pipeline/clarify-startup
 * 223 Phase 1: aggregate the "do not dispatch" startup outcomes so
 * `pipeline-start.ts` consumes Plan gates through the SAME functions the
 * settle side uses — never a second copy of the gate logic.
 *
 * With the unified decision layer, a re-started pipeline derives
 * `budget-exhausted` / `stalled` / `requirement-unclear` like any settle
 * round; the only difference is that the startup caller already knows its
 * target `docIndex` (the document being started), which it must hand down so
 * the accounting does not land on the previous document.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import {
  freezeClarify,
  type ClarifyDocState,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "./clarify-state";
import { handleClarifyBudgetExhausted } from "./clarify-autopilot";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobState } from "./job-state";

/**
 * Route a BLOCKED startup decision to its gate handler.
 *
 * - `budget-exhausted` → `handleClarifyBudgetExhausted` (freeze or one forced
 *   `full-und?` fallback, per `clarify.onExhausted`), with the explicit
 *   `docIndex` so accounting is attributed to the doc being started;
 * - `stalled` / `requirement-unclear` → `freezeClarify` with the SAME gate
 *   names the settle side uses.
 *
 * @returns TRUE when the caller must stop its normal startup handling.
 */
export async function runBlockedClarifyStartup(
  ctx: ClarifyEntryCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  state: AutoJobState,
  job: AutoJobConfig,
  docState: ClarifyDocState,
  docIndex: number,
  deps: ClarifyEntryDeps,
): Promise<boolean> {
  switch (docState.decision.action) {
    case "budget-exhausted":
      return handleClarifyBudgetExhausted(
        ctx, config, meta, state, job, docState, deps, docIndex,
      );
    case "stalled":
      return freezeClarify(ctx, config, meta, "clarify_stalled", docState.decision, deps);
    case "requirement-unclear":
      return freezeClarify(ctx, config, meta, "clarify_requirement_unclear", docState.decision, deps);
    default:
      // Only gate actions reach this module (checked at the call site).
      return false;
  }
}
