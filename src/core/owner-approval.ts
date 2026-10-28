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
// 217 review issue 2 (Medium): ONE capability predicate shared with Phase 2
// (P4 / R1-Q4=A) — a host that DECLARES hasUI=false must never be driven
// through a select() call even if it hands over a select control.
import { resolveDeclaredHasUI } from "./ui-capability";

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
      // 217 review issue 3 (Medium): stamp the pipeline of ORIGIN so the
      // owner-side consumer can reject cross-pipeline residue instead of
      // raising an unrelated destructive-command approval on a new pipeline.
      [fingerprint]: { command, stage, requestedAt: Date.now(), attempts: 0, pipelineId: meta.pipelineId },
    },
  });
  return { queued: true, fingerprint };
}

export type OwnerApprovalOutcome = "approved" | "denied" | "no_ui" | "none";

/**
 * Owner side: present ONE pending approval (oldest first) and apply the choice.
 * No UI (declared `false` wins, 217 review issue 2) → fail-closed and visible:
 * the request STAYS queued for a UI-capable turn (never silently dropped).
 *
 * 217 review issue 3 (Medium): only entries belonging to the CURRENT pipeline
 * are consumable. An entry whose origin `pipelineId` differs from (or is
 * missing under) the current meta is stale boundary residue — dropped with a
 * visible audit so a new pipeline's first owner settle never surfaces an
 * approval for a destructive command it never asked about.
 */
export async function consumeOnePendingOwnerApproval(
  ctx: {
    session: { getMeta: () => SessionMeta | undefined; updateMeta: (p: Partial<SessionMeta>) => unknown };
    /** 217 review issue 2: declared capability rides on the runtime ctx. */
    hasUI?: boolean | (() => boolean);
    ui?: { select?: (m: string, o: string[]) => Promise<string | undefined>; notify?: (m: string) => void };
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _config: PipelineConfig,
): Promise<OwnerApprovalOutcome> {
  const meta = ctx.session.getMeta();
  const pending = meta?.pendingOwnerApprovals;
  if (!meta || !pending) return "none";

  // ── Cross-pipeline residue guard (217 review issue 3) ──
  // Entries from another (or unknown-origin) pipeline are NOT consumable: they
  // are dropped so they can neither pop an unrelated approval menu nor leak a
  // command into the NEW pipeline's `sessionAllowedCommands` whitelist.
  const stale = Object.entries(pending).filter(([, request]) => request.pipelineId !== meta.pipelineId);
  if (stale.length > 0) {
    const staleKeys = new Set(stale.map(([key]) => key));
    const remaining = Object.fromEntries(
      Object.entries(ctx.session.getMeta()?.pendingOwnerApprovals ?? pending)
        .filter(([key]) => !staleKeys.has(key)),
    );
    ctx.session.updateMeta({ pendingOwnerApprovals: remaining });
    await safeWriteAuditLog("owner_approval_stale_dropped", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      dropped: stale.map(([fingerprint, request]) => `${fingerprint}:${request.pipelineId ?? "unknown"}`).join(","),
    }, "warn");
  }
  // Re-read AFTER the stale drop, then narrow to CURRENT-pipeline requests only.
  const consumable = Object.entries(ctx.session.getMeta()?.pendingOwnerApprovals ?? {})
    .filter(([, request]) => request.pipelineId === meta.pipelineId);
  if (consumable.length === 0) return "none";

  // Oldest first among CURRENT-pipeline requests only.
  const entry = consumable.sort((a, b) => a[1].requestedAt - b[1].requestedAt)[0];
  const [fingerprint, request] = entry;
  const remove = (): void => {
    const { [fingerprint]: _removed, ...rest } = ctx.session.getMeta()?.pendingOwnerApprovals ?? {};
    ctx.session.updateMeta({ pendingOwnerApprovals: rest });
  };

  // 217 review issue 2 (Medium): declared `false` WINS over a present select
  // (Phase 2 P4/R1-Q4=A capability unification) — the approval menu obeys the
  // SAME predicate as the decision menu, and the request stays queued
  // (owner_approval_no_ui) instead of being driven through a select() call.
  // `select` local keeps the type narrowing the old truthy check provided
  // (menuCapable already requires a real select).
  const select = ctx.ui?.select;
  const declared = resolveDeclaredHasUI(ctx);
  const menuCapable = declared !== false && typeof select === "function";
  if (!menuCapable) {
    // Fail-closed and visible: the request stays queued for a UI-capable turn.
    await safeWriteAuditLog("owner_approval_no_ui", {
      pipelineId: meta.pipelineId, stage: request.stage, fingerprint,
    }, "warn");
    try { ctx.ui?.notify?.(`A destructive command is waiting for approval (stage: ${request.stage}).`); } catch { /* fail-open */ }
    return "no_ui";
  }

  const display = request.command.length > 60 ? `${request.command.slice(0, 57)}...` : request.command;
  const choice = await select(`Child session requests a destructive command:\n  ${display}`, [
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
