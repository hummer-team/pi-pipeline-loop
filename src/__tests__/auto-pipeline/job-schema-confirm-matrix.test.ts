/**
 * 227 Phase 0 (D-13/D-9/D-16): the generalized `confirm` matrix.
 *
 * Pins:
 * - three keys (`plan` / `review` / `design-review`) with the doc defaults
 *   `{ plan: auto, review: auto, "design-review": smart }`;
 * - fail-fast: unknown confirm key / unknown mode, and `manual` on plan|review
 *   (a TUI gate nobody can answer in an unattended run);
 * - the deprecated `designReview.mode` alias is resolved by PRESENCE: the
 *   default fill never participates in the conflict rule;
 * - `designReview.enabled` is a tri-state topology switch (absent = untouched);
 * - the shipped template parses as-is.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const MINIMAL = "version: 1\nenabled: true\ndocs:\n  list:\n    - doc: docs/a.md\n";

function parse(yamlText: string) {
  return parseAutoJob(yamlText, "docs/jobs/matrix_loop.yaml");
}

function jobOrThrow(yamlText: string = MINIMAL): AutoJobConfig {
  const result = parse(yamlText);
  if (!result.ok) throw new Error(`fixture must parse: ${result.errors.join("; ")}`);
  return result.job;
}

describe("job-schema confirm matrix — defaults", () => {
  it("fills all three keys and mirrors the design-review decision", () => {
    const job = jobOrThrow();
    expect(job.confirm).toEqual({ plan: "auto", review: "auto", "design-review": "smart" });
    expect(job.designReview.mode).toBe("smart");
    expect(job.designReview.enabled).toBeUndefined();
  });

  it("warns about the filled default matrix", () => {
    const result = parse(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes('"confirm" not set') && w.includes("design-review"))).toBe(true);
  });
});

describe("job-schema confirm matrix — validation", () => {
  it("accepts an explicit design-review key", () => {
    const job = jobOrThrow(`${MINIMAL}confirm:\n  design-review: smart\n`);
    expect(job.confirm["design-review"]).toBe("smart");
    expect(job.confirm.plan).toBe("auto");
  });

  it("unknown confirm key → error", () => {
    const result = parse(`${MINIMAL}confirm:\n  deploy: auto\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('"confirm.deploy"'))).toBe(true);
  });

  it("unknown mode → error", () => {
    const result = parse(`${MINIMAL}confirm:\n  design-review: maybe\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("confirm.design-review"))).toBe(true);
  });

  it("plan/review = manual → error (no TUI in an unattended run); smart stays legal", () => {
    for (const key of ["plan", "review"] as const) {
      const bad = parse(`${MINIMAL}confirm:\n  ${key}: manual\n`);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.errors.some((e) => e.includes(`confirm.${key}`) && e.includes("manual"))).toBe(true);

      const good = parse(`${MINIMAL}confirm:\n  ${key}: smart\n`);
      expect(good.ok).toBe(true);
    }
  });
});

describe("job-schema confirm matrix — deprecated `designReview.mode` alias", () => {
  it("a legacy file with only `mode: auto` gets the aliased value + one deprecation warning", () => {
    const result = parse(`${MINIMAL}designReview:\n  mode: auto\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.confirm["design-review"]).toBe("auto");
    expect(result.job.designReview.mode).toBe("auto");
    const deprecated = result.warnings.filter((w) => w.includes("designReview.mode"));
    expect(deprecated).toHaveLength(1);
  });

  it("both explicit and equal → ok with a single deprecation warning", () => {
    const result = parse(`${MINIMAL}confirm:\n  design-review: manual\ndesignReview:\n  mode: manual\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.confirm["design-review"]).toBe("manual");
    expect(result.warnings.filter((w) => w.includes("designReview.mode"))).toHaveLength(1);
  });

  it("both explicit and different → error (presence decides, never the default)", () => {
    const result = parse(`${MINIMAL}confirm:\n  design-review: smart\ndesignReview:\n  mode: auto\n`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("designReview.mode") && e.includes('confirm.design-review'))).toBe(true);
    }
  });

  it("the default fill never conflicts with an explicit confirm key", () => {
    const result = parse(`${MINIMAL}confirm:\n  design-review: manual\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.confirm["design-review"]).toBe("manual");
    expect(result.job.designReview.mode).toBe("manual");
    expect(result.warnings.some((w) => w.includes("conflicts"))).toBe(false);
  });
});

describe("job-schema confirm matrix — designReview.enabled tri-state", () => {
  it("absent → undefined (topology untouched)", () => {
    expect(jobOrThrow(`${MINIMAL}designReview:\n  maxRounds: 2\n`).designReview.enabled).toBeUndefined();
  });

  it("true / false are preserved", () => {
    expect(jobOrThrow(`${MINIMAL}designReview:\n  enabled: true\n`).designReview.enabled).toBe(true);
    expect(jobOrThrow(`${MINIMAL}designReview:\n  enabled: false\n`).designReview.enabled).toBe(false);
  });

  it("non-boolean → error", () => {
    const result = parse(`${MINIMAL}designReview:\n  enabled: "yes"\n`);
    expect(result.ok).toBe(false);
  });
});

describe("job-schema confirm matrix — shipped template", () => {
  it("the distributed template parses with the three-key matrix", () => {
    const raw = readFileSync(path.join(SRC_ROOT, "src", "template", "auto_job_loop_template.yaml"), "utf8");
    const result = parseAutoJob(raw, "docs/jobs/template_loop.yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.confirm).toEqual({ plan: "auto", review: "auto", "design-review": "smart" });
    // The legacy alias must not reappear as an ACTIVE key in the template.
    expect(/^designReview:\n(\s*#[^\n]*\n)*\s*mode:/m.test(raw)).toBe(false);
  });
});
