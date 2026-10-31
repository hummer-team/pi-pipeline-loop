/**
 * 219 Phase 1: auto-pipeline job YAML schema — parsing / validation / default
 * filling (fail-fast) + the example.yaml compatibility assertion.
 *
 * Key behaviors:
 * - fail-fast enums with the unified `— not supported in this version` suffix
 * - removed-v0 keys (`clarify.fallback` / `clarify.answerStrategy`) are errors,
 *   while unknown keys stay warnings
 * - defaults filled BEFORE return (downstream never sees undefined):
 *   `finalLoopGrace` → 1 (explicit 0 stays 0), conservative stop defaults
 * - `decisionPolicy.byReason` values are FreezeAction only (B2)
 * - docs entries: project-relative, ".md"-suffixed, no "..", deduped
 */
import { describe, it, expect } from "bun:test";
import { parseAutoJob, hashJobBytes, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "..", "..", "..");

function parseYaml(yamlText: string) {
  return parseAutoJob(yamlText, "docs/jobs/test.yaml");
}

describe("job-schema — legal minimal set + default fill", () => {
  it("minimal job (version+enabled+docs.list) parses with warnings for omitted sections", () => {
    const result = parseYaml(
      [
        "version: 1",
        "enabled: true",
        "docs:",
        "  list:",
        "    - doc: docs/design/200_Feat.md",
        "  skipCompleted: true",
        "  onFailure: continue",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const job: AutoJobConfig = result.job;
    // Defaults filled — never undefined.
    expect(job.docs.list).toHaveLength(1);
    expect(job.docs.onFailure).toBe("continue");
    expect(job.docs.skipCompleted).toBe(true);
    expect(job.clarify.mode).toBe("self-answer");
    expect(job.designReview.mode).toBe("auto");
    expect(job.reviewFix.maxRounds).toBe(6);
    expect(job.reviewFix.maxLoopsPerStage).toBe(6);
    expect(job.stopConditions.maxTotalLoops).toBe(20);
    expect(job.stopConditions.maxConsecutiveVerifyFailures).toBe(3);
    expect(job.stopConditions.maxTotalFreezes).toBe(0);
    expect(job.stopConditions.wallClockMs).toBe(0);
    expect(job.stopConditions.finalLoopGrace).toBe(1); // default 1
    expect(job.chain.newSession).toBe(true);
    expect(job.audit.recordAutoDecisions).toBe(true);
    // Defaults are surfaced in warnings.
    expect(result.warnings.some((w) => w.includes("finalLoopGrace"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("maxTotalLoops"))).toBe(true);
  });
  it("explicit finalLoopGrace: 0 stays 0 (disabled);cap 3 exceeded → error", () => {
    const zero = parseYaml("version: 1\nenabled: true\ndocs:\n  list:\n    - doc: docs/a.md\nstopConditions:\n  finalLoopGrace: 0\n");
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(zero.job.stopConditions.finalLoopGrace).toBe(0);

    const four = parseYaml("version: 1\ndocs:\n  list:\n    - doc: docs/a.md\nstopConditions:\n  finalLoopGrace: 4\n");
    expect(four.ok).toBe(false);
  });
});

describe("job-schema — docs validation", () => {
  it("missing docs.list → error", () => {
    const result = parseYaml("version: 1\nenabled: true\n");
    expect(result.ok).toBe(false);
  });

  it("absolute path / traversal / non-md → errors", () => {
    for (const doc of ["/abs/path.md", "../outside.md", "docs/notes.txt"]) {
      const result = parseYaml(`version: 1\ndocs:\n  list:\n    - doc: ${doc}\n`);
      expect(result.ok).toBe(false);
    }
  });

  it("startStage outside RESUMABLE_STAGES → error; awaiting_human rejected", () => {
    const result = parseYaml(
      "version: 1\ndocs:\n  list:\n    - doc: docs/a.md\n      startStage: awaiting_human\n",
    );
    expect(result.ok).toBe(false);
  });

  it("single-entry list is legal; duplicate entries deduped with a warning", () => {
    const result = parseYaml(
      ["version: 1", "docs:", "  list:", "    - doc: docs/a.md", "    - doc: docs/a.md"].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.docs.list).toHaveLength(1);
      expect(result.warnings.some((w) => w.includes("duplicate entry dropped"))).toBe(true);
    }
  });
});

describe("job-schema — fail-fast enums (known-but-unsupported = ERROR)", () => {
  const base = "version: 1\ndocs:\n  list:\n    - doc: docs/a.md\n";

  it.each([
    ["clarify.mode \"prefilled\"", `${base}clarify:\n  mode: prefilled\n`],
    ["clarify.fallback (removed key)", `${base}clarify:\n  fallback: none\n`],
    ["clarify.answerStrategy (removed key)", `${base}clarify:\n  answerStrategy: first-option\n`],
    ["designReview.mode manual", `${base}designReview:\n  mode: manual\n`],
    [
      "docs.onFailure halt",
      "version: 1\ndocs:\n  list:\n    - doc: docs/a.md\n  onFailure: halt\n",
    ],
    ["writePolicy.bad", `${base}writePolicy:\n  whitelistMiss: maybe\n`],
  ])("%s → ok:false with the version suffix", (_label, yaml) => {
    const result = parseYaml(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("not supported in this version"))).toBe(true);
    }
  });

  it("decisionPolicy.byReason 210 member → error; FreezeAction member → ok (B2)", () => {
    const bad = parseYaml(
      `${base}decisionPolicy:\n  byReason:\n    verify_budget: choose_stage\n`,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => e.includes("byReason.verify_budget"))).toBe(true);

    const good = parseYaml(
      `${base}decisionPolicy:\n  byReason:\n    verify_budget: resume\n`,
    );
    expect(good.ok).toBe(true);
  });

  it("unknown key foo: 1 → warning AND ok:true (contrast with explicit rejects)", () => {
    const result = parseYaml(`${base}foo: 1\n`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.some((w) => w.includes('Unknown job key "foo"'))).toBe(true);
  });
});

describe("job-schema — failing YAML", () => {
  it("syntactically broken YAML → ok:false with parse message, no throw", () => {
    const result = parseYaml("version: 1\ndocs:\n  list:\n    - doc: [unclosed\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("YAML parse failed");
    }
  });

  it("non-mapping document → ok:false", () => {
    const result = parseYaml("- just\n- a\n- list\n");
    expect(result.ok).toBe(false);
  });
});

describe("job-schema — enabled / version guards", () => {
  const base = "version: 1\ndocs:\n  list:\n    - doc: docs/a.md\n";

  it("version !== 1 → error with the version suffix", () => {
    const result = parseYaml("version: 2\ndocs:\n  list:\n    - doc: docs/a.md\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("not supported in this version");
  });

  it("enabled non-boolean → warned and forced false", () => {
    const result = parseYaml(`${base}enabled: "yes"\n`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.enabled).toBe(false);
      expect(result.warnings.some((w) => w.includes('"enabled" is not a boolean'))).toBe(true);
    }
  });
});

describe("job-schema — numeric guards", () => {
  const base = "version: 1\ndocs:\n  list:\n    - doc: docs/a.md\n";

  it("clarify.maxRounds 0 → error; maxTotalLoops 0 → error; negative wallClockMs → error", () => {
    expect(parseYaml(`${base}clarify:\n  maxRounds: 0\n`).ok).toBe(false);
    expect(parseYaml(`${base}stopConditions:\n  maxTotalLoops: 0\n`).ok).toBe(false);
    expect(parseYaml(`${base}stopConditions:\n  wallClockMs: -5\n`).ok).toBe(false);
    expect(parseYaml(`${base}stopConditions:\n  maxConsecutiveVerifyFailures: 0\n`).ok).toBe(false);
  });
});

describe("job-schema — example.yaml stays parseable (anti-drift)", () => {
  it("docs/jobs/example.yaml parses ok with the expected defaults", () => {
    const raw = readFileSync(path.join(SRC, "docs", "jobs", "example.yaml"), "utf8");
    const result = parseAutoJob(raw, "docs/jobs/example.yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.enabled).toBe(true);
    expect(result.job.docs.list.length).toBeGreaterThanOrEqual(2);
    expect(result.job.writePolicy.whitelistMiss).toBe("deny");
    expect(result.job.stopConditions.finalLoopGrace).toBe(1);
    expect(result.job.decisionPolicy.onFreeze).toBe("resume");
  });
});

describe("hashJobBytes", () => {
  it("sha256 over raw bytes; text vs buffer consistent", () => {
    const text = "version: 1\n";
    const hex = hashJobBytes(text);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hashJobBytes(Buffer.from(text, "utf8"))).toBe(hex);
    expect(hashJobBytes(text)).not.toBe(hashJobBytes(text + "\n"));
  });
});
