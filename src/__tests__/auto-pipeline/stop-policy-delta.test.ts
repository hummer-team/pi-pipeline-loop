/**
 * 220 Phase 3 (D7/Q15 + R4): the two stop-policy deltas.
 *
 * Sealed behaviors:
 * - the verify-failure stop reads the LIVE `meta.verifyAttempts` only; the
 *   legacy cross-stage sidecar streak can no longer freeze a recovered doc;
 * - R4 intersection: a blocked reason listed in `stopOnBlockedReasons` is a
 *   HARD stop even when `freezePolicy.byReason` would resume it — the hard stop
 *   is judged first and `byReason` only decides what happens to a freeze that is
 *   NOT already a hard stop.
 *
 * (The threshold matrix itself — at/under/unset `verifyAttempts` — is pinned by
 * `stop-policy.test.ts`; this file covers only the 220 deltas.)
 */
import { describe, it, expect } from "bun:test";
import { makeTestMeta } from "../helpers";
import { createJobState, type AutoJobState } from "../../core/auto-pipeline/job-state";
import { parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { evaluateHardStop } from "../../core/auto-pipeline/stop-policy";
import { resolveFreezeAction } from "../../core/auto-pipeline/freeze-autopilot";

const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/a.md",
  "stopConditions:",
  "  stopOnBlockedReasons:",
  "    - clarify_stalled",
  "verify:",
  "  maxAttempts: 3",
  "freezePolicy:",
  "  onFreeze: resume",
  "  maxAutoResumes: 2",
  "  byReason:",
  "    clarify_stalled: abort",
].join("\n");

const NOW = 20_000_000;

function job(): AutoJobConfig {
  const parsed = parseAutoJob(JOB_YAML, "docs/jobs/alpha.yaml");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.job;
}

function state(overrides?: Partial<AutoJobState>): AutoJobState {
  const base = createJobState({
    jobId: "alpha",
    jobPath: "docs/jobs/alpha.yaml",
    jobHash: "h",
    docs: [{ doc: "docs/design/a.md" }],
  });
  return { ...base, ...overrides };
}

describe("evaluateHardStop — Q15 delta", () => {
  it("a stale sidecar verify streak never stops a recovered document", () => {
    // `counters.consecutiveVerifyFailures` is 220-retired evidence: only the
    // LIVE `meta.verifyAttempts` (reset on stage advance) may stop the job.
    const stale = state({
      counters: { ...state().counters, consecutiveVerifyFailures: 99 },
    });
    expect(evaluateHardStop({ state: stale, meta: makeTestMeta(), job: job(), now: NOW }).kind).toBe(
      "continue",
    );
  });
});

describe("evaluateHardStop — R4 intersection", () => {
  it("hard stop wins over a byReason that would resume/abort", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "clarify_stalled" });
    expect(evaluateHardStop({ state: state(), meta, job: job(), now: NOW })).toEqual({
      kind: "hard",
      stopReason: "blocked_reason",
    });
  });

  it("byReason is only consulted for a freeze that is not already a hard stop", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "other_freeze" });
    expect(evaluateHardStop({ state: state(), meta, job: job(), now: NOW }).kind).toBe("continue");
    expect(resolveFreezeAction({ meta, job: job(), state: state(), reason: "other_freeze" })).toEqual({
      action: "resume",
      basis: "on_freeze",
    });
    // The intersection reason keeps its byReason action for the NON-hard-stop
    // judgement (reached only when the reason is absent from the hard list).
    expect(resolveFreezeAction({ meta, job: job(), state: state(), reason: "clarify_stalled" })).toEqual({
      action: "abort",
      basis: "by_reason",
    });
  });
});
