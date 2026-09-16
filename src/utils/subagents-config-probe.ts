/**
 * @module subagents-config-probe
 * Read-only probe for the pi-subagents deployment config (`.pi/subagents.json`).
 *
 * Phase 1 / 179 (G2 layer ④): surfaces the `agentMentions:"model"` deployment
 * mode, which rewrites @mention prompts (a known cause of the clarify
 * next-command gap). The plugin never reads or overwrites this file for
 * behavior — it only detects the mode and nudges the user toward "direct"
 * (see guide.md §7.11).
 *
 * Fail-safe: a missing file, unreadable file, invalid JSON, or unexpected shape
 * degrades to "absent"/"invalid" — no warning, no block, no throw.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig } from "../types";
import { CONFIG_DIR_NAME, AUDIT_THROTTLE_WINDOW_MS } from "../constants";
import { safeWriteAuditLog } from "./auditLog";
import { shouldEmitWithinWindow } from "./audit-throttle";

/** Result of probing the `agentMentions` key in `.pi/subagents.json`. */
export type SubagentsMentionMode = "model" | "ok" | "absent" | "invalid";

/**
 * Probes the `agentMentions` mode in `<projectRoot>/.pi/subagents.json`.
 *
 * @param projectRoot - Absolute project root directory
 * @returns
 * - `"model"`:   file present, valid JSON, `agentMentions === "model"` (rewrite mode)
 * - `"ok"`:      file present, valid JSON, `agentMentions` set to anything else
 * - `"absent"`:  file missing, or present without an `agentMentions` key
 * - `"invalid"`: file present but not valid JSON (or not a JSON object)
 */
export function probeSubagentsMentionMode(projectRoot: string): SubagentsMentionMode {
  const configPath = path.join(projectRoot, CONFIG_DIR_NAME, "subagents.json");

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    return "absent";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "invalid";
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "invalid";
  }

  const value = (parsed as Record<string, unknown>).agentMentions;
  if (value === undefined) return "absent";
  return value === "model" ? "model" : "ok";
}

/**
 * When the deployment uses `agentMentions:"model"`, notify the user (throttled)
 * suggesting `"direct"` for pipeline usage, and record an audit event.
 * The user's config file is never modified.
 *
 * Fail-open: any error is swallowed — this must never block session start/init.
 *
 * @param config - Pipeline configuration (for projectRoot)
 * @param ui - Minimal notify sink
 */
export async function maybeNotifySubagentsMentionMode(
  config: PipelineConfig,
  ui: { notify: (msg: string) => void },
): Promise<void> {
  try {
    const mode = probeSubagentsMentionMode(config.projectRoot);
    if (mode !== "model") return;

    // Throttle so repeated session starts / inits within the window stay quiet.
    if (!shouldEmitWithinWindow(`subagents_mention_model:${config.projectRoot}`, AUDIT_THROTTLE_WINDOW_MS)) {
      return;
    }

    ui.notify(
      'pi-subagents agentMentions is set to "model" (.pi/subagents.json), which rewrites @mention prompts. ' +
        'For pipeline usage set it to "direct" to preserve exact args — see guide.md §7.11.',
    );
    await safeWriteAuditLog("subagents_mention_model_detected", {
      projectRoot: config.projectRoot,
    }, "warn");
  } catch {
    // Fail-open: probe/notify must never block the caller
  }
}
