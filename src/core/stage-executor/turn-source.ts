/**
 * @module stage-executor/turn-source
 * 194 Phase 3 (C3/C5, task 3): the trusted WAKE SOURCE channel between a
 * closed-loop executor terminal and the owner's settle path.
 *
 * Why text signatures alone were not enough: the owner settle gate decides
 * "pipeline turn vs pure chat" from the last user message. A plugin wake is
 * exactly the turn that must NEVER be mistaken for chat, and a REPEATED wake
 * of an already-consumed run must never re-trigger consumption. So every
 * trusted wake carries a plugin-issued id:
 *
 *   - the id is persisted as `run.pendingWakeId` through the STRICT commit
 *     BEFORE anything is sent (UI/wake only after a reliable commit);
 *   - the message begins with the registered signature
 *     `pi-pipeline:owner-wake <wakeId>` and additionally passes the source
 *     through the SDK message `detail` (harmlessly ignored by older SDKs)
 *     plus a LOCAL session entry (`pi-pipeline:turn-source`) — the entry
 *     survives message rewrites/truncation;
 *   - the settle gate verifies the marker against the CURRENT pendingWakeId
 *     BEFORE the ordinary-chat signature gate, making consumption "exactly
 *     once with the current binding" enforceable.
 *
 * Send failures KEEP the persisted pendingWakeId (a resumable state — the
 * owner can still consume on the next turn); they never re-dispatch the
 * executor to "fix" a lost notification (plan Phase 3 core guidance).
 */

import { randomUUID } from "node:crypto";
import type { PipelineConfig, SessionMeta, StageExecutorStatus } from "../../types";
import type { ReliableMetaCommitResult } from "../../types";
import type { StageExecutorRun, StageOwnerConsumptionState } from "./contracts";
import { strictCommitMeta } from "../session-state";
import { executorExpectationFromCurrent } from "./commit-guard";
import { takePendingWake } from "./run-state";
import { safeWriteAuditLog } from "../../utils/auditLog";

/** Message prefix of a plugin owner wake (registered in PIPELINE_TURN_SIGNATURES). */
export const OWNER_WAKE_SIGNATURE = "pi-pipeline:owner-wake";

/** Local session entry type recording the wake source (survives text rewrites). */
export const TURN_SOURCE_ENTRY_TYPE = "pi-pipeline:turn-source";

/** Strict-commit-capable session adapter (same bounded shape as terminal.ts). */
export interface WakeSession {
  getMeta(): SessionMeta | undefined;
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
  updateMetaVerified?(
    patch: Partial<SessionMeta>,
    expected: import("../session-state").MetaCommitExpectation,
  ): ReliableMetaCommitResult;
}

/** Minimal runtime surface needed to deliver a wake turn. */
export interface WakePi {
  sendUserMessage?(msg: string, opts?: Record<string, unknown>): void;
  appendEntry?(customType: string, data: unknown): void;
}

/** Result of one wake attempt. */
export interface OwnerWakeResult {
  sent: boolean;
  /** The wake id bound to the current run+revision (null: none was issuable). */
  wakeId: string | null;
  reason?: string;
}

/**
 * Issue (at most once per run+revision) and send the trusted owner wake.
 *
 * Ordering guarantees enforced here:
 * 1. NEVER wake before a trusted terminal — callers invoke this only from
 *    the terminal/recovery application paths;
 * 2. the pendingWakeId is persisted through the strict commit BEFORE the
 *    message goes out (a conflict means someone else moved the run: zero
 *    side effects, no send);
 * 3. an already-outstanding wake is NEVER re-sent (dedup);
 * 4. a send failure keeps the persisted wake (resumable), and never spawns
 *    or re-dispatches anything.
 */
export async function sendTrustedOwnerWake(
  deps: {
    pi: unknown;
    session: WakeSession;
    config: PipelineConfig;
    /** The run the wake is bound to (freshly applied terminal record). */
    run: StageExecutorRun;
    /** Terminal status to announce in the wake text. */
    status: StageExecutorStatus;
    issueWakeId?: () => string;
  },
): Promise<OwnerWakeResult> {
  const { session, run } = deps;
  try {
    if (run.terminalConsumed) {
      return { sent: false, wakeId: null, reason: "already_consumed" };
    }
    const taken = takePendingWake(run, deps.issueWakeId ?? (() => randomUUID()));
    if (taken.wakeId === null) {
      // One wake per run+revision, ever — an outstanding id already covers it.
      return { sent: false, wakeId: null, reason: "wake_already_pending" };
    }

    // Anchor the persist on the CURRENT meta run (it may carry a newer
    // declaration/consumption than the caller's snapshot; the strict
    // expectation pins every identity component anyway).
    const meta = session.getMeta();
    const currentRun = meta?.stageExecutorRun;
    if (!meta || !currentRun || currentRun.binding.runId !== run.binding.runId) {
      return { sent: false, wakeId: null, reason: "run_superseded" };
    }
    // Race guard: the PERSISTED run may already hold a wake the caller's
    // snapshot predates — dedup is against the durable state, never the
    // caller's view (at most one wake per run+revision).
    if (currentRun.pendingWakeId !== undefined) {
      return { sent: false, wakeId: currentRun.pendingWakeId, reason: "wake_already_pending" };
    }
    const res = strictCommitMeta(
      session,
      { stageExecutorRun: { ...currentRun, pendingWakeId: taken.wakeId } },
      {
        pipelineId: meta.pipelineId ?? "unknown",
        ...executorExpectationFromCurrent(meta),
      },
    );
    if (res.status !== "persisted") {
      void safeWriteAuditLog("owner_wake", {
        action: "wake_persist_failed",
        runId: currentRun.binding.runId,
        commit: res.status,
        reason: "reason" in res ? res.reason : "unknown",
      }, "error");
      return {
        sent: false,
        wakeId: null,
        reason: `persist_failed:${res.status}:${"reason" in res ? res.reason : "unknown"}`,
      };
    }

    const pi = (deps.pi ?? {}) as WakePi;
    const text =
      `${OWNER_WAKE_SIGNATURE} ${taken.wakeId}\n` +
      `Stage executor "${currentRun.binding.stage}" finished (${deps.status}). ` +
      `Consume the verified result now — the executor is not re-dispatched by this message.`;

    // Local entry: the durable source evidence for the settle gate even if
    // the message text gets rewritten/truncated by the transport.
    if (typeof pi.appendEntry === "function") {
      try {
        pi.appendEntry(TURN_SOURCE_ENTRY_TYPE, {
          wakeId: taken.wakeId,
          runId: currentRun.binding.runId,
          pipelineId: currentRun.binding.pipelineId,
          stage: currentRun.binding.stage,
          stageVisitId: currentRun.binding.stageVisitId,
          operationId: currentRun.binding.operationId,
          status: deps.status,
          at: Date.now(),
        });
      } catch (err) {
        // Entry is AUXILIARY evidence: the persisted pendingWakeId + the
        // marker text still carry the source. Never undo a persisted wake.
        void safeWriteAuditLog("owner_wake", {
          action: "turn_source_entry_failed",
          wakeId: taken.wakeId,
          error: err instanceof Error ? err.message : String(err),
        }, "warn");
      }
    }

    if (typeof pi.sendUserMessage !== "function") {
      void safeWriteAuditLog("owner_wake", {
        action: "wake_channel_unavailable",
        wakeId: taken.wakeId,
        runId: currentRun.binding.runId,
      }, "warn");
      return { sent: false, wakeId: taken.wakeId, reason: "channel_unavailable" };
    }
    try {
      // The structured `detail` rides the SDK options: newer SDKs surface it
      // as message detail; older ones ignore the extra keys.
      pi.sendUserMessage(text, {
        deliverAs: "followUp",
        customType: OWNER_WAKE_SIGNATURE,
        detail: {
          wakeId: taken.wakeId,
          runId: currentRun.binding.runId,
          stage: currentRun.binding.stage,
          stageVisitId: currentRun.binding.stageVisitId,
          operationId: currentRun.binding.operationId,
        },
      });
    } catch (err) {
      // Send failure keeps the resumable pendingWakeId — the owner can still
      // consume on any later turn; NO executor re-dispatch compensates (C4).
      void safeWriteAuditLog("owner_wake", {
        action: "wake_send_failed",
        wakeId: taken.wakeId,
        runId: currentRun.binding.runId,
        error: err instanceof Error ? err.message : String(err),
      }, "warn");
      return { sent: false, wakeId: taken.wakeId, reason: "send_failed" };
    }

    // The wake is DELIVERED at this point: the audit record is diagnostic
    // only — an audit failure must never turn a sent wake into a reported
    // non-send (the caller would risk re-waking, breaking exactly-once).
    void safeWriteAuditLog("owner_wake", {
      action: "wake_sent",
      wakeId: taken.wakeId,
      runId: currentRun.binding.runId,
      stage: currentRun.binding.stage,
      status: deps.status,
    });
    return { sent: true, wakeId: taken.wakeId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void safeWriteAuditLog("owner_wake", {
      action: "wake_error",
      runId: run.binding.runId,
      error: errMsg,
    }, "error");
    return { sent: false, wakeId: null, reason: `exception:${errMsg}` };
  }
}

/** Extract the plugin wake id from a user-turn text (null: not a wake turn). */
export function extractOwnerWakeId(messageText: string): string | null {
  const trimmed = messageText.trimStart();
  if (!trimmed.startsWith(OWNER_WAKE_SIGNATURE)) return null;
  const rest = trimmed.slice(OWNER_WAKE_SIGNATURE.length);
  // The id must sit on the SAME line as the signature (horizontal spacing
  // only) — a bare mention of the signature in prose never qualifies.
  const m = /^[ \t]+(\S+)/.exec(rest);
  return m ? m[1] : null;
}

/** Outcome of the pre-chat wake-source verification. */
export interface WakeTurnVerdict {
  /** True when the text carries a plugin wake marker at all. */
  matched: boolean;
  /** True only when the marker equals the CURRENT run's pendingWakeId. */
  trusted: boolean;
  wakeId: string | null;
}

/**
 * 194 task 3: verify a wake turn BEFORE the ordinary-chat signature gate.
 * `trusted` requires the marker id to equal the current run's persisted
 * pendingWakeId — a replay of an already-consumed wake (id cleared) is
 * matched-but-untrusted, which is what makes consumption exactly-once per
 * binding enforceable at the settle entry.
 */
export function verifyOwnerWakeTurn(messageText: string, meta: SessionMeta | undefined): WakeTurnVerdict {
  const wakeId = extractOwnerWakeId(messageText);
  if (wakeId === null) return { matched: false, trusted: false, wakeId: null };
  const pending = meta?.stageExecutorRun?.pendingWakeId;
  return { matched: true, trusted: pending !== undefined && pending === wakeId, wakeId };
}

/** Result of recording one C5 waiting state. */
export interface AwaitingStateResult {
  ok: boolean;
  reason?: string;
}

/**
 * 194 C5/task 3: record the visible waiting state on the CURRENT run BEFORE
 * a tool/smart path skips its turn (plan: "tool/smart skip records C5 wait
 * state"). The state is a RECORD only — it grants no advance, no counting
 * and no approval; Part 3's owner-consumption matrix acts on it.
 */
export async function recordAwaitingOwnerConsumption(
  deps: {
    session: WakeSession;
    /** Run the skip is bound to (identity must still be current). */
    run: StageExecutorRun;
    state: Extract<StageOwnerConsumptionState, "awaiting-owner-tool" | "awaiting-confirmation">;
  },
): Promise<AwaitingStateResult> {
  const { session, run } = deps;
  try {
    const meta = session.getMeta();
    const currentRun = meta?.stageExecutorRun;
    if (!meta || !currentRun) return { ok: false, reason: "run_absent" };
    if (currentRun.binding.runId !== run.binding.runId) return { ok: false, reason: "run_superseded" };
    if (currentRun.terminalConsumed) return { ok: false, reason: "already_consumed" };
    // Idempotent: the same waiting state already recorded is not a change.
    if (currentRun.consumption?.state === deps.state) return { ok: true };

    const res = strictCommitMeta(
      session,
      {
        stageExecutorRun: {
          ...currentRun,
          consumption: {
            ...currentRun.consumption,
            state: deps.state,
            declarationRevision:
              currentRun.declaration?.revision ?? currentRun.consumption?.declarationRevision,
          },
        },
      },
      {
        pipelineId: meta.pipelineId ?? "unknown",
        ...executorExpectationFromCurrent(meta),
      },
    );
    if (res.status !== "persisted") {
      const why = `${res.status}:${"reason" in res ? res.reason : "unknown"}`;
      void safeWriteAuditLog("owner_consumption", {
        action: "awaiting_state_failed",
        runId: currentRun.binding.runId,
        state: deps.state,
        reason: why,
      }, "error");
      return { ok: false, reason: why };
    }
    return { ok: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void safeWriteAuditLog("owner_consumption", {
      action: "awaiting_state_error",
      error: errMsg,
    }, "error");
    return { ok: false, reason: `exception:${errMsg}` };
  }
}
