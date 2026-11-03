/**
 * 222 Phase 0: unit tests for the single docs-path resolver
 * (`src/docs-paths.ts`). Pure functions only — no disk access.
 *
 * Covered contract:
 * - `normalizeDocsDir` validation (relative-only, no traversal, separator and
 *   trailing-slash normalization);
 * - `deriveDocsDirs` precedence (explicit key → `docs.stageDirs` derivation →
 *   built-in default) plus its warnings;
 * - `docsDirsOf` runtime precedence;
 * - `buildStageTypeToolDefaults` append-only write scope (R3Q9-A).
 */
import { describe, expect, it } from "bun:test";
import {
  buildPlanDocGlob,
  DEFAULT_DOCS_DIRS,
  deriveDocsDirs,
  docsDirsOf,
  normalizeDocsDir,
  buildStageTypeToolDefaults,
} from "../../docs-paths";
import {
  DEFAULT_DESIGN_DIR,
  DEFAULT_JOBS_DIR,
  DEFAULT_REVIEW_DIR,
  STAGE_TYPE_TOOL_DEFAULTS,
} from "../../constants";
import type { PipelineConfig } from "../../types";

describe("normalizeDocsDir", () => {
  it("accepts a plain relative directory", () => {
    expect(normalizeDocsDir("spec/design")).toEqual({ value: "spec/design" });
  });

  it("strips trailing slashes", () => {
    expect(normalizeDocsDir("spec/design///")).toEqual({ value: "spec/design" });
  });

  it("normalizes backslashes to posix separators", () => {
    expect(normalizeDocsDir("spec\\design")).toEqual({ value: "spec/design" });
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeDocsDir("  spec/design  ")).toEqual({ value: "spec/design" });
  });

  it("rejects empty / whitespace-only / non-string values", () => {
    for (const raw of ["", "   ", 42, null, undefined, [], {}]) {
      const parsed = normalizeDocsDir(raw);
      expect(parsed.value).toBeUndefined();
      expect(typeof parsed.warning).toBe("string");
    }
  });

  it("rejects absolute posix and Windows drive paths", () => {
    for (const raw of ["/tmp/x", "C:\\temp\\x", "d:/docs"]) {
      const parsed = normalizeDocsDir(raw);
      expect(parsed.value).toBeUndefined();
      expect(parsed.warning).toContain("absolute path");
    }
  });

  it("rejects any path containing a .. segment", () => {
    for (const raw of ["../escape", "docs/../../x", "docs/.."]) {
      const parsed = normalizeDocsDir(raw);
      expect(parsed.value).toBeUndefined();
      expect(parsed.warning).toContain("path traversal");
    }
  });

  // ─── 222 review issue 3: the output must be CANONICAL ─────────────────────

  it("collapses redundant separators and ./ segments", () => {
    // The consumers match the value literally (write whitelist prefixes,
    // read-only globs, verify detector, archive joins), so a non-canonical
    // string silently disabled every one of them.
    expect(normalizeDocsDir("spec//design")).toEqual({ value: "spec/design" });
    expect(normalizeDocsDir("./design")).toEqual({ value: "design" });
    expect(normalizeDocsDir("spec/./design")).toEqual({ value: "spec/design" });
    expect(normalizeDocsDir(".//spec//design//")).toEqual({ value: "spec/design" });
  });

  it("rejects a value that resolves to the project root", () => {
    // "." would make the archive scope (and its prune boundary) the whole
    // project, so `delete` could remove source files.
    for (const raw of [".", "./", ".//", ".//."]) {
      const parsed = normalizeDocsDir(raw);
      expect(parsed.value).toBeUndefined();
      expect(parsed.warning).toContain("project root");
    }
  });

  it("keeps a dot-prefixed directory name intact", () => {
    // ".design" is a legal directory; only the bare root segment is rejected.
    expect(normalizeDocsDir(".design")).toEqual({ value: ".design" });
    expect(normalizeDocsDir("spec/.design")).toEqual({ value: "spec/.design" });
  });
});

describe("deriveDocsDirs", () => {
  it("falls back to the three defaults when nothing is configured", () => {
    const { dirs, configured, warnings } = deriveDocsDirs(undefined, undefined);
    expect(dirs).toEqual({
      designDir: DEFAULT_DESIGN_DIR,
      reviewDir: DEFAULT_REVIEW_DIR,
      jobsDir: DEFAULT_JOBS_DIR,
    });
    expect(configured).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("derives design/review from docs.stageDirs (plan/develop, review/fix)", () => {
    const { dirs, configured, warnings } = deriveDocsDirs(undefined, {
      plan: "spec/design",
      develop: "spec/design",
      review: "spec/review",
      fix: "spec/review",
    });
    expect(dirs.designDir).toBe("spec/design");
    expect(dirs.reviewDir).toBe("spec/review");
    expect(dirs.jobsDir).toBe(DEFAULT_JOBS_DIR);
    expect(configured).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("uses the first valid stage key as the priority winner", () => {
    const { dirs } = deriveDocsDirs(undefined, { plan: "a/design", develop: "b/design" });
    expect(dirs.designDir).toBe("a/design");
  });

  it("warns when stage directories disagree and keeps the first", () => {
    const { dirs, warnings } = deriveDocsDirs(undefined, {
      plan: "a/design",
      develop: "b/design",
    });
    expect(dirs.designDir).toBe("a/design");
    expect(warnings.some((w) => w.includes("disagree"))).toBe(true);
  });

  it("lets an explicit key win over the derived value and warns once", () => {
    const { dirs, configured, warnings } = deriveDocsDirs(
      { designDir: "spec/design" },
      { plan: "legacy/design" },
    );
    expect(dirs.designDir).toBe("spec/design");
    expect(configured).toBe(true);
    expect(warnings.some((w) => w.includes("overrides"))).toBe(true);
  });

  it("reports configured=false when only stageDirs is set", () => {
    expect(deriveDocsDirs({ stageDirs: { plan: "x" } }, { plan: "x" }).configured).toBe(false);
  });

  it("reports configured=true when only jobsDir is set", () => {
    const { dirs, configured } = deriveDocsDirs({ jobsDir: "spec/jobs" });
    expect(dirs).toEqual({
      designDir: DEFAULT_DESIGN_DIR,
      reviewDir: DEFAULT_REVIEW_DIR,
      jobsDir: "spec/jobs",
    });
    expect(configured).toBe(true);
  });

  it("validates DERIVED stage values exactly like explicit keys (R1Q4-A)", () => {
    for (const bad of ["../escape", "/tmp/x", "C:\\temp"]) {
      const { dirs, warnings } = deriveDocsDirs(undefined, { plan: bad });
      expect(dirs.designDir).toBe(DEFAULT_DESIGN_DIR);
      expect(warnings.some((w) => w.includes("docs.stageDirs.plan"))).toBe(true);
    }
  });

  it("warns and falls back for an invalid explicit key", () => {
    const { dirs, warnings } = deriveDocsDirs({ designDir: "/abs/design" });
    expect(dirs.designDir).toBe(DEFAULT_DESIGN_DIR);
    expect(warnings.some((w) => w.includes("docs.designDir"))).toBe(true);
  });

  // ─── 222 review issue 1: the real upgrade path ─────────────────────────────

  /** The six `docs.stageDirs` values the pre-222 template shipped. */
  const LEGACY_TEMPLATE_STAGE_DIRS = {
    clarify: "docs/design",
    plan: "docs/design",
    "design-review": "docs/design",
    develop: "docs/design",
    review: "docs/design",
    fix: "docs/review",
  } as const;

  it("treats the legacy template six-key stageDirs as boilerplate (upgrade path)", () => {
    // An installed project whose pipeline_loop.json still pins the old values
    // must resolve EXACTLY like an unconfigured one — no migration required.
    const { dirs, configured, warnings } = deriveDocsDirs(undefined, LEGACY_TEMPLATE_STAGE_DIRS);
    expect(dirs).toEqual({
      designDir: DEFAULT_DESIGN_DIR,
      reviewDir: DEFAULT_REVIEW_DIR,
      jobsDir: DEFAULT_JOBS_DIR,
    });
    expect(configured).toBe(false);
    // No misleading "disagree" warning on every startup.
    expect(warnings).toEqual([]);
  });

  it("keeps a NON-DEFAULT value from the legacy set as a real derivation", () => {
    const { dirs } = deriveDocsDirs(undefined, {
      ...LEGACY_TEMPLATE_STAGE_DIRS,
      review: "spec/review",
    });
    expect(dirs.reviewDir).toBe("spec/review");
  });

  it("treats separator/trailing-slash variants of the default as boilerplate too", () => {
    const { dirs, warnings } = deriveDocsDirs(undefined, {
      review: "docs/design/",
      fix: "docs\\review",
    });
    expect(dirs.reviewDir).toBe(DEFAULT_REVIEW_DIR);
    expect(warnings).toEqual([]);
  });

  it("an explicit reviewDir still wins over a non-default review stageDirs entry", () => {
    const { dirs, warnings } = deriveDocsDirs(
      { reviewDir: "spec/review" },
      { review: "legacy/review" },
    );
    expect(dirs.reviewDir).toBe("spec/review");
    expect(warnings.some((w) => w.includes("overrides"))).toBe(true);
  });
});

// ─── 222 review issue 6: the shared diagnostics contract ───────────────────

describe("deriveDocsDirs diagnostics contract (222 review issue 6)", () => {
  it("warns with the REAL fall-through value on the in-memory path", () => {
    // This is the only warning outlet for a hand-built `PipelineJsonConfig`;
    // the on-disk path warns in `parseDocsConfig` instead and never reaches
    // this branch. Losing either one reintroduces the silent-misconfiguration
    // bug of review issue 3.
    const { warnings } = deriveDocsDirs({ designDir: "/abs/design" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("docs.designDir");
    expect(warnings[0]).toContain(`using "${DEFAULT_DESIGN_DIR}"`);
  });
});

describe("docsDirsOf", () => {
  const base = { projectRoot: "/tmp/p", stages: {} } as unknown as PipelineConfig;

  it("prefers the resolved docsDirs block", () => {
    const dirs = docsDirsOf({
      ...base,
      docsDirs: { designDir: "spec/design", reviewDir: "spec/review", jobsDir: "spec/jobs" },
    } as PipelineConfig);
    expect(dirs).toEqual({
      designDir: "spec/design",
      reviewDir: "spec/review",
      jobsDir: "spec/jobs",
    });
  });

  it("derives from docsStageDirs when no explicit block exists", () => {
    const dirs = docsDirsOf({
      ...base,
      docsStageDirs: { plan: "spec/design", review: "spec/review" },
    } as PipelineConfig);
    expect(dirs.designDir).toBe("spec/design");
    expect(dirs.reviewDir).toBe("spec/review");
    expect(dirs.jobsDir).toBe(DEFAULT_JOBS_DIR);
  });

  it("returns the built-in defaults when nothing is configured", () => {
    expect(docsDirsOf(base)).toEqual(DEFAULT_DOCS_DIRS);
  });

  it("emits no warnings for an invalid stageDirs value (runtime path is silent)", () => {
    const dirs = docsDirsOf({
      ...base,
      docsStageDirs: { plan: "../escape" },
    } as PipelineConfig);
    expect(dirs.designDir).toBe(DEFAULT_DESIGN_DIR);
  });

  // 222 review issue 1: the runtime path must apply the SAME boilerplate rule.
  it("ignores boilerplate stageDirs values on the runtime path too", () => {
    const dirs = docsDirsOf({
      ...base,
      docsStageDirs: { review: "docs/design", fix: "docs/review" },
    } as PipelineConfig);
    expect(dirs.reviewDir).toBe(DEFAULT_REVIEW_DIR);
  });

  it("still honours a non-default stageDirs value on the runtime path", () => {
    const dirs = docsDirsOf({
      ...base,
      docsStageDirs: { review: "spec/review" },
    } as PipelineConfig);
    expect(dirs.reviewDir).toBe("spec/review");
  });
});

describe("buildStageTypeToolDefaults (R3Q9-A append-only write scope)", () => {
  it("keeps every legacy read-only-stage entry and appends the resolved dirs", () => {
    const dirs = { designDir: "spec/design", reviewDir: "spec/review", jobsDir: "spec/jobs" };
    const built = buildStageTypeToolDefaults(dirs);
    for (const stage of ["clarify", "plan", "design-review", "review"] as const) {
      const legacy = STAGE_TYPE_TOOL_DEFAULTS[stage]!.allowedWritePaths;
      const next = built[stage]!.allowedWritePaths;
      for (const entry of legacy) expect(next).toContain(entry);
      // New entries relative to the legacy set are exactly the two dirs.
      const added = next.filter((p) => !legacy.includes(p));
      expect(added).toEqual(["spec/design/", "spec/review/"]);
    }
  });

  it("protects the plan document of the resolved design directory", () => {
    const dirs = { designDir: "spec/design", reviewDir: "spec/review", jobsDir: "spec/jobs" };
    const built = buildStageTypeToolDefaults(dirs);
    expect(built.develop!.allowedReadOnlyPaths).toEqual([buildPlanDocGlob("spec/design")]);
    expect(built.fix!.allowedReadOnlyPaths).toEqual([buildPlanDocGlob("spec/design")]);
    expect(built.develop!.allowedWritePaths).toEqual(["**"]);
    expect(built.fix!.allowedWritePaths).toEqual(["**"]);
  });

  it("deduplicates when a configured directory equals a legacy entry", () => {
    const built = buildStageTypeToolDefaults({ designDir: "docs", reviewDir: "docs", jobsDir: "j" });
    expect(built.clarify!.allowedWritePaths).toEqual(["docs/", "doc/", "documentation/"]);
  });

  it("default directories reproduce the legacy entries plus the two default dirs", () => {
    const built = buildStageTypeToolDefaults(DEFAULT_DOCS_DIRS);
    expect(built.plan!.allowedWritePaths).toEqual([
      "docs/",
      "doc/",
      "documentation/",
      "docs/design/",
      "docs/review/",
    ]);
  });
});