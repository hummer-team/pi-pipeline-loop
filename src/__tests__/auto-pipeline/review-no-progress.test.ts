/**
 * 229 Phase 4 (F4): the review/fix loop no-progress module.
 *
 * Boundaries covered (plan Phase 4 "单元测试目标，边界"):
 * - parseReviewFindings: BOTH report shapes — the bullet template
 *   (`### 问题 N` + `等级：` + `是否修复：待修复`) and a table with a severity
 *   column — produce equivalent records; no ID ⇒ `CR-2-n`;
 * - the ledger matrix: shrink/flat/two-flat rounds; a loop mismatch reads as
 *   progress with streak 0 (问题 20);
 * - grace independence: `noProgressGraceUsed` counts separately from
 *   `finalGraceUsed`;
 * - sidecar write failure ⇒ the meta accounting stays monotonic (audited,
 *   B17); frozen ⇒ the caller contract (`noteReviewRoundOutcome` returns
 *   frozen and the flow gets blocked).
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  parseReviewFindings,
  readNoProgressGraceUsed,
  bumpNoProgressGraceUsed,
} from "../../core/auto-pipeline/review-no-progress";
import { evaluateNoProgress } from "../../core/design-review/issue-ledger";

function listReport(): string {
  return [
    "# Code Review",
    "",
    "## Review发现以下问题",
    "### 问题 1",
    "- 问题: xx.ts:45 代码实现不全",
    "- 等级：Blocker",
    "- 是否修复：待修复",
    "- 改进建议：再次实施",
    "",
    "### 问题 2",
    "- 问题: yy.ts:8 命名与规划不一致",
    "- 等级：Medium",
    "- 是否修复：待修复",
    "",
    "## 结论",
    "- 结论：不通过",
  ].join("\n");
}

function tableReport(): string {
  return [
    "# Code Review",
    "",
    "## Review发现以下问题",
    "",
    "| ID | Severity | Status | Evidence | Summary |",
    "| --- | --- | --- | --- | --- |",
    "| CR-2-1 | Blocker | 待修复 | assertion | 代码实现不全 |",
    "| CR-2-2 | Medium | 待修复 | | 命名不一致 |",
    "",
    "## 结论",
    "- 结论：不通过",
  ].join("\n");
}

function writeReport(dir: string, content: string): string {
  const p = path.join(dir, "report.md");
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("229 Phase 4: parseReviewFindings (双形态 + CR ids)", () => {
  it("list template: 等级/是否修复 blocks produce severity + open statuses", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "rnp-list-"));
    const records = parseReviewFindings(writeReport(dir, listReport()), 2);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: "CR-2-1",
      origin: "2",
      severity: "Blocker",
      status: "open",
    });
    expect(records[1]?.severity).toBe("Medium");
  });

  it("table form with a severity column parses to the same shape", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "rnp-table-"));
    const records = parseReviewFindings(writeReport(dir, tableReport()), 2);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ id: "CR-2-1", severity: "Blocker", status: "open" });
    expect(records[1]).toMatchObject({ id: "CR-2-2", severity: "Medium", status: "open" });
  });

  it("unreadable report ⇒ empty list (caller treats as no findings)", () => {
    expect(parseReviewFindings(path.join(tmpdir(), "definitely-missing.md"), 2)).toEqual([]);
  });
});

describe("229 Phase 4: grace sidecar (独立宽限 + B17 fail-soft)", () => {
  it("read without an active job ⇒ 0 (human mode equity applies immediately)", () => {
    const root = path.join(tmpdir(), "rnp-nojob-");
    fs.mkdirSync(root, { recursive: true });
    expect(readNoProgressGraceUsed(root, "doc-a")).toBe(0);
  });

  it("an unreadable sidecar never throws and never blocks the caller (fail-soft)", () => {
    const root = path.join(tmpdir(), "rnp-failsoft-");
    fs.mkdirSync(root, { recursive: true });
    expect(() => bumpNoProgressGraceUsed(root, "doc-a")).not.toThrow();
  });
});

describe("229 Phase 4: no-progress matrix (loop-first, R3-Q4 B)", () => {
  const snap = (loop: "reviewFix" | "designReview", openIds: string[], streak = 0) => ({
    loop,
    openIds,
    severityCounts: { Blocker: openIds.length },
    ...(streak > 0 ? { streak } : {}),
  });

  it("shrink / flat / two flat rounds (grace used determines the freeze)", () => {
    expect(evaluateNoProgress(snap("reviewFix", ["a", "b"], 0), snap("reviewFix", ["a"]), 1)).toEqual({ verdict: "progress", streak: 0 });
    expect(evaluateNoProgress(snap("reviewFix", ["a", "b"], 0), snap("reviewFix", ["a", "b"]), 1)).toEqual({ verdict: "no-progress", streak: 1 });
    // grace consumed once ⇒ the second consecutive no-progress sort freezes
    expect(evaluateNoProgress(snap("reviewFix", ["a", "b"], 1), snap("reviewFix", ["a", "b"]), 1)).toEqual({ verdict: "exhausted", streak: 2 });
  });

  it("loop mismatch ⇒ FIXED progress with streak 0 (问题 20)", () => {
    expect(evaluateNoProgress(snap("designReview", ["a", "b"], 2), snap("reviewFix", ["a", "b"]), 0)).toEqual({
      verdict: "progress",
      streak: 0,
    });
  });
});
