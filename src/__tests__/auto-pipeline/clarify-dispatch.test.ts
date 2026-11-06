/**
 * 220 Phase 1 (D1/D2): pure clarify dispatch decision.
 *
 * Key behaviors:
 * - Decision order is total and fixed (confirmed wins over budget/stall).
 * - `fresh` dispatches `" 1"` (the human-path literal), `await-answer`
 *   dispatches `" {round} 答"`, `full-und?` dispatches `" full-und?"`.
 * - A second evaluation inside the 30s window coalesces instead of dispatching.
 * - The human track (no active job) is inert.
 */
import { describe, it, expect } from "bun:test";
import type { VerifyContractAnchors } from "../../utils/contract-loader";
import type { RequirementAssessment } from "../../core/auto-pipeline/clarify-protocol";
import {
  CLARIFY_DISPATCH_DEDUPE_MS,
  decideClarifyDispatch,
  type ClarifyDispatchInput,
} from "../../core/auto-pipeline/clarify-dispatch";

const ANCHORS: VerifyContractAnchors = {
  roundHeading: { patterns: ["^## 第 (\\d+) 轮"], mode: "or" },
  answerField: { patterns: ["答："], mode: "or" },
  modelConfirm: { patterns: ["## 模型确认"], mode: "or" },
};

const NO_PROBLEM: RequirementAssessment = {
  present: true,
  verdict: "ready",
  missingSections: [],
  ambiguities: [],
};

function baseInput(overrides: Partial<ClarifyDispatchInput> = {}): ClarifyDispatchInput {
  return {
    autoActive: true,
    requirementDoc: "docs/design/200_Feat.md",
    docText: "",
    anchors: ANCHORS,
    usedRounds: 0,
    maxRounds: 5,
    stalls: 0,
    stallLimit: 3,
    needsClarifyStreak: 0,
    needsClarifyLimit: 2,
    // 226 Phase 1 (review B-#8h): every matrix row carries the fact; the
    // finalisation-pending rows override it to true.
    finalisationDispatched: false,
    assessment: NO_PROBLEM,
    now: 1_000,
    ...overrides,
  };
}

describe("decideClarifyDispatch — forwarding states", () => {
  it("no active job → not-auto", () => {
    const decision = decideClarifyDispatch(baseInput({ autoActive: false }));
    expect(decision.action).toBe("not-auto");
    expect(decision.extraArgs).toBeUndefined();
    expect(decision.coalesced).toBe(false);
  });

  it("fresh document → dispatch ' 1' (leading space)", () => {
    const decision = decideClarifyDispatch(baseInput());
    expect(decision.action).toBe("fresh");
    expect(decision.extraArgs).toBe(" 1");
    expect(decision.round).toBe(1);
  });

  it("latest round awaiting an answer → dispatch ' {round} 答'", () => {
    const docText = ["## 第 2 轮", "## 问题 1", "未回答的题目"].join("\n");
    const decision = decideClarifyDispatch(baseInput({ docText, usedRounds: 1 }));
    expect(decision.action).toBe("await-answer");
    expect(decision.extraArgs).toBe(" 2 答");
    expect(decision.round).toBe(2);
  });

  it("answered but not converged (needs-clarify) → continue round", () => {
    const docText = ["## 第 1 轮", "## 问题 1", "答：选项 A"].join("\n");
    const decision = decideClarifyDispatch(
      baseInput({ docText, usedRounds: 1, assessment: { ...NO_PROBLEM, verdict: "needs-clarify" } }),
    );
    expect(decision.action).toBe("continue");
    expect(decision.extraArgs).toBe(" 1 答");
    expect(decision.round).toBe(1);
  });

  it("answered but `unknown` (no declared assessment) → continue round", () => {
    const docText = ["## 第 2 轮", "## 问题 1", "答：选项 A"].join("\n");
    const decision = decideClarifyDispatch(
      baseInput({ docText, usedRounds: 1, assessment: { ...NO_PROBLEM, verdict: "unknown" } }),
    );
    expect(decision.action).toBe("continue");
    expect(decision.extraArgs).toBe(" 2 答");
    expect(decision.round).toBe(2);
  });

  it("answered and converged (ready) → spawn the finalisation round", () => {
    const docText = ["## 第 3 轮", "## 问题 1", "答：选项 A"].join("\n");
    const decision = decideClarifyDispatch(baseInput({ docText, usedRounds: 2 }));
    expect(decision.action).toBe("spawn-full-und");
    expect(decision.extraArgs).toBe(" full-und?");
    expect(decision.round).toBe(3);
  });

  it("no answer takes priority over convergence → await-answer even when ready", () => {
    const docText = ["## 第 2 轮", "## 问题 1", "未回答的题目"].join("\n");
    const decision = decideClarifyDispatch(baseInput({ docText, usedRounds: 1 }));
    expect(decision.action).toBe("await-answer");
    expect(decision.extraArgs).toBe(" 2 答");
    expect(decision.round).toBe(2);
  });

  it("no answer + needs-clarify → await-answer (never a finalisation)", () => {
    const docText = ["## 第 2 轮", "## 问题 1", "未回答的题目"].join("\n");
    const decision = decideClarifyDispatch(
      baseInput({ docText, usedRounds: 1, assessment: { ...NO_PROBLEM, verdict: "needs-clarify" } }),
    );
    expect(decision.action).toBe("await-answer");
  });

  it("finalisation already dispatched + marker still missing → await-finalisation (skips the budget gate)", () => {
    const docText = ["## 第 3 轮", "## 问题 1", "答：选项 A"].join("\n");
    const decision = decideClarifyDispatch(
      baseInput({ docText, usedRounds: 3, maxRounds: 3, finalisationDispatched: true }),
    );
    // The finalisation round consumed round 3 of 3 — the budget gate MUST be
    // evaluated after this check (226 review #1).
    expect(decision.action).toBe("await-finalisation");
    expect(decision.round).toBe(3);
    expect(decision.extraArgs).toBeUndefined();
    expect(decision.reason).toBe("clarify_finalisation_pending");
  });

  it("finalisation already dispatched + no round heading (fresh) → await-finalisation on the derived round", () => {
    const decision = decideClarifyDispatch(
      baseInput({ docText: "## 目标\n做点什么", usedRounds: 2, finalisationDispatched: true }),
    );
    // Review B-#2: `derived.kind === "fresh"` has no `.round` — the already
    // computed `derivedRound` must be used, never an out-of-bounds access.
    expect(decision.action).toBe("await-finalisation");
    expect(decision.round).toBe(3);
  });

  it("confirmed → no dispatch", () => {
    const docText = ["## 第 3 轮", "答：选项 A", "## 模型确认", "是"].join("\n");
    const decision = decideClarifyDispatch(baseInput({ docText, usedRounds: 3 }));
    expect(decision.action).toBe("confirmed");
    expect(decision.extraArgs).toBeUndefined();
  });
});

describe("decideClarifyDispatch — discipline gates", () => {
  it("confirmed wins over budget exhaustion", () => {
    const docText = ["## 第 9 轮", "答：A", "## 模型确认"].join("\n");
    const decision = decideClarifyDispatch(baseInput({ docText, usedRounds: 9, maxRounds: 2 }));
    expect(decision.action).toBe("confirmed");
  });

  it("budget wins over stall and unclear", () => {
    const decision = decideClarifyDispatch(
      baseInput({ usedRounds: 5, maxRounds: 5, stalls: 9, needsClarifyStreak: 9 }),
    );
    expect(decision.action).toBe("budget-exhausted");
  });

  it("answered + converged but budget exhausted → budget-exhausted (freeze, no finalisation dispatch)", () => {
    const docText = ["## 第 5 轮", "## 问题 1", "答：选项 A"].join("\n");
    const decision = decideClarifyDispatch(baseInput({ docText, usedRounds: 5, maxRounds: 5 }));
    expect(decision.action).toBe("budget-exhausted");
  });

  it("stall wins over unclear", () => {
    const decision = decideClarifyDispatch(baseInput({ stalls: 3, stallLimit: 3, needsClarifyStreak: 5 }));
    expect(decision.action).toBe("stalled");
  });

  it("unclear streak freezes when the limit is reached", () => {
    const decision = decideClarifyDispatch(
      baseInput({
        needsClarifyStreak: 2,
        assessment: { ...NO_PROBLEM, verdict: "needs-clarify" },
      }),
    );
    expect(decision.action).toBe("requirement-unclear");
    expect(decision.reason).toBe("clarify_requirement_unclear");
  });

  it("stall/unclear gates are disabled by a 0 limit", () => {
    const decision = decideClarifyDispatch(
      baseInput({ stalls: 99, stallLimit: 0, needsClarifyStreak: 99, needsClarifyLimit: 0 }),
    );
    expect(decision.action).toBe("fresh");
  });

  it("missing document text falls back to fresh (fail-open)", () => {
    const decision = decideClarifyDispatch(baseInput({ docText: null }));
    expect(decision.action).toBe("fresh");
  });
});

describe("decideClarifyDispatch — dedupe window", () => {
  it("same round inside 30s → coalesced", () => {
    const decision = decideClarifyDispatch(
      baseInput({ lastDispatchedRound: 1, lastDispatchedAt: 1_000, now: 1_000 + CLARIFY_DISPATCH_DEDUPE_MS - 1 }),
    );
    expect(decision.action).toBe("fresh");
    expect(decision.coalesced).toBe(true);
  });

  it("same round after 30s → not coalesced", () => {
    const decision = decideClarifyDispatch(
      baseInput({ lastDispatchedRound: 1, lastDispatchedAt: 1_000, now: 1_000 + CLARIFY_DISPATCH_DEDUPE_MS }),
    );
    expect(decision.coalesced).toBe(false);
  });

  it("a different round is never coalesced", () => {
    const docText = ["## 第 4 轮", "## 问题 1", "答：A"].join("\n");
    const decision = decideClarifyDispatch(
      baseInput({ docText, usedRounds: 3, lastDispatchedRound: 3, lastDispatchedAt: 1_000, now: 1_100 }),
    );
    expect(decision.action).toBe("spawn-full-und");
    expect(decision.coalesced).toBe(false);
  });

  it("freeze actions are never reported as coalesced", () => {
    const decision = decideClarifyDispatch(baseInput({ stalls: 3, lastDispatchedRound: 1, lastDispatchedAt: 1_000 }));
    expect(decision.action).toBe("stalled");
    expect(decision.coalesced).toBe(false);
  });
});
