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
import { clearActiveSpawnRecord } from "./spawn-cleanup";
import { isSubagentsReady } from "./subagent-availability";
import { resolveClarifyDescription } from "./clarify-args";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";

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

/**
 * Minimal EventBus interface expected from pi.events.
 * Uses structural typing to avoid importing the SDK type.
 */
interface EventBus {
  emit(event: string, payload: Record<string, unknown>): void;
  on(event: string, handler: (payload: unknown) => void): void;
  off?(event: string, handler: (payload: unknown) => void): void;
}

/**
 * Minimal pi SDK interface for subagent RPC operations.
 */
interface PiWithEvents {
  events: EventBus;
}

/**
 * Type guard to check if pi has an events property.
 */
function hasEventBus(pi: unknown): pi is PiWithEvents {
  return !!pi && typeof (pi as PiWithEvents).events === "object"
    && typeof (pi as PiWithEvents).events.emit === "function"
    && typeof (pi as PiWithEvents).events.on === "function";
}

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
 * Plan, develop, review, and fix stages are spawnable (they have dedicated
 * agent subagents). The stage must also have an agentPath configured.
 * Clarify is NOT spawnable here — it has its own auto-launch path via
 * /pipeline-start (maybeAutoLaunchClarify) with different idempotency semantics.
 *
 * @param config - Pipeline configuration
 * @param stage - The stage to check
 * @returns True if the stage can be auto-spawned
 */
export function isSpawnableStage(
  config: PipelineConfig,
  stage: PipelineStage,
): boolean {
  const spawnableStages: PipelineStage[] = ["plan", "develop", "review", "fix"];
  if (!spawnableStages.includes(stage)) return false;
  return !!config.stages[stage]?.agentPath;
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
 */
interface SpawnSession {
  getMeta: () => SessionMeta | undefined;
  updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
}

/**
 * Spawns a subagent for the given stage after stage transition.
 *
 * Three-tier dispatch (mirrors clarify auto-launch pattern):
 * 1. Non-spawnable stage → return { spawned: false } immediately
 * 2. Idempotency guard: if session provided and spawnedStages[stage] === stageStartTime
 *    → audit stage_spawn_skipped reason=duplicate_spawn_guarded, return { spawned: false }
 * 3. resolveAgentMention fails → notify + audit stage_spawn_skipped
 * 4. RPC path (hasEventBus + availability latch): spawn → audit stage_spawn_rpc + watch lifecycle
 * 5. Fallback: sendUserMessage with deliverAs:"followUp" + notify + audit stage_spawn_fallback
 *
 * On success (RPC or fallback), writes the guard: spawnedStages[stage] = stageStartTime.
 * When session is not provided, the guard is skipped (backward compatible).
 *
 * @param pi - pi SDK ExtensionAPI handle
 * @param config - Pipeline configuration
 * @param stage - Target stage to spawn subagent for
 * @param meta - Current session metadata
 * @param opts - Optional UI notify handle, session for idempotency guard,
 *   extraArgs, and runtimeCtx (for sessionFile audit correlation)
 * @returns { spawned, fallback } indicating outcome
 */
export async function spawnStageSubagent(
  pi: unknown,
  config: PipelineConfig,
  stage: PipelineStage,
  meta: SessionMeta,
  opts?: { ui?: { notify: (msg: string) => void }; session?: SpawnSession; extraArgs?: string; runtimeCtx?: unknown },
): Promise<{ spawned: boolean; fallback: boolean }> {
  // 1. Non-spawnable stage → skip silently
  if (!isSpawnableStage(config, stage)) {
    return { spawned: false, fallback: false };
  }

  // 2. Idempotency guard: skip if already spawned for this visit
  if (opts?.session) {
    const freshMeta = opts.session.getMeta();
    if (freshMeta && freshMeta.spawnedStages?.[stage] === freshMeta.stageStartTime) {
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

  // 3. Resolve agent name from config
  const agentName = resolveAgentMention(config, stage);
  if (!agentName) {
    opts?.ui?.notify?.(`No agent configured for stage "${stage}". Please start manually.`);
    await safeWriteAuditLog("stage_spawn_skipped", {
      pipelineId: meta.pipelineId,
      stage,
      reason: "agentName_unresolvable",
    });
    return { spawned: false, fallback: false };
  }

  // 3b. Phase 2 / 177 (D4③): child/clone contexts must not spawn in place.
  // Enqueue for the owner session, which consumes pendingSpawns on agent_settled.
  if (opts?.session && isChildRuntimeCtx(opts.runtimeCtx)) {
    enqueuePendingSpawn(opts.session, stage, agentName);
    await safeWriteAuditLog("stage_spawn_routed_to_owner", {
      pipelineId: meta.pipelineId,
      stage,
      agentName,
      ...(extractSessionFile(opts.runtimeCtx) ? { sessionFile: extractSessionFile(opts.runtimeCtx)! } : {}),
    });
    return { spawned: false, fallback: false };
  }

  // Phase 1 (169): spawn prompt includes requirementDoc pointer for context passing
  const reqDocHint = meta.requirementDoc ?? "(unset)";
  // Phase 2 / 177 (D4⑥): sessionFile for audit correlation (171 precedent).
  const sessionFile = extractSessionFile(opts?.runtimeCtx);
  let prompt = `Begin the ${stage} stage work now. Pipeline: ${meta.pipelineId ?? ""}. Requirement doc: ${reqDocHint} — read it first (contains clarification conclusions)`;
  // Phase 3 (171) High B: append extraArgs (User focus) when provided by caller
  if (opts?.extraArgs) {
    prompt += opts.extraArgs;
  }
  // Phase 7 (172) G1: description for spawn RPC.
  // Note: clarify stage description derivation happens in pipeline-start.ts
  // (maybeAutoLaunchClarify → spawnClarifySubagent with explicit description).
  // This path only handles spawnable stages (plan/develop/review/fix) via
  // spawnStageSubagent — clarify is NOT in isSpawnableStage (L436 early return).
  const description = `${stage}: ${meta.requirementDoc ?? ""}`;

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
    if (subagentId) {
      patch.activeSpawns = {
        ...(currentMeta.activeSpawns ?? {}),
        [stage]: { agentName, agentId: subagentId, startedAt: Date.now() },
      };
    }
    opts.session.updateMeta(patch);
  };

  /** Helper to clear activeSpawns entry on lifecycle settle (delegates to shared utility) */
  const clearActiveSpawn = (): void => {
    if (!opts?.session) return;
    clearActiveSpawnRecord(opts.session, stage);
  };

  // Phase 2 / 175 (R1Q5A/R2Q5A): write reserved placeholder before ping.
  // This allows concurrent spawn attempts to detect in-flight spawns (<60s).
  const writeReserved = (): void => {
    if (!opts?.session) return;
    const currentMeta = opts.session.getMeta();
    if (!currentMeta) return;
    // Only write if no existing entry (avoid overwriting a live spawn)
    if (currentMeta.activeSpawns?.[stage]?.agentId) return;
    opts.session.updateMeta({
      activeSpawns: {
        ...(currentMeta.activeSpawns ?? {}),
        [stage]: { agentName, startedAt: Date.now(), reserved: true },
      },
    });
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
    // Write reserved before spawn to mark in-flight spawn
    writeReserved();
    const spawnResult = await spawnClarifySubagent(pi, {
      agentName,
      prompt,
      description,
    });

    if (spawnResult.ok) {
      await safeWriteAuditLog("stage_spawn_rpc", {
        pipelineId: meta.pipelineId,
        stage,
        agentName,
        subagentId: spawnResult.id,
        ...(sessionFile ? { sessionFile } : {}),
      });
      // Watch lifecycle (self-unregistering) with timeout guard to prevent leak.
      // On settle: clear activeSpawns entry so duplicate-spawn guard does not misfire.
      const cleanup = watchSubagentLifecycle(pi, spawnResult.id, () => {
        clearActiveSpawn();
        cleanup();
      }, { timeoutMs: LIFECYCLE_LISTENER_TIMEOUT_MS });
      await writeGuard(spawnResult.id);
      return { spawned: true, fallback: false };
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
      return { spawned: true, fallback: true };
    } catch {
      // sendUserMessage failure is non-fatal; fall through to notify
    }
  }

  // Final fallback: just notify
  opts?.ui?.notify?.(`Next: run @${agentName} manually for ${stage} stage.`);
  await safeWriteAuditLog("stage_spawn_fallback", {
    pipelineId: meta.pipelineId,
    stage,
    agentName,
    notify_only: "true",
    ...(sessionFile ? { sessionFile } : {}),
  });
  return { spawned: false, fallback: false };
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
function isChildRuntimeCtx(runtimeCtx: unknown): boolean {
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
 * Idempotent: re-enqueuing the same stage preserves `requestedAt`/`attempts`.
 *
 * @param session - Session handle exposing meta read/write
 * @param stage - Stage to spawn
 * @param agentName - Resolved agent mention for the stage
 */
export function enqueuePendingSpawn(
  session: SpawnSession,
  stage: PipelineStage,
  agentName: string,
): void {
  const meta = session.getMeta();
  if (!meta) return;
  const existing = meta.pendingSpawns?.[stage];
  session.updateMeta({
    pendingSpawns: {
      ...(meta.pendingSpawns ?? {}),
      [stage]: {
        agentName,
        requestedAt: existing?.requestedAt ?? Date.now(),
        attempts: existing?.attempts ?? 0,
      },
    },
  });
}

/**
 * Phase 2 / 177 (D4③): Removes a consumed pendingSpawns entry.
 *
 * @param session - Session handle exposing meta read/write
 * @param stage - Stage entry to clear
 */
export function clearPendingSpawn(session: SpawnSession, stage: PipelineStage): void {
  const meta = session.getMeta();
  if (!meta?.pendingSpawns?.[stage]) return;
  const next = { ...meta.pendingSpawns };
  delete next[stage];
  session.updateMeta({ pendingSpawns: next });
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
): Promise<PipelineStage[]> {
  const pending = meta.pendingSpawns;
  if (!pending) return [];
  const consumed: PipelineStage[] = [];
  const entries = Object.entries(pending) as [
    PipelineStage,
    { agentName: string; requestedAt: number; attempts: number },
  ][];

  for (const [stage, entry] of entries) {
    const fresh = opts.session.getMeta();
    if (!fresh?.pendingSpawns?.[stage]) continue;

    // Already spawned for this visit → nothing to do; drop the pending entry.
    if (fresh.spawnedStages?.[stage] === fresh.stageStartTime) {
      clearPendingSpawn(opts.session, stage);
      continue;
    }

    // Re-delivery bound reached → stop to avoid a settle loop.
    if (entry.attempts >= PENDING_SPAWN_MAX_ATTEMPTS) {
      clearPendingSpawn(opts.session, stage);
      continue;
    }

    // Phase 4 / 177 (D7): clarify is not in isSpawnableStage (its own spawn path),
    // so route it through the dedicated clarify dispatcher.
    const result = stage === "clarify"
      ? await spawnClarifyStageSubagent(pi, config, fresh, {
          ui: opts.ui,
          session: opts.session,
          runtimeCtx: opts.runtimeCtx,
        })
      : await spawnStageSubagent(pi, config, stage, fresh, {
          ui: opts.ui,
          session: opts.session,
          runtimeCtx: opts.runtimeCtx,
        });

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
      clearPendingSpawn(opts.session, stage);
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

/**
 * Phase 4 / 177 (D7): Spawns the clarify executor with a plugin-contract title.
 *
 * Clarify is intentionally excluded from `isSpawnableStage` (it has its own
 * auto-launch path), so the takeover consumer uses this dedicated dispatcher.
 * The description is derived two-state: verbatim user args win, otherwise a
 * document-derived title (no model free-form wording).
 *
 * @param pi - Owner `pi` SDK handle
 * @param config - Pipeline configuration
 * @param meta - Session metadata
 * @param opts - UI notify, session handle, runtimeCtx for sessionFile audit
 * @returns { spawned, fallback } outcome
 */
export async function spawnClarifyStageSubagent(
  pi: unknown,
  config: PipelineConfig,
  meta: SessionMeta,
  opts?: { ui?: { notify: (msg: string) => void }; session?: SpawnSession; runtimeCtx?: unknown },
): Promise<{ spawned: boolean; fallback: boolean }> {
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

  const file = meta.requirementDoc ?? "";
  const sessionFile = extractSessionFile(opts?.runtimeCtx);
  const { description } = resolveClarifyDescription(file, meta.lastClarifyTurnArgs);
  const argsSuffix = meta.lastClarifyTurnArgs?.trim() ? ` ${meta.lastClarifyTurnArgs.trim()}` : "";
  const prompt = `${file}${argsSuffix}`.trim();

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
      const cleanup = watchSubagentLifecycle(pi, spawnResult.id, () => {
        if (opts?.session) clearActiveSpawnRecord(opts.session, "clarify");
        cleanup();
      }, { timeoutMs: LIFECYCLE_LISTENER_TIMEOUT_MS });
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
