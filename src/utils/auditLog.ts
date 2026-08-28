/**
 * @module auditLog
 * Centralized audit log writer.
 * Provides initAuditLog (path resolution + directory creation),
 * getDateAuditFileName (date-rotated log filename),
 * writeAuditLog (formatted text-line appender), and
 * writePromptSnapshot / safeWritePromptSnapshot (multiline prompt snapshot writer).
 *
 * Multiline prompt snapshot protocol (E7):
 *   1. Metadata single-line event: `{date} {time} - [INFO] prompt_snapshot | stage=xxx | pipelineId=xxx | source=yml|fallback`
 *   2. `=== PROMPT START ===`
 *   3. Multiline raw prompt content (preserved as-is)
 *   4. `=== PROMPT END ===`
 *   5. Trailing blank line to separate from next event
 *
 * Event naming convention (Phase 6 / 161_Feat):
 *   - prompt_snapshot: combined system prompt (base + plugin)
 *   - prompt_snapshot_base: pi base system prompt only (placeholder when absent)
 *   - prompt_snapshot_plugin: plugin-injected prompt only
 *   All three events carry a prompt_hash metadata field for content identification.
 *
 * All snapshot lines are appended to `{auditDir}/YYYYMMDD_audit.log` alongside
 * regular single-line audit events.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { computeStringHash } from "./hash";
import type { AuditLogLevel, PipelineConfig, SessionMeta } from "../types";
import { buildStageSequence } from "./stage-sequence";

/** Resolved absolute path to the audit log directory. */
let auditDirPath = "";

/**
 * Initializes the audit log directory.
 *
 * Resolves `projectRoot + auditDir` to an absolute path, stores it in
 * module scope, and creates the directory recursively if it does not exist.
 *
 * Must be called once before `writeAuditLog` is used (typically at
 * pipeline startup in `createPipeline`).
 *
 * @param config - The pipeline configuration
 */
export async function initAuditLog(config: PipelineConfig): Promise<void> {
  const auditDir = config.auditDir || ".pi/audit";
  auditDirPath = path.resolve(config.projectRoot, auditDir);
  await fs.mkdir(auditDirPath, { recursive: true });
}

/**
 * Returns the date-rotated audit log filename.
 *
 * Format: `YYYYMMDD_audit.log` (e.g. `20260808_audit.log`).
 *
 * @returns The filename string for today's audit log
 */
export function getDateAuditFileName(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}_audit.log`;
}

/**
 * Writes a formatted audit log line and appends it to today's log file.
 *
 * Format:
 * - info (default): `YYYY-MM-DD HH:mm:ss - [INFO] {stage} | key1=val1 | key2=val2`
 * - warn:           `YYYY-MM-DD HH:mm:ss - [WARN] {stage} | key1=val1 | key2=val2`
 * - error:          `YYYY-MM-DD HH:mm:ss - [ERROR] {stage} | key1=val1 | key2=val2`
 *
 * If `message` is undefined or empty, only the timestamp and stage
 * are written (no trailing `|` separators).
 *
 * If `auditDirPath` has not been initialized (initAuditLog not called),
 * the function silently returns without writing or throwing.
 *
 * @param stage   - The pipeline stage or action name (e.g. "agent_settled")
 * @param message - Optional key-value pairs to append after the stage
 * @param level   - Log severity level (default "info"); "warn" and "error" add prefixes
 */
export async function writeAuditLog(
  stage: string,
  message?: Record<string, string>,
  level: AuditLogLevel = "info",
): Promise<void> {
  // Guard: if audit directory has not been initialized, silently skip
  if (!auditDirPath) return;

  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const timePart = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join(":");

  // All levels get a prefix: info=[INFO], warn=[WARN], error=[ERROR]
  const levelPrefix = level === "warn" ? "[WARN] " : level === "error" ? "[ERROR] " : "[INFO] ";
  let line = `${datePart} ${timePart} - ${levelPrefix}${stage}`;
  if (message && Object.keys(message).length > 0) {
    for (const [k, v] of Object.entries(message)) {
      line += ` | ${k}=${v}`;
    }
  }

  const logPath = path.join(auditDirPath, getDateAuditFileName());
  await fs.appendFile(logPath, line + "\n");
}

/**
 * Safe wrapper around writeAuditLog that never throws.
 *
 * Used in error-path call sites (Phase 1 catch blocks) where audit failure
 * must not alter business control flow. Any error is silently swallowed.
 *
 * @param stage   - The pipeline stage or action name
 * @param message - Optional key-value pairs to append after the stage
 * @param level   - Log severity level (default "info")
 */
export async function safeWriteAuditLog(
  stage: string,
  message?: Record<string, string>,
  level?: AuditLogLevel,
): Promise<void> {
  try {
    await writeAuditLog(stage, message, level);
  } catch {
    // Audit failure must never alter business control flow
  }
}

// ─── Stage audit writer (unified pipeline progression events) ─────────────────

/**
 * Unified audit log writer for pipeline progression events.
 *
 * Automatically enriches every log entry with a consistent snapshot of
 * pipeline state: `pipelineId`, `stage`, `sequence` (forward chain from
 * current stage via `buildStageSequence`), `loopCount`, and `maxLoops`.
 *
 * All stage-advancing events (stage_advance, pipeline_start, pipeline_state,
 * loop_check, pipeline_completed) MUST use this function instead of
 * `writeAuditLog` directly, ensuring uniform audit trail format.
 *
 * @param config - Pipeline configuration (required for sequence computation)
 * @param action - Event name (e.g. "stage_advance", "pipeline_completed")
 * @param meta   - Current session metadata
 * @param extra  - Optional additional key-value pairs to append
 * @param level  - Log severity level (default "info")
 */
export async function writeStageAudit(
  config: PipelineConfig,
  action: string,
  meta: SessionMeta,
  extra?: Record<string, string>,
  level: AuditLogLevel = "info",
): Promise<void> {
  // Guard: if audit directory has not been initialized, silently skip
  if (!auditDirPath) return;

  const sequence = buildStageSequence(config, meta.currentStage);

  const message: Record<string, string> = {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    sequence: sequence.join(","),
    loopCount: String(meta.loopCount),
    maxLoops: String(meta.maxLoops),
    ...extra,
  };

  await writeAuditLog(action, message, level);
}

/**
 * Safe wrapper around writeStageAudit that never throws.
 *
 * Used in hot paths where audit failure must not alter business control flow.
 *
 * @param config - Pipeline configuration (required for sequence computation)
 * @param action - Event name
 * @param meta   - Current session metadata
 * @param extra  - Optional additional key-value pairs
 * @param level  - Log severity level (default "info")
 */
export async function safeWriteStageAudit(
  config: PipelineConfig,
  action: string,
  meta: SessionMeta,
  extra?: Record<string, string>,
  level?: AuditLogLevel,
): Promise<void> {
  try {
    await writeStageAudit(config, action, meta, extra, level);
  } catch {
    // Audit failure must never alter business control flow
  }
}

// ─── Prompt snapshot markers (E7 protocol) ────────────────────────────────────

const PROMPT_SNAPSHOT_START = "=== PROMPT START ===";
const PROMPT_SNAPSHOT_END = "=== PROMPT END ===";

/**
 * Writes a multiline prompt snapshot to today's audit log file.
 *
 * Snapshot format:
 *   Line 1:  `{date} {time} - [INFO] prompt_snapshot | stage=xxx | pipelineId=xxx | source=...`
 *   Line 2:  `=== PROMPT START ===`
 *   Lines:   (multiline prompt content, preserved as-is)
 *   Line N:  `=== PROMPT END ===`
 *   Line N+1: (blank line separator)
 *
 * If `auditDirPath` has not been initialized (initAuditLog not called),
 * the function silently returns without writing or throwing.
 *
 * @param stage   - Fixed string "prompt_snapshot" identifying the event type
 * @param message - Key-value metadata (must include stage, pipelineId, source)
 * @param prompt  - The rendered plugin prompt content (may be multiline)
 */
export async function writePromptSnapshot(
  stage: string,
  message: Record<string, string>,
  prompt: string,
): Promise<void> {
  // Guard: if audit directory has not been initialized, silently skip
  if (!auditDirPath) return;

  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const timePart = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join(":");

  // Build metadata single-line event (same format as writeAuditLog)
  // Append prompt_hash (SHA-256) for quick comparison / dedup
  let metaLine = `${datePart} ${timePart} - [INFO] ${stage}`;
  if (message && Object.keys(message).length > 0) {
    for (const [k, v] of Object.entries(message)) {
      metaLine += ` | ${k}=${v}`;
    }
  }
  metaLine += ` | prompt_hash=${computeStringHash(prompt)}`;

  // Build the full snapshot block with a real blank line after END
  // to separate from the next audit event (E7 protocol)
  const snapshotBlock = [
    metaLine,
    PROMPT_SNAPSHOT_START,
    prompt,
    PROMPT_SNAPSHOT_END,
    "", // produces \n after END
    "", // produces second \n → real blank line separator
  ].join("\n");

  const logPath = path.join(auditDirPath, getDateAuditFileName());
  await fs.appendFile(logPath, snapshotBlock);
}

/**
 * Safe wrapper around writePromptSnapshot that never throws.
 *
 * Used in hot paths where audit failure must not alter business control flow.
 * Any error is silently swallowed.
 *
 * @param stage   - Fixed string "prompt_snapshot" identifying the event type
 * @param message - Key-value metadata (must include stage, pipelineId, source)
 * @param prompt  - The rendered plugin prompt content (may be multiline)
 */
export async function safeWritePromptSnapshot(
  stage: string,
  message: Record<string, string>,
  prompt: string,
): Promise<void> {
  try {
    await writePromptSnapshot(stage, message, prompt);
  } catch {
    // Audit failure must never alter business control flow
  }
}

/**
 * Resets the module-level auditDirPath to empty string.
 * FOR TESTING ONLY — allows tests to verify the uninitialized guard behavior.
 */
export function __resetAuditDirPath(): void {
  auditDirPath = "";
}
