/**
 * @module fix-executor-completion
 * Handles auto-unfreeze of the fix stage when the executor subagent completes
 * after a max_loop_cycles block.
 *
 * Phase 0 (189): Extracted from `utils/subagent-rpc.ts` to break the runtime
 * circular dependency:
 *   subagent-rpc → verify-advance → subagent-rpc
 *
 * The function is registered as a DI handler in `utils/subagent-rpc.ts` via
 * `setFixExecutorCompletedHandler` and wired by the composition root (`index.ts`).
 * This restores the `core → utils` one-way dependency invariant.
 */

import { getFlowState } from "./flow-state";
import { createPipelineUI } from "./pipeline-ui";
import { autoAdvanceAfterVerify } from "./verify-advance";
import { safeWriteAuditLog } from "../utils/auditLog";
import type { PipelineConfig, SessionMeta } from "../types";

/**
 * Context object passed to the fix-executor-completion handler.
 *
 * Consolidates the previously separate `opts` and `ui` parameters into a
 * single typed shape. The handler is invoked from the RPC lifecycle callback
 * in `subagent-rpc.ts` when a fix-stage subagent completes.
 */
export interface FixExecutorCompletedCtx {
  /** Optional UI notification handle */
  ui?: { notify: (msg: string) => void };
  /** Session handle for meta read/write */
  session?: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  /** Raw runtime context for child-session detection and audit correlation */
  runtimeCtx?: unknown;
}

/**
 * Handler type for fix-executor completion events.
 * Registered by the composition root (`index.ts`) via `setFixExecutorCompletedHandler`.
 */
export type FixExecutorCompletedHandler =
  (pi: unknown, config: PipelineConfig, ctx: FixExecutorCompletedCtx) => Promise<void>;

/**
 * 189 Bug 4 (Phase 3): Auto-unfreeze fix stage when executor completes after max_loop_cycles block.
 *
 * Preconditions (all must pass):
 * - currentStage === "fix"
 * - flowState === "blocked"
 * - blockedReason === "max_loop_cycles" (exact string match)
 *
 * Action: unfreeze, audit, advance fix→review via autoAdvanceAfterVerify.
 * Fail-open: any error is caught and audited, frozen state preserved.
 *
 * @param pi - pi SDK handle (forwarded to autoAdvanceAfterVerify for wake messages)
 * @param config - Pipeline configuration
 * @param ctx - Consolidated context with ui, session, and runtimeCtx
 */
export async function handleFixExecutorCompleted(
  pi: unknown,
  config: PipelineConfig,
  ctx: FixExecutorCompletedCtx,
): Promise<void> {
  try {
    // Read fresh meta to check preconditions
    const freshMeta = ctx.session?.getMeta();
    if (!freshMeta) return;

    // Preconditions: stage=fix, blocked, max_loop_cycles
    if (freshMeta.currentStage !== "fix") return;
    if (getFlowState(freshMeta) !== "blocked") return;
    if (freshMeta.blockedReason !== "max_loop_cycles") return;

    // Unfreeze the pipeline
    ctx.session?.updateMeta({
      flowState: "running",
      blockedReason: undefined,
      loopCount: 0,
    });

    // Audit the unfreeze
    await safeWriteAuditLog("fix_completed_auto_unfreeze", {
      pipelineId: freshMeta.pipelineId,
      stage: "fix",
      reason: "max_loop_cycles",
    });

    // Build PipelineUI from config
    const pipelineUI = createPipelineUI(config);

    // Empty shared result (subagent finished, no verify needed — trusted signal)
    const emptySharedResult = {
      structuredResult: undefined,
      ruleMissing: [],
      verifyResult: null,
    };

    // Build the verify advance context.
    // The autoAdvanceAfterVerify ctx requires session, ui, pi, and for
    // isChildRuntimeCtx detection the original runtimeCtx as _ctx/runtimeCtx.
    // This preserves the 189 Issue 8 runtimeCtx transparent forwarding.
    //
    // Type derivation uses `Parameters<typeof autoAdvanceAfterVerify>[n]` to
    // extract the exact parameter shapes from the callee signature without
    // requiring verify-advance to export its internal interfaces. This
    // preserves compile-time guard against parameter-shape drift (189 Phase 0).
    type AutoAdvanceCtxParam = Parameters<typeof autoAdvanceAfterVerify>[1];
    type AutoAdvanceResultParam = Parameters<typeof autoAdvanceAfterVerify>[5];

    const notify = ctx.ui?.notify ?? (() => {});
    const verifyCtx = {
      session: ctx.session!,
      ui: { notify },
      // Cast pi to the expected structural shape (extracted from the callee signature)
      pi: pi as AutoAdvanceCtxParam["pi"],
      // 189 Issue 8: Include runtimeCtx for isChildRuntimeCtx detection
      ...(ctx.runtimeCtx ? { _ctx: ctx.runtimeCtx, runtimeCtx: ctx.runtimeCtx } : {}),
    };

    // Advance fix→review with skipPassAudit=true
    // 216 P1 (F3): consume the outcome — a refused/blocked commit must NOT be
    // reported as "fix completed & advanced"; the unfreeze stays, the advance
    // honestly reports `fix_advance_refused` (warn) for the audit trail.
    const outcome = await autoAdvanceAfterVerify(
      config,
      verifyCtx as AutoAdvanceCtxParam,
      freshMeta,
      "fix",
      "review",
      emptySharedResult as AutoAdvanceResultParam,
      pipelineUI,
      { skipPassAudit: true, caller: "fix_executor" },
    );
    if (!outcome.advanced) {
      await safeWriteAuditLog("fix_advance_refused", {
        pipelineId: freshMeta.pipelineId,
        fromStage: "fix",
        toStage: "review",
        reason: outcome.blockReason ?? "advance_blocked",
      }, "warn");
    }
  } catch (err) {
    // Fail-open: audit error, preserve frozen state
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("fix_unfreeze_error", {
      pipelineId: ctx.session?.getMeta()?.pipelineId ?? "unknown",
      stage: "fix",
      error: errMsg,
    }, "warn");
  }
}
