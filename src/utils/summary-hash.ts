/**
 * @module summary-hash
 * Utility for verifying summary artifact integrity.
 *
 * Phase 4 (143): Detects manual edits to summary files by comparing
 * the recorded hash (in SessionMeta.summaries[stage].hash) against
 * the actual SHA-256 hash computed from the file on disk.
 *
 * Used by pipeline_handoff and stage_advance as a pre-condition check
 * to block progression when summaries have been modified externally.
 */

import { computeFileHashSync } from "./hash";

/**
 * Result of a single stage's hash verification.
 */
export interface SummaryHashCheck {
  /** The stage name */
  stage: string;
  /** Path to the summary file */
  path: string;
  /** Hash recorded in SessionMeta */
  recordedHash: string;
  /** True if hashes match (file is unmodified), false if mismatch */
  match: boolean;
  /** "ok" if match, "mismatch" if hashes differ, "missing" if file not found */
  status: "ok" | "mismatch" | "missing";
}

/**
 * Compute the SHA-256 hash of a file's content.
 * Delegates to the shared sync core in hash.ts.
 * Returns null if the file cannot be read.
 */
function computeFileHash(filePath: string): string | null {
  return computeFileHashSync(filePath);
}

/**
 * Verify the hash integrity of all summary artifacts tracked in SessionMeta.
 *
 * Iterates over `meta.summaries` entries that have both `path` and `hash`.
 * For each, computes the actual file hash and compares against the recorded hash.
 *
 * @param meta - Current session metadata
 * @returns Array of hash check results (one per summary entry)
 */
export function verifySummaryHash(meta: {
  summaries: Record<string, { path: string; hash: string; status?: string }>;
}): SummaryHashCheck[] {
  const results: SummaryHashCheck[] = [];

  if (!meta?.summaries || typeof meta.summaries !== "object") {
    return results;
  }

  for (const [stage, summary] of Object.entries(meta.summaries)) {
    if (!summary || !summary.path || !summary.hash) continue;

    const actualHash = computeFileHash(summary.path);

    if (actualHash === null) {
      results.push({
        stage,
        path: summary.path,
        recordedHash: summary.hash,
        match: false,
        status: "missing",
      });
    } else if (actualHash === summary.hash) {
      results.push({
        stage,
        path: summary.path,
        recordedHash: summary.hash,
        match: true,
        status: "ok",
      });
    } else {
      results.push({
        stage,
        path: summary.path,
        recordedHash: summary.hash,
        match: false,
        status: "mismatch",
      });
    }
  }

  return results;
}

/**
 * Check a single stage's summary hash integrity.
 *
 * Returns the hash check result for the specified stage, or undefined
 * if the stage has no summary entry.
 *
 * @param meta - Current session metadata
 * @param stage - The stage to check
 * @returns Hash check result, or undefined if no summary exists for the stage
 */
export function checkStageSummaryHash(
  meta: { summaries: Record<string, { path: string; hash: string; status?: string }> },
  stage: string,
): SummaryHashCheck | undefined {
  const summary = meta.summaries?.[stage];
  if (!summary || !summary.path || !summary.hash) return undefined;

  const actualHash = computeFileHash(summary.path);

  if (actualHash === null) {
    return {
      stage,
      path: summary.path,
      recordedHash: summary.hash,
      match: false,
      status: "missing",
    };
  } else if (actualHash === summary.hash) {
    return {
      stage,
      path: summary.path,
      recordedHash: summary.hash,
      match: true,
      status: "ok",
    };
  } else {
    return {
      stage,
      path: summary.path,
      recordedHash: summary.hash,
      match: false,
      status: "mismatch",
    };
  }
}

/**
 * Find the first summary with a hash mismatch (file modified manually).
 *
 * Returns the stage name of the first mismatched summary, or undefined
 * if all summaries are intact (or no summaries exist).
 *
 * This is the primary entry point for handoff/advance pre-checks:
 * if a mismatch is found, the tool should block progression and
 * instruct the user to confirm re-entry via stage_advance.
 *
 * @param meta - Current session metadata
 * @returns Stage name of first mismatch, or undefined if all OK
 */
export function findFirstMismatch(meta: {
  summaries: Record<string, { path: string; hash: string; status?: string }>;
}): string | undefined {
  const checks = verifySummaryHash(meta);
  // Block on both "mismatch" (file modified) and "missing" (file deleted) —
  // both indicate the summary has been changed externally.
  const mismatch = checks.find((c) => c.status === "mismatch" || c.status === "missing");
  return mismatch?.stage;
}
