/**
 * 229 Phase 2 (F2/B7/B9): the review-findings directive module.
 *
 * Boundaries covered (plan Phase 2 "单元测试目标，边界"):
 * - injection: no previous round ⇒ null; `round <= 1` ⇒ null; legacy report
 *   without a ledger ⇒ LEGACY-1..n ids (DID NOT REWRITE the history bytes);
 *   the round-(n-1) ledger is preferred over synthesis;
 * - rendering: ≤6 lines, mentions the injected ids and (when present) the
 *   declared scope; empty carried set + no scope ⇒ null (prompt unchanged);
 * - determinism: two calls over the SAME bytes produce byte-identical
 *   synthetic records (persistence lives ONLY in the coordinator);
 * - the module NEVER writes anything (pure/read-only signatures only).
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  resolvePreviousOpenFindings,
  renderReviewFindingsDirective,
  synthesizeLegacyCarryOver,
  declaredScopeOf,
} from "../../core/auto-pipeline/review-findings-directive";
import type { DesignReviewState } from "../../types";

function legacyReport(dir: string, name: string, issues: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    [
      "# Design Review Report",
      "",
      `**pipeline**: p-legacy`,
      `**plan**: ${path.join(dir, "plan.md")}`,
      "**round**: 1",
      "**operation**: op-1",
      "**input hash**: h",
      "",
      "## Summary",
      "",
      "Reviewed.",
      "",
      "## Verdict",
      "",
      "**Design Review: FAIL**",
      "",
      "## Issues",
      ...issues.map((t, i) => `${i + 1}. ${t}`),
      "",
      "## Recommendations",
      "",
      "ok",
      "",
    ].join("\n"),
    "utf-8",
  );
  return p;
}

describe("229 Phase 2: resolvePreviousOpenFindings (read-only)", () => {
  it("round <= 1 ⇒ null (no previous round)", () => {
    expect(resolvePreviousOpenFindings({ planDoc: "/x/plan.md", round: 1 })).toBeNull();
    expect(resolvePreviousOpenFindings({ planDoc: "/x/plan.md", round: 0 })).toBeNull();
  });

  it("missing previous report ⇒ null", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "rfd-missing-"));
    expect(resolvePreviousOpenFindings({ planDoc: path.join(dir, "plan.md"), round: 2 })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("legacy report without ledger ⇒ synthetic LEGACY-1..n, deterministic", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "rfd-legacy-"));
    fs.writeFileSync(path.join(dir, "plan.md"), "# Plan\n", "utf-8");
    legacyReport(dir, "Design_Review_1_plan_Design.md", ["gap A", "gap B"]);
    const first = resolvePreviousOpenFindings({ planDoc: path.join(dir, "plan.md"), round: 2 });
    const second = resolvePreviousOpenFindings({ planDoc: path.join(dir, "plan.md"), round: 2 });
    expect(first).not.toBeNull();
    expect(first!.legacy).toBe(true);
    expect(first!.records.map((r) => r.id)).toEqual(["LEGACY-1", "LEGACY-2"]);
    expect(first!.records.map((r) => r.origin)).toEqual(["1", "1"]);
    // determinism (B9: two calls over the same bytes are byte-identical)
    expect(first!.records).toEqual(second!.records);
    // the history file is NEVER rewritten (B9)
    const after = fs.readFileSync(path.join(dir, "Design_Review_1_plan_Design.md"), "utf-8");
    expect(after).toContain("1. gap A");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("previous ledger present ⇒ open set from the ledger (no legacy synthesis)", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "rfd-ledger-"));
    fs.writeFileSync(path.join(dir, "plan.md"), "# Plan\n", "utf-8");
    fs.writeFileSync(
      path.join(dir, "Design_Review_1_plan_Design.md"),
      [
        "# Design Review Report", "",
        "**pipeline**: p", `**plan**: ${path.join(dir, "plan.md")}`, "**round**: 1",
        "**operation**: op-1", "**input hash**: h", "",
        "## Summary", "", "Reviewed.", "",
        "## Verdict", "", "**Design Review: FAIL**", "",
        "## Issue Ledger", "",
        "| ID | Severity | Status | Evidence | Summary |",
        "| --- | --- | --- | --- | --- |",
        "| DR-1-1 | Blocker | open | failing assertion | gap one |",
        "| DR-1-2 | Low | fixed | - | nit |",
        "| DR-1-3 | High | carry-over | missing AC | gap three |",
        "",
        "## Issues", "", "None", "",
        "## Recommendations", "", "ok", "",
      ].join("\n"),
      "utf-8",
    );
    const res = resolvePreviousOpenFindings({ planDoc: path.join(dir, "plan.md"), round: 2 });
    expect(res!.legacy).toBe(false);
    // DR-1-2 is fixed ⇒ leaves the open set; DR-1-1 (open) + DR-1-3 (carry-over) stay
    expect(res!.records.map((r) => r.id)).toEqual(["DR-1-1", "DR-1-3"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("229 Phase 2: renderReviewFindingsDirective", () => {
  const records = [
    { id: "DR-1-1", origin: "1", severity: "Blocker" as const, status: "open" as const, text: "gap one" },
    { id: "DR-1-3", origin: "1", severity: "High" as const, status: "carry-over" as const, text: "gap three" },
  ];

  it("empty carried set ⇒ null (prompt bytes unchanged)", () => {
    expect(renderReviewFindingsDirective([], "/x/report.md", { phases: [2, 5], sections: [] })).toBeNull();
  });

  it("renders ids, requirement restating and the declared scope (≤6 lines)", () => {
    const directive = renderReviewFindingsDirective(records, "/x/report.md", { phases: [2, 5], sections: [] });
    expect(directive).not.toBeNull();
    const lines = directive!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(directive).toContain("DR-1-1 (Blocker, open)");
    expect(directive).toContain("DR-1-3 (High, carry-over)");
    expect(directive).toContain("Issue Ledger");
    expect(directive).toContain("Scope for this round: Phase 2, Phase 5 (declared)");
  });

  it("without a declared scope no scope line is rendered", () => {
    const directive = renderReviewFindingsDirective(records, "/x/report.md");
    expect(directive).not.toBeNull();
    expect(directive).not.toContain("Scope for this round");
  });

  it("declaredScopeOf reads the optional state field defensively", () => {
    expect(declaredScopeOf(undefined)).toBeUndefined();
    expect(declaredScopeOf({ lastDeclaredScope: { phases: [2], sections: [] } } as unknown as DesignReviewState)).toEqual({
      phases: [2],
      sections: [],
    });
  });
});

describe("229 Phase 2: synthesizeLegacyCarryOver (pure)", () => {
  it("deterministic and id-stable over identical bytes", () => {
    const content = [
      "# Design Review Report", "",
      "## Verdict", "", "**Design Review: FAIL**", "",
      "## Issues", "1. gap A", "2. gap B", "",
      "## Recommendations", "", "ok", "",
    ].join("\n");
    const a = synthesizeLegacyCarryOver({ reportContent: content, round: 1 });
    const b = synthesizeLegacyCarryOver({ reportContent: content, round: 1 });
    expect(a.map((r) => r.id)).toEqual(["LEGACY-1", "LEGACY-2"]);
    expect(a).toEqual(b);
  });

  it("a report WITH a ledger never synthesizes", () => {
    const content = [
      "# Design Review Report", "",
      "## Verdict", "", "**Design Review: FAIL**", "",
      "## Issue Ledger", "",
      "| ID | Severity | Status | Evidence | Summary |",
      "| --- | --- | --- | --- | --- |",
      "| DR-1-1 | Blocker | open | assertion | gap |", "",
      "## Issues", "", "None", "",
      "## Recommendations", "", "ok", "",
    ].join("\n");
    expect(synthesizeLegacyCarryOver({ reportContent: content, round: 1 })).toEqual([]);
  });
});
