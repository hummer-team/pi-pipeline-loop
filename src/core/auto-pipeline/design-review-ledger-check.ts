/**
 * @module auto-pipeline/design-review-ledger-check
 * 220 Phase 1/4 (D4): deterministic "plan traces back to the decision ledger"
 * check used to EXTEND the design-review prompt.
 *
 * Facts:
 * - The check is deterministic (substring presence) so the reviewer receives
 *   facts, not a verdict: the review contract (`PASS` / `FAIL`) is unchanged.
 * - AUTO ONLY: without `meta.autoJob` the caller never asks for a directive,
 *   so the human-track prompt stays byte-identical.
 * - `rule` (3 items) and `assisted` (6 items) mirror the C-2 tier split.
 */

/** One label whose decision is not referenced by the plan document. */
export interface MissingLedgerReference {
  label: string;
}

/**
 * Count how many ledger labels appear in the plan text.
 * Matching is case-sensitive whole-substring (labels are user-authored names).
 */
export function countLedgerReferences(labels: readonly string[], planText: string): number {
  let count = 0;
  for (const label of labels) {
    if (label.length > 0 && planText.includes(label)) count += 1;
  }
  return count;
}

/** Labels that the plan never mentions (order preserved). */
function missingLabels(labels: readonly string[], planText: string): MissingLedgerReference[] {
  return labels
    .filter((label) => label.length > 0 && !planText.includes(label))
    .map((label) => ({ label }));
}

/** Checklist items shared by both tiers. */
const RULE_CHECKS = [
  "Every hard constraint recorded in the ledger is satisfied by the plan.",
  "Every eliminated option carries its elimination reason in the ledger.",
  "No undecided conflict between two ledger decisions is left open.",
];

/** Extra checklist items of the `assisted` tier. */
const ASSISTED_CHECKS = [
  "An eliminated option is not silently reintroduced by the plan.",
  "The plan introduces no option that is absent from the ledger.",
  "For every dimension, the chosen option is not worse than the eliminated one.",
];

/**
 * Build the traceability checklist for the reviewer prompt.
 *
 * @returns NULL when the ledger has no labels or every label is referenced.
 */
export function buildLedgerTraceabilityDirective(input: {
  labels: readonly string[];
  planText: string;
  tier: "rule" | "assisted";
  ledger: { hasEliminatedReasons: boolean; hasConflictMatrix: boolean };
}): string | null {
  const labels = input.labels.filter((label) => label.length > 0);
  if (labels.length === 0) return null;
  // Same counter the callers use, so "fully covered" has one definition.
  if (countLedgerReferences(labels, input.planText) === labels.length) return null;
  const missing = missingLabels(labels, input.planText);

  const checks = input.tier === "assisted" ? [...RULE_CHECKS, ...ASSISTED_CHECKS] : RULE_CHECKS;
  const lines = [
    "[auto-pipeline] Ledger traceability (facts, not a verdict):",
    `- The plan does not reference these decided items: ${missing.map((m) => m.label).join(" | ")}.`,
    `- Elimination reasons documented: ${input.ledger.hasEliminatedReasons ? "yes" : "no"}.`,
    `- Conflict matrix documented: ${input.ledger.hasConflictMatrix ? "yes" : "no"}.`,
    "Checklist:",
    ...checks.map((check) => `- ${check}`),
    "Report every inconsistency you find under Issues; the PASS/FAIL contract is unchanged.",
  ];
  return lines.join("\n");
}
