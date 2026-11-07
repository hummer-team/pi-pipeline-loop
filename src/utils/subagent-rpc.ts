/**
 * @module subagent-rpc
 * RPC wrapper for pi-subagents communication via pi.events EventBus.
 *
 * Protocol (third-party, envelope-tolerant):
 * - Ping: emit "subagents:rpc:ping" → reply on "subagents:rpc:ping:reply:<requestId>"
 * - Spawn: emit "subagents:rpc:spawn" → reply on "subagents:rpc:spawn:reply:<requestId>"
 * - Lifecycle: listen for "subagents:completed" / "subagents:failed"
 *
 * All functions are fail-safe: timeout or parse errors never throw.
 * The caller is expected to degrade gracefully on { ok: false }.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeWriteAuditLog } from "./auditLog";
import { clearActiveSpawnRecord, removePendingSpawnsEntry } from "./spawn-cleanup";
import { isSubagentsReady } from "./subagent-availability";
import { resolveClarifyDescription } from "./clarify-args";
import { appendPipelineIdMarker } from "./pipeline-id-marker";
// 225 Phase 2: review round ledger + 同一 resolver for description & prompt.
import { ensureReviewRound } from "./review-round";
import { resolveStageTargetDoc } from "./stage-target-doc";
// 222 Phase 1: resolved docs directories — the layer-neutral `src/docs-paths.ts`
// module (never `../core/`, which the static guard below forbids).
import { codeReviewDocFileName, docsDirsOf, reqBaseFromRequirementDoc } from "../docs-paths";
import { probeAgentState, anyTopLevelRunning } from "./subagents-introspect";
import { scanActiveSpawnEvidence, type SpawnEvidenceHit } from "./spawn-evidence";
import { checkDispatchConflicts } from "./guard-conflict-report";
import {
  DEFAULT_SPAWN_WAIT_TIMEOUT_MS,
  DEFERRED_SPAWN_POLL_INTERVAL_MS,
  RESUMABLE_STAGES,
} from "../constants";
// 210 Phase 2: idle-clock renewal on dispatch success (requirement 5.4 whitelist).
// Routed through the leaf sink because this module must not import `core/` at
// runtime (static guard: subagent-rpc.test.ts, Phase 0 / 189).
import { reportStageProgress } from "./stage-progress-sink";
import type { PendingSpawnEntry, PipelineConfig, PipelineStage, SessionMeta, SpawnOperationContext } from "../types";
import type { FixExecutorCompletedCtx, FixExecutorCompletedHandler } from "../core/fix-executor-completion";
import type { DesignReviewWritePolicy } from "../core/design-review/write-policy";

// ── 217 Phase 1 (T1.2): pending-spawn stall DI hook ──
// utils must not import core at runtime (static guard, Phase 0 / 189), so
// index.ts injects the watchdog arming hook here (same shape as
// `setFixExecutorCompletedHandler`).
type PendingSpawnStallHook = (stage: PipelineStage, requestedAt: number) => void;
let _pendingSpawnStallHook: PendingSpawnStallHook | null = null;
/** 217 F3: registered by index.ts (core owns delivery; utils must not import core). */
export function setPendingSpawnStallHook(hook: PendingSpawnStallHook | null): void { _pendingSpawnStallHook = hook; }

// 218 Phase 1 (T1.3): same seam as `setPendingSpawnStallHook` —
// utils must NOT import ../core at runtime (the static guard in
// `src/__tests__/utils/subagent-rpc.test.ts` scans every non-`import type`
// line for "../core/" and fails). The enqueue-side owner wake is delivered
// through the dedupe entry installed by `src/index.ts`.
export interface OwnerWakeOnceReport { delivered: boolean; via: string; deduped: boolean }
type OwnerWakeOnceHook = (stage: PipelineStage, reason: "enqueue") => OwnerWakeOnceReport;
let _ownerWakeOnceHook: OwnerWakeOnceHook | null = null;
export function setOwnerWakeOnceHook(hook: OwnerWakeOnceHook | null): void { _ownerWakeOnceHook = hook; }

// Module-level cache for lazy import of ../core/design-review/write-policy
// (Cannot use static import due to circular dependency guard test)
let _writePolicyModule: Promise<typeof import("../core/design-review/write-policy")> | null = null;

async function getWritePolicyModule(): Promise<typeof import("../core/design-review/write-policy")> {
  if (!_writePolicyModule) {
    _writePolicyModule = import("../core/design-review/write-policy");
  }
  return _writePolicyModule;
}

// 226 review round 2 (issue 2): same lazy-import discipline for the deferred
// clarify round's delivery fact. `utils` must not import `../core` at load time
// (static guard), but the dequeue is the ONLY place that knows a queued clarify
// round really went out — so the promotion is loaded on demand.
let _clarifyQueueFactModule: Promise<typeof import("../core/auto-pipeline/clarify-queue-fact")> | null = null;

async function getClarifyQueueFactModule(): Promise<typeof import("../core/auto-pipeline/clarify-queue-fact")> {
  if (!_clarifyQueueFactModule) {
    _clarifyQueueFactModule = import("../core/auto-pipeline/clarify-queue-fact");
  }
  return _clarifyQueueFactModule;
}

/**
 * Promote a queued finalisation round after a REAL dequeue spawn.
 *
 * Best effort: the round already went out, so a bookkeeping failure is audited
 * (`warn`) and never unwinds the spawn.
 */
async function noteQueuedClarifyDelivered(config: PipelineConfig, meta: SessionMeta): Promise<void> {
  try {
    const { promoteClarifyQueuedFinalisation } = await getClarifyQueueFactModule();
    await promoteClarifyQueuedFinalisation(config, meta.requirementDoc ?? null);
  } catch (err) {
    await safeWriteAuditLog("clarify_queue_fact_failed", {
      pipelineId: meta.pipelineId,
      stage: "clarify",
      error: String(err),
    }, "warn");
  }
}

/**
 * Phase 2 / 177 (D4⑥): Extracts the current session file from a runtime context
 * for audit correlation. Mirrors the 171 precedent (`tool_rejected_frozen`).
 *
 * Fail-safe: returns undefined when the context shape does not expose it.
 *
 * @param runtimeCtx - Raw runtime context (structural)
 * @returns Session file path, or undefined
 */
function extractSessionFile(runtimeCtx: unknown): string | undefined {
  const sm = (runtimeCtx as { _ctx?: { sessionManager?: { getSessionFile?: () => string } } } | undefined)
    ?._ctx?.sessionManager;
  return sm?.getSessionFile?.();
}

// 203_Bug Phase 0: EventBus/PiWithEvents/hasEventBus moved to the shared
// "./pi-event-bus" module (single source). The imported type guard keeps the
// same call-site narrowing behavior for `pi.events` access.
import { hasEventBus } from "./pi-event-bus";

/**
 * Generates a unique request ID for RPC correlation.
 */
function generateRequestId(): string {
  return `rpc-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Pings the pi-subagents extension to check availability.
 *
 * Sends "subagents:rpc:ping" and waits for a reply on the reply channel.
 * Returns true if a valid pong is received within timeout, false otherwise.
 *
 * @param pi - Extension API with events bus
 * @param timeoutMs - Maximum wait time in milliseconds (default 500)
 * @returns True if subagents extension is available
 */
export async function pingSubagents(
  pi: unknown,
  timeoutMs = 500,
): Promise<boolean> {
  if (!hasEventBus(pi)) return false;

  const requestId = generateRequestId();
  const replyChannel = `subagents:rpc:ping:reply:${requestId}`;

  return new Promise<boolean>((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // Clean up the reply-channel listener on timeout to avoid leak
        if (pi.events.off) {
          pi.events.off(replyChannel, replyHandler);
        }
        resolve(false);
      }
    }, timeoutMs);

    const replyHandler = (payload: unknown): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Self-unregister after first reply to avoid leak on reply channel
      if (pi.events.off) {
        pi.events.off(replyChannel, replyHandler);
      }

      // Envelope-tolerant: accept {success:true} or {success:true,data:{version:2}}
      const env = payload as Record<string, unknown> | undefined;
      if (env && (env as Record<string, unknown>).success === true) {
        resolve(true);
      } else {
        resolve(false);
      }
    };

    try {
      pi.events.on(replyChannel, replyHandler);

      pi.events.emit("subagents:rpc:ping", { requestId });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        // Clean up the reply-channel listener on error to avoid leak
        if (pi.events.off) {
          pi.events.off(replyChannel, replyHandler);
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        safeWriteAuditLog("subagent_rpc", {
          action: "ping", outcome: "error", error: errMsg,
        }, "warn").catch(() => {});
        resolve(false);
      }
    }
  });
}

/**
 * Spawns a clarify subagent via RPC.
 *
 * Emits "subagents:rpc:spawn" and waits for a reply on the reply channel.
 * Returns the subagent ID on success, or an error message on failure.
 *
 * @param pi - Extension API with events bus
 * @param req - Spawn request parameters
 * @returns { ok: true, id } on success, { ok: false, error } on failure
 */
export async function spawnClarifySubagent(
  pi: unknown,
  req: { agentName: string; prompt: string; description?: string },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!hasEventBus(pi)) {
    return { ok: false, error: "no_event_bus" };
  }

  const requestId = generateRequestId();
  const replyChannel = `subagents:rpc:spawn:reply:${requestId}`;
  const SPAWN_TIMEOUT_MS = 5000;

  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // Clean up the reply-channel listener on timeout to avoid leak
        if (pi.events.off) {
          pi.events.off(replyChannel, replyHandler);
        }
        safeWriteAuditLog("subagent_rpc", {
          action: "spawn", outcome: "timeout", requestId, agentName: req.agentName,
        }, "warn").catch(() => {});
        resolve({ ok: false, error: "spawn_timeout" });
      }
    }, SPAWN_TIMEOUT_MS);

    const replyHandler = (payload: unknown): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Self-unregister after first reply to avoid leak on reply channel
      if (pi.events.off) {
        pi.events.off(replyChannel, replyHandler);
      }

      const env = payload as Record<string, unknown> | undefined;
      if (!env) {
        resolve({ ok: false, error: "empty_reply" });
        return;
      }

      if (env.success === true) {
        // Extract id from {success:true, data:{id:"..."}}
        const data = env.data as Record<string, unknown> | undefined;
        const id = data?.id as string | undefined;
        if (id) {
          resolve({ ok: true, id });
        } else {
          resolve({ ok: false, error: "missing_id_in_reply" });
        }
      } else if (env.success === false) {
        const error = (env.error as string) || "spawn_rejected";
        resolve({ ok: false, error });
      } else {
        resolve({ ok: false, error: "unexpected_envelope" });
      }
    };

    try {
      pi.events.on(replyChannel, replyHandler);

      // Phase 2 / 177 (D4): `run_in_background` was removed — it is an Agent-tool
      // parameter that the RPC silently ignored (spawn is already detached).
      // The RPC handshake latency is bounded by SPAWN_TIMEOUT_MS.
      pi.events.emit("subagents:rpc:spawn", {
        requestId,
        type: req.agentName,
        prompt: req.prompt,
        options: {
          ...(req.description ? { description: req.description } : {}),
        },
      });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        // Clean up the reply-channel listener on error to avoid leak
        if (pi.events.off) {
          pi.events.off(replyChannel, replyHandler);
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        safeWriteAuditLog("subagent_rpc", {
          action: "spawn", outcome: "error", error: errMsg,
        }, "warn").catch(() => {});
        resolve({ ok: false, error: errMsg });
      }
    }
  });
}

/**
 * Watches for subagent lifecycle events (completed/failed).
 * Best-effort: logs outcomes via audit, never throws.
 *
 * Includes a defensive timeout that auto-unregisters listeners after `timeoutMs`
 * to prevent unbounded accumulation across repeated spawns (defaults to 30min).
 *
 * @param pi - Extension API with events bus
 * @param requestId - The spawn request ID to correlate
 * @param onEvent - Callback for lifecycle events
 * @param opts - Optional timeout guard (timeoutMs defaults to LIFECYCLE_LISTENER_TIMEOUT_MS)
 * @returns Cleanup function to unregister listeners
 */
export function watchSubagentLifecycle(
  pi: unknown,
  requestId: string,
  onEvent: (event: "completed" | "failed", payload: unknown) => void,
  opts?: { timeoutMs?: number },
): () => void {
  if (!hasEventBus(pi)) return () => {};

  let cleanedUp = false;
  const cleanupFn = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timeoutHandle);
    if (pi.events.off) {
      pi.events.off("subagents:completed", completedHandler);
      pi.events.off("subagents:failed", failedHandler);
    }
  };

  const completedHandler = (payload: unknown): void => {
    const env = payload as Record<string, unknown> | undefined;
    if (env?.id === requestId || env?.requestId === requestId) {
      onEvent("completed", payload);
      safeWriteAuditLog("subagent_lifecycle", {
        requestId, event: "completed",
      }).catch(() => {});
      cleanupFn();
    }
  };

  const failedHandler = (payload: unknown): void => {
    const env = payload as Record<string, unknown> | undefined;
    if (env?.id === requestId || env?.requestId === requestId) {
      onEvent("failed", payload);
      safeWriteAuditLog("subagent_lifecycle", {
        requestId, event: "failed",
      }, "warn").catch(() => {});
      cleanupFn();
    }
  };

  pi.events.on("subagents:completed", completedHandler);
  pi.events.on("subagents:failed", failedHandler);

  // Defensive timeout: auto-unregister listeners if no terminal event arrives.
  // Prevents accumulation of zombie handlers across repeated spawns.
  const timeoutMs = opts?.timeoutMs ?? LIFECYCLE_LISTENER_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => {
    safeWriteAuditLog("subagent_lifecycle_timeout", {
      requestId, timeoutMs: String(timeoutMs),
    }, "info").catch(() => {});
    cleanupFn();
  }, timeoutMs);

  // Return cleanup function
  return cleanupFn;
}

// ─── Stage Subagent Spawn (168 Phase 4) ──────────────────────────────────────

/**
 * Defensive timeout for lifecycle listener auto-cleanup.
 * If a subagent neither completes nor fails within this window, the listener
 * is unregistered to prevent unbounded accumulation across repeated spawns.
 * Default: 30 minutes.
 */
const LIFECYCLE_LISTENER_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolves the agent name for a given stage from its agentPath configuration.
 *
 * Reads the agent file and extracts the `name` field from YAML frontmatter.
 * Falls back to the file basename (without .md) when frontmatter is absent.
 * Returns null when the file is unreadable or agentPath is not configured.
 *
 * 168 Phase 4: Migrated from pipeline-start.ts to enable reuse by
 * spawnStageSubagent for any stage (not just clarify).
 *
 * @param config - Pipeline configuration
 * @param stage - The stage to resolve agent name for
 * @returns Agent name string, or null if unresolvable
 */
export function resolveAgentMention(
  config: PipelineConfig,
  stage: PipelineStage,
): string | null {
  const stageConfig = config.stages[stage];
  if (!stageConfig?.agentPath) return null;

  const agentFilePath = path.join(config.projectRoot, stageConfig.agentPath);

  // Read agent file — distinguish file-missing/unreadable (return null so
  // the caller falls back to notify) from file-exists-but-no-frontmatter
  // (basename fallback is still safe to inject).
  let content: string;
  try {
    content = fs.readFileSync(agentFilePath, "utf-8");
  } catch {
    // File unreadable / missing → null (caller does notify fallback, no inject)
    return null;
  }

  // Parse YAML frontmatter: ^---\n...\n---
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fmBody = fmMatch[1];
    const nameMatch = fmBody.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      return nameMatch[1].trim();
    }
  }

  // File exists but no frontmatter name → basename fallback (safe to inject)
  return path.basename(stageConfig.agentPath, ".md");
}

/**
 * Checks whether a stage is eligible for automatic subagent spawning.
 *
 * Spawnability is a property of the stage machine: an enterable stage is
 * spawnable iff its executor is configured. The old hand-written list drifted
 * from this fact and silently blocked the clarify executor (226_Bug).
 *
 * @param config - Pipeline configuration
 * @param stage - The stage to check
 * @returns True if the stage can be auto-spawned
 */
export function isSpawnableStage(
  config: PipelineConfig,
  stage: PipelineStage,
): boolean {
  // RESUMABLE_STAGES excludes the terminal pseudo-stages, which must never be
  // spawn targets even when a config entry exists (test fixtures configure all).
  return RESUMABLE_STAGES.includes(stage) && !!config.stages[stage]?.agentPath;
}

/**
 * Minimal pi interface for sendUserMessage with deliverAs option.
 * SDK signature: sendUserMessage(msg, { deliverAs?: "steer" | "followUp" })
 */
interface PiWithSend {
  sendUserMessage: (msg: string, opts?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }) => void;
}

/**
 * Type guard for pi with sendUserMessage.
 */
function hasSendUserMessage(pi: unknown): pi is PiWithSend {
  return !!pi && typeof (pi as PiWithSend).sendUserMessage === "function";
}

/**
 * Session interface for the idempotency guard.
 * When provided, spawnStageSubagent reads/writes spawnedStages in meta.
 * 192 Phase 1: may also expose the strict commit interface — operation-aware
 * design-review spawns REQUIRE it (fail-closed).
 */
interface SpawnSession {
  getMeta: () => SessionMeta | undefined;
  updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  updateMetaVerified?: import("../core/session-state").StrictCommitSession["updateMetaVerified"];
}

// ─── Design-review operation terminal handler registry (192 Phase 1, task 8) ──

/**
 * 192 Phase 1: terminal lifecycle evidence for a design-review operation,
 * routed to the OWNER (child sessions never finalize operations themselves).
 */
export interface DesignReviewTerminalEvent {
  /** The operation this spawn was bound to */
  operationContext: SpawnOperationContext;
  /** Lifecycle event */
  event: "completed" | "failed";
  /** Trusted subagent id from the RPC reply */
  agentId?: string;
}

export type DesignReviewTerminalHandler = (
  pi: unknown,
  config: PipelineConfig,
  session: SpawnSession,
  evt: DesignReviewTerminalEvent,
) => Promise<void>;

/**
 * Module-level handler registered by the composition root (`index.ts`),
 * mirroring the `setFixExecutorCompletedHandler` precedent. When null the
 * lifecycle callback only performs conditional cleanup — no second dispatch,
 * no fabricated completion.
 */
let designReviewTerminalHandler: DesignReviewTerminalHandler | null = null;

/**
 * Register the design-review operation-terminal handler. Pass null to
 * unregister (test cleanup).
 */
export function setDesignReviewTerminalHandler(handler: DesignReviewTerminalHandler | null): void {
  designReviewTerminalHandler = handler;
}

/**
 * Test-only: peek the currently registered design-review terminal handler.
 * @internal Exported for unit testing only
 */
export function __peekDesignReviewTerminalHandler(): DesignReviewTerminalHandler | null {
  return designReviewTerminalHandler;
}

// ─── Fix-executor-completion handler registry (Phase 0 / 189 DI) ─────────────

/**
 * Module-level handler for fix-executor completion events.
 *
 * Registered by the composition root (`index.ts`) via `setFixExecutorCompletedHandler`.
 * When null (handler not registered), the lifecycle callback silently skips the
 * fix-completion handler invocation. Production path always registers via `createPipeline`.
 *
 * Idempotent: overwriting with a new handler is safe (handler is stateless).
 */
let fixExecutorCompletedHandler: FixExecutorCompletedHandler | null = null;

/**
 * Registers the handler invoked when a fix-stage subagent completes.
 *
 * Called by the composition root (`createPipeline` factory) to wire
 * `handleFixExecutorCompleted` from `core/fix-executor-completion.ts`.
 * Pass `null` to unregister (test cleanup).
 *
 * @param handler - The handler function, or null to clear
 */
export function setFixExecutorCompletedHandler(handler: FixExecutorCompletedHandler | null): void {
  fixExecutorCompletedHandler = handler;
}

/**
 * Test-only: returns the currently registered handler (or null).
 * Used by composition-root tests to assert the wiring occurred.
 *
 * @internal Exported for unit testing only
 */
export function __peekFixExecutorCompletedHandler(): FixExecutorCompletedHandler | null {
  return fixExecutorCompletedHandler;
}

// Re-export types for downstream consumers (e.g., composition root, tests)
export type { FixExecutorCompletedCtx, FixExecutorCompletedHandler };

/**
 * 192 Phase 1: dispatch outcome taxonomy for operation-aware spawns.
 * Only meaningful together with `operationContext`; ordinary spawns may leave
 * it undefined (backward compatible).
 */
export type StageDispatchOutcome =
  /** RPC returned a trusted agentId */
  | "spawned_id"
  /** followUp fallback delivered but no agentId exists — outcome unknown, verify */
  | "fallback_no_id"
  /** deferred: live same-agent twin, queued in pendingSpawns, watcher armed */
  | "deferred"
  /** child context: routed to owner pendingSpawns queue */
  | "queued_owner"
  /** provably NOT dispatched (transport rejection/unavailable) — retryable */
  | "not_sent"
  /** RPC timeout/ambiguous envelope — window unknown, must NOT auto re-dispatch */
  | "unknown"
  /** strict identity/commit check failed BEFORE any external call — zero RPC */
  | "strict_blocked"
  /** duplicate guard: this exact operation was already dispatched */
  | "skipped_duplicate"
  /** 195 Phase 2: configuration conflict (read-only ∩ write / empty write scope) blocks spawn */
  | "conflict_blocked";

/**
 * Spawns a subagent for the given stage after stage transition.
 *
 * Three-tier dispatch (mirrors clarify auto-launch pattern):
 * 1. Non-spawnable stage → audit stage_spawn_skipped (reason=stage_not_spawnable)
 *    + return { spawned: false } immediately
 * 2. Idempotency guard: if session provided and spawnedStages[stage] === stageStartTime
 *    → audit stage_spawn_skipped reason=duplicate_spawn_guarded, return { spawned: false }
 * 3. resolveAgentMention fails → notify + audit stage_spawn_skipped
 * 4. RPC path (hasEventBus + availability latch): spawn → audit stage_spawn_rpc + watch lifecycle
 * 5. Fallback: sendUserMessage with deliverAs:"followUp" + notify + audit stage_spawn_fallback
 *
 * On success (RPC or fallback), writes the guard: spawnedStages[stage] = stageStartTime.
 * When session is not provided, the guard is skipped (backward compatible).
 *
 * 192 Phase 1 (F01/F04) additions:
 * - opts.exactPrompt replaces the composed generic prompt verbatim (used by
 *   design-review update dispatch where the rendered YAML prompt is the input).
 * - opts.description overrides the composed spawn description.
 * - opts.operationContext binds the spawn to a design-review operation:
 *   fresh identity is checked before any external call; the reserved guard
 *   write must succeed strictly (otherwise ZERO RPC); the duplicate guard
 *   compares the CURRENT operation so a same-millisecond new operation is not
 *   swallowed by the old stamp; results carry the real agentId and an
 *   explicit dispatchOutcome; ambiguous RPC windows do NOT fall through to a
 *   parallel second dispatch channel.
 *
 * @param pi - pi SDK ExtensionAPI handle
 * @param config - Pipeline configuration
 * @param stage - Target stage to spawn subagent for
 * @param meta - Current session metadata
 * @param opts - Optional UI notify handle, session for idempotency guard,
 *   extraArgs, runtimeCtx (for sessionFile audit correlation), exactPrompt,
 *   description and operationContext
 * @returns { spawned, fallback, deferred?, agentId?, dispatchOutcome? }
 *   indicating outcome. `deferred` is true when a live same-agent child in
 *   another stage postponed the spawn.
 */
export async function spawnStageSubagent(
  pi: unknown,
  config: PipelineConfig,
  stage: PipelineStage,
  meta: SessionMeta,
  opts?: {
    ui?: { notify: (msg: string) => void };
    session?: SpawnSession;
    extraArgs?: string;
    runtimeCtx?: unknown;
    /** 192 Phase 1: use this prompt verbatim instead of the composed text */
    exactPrompt?: string;
    /** 192 Phase 1: override the spawn description */
    description?: string;
    /** 192 Phase 1: design-review operation identity to bind this spawn to */
    operationContext?: SpawnOperationContext;
  },
): Promise<{
  spawned: boolean;
  fallback: boolean;
  deferred?: boolean;
  /** Trusted subagent id — only set when the RPC reply carried a real id */
  agentId?: string;
  /** 192 Phase 1: explicit outcome taxonomy (only for operation-aware spawns) */
  dispatchOutcome?: StageDispatchOutcome;
  /**
   * 216 P2 (F2): the child context routed this spawn to the OWNER queue
   * (`pendingSpawns`) instead of spawning in place. UNCONDITIONAL signal —
   * set even without an `operationContext`, so the auto-advance chain can
   * skip the child wake without touching the 192 dispatchOutcome semantics.
   */
  queuedForOwner?: boolean;
}> {
  // 1. Non-spawnable stage → skip (audited: a silent early-exit hid clarify
  // dispatch failures from the audit trail — 226_Bug).
  if (!isSpawnableStage(config, stage)) {
    await safeWriteAuditLog("stage_spawn_skipped", {
      pipelineId: meta.pipelineId,
      stage,
      reason: "stage_not_spawnable",
    });
    return {
      spawned: false,
      fallback: false,
      ...(opts?.operationContext ? { dispatchOutcome: "not_sent" as StageDispatchOutcome } : {}),
    };
  }

  // 2. Idempotency guard: skip if already spawned for this visit
  if (opts?.session) {
    const freshMeta = opts.session.getMeta();
    if (freshMeta && freshMeta.spawnedStages?.[stage] === freshMeta.stageStartTime) {
      // 192 Phase 1: operation-aware duplicate check. With an
      // operationContext the guard only fires for the SAME operation id —
      // a new operation at the same millisecond/visit must not be swallowed
      // by the old stamp (the time gate keeps protecting ordinary paths).
      if (opts.operationContext) {
        const existingEntry = freshMeta.activeSpawns?.[stage];
        const sameOperation =
          existingEntry?.operationContext?.operationId === opts.operationContext.operationId;
        if (sameOperation) {
          await safeWriteAuditLog("stage_spawn_skipped", {
            pipelineId: meta.pipelineId,
            stage,
            reason: "duplicate_operation_spawn_guarded",
            operationId: opts.operationContext.operationId,
          });
          return { spawned: false, fallback: false, dispatchOutcome: "skipped_duplicate" };
        }
        // Different (or untracked) operation for the same visit stamp: the
        // time-based guard does not apply — continue to dispatch for the
        // CURRENT operation. Ordinary path (no operationContext) below.
      } else {
        // Phase 2 / 175 (R1Q5A/R2Q5A): check if there's a reserved in-flight spawn (<60s)
        const existingSpawn = freshMeta.activeSpawns?.[stage];
        if (existingSpawn?.reserved && (Date.now() - existingSpawn.startedAt) < 60_000) {
          await safeWriteAuditLog("stage_spawn_skipped", {
            pipelineId: meta.pipelineId,
            stage,
            reason: "spawn_in_flight",
          });
        } else {
          await safeWriteAuditLog("stage_spawn_skipped", {
            pipelineId: meta.pipelineId,
            stage,
            reason: "duplicate_spawn_guarded",
          });
        }
        return { spawned: false, fallback: false };
      }
    }
  }

  // 195 Phase 2: Configuration conflict fail-fast check
  // Uses static import for checkDispatchConflicts (sibling module) and cached
  // lazy import for ../core/design-review/write-policy (circular dependency guard)
  const writePolicyModule = await getWritePolicyModule();
  const conflictResult = await checkDispatchConflicts(
    stage,
    meta,
    config.stages?.[stage]?.allowedReadOnlyPaths,
    config.stages?.[stage]?.allowedWritePaths,
    () => writePolicyModule.resolveDesignReviewWritePolicy(meta),
    (policy) => writePolicyModule.describeWriteScope(policy as DesignReviewWritePolicy),
    // 222 Phase 2: the probed deliverable path follows the configured layout.
    docsDirsOf(config).designDir,
  );
  
  if (conflictResult) {
    // Notify UI with conflict report
    if (opts?.ui?.notify) {
      opts.ui.notify(conflictResult.report);
    }
    // Audit the conflict block
    await safeWriteAuditLog("dispatch_conflict_blocked", {
      pipelineId: meta.pipelineId,
      stage,
      conflictType: conflictResult.conflictType,
    });
    return {
      spawned: false,
      fallback: false,
      dispatchOutcome: "conflict_blocked" as StageDispatchOutcome,
    };
  }

  // G2 (188): Gate defer guard — do not spawn when confirm gate is in deferred
  // state for this stage. Prevents duplicate spawn when the plan subagent's
  // settle triggers a re-spawn while the confirm gate dialog is still deferred.
  if (opts?.session) {
    const freshMeta = opts.session.getMeta();
    if (freshMeta?.confirmGateDeferredAt?.stage === stage) {
      await safeWriteAuditLog("stage_spawn_skipped", {
        pipelineId: meta.pipelineId,
        stage,
        reason: "confirm_gate_deferred",
      });
      return {
        spawned: false,
        fallback: false,
        ...(opts.operationContext ? { dispatchOutcome: "not_sent" as StageDispatchOutcome } : {}),
      };
    }
  }

  // 3. Resolve agent name from config
  const agentName = resolveAgentMention(config, stage);
  if (!agentName) {
    opts?.ui?.notify?.(`No agent configured for stage "${stage}". Please start manually.`);
    await safeWriteAuditLog("stage_spawn_skipped", {
      pipelineId: meta.pipelineId,
      stage,
      reason: "agentName_unresolvable",
    });
    return {
      spawned: false,
      fallback: false,
      ...(opts?.operationContext ? { dispatchOutcome: "not_sent" as StageDispatchOutcome } : {}),
    };
  }

  // 3b. Phase 2 / 177 (D4③): child/clone contexts must not spawn in place.
  // Enqueue for the owner session, which consumes pendingSpawns on agent_settled.
  if (opts?.session && isChildRuntimeCtx(opts.runtimeCtx)) {
    enqueuePendingSpawn(opts.session, stage, agentName, opts.extraArgs, opts.operationContext);
    // 217 Phase 1 (F3): arm the one-shot stall watchdog for this enqueue.
    _pendingSpawnStallHook?.(stage, opts.session.getMeta()?.pendingSpawns?.[stage]?.requestedAt ?? Date.now());
    await safeWriteAuditLog("stage_spawn_routed_to_owner", {
      pipelineId: meta.pipelineId,
      stage,
      agentName,
      ...(extractSessionFile(opts.runtimeCtx) ? { sessionFile: extractSessionFile(opts.runtimeCtx)! } : {}),
    });

    // 218 R10 / Q18-A: wake the owner IMMEDIATELY instead of waiting for the 120s
    // stall watchdog. Fail-open: a missing hook / failed delivery never blocks the
    // enqueue (the watchdog stays as the last resort).
    const wake = _ownerWakeOnceHook?.(stage, "enqueue");
    await safeWriteAuditLog(wake ? "pending_spawn_wake_delivered" : "pending_spawn_wake_unavailable", {
      pipelineId: meta.pipelineId, stage,
      delivered: String(wake?.delivered ?? false), via: wake?.via ?? "hook_unregistered",
      deduped: String(wake?.deduped ?? false),
    });
    return {
      spawned: false,
      fallback: false,
      // 216 P2 (F2): unconditional — the chain must know NO child wake may fire.
      queuedForOwner: true,
      ...(opts?.operationContext ? { dispatchOutcome: "queued_owner" as StageDispatchOutcome } : {}),
    };
  }

  // 3c. Phase 2 / 179 (G3): wait-and-settle pre-check.
  // If a same-agent subagent in ANOTHER stage is still live, defer this spawn
  // instead of creating a cross-stage twin.
  if (await maybeDeferSpawnForLiveTwin(pi, config, stage, agentName, meta, opts)) {
    return {
      spawned: false,
      fallback: false,
      deferred: true,
      ...(opts?.operationContext ? { dispatchOutcome: "deferred" as StageDispatchOutcome } : {}),
    };
  }

  // Phase 1 (169): spawn prompt includes requirementDoc pointer for context passing
  const reqDocHint = meta.requirementDoc ?? "(unset)";
  // Phase 2 / 177 (D4⑥): sessionFile for audit correlation (171 precedent).
  const sessionFile = extractSessionFile(opts?.runtimeCtx);
  // 192 Phase 1: exactPrompt wins verbatim (design-review update dispatch must
  // send exactly the rendered configuration prompt, nothing composed).
  let prompt = opts?.exactPrompt !== undefined
    ? opts.exactPrompt
    : `Begin the ${stage} stage work now. Pipeline: ${meta.pipelineId ?? ""}. Requirement doc: ${reqDocHint} — read it first (contains clarification conclusions)`;
  if (opts?.exactPrompt === undefined && opts?.extraArgs) {
    // Phase 3 (171) High B: append extraArgs (User focus) when provided by caller
    prompt += opts.extraArgs;
  }
  // Phase 7 (188) G8 / 192 Phase 1: description override support.
  // 225 Phase 2 (T5): only REVIEW allocates/advances the round (retry-safe);
  // fix reads `meta.reviewRound` inside the resolver — caller never picks a round.
  const round = stage === "review"
    ? ensureReviewRound(meta, opts?.session as { updateMeta(patch: Partial<SessionMeta>): unknown } | undefined, Date.now())
    : undefined;
  let description = opts?.description ?? `${stage}: ${meta.requirementDoc ?? ""}`;
  let targetDoc: Awaited<ReturnType<typeof resolveStageTargetDoc>> | undefined;
  if (opts?.exactPrompt === undefined) {
    // D4: description and prompt point at the SAME target document (one resolver).
    // Computed even when `opts.description` overrides the TUI text — the prompt
    // target line stays同源 for every ordinary dispatch.
    targetDoc = await resolveStageTargetDoc(config, meta, { reviewRound: round });
    if (opts?.description === undefined && targetDoc.path) {
      description = `${stage}: ${targetDoc.path}`;
    }
  }
  if (opts?.exactPrompt === undefined && targetDoc?.path && targetDoc.source !== "requirement") {
    // Same-source prompt target for the D4 TARGET stages only; requirement
    // dispatches (clarify etc.) keep their verbatim baseline behaviour.
    prompt += `\n\nTarget document: ${targetDoc.path} — read it first; do not glob or guess another round's file.`;
    if (stage === "review" && round) {
      const reviewDir = docsDirsOf(config).reviewDir;
      prompt += `\nExpected report: ${reviewDir.replace(/\/+$/, "")}/${codeReviewDocFileName(reqBaseFromRequirementDoc(meta.requirementDoc ?? ""), round.index)} (write exactly this path).`;
    }
  }

  /** Helper to write the idempotency guard + activeSpawns entry after successful spawn */
  const writeGuard = async (subagentId?: string): Promise<void> => {
    if (!opts?.session) return;
    const currentMeta = opts.session.getMeta();
    if (!currentMeta) return;
    const patch: Partial<SessionMeta> = {
      spawnedStages: {
        ...(currentMeta.spawnedStages ?? {}),
        [stage]: currentMeta.stageStartTime,
      },
    };
    // Phase 4 (171) High A: write activeSpawns entry for in-run probe.
    // review#2 Low: only write when we have a recorded agentId; fallback channel
    // (sendUserMessage) has no agentId — writing an entry without agentId would
    // hang in activeSpawns up to 30min (no lifecycle listener on fallback) and
    // cause false-positive blocks via the time-based check.
    // 192 Phase 1: operationContext rides along so cleanup/callbacks can be
    // bound to the operation identity.
    if (subagentId) {
      patch.activeSpawns = {
        ...(currentMeta.activeSpawns ?? {}),
        [stage]: {
          agentName,
          agentId: subagentId,
          startedAt: Date.now(),
          ...(opts.operationContext ? { operationContext: opts.operationContext } : {}),
        },
      };
    }
    // 225 Phase 2 (T5): same-turn dispatch marker for the review exit gate.
    // NOT gated on subagentId — the fallback channel has no agentId, so the
    // gate's probe evidence is empty there and only this marker identifies a
    // just-dispatched executor. Cleared on first consumption (Phase 3).
    if (stage === "review") {
      patch.reviewDispatchedAt = { stageStartTime: currentMeta.stageStartTime, at: Date.now() };
    }
    opts.session.updateMeta(patch);
  };

  /** Helper to clear activeSpawns entry on lifecycle settle (delegates to shared utility) */
  const clearActiveSpawn = (): void => {
    if (!opts?.session) return;
    // 192 Phase 1: conditional cleanup — when bound to an operation/agent id,
    // only delete the entry that actually matches. A late callback from a
    // superseded operation must not wipe the CURRENT spawn record.
    clearActiveSpawnRecord(
      opts.session,
      stage,
      opts.operationContext || subagentIdForCleanup
        ? {
            ...(opts.operationContext ? { operationId: opts.operationContext.operationId } : {}),
            ...(subagentIdForCleanup ? { agentId: subagentIdForCleanup } : {}),
          }
        : undefined,
    );
  };

  /** Agent id captured on the RPC success path (scoped for the cleanup closure) */
  let subagentIdForCleanup: string | undefined;

  /** Helper to write the reserved placeholder (strict when operation-bound) */
  const writeReserved = (): void => {
    if (!opts?.session) return;
    const currentMeta = opts.session.getMeta();
    if (!currentMeta) return;
    // Only write if no existing entry (avoid overwriting a live spawn)
    if (currentMeta.activeSpawns?.[stage]?.agentId) return;
    const entry = {
      agentName,
      startedAt: Date.now(),
      reserved: true,
      ...(opts.operationContext ? { operationContext: opts.operationContext } : {}),
    };
    opts.session.updateMeta({
      activeSpawns: {
        ...(currentMeta.activeSpawns ?? {}),
        [stage]: entry,
      },
    });
  };

  /**
   * 192 Phase 1: strict reserved write for operation-bound spawns.
   * Requires the session's strict interface, a fresh identity match against
   * the CURRENT design-review operation, and a persisted commit — otherwise
   * NO external call may happen (fail-closed before RPC).
   */
  const writeReservedStrict = (): boolean => {
    const oc = opts?.operationContext;
    const session = opts?.session;
    if (!oc || !session) return true;
    if (typeof session.updateMetaVerified !== "function") {
      void safeWriteAuditLog("stage_spawn_strict_blocked", {
        pipelineId: oc.pipelineId,
        stage,
        operationId: oc.operationId,
        reason: "adapter_lacks_strict_interface",
      }, "error");
      return false;
    }
    // Fresh identity check: current design-review operation must still be the
    // operation this spawn belongs to (same auth/round/operation).
    const fresh = session.getMeta();
    const dr = fresh?.designReview;
    const op = dr?.operation;
    if (
      !fresh
      || fresh.pipelineId !== oc.pipelineId
      || !dr
      || !op
      || op.operationId !== oc.operationId
      || op.kind !== oc.kind
      || dr.authorizationId !== oc.authorizationId
      || dr.round !== oc.round
    ) {
      void safeWriteAuditLog("stage_spawn_strict_blocked", {
        pipelineId: oc.pipelineId,
        stage,
        operationId: oc.operationId,
        reason: "stale_operation_identity",
        currentOperationId: op?.operationId ?? "none",
        currentRound: String(dr?.round ?? "none"),
      }, "error");
      return false;
    }
    const res = session.updateMetaVerified(
      {
        activeSpawns: {
          ...(fresh.activeSpawns ?? {}),
          [stage]: {
            agentName,
            startedAt: Date.now(),
            reserved: true,
            operationContext: oc,
          },
        },
      },
      {
        pipelineId: oc.pipelineId,
        authorizationId: dr.authorizationId,
        round: dr.round,
        operationId: op.operationId,
        stateUpdatedAt: dr.updatedAt,
      },
    );
    if (res.status !== "persisted") {
      void safeWriteAuditLog("stage_spawn_strict_blocked", {
        pipelineId: oc.pipelineId,
        stage,
        operationId: oc.operationId,
        reason: `reserved_commit_${res.status}`,
        detail: res.reason,
      }, "error");
      return false;
    }
    return true;
  };

  /** Helper to clear reserved flag (on any failure path) */
  const clearReserved = (): void => {
    if (!opts?.session) return;
    const currentMeta = opts.session.getMeta();
    if (!currentMeta) return;
    const existing = currentMeta.activeSpawns?.[stage];
    if (!existing?.reserved) return;
    // Only clear if still reserved (not promoted to real spawn)
    const cleared = { ...currentMeta.activeSpawns };
    delete cleared[stage];
    opts.session.updateMeta({ activeSpawns: cleared });
  };

  // 4. RPC path: availability latch → spawn (Phase 2 / 177 D4).
  // The latch is set by `subagents:ready`; when it is false we skip the ping
  // entirely and fall back immediately (zero dead wait).
  if (hasEventBus(pi) && isSubagentsReady()) {
    // 192 Phase 1: operation-bound spawns use the STRICT reserved write —
    // a failed strict commit means ZERO RPC calls happened.
    if (opts?.operationContext) {
      if (!writeReservedStrict()) {
        return { spawned: false, fallback: false, dispatchOutcome: "strict_blocked" };
      }
    } else {
      // Phase 2 / 175: write reserved before spawn to mark in-flight spawn
      writeReserved();
    }
    const spawnResult = await spawnClarifySubagent(pi, {
      agentName,
      prompt,
      description,
    });

    if (spawnResult.ok) {
      subagentIdForCleanup = spawnResult.id;
      await safeWriteAuditLog("stage_spawn_rpc", {
        pipelineId: meta.pipelineId,
        stage,
        agentName,
        subagentId: spawnResult.id,
        ...(sessionFile ? { sessionFile } : {}),
        ...(opts?.operationContext ? { operationId: opts.operationContext.operationId } : {}),
      });
      // Watch lifecycle (self-unregistering) with timeout guard to prevent leak.
      // On settle: clear activeSpawns entry so duplicate-spawn guard does not misfire.
      const cleanup = watchSubagentLifecycle(pi, spawnResult.id, async (event, _payload) => {
        clearActiveSpawn();
        // Phase 3 (189): auto-unfreeze fix stage on executor completion
        if (stage === "fix" && event === "completed") {
          // Phase 0: invoke registered handler via DI (breaks circular dependency)
          // Handler registered by composition root; silently skip if not registered
          if (fixExecutorCompletedHandler) {
            await fixExecutorCompletedHandler(pi, config, {
              ui: opts?.ui,
              session: opts?.session,
              runtimeCtx: opts?.runtimeCtx,
            });
          }
        }
        // 192 Phase 1 (task 8): design-review operation terminal evidence.
        // The OWNER-routed handler records completion for the CURRENT
        // operation only (fresh identity check inside the handler); children
        // never advance stages here.
        if (opts?.operationContext && designReviewTerminalHandler) {
          await designReviewTerminalHandler(pi, config, opts.session ?? {
            getMeta: () => undefined,
            updateMeta: () => undefined,
          }, {
            operationContext: opts.operationContext,
            event,
            agentId: spawnResult.id,
          });
        }
        cleanup();
      }, { timeoutMs: LIFECYCLE_LISTENER_TIMEOUT_MS });
      await writeGuard(spawnResult.id);
      // 210 Phase 2 (requirement 5.4 whitelist): a successful dispatch is stage
      // progress — renews the idle clock (no-op when no watchdog is armed).
      reportStageProgress(meta.pipelineId, "spawn");
      return {
        spawned: true,
        fallback: false,
        agentId: spawnResult.id,
        ...(opts?.operationContext ? { dispatchOutcome: "spawned_id" as StageDispatchOutcome } : {}),
      };
    }
    // Spawn rejected/failed → log failure reason before falling back
    await safeWriteAuditLog("stage_spawn_rpc_failed", {
      pipelineId: meta.pipelineId,
      stage,
      agentName,
      error: spawnResult.error,
      ...(sessionFile ? { sessionFile } : {}),
    }, "warn");
    // Phase 2 / 175: clear reserved on spawn failure
    clearReserved();
    // 192 Phase 1: for operation-bound spawns an AMBIGUOUS RPC window must
    // not silently fall through to a parallel second dispatch channel.
    // - "spawn_timeout"/"empty_reply"/"unexpected_envelope"/"missing_id_in_reply":
    //   the child may or may not exist → outcome "unknown", verify on resume.
    // - explicit rejection (success:false, e.g. "spawn_rejected"): provably
    //   not dispatched → fall through to the fallback channel is allowed.
    if (opts?.operationContext) {
      const ambiguous = ["spawn_timeout", "empty_reply", "unexpected_envelope", "missing_id_in_reply"].includes(
        spawnResult.error,
      );
      if (ambiguous) {
        await safeWriteAuditLog("stage_spawn_dispatch_unknown", {
          pipelineId: meta.pipelineId,
          stage,
          operationId: opts.operationContext.operationId,
          error: spawnResult.error,
        }, "warn");
        return { spawned: false, fallback: false, dispatchOutcome: "unknown" };
      }
    }
    // Fall through to fallback
  }

  // 5. Fallback: sendUserMessage with deliverAs:"followUp"
  if (hasSendUserMessage(pi)) {
    try {
      // Phase 2 / 177 (D10): `[plugin auto-handoff]` prefix prevents the main-thread
      // model from re-narrating/duplicating the handoff.
      pi.sendUserMessage(`[plugin auto-handoff] @${agentName} ${prompt}`, { deliverAs: "followUp" });
      opts?.ui?.notify?.(`Spawned ${stage} agent via followUp message.`);
      await safeWriteAuditLog("stage_spawn_fallback", {
        pipelineId: meta.pipelineId,
        stage,
        agentName,
        ...(sessionFile ? { sessionFile } : {}),
      });
      await writeGuard();
      // 192 Phase 1 (task 5): the followUp channel HAS no agentId — record
      // "fallback_no_id". Callers must treat this as an unknown outcome for
      // operation-bound dispatches and NEVER fabricate a trusted id.
      // 210 Phase 2: the followUp channel dispatched work as well → idle renewal.
      reportStageProgress(meta.pipelineId, "spawn");
      return {
        spawned: true,
        fallback: true,
        ...(opts?.operationContext ? { dispatchOutcome: "fallback_no_id" as StageDispatchOutcome } : {}),
      };
    } catch {
      // sendUserMessage failure is non-fatal; fall through to notify
    }
  }

  // Final fallback: just notify — provably nothing was dispatched (retryable)
  opts?.ui?.notify?.(`Next: run @${agentName} manually for ${stage} stage.`);
  await safeWriteAuditLog("stage_spawn_fallback", {
    pipelineId: meta.pipelineId,
    stage,
    agentName,
    notify_only: "true",
    ...(sessionFile ? { sessionFile } : {}),
  });
  return {
    spawned: false,
    fallback: false,
    ...(opts?.operationContext ? { dispatchOutcome: "not_sent" as StageDispatchOutcome } : {}),
  };
}

// ─── Owner-routed pending spawns (Phase 2 / 177 D4③/D4④) ────────────────────

/**
 * Bounds idempotent re-delivery: the owner session attempts at most one
 * consumption per pending stage entry.
 */
const PENDING_SPAWN_MAX_ATTEMPTS = 1;

/** Subagent session-name pattern (mirrors session-role.ts). */
const SUBAGENT_NAME_PATTERN = /^[a-z0-9-]+#[0-9a-f]{8}$/;

/**
 * Phase 2 / 177 (D4③): Structural child-session detection for owner routing.
 * Mirrors `detectSessionRole` without importing core (avoids a utils→core cycle).
 *
 * @param runtimeCtx - Raw runtime context (structural)
 * @returns true when the context belongs to a child/clone session
 */
export function isChildRuntimeCtx(runtimeCtx: unknown): boolean {
  const sm = (runtimeCtx as {
    _ctx?: {
      sessionManager?: {
        getHeader?: () => Record<string, unknown> | undefined;
        getSessionName?: () => string;
      };
    };
  } | undefined)?._ctx?.sessionManager;
  if (!sm) return false;
  const parentSession = sm.getHeader?.()?.parentSession;
  const name = sm.getSessionName?.() ?? "";
  return !!parentSession || SUBAGENT_NAME_PATTERN.test(name);
}

/**
 * Phase 2 / 177 (D4③): Enqueues a spawn request for the owner session.
 *
 * Child/clone sessions have no owner `pi` handle or UI, so they must not spawn
 * in place. The owner consumes `pendingSpawns[stage]` on `agent_settled`.
 *
 * Idempotent: re-enqueuing the SAME target (same agent + same operation
 * identity, both absent counts as same) preserves `requestedAt`/`attempts`
 * (216 R6-2).
 * 192 Phase 1 (task 7): when an `operationContext` is provided the entry
 * carries the same identity as the dispatch request; a re-enqueue with a
 * DIFFERENT operation replaces the stale request (exact prompt/source travel
 * with the entry via `extraArgs`).
 *
 * @param session - Session handle exposing meta read/write
 * @param stage - Stage to spawn
 * @param agentName - Resolved agent mention for the stage
 * @param extraArgs - 189 Bug 1: Optional breakpoint prompt for transient re-spawn
 * @param operationContext - 192 Phase 1: design-review operation identity
 */
export function enqueuePendingSpawn(
  session: SpawnSession,
  stage: PipelineStage,
  agentName: string,
  extraArgs?: string,
  operationContext?: SpawnOperationContext,
): void {
  const meta = session.getMeta();
  if (!meta) return;
  const existing = meta.pendingSpawns?.[stage];
  /**
   * 216 P2 (review R6-2, R2-Q4-A + R3-Q2-A): Same queue target: same agent
   * AND same operation identity (both absent counts as same). A re-enqueue of
   * the SAME target keeps BOTH the queue age and the delivery budget.
   * `attempts` stays the "failed deliveries" counter bounded by
   * PENDING_SPAWN_MAX_ATTEMPTS = 1 (subagent-rpc.ts:1091, consume bound at
   * :1321) — incrementing it here would make the owner's first consume hit
   * the bound and silently DROP the entry (`clearPendingSpawn`, no spawn, no
   * audit). R3-Q2-A wins over the §3② wording in 216_Bug.md.
   * 192 semantics unchanged: a DIFFERENT operationId still resets both
   * (replacing the stale request).
   */
  const sameTarget =
    existing !== undefined &&
    existing.agentName === agentName &&
    (existing.operationContext?.operationId ?? null) === (operationContext?.operationId ?? null);
  session.updateMeta({
    pendingSpawns: {
      ...(meta.pendingSpawns ?? {}),
      // 218 Q23-A: the authorization lifecycle is OWNED BY the
      // queue entry. A same-target re-enqueue (child settles again) must not wipe
      // `stalledAt`/`dispatchAuthorizedAt`/`dispatchConsumedAt`, otherwise the stall
      // watchdog's one-shot key (`requestedAt`) never re-fires and the manual
      // one-shot authorization is silently lost for the rest of the queue lifetime.
      [stage]: {
        pipelineId: meta.pipelineId,
        agentName,
        requestedAt: sameTarget ? existing!.requestedAt : Date.now(),
        attempts: sameTarget ? existing!.attempts : 0,
        extraArgs: extraArgs ?? existing?.extraArgs,
        ...(operationContext ? { operationContext } : {}),
        ...(sameTarget
          ? {
              ...(existing!.stalledAt !== undefined ? { stalledAt: existing!.stalledAt } : {}),
              ...(existing!.dispatchAuthorizedAt !== undefined ? { dispatchAuthorizedAt: existing!.dispatchAuthorizedAt } : {}),
              ...(existing!.dispatchConsumedAt !== undefined ? { dispatchConsumedAt: existing!.dispatchConsumedAt } : {}),
            }
          : {}),
      },
    },
  });
}

/**
 * Phase 2 / 177 (D4③): Removes a consumed pendingSpawns entry.
 *
 * 192 Phase 1 (task 7): when `expected` is provided the entry is only deleted
 * if its operationContext still matches — a late callback must NOT delete a
 * queue entry that a NEWER operation has replaced.
 *
 * @param session - Session handle exposing meta read/write
 * @param stage - Stage entry to clear
 * @param expected - Optional identity that must match the entry
 */
export function clearPendingSpawn(
  session: SpawnSession,
  stage: PipelineStage,
  expected?: { operationId?: string },
): void {
  const meta = session.getMeta();
  if (!meta?.pendingSpawns?.[stage]) return;
  const entry = meta.pendingSpawns[stage]!;
  if (expected?.operationId !== undefined) {
    if (entry.operationContext?.operationId !== expected.operationId) {
      // The queue slot now belongs to a DIFFERENT operation — leave it intact.
      return;
    }
  }
  // 203_Bug Phase 1: deletion logic delegated to the shared spawn-cleanup
  // helper (DRY single source for pending-entry removal).
  const next = removePendingSpawnsEntry(meta.pendingSpawns, stage);
  if (next) {
    session.updateMeta({ pendingSpawns: next });
  }
}

/**
 * Phase 0 (186): Clears ALL pendingSpawns entries at once.
 * Used on terminal states (completed / aborted) to prevent stale entries
 * from blocking wakeOwnerOnChainTerminal.
 *
 * @param session - Session handle exposing meta read/write
 */
export function clearAllPendingSpawns(session: SpawnSession): void {
  const meta = session.getMeta();
  if (!meta?.pendingSpawns || Object.keys(meta.pendingSpawns).length === 0) return;
  session.updateMeta({ pendingSpawns: {} });
}

/**
 * Phase 2 / 177 (D4③/D4④): Consumes owner-routed pending spawns.
 *
 * For each pending stage the owner spawns via its own `pi`. Bounded/idempotent:
 * - skipped (and cleared) when the stage was already spawned for this visit
 *   (spawnedStages match — coordinates with the 3c duplicate-spawn guard)
 * - at most PENDING_SPAWN_MAX_ATTEMPTS consumption attempts per stage
 *
 * @param pi - Owner `pi` SDK handle
 * @param config - Pipeline configuration
 * @param meta - Owner session metadata
 * @param opts - UI notify, session handle, and runtimeCtx for sessionFile audit
 * @returns Stages that were successfully spawned/fallback-delivered
 */
export async function consumePendingSpawns(
  pi: unknown,
  config: PipelineConfig,
  meta: SessionMeta,
  opts: { ui?: { notify: (msg: string) => void }; session: SpawnSession; runtimeCtx?: unknown },
  skipStageGuard = false,
): Promise<PipelineStage[]> {
  const pending = meta.pendingSpawns;
  if (!pending) return [];
  const consumed: PipelineStage[] = [];
  const entries = Object.entries(pending) as [
    PipelineStage,
    PendingSpawnEntry,
  ][];

  for (const [stage, entry] of entries) {
    const fresh = opts.session.getMeta();
    if (!fresh?.pendingSpawns?.[stage]) continue;
    const freshEntry = fresh.pendingSpawns[stage]!;

    // Phase 8 (195 Bug): backwards-compatible ownership check
    // Only enforce pipelineId match if both entry and current have pipelineId
    // Legacy entries without pipelineId are treated as compatible
    if (freshEntry.pipelineId && fresh.pipelineId && freshEntry.pipelineId !== fresh.pipelineId) {
      clearPendingSpawn(opts.session, stage, { operationId: freshEntry.operationContext?.operationId });
      await safeWriteAuditLog("pending_spawn_discarded", {
        stage,
        reason: "ownership_mismatch",
        expectedPipelineId: freshEntry.pipelineId,
        currentPipelineId: fresh.pipelineId,
        requestedAt: String(freshEntry.requestedAt),
      });
      continue;
    }

    // 192 Phase 1 (task 7): operation-bound queue entries are consumed ONLY
    // when the CURRENT design-review operation matches the entry identity
    // (authorization/round/kind/operationId). A stale entry cannot trigger a
    // spawn for a new operation, and its cleanup must not delete a newer one.
    if (freshEntry.operationContext) {
      const oc = freshEntry.operationContext;
      const dr = fresh.designReview;
      const op = dr?.operation;
      const identityMatches =
        !!dr
        && !!op
        && op.operationId === oc.operationId
        && op.kind === oc.kind
        && dr.authorizationId === oc.authorizationId
        && dr.round === oc.round
        && fresh.pipelineId === oc.pipelineId;
      if (!identityMatches) {
        clearPendingSpawn(opts.session, stage, { operationId: oc.operationId });
        await safeWriteAuditLog("pending_spawn_discarded", {
          stage,
          reason: "stale_operation_identity",
          operationId: oc.operationId,
          currentOperationId: op?.operationId ?? "none",
          requestedAt: String(freshEntry.requestedAt),
        });
        continue;
      }
    }

    // 187: stage-consistency guard — discard any pending entry whose stage does not
    // match the current pipeline stage. This is the direct-cause fix for the
    // multi-agent spawn bug (Q3 decision: 方案 B — "consume-time stage must match").
    // Phase 4 lifecycle cleanup handles cross-run residue at pipeline entry points
    // (buildStartMeta / buildResumeMeta / executeDecision); this guard catches
    // same-run stage jumps (e.g. choose_stage skipped the pending entry's stage).
    const currentStage = fresh.currentStage;
    // skipStageGuard: set by the deferred-spawn dequeue path (tryDequeue) where the
    // caller has already validated the entry (pending entry exists, old child settled).
    // In that path currentStage may still differ from the pending entry's stage because
    // the stage transition has not yet occurred — the guard would incorrectly discard
    // a legitimate deferred spawn. All other callers (agent-settled consume) must keep
    // the guard to discard stale cross-run / cross-stage residue (187_Bug.md Q3 方案 B).
    if (!skipStageGuard && stage !== currentStage) {
      clearPendingSpawn(opts.session, stage, { operationId: freshEntry.operationContext?.operationId });
      await safeWriteAuditLog("pending_spawn_discarded", {
        stage,
        currentStage,
        agentName: entry.agentName,
        reason: "stale_stage_mismatch",
        requestedAt: String(entry.requestedAt),
      });
      continue;
    }

    // 218 Q23-A: an authorized MANUAL dispatch already happened for this entry.
    // The plugin must NOT dispatch its own twin; drop the entry and audit.
    if (freshEntry.dispatchConsumedAt !== undefined) {
      clearPendingSpawn(opts.session, stage, { operationId: freshEntry.operationContext?.operationId });
      await safeWriteAuditLog("pending_spawn_authorized_consumed", {
        stage, agentName: freshEntry.agentName,
        stalledAt: String(freshEntry.stalledAt ?? ""),
        consumedAt: String(freshEntry.dispatchConsumedAt),
      });
      continue;
    }

    // Already spawned for this visit → nothing to do; drop the pending entry.
    if (fresh.spawnedStages?.[stage] === fresh.stageStartTime) {
      clearPendingSpawn(opts.session, stage, { operationId: freshEntry.operationContext?.operationId });
      continue;
    }

    // Re-delivery bound reached → stop to avoid a settle loop.
    if (entry.attempts >= PENDING_SPAWN_MAX_ATTEMPTS) {
      clearPendingSpawn(opts.session, stage, { operationId: freshEntry.operationContext?.operationId });
      continue;
    }

    // Phase 4 / 177 (D7): clarify has an executor and is spawnable now (226_Bug),
    // but its plugin-contract title is derived differently — keep routing it to
    // the dedicated clarify dispatcher instead of the generic stage path.
    const result = stage === "clarify"
      ? await spawnClarifyStageSubagent(pi, config, fresh, {
          ui: opts.ui,
          session: opts.session,
          runtimeCtx: opts.runtimeCtx,
          // 226 review round 2 (issue 2): the queue entry's OWN args must ride
          // the dispatch — otherwise a deferred round loses `full-und?`/`<n> 答`
          // and its finalisation instruction (the retry would ask nothing).
          ...(freshEntry.extraArgs !== undefined ? { extraArgs: freshEntry.extraArgs } : {}),
        })
      : await spawnStageSubagent(pi, config, stage, fresh, {
          ui: opts.ui,
          session: opts.session,
          runtimeCtx: opts.runtimeCtx,
          extraArgs: freshEntry.extraArgs,
          ...(freshEntry.operationContext ? { operationContext: freshEntry.operationContext } : {}),
        });

    if (result.deferred) {
      // Phase 2 / 179 (G3): the spawn is waiting for a live same-agent child in
      // another stage. Leave the pending entry untouched and do NOT consume an
      // attempt — the wait is not a spawn failure.
      continue;
    }

    if ("dispatchOutcome" in result && result.dispatchOutcome === "conflict_blocked") {
      // 195 Phase 2: configuration conflict — UI already notified, retry won't help.
      // Clear the pending entry to prevent retry loops, but don't count as consumed.
      // Note: spawnClarifyStageSubagent doesn't return dispatchOutcome, so we use a type guard.
      clearPendingSpawn(opts.session, stage, { operationId: freshEntry.operationContext?.operationId });
      const { emitDispatchConflictBlocked } = await import("../utils/dispatch-conflict-audit");
      await emitDispatchConflictBlocked("pending_spawn", {
        stage,
        pipelineId: fresh.pipelineId,
        reason: "configuration_conflict",
      });
      continue;
    }

    if (result.spawned || result.fallback) {
      // Phase 4 / 177 fix (review 1): the takeover block wrote synthetic reserved
      // evidence (activeSpawns[stage] with a `takeover-…` id). RPC success
      // overwrites it with the real agentId, but the fallback channel does not —
      // clear the stale reserved entry so it cannot cause 60s duplicate-spawn
      // suppression or a 30min stale active-spawn note.
      if (result.fallback) {
        const m = opts.session.getMeta();
        if (m?.activeSpawns?.[stage]?.reserved) {
          clearActiveSpawnRecord(opts.session, stage);
        }
      }
      clearPendingSpawn(opts.session, stage, { operationId: freshEntry.operationContext?.operationId });
      consumed.push(stage);
    } else {
      // Record the failed attempt so the next settle does not re-deliver forever.
      const latest = opts.session.getMeta();
      if (latest?.pendingSpawns?.[stage]) {
        opts.session.updateMeta({
          pendingSpawns: {
            ...latest.pendingSpawns,
            [stage]: { ...latest.pendingSpawns[stage]!, attempts: entry.attempts + 1 },
          },
        });
      }
    }
  }

  return consumed;
}

// ─── Deferred spawn wait-and-settle (Phase 2 / 179 G3) ───────────────────────

/**
 * Module-level dedup registry for deferred spawn setups.
 *
 * Key: `${stage}:${oldChildId}` — the (stage, old-child) pair uniquely identifies
 * a deferral. Value: a cleanup handle returned by `scheduleDeferredSpawn`.
 *
 * Without this registry, every owner settle while the old twin is still live
 * would re-enter `maybeDeferSpawnForLiveTwin` → `scheduleDeferredSpawn`, arming
 * duplicate timers/listeners/timeouts. The first finalization (settle/timeout)
 * would clean them all up individually, but intermediate duplicates waste
 * resources and violate the SOP #4 self-cleanup principle.
 */
const activeDeferredSpawns = new Map<string, () => void>();

/** Build the dedup key for a deferred spawn entry. */
function deferredSpawnKey(stage: PipelineStage, oldChildId: string | undefined): string {
  return `${stage}:${oldChildId ?? "unknown"}`;
}

/** Test-only: reset the deferred-spawn dedup registry. */
export function __resetActiveDeferredSpawns(): void {
  activeDeferredSpawns.clear();
}

/**
 * Test-only override for the deferred-spawn poll interval.
 * Production uses DEFERRED_SPAWN_POLL_INTERVAL_MS.
 */
let deferredSpawnPollMs = DEFERRED_SPAWN_POLL_INTERVAL_MS;

/** Test-only: override the deferred-spawn poll interval (ms). */
export function __setDeferredSpawnPollMs(ms: number): void {
  deferredSpawnPollMs = ms;
}

/** Test-only: restore the default deferred-spawn poll interval. */
export function __resetDeferredSpawnPollMs(): void {
  deferredSpawnPollMs = DEFERRED_SPAWN_POLL_INTERVAL_MS;
}

/**
 * Phase 2 / 179 (G3): wait-and-settle pre-check shared by both dispatchers.
 *
 * When `expectedAgent` is already live in a DIFFERENT stage (primary probe
 * evidence), the new spawn is deferred: the pending entry is enqueued and a
 * self-cleaning watcher/poll/timeout is armed. The caller should return a
 * `deferred: true` result so `consumePendingSpawns` leaves the entry intact.
 *
 * @returns true when the spawn was deferred
 */
async function maybeDeferSpawnForLiveTwin(
  pi: unknown,
  config: PipelineConfig,
  stage: PipelineStage,
  agentName: string,
  meta: SessionMeta,
  opts?: {
    ui?: { notify: (msg: string) => void };
    session?: SpawnSession;
    runtimeCtx?: unknown;
    extraArgs?: string;
    operationContext?: SpawnOperationContext;
  },
): Promise<boolean> {
  if (!opts?.session) return false;

  const activeSpawns = opts.session.getMeta()?.activeSpawns;

  // Phase 4 (182) Task 3: three-tier evidence chain for live-twin detection.
  //
  // Tier 1 — cross-stage probe (existing behavior):
  //   A same-agent child live in a DIFFERENT stage is definitive twin evidence.
  let hit = scanActiveSpawnEvidence(activeSpawns, agentName, { excludeStage: stage });

  // Tier 2 — same-stage probe (new, excluding self-reserved entries):
  //   A same-agent child live in the SAME stage (e.g. manually spawned via
  //   @mention while the plugin hasn't advanced yet) must also trigger deferral.
  //   Self-reserved entries (agentId prefixed "takeover-" / "dispatch:") are
  //   written by the current dispatch itself and must not cause self-lock.
  if (!hit || hit.basis !== "probe_live") {
    const sameStageHit = scanActiveSpawnEvidence(activeSpawns, agentName);
    if (sameStageHit && sameStageHit.basis === "probe_live" && sameStageHit.agentId) {
      const isSelfReserved =
        sameStageHit.agentId.startsWith("takeover-") ||
        sameStageHit.agentId.startsWith("dispatch:");
      if (!isSelfReserved) {
        hit = sameStageHit;
      }
    }
  }

  // 218 P0 (T0.6): Tier-3 (name-probe) DELETED — it depended on the fake
  // `listRecords` contract (constant null on 0.22.0). The event ledger is the
  // same-stage truth; manual/Agent-tool dispatches appear there via
  // `subagents:started` (source:"event"), covered by Tier 1/2 above.
  //
  // Tier 2.5 (defer-only supplement, Q16-B): a same-name ledger entry WITHOUT
  // a probeable agentId means a dispatch is in flight whose RPC reply has not
  // arrived. When the manager has NOT authoritatively confirmed "nothing is
  // running" (`hasRunning()` true or null), defer this dispatch instead of
  // racing a twin. With no such entry the miss fails open (no defer), matching
  // the old name-probe behavior — but now the ledger actually fills.
  // 218 review #6: the hit carries its TRUE basis — `reserved` (in-flight,
  // not probeable), never a borrowed `probe_live` label.
  if (!hit || hit.basis !== "probe_live") {
    if (anyTopLevelRunning() !== false) {
      const reservedSameName = Object.entries(activeSpawns ?? {})
        .find(([, spawn]) => spawn?.agentName === agentName && !spawn?.agentId);
      if (reservedSameName) {
        hit = { stage: reservedSameName[0] as PipelineStage, basis: "reserved" };
      }
    }
  }

  // 218 review #6: two-stage defer gate on FACTS, not borrowed labels —
  // hard live evidence (`probe_live`: probeable and currently running) OR a
  // reserved in-flight entry (`reserved`) while the manager has not
  // authoritatively confirmed "nothing is running".
  if (!hit) return false;
  const deferrableBasis =
    hit.basis === "probe_live" ||
    (hit.basis === "reserved" && anyTopLevelRunning() !== false);
  if (!deferrableBasis) return false;

  const key = deferredSpawnKey(stage, hit.agentId);
  // Dedup: if a deferral is already armed for this (stage, oldChildId) pair,
  // skip re-arming timers/listeners. enqueuePendingSpawn is itself idempotent
  // (preserves requestedAt), so re-entrance is harmless at the meta level.
  if (activeDeferredSpawns.has(key)) {
    return true;
  }
  // 192 Phase 1: the queued entry carries the same operation identity and
  // exact prompt/source as the dispatch request (task 7).
  enqueuePendingSpawn(opts.session, stage, agentName, opts.extraArgs, opts.operationContext);
  const cleanup = scheduleDeferredSpawn(pi, config, stage, agentName, hit, opts);
  activeDeferredSpawns.set(key, cleanup);
  await safeWriteAuditLog("stage_spawn_deferred", {
    pipelineId: meta.pipelineId,
    stage,
    agentName,
    oldChildId: hit.agentId ?? "",
    evidenceStage: hit.stage,
    // 218 review #6: replay can now tell a live-twin defer from a reserved
    // in-flight defer.
    evidenceBasis: hit.basis,
  });
  return true;
}

/**
 * Phase 2 / 179 (G3): Defers a stage spawn until a live same-agent child in
 * another stage settles.
 *
 * Arms three self-cleaning mechanisms:
 * 1. `watchSubagentLifecycle` on the old child (event-driven, primary)
 * 2. a `probeAgentState` poll fallback (covers lost lifecycle events)
 * 3. a bounded timeout (`config.spawnWaitTimeoutMs`) that escalates to manual
 *
 * Dequeue reuses the existing owner-routed channel (`consumePendingSpawns`).
 * All timers/listeners self-clean on settle or timeout — no leaks.
 */
function scheduleDeferredSpawn(
  pi: unknown,
  config: PipelineConfig,
  stage: PipelineStage,
  agentName: string,
  evidence: SpawnEvidenceHit,
  opts: {
    ui?: { notify: (msg: string) => void };
    session?: SpawnSession;
    runtimeCtx?: unknown;
    extraArgs?: string;
    operationContext?: SpawnOperationContext;
  },
): () => void {
  const session = opts.session;
  if (!session) return () => { /* noop */ };

  const key = deferredSpawnKey(stage, evidence.agentId);
  const timeoutMs = config.spawnWaitTimeoutMs ?? DEFAULT_SPAWN_WAIT_TIMEOUT_MS;
  const requestedAt = session.getMeta()?.pendingSpawns?.[stage]?.requestedAt ?? Date.now();
  const remaining = Math.max(0, timeoutMs - (Date.now() - requestedAt));

  let done = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupLifecycle: (() => void) | null = null;

  const finalize = (): void => {
    if (done) return;
    done = true;
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    cleanupLifecycle?.();
    // Remove from dedup registry so future deferrals for the same key can arm.
    activeDeferredSpawns.delete(key);
  };

  const tryDequeue = async (): Promise<void> => {
    if (done) return;
    const fresh = session.getMeta();
    if (!fresh?.pendingSpawns?.[stage]) {
      // Entry already consumed/cleared elsewhere — nothing left to do.
      finalize();
      return;
    }
    // Old child still live → keep waiting (poll/timeout retry).
    if (evidence.agentId && probeAgentState(evidence.agentId) === "live") return;
    finalize();
    // Dequeue the specific deferred entry. Skip the stage-consistency guard
    // (187) because currentStage may still differ from the pending entry's
    // stage at this point — the stage transition has not yet occurred. The
    // deferred path has its own validity checks (entry exists, old child
    // settled), so the guard would incorrectly discard a legitimate entry.
    await consumePendingSpawns(pi, config, fresh, {
      ui: opts.ui,
      session,
      runtimeCtx: opts.runtimeCtx,
    }, true /* skipStageGuard */);
  };

  if (evidence.agentId) {
    cleanupLifecycle = watchSubagentLifecycle(
      pi,
      evidence.agentId,
      () => {
        void tryDequeue();
      },
      { timeoutMs },
    );
  }

  timeoutTimer = setTimeout(() => {
    if (done) return;
    finalize();
    const fresh = session.getMeta();
    if (!fresh?.pendingSpawns?.[stage]) return;
    // Escalate to manual. The wait is not a spawn failure → do not consume an
    // attempt; clear the pending entry so it cannot loop.
    // 192 Phase 1: only clear OUR operation's entry — a newer operation may
    // have replaced the queue slot, and stale escalation must not delete it.
    clearPendingSpawn(session, stage, opts.operationContext
      ? { operationId: opts.operationContext.operationId }
      : undefined);
    const probeStatus = evidence.agentId ? probeAgentState(evidence.agentId) : "unknown";
    opts.ui?.notify?.(
      `Deferred spawn for "${stage}" timed out after ${timeoutMs}ms ` +
      `(old child: ${evidence.agentId ?? "n/a"}, source stage: ${evidence.stage}, probe: ${probeStatus}). ` +
      `Please handle it manually.`,
    );
    void safeWriteAuditLog("pending_spawn_wait_timeout", {
      stage,
      agentName,
      waitedMs: String(timeoutMs),
      oldChildId: evidence.agentId ?? "",
      evidenceStage: evidence.stage,
    }, "warn");
  }, remaining);

  pollTimer = setInterval(() => {
    void tryDequeue();
  }, deferredSpawnPollMs);

  // Do not keep the process alive solely for these timers.
  (pollTimer as { unref?: () => void }).unref?.();
  (timeoutTimer as { unref?: () => void }).unref?.();

  // Return a cleanup handle so the dedup registry can force-finalize if needed.
  return finalize;
}

/**
 * Phase 4 / 177 (D7): Spawns the clarify executor with a plugin-contract title.
 *
 * Clarify is also spawnable through `isSpawnableStage` (226_Bug made the gate
 * state-machine-derived), but the takeover consumer keeps using this dedicated
 * dispatcher: the description is derived two-state (verbatim user args win,
 * otherwise a document-derived title — no model free-form wording, 172).
 *
 * @param pi - Owner `pi` SDK handle
 * @param config - Pipeline configuration
 * @param meta - Session metadata
 * @param opts - UI notify, session handle, runtimeCtx for sessionFile audit
 * @returns { spawned, fallback, deferred? } outcome
 */
export async function spawnClarifyStageSubagent(
  pi: unknown,
  config: PipelineConfig,
  meta: SessionMeta,
  opts?: {
    ui?: { notify: (msg: string) => void };
    session?: SpawnSession;
    runtimeCtx?: unknown;
    /**
     * 226 review round 2 (issue 2): the args the QUEUED dispatch carried
     * (`pendingSpawns[stage].extraArgs`). The owner-side dequeue must deliver
     * exactly those — `meta.lastClarifyTurnArgs` is only written by the human
     * mention path, so falling back to it silently dropped the auto round's
     * `full-und?`/`<n> 答` and its protocol/finalisation directive.
     */
    extraArgs?: string;
  },
): Promise<{ spawned: boolean; fallback: boolean; deferred?: boolean }> {
  const agentName = resolveAgentMention(config, "clarify");
  if (!agentName) {
    opts?.ui?.notify?.(`No agent configured for stage "clarify". Please start manually.`);
    await safeWriteAuditLog("stage_spawn_skipped", {
      pipelineId: meta.pipelineId,
      stage: "clarify",
      reason: "agentName_unresolvable",
    });
    return { spawned: false, fallback: false };
  }

  // Phase 2 / 179 (G3): same wait-and-settle pre-check as spawnStageSubagent.
  // Clarify and plan often share the same agent name, so a live plan child must
  // block a clarify re-spawn too.
  if (await maybeDeferSpawnForLiveTwin(pi, config, "clarify", agentName, meta, opts)) {
    return { spawned: false, fallback: false, deferred: true };
  }

  const file = meta.requirementDoc ?? "";
  const sessionFile = extractSessionFile(opts?.runtimeCtx);
  // 226 review round 2 (issue 2): a dequeued round arrives with its own args.
  // They are the contract of the queue entry (`enqueuePendingSpawn` carries
  // `extraArgs`), so they WIN over the human mention field — the deferred round
  // must arrive with `full-und?`/`<n> 答` and the finalisation instruction.
  const roundArgs = opts?.extraArgs ?? meta.lastClarifyTurnArgs;
  // The queued args also carry the protocol/finalisation DIRECTIVE (prose after
  // a blank line). Only the args line belongs in the title, exactly like the
  // direct dispatch path (`resolveClarifyDescription(doc, decision.extraArgs)`).
  const descriptionArgs = opts?.extraArgs !== undefined
    ? opts.extraArgs.split("\n")[0]
    : meta.lastClarifyTurnArgs;
  const { description } = resolveClarifyDescription(file, descriptionArgs);
  const argsSuffix = roundArgs?.trim() ? ` ${roundArgs.trim()}` : "";
  // 204 Phase 0: marker shared by the RPC path and the `[plugin auto-handoff]` fallback.
  const prompt = appendPipelineIdMarker(`${file}${argsSuffix}`.trim(), meta.pipelineId);

  // RPC path (availability latch driven).
  if (hasEventBus(pi) && isSubagentsReady()) {
    const spawnResult = await spawnClarifySubagent(pi, { agentName, prompt, description });
    if (spawnResult.ok) {
      await safeWriteAuditLog("stage_spawn_rpc", {
        pipelineId: meta.pipelineId,
        stage: "clarify",
        agentName,
        subagentId: spawnResult.id,
        ...(sessionFile ? { sessionFile } : {}),
      });
      // Phase 2 / 179 (G3): overwrite any takeover pseudo-id reserved evidence
      // with the real agentId so probeAgentState-based suppression (primary
      // evidence) works for the clarify stage too.
      if (opts?.session) {
        const currentMeta = opts.session.getMeta();
        if (currentMeta) {
          opts.session.updateMeta({
            activeSpawns: {
              ...(currentMeta.activeSpawns ?? {}),
              clarify: { agentName, agentId: spawnResult.id, startedAt: Date.now() },
            },
          });
        }
      }
      const cleanup = watchSubagentLifecycle(pi, spawnResult.id, () => {
        if (opts?.session) clearActiveSpawnRecord(opts.session, "clarify");
        cleanup();
      }, { timeoutMs: LIFECYCLE_LISTENER_TIMEOUT_MS });
      // 210 Phase 2: clarify dispatch success is stage progress too.
      reportStageProgress(meta.pipelineId, "spawn");
      // 226 review round 2 (issue 2): the queued finalisation round is REALLY
      // out — promote the queue intent into the dispatched fact.
      await noteQueuedClarifyDelivered(config, meta);
      return { spawned: true, fallback: false };
    }
    await safeWriteAuditLog("stage_spawn_rpc_failed", {
      pipelineId: meta.pipelineId,
      stage: "clarify",
      agentName,
      error: spawnResult.error,
      ...(sessionFile ? { sessionFile } : {}),
    }, "warn");
  }

  // Fallback: sendUserMessage with the plugin auto-handoff prefix (D10).
  if (hasSendUserMessage(pi)) {
    try {
      pi.sendUserMessage(`[plugin auto-handoff] @${agentName} ${prompt}`, { deliverAs: "followUp" });
      opts?.ui?.notify?.(`Spawned clarify agent via followUp message.`);
      await safeWriteAuditLog("stage_spawn_fallback", {
        pipelineId: meta.pipelineId,
        stage: "clarify",
        agentName,
        ...(sessionFile ? { sessionFile } : {}),
      });
      // 210 Phase 2: clarify followUp dispatch renews the idle clock.
      reportStageProgress(meta.pipelineId, "spawn");
      // 226 review round 2 (issue 2): the fallback channel really delivered the
      // queued round as well — same promotion as the RPC path.
      await noteQueuedClarifyDelivered(config, meta);
      return { spawned: true, fallback: true };
    } catch {
      // sendUserMessage failure is non-fatal; fall through to notify
    }
  }

  opts?.ui?.notify?.(`Next: run @${agentName} manually for clarify stage.`);
  await safeWriteAuditLog("stage_spawn_fallback", {
    pipelineId: meta.pipelineId,
    stage: "clarify",
    agentName,
    notify_only: "true",
    ...(sessionFile ? { sessionFile } : {}),
  });
  return { spawned: false, fallback: false };
}
