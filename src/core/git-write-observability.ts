/**
 * @module git-write-observability
 * 225 Phase 0 (RC-1 leftover + R3): positive audit for ALLOWED git writes.
 *
 * The tool-guard historically only audited BLOCKED git commands, so a stage
 * that committed cleanly left no evidence. This module records every allowed
 * git write (`git_write_allowed`), flags remote writes for observability
 * (R3 disposition: accepted + auditable, never intercepted), and maintains
 * the per-period `meta.gitAllowedWrites` counter that Phase 5's
 * `git_write_unobserved` warning consumes.
 *
 * Failure posture is strictly fail-open: an observability error must never
 * block the agent's command — errors are logged (error level + context) and
 * swallowed.
 */

import type { PipelineStage, SessionMeta } from "../types";
import { safeWriteAuditLog, encodeAuditValue } from "../utils/auditLog";

/** Git subcommands that reach remotes (R3: accepted + auditable). */
const REMOTE_SUBCOMMANDS = new Set(["push", "fetch", "pull"]);

/**
 * Extracts the git subcommand from a segment (tolerates an `rtk git` prefix).
 */
function gitSubcommandOf(segment: string): string | undefined {
  const tokens = segment.trim().split(/\s+/);
  const gitIdx = tokens.findIndex((t) => t === "git");
  const sub = gitIdx >= 0 ? tokens[gitIdx + 1] : undefined;
  return sub;
}

/** Reads the allowed-git-write counter (Phase 5 consumes this). */
export function getAllowedGitWriteCount(meta: SessionMeta): number {
  return meta.gitAllowedWrites ?? 0;
}

/**
 * Records one allowed git write: increments `meta.gitAllowedWrites`,
 * audits `git_write_allowed`, and additionally audits `git_remote_write`
 * when the segment targets a remote (push/fetch/pull).
 *
 * Never throws — observability failures are logged and swallowed.
 */
export async function recordAllowedGitWrite(
  meta: SessionMeta,
  session: { getMeta(): SessionMeta | undefined; updateMeta(patch: Partial<SessionMeta>): unknown },
  segment: string,
  stage: PipelineStage,
): Promise<void> {
  try {
    // Read the LIVE counter so multiple writes inside one turn accumulate
    // instead of overwriting each other with the snapshot value.
    const live = session.getMeta() ?? meta;
    const nextCount = getAllowedGitWriteCount(live) + 1;
    session.updateMeta({ gitAllowedWrites: nextCount });

    await safeWriteAuditLog("git_write_allowed", {
      stage,
      command: encodeAuditValue(segment),
    });

    const subcommand = gitSubcommandOf(segment);
    if (subcommand && REMOTE_SUBCOMMANDS.has(subcommand)) {
      const args = segment.trim().split(/\s+/).filter((t) => t !== "git" && t !== subcommand);
      await safeWriteAuditLog("git_remote_write", {
        stage,
        subcommand,
        args: encodeAuditValue(args.join(" ")),
        policy: "allow",
      });
    }
  } catch (err) {
    // Fail-open: never alter the command outcome; still log with context.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[pi-pipeline] git-write observability failed for stage="${stage}": ${errMsg}`);
    void safeWriteAuditLog("git_write_observability_error", { stage, error: errMsg }, "error");
  }
}
