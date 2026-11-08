/**
 * 220 Phase 2 (D6 + D7) — `job-schema` delta over 219.
 *
 * Pins the CONVERGED contract:
 * - every default is filled at the schema layer (a minimal job never leaks
 *   `undefined` downstream — an `undefined < 1` would silently disable a budget);
 * - the seven removed/renamed keys are HARD errors that name themselves
 *   (a 219-era job must fail loudly instead of degrading);
 * - `defaults.startStage` accepts RESUMABLE_STAGES + "auto" only;
 * - `configured` records the "inherit-not-overlay" provenance of
 *   `verify.maxAttempts` / `writePolicy.gitModify`.
 */
import { describe, it, expect } from "bun:test";
import { parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { RESUMABLE_STAGES } from "../../constants";

const MINIMAL = "version: 1\nenabled: true\ndocs:\n  list:\n    - doc: docs/a.md\n";

function parse(yamlText: string) {
  return parseAutoJob(yamlText, "docs/jobs/delta.yaml");
}

function jobOrThrow(yamlText: string = MINIMAL): AutoJobConfig {
  const result = parse(yamlText);
  if (!result.ok) throw new Error(`fixture must parse: ${result.errors.join("; ")}`);
  return result.job;
}

describe("job-schema delta — default snapshot (220 D7 table)", () => {
  it("a minimal job resolves EVERY key of the defaults table", () => {
    const job = jobOrThrow();
    expect({
      tier: job.tier,
      clarify: job.clarify,
      designReview: job.designReview,
      reviewFix: job.reviewFix,
      verify: job.verify,
      writePolicy: job.writePolicy,
      freezePolicy: job.freezePolicy,
      audit: job.audit,
      defaults: job.defaults,
      stopConditions: job.stopConditions,
      chain: job.chain,
      docs: { skipCompleted: job.docs.skipCompleted, onFailure: job.docs.onFailure },
      confirm: job.confirm,
      configured: job.configured,
    }).toEqual({
      tier: "assisted",
      clarify: { strategy: "self-answer", maxRounds: 5, onExhausted: "stop" },
      designReview: { mode: "smart", maxRounds: 3, onFail: "auto-revise" },
      reviewFix: { maxRounds: 6, maxLoopsPerStage: 6 },
      verify: { maxAttempts: 3 },
      writePolicy: {
        whitelistMiss: "deny",
        protectedPath: "deny",
        destructiveCommand: "deny",
        allowGlobs: [],
        gitModify: "block",
      },
      freezePolicy: { onFreeze: "resume", maxAutoResumes: 2, byReason: {} },
      audit: { autoDecisions: true },
      defaults: { startStage: "clarify" },
      stopConditions: {
        maxTotalFreezes: 0,
        maxTotalLoops: 20,
        wallClockMs: 0,
        stopOnBlockedReasons: [],
        finalLoopGrace: 1,
      },
      chain: { newSession: true, onSessionFail: "same-session" },
      docs: { skipCompleted: true, onFailure: "stop" },
      confirm: { plan: "auto", review: "auto", "design-review": "smart" },
      configured: { verifyMaxAttempts: false, gitModify: false },
    });
  });

  it("no default is `undefined` (downstream comparisons stay meaningful)", () => {
    const job = jobOrThrow();
    for (const [key, value] of Object.entries(job.stopConditions)) {
      expect(value).not.toBeUndefined();
      if (key !== "stopOnBlockedReasons") expect(typeof value).toBe("number");
    }
    expect(job.verify.maxAttempts).not.toBeUndefined();
    expect(job.writePolicy.gitModify).not.toBeUndefined();
    expect(job.defaults.startStage).not.toBeUndefined();
    expect(job.clarify.onExhausted).not.toBeUndefined();
    expect(job.designReview.onFail).not.toBeUndefined();
  });

  it("`configured` flips only when the inherit-not-overlay key is written", () => {
    const explicit = jobOrThrow(`${MINIMAL}verify:\n  maxAttempts: 7\nwritePolicy:\n  gitModify: allow\n`);
    expect(explicit.verify.maxAttempts).toBe(7);
    expect(explicit.writePolicy.gitModify).toBe("allow");
    expect(explicit.configured).toEqual({ verifyMaxAttempts: true, gitModify: true });

    const partial = jobOrThrow(`${MINIMAL}verify:\n  maxAttempts: 2\n`);
    expect(partial.configured).toEqual({ verifyMaxAttempts: true, gitModify: false });
  });
});

describe("job-schema delta — 220 D6/D7 removed keys are hard errors", () => {
  // The plan's six removed keys + the renamed block.
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ["clarify.mode", "clarify:\n  mode: self-answer\n", "clarify.mode"],
    ["clarify.fallback", "clarify:\n  fallback: orchestrated\n", "clarify.fallback"],
    ["clarify.answerStrategy", "clarify:\n  answerStrategy: first-option\n", "clarify.answerStrategy"],
    ["designReview.failAction", "designReview:\n  failAction: stop\n", "designReview.failAction"],
    ["audit.recordAutoDecisions", "audit:\n  recordAutoDecisions: false\n", "audit.recordAutoDecisions"],
    [
      "stopConditions.maxConsecutiveVerifyFailures",
      "stopConditions:\n  maxConsecutiveVerifyFailures: 3\n",
      "stopConditions.maxConsecutiveVerifyFailures",
    ],
  ];

  it.each(CASES)("%s → error naming the key", (_label, block, key) => {
    const result = parse(`${MINIMAL}${block}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes(`"${key}"`) && e.includes("removed in this version"))).toBe(true);
  });

  it("the whole `decisionPolicy` block → error naming its replacement", () => {
    const result = parse(`${MINIMAL}decisionPolicy:\n  onFreeze: resume\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.errors.find((e) => e.includes("decisionPolicy"));
    expect(message).toBeDefined();
    expect(message!).toContain("freezePolicy");
    expect(message!).toContain("removed in this version");
  });

  it("an unknown key is still only a warning (the allowlist stays scoped)", () => {
    const result = parse(`${MINIMAL}futureKey: 1\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes('Unknown job key "futureKey"'))).toBe(true);
  });
});

describe("job-schema delta — `defaults.startStage` = RESUMABLE_STAGES ∪ {auto}", () => {
  it("accepts every resumable stage", () => {
    for (const stage of RESUMABLE_STAGES) {
      const result = parse(`${MINIMAL}defaults:\n  startStage: ${stage}\n`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.job.defaults.startStage).toBe(stage);
    }
  });

  it("accepts `auto`", () => {
    const result = parse(`${MINIMAL}defaults:\n  startStage: auto\n`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.job.defaults.startStage).toBe("auto");
  });

  it("rejects a non-resumable stage and an unknown string", () => {
    for (const value of ["awaiting_human", "completed", "deploy"]) {
      const result = parse(`${MINIMAL}defaults:\n  startStage: ${value}\n`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("defaults.startStage"))).toBe(true);
      }
    }
  });
});

describe("job-schema delta — enum validation (fail-fast)", () => {
  it.each([
    ["tier", "tier: manual\n", "tier"],
    ["clarify.onExhausted", "clarify:\n  onExhausted: retry\n", "clarify.onExhausted"],
    ["designReview.onFail", "designReview:\n  onFail: continue\n", "designReview.onFail"],
    ["writePolicy.gitModify", "writePolicy:\n  gitModify: warn\n", "writePolicy.gitModify"],
    ["freezePolicy.onFreeze", "freezePolicy:\n  onFreeze: choose_stage\n", "freezePolicy.onFreeze"],
  ])("%s rejects an out-of-range value", (_label, block, key) => {
    const result = parse(`${MINIMAL}${block}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes(key))).toBe(true);
  });

  it("`verify.maxAttempts` must be >= 1", () => {
    expect(parse(`${MINIMAL}verify:\n  maxAttempts: 0\n`).ok).toBe(false);
    const ok = parse(`${MINIMAL}verify:\n  maxAttempts: 1\n`);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.job.verify.maxAttempts).toBe(1);
  });

  it("`clarify.maxRounds` must be >= 1", () => {
    expect(parse(`${MINIMAL}clarify:\n  maxRounds: 0\n`).ok).toBe(false);
    const ok = parse(`${MINIMAL}clarify:\n  maxRounds: 1\n`);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.job.clarify.maxRounds).toBe(1);
  });

  it("`tier` is NOT part of the overlay mapping table (no json target exists)", () => {
    // Provenance statement, not a behaviour: the schema exposes `tier` for the
    // dispatch seam (Phase 4/5), never as a config write.
    const job = jobOrThrow(`${MINIMAL}tier: rule\n`);
    expect(job.tier).toBe("rule");
  });
});
