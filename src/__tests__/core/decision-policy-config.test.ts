/**
 * 210 Phase 0: decisionPolicy / watchdog JSON config parsing + fail-fast
 * static validation (requirement 5.2 / Q6=A).
 *
 * Covered here (NOT merged into json-config.test.ts per plan):
 * - legal policy parses; `enabled` omitted → true ("configured = effective")
 * - illegal combos throw with reason + decision in the message
 * - projects without the blocks do not trigger validation (baseline output)
 */
import { describe, expect, it } from "bun:test";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { allowedDecisions, validateDecisionPolicy } from "../../core/decision-policy/policy-config";

function baseJson(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    stages: {
      clarify: { nextStage: "plan" },
      plan: { nextStage: "develop" },
      develop: { nextStage: "review" },
      review: { nextStage: "fix" },
      fix: { nextStage: "completed" },
      completed: { nextStage: null },
    },
    ...extra,
  };
}

describe("decisionPolicy parsing (210 Phase 0)", () => {
  it("parses a legal policy with defaults", () => {
    const json = baseJson({
      decisionPolicy: {
        byReason: { max_loop_cycles: { decision: "set_budget", budgetValue: 5 } },
        stages: { review: { byReason: { violation_overflow: { decision: "restart" } } } },
      },
    });
    const cfg = resolvePipelineConfig(json as never);
    expect(cfg.decisionPolicy).toBeDefined();
    expect(cfg.decisionPolicy?.enabled).toBe(true); // omitted enabled → true
    expect(cfg.decisionPolicy?.byReason?.max_loop_cycles?.decision).toBe("set_budget");
    expect(cfg.decisionPolicy?.byReason?.max_loop_cycles?.budgetValue).toBe(5);
    expect(cfg.decisionPolicy?.stages?.review?.byReason?.violation_overflow?.decision).toBe("restart");
  });

  it("explicit enabled: false is preserved", () => {
    const cfg = resolvePipelineConfig(baseJson({ decisionPolicy: { enabled: false } }) as never);
    expect(cfg.decisionPolicy?.enabled).toBe(false);
  });

  it("unconfigured projects keep baseline output (no decisionPolicy/watchdog keys attached)", () => {
    const cfg = resolvePipelineConfig(baseJson() as never);
    expect(cfg.decisionPolicy).toBeUndefined();
    expect(cfg.watchdog).toBeUndefined();
  });

  it("illegal decision for a reason throws with reason and decision in message", () => {
    const json = baseJson({
      decisionPolicy: { byReason: { max_loop_cycles: { decision: "skip" } } },
    });
    expect(() => resolvePipelineConfig(json as never)).toThrow(/max_loop_cycles/);
    expect(() => resolvePipelineConfig(json as never)).toThrow(/decision "skip"/);
  });

  it("confirm_awaiting_human: resume is rejected (Q15=A)", () => {
    const json = baseJson({
      decisionPolicy: { byReason: { confirm_awaiting_human: { decision: "resume" } } },
    });
    expect(() => resolvePipelineConfig(json as never)).toThrow(/confirm_awaiting_human/);
  });

  it("choose_stage without targetStage throws", () => {
    const json = baseJson({
      decisionPolicy: { byReason: { "*": { decision: "choose_stage" } } },
    });
    expect(() => resolvePipelineConfig(json as never)).toThrow(/choose_stage/);
    expect(() => resolvePipelineConfig(json as never)).toThrow(/targetStage/);
  });

  it("set_budget missing budgetValue or non-positive integer throws", () => {
    const missing = baseJson({
      decisionPolicy: { byReason: { max_loop_cycles: { decision: "set_budget" } } },
    });
    expect(() => resolvePipelineConfig(missing as never)).toThrow(/set_budget/);
    expect(() => resolvePipelineConfig(missing as never)).toThrow(/budgetValue/);

    const zero = baseJson({
      decisionPolicy: { byReason: { max_loop_cycles: { decision: "set_budget", budgetValue: 0 } } },
    });
    expect(() => resolvePipelineConfig(zero as never)).toThrow(/set_budget/);

    const fractional = baseJson({
      decisionPolicy: { byReason: { max_loop_cycles: { decision: "set_budget", budgetValue: 1.5 } } },
    });
    expect(() => resolvePipelineConfig(fractional as never)).toThrow(/set_budget/);

    const negative = baseJson({
      decisionPolicy: { byReason: { max_loop_cycles: { decision: "set_budget", budgetValue: -2 } } },
    });
    expect(() => resolvePipelineConfig(negative as never)).toThrow(/set_budget/);
  });

  it("unknown byReason keys warn but do not throw (forward compatible)", () => {
    const json = baseJson({
      decisionPolicy: { byReason: { some_future_reason: { decision: "restart" } } },
    });
    const cfg = resolvePipelineConfig(json as never);
    expect(cfg.decisionPolicy?.byReason?.some_future_reason?.decision).toBe("restart");
  });
});

describe("watchdog parsing (210 Phase 0)", () => {
  it("explicit enabled: true and thresholds parse", () => {
    const cfg = resolvePipelineConfig(
      baseJson({ watchdog: { enabled: true, stageTimeoutMs: 100_000, stageIdleTimeoutMs: 50_000 } }) as never,
    );
    expect(cfg.watchdog?.enabled).toBe(true);
    expect(cfg.watchdog?.stageTimeoutMs).toBe(100_000);
    expect(cfg.watchdog?.stageIdleTimeoutMs).toBe(50_000);
  });

  it("block presence without enabled stays off (opt-in)", () => {
    const cfg = resolvePipelineConfig(baseJson({ watchdog: {} }) as never);
    expect(cfg.watchdog?.enabled).toBeUndefined();
  });

  it("invalid thresholds warn and drop", () => {
    const cfg = resolvePipelineConfig(
      baseJson({ watchdog: { enabled: true, stageTimeoutMs: -1, stageIdleTimeoutMs: 1.5 } }) as never,
    );
    expect(cfg.watchdog?.stageTimeoutMs).toBeUndefined();
    expect(cfg.watchdog?.stageIdleTimeoutMs).toBeUndefined();
  });
});

describe("allowedDecisions / validateDecisionPolicy unit contract", () => {
  it("base set contains the six navigation decisions", () => {
    for (const d of ["resume", "skip", "rollback", "restart", "abort", "choose_stage"]) {
      expect(allowedDecisions("*").has(d as never)).toBe(true);
    }
    expect(allowedDecisions("*").has("set_budget")).toBe(false);
  });

  it("max_loop_cycles allows only the breaker escapes", () => {
    for (const d of ["set_budget", "rewind_last_round", "restart", "abort", "resume"]) {
      expect(allowedDecisions("max_loop_cycles").has(d as never)).toBe(true);
    }
    expect(allowedDecisions("max_loop_cycles").has("skip")).toBe(false);
  });

  it("confirm_awaiting_human allows only restart|abort", () => {
    expect(allowedDecisions("confirm_awaiting_human").has("restart")).toBe(true);
    expect(allowedDecisions("confirm_awaiting_human").has("abort")).toBe(true);
    expect(allowedDecisions("confirm_awaiting_human").has("resume")).toBe(false);
  });

  it("validateDecisionPolicy accepts legal stage overrides", () => {
    expect(() =>
      validateDecisionPolicy({
        enabled: true,
        byReason: { "*": { decision: "abort" } },
        stages: { review: { byReason: { violation_overflow: { decision: "restart" } } } },
      }),
    ).not.toThrow();
  });
});
