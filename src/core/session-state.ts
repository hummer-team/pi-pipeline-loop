/**
 * @module session-state
 * SessionState adapter over pi SDK's native CustomEntry mechanism.
 *
 * Provides a unified getMeta/updateMeta interface for persisting pipeline
 * SessionMeta across session reloads, replacing the non-existent ctx.session
 * API from the original stub.
 *
 * Phase 1 (143): Introduces shared state source — a per-pipeline meta.json
 * file at `{projectRoot}/{auditDir}/{pipelineId}/meta.json`. This file is
 * the authority for cross-session stage synchronization (sub-agent fork
 * and breakpoint resume). getMeta() reads shared source first (if pipelineId
 * matches), falling back to local session entries. updateMeta() dual-writes
 * to both local entries and the shared meta.json (fail-open on shared write).
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionMeta } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";
import type { PipelineConfig } from "../types";

/** CustomEntry type identifier for pipeline metadata persistence. */
export const PIPELINE_META_CUSTOM_TYPE = "pi-pipeline:meta";

/**
 * Options for createSessionState enabling the shared state source.
 * When projectRoot is provided, getMeta/updateMeta will dual-read/write
 * the shared meta.json at `{projectRoot}/{auditDir}/{pipelineId}/meta.json`.
 */
export interface SessionStateOptions {
  /** Absolute path to the project root directory */
  projectRoot?: string;
  /** Audit directory relative to projectRoot (default ".pi/audit") */
  auditDir?: string;
}

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
 * Module-level cache for the shared state base directory.
 * Resolved once from projectRoot + auditDir on first createSessionState call.
 * Reset via __resetSharedStateDir() for test isolation.
 *
 * NOTE: The base dir is also captured per-instance via closure in createSessionState
 * so that concurrent sessions with different projectRoots don't interfere.
 * The module-level cache exists primarily for backward compatibility with
 * code that doesn't pass options.
 */
let sharedStateBaseDir = "";

/**
 * Test-only reset hook for the shared state base directory.
 * Mirrors __resetAuditDirPath() in auditLog.ts.
 */
export function __resetSharedStateDir(): void {
  sharedStateBaseDir = "";
}

/**
 * Resolve the shared state base directory from options.
 * Updates the module-level cache and returns the resolved path.
 */
function resolveSharedStateBaseDir(options?: SessionStateOptions): string {
  if (options?.projectRoot) {
    const auditDir = options.auditDir || ".pi/audit";
    const resolved = path.resolve(options.projectRoot, auditDir);
    if (!sharedStateBaseDir) sharedStateBaseDir = resolved;
    return resolved;
  }
  return sharedStateBaseDir;
}

/**
 * Create a SessionState adapter bound to the current pi ExtensionAPI and ExtensionContext.
 *
 * Read path:
 *   1. Scan local session entries in reverse for the latest pipeline meta CustomEntry.
 *      Extract pipelineId from it.
 *   2. If shared state base dir is configured AND pipelineId is known, read
 *      `{baseDir}/{pipelineId}/meta.json`. If it exists and contains a matching
 *      pipelineId, return it as the authoritative state (shared source wins).
 *   3. Otherwise fall back to the local entry result.
 *
 * Write path: calls pi.appendEntry() + writes meta.json (dual-write, fail-open on shared).
 */
export function createSessionState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options?: SessionStateOptions,
): SessionState {
  // Resolve base dir per-instance (captured in closure) — avoids cross-test interference.
  // Also updates module-level cache for backward compat.
  const instanceBaseDir = resolveSharedStateBaseDir(options);

  return {
    getMeta(): SessionMeta | undefined {
      try {
        const entries = ctx.sessionManager.getEntries();

        // Step 1: Scan local entries for pipelineId and local meta snapshot
        let localPipelineId: string | undefined;
        let localMeta: SessionMeta | undefined;
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (
            entry.type === "custom" &&
            "customType" in entry &&
            entry.customType === PIPELINE_META_CUSTOM_TYPE
          ) {
            const data = (entry as { data?: unknown }).data;
            if (data && typeof data === "object") {
              if (!localMeta) localMeta = data as SessionMeta;
              if (!localPipelineId && (data as SessionMeta).pipelineId) {
                localPipelineId = (data as SessionMeta).pipelineId;
              }
              if (localMeta && localPipelineId) break;
            }
          }
        }

        // Step 2: Read shared source if available (use per-instance base dir)
        if (localPipelineId && instanceBaseDir) {
          try {
            const metaPath = path.join(instanceBaseDir, localPipelineId, "meta.json");
            const content = fs.readFileSync(metaPath, "utf-8");
            const shared = JSON.parse(content) as SessionMeta;
            // Only trust shared source if pipelineId matches (guard against stale files)
            if (shared && shared.pipelineId === localPipelineId) {
              // Check if the local entry has a _sharedStale flag, which means the
              // last shared source write failed. In that case, fall back to local
              // entries to prevent state regression from old shared data.
              if ((localMeta as any)?._sharedStale) {
                // Return local meta without the internal stale markers
                const { _sharedStale, _sharedStaleAt, ...cleanLocal } = localMeta as any;
                return cleanLocal as SessionMeta;
              }
              return shared;
            }
          } catch {
            // Shared source doesn't exist or is unreadable — fall through to local
          }
        }

        // Step 3: Fall back to local entries
        return localMeta;
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

        // Write 1: appendEntry (local session)
        pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, merged);

        // Write 2: meta.json (shared source, fail-open; use per-instance base dir)
        if (merged.pipelineId && instanceBaseDir) {
          try {
            const metaDir = path.join(instanceBaseDir, merged.pipelineId);
            fs.mkdirSync(metaDir, { recursive: true });
            const metaPath = path.join(metaDir, "meta.json");
            fs.writeFileSync(metaPath, JSON.stringify(merged, null, 2), "utf-8");
          } catch (sharedErr) {
            // Fail-open: log but don't block pipeline.
            // Mark shared source as stale in the local entry so that getMeta
            // can detect and fall back to local entries on next read,
            // preventing partial-failure amplification (old shared source
            // overriding newer local state).
            const errMsg = sharedErr instanceof Error ? sharedErr.message : String(sharedErr);
            safeWriteAuditLog("session_state_error", {
              operation: "updateMeta_shared",
              error: errMsg,
            }, "warn");

            // Stamp local entry with sharedStale flag so getMeta detects it
            try {
              const staleMerged = { ...merged, _sharedStale: true, _sharedStaleAt: Date.now() };
              pi.appendEntry(PIPELINE_META_CUSTOM_TYPE, staleMerged);
            } catch {
              // Best-effort: if even this fails, local state is still consistent
            }
          }
        }

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
            // Use real timestamp from entry metadata if available;
            // fall back to Date.now() for consistent unit with stageStartTime.
            const entryAny = entry as unknown as { timestamp?: unknown; createdAt?: unknown };
            const ts = typeof entryAny.timestamp === "number"
              ? entryAny.timestamp
              : (typeof entryAny.createdAt === "number" ? entryAny.createdAt : Date.now());
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
            // When exitCode cannot be parsed, leave it undefined.
            // command-verifier's trySelfVerifySkip conservatively skips records with
            // undefined exitCode (does NOT treat as success), preventing false positives.
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
