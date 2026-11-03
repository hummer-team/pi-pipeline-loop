/**
 * 222 Phase 0: `docs` config-block parsing plus the `PipelineConfig.docsDirs`
 * shape contract. Kept separate from the large `json-config.test.ts`.
 *
 * Contract:
 * - `parseDocsConfig` accepts ANY of the four keys (`designDir` / `reviewDir` /
 *   `jobsDir` / `stageDirs`); `stageDirs` alone is no longer required;
 * - invalid directory values are dropped at parse time (the single warning is
 *   emitted later by `deriveDocsDirs`);
 * - `resolvePipelineConfig` attaches `docsDirs` ONLY when an explicit key exists
 *   (baseline shape preserved for unconfigured projects).
 */
import { describe, expect, it } from "bun:test";
import { parseDocsConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import type { PipelineJsonConfig } from "../../types";

describe("parseDocsConfig (222 Phase 0 directory keys)", () => {
  it("returns a block when only jobsDir is configured", () => {
    expect(parseDocsConfig({ jobsDir: "spec/jobs" })).toEqual({ jobsDir: "spec/jobs" });
  });

  it("returns a block when only designDir is configured", () => {
    expect(parseDocsConfig({ designDir: "spec/design" })).toEqual({ designDir: "spec/design" });
  });

  it("normalizes trailing slashes and backslashes", () => {
    expect(parseDocsConfig({ designDir: "spec\\design//" })).toEqual({ designDir: "spec/design" });
  });

  it("drops invalid directory values at parse time", () => {
    expect(parseDocsConfig({ designDir: "/abs", reviewDir: "../escape", jobsDir: "" }))
      .toBeUndefined();
  });

  it("keeps valid keys and drops invalid ones", () => {
    expect(parseDocsConfig({ designDir: "spec/design", reviewDir: 42 })).toEqual({
      designDir: "spec/design",
    });
  });

  it("still parses stageDirs alongside the new keys", () => {
    expect(
      parseDocsConfig({ stageDirs: { plan: "spec/design" }, jobsDir: "spec/jobs" }),
    ).toEqual({ stageDirs: { plan: "spec/design" }, jobsDir: "spec/jobs" });
  });

  it("returns undefined for an empty block", () => {
    expect(parseDocsConfig({})).toBeUndefined();
    expect(parseDocsConfig(undefined)).toBeUndefined();
    expect(parseDocsConfig("nope")).toBeUndefined();
  });
});

describe("resolvePipelineConfig docsDirs shape (222 Phase 0)", () => {
  it("does not attach docsDirs when nothing is configured", () => {
    const config = resolvePipelineConfig({ stages: { plan: {}, develop: {} } });
    expect(config.docsDirs).toBeUndefined();
    expect("docsDirs" in config).toBe(false);
  });

  it("does not attach docsDirs when only stageDirs is configured", () => {
    const config = resolvePipelineConfig({
      stages: { plan: {} },
      docs: { stageDirs: { plan: "spec/design" } },
    });
    expect(config.docsStageDirs).toEqual({ plan: "spec/design" });
    expect(config.docsDirs).toBeUndefined();
  });

  it("attaches docsDirs when only jobsDir is configured", () => {
    const config = resolvePipelineConfig({
      stages: { plan: {} },
      docs: { jobsDir: "spec/jobs" },
    });
    expect(config.docsDirs).toEqual({
      designDir: "docs/design",
      reviewDir: "docs/review",
      jobsDir: "spec/jobs",
    });
  });

  it("resolves stageDirs derivation for the keys without an explicit value", () => {
    const config = resolvePipelineConfig({
      stages: { plan: {} },
      docs: { stageDirs: { plan: "spec/design", fix: "spec/review" }, jobsDir: "spec/jobs" },
    });
    expect(config.docsDirs).toEqual({
      designDir: "spec/design",
      reviewDir: "spec/review",
      jobsDir: "spec/jobs",
    });
  });
});