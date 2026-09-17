/**
 * @module pipeline-ui
 * Unified TUI output for pipeline stage transitions.
 * All notify/setStatus calls are gated by config.output.pipelineStage.
 * When the switch is off, all methods are no-ops (silent).
 */

import type { PipelineConfig } from "../types";
import { toProjectRelative } from "../utils/path-display";

/** Status bar key for pipeline stage display */
export const STAGE_STATUS_KEY = "pipeline-stage";

/**
 * When true, the next-stage arrow is rendered with ANSI gray (dim) styling.
 * Set to false for pure-text fallback when the terminal does not support ANSI.
 * Exported as `let` to allow test-time override for degradation branch coverage.
 */
export let NEXT_STAGE_GRAY = true;

/**
 * Sets the NEXT_STAGE_GRAY flag. Intended for test-time override only.
 * @internal
 */
export function _setNextStageGray(value: boolean): void {
  NEXT_STAGE_GRAY = value;
}

/** ANSI escape for dim/gray text */
const ANSI_GRAY_OPEN = "\x1b[90m";
const ANSI_GRAY_CLOSE = "\x1b[0m";

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
  /** Set persistent status bar text (setStatus) with unified format */
  setStage(ctx: any, stage: string): void;
  /** Clear persistent status bar (setStatus with undefined) */
  clearStage(ctx: any): void;
  /** Stage entry: "[ {pipelineId} • {stage} -> {nextStage} ]" or fallback */
  stageEntry(ctx: any, stage: string): void;
  /** Stage transition: "[ {pipelineId} • {to} -> {nextStage} ]" or fallback */
  transition(ctx: any, from: string, to: string): void;
  /** Stage failure: "[ {pipelineId} • {stage} ] ⚠ {reason}" or fallback */
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
 * Builds the progress status text using unified format.
 */
function buildProgressText(label: string, frame: string, message?: string): string {
  const parts = [`Pipeline → ${label}`, frame];
  if (message) parts.push(message);
  return parts.join(" ");
}

/**
 * Reads the pipelineId from ctx session meta (safe — returns undefined if missing).
 */
function readPipelineId(ctx: any): string | undefined {
  return ctx?.session?.getMeta?.()?.pipelineId;
}

/**
 * Reads nextStage for a given stage from config.
 */
function readNextStage(config: PipelineConfig, stage: string): string | null | undefined {
  const stageConfig = (config.stages as Record<string, { nextStage?: string | null }>)?.[stage];
  return stageConfig?.nextStage;
}

/**
 * Unified stage format:
 * - With meta: "[ {pipelineId} • {stage} -> {nextStage} ]" (nextStage grayed when NEXT_STAGE_GRAY)
 * - With meta but no nextStage: "[ {pipelineId} • {stage} ]"
 * - Without meta: "Pipeline → {stage}"
 */
function formatStage(config: PipelineConfig, ctx: any, stage: string): string {
  const pipelineId = readPipelineId(ctx);
  if (!pipelineId) {
    return `Pipeline → ${stage}`;
  }
  const nextStage = readNextStage(config, stage);
  if (nextStage) {
    const arrow = NEXT_STAGE_GRAY
      ? `${ANSI_GRAY_OPEN}-> ${nextStage}${ANSI_GRAY_CLOSE}`
      : `-> ${nextStage}`;
    return `[ ${pipelineId} • ${stage} ${arrow} ]`;
  }
  return `[ ${pipelineId} • ${stage} ]`;
}

/**
 * Reads the deliverable path from the previous stage's summary metadata.
 * Returns null if the path is not available.
 *
 * @param ctx - Runtime context with session state
 * @param from - Previous stage name
 * @returns Deliverable path or null
 */
function readDeliverablePath(ctx: any, from: string): string | null {
  const summaries = ctx?.session?.getMeta?.()?.summaries as
    | Record<string, { path?: string }>
    | undefined;
  return summaries?.[from]?.path ?? null;
}

/**
 * Writes the pipeline stage status so it becomes the LAST entry in the
 * third-party footer's extension-status map.
 *
 * `setStatus(key, undefined)` deletes the key; the immediate re-set re-inserts
 * it at the end of the Map. A plain repeat `setStatus(key, message)` would keep
 * the key's original insertion position. This helper is the single move-to-end
 * writer for every stage-status boundary write.
 *
 * @param ctx - Extension context exposing `ui.setStatus`
 * @param message - Formatted stage status text to display
 */
function writeStageStatusLast(ctx: any, message: string): void {
  ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, undefined);
  ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, message);
}

/**
 * Writes the persistent TUI status bar showing the current pipeline stage.
 * Safely no-ops when ctx/ui is unavailable or output.pipelineStage is off
 * (the `setStage` gate handles the disabled case).
 *
 * This is the single entry point for an owner session to restore the
 * persistent stage status bar (e.g. after `/pipeline-resume` or a reload);
 * `/pipeline-start` uses the same helper so both commands render identically.
 *
 * @param ui - PipelineUI instance
 * @param ctx - Extension context (uses session.getMeta for the dynamic stage)
 */
export function syncStageStatusBar(ui: PipelineUI, ctx?: any): void {
  const stage = ctx?.session?.getMeta?.()?.currentStage ?? "clarify";
  ui.setStage(ctx, stage);
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

    setStage(ctx: any, stage: string): void {
      if (!enabled) return;
      const msg = formatStage(config, ctx, stage);
      writeStageStatusLast(ctx, msg);
    },

    clearStage(ctx: any): void {
      if (!enabled) return;
      ctx?.ui?.setStatus?.(STAGE_STATUS_KEY, undefined);
    },

    stageEntry(ctx: any, stage: string): void {
      if (!enabled) return;
      const msg = formatStage(config, ctx, stage);
      ctx?.ui?.notify?.(msg);
      writeStageStatusLast(ctx, msg);
    },

    transition(ctx: any, from: string, to: string): void {
      if (!enabled) return;
      const baseMsg = formatStage(config, ctx, to);
      // Bug 3.1: show deliverable path from the previous stage when available
      // Phase 0 (169): display as project-relative path for readability
      const deliverablePath = readDeliverablePath(ctx, from);
      const msg = deliverablePath
        ? `${baseMsg} ← deliverable: ${toProjectRelative(config.projectRoot, deliverablePath)}`
        : baseMsg;
      ctx?.ui?.notify?.(msg);
      writeStageStatusLast(ctx, msg);
    },

    fail(ctx: any, stage: string, reason: string): void {
      if (!enabled) return;
      const pipelineId = readPipelineId(ctx);
      const prefix = pipelineId
        ? `[ ${pipelineId} • ${stage} ]`
        : `Pipeline → ${stage}`;
      const msg = `${prefix} ⚠ ${reason}`;
      ctx?.ui?.notify?.(msg);
      writeStageStatusLast(ctx, msg);
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

      // Write first frame immediately (move-to-end — animation start)
      const firstFrame = PROGRESS_FRAMES[0];
      writeStageStatusLast(ctx, buildProgressText(label, firstFrame, message));

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

      // Write base text (no frame, no message) — move-to-end at animation end
      writeStageStatusLast(ctx, `Pipeline → ${progressLabel}`);

      // Reset state
      progressLabel = "";
      progressMsg = undefined;
      progressFrameIndex = 0;
    },
  };
}
