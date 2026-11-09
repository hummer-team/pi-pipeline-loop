/**
 * @module fix-report-write-guard
 * The fix-stage REVIEW REPORT write whitelist, shared by every exit that can
 * leave the fix stage:
 *
 * - `verify-advance.applyVerifyPass` (hook settle + `pipeline_verify`), and
 * - `stage-advancer` `stage_advance` (a direct owner-driven exit),
 *
 * so a bound fix exit can never bypass the check by picking a different entry
 * point. The fix executor may answer the review report ONLY in its allowed
 * fields: `是否修复` / `状态` / `disposition` and `证据` / `evidence`. Everything
 * else — finding text, severity, ids — must stay byte-stable
 * (see `verifiers/fix-report-edit-verifier`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { PipelineConfig, SessionMeta } from "../types";
import { codeReviewDocFileName, docsDirsOf, reqBaseFromRequirementDoc } from "../docs-paths";
import { verifyFixReportEditsAgainstHash } from "./verifiers/fix-report-edit-verifier";

/** Refusal copy shared by every fix-exit caller (the owner sees one wording). */
export const FIX_REPORT_EDIT_VIOLATION_MESSAGE =
  "Fix report write-scope violation: only 是否修复/状态 and 证据 lines may change. Nothing advanced.";

/**
 * Resolve the protected-body violation of the fix stage's review report.
 *
 * `null` means "nothing to refuse": either no baseline was captured at the
 * review→fix routing, or the report is unreadable. A missing baseline NEVER
 * fabricates a violation (fail-open on absence, fail-closed on an actual
 * protected-body change). The caller writes the `fix_report_edit_violation`
 * audit record so the refusal is attributable to its own entry point.
 */
export async function checkFixReportWriteWhitelist(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<string | null> {
  const baselineHash = meta.reviewReportHashAtFixStart;
  if (baselineHash === undefined) return null;
  const round = meta.reviewRound?.index ?? 1;
  const reportPath = path.join(
    config.projectRoot,
    docsDirsOf(config).reviewDir,
    codeReviewDocFileName(reqBaseFromRequirementDoc(meta.requirementDoc ?? ""), round),
  );
  let content: string;
  try {
    content = await fs.readFile(reportPath, "utf-8");
  } catch {
    return null;
  }
  const verdict = verifyFixReportEditsAgainstHash({ baselineHash, current: content });
  return verdict.ok ? null : verdict.violations.join("; ");
}