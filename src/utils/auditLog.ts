/**
 * @module auditLog
 * Centralized audit log writer.
 * Provides initAuditLog (path resolution + directory creation),
 * getDateAuditFileName (date-rotated log filename), and
 * writeAuditLog (formatted text-line appender).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AuditLogLevel, PipelineConfig } from "../types";

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
 * - info (default): `YYYY-MM-DD HH:mm:ss - {stage} | key1=val1 | key2=val2`
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

  // Only warn/error get a prefix; info remains backward compatible (no prefix)
  const levelPrefix = level === "warn" ? "[WARN] " : level === "error" ? "[ERROR] " : "[INFO]";
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

/**
 * Resets the module-level auditDirPath to empty string.
 * FOR TESTING ONLY — allows tests to verify the uninitialized guard behavior.
 */
export function __resetAuditDirPath(): void {
  auditDirPath = "";
}
