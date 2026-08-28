/**
 * @module hash
 * Shared utility for computing file content hashes.
 * Used by tool-guard (oldHash recording) and loop-breaker (diff archiving).
 */

import { createReadStream } from "node:fs";
import fsSync from "node:fs";
import crypto from "node:crypto";

/**
 * Computes the SHA-256 hash of a file's content using streaming I/O.
 * Memory O(1) regardless of file size — reads in chunks via createReadStream.
 * Returns "file-not-exists" if the file cannot be read.
 *
 * @param filePath - Absolute path to the file
 * @returns Hex-encoded SHA-256 hash or fallback string
 */
export async function getFileHash(filePath: string): Promise<string> {
  try {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } catch {
    return "file-not-exists";
  }
}

/**
 * Synchronous SHA-256 hash of a file (shared with summary-hash).
 * Returns null on read error.
 *
 * @param filePath - Absolute path to the file
 * @returns Hex-encoded SHA-256 hash or null if file cannot be read
 */
export function computeFileHashSync(filePath: string): string | null {
  try {
    const content = fsSync.readFileSync(filePath, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Computes the SHA-256 hash of a string content.
 * Used for prompt snapshot hashing (audit trail).
 *
 * @param content - String content to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function computeStringHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
