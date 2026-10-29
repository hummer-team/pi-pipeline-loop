/**
 * @module resume-dispatch
 * 218 Phase 3 (T3.5, Q13-A / R8 / R12): the single DI seam that lets the
 * flow-state `resume` branch dispatch the stage executor from EVERY resume
 * entry — the decision menu, the policy unfreeze and `--force-resume`.
 *
 * Why a seam: `core/flow-state.ts` may not import `commands/pipeline-start`
 * (dependency inversion + circular-import risk: pipeline-start already pulls
 * in core). The composition root (`src/index.ts`) installs the real handler
 * (`dispatchAfterResume`); while it is unset (unit tests, partial wiring)
 * the call converges to an audited `"unavailable"` — never a silent drop,
 * never a throw.
 *
 * Incident 20261028 (R8/R12): picking "Resume" unfroze the pipeline but no
 * executor ever started; the resume command then re-dispatched on some
 * entries (double spawn) and missed on others (silent stall). Centralising
 * the dispatch in the resume branch — exactly once per `executeDecision
 * ("resume")` — makes both failure shapes impossible.
 */

import type { PipelineConfig, SessionMeta } from "../types";

/**
 * Minimal context shape the dispatch handler needs (mock-friendly; the
 * runtime ctx structurally satisfies it, `FlowStateCtx` included).
 */
export interface ResumeDispatchContext {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => unknown;
  };
  ui?: { notify?: (msg: string) => void };
  pi?: unknown;
  _ctx?: unknown;
  hasUI?: boolean | (() => boolean);
}

/**
 * Handler contract: spawn/queue the stage executor for `freshMeta`'s CURRENT
 * stage. Errors may propagate — the caller fail-safes them into the same
 * audited convergence as an unset handler.
 */
export type ResumeDispatchHandler = (
  ctx: ResumeDispatchContext,
  config: PipelineConfig,
  freshMeta: SessionMeta,
) => Promise<void>;

/** Outcome labels audited by the resume branch. */
export type ResumeDispatchOutcome = "dispatched" | "unavailable";

let resumeDispatchHandler: ResumeDispatchHandler | null = null;

/**
 * Composition root installs `dispatchAfterResume`; `null` restores the
 * audited no-op (used by test teardown — every installer must clear it).
 */
export function setResumeDispatchHandler(handler: ResumeDispatchHandler | null): void {
  resumeDispatchHandler = handler;
}

/** Test/diagnostics peek (mirrors `__peekFixExecutorCompletedHandler`). */
export function __peekResumeDispatchHandler(): ResumeDispatchHandler | null {
  return resumeDispatchHandler;
}

/**
 * Invoke the installed resume dispatch exactly once. Returns
 * `"unavailable"` only when no handler is wired; a throwing handler
 * propagates to the caller's fail-safe audit path.
 */
export async function invokeResumeDispatch(
  ctx: ResumeDispatchContext,
  config: PipelineConfig,
  freshMeta: SessionMeta,
): Promise<ResumeDispatchOutcome> {
  if (!resumeDispatchHandler) return "unavailable";
  await resumeDispatchHandler(ctx, config, freshMeta);
  return "dispatched";
}
