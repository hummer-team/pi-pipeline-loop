/**
 * @module hash
 * Shared utility for computing file content hashes.
 * Used by tool-guard (oldHash recording) and loop-breaker (diff archiving).
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";

/**
 * Computes the SHA-256 hash of a file's content.
 * Returns "file-not-exists" if the file cannot be read.
 *
 * @param filePath - Absolute path to the file
 * @returns Hex-encoded SHA-256 hash or fallback string
 */
export async function getFileHash(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return "file-not-exists";
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
