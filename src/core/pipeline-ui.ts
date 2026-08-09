/**
 * @module pipeline-ui
 * Unified TUI output for pipeline stage transitions.
 * All notify/setStatus calls are gated by config.output.pipelineStage.
 * When the switch is off, all methods are no-ops (silent).
 */

import type { PipelineConfig } from "../types";

/** Status bar key for pipeline stage display */
export const STAGE_STATUS_KEY = "pipeline-stage";

/**
 * Pipeline UI interface — provides stage transition output methods.
 * All methods are no-ops when output.pipelineStage is false.
 */
export interface PipelineUI {
  /** Gated one-time notification (notify) */
  notify(ctx: any, message: string): void;
  /** Set persistent status bar text (setStatus) */
  setStage(ctx: any, label: string): void;
  /** Clear persistent status bar (setStatus with empty string) */
  clearStage(ctx: any): void;
  /** Stage entry: "Pipeline → {stage}" */
  stageEntry(ctx: any, stage: string): void;
  /** Stage transition: "{from} → {to}" */
  transition(ctx: any, from: string, to: string): void;
  /** Stage failure: "{stage} ⚠ {reason}" */
  fail(ctx: any, stage: string, reason: string): void;
}

/**
 * Creates a PipelineUI instance gated by config.output.pipelineStage.
 * When enabled, outputs via ctx.ui.notify() and ctx.ui.setStatus().
 * When disabled (default), all methods are silent no-ops.
 *
 * @param config - Pipeline configuration
 * @returns PipelineUI instance
 */
export function createPipelineUI(config: PipelineConfig): PipelineUI {
  const enabled = config.output?.pipelineStage === true;

  return {
    notify(ctx: any, message: string): void {
      if (!enabled) return;
      ctx?.ui?.notify?.(message);
    },

    setStage(ctx: any, label: string): void {
      if (!enabled) return;
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, label);
    },

    clearStage(ctx: any): void {
      if (!enabled) return;
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, "");
    },

    stageEntry(ctx: any, stage: string): void {
      if (!enabled) return;
      const msg = `Pipeline → ${stage}`;
      ctx?.ui?.notify?.(msg);
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, msg);
    },

    transition(ctx: any, from: string, to: string): void {
      if (!enabled) return;
      const msg = `${from} → ${to}`;
      ctx?.ui?.notify?.(msg);
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, msg);
    },

    fail(ctx: any, stage: string, reason: string): void {
      if (!enabled) return;
      const msg = `${stage} ⚠ ${reason}`;
      ctx?.ui?.notify?.(msg);
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, msg);
    },
  };
}
