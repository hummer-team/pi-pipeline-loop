/**
 * 220 Phase 1 (D4): deterministic ledger traceability used by design-review.
 *
 * Key behaviors:
 * - Reference counting is case-sensitive substring presence.
 * - NULL when the ledger is empty or fully referenced (nothing to report).
 * - `rule` lists 3 checks, `assisted` lists 6, and the missing labels are named.
 */
import { describe, it, expect } from "bun:test";
import {
  buildLedgerTraceabilityDirective,
  countLedgerReferences,
} from "../../core/auto-pipeline/design-review-ledger-check";

const LABELS = ["Q1 起点", "Q2 预算", "Q3 文档协议"];

describe("countLedgerReferences", () => {
  it("counts zero when nothing is referenced", () => {
    expect(countLedgerReferences(LABELS, "plan without references")).toBe(0);
  });

  it("counts partially referenced labels", () => {
    expect(countLedgerReferences(LABELS, "按 Q2 预算执行")).toBe(1);
  });

  it("counts every label when fully referenced", () => {
    expect(countLedgerReferences(LABELS, "Q1 起点 / Q2 预算 / Q3 文档协议")).toBe(3);
  });

  it("empty labels are ignored", () => {
    expect(countLedgerReferences(["", "Q2 预算"], "Q2 预算")).toBe(1);
  });
});

describe("buildLedgerTraceabilityDirective", () => {
  const ledger = { hasEliminatedReasons: true, hasConflictMatrix: true };

  it("empty ledger → null", () => {
    expect(buildLedgerTraceabilityDirective({ labels: [], planText: "x", tier: "rule", ledger })).toBeNull();
  });

  it("fully covered plan → null", () => {
    const planText = "Q1 起点 Q2 预算 Q3 文档协议";
    expect(buildLedgerTraceabilityDirective({ labels: LABELS, planText, tier: "rule", ledger })).toBeNull();
  });

  it("partial coverage names the missing labels", () => {
    const directive = buildLedgerTraceabilityDirective({
      labels: LABELS,
      planText: "Q1 起点",
      tier: "rule",
      ledger,
    });
    expect(directive).toContain("Q2 预算");
    expect(directive).toContain("Q3 文档协议");
    expect(directive).not.toContain("Q1 起点 |");
  });

  it("rule tier lists 3 checks, assisted lists 6", () => {
    const rule = buildLedgerTraceabilityDirective({ labels: LABELS, planText: "", tier: "rule", ledger })!;
    const assisted = buildLedgerTraceabilityDirective({ labels: LABELS, planText: "", tier: "assisted", ledger })!;
    const count = (text: string): number => text.split("\n").filter((line) => line.startsWith("- ")).length;
    // 3 ledger facts + N checks are all bullet lines; the difference is exactly 3.
    expect(count(assisted) - count(rule)).toBe(3);
  });

  it("missing markers are reported as facts, not verdicts", () => {
    const directive = buildLedgerTraceabilityDirective({
      labels: LABELS,
      planText: "",
      tier: "rule",
      ledger: { hasEliminatedReasons: false, hasConflictMatrix: false },
    })!;
    expect(directive).toContain("Elimination reasons documented: no");
    expect(directive).toContain("Conflict matrix documented: no");
    expect(directive).toContain("PASS/FAIL contract is unchanged");
  });
});
