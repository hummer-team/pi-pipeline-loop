/**
 * @module pipeline-meta-transaction
 * 193 Phase 2: the exclusive cross-writer commit boundary for the SHARED
 * pipeline meta.json at `{baseDir}/{pipelineId}/meta.json`.
 *
 * Design (plan 193 Phase 2 tasks 1/3):
 * - The lock is a directory created ATOMICALLY with `mkdirSync` (EEXIST is
 *   the single portable "someone else holds it" signal on local filesystems).
 *   The owner writes a token + pid/host/createdAt INSIDE the lock directory.
 * - Acquisition is synchronous, ONE attempt, never a spin and never awaited:
 *   callers must handle `busy` honestly (strict commits report a conflict,
 *   plain writers refuse to fake success).
 * - The lock protects exactly
 *   "authoritative read → expectation compare → merge → shared publish →
 *   read-back". Menus and RPC dispatches NEVER run under the lock.
 * - Publishing meta.json uses a unique temp file in the SAME directory,
 *   fsync, then an atomic rename, so readers can never observe half-written
 *   JSON. This is runtime-metadata publishing only; no repository source
 *   file is ever renamed or moved.
 * - Release requires the caller's OWN token. A crashed holder's lock stays
 *   in place (fail-closed): a human must confirm that every writer for this
 *   pipeline has stopped, then remove the EXACT residual lock directory.
 *   There is NO lease timer and NO automatic stealing, because deleting a
 *   lock never proves the holder's send-intent was unsent.
 * - Scope: same-machine local filesystems only. This is explicitly NOT a
 *   network / multi-host distributed lock.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/** Directory name of the exclusive write lock (inside the pipeline dir). */
export const META_LOCK_DIR_NAME = ".meta-write-lock";
/** Owner-metadata file inside the lock directory. */
export const META_LOCK_OWNER_FILE = "owner.json";
/** The shared meta file name published under the lock. */
export const META_FILE_NAME = "meta.json";

/** Identity written by the lock holder so a busy contender can report WHO owns the lock. */
export interface MetaLockOwner {
  /** Random per-acquisition token; the ONLY key that may release the lock. */
  token: string;
  /** Holding process id (same-machine evidence, never a lease) */
  pid: number;
  /** Host name (evidence for multi-machine misconfiguration; NOT supported as distributed lock) */
  host: string;
  /** Wall-clock acquisition time (diagnostic only, never used for expiry) */
  createdAt: number;
}

export type MetaLockAcquisition =
  | { status: "acquired"; lockDir: string; token: string; owner: MetaLockOwner }
  | { status: "busy"; lockDir: string; owner?: MetaLockOwner }
  | {
      status: "unavailable";
      reason: "pipeline_dir_failed" | "lock_create_failed" | "owner_publish_failed";
      error?: string;
    };

export type MetaLockRelease =
  | { ok: true }
  | { ok: false; reason: "owner_missing" | "not_owner" | "remove_failed"; error?: string };

export type MetaPublishResult = { ok: true } | { ok: false; error: string };

/** Absolute path of the per-pipeline shared directory. */
export function sharedPipelineDir(baseDir: string, pipelineId: string): string {
  return path.join(baseDir, pipelineId);
}

/** Absolute path of the exclusive lock directory for one pipeline. */
export function metaLockDirPath(baseDir: string, pipelineId: string): string {
  return path.join(sharedPipelineDir(baseDir, pipelineId), META_LOCK_DIR_NAME);
}

/** Best-effort read of the current lock owner; any problem yields undefined. */
export function readMetaLockOwner(lockDir: string): MetaLockOwner | undefined {
  try {
    const raw = fs.readFileSync(path.join(lockDir, META_LOCK_OWNER_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<MetaLockOwner> | null;
    if (
      !parsed
      || typeof parsed.token !== "string"
      || typeof parsed.pid !== "number"
      || typeof parsed.host !== "string"
      || typeof parsed.createdAt !== "number"
    ) {
      return undefined;
    }
    return parsed as MetaLockOwner;
  } catch {
    return undefined;
  }
}

/**
 * ONE non-blocking acquisition attempt. Never spins, never awaits, never
 * steals an existing lock — busy/unavailable are honest return values the
 * caller must surface (conflict/unavailable), not retry away.
 */
export function tryAcquireMetaLock(baseDir: string, pipelineId: string): MetaLockAcquisition {
  const dir = sharedPipelineDir(baseDir, pipelineId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      status: "unavailable",
      reason: "pipeline_dir_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const lockDir = path.join(dir, META_LOCK_DIR_NAME);
  try {
    // Non-recursive mkdir: EEXIST is the atomic "already held" signal.
    fs.mkdirSync(lockDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      // Held elsewhere (or a crashed holder's residual). Keep it, report the
      // owner evidence we can read; missing owner metadata stays fail-closed.
      return { status: "busy", lockDir, owner: readMetaLockOwner(lockDir) };
    }
    return {
      status: "unavailable",
      reason: "lock_create_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const owner: MetaLockOwner = {
    token: crypto.randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    createdAt: Date.now(),
  };
  try {
    fs.writeFileSync(path.join(lockDir, META_LOCK_OWNER_FILE), JSON.stringify(owner), "utf-8");
  } catch (err) {
    // Could not record ownership → we may NOT keep a lock nobody can audit.
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return {
      status: "unavailable",
      reason: "owner_publish_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { status: "acquired", lockDir, token: owner.token, owner };
}

/**
 * Release ONLY with the acquisition token. A token mismatch or missing owner
 * file never deletes a lock another writer may still hold; a failed removal
 * is surfaced so the caller can stop instead of proceeding to the next action.
 */
export function releaseMetaLock(lockDir: string, token: string): MetaLockRelease {
  const owner = readMetaLockOwner(lockDir);
  if (!owner) {
    return { ok: false, reason: "owner_missing" };
  }
  if (owner.token !== token) {
    return { ok: false, reason: "not_owner" };
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, reason: "remove_failed", error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

/**
 * Atomically publish the shared meta.json: unique temp file in the SAME
 * directory → write → fsync → rename. Readers therefore never see a partial
 * JSON document, and a failed publish leaves the previous file intact. The
 * temp name is process- and entropy-scoped, so cleanup only ever touches
 * this writer's own file.
 */
export function publishSharedMeta(pipelineDir: string, contents: string): MetaPublishResult {
  const tmpName = `${META_FILE_NAME}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(pipelineDir, tmpName);
  const finalPath = path.join(pipelineDir, META_FILE_NAME);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "wx");
    fs.writeFileSync(fd, contents, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, finalPath);
    return { ok: true };
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* our own temp file; ignoring a missing one is safe */
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
