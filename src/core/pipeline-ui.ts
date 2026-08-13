/**
 * @module pipeline-ui
 * Unified TUI output for pipeline stage transitions.
 * All notify/setStatus calls are gated by config.output.pipelineStage.
 * When the switch is off, all methods are no-ops (silent).
 */

import type { PipelineConfig } from "../types";

/** Status bar key for pipeline stage display */
export const STAGE_STATUS_KEY = "pipeline-stage";

/** Braille spinner frames for progress animation */
export const PROGRESS_FRAMES: readonly string[] = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
];

/** Default interval between progress animation frames (ms) */
export const DEFAULT_PROGRESS_FRAME_MS = 120;

/**
 * Pipeline UI interface — provides stage transition output methods.
 * All methods are no-ops when output.pipelineStage is false.
 */
export interface PipelineUI {
  /** Gated one-time notification (notify) */
  notify(ctx: any, message: string): void;
  /** Set persistent status bar text (setStatus) */
  setStage(ctx: any, label: string): void;
  /** Clear persistent status bar (setStatus with undefined) */
  clearStage(ctx: any): void;
  /** Stage entry: "Pipeline → {stage}" */
  stageEntry(ctx: any, stage: string): void;
  /** Stage transition: "{from} → {to}" */
  transition(ctx: any, from: string, to: string): void;
  /** Stage failure: "{stage} ⚠ {reason}" */
  fail(ctx: any, stage: string, reason: string): void;
  /**
   * Start a progress animation with frame cycling.
   * Clears any existing timer before starting a new one.
   * Immediately writes the first frame to the status bar.
   */
  progressStart(ctx: any, label: string, message?: string, intervalMs?: number): void;
  /**
   * Update the progress message suffix and immediately re-render.
   * No-op if no animation is running.
   */
  progressUpdate(ctx: any, message?: string): void;
  /**
   * Stop the progress animation and write the base text (no frame, no message).
   */
  progressEnd(ctx: any): void;
}

/**
 * Builds the progress status text: "Pipeline → {label} {frame} {message}"
 */
function buildProgressText(label: string, frame: string, message?: string): string {
  const parts = [`Pipeline → ${label}`, frame];
  if (message) parts.push(message);
  return parts.join(" ");
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

  // Progress animation closure state
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let progressLabel = "";
  let progressMsg: string | undefined;
  let progressFrameIndex = 0;

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
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, undefined);
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

    progressStart(ctx: any, label: string, message?: string, intervalMs?: number): void {
      if (!enabled) return;

      // Clear any existing timer to prevent double timers
      if (progressTimer !== null) {
        clearInterval(progressTimer);
        progressTimer = null;
      }

      // Record state
      progressLabel = label;
      progressMsg = message;
      progressFrameIndex = 0;

      // Write first frame immediately
      const firstFrame = PROGRESS_FRAMES[0];
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, buildProgressText(label, firstFrame, message));

      // Start frame cycling
      const interval = intervalMs ?? DEFAULT_PROGRESS_FRAME_MS;
      progressTimer = setInterval(() => {
        progressFrameIndex = (progressFrameIndex + 1) % PROGRESS_FRAMES.length;
        const frame = PROGRESS_FRAMES[progressFrameIndex];
        ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, buildProgressText(progressLabel, frame, progressMsg));
      }, interval);
    },

    progressUpdate(ctx: any, message?: string): void {
      if (!enabled) return;
      // No-op if no animation is running
      if (progressTimer === null) return;

      progressMsg = message;
      // Immediately re-render current frame with updated message
      const frame = PROGRESS_FRAMES[progressFrameIndex];
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, buildProgressText(progressLabel, frame, message));
    },

    progressEnd(ctx: any): void {
      if (!enabled) return;

      // Stop timer
      if (progressTimer !== null) {
        clearInterval(progressTimer);
        progressTimer = null;
      }

      // Write base text (no frame, no message)
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, `Pipeline → ${progressLabel}`);

      // Reset state
      progressLabel = "";
      progressMsg = undefined;
      progressFrameIndex = 0;
    },
  };
}
