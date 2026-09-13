/**
 * @module config-staleness
 * Phase 3 / 175: Detect when pipeline_loop.json has been modified after plugin load.
 *
 * Design: mtime-based staleness check (NOT hot-reload). When the config file's mtime
 * exceeds the recorded load-time mtime, the config is considered stale. The user is
 * notified once (throttled) to run pi `/reload` to pick up changes.
 *
 * Any IO failure (file missing, stat error) → fail-open → returns false/null.
 */

import fs from "node:fs";
import type { PipelineConfig } from "../types";
import { shouldEmitWithinWindow } from "./audit-throttle";

/** Throttle key for stale-config notifications (60s window) */
const STALE_CONFIG_THROTTLE_KEY = "config_stale_notify";

/** Throttle window for stale-config notifications (milliseconds) */
const STALE_CONFIG_THROTTLE_WINDOW_MS = 60_000;

/**
 * Checks whether the pipeline config file has been modified since it was loaded.
 *
 * @param config - Pipeline configuration with configSourcePath and configLoadedMtimeMs
 * @returns true if the config file has been modified since load; false if unchanged or unknown
 */
export function isConfigStale(config: PipelineConfig): boolean {
  const { configSourcePath, configLoadedMtimeMs } = config;

  // No tracking info → cannot determine staleness → fail-open
  if (!configSourcePath || configLoadedMtimeMs === undefined) {
    return false;
  }

  try {
    const stat = fs.statSync(configSourcePath);
    return stat.mtimeMs > configLoadedMtimeMs;
  } catch {
    // IO failure (file deleted, permissions, etc.) → fail-open
    return false;
  }
}

/**
 * Returns an English notification message if the config is stale, or null if up-to-date.
 * Throttled to once per 60s per key to prevent notification flooding.
 *
 * @param config - Pipeline configuration
 * @returns English notification string, or null if no notification needed
 */
export function staleConfigNotice(config: PipelineConfig): string | null {
  if (!isConfigStale(config)) {
    return null;
  }

  // Throttle: only emit once per 60s window
  if (!shouldEmitWithinWindow(STALE_CONFIG_THROTTLE_KEY, STALE_CONFIG_THROTTLE_WINDOW_MS)) {
    return null;
  }

  const fileName = config.configSourcePath
    ? config.configSourcePath.split("/").pop() ?? "pipeline_loop.json"
    : "pipeline_loop.json";

  return `Configuration file "${fileName}" has been modified since the extension was loaded. Changes will not take effect until you run pi /reload to reload the extension.`;
}
