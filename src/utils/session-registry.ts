/**
 * @module session-registry
 * Session-to-pipeline mapping registry for subagent JOIN support.
 *
 * Registry file: `{projectRoot}/{auditDir}/session-registry.json`
 * Structure: `{ [sessionFile: string]: { sessionFile, pipelineId, registeredAt } }`
 *
 * Provides O(1) reverse lookup from session file to parent pipeline ID.
 * All operations are fail-open: missing/corrupt file → null + warn, never throws.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig } from "../types";
import { safeWriteAuditLog } from "./auditLog";

/**
 * Registry entry for a single session-to-pipeline mapping.
 */
interface RegistryEntry {
  /** Session file identifier (key in the registry map) */
  sessionFile: string;
  /** Pipeline ID this session belongs to */
  pipelineId: string;
  /** Unix timestamp (ms) when the entry was created/updated */
  registeredAt: number;
}

/** Full registry structure stored on disk. */
type RegistryMap = Record<string, RegistryEntry>;

/**
 * Resolves the absolute path to the session-registry.json file.
 *
 * @param config - Pipeline configuration (uses projectRoot + auditDir)
 * @returns Absolute path to the registry file
 */
export function resolveRegistryPath(config: PipelineConfig): string {
  const auditDir = config.auditDir || ".pi/audit";
  return path.resolve(config.projectRoot, auditDir, "session-registry.json");
}

/**
 * Reads and parses the session registry from disk.
 * Returns an empty map on any read/parse failure (fail-open).
 *
 * @param registryPath - Absolute path to the registry file
 * @returns Parsed registry map, or empty map on failure
 */
async function readRegistry(registryPath: string): Promise<RegistryMap> {
  try {
    const content = await fs.readFile(registryPath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RegistryMap;
    }
    return {};
  } catch {
    // File missing, unreadable, or corrupt JSON → fail-open
    return {};
  }
}

/**
 * Writes the registry map to disk atomically.
 * Creates parent directories if needed.
 *
 * @param registryPath - Absolute path to the registry file
 * @param registry - Registry map to persist
 */
async function writeRegistry(registryPath: string, registry: RegistryMap): Promise<void> {
  const dir = path.dirname(registryPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * Registers (upserts) a session-to-pipeline mapping.
 * Fail-open: any IO/write error is logged as warn and silently swallowed.
 *
 * @param config - Pipeline configuration
 * @param sessionFile - Session file identifier (from sessionManager.getSessionFile())
 * @param pipelineId - Pipeline ID to associate with this session
 */
export async function registerSession(
  config: PipelineConfig,
  sessionFile: string,
  pipelineId: string,
): Promise<void> {
  if (!sessionFile) return;

  try {
    const registryPath = resolveRegistryPath(config);
    const registry = await readRegistry(registryPath);

    registry[sessionFile] = {
      sessionFile,
      pipelineId,
      registeredAt: Date.now(),
    };

    await writeRegistry(registryPath, registry);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog(
      "session_registry",
      { action: "register", sessionFile, pipelineId, error: errMsg },
      "warn",
    );
  }
}

/**
 * Looks up the parent pipeline ID for a given session file.
 * Returns null if the session is not registered or the registry is corrupt.
 *
 * @param config - Pipeline configuration
 * @param parentSessionFile - Parent session file to look up
 * @returns Parent pipeline ID, or null if not found
 */
export async function lookupParentPipeline(
  config: PipelineConfig,
  parentSessionFile: string,
): Promise<string | null> {
  if (!parentSessionFile) return null;

  try {
    const registryPath = resolveRegistryPath(config);
    const registry = await readRegistry(registryPath);
    const entry = registry[parentSessionFile];
    return entry?.pipelineId ?? null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog(
      "session_registry",
      { action: "lookup", parentSessionFile, error: errMsg },
      "warn",
    );
    return null;
  }
}
