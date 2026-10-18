/**
 * @module design-review/update-artifact
 * 194 Phase 0 (C1): standalone design-review UPDATE receipt artifact contract.
 *
 * A plan-revision operation must NOT append its process receipt to the plan
 * body any more. New operations pin a descriptor pointing at an independent
 * receipt document that lives next to the original plan:
 *
 *   `{planDir}/Design_Review_Update_{round}_{operationId}_{reqBase}_Design.md`
 *
 * The path is ALWAYS plugin-derived (never model-supplied), so a revision
 * attempt can neither escape the plan directory nor pick "the latest file".
 *
 * Legacy operations (created before this feature) carry no descriptor and may
 * still be READ with their embedded `## Design Review Update` section — that
 * compatibility window is entered only by the ABSENCE of the descriptor, never
 * by a malformed one (fail-closed, no silent downgrade).
 *
 * This file stays import-free (pure type/value declarations + pure helpers)
 * so `src/types.ts` can bridge these types without a module cycle.
 */

import crypto from "node:crypto";
import path from "node:path";
import { reqBaseFromPlanStem, updateReceiptFileName } from "../naming/doc-naming";

/** Format discriminator of a standalone update descriptor. */
export const STANDALONE_UPDATE_FORMAT = "standalone-v1" as const;

/** Heading of the legacy embedded receipt section inside a plan body. */
export const LEGACY_UPDATE_SECTION_HEADING = "Design Review Update";

/**
 * 201 Phase 4: standalone receipts adopt the doc-naming contract
 * (`Design_Review_Update_{round}_{operationId}_{reqBase}_Design.md`,
 * hard switch). The prefix constant was therefore removed.
 */

/**
 * Plugin operation ids are UUID v4. The pattern doubles as the path-injection
 * guard: anything else (slashes, `..`, globs, newlines) can never reach join().
 */
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lower-case hex SHA-256 digest. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 194 C1: descriptor pinned onto a `DesignReviewOperation` when the update
 * receipt is rendered OUTSIDE the plan body.
 */
export interface StandaloneUpdateArtifact {
  readonly format: "standalone-v1";
  /** Absolute, plugin-derived receipt path — never model-supplied */
  readonly receiptDoc: string;
  /**
   * Fence-aware ordered SHA-256 digest of the legacy update sections present
   * in the plan at preparation time. The EMPTY set is hashed too, so "no
   * baseline" is a positive statement rather than a missing field.
   */
  readonly baselineSectionsHash: string;
}

/** Narrowed, trusted view of an operation's update output binding. */
export type UpdateArtifactNarrow =
  | { ok: true; kind: "legacy" }
  | { ok: true; kind: "standalone"; receiptDoc: string; baselineSectionsHash: string }
  | { ok: false; reason: string };

/**
 * Derive the canonical standalone receipt path for one update operation.
 *
 * Returns null when any identity component is invalid — the caller must then
 * block dispatch instead of guessing a path.
 *
 * @param planDoc - Canonical absolute path of the plan under revision
 * @param round - Design-review round (positive integer)
 * @param operationId - Plugin-issued UUID v4 operation id
 */
export function deriveStandaloneReceiptPath(
  planDoc: string,
  round: number,
  operationId: string,
): string | null {
  if (typeof planDoc !== "string" || planDoc.length === 0 || !path.isAbsolute(planDoc)) {
    return null;
  }
  if (!Number.isInteger(round) || round <= 0) {
    return null;
  }
  if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
    return null;
  }
  const base = path.parse(planDoc).name; // spaces / CJK are preserved verbatim
  if (base.length === 0) return null;
  const reqBase = reqBaseFromPlanStem(base);
  return path.join(
    path.dirname(planDoc),
    updateReceiptFileName(reqBase, round, operationId),
  );
}

/**
 * Compute the baseline digest of the legacy update sections found in a plan
 * body. Ordering is the document order of extraction; the empty set still
 * produces a stable digest (no content is stored, only the hash).
 */
export function computeBaselineSectionsHash(sections: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sections.map((s) => s)), "utf-8")
    .digest("hex");
}

/** True when a markdown heading line names the legacy update section. */
function isUpdateHeading(line: string): boolean {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) return false;
  return match[2].trim().toLowerCase() === LEGACY_UPDATE_SECTION_HEADING.toLowerCase();
}

/** Heading level (`#` count) of a markdown heading line, or null. */
function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1].length : null;
}

/**
 * Fence-aware extraction of every legacy `## Design Review Update` section in
 * a plan body (heading line included, terminated by the next heading of equal
 * or higher level, outside fences). Content inside ``` or ~~~ fences never
 * starts or terminates a section.
 */
export function extractLegacyUpdateSections(planContent: string): string[] {
  const lines = planContent.split(/\r?\n/);
  const sections: string[] = [];
  let fenceMarker: string | null = null;
  let current: string[] | null = null;
  let currentLevel = 0;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fenceMarker === null) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
      if (current) current.push(line);
      continue;
    }
    if (fenceMarker !== null) {
      if (current) current.push(line);
      continue;
    }

    const level = headingLevel(line);
    if (level === null) {
      if (current) current.push(line);
      continue;
    }
    // A heading at the same or a higher level closes the open section.
    if (current && level <= currentLevel) {
      sections.push(current.join("\n"));
      current = null;
    }
    if (isUpdateHeading(line)) {
      current = [line];
      currentLevel = level;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) sections.push(current.join("\n"));
  return sections;
}

/** Read a non-empty trimmed string field from an unknown record. */
function readStringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

/**
 * 194 C1: narrow an operation's persisted `updateArtifact` against the
 * operation's own identity.
 *
 * - absent descriptor   → `legacy`  (READ compatibility only; the caller must
 *   separately prove the operation pre-dates this feature)
 * - valid descriptor    → `standalone` with the pinned absolute receipt path
 * - malformed / unknown format / path drift → `ok:false` (NEVER a downgrade)
 *
 * @param input - The persisted descriptor (unknown until proven)
 * @param planDoc - Plan bound to the operation (identity component)
 * @param round - Round bound to the operation (identity component)
 * @param operationId - Operation id bound to the descriptor (identity component)
 */
export function narrowUpdateArtifact(
  input: unknown,
  planDoc: string,
  round: number,
  operationId: string,
): UpdateArtifactNarrow {
  if (input === undefined) return { ok: true, kind: "legacy" };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "update_artifact_not_object" };
  }
  const obj = input as Record<string, unknown>;

  const format = readStringField(obj, "format");
  if (format !== STANDALONE_UPDATE_FORMAT) {
    return { ok: false, reason: "update_artifact_unknown_format" };
  }
  const receiptDoc = readStringField(obj, "receiptDoc");
  if (receiptDoc === null) return { ok: false, reason: "update_artifact_missing_receipt_doc" };
  const baselineSectionsHash = readStringField(obj, "baselineSectionsHash");
  if (baselineSectionsHash === null) {
    return { ok: false, reason: "update_artifact_missing_baseline_hash" };
  }
  if (!HASH_PATTERN.test(baselineSectionsHash)) {
    return { ok: false, reason: "update_artifact_baseline_hash_malformed" };
  }
  if (!path.isAbsolute(receiptDoc)) {
    return { ok: false, reason: "update_artifact_receipt_not_absolute" };
  }

  const expected = deriveStandaloneReceiptPath(planDoc, round, operationId);
  if (expected === null) return { ok: false, reason: "update_artifact_identity_invalid" };
  if (path.resolve(receiptDoc) !== expected) {
    return { ok: false, reason: "update_artifact_receipt_path_drift" };
  }
  return { ok: true, kind: "standalone", receiptDoc: expected, baselineSectionsHash };
}

/**
 * Build the descriptor a new update operation must pin. Returns null when the
 * identity cannot produce a safe path (caller blocks instead of guessing).
 *
 * @param planDoc - Canonical absolute plan path
 * @param round - Round of the new update operation
 * @param operationId - Plugin-issued UUID v4 for the new operation
 * @param baselineSections - Fence-aware legacy sections extracted from the plan
 */
export function createStandaloneUpdateArtifact(
  planDoc: string,
  round: number,
  operationId: string,
  baselineSections: readonly string[],
): StandaloneUpdateArtifact | null {
  const receiptDoc = deriveStandaloneReceiptPath(planDoc, round, operationId);
  if (receiptDoc === null) return null;
  return {
    format: STANDALONE_UPDATE_FORMAT,
    receiptDoc,
    baselineSectionsHash: computeBaselineSectionsHash(baselineSections),
  };
}
