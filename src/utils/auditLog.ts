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
 *   When meta already contains prompt_hash (e.g., "full" mode callers), the function
 *   skips the automatic append to avoid duplicate keys in the snapshot line.
 *
 * Per-pipeline routing (Phase 0 / 197_Feat):
 *   Audit writes are routed to `{auditDir}/{pipelineId}/log/YYYYMMDD_audit.log`.
 *   Unattributable events (pipelineId empty) fall back to `{auditDir}/system/log/...`.
 *   Routing is resolved via `resolveAuditPipelineId()`; directory creation is lazy
 *   via `ensureAuditLogDir()`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { computeStringHash } from "./hash";
import type { AuditLogLevel, PipelineConfig, SessionMeta } from "../types";
import { buildStageSequence } from "./stage-sequence";
import { resolveAuditDir } from "./work-dir";

/** Resolved absolute path to the audit log base directory. */
let auditDirPath = "";

/** Routing context: pipelineId of the pipeline the current event belongs to. */
let auditPipelineId = "";

/** Audit log dirs whose creation has been confirmed in this process. */
const ensuredAuditDirs = new Set<string>();

/**
 * Initializes the audit log directory.
 *
 * Resolves `projectRoot + auditDir` to an absolute path, stores it in
 * module scope. Per-pipeline subdirectories are created lazily by
 * `ensureAuditLogDir` on first write — no eager `mkdir` here.
 *
 * Must be called once before `writeAuditLog` is used (typically at
 * pipeline startup in `createPipeline`).
 *
 * Zero-write gate (Phase 2 / 184_Bug D3): when `config.isFallbackTemplate`
 * is true (in-memory template fallback, no config file on disk), this function
 * is a no-op — `auditDirPath` stays empty, and `safeWriteAuditLog` (L93 guard)
 * silently drops all writes. No directories are created on disk.
 *
 * @param config - The pipeline configuration
 */
export async function initAuditLog(config: PipelineConfig): Promise<void> {
  // Phase 2 / 184_Bug (D3): fallback registration must not create any files.
  // Skip directory creation; safeWriteAuditLog's L93 no-op guard handles the rest.
  if (config.isFallbackTemplate) return;

  const auditDir = resolveAuditDir(config);
  auditDirPath = path.resolve(config.projectRoot, auditDir);
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

// ─── Per-pipeline routing helpers (197_Feat Phase 0) ──────────────────────────

/**
 * Resolves the audit pipelineId via a four-step priority chain.
 *
 * Priority: explicit (param) > message.pipelineId > context binding > ""
 *
 * @param message - Optional message object that may carry a pipelineId field
 * @param explicitPipelineId - Optional explicit pipelineId passed directly by the caller
 * @returns The resolved pipelineId string (may be empty)
 */
function resolveAuditPipelineId(
  message?: { pipelineId?: string },
  explicitPipelineId?: string,
): string {
  // Step 1: explicit parameter (highest priority)
  if (explicitPipelineId && explicitPipelineId.length > 0) {
    return explicitPipelineId;
  }
  // Step 2: message.pipelineId (message carries its own attribution)
  if (message?.pipelineId && message.pipelineId.length > 0) {
    return message.pipelineId;
  }
  // Step 3: context binding (module-level auditPipelineId)
  if (auditPipelineId && auditPipelineId.length > 0) {
    return auditPipelineId;
  }
  // Step 4: fallback to empty string (will route to system/log)
  return "";
}

/**
 * Enriches the message object with the resolved pipelineId attribution.
 *
 * - If the message already carries a pipelineId field, returns the original object (no mutation).
 * - If the resolved pipelineId is non-empty, returns a new object with pipelineId injected.
 * - If the resolved pipelineId is empty, returns the original object (no injection).
 *
 * This preserves the caller object immutability and ensures log lines always
 * carry their pipelineId attribution for post-hoc analysis.
 *
 * @param message - The original message object (not mutated)
 * @param routedId - The resolved pipelineId for this write
 * @returns The enriched message (new object if injected, same reference otherwise)
 */
function withPipelineId<T extends Record<string, unknown>>(
  message: T | undefined,
  routedId: string,
): T | undefined {
  if (!routedId) return message; // No injection if routedId is empty
  // Always inject/override with the routedId for consistency between directory and log content
  if (!message) return { pipelineId: routedId } as unknown as T;
  return { ...message, pipelineId: routedId } as T;
}

/**
 * Resolves the audit log directory for a given pipelineId.
 *
 * - pipelineId non-empty → auditDirPath / pipelineId / log
 * - pipelineId empty       → auditDirPath / system / log
 *
 * This is the single routing entry point; no other function may construct
 * audit log paths from auditDirPath directly.
 *
 * @param pipelineId - The pipelineId to route to (empty for system)
 * @returns The resolved absolute audit log directory path
 */
function auditLogDirFor(pipelineId: string): string {
  const segment = pipelineId && pipelineId.length > 0 ? pipelineId : "system";
  return path.join(auditDirPath, segment, "log");
}

/**
 * Ensures a directory exists, creating it recursively if needed.
 *
 * Writes are skipped when auditDirPath is uninitialized (initAuditLog not called).
 * Per-pipeline directories are cached in ensuredAuditDirs to avoid repeated mkdir calls.
 *
 * @param dir - The directory path to ensure exists
 */
async function ensureAuditLogDir(dir: string): Promise<void> {
  if (!auditDirPath) return;
  if (ensuredAuditDirs.has(dir)) return;
  await fs.mkdir(dir, { recursive: true });
  ensuredAuditDirs.add(dir);
}

/**
 * Runs a callback within a scoped audit routing context (runWithAuditPipelineContext).
 *
 * Used by callers that have a pipelineId available (e.g. meta.pipelineId)
 * to route events to the correct pipeline directory without mutating global state.
 *
 * After the callback completes, the previous auditPipelineId is restored.
 *
 * @param pipelineId - The pipelineId to use during the callback (may be undefined)
 * @param fn - The callback to execute with the routing context set
 * @returns Promise that resolves with the callback's return value
 */
export async function runWithAuditPipelineContext<T>(
  pipelineId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = auditPipelineId;
  // Only override context when pipelineId is explicitly provided
  if (pipelineId !== undefined) {
    auditPipelineId = pipelineId;
  }
  try {
    return await fn();
  } finally {
    auditPipelineId = previous;
  }
}

/**
 * Permanently sets the audit routing pipelineId context.
 *
 * Used by lifecycle entry points (birth, recovery, JOIN) to bind the module-level
 * auditPipelineId so that subsequent writeAuditLog calls route to the correct
 * pipeline directory without needing an explicit override.
 *
 * @param pipelineId - The pipelineId to bind (null/undefined clears to "")
 */
export function setAuditPipelineContext(pipelineId: string | null | undefined): void {
  auditPipelineId = (pipelineId ?? "").trim();
}

/**
 * Binds the audit routing context and pre-creates the pipeline's audit log directory.
 *
 * Combines setAuditPipelineContext + auditLogDirFor + ensureAuditLogDir into a single
 * call for the three birth points (pipeline-start ×2, flow-state restart).
 *
 * @param pipelineId - The new pipelineId to bind and pre-create
 */
export async function prepareAuditPipelineLog(pipelineId: string): Promise<void> {
  setAuditPipelineContext(pipelineId);
  const dir = auditLogDirFor(pipelineId);
  await ensureAuditLogDir(dir);
}

// ─── Core audit writers ────────────────────────────────────────────────────────

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
  message?: Record<string, string | boolean>,
  level: AuditLogLevel = "info",
  explicitPipelineId?: string,
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

  // Route-then-enrich: resolve pipelineId, enrich message, serialize (single
  // assembly path — review round-2 M1: former duplicate `line` serializer was
  // dead code and a byte-format drift trap; enrichedLine is the only format)
  const routedId = resolveAuditPipelineId(message, explicitPipelineId);
  const outMessage = withPipelineId(message, routedId);

  const logDir = auditLogDirFor(routedId);
  await ensureAuditLogDir(logDir);

  // Rebuild line with enriched message (ensures pipelineId attribution in log content)
  let enrichedLine = `${datePart} ${timePart} - ${levelPrefix}${stage}`;
  if (outMessage && Object.keys(outMessage).length > 0) {
    for (const [k, v] of Object.entries(outMessage)) {
      enrichedLine += ` | ${k}=${v}`;
    }
  }

  const logPath = path.join(logDir, getDateAuditFileName());
  await fs.appendFile(logPath, enrichedLine + "\n");
}

/**
 * Safe wrapper around writeAuditLog that never throws.
 *
 * Used in error-path call sites (Phase 1 catch blocks) where audit failure
 * must not alter business control flow. Any error is silently swallowed.
 *
 * @param stage      - The pipeline stage or action name
 * @param message    - Optional key-value pairs to append after the stage
 * @param level      - Log severity level (default "info")
 * @param pipelineId - Optional pipelineId for routing (transparent to caller)
 */
export async function safeWriteAuditLog(
  stage: string,
  message?: Record<string, string | boolean>,
  level?: AuditLogLevel,
  pipelineId?: string,
): Promise<void> {
  // Test override: when set, delegate to the replacement (which may throw)
  if (_safeWriteOverride) return _safeWriteOverride(stage, message, level);
  try {
    await runWithAuditPipelineContext(pipelineId, () => writeAuditLog(stage, message, level, pipelineId));
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
  explicitPipelineId?: string,
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

  // Route-then-enrich: resolve pipelineId, enrich message, serialize
  const routedId = resolveAuditPipelineId(message, explicitPipelineId);
  const outMessage = withPipelineId(message, routedId);

  // Build metadata single-line event (same format as writeAuditLog)
  // D5: Only append prompt_hash if not already present in meta (avoids duplicate keys)
  let metaLine = `${datePart} ${timePart} - [INFO] ${stage}`;
  let hasPromptHash = false;
  if (outMessage && Object.keys(outMessage).length > 0) {
    for (const [k, v] of Object.entries(outMessage)) {
      metaLine += ` | ${k}=${v}`;
      if (k === "prompt_hash") hasPromptHash = true;
    }
  }
  if (!hasPromptHash) {
    metaLine += ` | prompt_hash=${computeStringHash(prompt)}`;
  }

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

  // Route to per-pipeline directory using already-resolved routedId
  const logDir = auditLogDirFor(routedId);
  await ensureAuditLogDir(logDir);

  const logPath = path.join(logDir, getDateAuditFileName());
  await fs.appendFile(logPath, snapshotBlock);
}

/**
 * Safe wrapper around writePromptSnapshot that never throws.
 *
 * Used in hot paths where audit failure must not alter business control flow.
 * Any error is silently swallowed.
 *
 * @param stage      - Fixed string "prompt_snapshot" identifying the event type
 * @param message    - Key-value metadata (must include stage, pipelineId, source)
 * @param prompt     - The rendered plugin prompt content (may be multiline)
 * @param pipelineId - Optional pipelineId for routing (transparent to caller)
 */
export async function safeWritePromptSnapshot(
  stage: string,
  message: Record<string, string>,
  prompt: string,
  pipelineId?: string,
): Promise<void> {
  try {
    await runWithAuditPipelineContext(pipelineId, () => writePromptSnapshot(stage, message, prompt, pipelineId));
  } catch {
    // Audit failure must never alter business control flow
  }
}

// ─── Test hooks ────────────────────────────────────────────────────────────────

/** @internal — FOR TESTING ONLY. Expose resolveAuditPipelineId for tests */
export const __resolveAuditPipelineId: (
  message?: { pipelineId?: string },
  explicitPipelineId?: string,
) => string = resolveAuditPipelineId;

/** @internal — FOR TESTING ONLY. Expose auditLogDirFor for tests */
export const __auditLogDirFor = auditLogDirFor;

/** @internal — FOR TESTING ONLY. Expose ensureAuditLogDir for tests */
export const __ensureAuditLogDir = ensureAuditLogDir;


/**
 * Resets all module-level audit routing state to initial values.
 * FOR TESTING ONLY — allows tests to start with a clean slate.
 */
export function __resetAuditRoutingState(): void {
  auditDirPath = "";
  auditPipelineId = "";
  ensuredAuditDirs.clear();
}

/**
 * Test-only: Set the audit pipeline ID context
 * @param pipelineId - The pipeline ID to set as context
 */
export function __setAuditPipelineId(pipelineId: string): void {
  auditPipelineId = pipelineId;
}


/**
 * Resets the module-level auditDirPath to empty string.
 * FOR TESTING ONLY — allows tests to verify the uninitialized guard behavior.
 * @deprecated Use __resetAuditRoutingState() instead
 */
export function __resetAuditDirPath(): void {
  auditDirPath = "";
  auditPipelineId = "";
  ensuredAuditDirs.clear();
}

/**
 * Sets the module-level auditDirPath to a custom value.
 * FOR TESTING ONLY — allows tests to point audit writes to invalid paths
 * to trigger real fs.write failures.
 */
export function __setAuditDirPath(dirPath: string): void {
  auditDirPath = dirPath;
  ensuredAuditDirs.clear();
}

/** Override for safeWriteAuditLog — when set, replaces the real implementation. FOR TESTING ONLY */
let _safeWriteOverride: ((stage: string, message?: Record<string, string | boolean>, level?: AuditLogLevel, explicitPipelineId?: string) => Promise<void>) | null = null;

/**
 * Replace safeWriteAuditLog with a custom implementation (or null to restore).
 * FOR TESTING ONLY — allows tests to verify fail-open catch branches in callers.
 */
export function __setSafeWriteAuditLogOverride(
  fn: ((stage: string, message?: Record<string, string | boolean>, level?: AuditLogLevel, explicitPipelineId?: string) => Promise<void>) | null,
): void {
  _safeWriteOverride = fn;
}

/**
 * Encode a value for single-line `key=value |` audit format.
 * Aligns with the existing protect-ask convention (| → %7C, = → %3D, newline → space).
 *
 * Audit log lines use `|` as field separator and `=` as key-value separator.
 * Values containing these characters would corrupt the line format if not escaped.
 *
 * @param value - Raw string value to encode
 * @returns Encoded string safe for audit log embedding
 */
export function encodeAuditValue(value: string): string {
  return value.replace(/\|/g, "%7C").replace(/=/g, "%3D").replace(/\n/g, " ");
}
