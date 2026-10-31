/**
 * @module auto-pipeline/gate-answers
 * 219 Phase 3 G5: automatic answers for the three write/command dialogs.
 *
 * Facts (frozen in 219_Feat.md 6.5 decision 7 + plan Phase 3 §5):
 * - Only an ACTIVE auto job (this process owns the lock) answers; otherwise
 *   `{ auto: false }` and the caller runs the unchanged 3-choice dialog.
 * - In auto mode `"ask"` NEVER becomes "allow": a question is answered with
 *   `block` (the job must not be able to widen its own permissions).
 * - `whitelist_miss` follows the resolved mode: `allow` → allow, `deny` →
 *   block, `ask` → block.
 * - Hard boundaries are untouched: `PROTECTED_PATHS`, the git policy and the
 *   system-path safety net are decided BEFORE any dialog is reached.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { isAutoJobActive } from "./config-overlay";
import { resolveDestructiveCommandPolicy, resolveProtectedPathPolicy } from "../../utils/protect";
import { resolveWhitelistMissMode } from "../write-scope/mode";

/** The three dialogs an auto job must answer without a human. */
export type AutoGateKind = "protected_path" | "destructive_command" | "whitelist_miss";

/** Machine-readable verdict. `auto: false` ⇒ the caller keeps its dialog. */
export type AutoGateVerdict =
  | { auto: false }
  | { auto: true; decision: "allow" | "block"; reason: string };

export interface AutoGateDetail {
  /** Target path (write decisions). */
  path?: string;
  /** Command text (destructive-command decisions). */
  command?: string;
}

/**
 * Resolve one gate for an active auto job.
 *
 * @param kind - Which dialog would have been shown
 * @param config - Live pipeline config (already overlaid by the job)
 * @param meta - Current session metadata (stage drives `whitelist_miss`)
 * @param detail - Dialog-specific detail (diagnostics only, never consulted
 *   for the verdict — the policy keys are the only authority)
 */
export function resolveAutoGate(
  kind: AutoGateKind,
  config: PipelineConfig,
  meta: SessionMeta,
  detail: AutoGateDetail = {},
): AutoGateVerdict {
  if (!isAutoJobActive()) return { auto: false };

  const target = detail.path ?? detail.command ?? "";

  if (kind === "protected_path") {
    const policy = resolveProtectedPathPolicy(config);
    // Both policies block: auto mode must not turn a question into consent.
    return {
      auto: true,
      decision: "block",
      reason: `protected_path_policy=${policy}${target ? ` path=${target}` : ""}`,
    };
  }

  if (kind === "destructive_command") {
    const policy = resolveDestructiveCommandPolicy(config);
    return {
      auto: true,
      decision: "block",
      reason: `destructive_command_policy=${policy}${target ? ` command=${target}` : ""}`,
    };
  }

  // whitelist_miss: the resolved per-stage mode is the authority.
  const mode = resolveWhitelistMissMode(config, meta.currentStage);
  if (mode === "allow") {
    return { auto: true, decision: "allow", reason: "whitelist_miss_mode=allow" };
  }
  return {
    auto: true,
    decision: "block",
    reason: `whitelist_miss_mode=${mode}${target ? ` path=${target}` : ""}`,
  };
}
