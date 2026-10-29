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
import type { OwnerApprovalRequest, OwnerCommandApproval, OwnerWriteApproval, PipelineConfig, PipelineStage, SessionMeta } from "../types";
import { safeWriteAuditLog, encodeAuditValue } from "../utils/auditLog";
// 217 review issue 2 (Medium): ONE capability predicate shared with Phase 2
// (P4 / R1-Q4=A) — a host that DECLARES hasUI=false must never be driven
// through a select() call even if it hands over a select control.
import { resolveDeclaredHasUI } from "./ui-capability";
// 218 T2.4: the batched write menu feeds the SAME Deny breaker + freeze path
// as the owner direct ask (write-scope/decision). flow-state / pipeline-start
// never import this module, so these edges are cycle-free.
import { DEFAULT_MAX_VIOLATIONS } from "../constants";
import { freezeAndPrompt } from "./flow-state";
import { buildOnStageChangedCallback } from "../commands/pipeline-start";
import { recordDenial, clearDenials, readDenialCount } from "./write-scope/denials";
// 218 T2.4: write-approval candidates reuse the merged-decision candidate shape.
import type { WriteCandidate } from "./write-scope/types";
// 218 review #4: a merged batch covers ALL its coarse classes — the breaker
// must count every class, not just the batch's first one.
import { formatCandidateList, uniqueClasses } from "./write-scope/types";

/** Stable short key for a command (the queue's identity, not a security hash). */
export function commandFingerprint(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}

/**
 * 218 T2.4: stable fingerprint for a WRITE batch — target-order independent
 * (sorted join), so the same intent from any call shape dedupes to one entry.
 */
export function writeFingerprint(targets: string[]): string {
  return "w:" + createHash("sha256").update([...targets].sort().join("\n")).digest("hex").slice(0, 16);
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
  const entry: OwnerCommandApproval = {
    command, stage, requestedAt: Date.now(), attempts: 0, pipelineId: meta.pipelineId,
  };
  session.updateMeta({
    pendingOwnerApprovals: {
      ...existing,
      // 217 review issue 3 (Medium): stamp the pipeline of ORIGIN so the
      // owner-side consumer can reject cross-pipeline residue instead of
      // raising an unrelated destructive-command approval on a new pipeline.
      [fingerprint]: entry,
    },
  });
  return { queued: true, fingerprint };
}

/**
 * 218 T2.4/F.3-2: child-side enqueue of a WRITE approval batch (called from
 * write-scope/decision when a child's whitelist-miss candidates are denied).
 * Same fingerprint already waiting → {queued:false}, no duplicate entry and
 * NO violation counting (Q22-A). Audit: `write_approval_queued`.
 */
export function enqueueWriteApproval(
  session: { getMeta: () => SessionMeta | undefined; updateMeta: (p: Partial<SessionMeta>) => unknown },
  stage: PipelineStage,
  candidates: WriteCandidate[],
): OwnerApprovalQueueResult {
  const targets = Array.from(new Set(candidates.map((c) => c.path)));
  const fingerprint = writeFingerprint(targets);
  const meta = session.getMeta();
  if (!meta) return { queued: false, fingerprint };
  const existing = meta.pendingOwnerApprovals ?? {};
  if (existing[fingerprint]) return { queued: false, fingerprint }; // already waiting
  const classes = uniqueClasses(candidates);
  const entry: OwnerWriteApproval = {
    kind: "write",
    targets,
    // 218 review #4: `pathClass` stays the first class (legacy display), but
    // `pathClasses` carries every distinct class so the Deny path can feed
    // the breaker for ALL of them.
    pathClass: classes[0] ?? "@root",
    pathClasses: classes,
    categories: Array.from(new Set(candidates.map((c) => c.category))),
    stage,
    requestedAt: Date.now(),
    attempts: 0,
    pipelineId: meta.pipelineId,
  };
  session.updateMeta({ pendingOwnerApprovals: { ...existing, [fingerprint]: entry } });
  // Fire-and-forget: the child's tool call must never wait on the audit sink.
  void safeWriteAuditLog("write_approval_queued", {
    pipelineId: meta.pipelineId, stage, fingerprint,
    count: String(targets.length),
    targets: targets.map((t) => encodeAuditValue(t)).join(","),
    classes: classes.join(","),
  });
  return { queued: true, fingerprint };
}

/**
 * 218 T2.4: block reason shown to the child — carries the fingerprint and the
 * "do NOT retry" instruction (the queue entry makes retrying pointless; the
 * owner decides on its next settle).
 */
export function writeApprovalBlockReason(candidates: WriteCandidate[], fingerprint: string, stage: PipelineStage): string {
  const list = formatCandidateList(candidates);
  return (
    `FORBIDDEN: write target(s) [${list}] need owner approval ` +
    `(fingerprint ${fingerprint}, stage "${stage}"). Submitted to the owner session — ` +
    `do NOT retry; the owner decides when it settles.`
  );
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
/**
 * 218 T2.4/F.4-2: detailed consume result. `kind` lets callers (T3.3 freeze
 * branch) distinguish WHICH channel was surfaced; the legacy outcome string
 * stays byte-compatible for existing call sites (agent-settled).
 */
export interface OwnerApprovalConsumeResult {
  outcome: OwnerApprovalOutcome;
  kind: "command" | "write" | "none";
  /** Queue fingerprint of the served batch/entry (absent for "none"). */
  fingerprint?: string;
}

/** Minimal owner-side runtime surface (structurally compatible with RuntimeCtx). */
export interface OwnerApprovalConsumeCtx {
  session: { getMeta: () => SessionMeta | undefined; updateMeta: (p: Partial<SessionMeta>) => unknown };
  /** 217 review issue 2: declared capability rides on the runtime ctx. */
  hasUI?: boolean | (() => boolean);
  ui?: { select?: (m: string, o: string[]) => Promise<string | undefined>; notify?: (m: string) => void };
}

/**
 * 218 T2.4: legacy entry point — delegates to the detailed variant and returns
 * `.outcome`, so the 217 call site (agent-settled) is untouched.
 */
export async function consumeOnePendingOwnerApproval(
  ctx: OwnerApprovalConsumeCtx,
  config: PipelineConfig,
): Promise<OwnerApprovalOutcome> {
  return (await consumePendingOwnerApprovalDetailed(ctx, config)).outcome;
}

/**
 * 218 F.3-2 — deterministic selection, ONE interaction per settle:
 * 1. Only entries of the CURRENT pipeline (the existing stale-residue drop stays).
 * 2. Prefer a BATCH of kind:"write" entries of the CURRENT stage, merged into one menu.
 * 3. Otherwise the OLDEST entry whose kind is missing or "command" (217 behaviour verbatim).
 * 4. Otherwise "none" — other stages' writes stay queued for THEIR own settle.
 */
export async function consumePendingOwnerApprovalDetailed(
  ctx: OwnerApprovalConsumeCtx,
  config: PipelineConfig,
): Promise<OwnerApprovalConsumeResult> {
  const meta = ctx.session.getMeta();
  const pending = meta?.pendingOwnerApprovals;
  if (!meta || !pending) return { outcome: "none", kind: "none" };

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
  if (consumable.length === 0) return { outcome: "none", kind: "none" };

  // ── Step 2 (218 T2.4): ALL current-stage kind:"write" entries merge into
  // ONE batched menu (F.4-2: "3 blocked calls → 1 ask" across the queue).
  // Other stages' writes stay queued untouched — they belong to THEIR settle.
  const stageWrites = consumable.filter(
    (entry): entry is [string, OwnerWriteApproval] =>
      entry[1].kind === "write" && entry[1].stage === meta.currentStage,
  );
  if (stageWrites.length > 0) {
    return await consumeWriteBatch(ctx, config, meta, stageWrites);
  }

  // ── Step 3: oldest COMMAND entry (217 behaviour verbatim, strict one-per-settle).
  const commandEntries = consumable.filter(
    (entry): entry is [string, OwnerCommandApproval] => !entry[1].kind || entry[1].kind === "command",
  );
  // ── Step 4: only other-stage writes remain → "none", no menu.
  if (commandEntries.length === 0) return { outcome: "none", kind: "none" };
  const entry = commandEntries.sort((a, b) => a[1].requestedAt - b[1].requestedAt)[0];
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
    return { outcome: "no_ui", kind: "command", fingerprint };
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
  return { outcome: approved ? "approved" : "denied", kind: "command", fingerprint };
}

/**
 * 218 T2.4/F.3-2: consume the CURRENT-stage write batch with ONE menu.
 * Choices act on ALL entries at once:
 * - Allow for this session → every target joins sessionAllowedWritePaths,
 *   the Deny breaker clears, entries are removed, audit `write_approval_approved`,
 *   and a visible /pipeline-resume exit is notified (the blocked child call
 *   already FAILED — re-dispatch is the owner's next move, T3.5 owns recovery).
 * - otherwise (Deny / Esc) → per DISTINCT pathClass one `recordDenial(+1)`;
 *   any class reaching DEFAULT_MAX_VIOLATIONS freezes the pipeline
 *   (`whitelist_miss_denial_overflow`); audit `write_approval_denied`.
 * No menu capability → entries STAY queued (217 owner_approval_no_ui parity).
 */
async function consumeWriteBatch(
  ctx: OwnerApprovalConsumeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  entries: Array<[string, OwnerWriteApproval]>,
): Promise<OwnerApprovalConsumeResult> {
  // Merged, order-preserving, deduped target list (plan: one menu per batch).
  const mergedTargets: string[] = [];
  for (const [, request] of entries) {
    for (const target of request.targets) {
      if (!mergedTargets.includes(target)) mergedTargets.push(target);
    }
  }
  const fingerprints = entries.map(([fingerprint]) => fingerprint);
  const head = mergedTargets.slice(0, 5).join(", ");
  const display = mergedTargets.length > 5 ? `${head} …+${mergedTargets.length - 5}` : head;
  const firstFingerprint = fingerprints[0] ?? "";

  const select = ctx.ui?.select;
  const declared = resolveDeclaredHasUI(ctx);
  const menuCapable = declared !== false && typeof select === "function";
  if (!menuCapable) {
    await safeWriteAuditLog("owner_approval_no_ui", {
      pipelineId: meta.pipelineId, stage: meta.currentStage, kind: "write",
      fingerprints: fingerprints.join(","),
    }, "warn");
    try {
      ctx.ui?.notify?.(`Write approvals are waiting for approval (stage: ${meta.currentStage}).`);
    } catch { /* fail-open */ }
    return { outcome: "no_ui", kind: "write", fingerprint: firstFingerprint };
  }

  const choice = await select(
    `Child sessions request these writes (stage "${meta.currentStage}"):\n  ${display}`,
    ["Deny (block)", "Allow for this session"],
  );
  const approved = choice === "Allow for this session";

  // Remove ALL served entries from the FRESHEST queue snapshot (shared-store
  // discipline: a concurrent enqueue during the await must not be clobbered).
  const removeBatch = (): void => {
    const current = ctx.session.getMeta()?.pendingOwnerApprovals ?? {};
    const served = new Set(fingerprints);
    ctx.session.updateMeta({
      pendingOwnerApprovals: Object.fromEntries(Object.entries(current).filter(([key]) => !served.has(key))),
    });
  };

  if (approved) {
    const fresh = ctx.session.getMeta() ?? meta;
    const allowed = fresh.sessionAllowedWritePaths ?? [];
    const toAdd = mergedTargets.filter((target) => !allowed.includes(target));
    if (toAdd.length > 0) {
      ctx.session.updateMeta({ sessionAllowedWritePaths: [...allowed, ...toAdd] });
    }
    // Any human Allow replaces the deny pressure entirely (Q15-B).
    clearDenials(ctx.session);
    removeBatch();
    await safeWriteAuditLog("write_approval_approved", {
      pipelineId: meta.pipelineId, stage: meta.currentStage,
      count: String(mergedTargets.length),
      targets: mergedTargets.map((target) => encodeAuditValue(target)).join(","),
      fingerprints: fingerprints.join(","),
    });
    try {
      ctx.ui?.notify?.(
        `Write approval granted for this session (stage "${meta.currentStage}"). ` +
        `No executor is running for this stage — run /pipeline-resume to re-dispatch it.`,
      );
    } catch { /* fail-open */ }
    return { outcome: "approved", kind: "write", fingerprint: firstFingerprint };
  }

  // Deny path: per DISTINCT pathClass the +1 feeds the stage-scoped breaker.
  // 218 review #4: merged batches carry EVERY class they cover (`pathClasses`);
  // legacy single-class entries fall back to `[pathClass]`.
  const classes = Array.from(new Set(
    entries.flatMap(([, request]) => request.pathClasses?.length ? request.pathClasses : [request.pathClass]),
  ));
  for (const pathClass of classes) {
    recordDenial(ctx.session, ctx.session.getMeta() ?? meta, meta.currentStage, pathClass);
  }
  removeBatch();
  await safeWriteAuditLog("write_approval_denied", {
    pipelineId: meta.pipelineId, stage: meta.currentStage,
    count: String(mergedTargets.length),
    targets: mergedTargets.map((target) => encodeAuditValue(target)).join(","),
    fingerprints: fingerprints.join(","),
    classes: classes.join(","),
  });
  const afterMeta = ctx.session.getMeta();
  // 218 review #2: use the single canonical read (stage AND pipeline-period
  // scoped) instead of an ad-hoc raw record read.
  const overflowed = classes.some(
    (pathClass) => readDenialCount(afterMeta ?? meta, meta.currentStage, pathClass) >= DEFAULT_MAX_VIOLATIONS,
  );
  if (overflowed) {
    await freezeAndPrompt(
      // Structural parity: the owner ctx always satisfies FlowStateCtx at
      // runtime; the narrow local type only differs in updateMeta's return.
      ctx as unknown as Parameters<typeof freezeAndPrompt>[0],
      ctx.session.getMeta() ?? meta,
      "violation_overflow",
      config,
      { onStageChanged: buildOnStageChangedCallback(ctx, config) },
    );
    await safeWriteAuditLog("whitelist_miss_denial_overflow", {
      pipelineId: meta.pipelineId, stage: meta.currentStage,
      classes: classes.join(","),
    });
  }
  return { outcome: "denied", kind: "write", fingerprint: firstFingerprint };
}
