/**
 * 229 Phase 7 (F7/问题 6): the fix-report EDIT verifier (unit level).
 * The flow-level wiring lives in attribution-events.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  stripAllowedFixFields,
  verifyFixReportEdits,
  verifyFixReportEditsAgainstHash,
  protectedFixReportHash,
} from "../../core/verifiers/fix-report-edit-verifier";

const BASE = [
  "# Code Review", "",
  "### 问题 1", "",
  "- 问题: xx.ts:45 代码实现不全",
  "- 等级：Blocker",
  "- 是否修复：待修复",
  "- 证据：",
].join("\n");

describe("229 Phase 7: stripAllowedFixFields", () => {
  it("only removes the allowed-field lines", () => {
    const stripped = stripAllowedFixFields(BASE);
    expect(stripped).toContain("xx.ts:45 代码实现不全");
    expect(stripped).toContain("等级：Blocker");
    expect(stripped).not.toContain("是否修复");
    expect(stripped).not.toContain("证据");
  });
});

describe("229 Phase 7: verifyFixReportEdits", () => {
  it("allowed-field edits pass; protected edits refuse naming fix_report_edit_violation", () => {
    const allowedEdit = BASE.replace("- 是否修复：待修复", "- 是否修复：已修复").replace("- 证据：", "- 证据：commit abc");
    expect(verifyFixReportEdits({ baseline: BASE, current: allowedEdit }).ok).toBe(true);
    const forbidden = BASE.replace("- 问题: xx.ts:45 代码实现不全", "- 问题: rewritten finding");
    const verdict = verifyFixReportEdits({ baseline: BASE, current: forbidden });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(" ")).toContain("fix_report_edit_violation");
  });

  it("severity (等级) edits refuse (fix_report_edit_violation)", () => {
    const verdict = verifyFixReportEdits({ baseline: BASE, current: BASE.replace("- 等级：Blocker", "- 等级：Medium") });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(" ")).toContain("fix_report_edit_violation");
  });

  it("identical bytes pass; a hash baseline round-trips allowed edits", () => {
    expect(verifyFixReportEdits({ baseline: BASE, current: BASE }).ok).toBe(true);
    const h = protectedFixReportHash(BASE);
    const allowedEdit = BASE.replace("- 证据：", "- 证据：assert x");
    expect(verifyFixReportEditsAgainstHash({ baselineHash: h, current: allowedEdit }).ok).toBe(true);
    expect(verifyFixReportEditsAgainstHash({ baselineHash: h, current: BASE.replace("- 等级：Blocker", "- 等级：High") }).ok).toBe(false);
  });
});
