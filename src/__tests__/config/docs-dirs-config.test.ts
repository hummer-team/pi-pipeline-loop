/**
 * 222 Phase 0: `docs` config-block parsing plus the `PipelineConfig.docsDirs`
 * shape contract. Kept separate from the large `json-config.test.ts`.
 *
 * Contract:
 * - `parseDocsConfig` accepts ANY of the four keys (`designDir` / `reviewDir` /
 *   `jobsDir` / `stageDirs`); `stageDirs` alone is no longer required;
 * - invalid directory values are dropped at parse time WITH their own warning
 *   (222 review issue 3: this is the only on-disk entry point, so deferring the
 *   diagnostic to `deriveDocsDirs` — which never sees a dropped value — left
 *   every real misconfiguration silent);
 * - `resolvePipelineConfig` attaches `docsDirs` ONLY when an explicit key exists
 *   (baseline shape preserved for unconfigured projects).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadJsonConfig, parseDocsConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import type { PipelineConfig, PipelineJsonConfig } from "../../types";

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

  // ─── 222 review issue 3: the on-disk path must WARN, not drop silently ────

  it("warns for every invalid directory value it drops", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      expect(parseDocsConfig({ designDir: "/abs", reviewDir: "../escape", jobsDir: "" }))
        .toBeUndefined();
    } finally {
      console.warn = original;
    }
    // Exactly one warning per rejected key, each naming the offending key.
    expect(warnings.length).toBe(3);
    for (const key of ["designDir", "reviewDir", "jobsDir"]) {
      expect(warnings.filter((w) => w.includes(`docs.${key}`)).length).toBe(1);
    }
  });

  it("does not warn for valid directory values", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      expect(parseDocsConfig({ designDir: "spec/design", reviewDir: "spec\\review//" }))
        .toEqual({ designDir: "spec/design", reviewDir: "spec/review" });
    } finally {
      console.warn = original;
    }
    expect(warnings).toEqual([]);
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

// ─── 222 review issue 3: the warning survives the real on-disk path ─────────

describe("invalid docs keys warn on the loadJsonConfig path (222 review issue 3)", () => {
  let dir = "";
  let configPath = "";

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-docs-warn-"));
    configPath = path.join(dir, ".pi/pipeline_loop.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** Loads the on-disk config, capturing both `console.warn` phases. */
  function loadCapturingWarnings(): { config: PipelineConfig; warnings: string[] } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      return { config: resolvePipelineConfig(loadJsonConfig(configPath)), warnings };
    } finally {
      console.warn = original;
    }
  }

  it("warns once per invalid docs.<x>Dir key read from disk", async () => {
    await fsp.writeFile(configPath, JSON.stringify({
      stages: { clarify: {} },
      docs: { designDir: "/abs/dir", reviewDir: "../escape" },
    }), "utf8");
    const { config, warnings } = loadCapturingWarnings();
    // The values are dropped (fail-open) but the user is TOLD.
    expect("docsDirs" in config).toBe(false);
    expect(warnings.filter((w) => w.includes("docs.designDir")).length).toBe(1);
    expect(warnings.filter((w) => w.includes("docs.reviewDir")).length).toBe(1);
  });

  it("keeps valid keys and still resolves them", async () => {
    await fsp.writeFile(configPath, JSON.stringify({
      stages: { clarify: {} },
      docs: { designDir: "spec/design", reviewDir: "/abs/dir" },
    }), "utf8");
    const { config, warnings } = loadCapturingWarnings();
    expect(config.docsDirs?.designDir).toBe("spec/design");
    expect(warnings.some((w) => w.includes("docs.reviewDir"))).toBe(true);
  });

  it("warns exactly once for an in-memory config that bypasses the parser", () => {
    // The other entry point: a hand-built PipelineJsonConfig never passes
    // through `parseDocsConfig`, so `deriveDocsDirs` supplies the single warning.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      resolvePipelineConfig({
        stages: { clarify: {} },
        docs: { designDir: "/abs/dir" },
      });
    } finally {
      console.warn = original;
    }
    expect(warnings.filter((w) => w.includes("docs.designDir")).length).toBe(1);
  });
});