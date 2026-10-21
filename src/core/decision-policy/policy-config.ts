/**
 * @module decision-policy/policy-config
 * 210 Phase 0: allowed decision sets and fail-fast static validation for the
 * decision-provider policy (requirement 5.2 / 5.3). This module is import-free
 * (domain module) so the JSON config loader can validate at load time without
 * pulling any runtime dependencies.
 *
 * Phase 1 extends this module with `resolveRule` / `isDecisionPolicyEnabled`.
 */

import type { DecisionPolicyConfig, DecisionPolicyRule, PipelineDecision } from "../../types";

// ─── Allowed decision sets (static legality, Q6=A) ───────────────────────────

/**
 * Decisions allowed for the wildcard reason "*": plain pipeline navigation
 * decisions only (never parameterized ones like set_budget / choose_stage).
 */
const POLICY_BASE_DECISIONS: ReadonlySet<PipelineDecision> = new Set([
  "resume",
  "skip",
  "rollback",
  "restart",
  "abort",
  "choose_stage",
]);

/**
 * Decisions allowed when the max_loop_cycles breaker freezes the pipeline:
 * budget/rewind actions plus restart/abort/resume escapes.
 */
const POLICY_DECISIONS_BY_REASON: Record<string, ReadonlySet<PipelineDecision>> = {
  max_loop_cycles: new Set(["set_budget", "rewind_last_round", "restart", "abort", "resume"]),
  /**
   * 210 Phase 3 (R1-1 补全, Q15=A): the confirm-stall freeze allows ONLY
   * restart / abort — an automatic resume would defeat the very gate the
   * human rejected.
   */
  confirm_awaiting_human: new Set(["restart", "abort"]),
};

/**
 * Decisions allowed for confirm-type reasons (the confirm blocks are not
 * plain menu decisions — they are parameterized and their allowed sets live
 * in {@link POLICY_CONFIRM_DECISIONS}).
 */
const POLICY_CONFIRM_DECISIONS: ReadonlySet<PipelineDecision> = POLICY_BASE_DECISIONS;

/**
 * Returns the allowed decision set for a given blocked reason.
 * - "*" → base navigation set.
 * - Known reason → its configured set.
 * - Unknown reason → base set (forward compatible; unknown reason keys in
 *   the USER config only warn, they are treated as "no rule" at resolve time).
 */
export function allowedDecisions(reason: string): ReadonlySet<PipelineDecision> {
  return POLICY_DECISIONS_BY_REASON[reason] ?? POLICY_CONFIRM_DECISIONS;
}

// ─── Static validation (fail-fast, load time only) ───────────────────────────

/**
 * Validates a single rule against its reason's allowed set.
 * Throws when the shape is illegal — the JSON loader surfaces the error to
 * the user at config load time (fail-fast, Q6=A).
 *
 * @param rule - The rule to validate
 * @param reason - The blockedReason key the rule is filed under
 * @param origin - Human-readable origin for error messages ("global" / "stages.<stage>")
 */
function validateRule(rule: DecisionPolicyRule, reason: string, origin: string): void {
  const allowed = allowedDecisions(reason);
  if (!allowed.has(rule.decision)) {
    throw new Error(
      `decisionPolicy.${origin}: decision "${rule.decision}" is not allowed for reason "${reason}" ` +
        `(allowed: ${[...allowed].join(", ")})`,
    );
  }
  if (rule.decision === "choose_stage") {
    if (!rule.targetStage) {
      throw new Error(
        `decisionPolicy.${origin}: decision "choose_stage" for reason "${reason}" requires targetStage`,
      );
    }
    if (rule.budgetValue !== undefined) {
      throw new Error(
        `decisionPolicy.${origin}: decision "choose_stage" for reason "${reason}" must not set budgetValue`,
      );
    }
  }
  if (rule.decision === "set_budget") {
    if (
      rule.budgetValue === undefined ||
      typeof rule.budgetValue !== "number" ||
      !Number.isInteger(rule.budgetValue) ||
      rule.budgetValue <= 0
    ) {
      throw new Error(
        `decisionPolicy.${origin}: decision "set_budget" for reason "${reason}" requires budgetValue ` +
          `to be a positive integer (got ${String(rule.budgetValue)})`,
      );
    }
    if (rule.targetStage !== undefined) {
      throw new Error(
        `decisionPolicy.${origin}: decision "set_budget" for reason "${reason}" must not set targetStage`,
      );
    }
  }
}

/**
 * Validates the whole decision-policy configuration (fail-fast).
 * Called by `resolvePipelineConfig` ONLY when `decisionPolicy` is explicitly
 * configured — unconfigured projects never trigger validation (zero breakage).
 *
 * Throws with a message containing the offending reason and decision.
 */
export function validateDecisionPolicy(
  cfg: DecisionPolicyConfig,
): void {
  for (const [reason, rule] of Object.entries(cfg.byReason ?? {})) {
    validateRule(rule, reason, "global");
  }
  for (const [stage, stageBlock] of Object.entries(cfg.stages ?? {})) {
    for (const [reason, rule] of Object.entries(stageBlock?.byReason ?? {})) {
      validateRule(rule, reason, `stages.${stage}`);
    }
  }
}
