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
import { writeAuditLog } from "../utils/auditLog";
import type { PipelineConfig } from "../types";

/** CustomEntry type identifier for pipeline metadata persistence. */
export const PIPELINE_META_CUSTOM_TYPE = "pi-pipeline:meta";

/**
 * Unified interface for reading and writing pipeline SessionMeta
 * via the pi SDK's CustomEntry mechanism.
 */
export interface SessionState {
  /** Read the latest SessionMeta from session entries. Returns undefined if none exists. */
  getMeta(): SessionMeta | undefined;

  /**
   * Write a new SessionMeta snapshot by merging the current state with a patch.
   * Uses pi.appendEntry() for persistence. Failures are logged but not thrown (fail-open).
   */
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;

  /**
   * Extract assistant messages from the current session branch.
   * Scans for message entries where role === "assistant" and extracts text content.
   */
  extractAssistantMessages(): string[];
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
      } catch {
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
        // Use fire-and-forget for audit log (non-blocking)
        writeAuditLog("session_state_error", {
          error: errMsg,
          operation: "updateMeta",
        }, "error").catch(() => {});
        return undefined;
      }
    },

    extractAssistantMessages(): string[] {
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
      } catch {
        return [];
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
  } catch {
    return [];
  }
}
