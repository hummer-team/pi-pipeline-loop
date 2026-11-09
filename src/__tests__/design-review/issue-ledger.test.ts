/**
 * 229 Phase 0 (Unit Tests Core): PURE issue-ledger primitives.
 *
 * Boundaries covered (plan Phase 0 "单元测试目标，边界"):
 * - header-aware parsing: four columns selected BY NAME, swapped column order,
 *   legacy 3-column table without a header ⇒ `cells[1]`;
 * - sentinel-first filtering: `None` alone ⇒ empty records; `None` plus one
 *   Medium ⇒ exactly one record;
 * - defaults: two `## Issues` bullets ⇒ `status="open"` / `origin="2"`,
 *   `computeOpenSet` keeps both, unknown status stays in the open set;
 * - `evaluateNoProgress`: shrink / flat / two flat rounds, grace not used up,
 *   loop mismatch ⇒ progress with streak 0;
 * - `nextIssueId`: same-round increment, cross-round reset, dedupe.
 *
 * Pure module: no I/O and no meta access anywhere in these tests.
 */

import { describe, expect, it } from "bun:test";
import type { DesignReviewIssueRecord } from "../../types";
import {
  computeOpenSet,
  evaluateNoProgress,
  hasEvidence,
  isBlocking,
  isBlockingSeverity,
  isNoIssueSentinel,
  nextIssueId,
  parseIssueLedgerSection,
  parseIssuesSection,
  severityCounts,
} from "../../core/design-review/issue-ledger";

describe("229 Phase 0: header-aware `## Issues` parsing", () => {
  it("selects the four columns by name", () => {
    const records = parseIssuesSection(
      [
        "| ID | Severity | Evidence | Summary |",
        "| --- | --- | --- | --- |",
        "| DR-2-1 | Blocker | bun test docs | fee caliber regressed |",
        "| DR-2-2 | Medium | | wording nit |",
      ],
      2,
    );
    expect(records.map((r) => r.id)).toEqual(["DR-2-1", "DR-2-2"]);
    expect(records[0]).toEqual({
      id: "DR-2-1",
      origin: "2",
      severity: "Blocker",
      status: "open",
      evidence: "bun test docs",
      text: "fee caliber regressed",
    });
    expect(records[1]!.severity).toBe("Medium");
    expect(records[1]!.evidence).toBeUndefined();
  });

  it("tolerates swapped column order", () => {
    const records = parseIssuesSection(
      [
        "| Summary | Severity | ID | Evidence |",
        "| --- | --- | --- | --- |",
        "| missing export | High | DR-2-7 | ci failure |",
      ],
      2,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("DR-2-7");
    expect(records[0]!.severity).toBe("High");
    expect(records[0]!.text).toBe("missing export");
    expect(records[0]!.evidence).toBe("ci failure");
  });

  it("legacy 3-column table without a header falls back to cells[1]", () => {
    const records = parseIssuesSection(
      ["| # | Issue |", "| --- | --- |", "| 1 | 无法恢复的数据字段 |"],
      3,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.text).toBe("无法恢复的数据字段");
    expect(records[0]!.id).toBe("DR-3-1");
    expect(records[0]!.severity).toBeUndefined();
    expect(records[0]!.status).toBe("open");
  });

  it("illegal severity in a declared column stays undefined (verifier rejects later)", () => {
    const records = parseIssuesSection(
      [
        "| ID | Severity | Evidence | Summary |",
        "| --- | --- | --- | --- |",
        "| DR-4-1 | CRITICAL | x | bad label |",
      ],
      4,
    );
    expect(records[0]!.severity).toBeUndefined();
  });
});

describe("229 Phase 0: sentinel-first filtering (问题 11)", () => {
  it("`None` alone yields an EMPTY record list", () => {
    expect(parseIssuesSection(["None"], 1)).toEqual([]);
    expect(parseIssuesSection(["- **None**"], 1)).toEqual([]);
    expect(parseIssuesSection(["无"], 1)).toEqual([]);
    expect(parseIssuesSection(["N/A"], 1)).toEqual([]);
    expect(isNoIssueSentinel("  __None__ ")).toBe(true);
  });

  it("`None` plus one Medium yields exactly one record (the Medium is validated normally)", () => {
    const records = parseIssuesSection(
      ["None", "", "| ID | Severity | Evidence | Summary |", "| --- | --- | --- | --- |", "| DR-5-1 | Medium | | nit |"],
      5,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.severity).toBe("Medium");
    expect(records[0]!.id).toBe("DR-5-1");
  });

  it("sentinel-like prose rows that are NOT whole-item sentinels stay issues", () => {
    const records = parseIssuesSection(["nonequivalent mapping is wrong"], 6);
    expect(records).toHaveLength(1);
    expect(records[0]!.text).toBe("nonequivalent mapping is wrong");
  });
});

describe("229 Phase 0: defaults and open-set semantics (问题 10)", () => {
  it("two `## Issues` bullets ⇒ status open, origin round, generated ids", () => {
    const records = parseIssuesSection(["- first problem", "2. second problem"], 2);
    expect(records.map((r) => r.id)).toEqual(["DR-2-1", "DR-2-2"]);
    for (const r of records) {
      expect(r.status).toBe("open");
      expect(r.origin).toBe("2");
    }
  });

  it("computeOpenSet keeps open and carry-over, drops fixed and accepted-risk", () => {
    const records: DesignReviewIssueRecord[] = [
      { id: "DR-1-1", origin: "1", severity: "High", status: "open", text: "a" },
      { id: "DR-1-2", origin: "1", severity: "Medium", status: "fixed", text: "b" },
      { id: "DR-1-3", origin: "1", severity: "Low", status: "accepted-risk", text: "c" },
      { id: "DR-1-4", origin: "1", severity: "Medium", status: "carry-over", text: "d" },
    ];
    expect(computeOpenSet(records).map((r) => r.id)).toEqual(["DR-1-1", "DR-1-4"]);
  });

  it("unknown status is treated as OPEN by computeOpenSet", () => {
    const legacy = { id: "DR-2-9", origin: "2", severity: "High", status: "pending-recheck", text: "x" };
    const records = [legacy] as unknown as DesignReviewIssueRecord[];
    expect(computeOpenSet(records).map((r) => r.id)).toEqual(["DR-2-9"]);
  });

  it("severityCounts skips records without a declared severity", () => {
    const records: DesignReviewIssueRecord[] = [
      { id: "A", origin: "1", severity: "Blocker", text: "a" },
      { id: "B", origin: "1", severity: "Blocker", text: "b" },
      { id: "C", origin: "1", severity: "High", text: "c" },
      { id: "D", origin: "1", text: "no severity" },
    ];
    expect(severityCounts(records)).toEqual({ Blocker: 2, High: 1 });
  });
});

describe("229 Phase 0: blocking/evidence separation (F1)", () => {
  it("Blocker and High are blocking; Medium and Low and missing are not", () => {
    expect(isBlockingSeverity("Blocker")).toBe(true);
    expect(isBlockingSeverity("High")).toBe(true);
    expect(isBlockingSeverity("Medium")).toBe(false);
    expect(isBlockingSeverity("Low")).toBe(false);
    expect(isBlockingSeverity(undefined)).toBe(false);
  });

  it("isBlocking mirrors isBlockingSeverity on a record; hasEvidence is separate", () => {
    expect(isBlocking({ severity: "High" })).toBe(true);
    expect(hasEvidence({ evidence: " commit 123 " })).toBe(true);
    expect(hasEvidence({ evidence: "   " })).toBe(false);
    expect(hasEvidence({})).toBe(false);
  });
});

describe("229 Phase 0: stable issue ids", () => {
  it("increments within the same round", () => {
    expect(nextIssueId("DR", 2, [])).toBe("DR-2-1");
    expect(
      nextIssueId("DR", 2, [
        { id: "DR-2-1", origin: "2", text: "a" },
        { id: "DR-2-4", origin: "2", text: "b" },
      ]),
    ).toBe("DR-2-5");
  });

  it("resets across rounds and ignores other rounds/other prefixes", () => {
    expect(
      nextIssueId("CR", 3, [
        { id: "DR-3-2", origin: "3", text: "a" },
        { id: "CR-2-9", origin: "2", text: "b" },
      ]),
    ).toBe("CR-3-1");
  });

  it("dedupes against the existing id set", () => {
    expect(
      nextIssueId("DR", 1, [
        { id: "DR-1-1", origin: "1", text: "a" },
        { id: "DR-1-2", origin: "1", text: "b" },
      ]),
    ).toBe("DR-1-3");
  });

  it("dupes of a parsed id are replaced by the next generated id", () => {
    const records = parseIssuesSection(
      [
        "| ID | Severity | Evidence | Summary |",
        "| --- | --- | --- | --- |",
        "| DR-7-1 | High | e1 | first |",
        "| DR-7-1 | Medium | e2 | second |",
      ],
      7,
    );
    expect(records.map((r) => r.id)).toEqual(["DR-7-1", "DR-7-2"]);
  });
});

describe("229 Phase 0: `## Issue Ledger` parsing", () => {
  it("parses status by name; unknown status normalizes to open", () => {
    const records = parseIssueLedgerSection(
      [
        "| ID | Severity | Status | Evidence | Summary |",
        "| --- | --- | --- | --- | --- |",
        "| DR-1-1 | High | fixed | bun test | done |",
        "| DR-1-2 | Blocker | 遗留 | ci fail | still open |",
        "| DR-1-5 | Medium | nonsense | | normalizes open |",
      ],
      3,
    );
    expect(records.map((r) => r.status)).toEqual(["fixed", "carry-over", "open"]);
    expect(records[1]!.evidence).toBe("ci fail");
  });

  it("origin is derived from the id round segment when parseable", () => {
    const records = parseIssueLedgerSection(
      [
        "| ID | Severity | Status | Evidence | Summary |",
        "| --- | --- | --- | --- | --- |",
        "| DR-1-2 | High | open | | carried into round 3 |",
      ],
      3,
    );
    expect(records[0]!.origin).toBe("1");
  });
});

describe("229 Phase 0: evaluateNoProgress (F4)", () => {
  const snap = (openIds: string[], streak?: number) => ({
    loop: "designReview" as const,
    openIds,
    severityCounts: { High: openIds.length },
    ...(streak !== undefined ? { streak } : {}),
  });

  it("shrink ⇒ progress with streak 0", () => {
    expect(evaluateNoProgress(snap(["a", "b"], 1), snap(["a"]), 1)).toEqual({
      verdict: "progress",
      streak: 0,
    });
  });

  it("flat ⇒ no-progress with an extended streak", () => {
    expect(evaluateNoProgress(snap(["a", "b"], 0), snap(["b", "a"]), 2)).toEqual({
      verdict: "no-progress",
      streak: 1,
    });
  });

  it("regression (growth) is never progress", () => {
    expect(evaluateNoProgress(snap(["a"], 0), snap(["a", "b"]), 2).verdict).toBe("no-progress");
  });

  it("equal count with REPLACED ids is NOT progress (one blocker swapped for another, R3-Q4 B)", () => {
    // The debt did not shrink: `a` was resolved but `c` replaced it, so the
    // open set is neither a proper subset nor smaller — the streak extends.
    expect(evaluateNoProgress(snap(["a", "b"], 0), snap(["b", "c"]), 2)).toEqual({
      verdict: "no-progress",
      streak: 1,
    });
  });

  it("a proper SUBSET is progress even when the count drops", () => {
    expect(evaluateNoProgress(snap(["a", "b", "c"], 0), snap(["a", "b"]), 2)).toEqual({
      verdict: "progress",
      streak: 0,
    });
  });

  it("same count replaced AND grown is never progress", () => {
    expect(evaluateNoProgress(snap(["a"], 0), snap(["b", "c"]), 2).verdict).toBe("no-progress");
  });

  it("equal count with the IDENTICAL id set stays a flat repetition", () => {
    expect(evaluateNoProgress(snap(["b", "a"], 0), snap(["a", "b"]), 2)).toEqual({
      verdict: "no-progress",
      streak: 1,
    });
  });

  it("two consecutive flat rounds turn exhausted once the grace is used up", () => {
    expect(evaluateNoProgress(snap(["a", "b"], 1), snap(["a", "b"]), 1)).toEqual({
      verdict: "exhausted",
      streak: 2,
    });
  });

  it("grace not used up is never exhausted", () => {
    expect(evaluateNoProgress(snap(["a", "b"], 1), snap(["a", "b"]), 2).verdict).toBe("no-progress");
  });

  it("loop mismatch or missing previous ⇒ FIXED progress with streak 0 (问题 20)", () => {
    expect(evaluateNoProgress(snap(["a", "b"], 2), { loop: "reviewFix", openIds: ["a", "b", "c"], severityCounts: {} }, 0)).toEqual({
      verdict: "progress",
      streak: 0,
    });
    expect(evaluateNoProgress(undefined, snap(["a"]), 0)).toEqual({ verdict: "progress", streak: 0 });
  });
});
