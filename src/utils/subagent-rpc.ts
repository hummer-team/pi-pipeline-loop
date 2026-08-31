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
import { safeWriteAuditLog } from "./auditLog";

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
        resolve(false);
      }
    }, timeoutMs);

    try {
      pi.events.on(replyChannel, (payload: unknown) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);

        // Envelope-tolerant: accept {success:true} or {success:true,data:{version:2}}
        const env = payload as Record<string, unknown> | undefined;
        if (env && (env as Record<string, unknown>).success === true) {
          resolve(true);
        } else {
          resolve(false);
        }
      });

      pi.events.emit("subagents:rpc:ping", { requestId });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
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
        safeWriteAuditLog("subagent_rpc", {
          action: "spawn", outcome: "timeout", requestId, agentName: req.agentName,
        }, "warn").catch(() => {});
        resolve({ ok: false, error: "spawn_timeout" });
      }
    }, SPAWN_TIMEOUT_MS);

    try {
      pi.events.on(replyChannel, (payload: unknown) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);

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
      });

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
