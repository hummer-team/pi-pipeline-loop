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
import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";

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

      pi.events.emit("subagents:rpc:spawn", {
        requestId,
        type: req.agentName,
        prompt: req.prompt,
        options: {
          run_in_background: false,
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
 * @param pi - Extension API with events bus
 * @param requestId - The spawn request ID to correlate
 * @param onEvent - Callback for lifecycle events
 * @returns Cleanup function to unregister listeners
 */
export function watchSubagentLifecycle(
  pi: unknown,
  requestId: string,
  onEvent: (event: "completed" | "failed", payload: unknown) => void,
): () => void {
  if (!hasEventBus(pi)) return () => {};

  const completedHandler = (payload: unknown): void => {
    const env = payload as Record<string, unknown> | undefined;
    if (env?.id === requestId || env?.requestId === requestId) {
      onEvent("completed", payload);
      safeWriteAuditLog("subagent_lifecycle", {
        requestId, event: "completed",
      }).catch(() => {});
    }
  };

  const failedHandler = (payload: unknown): void => {
    const env = payload as Record<string, unknown> | undefined;
    if (env?.id === requestId || env?.requestId === requestId) {
      onEvent("failed", payload);
      safeWriteAuditLog("subagent_lifecycle", {
        requestId, event: "failed",
      }, "warn").catch(() => {});
    }
  };

  pi.events.on("subagents:completed", completedHandler);
  pi.events.on("subagents:failed", failedHandler);

  // Return cleanup function
  return () => {
    if (pi.events.off) {
      pi.events.off("subagents:completed", completedHandler);
      pi.events.off("subagents:failed", failedHandler);
    }
  };
}

// ─── Stage Subagent Spawn (168 Phase 4) ──────────────────────────────────────

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
 * Only develop, review, and fix stages are spawnable (they have dedicated
 * agent subagents). The stage must also have an agentPath configured.
 *
 * @param config - Pipeline configuration
 * @param stage - The stage to check
 * @returns True if the stage can be auto-spawned
 */
export function isSpawnableStage(
  config: PipelineConfig,
  stage: PipelineStage,
): boolean {
  const spawnableStages: PipelineStage[] = ["develop", "review", "fix"];
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
 * Spawns a subagent for the given stage after manual confirm gate approval.
 *
 * Three-tier dispatch (mirrors clarify auto-launch pattern):
 * 1. Non-spawnable stage → return { spawned: false } immediately
 * 2. resolveAgentMention fails → notify + audit stage_spawn_skipped
 * 3. RPC path (hasEventBus): ping → spawn → audit stage_spawn_rpc + watch lifecycle
 * 4. Fallback: sendUserMessage with deliverAs:"followUp" + notify + audit stage_spawn_fallback
 *
 * @param pi - pi SDK ExtensionAPI handle
 * @param config - Pipeline configuration
 * @param stage - Target stage to spawn subagent for
 * @param meta - Current session metadata
 * @param opts - Optional UI notify handle
 * @returns { spawned, fallback } indicating outcome
 */
export async function spawnStageSubagent(
  pi: unknown,
  config: PipelineConfig,
  stage: PipelineStage,
  meta: SessionMeta,
  opts?: { ui?: { notify: (msg: string) => void } },
): Promise<{ spawned: boolean; fallback: boolean }> {
  // 1. Non-spawnable stage → skip silently
  if (!isSpawnableStage(config, stage)) {
    return { spawned: false, fallback: false };
  }

  // 2. Resolve agent name from config
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

  const prompt = `Begin the ${stage} stage work now. Pipeline: ${meta.pipelineId}`;
  const description = `${stage}: ${meta.requirementDoc ?? ""}`;

  // 3. RPC path: ping → spawn → success
  if (hasEventBus(pi)) {
    const pinged = await pingSubagents(pi, 500);
    if (pinged) {
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
        });
        // Watch lifecycle (self-unregistering)
        const cleanup = watchSubagentLifecycle(pi, spawnResult.id, () => {
          cleanup();
        });
        return { spawned: true, fallback: false };
      }
      // Spawn failed → fall through to sendUserMessage fallback
    }
    // Ping timeout or spawn failure → fall through
  }

  // 4. Fallback: sendUserMessage with deliverAs:"followUp"
  if (hasSendUserMessage(pi)) {
    try {
      pi.sendUserMessage(`@${agentName} ${prompt}`, { deliverAs: "followUp" });
      opts?.ui?.notify?.(`Spawned ${stage} agent via followUp message.`);
      await safeWriteAuditLog("stage_spawn_fallback", {
        pipelineId: meta.pipelineId,
        stage,
        agentName,
      });
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
  });
  return { spawned: false, fallback: false };
}
