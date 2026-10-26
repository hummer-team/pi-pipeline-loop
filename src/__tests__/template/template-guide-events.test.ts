/**
 * 211 Phase 2: guide.md audit-event table drift lock.
 *
 * The `/pipeline-status` hint and the child/owner contract are documented in
 * `src/template/guide.md` §7.5. This test keeps the new confirm-gate event
 * names from drifting out of the doc when subsequent refactors rename them.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GUIDE = readFileSync(
  join(process.cwd(), "src", "template", "guide.md"),
  "utf8",
);

describe("template guide.md audit-event contracts (211 Phase 2)", () => {
  it("documents the child-suppression → owner-representation contract in the event table", () => {
    // The suppressed-child row names the defer stamp + one-shot arm broadcast.
    expect(GUIDE).toContain("confirm_gate_suppressed_child");
    expect(GUIDE).toContain("deferredAt");
    expect(GUIDE).toContain("一次性 arm 广播");
  });

  it("lists the 211 owner-representation escalation event family", () => {
    for (const event of [
      "confirm_gate_owner_reprompt",
      "confirm_gate_owner_reprompt_skipped",
      "confirm_gate_owner_reprompt_error",
      "confirm_gate_escalation_armed",
    ]) {
      expect(GUIDE).toContain(`\`${event}\``);
    }
  });

  it("lists the 211 owner-wake escalation channel events", () => {
    for (const event of [
      "owner_wake_escalation",
      "owner_wake_escalation_skipped",
      "owner_wake_escalation_failed",
    ]) {
      expect(GUIDE).toContain(`\`${event}\``);
    }
  });

  it("keeps the skip-reason vocabulary in sync with the re-presentation guard", () => {
    // Reasons per the plan: child / not_bound / predicate_mismatch / reask_exhausted.
    expect(GUIDE).toContain("predicate_mismatch");
    expect(GUIDE).toContain("reask_exhausted");
  });
});
