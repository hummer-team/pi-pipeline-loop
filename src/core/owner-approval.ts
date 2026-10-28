/**
 * @module owner-approval
 * 217 Phase 3 (T3.2, F5 / P2): child destructive-command escalation queue.
 *
 * A child that hits a destructive command used to depend on the host sharing
 * the owner's `ui.select` (protect.ask) — a carry-in that does not exist for
 * a child runtime, so the command was either "hard-banned" invisibly or fell
 * through. Fail closed instead: the child enqueues a fingerprint-keyed
 * approval request in the SHARED meta, and the owner consumes it on its next
 * settle with its own menu; an approval writes the existing
 * `sessionAllowedCommands` (no new persistence shape).
 */

import { createHash } from "node:crypto";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";

/** Stable short key for a command (the queue's identity, not a security hash). */
export function commandFingerprint(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

export interface OwnerApprovalQueueResult { queued: boolean; fingerprint: string }

/** Child side: enqueue (idempotent) and return the fingerprint for auditing. */
export function enqueueOwnerApproval(
  session: { getMeta: () => SessionMeta | undefined; updateMeta: (p: Partial<SessionMeta>) => unknown },
  stage: PipelineStage,
  command: string,
): OwnerApprovalQueueResult {
  const fingerprint = commandFingerprint(command);
  const meta = session.getMeta();
  if (!meta) return { queued: false, fingerprint };
  const existing = meta.pendingOwnerApprovals ?? {};
  if (existing[fingerprint]) return { queued: false, fingerprint }; // already waiting
  session.updateMeta({
    pendingOwnerApprovals: {
      ...existing,
      [fingerprint]: { command, stage, requestedAt: Date.now(), attempts: 0 },
    },
  });
  return { queued: true, fingerprint };
}

export type OwnerApprovalOutcome = "approved" | "denied" | "no_ui" | "none";

/**
 * Owner side: present ONE pending approval (oldest first) and apply the choice.
 * No UI → fail-closed and visible: the request STAYS queued for a UI-capable
 * turn (never silently dropped).
 */
export async function consumeOnePendingOwnerApproval(
  ctx: {
    session: { getMeta: () => SessionMeta | undefined; updateMeta: (p: Partial<SessionMeta>) => unknown };
    ui?: { select?: (m: string, o: string[]) => Promise<string | undefined>; notify?: (m: string) => void };
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _config: PipelineConfig,
): Promise<OwnerApprovalOutcome> {
  const meta = ctx.session.getMeta();
  const pending = meta?.pendingOwnerApprovals;
  if (!meta || !pending) return "none";
  const entry = Object.entries(pending).sort((a, b) => a[1].requestedAt - b[1].requestedAt)[0];
  if (!entry) return "none";
  const [fingerprint, request] = entry;
  const remove = (): void => {
    const { [fingerprint]: _removed, ...rest } = ctx.session.getMeta()?.pendingOwnerApprovals ?? {};
    ctx.session.updateMeta({ pendingOwnerApprovals: rest });
  };

  if (typeof ctx.ui?.select !== "function") {
    // Fail-closed and visible: the request stays queued for a UI-capable turn.
    await safeWriteAuditLog("owner_approval_no_ui", {
      pipelineId: meta.pipelineId, stage: request.stage, fingerprint,
    }, "warn");
    try { ctx.ui?.notify?.(`A destructive command is waiting for approval (stage: ${request.stage}).`); } catch { /* fail-open */ }
    return "no_ui";
  }

  const display = request.command.length > 60 ? `${request.command.slice(0, 57)}...` : request.command;
  const choice = await ctx.ui.select(`Child session requests a destructive command:\n  ${display}`, [
    "Deny (block)",
    "Allow for this session",
  ]);
  const approved = choice === "Allow for this session";
  if (approved) {
    const allowed = meta.sessionAllowedCommands ?? [];
    if (!allowed.includes(request.command)) {
      ctx.session.updateMeta({ sessionAllowedCommands: [...allowed, request.command] });
    }
  }
  remove();
  await safeWriteAuditLog(approved ? "destructive_command_approved" : "destructive_command_denied", {
    pipelineId: meta.pipelineId, stage: request.stage, fingerprint, command: request.command,
  });
  return approved ? "approved" : "denied";
}
