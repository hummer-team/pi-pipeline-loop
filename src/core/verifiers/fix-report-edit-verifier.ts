/**
 * @module verifiers/fix-report-edit-verifier
 * 229 Phase 7 (F7/问题 6): the fix-stage REVIEW REPORT write whitelist.
 *
 * The fix executor may answer the review report ONLY in its allowed fields:
 * `是否修复` (disposition/status) and `证据` (evidence). Everything else —
 * the finding text, the severity (等级), the ids — must stay byte-stable.
 * The comparison strips the ALLOWED lines from both texts and compares the
 * remainder byte-for-byte (hash of the stripped body), so a finding rewrite
 * or severity inflation is refused (`fix_report_edit_violation`).
 */

import { createHash } from "node:crypto";

/** Lines the fix stage MAY edit in the review report. */
const ALLOWED_FIELD_RE = /^[-*]?\s*(?:是否修复|状态|disposition|evidence|证据)\s*[:：]/i;

/** Strip the allowed-field lines; the remainder is the protected body. */
export function stripAllowedFixFields(content: string): string {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    if (ALLOWED_FIELD_RE.test(line.trim())) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** sha256 of the stripped (protected) body. */
function protectedHash(content: string): string {
  return createHash("sha256").update(stripAllowedFixFields(content), "utf-8").digest("hex");
}

export interface FixReportEditVerdict {
  ok: boolean;
  violations: string[];
}

/**
 * Byte-compare the PROTECTED bodies. `baseline` is the review report content
 * as it was BEFORE the fix dispatch (`reviewReportHashAtFixStart` holds its
 * protected hash — both callers derive it with {@link protectedFixReportHash});
 * `current` is the report as it stands at the fix exit.
 */
export function verifyFixReportEdits(input: {
  baseline: string;
  current: string;
}): FixReportEditVerdict {
  const baselineHash = protectedHash(input.baseline);
  const currentHash = protectedHash(input.current);
  if (baselineHash === currentHash) return { ok: true, violations: [] };
  return {
    ok: false,
    violations: [
      "fix_report_edit_violation — the review report's protected body changed: only 是否修复/状态 and 证据 lines may be edited by the fix stage (fix-report-edit-verifier)",
    ],
  };
}

/** The protected-body hash a caller stores as the fix-start baseline. */
export function protectedFixReportHash(content: string): string {
  return protectedHash(content);
}

/** Convenience: does a STORED baseline hash still match the live content? */
export function verifyFixReportEditsAgainstHash(input: {
  baselineHash: string;
  current: string;
}): FixReportEditVerdict {
  const currentHash = protectedHash(input.current);
  if (currentHash === input.baselineHash) return { ok: true, violations: [] };
  return {
    ok: false,
    violations: [
      "fix_report_edit_violation — the review report's protected body changed: only 是否修复/状态 and 证据 lines may be edited by the fix stage (fix-report-edit-verifier)",
    ],
  };
}
