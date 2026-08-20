/**
 * @module session-state
 * SessionState adapter over pi SDK's native CustomEntry mechanism.
 *
 * Provides a unified getMeta/updateMeta interface for persisting pipeline
 * SessionMeta across session reloads, replacing the non-existent ctx.session
 * API from the original stub.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionMeta } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";
import type { PipelineConfig } from "../types";

/** CustomEntry type identifier for pipeline metadata persistence. */
export const PIPELINE_META_CUSTOM_TYPE = "pi-pipeline:meta";

/**
 * Unified interface for reading and writing pipeline SessionMeta
 * via the pi SDK's CustomEntry mechanism.
 *
 * Per plan, the interface only contains getMeta/updateMeta.
 * extractAssistantMessages is a standalone exported function.
 */
export interface SessionState {
  /** Read the latest SessionMeta from session entries. Returns undefined if none exists. */
  getMeta(): SessionMeta | undefined;

  /**
   * Write a new SessionMeta snapshot by merging the current state with a patch.
   * Uses pi.appendEntry() for persistence. Failures are logged but not thrown (fail-open).
   */
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
}

/**
 * Create a SessionState adapter bound to the current pi ExtensionAPI and ExtensionContext.
 *
 * Read path: scans ctx.sessionManager.getEntries() in reverse for the latest
 * CustomEntry with customType === PIPELINE_META_CUSTOM_TYPE.
 *
 * Write path: calls pi.appendEntry() with the merged metadata snapshot.
 */
export function createSessionState(pi: ExtensionAPI, ctx: ExtensionContext): SessionState {
  return {
    getMeta(): SessionMeta | undefined {
      try {
        const entries = ctx.sessionManager.getEntries();
        // Scan in reverse to find the most recent pipeline meta entry
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (
            entry.type === "custom" &&
            "customType" in entry &&
            entry.customType === PIPELINE_META_CUSTOM_TYPE
          ) {
            const data = (entry as { data?: unknown }).data;
            if (data && typeof data === "object") {
              return data as SessionMeta;
            }
          }
        }
        return undefined;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        safeWriteAuditLog("session_state_error", { operation: "getMeta", error: errMsg }, "error");
        return undefined;
      }
    },

    updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined {
      try {
        const current = this.getMeta();
        const merged = current ? { ...current, ...patch } : (patch as SessionMeta);
        pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, merged);
        return merged;
      } catch (err) {
        // Fail-open: log but don't throw to avoid blocking the pipeline
        const errMsg = err instanceof Error ? err.message : String(err);
        // Use safeWriteAuditLog (fire-and-forget, never throws)
        safeWriteAuditLog("session_state_error", {
          error: errMsg,
          operation: "updateMeta",
        }, "error");
        return undefined;
      }
    },

  };
}

/**
 * Extract assistant messages from the current session branch.
 *
 * Scans ctx.sessionManager.getBranch() for message entries where
 * message.role === "assistant", extracting text content from each.
 *
 * Content extraction:
 * - string content → used directly
 * - array content → concatenates parts where type === "text"
 */
export function extractAssistantMessages(ctx: ExtensionContext): string[] {
  try {
    const entries = ctx.sessionManager.getBranch();
    const messages: string[] = [];

    for (const entry of entries) {
      if (entry.type !== "message") continue;

      const msgEntry = entry as { type: "message"; message: { role: string; content?: unknown } };
      if (msgEntry.message.role !== "assistant") continue;

      const content = msgEntry.message.content;
      if (typeof content === "string") {
        messages.push(content);
      } else if (Array.isArray(content)) {
        const textParts = content
          .filter((part: { type?: string }) => part.type === "text")
          .map((part: { text?: string }) => part.text ?? "");
        if (textParts.length > 0) {
          messages.push(textParts.join(""));
        }
      }
    }

    return messages;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeWriteAuditLog("session_state_error", { operation: "extractAssistantMessages", error: errMsg }, "error");
    return [];
  }
}

/**
 * A single tool call record extracted from the session branch.
 * Used by selfVerifySkip to determine whether the model has already
 * successfully executed a given command during the current stage.
 */
export interface ToolCallRecord {
  /** Tool name (e.g. "bash", "write", "edit") */
  name: string;
  /** For bash: the full command string. For write/edit: the file path. */
  command?: string;
  /** For bash: the exit code (0 = success). Undefined if result not yet received. */
  exitCode?: number;
  /** For write/edit: whether the operation succeeded */
  success?: boolean;
  /** Unix timestamp (ms) when the call was recorded */
  ts: number;
}

/**
 * Extracts all tool call records from the current session branch.
 * Scans for tool_call + tool_result pairs, pairing them to capture
 * the execution outcome (exit code, success flag).
 *
 * @param ctx - Extension context with session manager
 * @returns Chronologically ordered array of tool call records
 */
export function extractToolCallRecords(ctx: ExtensionContext): ToolCallRecord[] {
  try {
    const entries = ctx.sessionManager.getBranch();
    const records: ToolCallRecord[] = [];

    // Index pending tool_call entries by their callId for result pairing
    const pendingCalls = new Map<string, { index: number; record: ToolCallRecord }>();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type !== "message") continue;

      const msgEntry = entry as {
        type: "message";
        message: {
          role: string;
          content?: unknown;
          toolCallId?: string;
          toolName?: string;
        };
      };
      const msg = msgEntry.message;

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Look for tool_use content blocks
        for (const block of msg.content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
          if (block?.type === "tool_use" && block.id && block.name) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const ts = i; // Use entry index as monotonic timestamp proxy
            let command: string | undefined;
            if (block.name === "bash") {
              command = typeof input.command === "string" ? input.command : undefined;
            } else if (block.name === "write" || block.name === "edit") {
              command = typeof input.filePath === "string" ? input.filePath : (typeof input.file_path === "string" ? input.file_path : undefined);
            }
            const record: ToolCallRecord = {
              name: block.name,
              command,
              ts,
            };
            pendingCalls.set(block.id, { index: i, record });
          }
        }
      } else if (msg.role === "user" && msg.toolCallId) {
        // Tool result — pair with pending call
        const pending = pendingCalls.get(msg.toolCallId);
        if (pending) {
          const content = msg.content;
          // Detect exit code from tool result content
          if (pending.record.name === "bash") {
            // bash tool results typically contain exit code info
            const text = typeof content === "string" ? content :
              (Array.isArray(content) ? content.map(p => typeof p === "object" && p && "text" in p ? (p as { text?: string }).text : "").join("") : "");
            const exitMatch = text.match(/exit code[:\s]+(-?\d+)/i) || text.match(/exitCode[:\s]+(-?\d+)/i);
            if (exitMatch) {
              pending.record.exitCode = parseInt(exitMatch[1], 10);
            }
            // If no exit code found but result has no error markers, assume success (exitCode=0)
            if (pending.record.exitCode === undefined && !text.toLowerCase().includes("error")) {
              pending.record.exitCode = 0;
            }
          } else if (pending.record.name === "write" || pending.record.name === "edit") {
            // Write/edit success: no error in result content
            const text = typeof content === "string" ? content :
              (Array.isArray(content) ? content.map(p => typeof p === "object" && p && "text" in p ? (p as { text?: string }).text : "").join("") : "");
            pending.record.success = !text.toLowerCase().includes("error") && !text.toLowerCase().includes("failed");
          }
          records.push(pending.record);
          pendingCalls.delete(msg.toolCallId);
        }
      }
    }

    return records.sort((a, b) => a.ts - b.ts);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    safeWriteAuditLog("session_state_error", { operation: "extractToolCallRecords", error: errMsg }, "error");
    return [];
  }
}
