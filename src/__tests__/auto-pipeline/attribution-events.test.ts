/**
 * 229 Phase 7 (F8): attribution audit events + the fix-report write whitelist.
 *
 * Boundaries (plan Phase 7 "单元测试目标,边界"):
 * - attribution: an exhausted-advance doc receipt vite carries
 *   `exhausted(<reason>)` while `freeze_unresolvable` stays ONLY for a REAL
 *   unresolvable freeze (finalize helpers + freeze-autopilot legs);
 * - the fix whitelist: only 是否修复/状态 + 证据 lines may change; edits to the
 *   finding text or 等级 (severity) ⇒ `fix_report_edit_violation`;
 * - the 229 audit vocabulary is registered (issue #6 three-value
 *   parse + stable ids checked at the parse level).
 */

import { describe, expect, it } from "bun:test";
import { exhaustedDocReason } from "../../core/auto-pipeline/finalize";
import { resolveFreezeAction } from "../../core/auto-pipeline/freeze-autopilot";
import { parseAutoJob } from "../../core/auto-pipeline/job-schema";
import {
  verifyFixReportEdits,
  verifyFixReportEditsAgainstHash,
  protectedFixReportHash,
} from "../../core/verifiers/fix-report-edit-verifier";
import { parseReviewFindings } from "../../core/auto-pipeline/review-no-progress";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

function scrubJob(): ReturnType<typeof parseAutoJob> {
  return parseAutoJob(
    ["version: 1", "enabled: false", "tier: rule", "docs:", "  list:", "    - doc: docs/design/x_Feat.md"].join("\n"),
    "attribution-test",
  );
}

function metaFor(reason: string): SessionMeta {
  return makeTestMeta({
    currentStage: "review",
    pipelineId: "p",
    flowState: "blocked",
    blockedReason: reason,
    reviewLedger: { loop: "reviewFix", roundIndex: 2, pipelineId: "p", openIds: [], severityCounts: {}, streak: 2 },
  });
}

describe("229 Phase 7: attribution (F8)", () => {
  it("an exhausted loop resolves ADVANCE (never freeze_unresolvable)", () => {
    const j = scrubJob();
    if (!j.ok) throw new Error(j.errors.join("; "));
    const r = resolveFreezeAction({
      meta: metaFor("no_progress_detected"),
      job: j.job,
      state: {
        schemaVersion: 1, jobId: "j", jobPath: "/x", jobHash: "h", jobTotalDocs: 1, docIndex: 0,
        status: "running", startedAt: 0, updatedAt: 0,
        counters: { totalLoops: 0, totalFreezes: 0, consecutiveVerifyFailures: 0, autoResumes: 0, finalGraceUsed: {}, noProgressGraceUsed: {}, designReviewRounds: {} },
        docs: [],
      },
      reason: "no_progress_detected",
      config: makeTestConfig(),
    });
    expect(r.action).toBe("advance");
    expect(r.action).not.toBe("stop-and-report");
  });

  it("exhaustedDocReason: loop reasons + freeze_unresolvable(...) carry the exhausted shape; others pass through", () => {
    expect(exhaustedDocReason("no_progress_detected")).toBe("exhausted(no_progress_detected)");
    expect(exhaustedDocReason("freeze_unresolvable(max_loop_cycles)")).toBe("exhausted(max_loop_cycles)");
    expect(exhaustedDocReason("design_review_budget_exhausted")).toBe("exhausted(design_review_budget_exhausted)");
    expect(exhaustedDocReason("doc_failed")).toBeUndefined();
    expect(exhaustedDocReason(undefined)).toBeUndefined();
  });

  it("a real unresolvable freeze still stops (byReason pinned stop)", () => {
    const j = scrubJob();
    if (!j.ok) throw new Error(j.errors.join("; "));
    const cfg = makeTestConfig();
    void cfg;
    const job = { ...j.job, freezePolicy: { ...j.job.freezePolicy, byReason: { "x": "stop-and-report" as const }, maxAutoResumes: 0 } };
    const r = resolveFreezeAction({
      meta: metaFor("x"),
      job,
      state: {
        schemaVersion: 1, jobId: "j", jobPath: "/x", jobHash: "h", jobTotalDocs: 1, docIndex: 0,
        status: "running", startedAt: 0, updatedAt: 0,
        counters: { totalLoops: 0, totalFreezes: 0, consecutiveVerifyFailures: 0, autoResumes: 0, finalGraceUsed: {}, noProgressGraceUsed: {}, designReviewRounds: {} },
        docs: [],
      },
      reason: "some_other_freeze",
      config: makeTestConfig(),
    });
    expect(r.action).toBe("stop-and-report");
  });
});

describe("229 Phase 7: fix-report write whitelist (问题 6)", () => {
  const BASE = [
    "# Code Review", "",
    "## Review发现以下问题", "",
    "### 问题 1", "",
    "- 问题: xx.ts:45 代码实现不全",
    "- 等级：Blocker",
    "- 符合规划：否",
    "- 是否修复：待修复",
    "- 证据：",
    "- 改进建议：再次实施", "",
    "## 结论", "- 结论：不通过",
  ].join("\n");

  it("editing ONLY allowed fields (是否修复/证据) passes", () => {
    const edited = BASE.replace("- 是否修复：待修复", "- 是否修复：已修复").replace("- 证据：", "- 证据：bun test exits 1");
    expect(verifyFixReportEdits({ baseline: BASE, current: edited }).ok).toBe(true);
  });

  it("rewriting the finding text ⇒ fix_report_edit_violation", () => {
    const edited = BASE.replace("xx.ts:45 代码实现不全", "xx.ts:45 编码风格问题");
    const v = verifyFixReportEdits({ baseline: BASE, current: edited });
    expect(v.ok).toBe(false);
    expect(v.violations.join(" ")).toContain("fix_report_edit_violation");
  });

  it("editing the severity (等级) ⇒ fix_report_edit_violation (severity inflation is refused)", () => {
    const edited = BASE.replace("- 等级：Blocker", "- 等级：Medium");
    expect(verifyFixReportEdits({ baseline: BASE, current: edited }).ok).toBe(false);
  });

  it("hash-based check: protectedFixReportHash round-trips an allowed-field edit", () => {
    const edited = BASE.replace("- 是否修复：待修复", "- 是否修复：已修复");
    const baseline = protectedFixReportHash(BASE);
    expect(verifyFixReportEditsAgainstHash({ baselineHash: baseline, current: edited }).ok).toBe(true);
    const tampered = BASE.replace("### 问题 1", "### 问题 999");
    expect(verifyFixReportEditsAgainstHash({ baselineHash: baseline, current: tampered }).ok).toBe(false);
  });
});

describe("229 Phase 7 (问题 6): the three-value 判定 parses in the review loop", () => {
  it("争议/接受风险 statuses map into the ledger statuses (parseReviewFindings)", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "fixreport-"));
    const p = `${dir}/r.md`;
    fs.writeFileSync(p, [
      "### 问题 1",
      "- 等级：Blocker",
      "- 是否修复：争议",
      "",
      "### 问题 2",
      "- 等级：Medium",
      "- 是否修复：接受风险",
    ].join("\n"), "utf-8");
    const records = parseReviewFindings(p, 2);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(records[0]?.status).toBe("open");
    expect(records[1]?.status).toBe("accepted-risk");
  });
});
