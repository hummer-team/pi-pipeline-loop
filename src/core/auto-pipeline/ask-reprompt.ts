/**
 * @module auto-pipeline/ask-reprompt
 * 227 Phase 4 (D-3): a model that "finishes and stops" (ASK) inside an
 * unattended job becomes a BOUNDED, auditable event instead of hanging until
 * the wall-clock stop.
 *
 * Facts:
 * - Owner-only: a child never reprompts (the owner evaluates the chain).
 * - The budget is per STAGE VISIT (`stageStartTime` + visit order fingerprint);
 *   a new visit resets it.
 * - Only a SILENT settle qualifies: no advance, no gate, no pending dispatch.
 * - After the budget the job HARD stops (`ask_reprompt_exhausted`) through the
 *   shared 227 seam.
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import { CONFIRM_GATE_REASK_MAX } from "../../constants";
import { buildStageSequence } from "../../utils/stage-sequence";
import { detectSessionRole } from "../session-role";
import { detectPendingConfirmGate } from "../stage-advancer";
import { scanActiveSpawnEvidence } from "../../utils/spawn-evidence";
import { resolveAgentMention } from "../../utils/subagent-rpc";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { stopAutoDocOnHardFailure } from "./stop-policy";
import { readStateForActiveLock } from "./config-overlay";
import type { AutoJobState } from "./job-state";
import type { FinalizeCtx } from "./finalize";

/** Persisted budget fingerprint + counter (cleared with the meta period). */
export interface AskRepromptSnapshot {
  stage: PipelineStage;
  /** `${stageStartTime}:${stageVisitOrder.length}` — a new visit resets the budget. */
  fingerprint: string;
  count: number;
}

export type RepromptDecision =
  | { deliver: true; reason: "silent_settle"; fingerprint: string; count: number }
  | { deliver: false; reason: string; fingerprint?: string; count?: number; exhausted?: boolean };

/** The stages where a silent settle is a genuine ASK (never clarify/terminal). */
const NON_WORK_STAGES: ReadonlySet<PipelineStage> = new Set([
  "clarify",
  "awaiting_human",
  "completed",
]);

/**
 * Trigger conditions — ALL must hold. Pure, no I/O (the pending-gate probe and
 * the live-executor scan run in {@link maybeAutoAskReprompt}).
 */
export function shouldReprompt(input: {
  meta: SessionMeta;
  before: { stage: PipelineStage; stageStartTime: number; visitCount: number };
  now: number;
}): RepromptDecision {
  const { meta, before } = input;
  if (!meta.autoJob) return { deliver: false, reason: "not_auto_job" };

  // This turn did not advance: stage, entry clock and visit count all match.
  const stageNow = meta.currentStage;
  const startedNow = meta.stageStartTime ?? 0;
  const visitsNow = meta.stageVisitOrder?.length ?? 0;
  if (stageNow !== before.stage || startedNow !== before.stageStartTime || visitsNow !== before.visitCount) {
    return { deliver: false, reason: "stage_advanced" };
  }

  if (meta.flowState === "blocked" || meta.flowState === "aborted") {
    return { deliver: false, reason: "frozen_or_aborted" };
  }
  if (NON_WORK_STAGES.has(stageNow)) return { deliver: false, reason: "non_work_stage" };
  if (meta.pendingSpawns && Object.keys(meta.pendingSpawns).length > 0) {
    return { deliver: false, reason: "pending_spawn" };
  }
  if (meta.confirmGateDeferredAt || meta.confirmGateReask) {
    return { deliver: false, reason: "confirm_gate_pending" };
  }
  if (meta.designReviewEntryPending) {
    return { deliver: false, reason: "design_review_entry_pending" };
  }

  const fingerprint = `${startedNow}:${visitsNow}`;
  const previous = meta.autoAskReprompt;
  const count = previous && previous.fingerprint === fingerprint ? previous.count + 1 : 1;
  if (count > CONFIRM_GATE_REASK_MAX) {
    return { deliver: false, reason: "budget_exhausted", fingerprint, count, exhausted: true };
  }
  return { deliver: true, reason: "silent_settle", fingerprint, count };
}

/** Copy for the bounded owner re-prompt (never parsed — the contract is structural). */
function buildRepromptText(config: PipelineConfig, meta: SessionMeta): string {
  const seq = buildStageSequence(config, meta.currentStage);
  const next = config.stages[meta.currentStage]?.nextStage ?? "the configured next stage";
  return [
    `Auto job "${meta.autoJob?.jobId ?? "unknown"}" is unattended: nobody will answer a question.`,
    `You are in stage "${meta.currentStage}". The legal next stage is "${next}".`,
    `Sequence from here: ${seq.join(" → ")}.`,
    "- Continue the work and call stage_advance with the configured next stage when the evidence is complete.",
    "- Decide autonomously from the available evidence and record the decision in the stage deliverable.",
    "- If you cannot decide, do not ask: write the reason and stop — the plugin reports stop-and-report.",
  ].join("\n");
}

/**
 * 227 review fix (issues 1/2): a settle must never be followed by a "keep
 * going" prompt when the job it belongs to is no longer running — that would
 * restart a stopped document after `finalizeJob` already released the lock and
 * rolled back the overlay.
 *
 * Liveness is judged from the authoritative SIDECAR, not from the settle-time
 * in-process snapshot: an owner settle can begin after the lock was released
 * (crash recovery, another terminal, a resumed session), and `meta.autoJob`
 * survives `finalizeJob`/`handleDocFailure` until the next meta period. The
 * sidecar must exist, be `running`, name the SAME job, and the SAME document
 * index must still be `running`.
 */
function sidecarShowsRunningJob(state: AutoJobState | null, meta: SessionMeta): boolean {
  if (!state || state.status !== "running") return false;
  const jobId = meta.autoJob?.jobId;
  if (!jobId || state.jobId !== jobId) return false;
  const docIndex = meta.autoJob?.docIndex;
  if (docIndex !== undefined && state.docIndex !== docIndex) return false;
  return state.docs[state.docIndex]?.status === "running";
}

/**
 * 227 review fix (issue 4): "is this turn actually SILENT?" — the gate the
 * budget/hard-stop decision MUST consult BEFORE counting a settle. A live
 * executor (or a live confirm gate) means the turn is busy, not an ASK, so it
 * can never push the budget to exhaustion. This probe runs in the async layer
 * (pending-gate detection does I/O).
 */
async function isTurnIdle(config: PipelineConfig, meta: SessionMeta): Promise<boolean> {
  const expectedAgent = resolveAgentMention(config, meta.currentStage) ?? "";
  if (expectedAgent && scanActiveSpawnEvidence(meta.activeSpawns, expectedAgent) !== null) return false;
  if (await detectPendingConfirmGate(config, meta)) return false;
  return true;
}

/**
 * Deliver at most `CONFIRM_GATE_REASK_MAX` owner re-prompts per stage visit;
 * the next silent settle is a hard stop (`ask_reprompt_exhausted`).
 */
export async function maybeAutoAskReprompt(args: {
  ctx: FinalizeCtx;
  config: PipelineConfig;
  before: { stage: PipelineStage; stageStartTime: number; visitCount: number };
}): Promise<void> {
  const { ctx, config, before } = args;
  const meta = ctx.session.getMeta();
  if (!meta) return;
  if (detectSessionRole(ctx as never).isChild) return;

  // 227 review fix (issues 1/2): stop-and-report must stay silent — judged
  // against the SIDECAR on EVERY settle, never against a settle-time snapshot.
  // A hard stop / finalize inside this settle (or a previous one) leaves
  // `meta.autoJob` in place while the job is no longer running, and the
  // re-prompt channel must already be closed.
  if (meta.autoJob) {
    const state = readStateForActiveLock(config.projectRoot);
    if (!sidecarShowsRunningJob(state, meta)) {
      // No sidecar at all = a session that merely CARRIES an `autoJob` block
      // (220 INV-1: the human track stays byte-identical) — return silently.
      // A sidecar that exists but is not running = a finalized/stopped job;
      // audit it so stop-and-report remains observable.
      if (state) {
        await safeWriteAuditLog("auto_ask_reprompt_skipped", {
          pipelineId: meta.pipelineId ?? "",
          stage: meta.currentStage,
          reason: "job_not_running",
        });
      }
      return;
    }
  }

  const decision = shouldReprompt({ meta, before, now: Date.now() });
  if (!decision.deliver) {
    if (decision.exhausted !== true) return;
    // 227 review fix (issue 4): a spent budget is only a hard stop for a TRULY
    // silent settle. A turn that dispatched (or still holds) an executor is not
    // an ASK, so the liveness/idle probes must be consulted BEFORE stopping —
    // otherwise the hard stop kills a job that is making progress.
    if (!(await isTurnIdle(config, meta))) return;
    ctx.session.updateMeta({
      autoAskReprompt: {
        stage: meta.currentStage,
        fingerprint: decision.fingerprint ?? "",
        count: decision.count ?? CONFIRM_GATE_REASK_MAX,
      },
    });
    await stopAutoDocOnHardFailure({
      ctx,
      config,
      meta,
      reason: "ask_reprompt_exhausted",
      auditEvent: "auto_ask_reprompt_exhausted",
      auditExtras: { budget: String(CONFIRM_GATE_REASK_MAX) },
    });
    return;
  }

  // A live spawn / queued spawn means the turn is not actually idle.
  if (!(await isTurnIdle(config, meta))) return;

  const send = ctx.pi?.sendUserMessage;
  if (typeof send !== "function") {
    // Fail-open: the re-prompt channel is optional, but the miss is honest.
    await safeWriteAuditLog("auto_ask_reprompt_error", {
      pipelineId: meta.pipelineId ?? "",
      stage: meta.currentStage,
      reason: "send_user_message_unavailable",
    }, "error");
    return;
  }

  try {
    send(buildRepromptText(config, meta), { deliverAs: "followUp" });
  } catch (err) {
    await safeWriteAuditLog("auto_ask_reprompt_error", {
      pipelineId: meta.pipelineId ?? "",
      stage: meta.currentStage,
      reason: String(err),
    }, "error");
    return;
  }

  ctx.session.updateMeta({
    autoAskReprompt: { stage: meta.currentStage, fingerprint: decision.fingerprint, count: decision.count },
  });
  await safeWriteAuditLog("auto_ask_reprompt", {
    pipelineId: meta.pipelineId ?? "",
    stage: meta.currentStage,
    count: String(decision.count),
  });
}
