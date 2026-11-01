/**
 * 220 Phase 1 (D3): requirement assessment + decision ledger protocol parsing.
 *
 * Key behaviors:
 * - `missingSections` is exact (the three mandatory headings).
 * - `ambiguities` catches vague words, non-quantified thresholds and long sentences.
 * - `verdict` is `needs-clarify` as soon as any deterministic problem exists.
 * - `labels` are deduped, order preserved; the ledger checks (elimination
 *   reasons / conflict matrix) are section-scoped.
 * - The directive lists missing items only (`rule` vs `assisted` differ).
 */
import { describe, it, expect } from "bun:test";
import {
  buildProtocolDirective,
  parseClarifyQuestionCount,
  parseDecisionLedger,
  parseRequirementAssessment,
} from "../../core/auto-pipeline/clarify-protocol";

const READY_DOC = [
  "## 目标",
  "交付一个可审计的自动流水线。",
  "## 范围",
  "仅插件内部改动。",
  "## 验收标准",
  "单测全绿。",
  "## 需求评估",
  "ready",
].join("\n");

const LEDGER_DOC = [
  READY_DOC,
  "## 组合决策台账",
  "",
  "| 题目 | 选择 | 淘汰 | 得分 | 淘汰理由 | 冲突矩阵 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Q1 起点 | 方案A | 方案B | 4.2 | 成本高 | 无冲突 |",
  "| Q2 预算 | 方案C | 方案D | 3.8 | 风险大 | 无冲突 |",
  "| Q1 起点 | 方案A | 方案E | 4.2 | 与 Q2 冲突 | 已裁决 |",
].join("\n");

describe("parseRequirementAssessment", () => {
  it("ready document with all headings → ready", () => {
    const assessment = parseRequirementAssessment(READY_DOC);
    expect(assessment).toEqual({
      present: true,
      verdict: "ready",
      missingSections: [],
      ambiguities: [],
    });
  });

  it("missing mandatory sections are reported exactly", () => {
    const assessment = parseRequirementAssessment("## 目标\n做点什么\n## 需求评估\nready");
    expect(assessment.missingSections).toEqual(["## 范围", "## 验收标准"]);
    expect(assessment.verdict).toBe("needs-clarify");
  });

  it("missing assessment section → present=false and unknown verdict", () => {
    const assessment = parseRequirementAssessment("## 目标\nA\n## 范围\nB\n## 验收标准\nC");
    expect(assessment.present).toBe(false);
    expect(assessment.verdict).toBe("unknown");
  });

  it("vague words are reported, deduped and capped", () => {
    const doc = `${READY_DOC}\n性能要更快，延迟待定。\n范围待定。`;
    const assessment = parseRequirementAssessment(doc);
    expect(assessment.ambiguities.length).toBe(2);
    expect(assessment.ambiguities[0]).toContain("更快");
    expect(assessment.verdict).toBe("needs-clarify");
  });

  it("'等等' is ambiguous only when it trails a list item", () => {
    expect(parseRequirementAssessment(`${READY_DOC}\n需要日志、指标等等。`).ambiguities.length).toBe(1);
    expect(parseRequirementAssessment(`${READY_DOC}\n等等，先确认一件事。`).ambiguities.length).toBe(0);
  });

  it("a single sentence longer than 120 characters is ambiguous", () => {
    const longSentence = `${"很长的描述".repeat(30)}。`;
    const assessment = parseRequirementAssessment(`${READY_DOC}\n${longSentence}`);
    expect(assessment.ambiguities.length).toBe(1);
    expect(assessment.ambiguities[0]!.endsWith("…")).toBe(true);
  });

  it("declared needs-clarify survives an otherwise complete document", () => {
    const doc = READY_DOC.replace("\nready", "\nneeds-clarify");
    expect(parseRequirementAssessment(doc).verdict).toBe("needs-clarify");
  });
});

describe("parseDecisionLedger", () => {
  it("absent ledger → all facts false/empty", () => {
    expect(parseDecisionLedger(READY_DOC)).toEqual({
      present: false,
      entries: 0,
      labels: [],
      hasEliminatedReasons: false,
      hasConflictMatrix: false,
    });
  });

  it("rows, labels and markers are parsed", () => {
    const ledger = parseDecisionLedger(LEDGER_DOC);
    expect(ledger.present).toBe(true);
    expect(ledger.entries).toBe(3);
    expect(ledger.labels).toEqual(["Q1 起点", "Q2 预算"]);
    expect(ledger.hasEliminatedReasons).toBe(true);
    expect(ledger.hasConflictMatrix).toBe(true);
  });
});

describe("parseClarifyQuestionCount", () => {
  it("counts questions of the latest round only", () => {
    const doc = [
      "## 第 1 轮",
      "## 问题 1",
      "## 问题 2",
      "## 问题 3",
      "## 第 2 轮",
      "## 问题 1",
      "## 问题 2",
    ].join("\n");
    expect(parseClarifyQuestionCount(doc)).toBe(2);
  });

  it("without round headings the whole document counts", () => {
    expect(parseClarifyQuestionCount("## 问题 1\n## 问题 2\n## 问题 3")).toBe(3);
  });

  it("no questions → 0", () => {
    expect(parseClarifyQuestionCount(READY_DOC)).toBe(0);
  });
});

describe("buildProtocolDirective", () => {
  const ready = parseRequirementAssessment(READY_DOC);
  const completeLedger = parseDecisionLedger(LEDGER_DOC);

  it("nothing to complete → null", () => {
    expect(
      buildProtocolDirective({ assessment: ready, ledger: completeLedger, questionCount: 2, tier: "rule" }),
    ).toBeNull();
  });

  it("missing assessment section is requested", () => {
    const directive = buildProtocolDirective({
      assessment: { present: false, verdict: "unknown", missingSections: [], ambiguities: [] },
      ledger: completeLedger,
      questionCount: 1,
      tier: "rule",
    });
    expect(directive).toContain("## 需求评估");
    expect(directive).toContain("ready");
  });

  it("two or more questions require the ledger", () => {
    const directive = buildProtocolDirective({
      assessment: ready,
      ledger: { present: false, entries: 0, labels: [], hasEliminatedReasons: false, hasConflictMatrix: false },
      questionCount: 2,
      tier: "rule",
    });
    expect(directive).toContain("## 组合决策台账");
  });

  it("assisted adds the conflict matrix requirement, rule does not", () => {
    const ledger = { present: true, entries: 2, labels: ["Q1"], hasEliminatedReasons: true, hasConflictMatrix: false };
    const rule = buildProtocolDirective({ assessment: ready, ledger, questionCount: 1, tier: "rule" });
    const assisted = buildProtocolDirective({ assessment: ready, ledger, questionCount: 1, tier: "assisted" });
    expect(rule).toBeNull();
    expect(assisted).toContain("冲突矩阵");
  });

  it("ambiguities are listed as fragments", () => {
    const directive = buildProtocolDirective({
      assessment: { ...ready, ambiguities: ["延迟待定"] },
      ledger: completeLedger,
      questionCount: 1,
      tier: "rule",
    });
    expect(directive).toContain("延迟待定");
  });
});
