/**
 * @module terminal-compact
 * One-shot pipeline terminal context compaction via ctx.compact.
 *
 * Phase 4 (169): After the pipeline reaches "completed" stage, this helper
 * triggers ctx.compact exactly once to shrink the main session context.
 * Products are already on disk, so lossy compression risk is minimal.
 *
 * Guard chain (sequential short-circuit):
 * 1. config.compact?.enabled !== false
 * 2. Fresh getMeta()?.currentStage === "completed"
 * 3. !meta.terminalCompact (not yet consumed)
 * 4. _ctx.isIdle?.() !== false (busy → silent return, no consume)
 * 5. _ctx.compact missing → audit skip, no consume
 * 6. usage = getContextUsage(), tokens null → audit skip, no consume
 * 7. tokens < threshold → consume + audit below_threshold
 * 8. Execute compact via Promise wrapper
 *
 * This module never throws — all errors are caught and converted to audit + notify.
 * It does NOT import flow-state or stage-advancer (no circular dependencies).
 */

import type { PipelineConfig, SessionMeta } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";
import { DEFAULT_COMPACT_ENABLED, DEFAULT_COMPACT_TOKEN_THRESHOLD, DEFAULT_COMPACT_INSTRUCTIONS } from "../constants";

/**
 * Minimal context interface for terminal compaction.
 * Compatible with RuntimeCtx at the structural level.
 */
export interface TerminalCompactCtx {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: {
    notify?: (msg: string) => void;
  };
  _ctx: {
    isIdle?: () => boolean;
    compact?: (opts: {
      customInstructions: string;
      onComplete: (result: CompactResult) => void;
      onError: (error: Error) => void;
    }) => void;
    getContextUsage?: () => { tokens: number | null } | undefined;
  };
}

/**
 * Result shape returned by ctx.compact onComplete callback.
 */
interface CompactResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number | null;
}

/**
 * Attempts one-shot terminal context compaction after pipeline completion.
 *
 * This function is safe to call from any wiring point (W1/W2/W3) — the internal
 * guard chain ensures it executes at most once per pipeline lifecycle.
 *
 * @param ctx - Terminal compact context (session + ui + _ctx)
 * @param config - Pipeline configuration
 * @returns Promise that always resolves (never throws)
 */
export async function maybeCompactOnPipelineCompleted(
  ctx: TerminalCompactCtx,
  config: PipelineConfig,
): Promise<void> {
  try {
    await executeCompactGuardChain(ctx, config);
  } catch (err) {
    // Top-level catch: compact optimization must NEVER throw to callers
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("pipeline_compact_unexpected_error", {
      error: errMsg,
    }, "warn");
  }
}

/**
 * Internal guard chain implementation.
 * Split from the outer function for clarity (outer catches all, inner has the logic).
 */
async function executeCompactGuardChain(
  ctx: TerminalCompactCtx,
  config: PipelineConfig,
): Promise<void> {
  // Guard 1: enabled check
  const compactConfig = config.compact;
  if (compactConfig?.enabled === false) {
    return;
  }

  // Guard 2: fresh meta must be completed
  const meta = ctx.session.getMeta();
  if (!meta || meta.currentStage !== "completed") {
    return;
  }

  // Guard 3: not yet consumed
  if (meta.terminalCompact) {
    return;
  }

  // Guard 4: idle check (busy → silent return, no consume)
  if (ctx._ctx.isIdle?.() === false) {
    return;
  }

  // Guard 5: compact availability
  if (!ctx._ctx.compact) {
    await safeWriteAuditLog("pipeline_compact_skipped", {
      pipelineId: meta.pipelineId,
      reason: "compact_unavailable",
    });
    return;
  }

  // Guard 6: usage/tokens check
  const usage = ctx._ctx.getContextUsage?.();
  const tokens = usage?.tokens;

  if (tokens === null || tokens === undefined) {
    await safeWriteAuditLog("pipeline_compact_skipped", {
      pipelineId: meta.pipelineId,
      reason: "usage_unknown",
    });
    return;
  }

  // Guard 7: threshold check (consumes on skip)
  const threshold = compactConfig?.tokenThreshold ?? DEFAULT_COMPACT_TOKEN_THRESHOLD;
  if (tokens < threshold) {
    ctx.session.updateMeta({
      terminalCompact: {
        outcome: "skipped_below_threshold",
        at: Date.now(),
        tokensBefore: tokens,
      },
    });
    await safeWriteAuditLog("pipeline_compact_skipped", {
      pipelineId: meta.pipelineId,
      reason: "below_threshold",
      tokensBefore: String(tokens),
      threshold: String(threshold),
    });
    return;
  }

  // Guard 8: Execute compaction
  const enabled = compactConfig?.enabled ?? DEFAULT_COMPACT_ENABLED;
  if (!enabled) {
    return;
  }

  const customInstructions = compactConfig?.customInstructions ?? DEFAULT_COMPACT_INSTRUCTIONS;
  const pipelineId = meta.pipelineId;

  try {
    const result = await new Promise<CompactResult>((resolve) => {
      ctx._ctx.compact!({
        customInstructions,
        onComplete: (res: CompactResult) => resolve(res),
        onError: (err: Error) => resolve({
          tokensBefore: tokens,
          estimatedTokensAfter: null,
          // Signal failure via a special marker
          ...{ _error: err.message } as Record<string, unknown>,
        } as CompactResult & { _error: string }),
      });
    });

    // Check if the result contains an error marker
    const errorFromCallback = (result as CompactResult & { _error?: string })._error;

    if (errorFromCallback) {
      // Failure branch: consume + audit + notify
      ctx.session.updateMeta({
        terminalCompact: {
          outcome: "failed",
          at: Date.now(),
          tokensBefore: tokens,
          error: errorFromCallback,
        },
      });
      await safeWriteAuditLog("pipeline_compact_failed", {
        pipelineId,
        error: errorFromCallback,
        tokensBefore: String(tokens),
      }, "warn");
      ctx.ui?.notify?.(
        `Pipeline terminal context compaction failed: ${errorFromCallback}. You can manually run /compact to shrink the session.`,
      );
      return;
    }

    // Success branch: consume + audit
    ctx.session.updateMeta({
      terminalCompact: {
        outcome: "compacted",
        at: Date.now(),
        tokensBefore: result.tokensBefore ?? tokens,
        tokensAfter: result.estimatedTokensAfter ?? null,
      },
    });
    await safeWriteAuditLog("pipeline_compacted", {
      pipelineId,
      tokensBefore: String(result.tokensBefore ?? tokens),
      tokensAfter: String(result.estimatedTokensAfter ?? "null"),
    });
  } catch (err) {
    // Synchronous throw from compact (e.g. "Already compacted", "Nothing to compact")
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.session.updateMeta({
      terminalCompact: {
        outcome: "failed",
        at: Date.now(),
        tokensBefore: tokens,
        error: errMsg,
      },
    });
    await safeWriteAuditLog("pipeline_compact_failed", {
      pipelineId,
      error: errMsg,
      tokensBefore: String(tokens),
    }, "warn");
    ctx.ui?.notify?.(
      `Pipeline terminal context compaction failed: ${errMsg}. You can manually run /compact to shrink the session.`,
    );
  }
}
