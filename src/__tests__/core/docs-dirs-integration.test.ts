/**
 * 222 Phase 6: end-to-end integration of the configurable docs layout.
 *
 * Invariants pinned here:
 *
 * 1. ZERO IMPACT ON DEFAULTS — an unconfigured project resolves exactly like the
 *    pre-222 baseline: no `docsDirs` field, default commit-doc path, default glob
 *    detection, default archive scope, `docsStageDirs` still `undefined` for the
 *    shipped template. The ONE intended baseline difference (R3Q9-A: the
 *    read-only stages gain `docs/design/` + `docs/review/` in their write
 *    whitelist) is asserted explicitly as a known, frozen exception.
 * 2. FULL-CHAIN CUSTOMISATION — a configured layout follows through every
 *    consumer at once: write whitelist, read-only protection, verify narrowing,
 *    review scanning, job-file resolution, archive scope and the document menu
 *    (`resolveStageDocDir`), so no consumer silently keeps the old directory.
 * 3. UPGRADE PATH — an installed project whose `.pi/pipeline_loop.json` still
 *    carries the pre-222 template's six `docs.stageDirs` values (and no new key)
 *    resolves EXACTLY like an unconfigured one, loaded through the real
 *    `loadJsonConfig` (222 review issue 1).
 *
 * Boundary coverage: directory equal to the default, a directory containing
 * spaces, a Windows-separator input, and the `stageDirs` vs explicit-key
 * conflict.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import { resolveStageDocDir } from "../../core/doc-discovery";
import { resolveTrackedJobFile } from "../../core/auto-pipeline/job-state";
import { scanJobFiles } from "../../commands/pipeline-auto-menu";
import { collectArchiveTargets, archiveScopeRoots } from "../../core/archive/scanner";
import { deleteArchiveTargets } from "../../core/archive/runner";
import {
  applyConcreteStageDocPaths,
  isCommitDocGlob,
  isPlanDocGlob,
  isReviewDocGlob,
  resolveCommitDocPath,
} from "../../core/verify-path-resolver";
import { checkDispatchConflicts } from "../../utils/guard-conflict-report";
import { findLatestReviewReport } from "../../utils/review-conclusion";
import { isPathAllowedWrite, isPathReadOnly } from "../../utils/protect";
import { docsDirsOf } from "../../docs-paths";
import {
  DEFAULT_DESIGN_DIR,
  DEFAULT_JOBS_DIR,
  DEFAULT_READONLY_WRITE_PATHS,
  DEFAULT_REVIEW_DIR,
} from "../../constants";
import type { PipelineConfig, PipelineJsonConfig, PipelineStage } from "../../types";
import type { VerifyRules } from "../../core/verify-frontmatter";
import { makeTestMeta } from "../helpers";

/** Stages whose write scope is restricted to the docs directories. */
const READ_ONLY_STAGES: PipelineStage[] = ["clarify", "plan", "design-review", "review"];

/** Every stage of the 7-stage pipeline (plus terminals), in order. */
const ALL_STAGES: PipelineStage[] = [
  "clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed",
];

/** Stage map accepted by `resolvePipelineConfig` (empty config per stage). */
function stageMap(stages: PipelineStage[] = ALL_STAGES): PipelineJsonConfig["stages"] {
  return Object.fromEntries(stages.map((stage) => [stage, {}])) as PipelineJsonConfig["stages"];
}

/**
 * Runs `resolvePipelineConfig` while capturing `console.warn`.
 * The loader is the ONLY place docs-resolution diagnostics are emitted.
 */
function resolveCapturingWarnings(json: PipelineJsonConfig): {
  config: PipelineConfig;
  warnings: string[];
} {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { config: resolvePipelineConfig(json), warnings };
  } finally {
    console.warn = original;
  }
}

/** Verifies rules carrying one path in every field that `replaceGlobInRules` touches. */
function rulesWith(relPath: string): VerifyRules {
  return {
    keywords: [],
    mode: "and",
    path: relPath,
    requiredFiles: [relPath],
    fileContentPattern: [{ path: relPath, pattern: "^x$" }],
  };
}

const CUSTOM_DOCS = {
  designDir: "spec/design",
  reviewDir: "spec/review",
  jobsDir: "spec/jobs",
};

// ─── Invariant 1: an unconfigured project keeps the baseline ────────────────

describe("222 Phase 6 — zero impact when nothing is configured", () => {
  /** Baseline top-level keys of a resolved config (pre-222 shape). */
  const BASELINE_KEYS = [
    "archiveDest", "archiveDirs", "audit", "auditDir", "compact", "confirmOverflow",
    "docsStageDirs", "domainDir", "init", "llmExtract", "maxConfirmRejections",
    "maxLoopCycles", "maxLoops", "maxVerifyAttempts", "output", "piWorkDir",
    "projectRoot", "protect", "spawnWaitTimeoutMs", "stages", "startStageMode",
  ];

  it("keeps the pre-222 config shape (no docsDirs field)", () => {
    const config = resolvePipelineConfig({ stages: stageMap() });
    expect(Object.keys(config).sort()).toEqual(BASELINE_KEYS);
    expect("docsDirs" in config).toBe(false);
    expect(config.docsDirs).toBeUndefined();
    expect(config.docsStageDirs).toBeUndefined();
  });

  it("emits no docs warning for an unconfigured project", () => {
    expect(resolveCapturingWarnings({ stages: stageMap() }).warnings).toEqual([]);
  });

  it("resolves the default docs directories", () => {
    const config = resolvePipelineConfig({ stages: stageMap() });
    expect(docsDirsOf(config)).toEqual({
      designDir: DEFAULT_DESIGN_DIR,
      reviewDir: DEFAULT_REVIEW_DIR,
      jobsDir: DEFAULT_JOBS_DIR,
    });
  });

  it("keeps the default deliverable path, glob detection and archive scope", () => {
    const config = resolvePipelineConfig({ stages: stageMap() });
    expect(resolveCommitDocPath("222_Feat")).toBe("docs/design/222_Feat_Develop_Commit.md");
    expect(isPlanDocGlob("docs/design/*_Plan.md")).toBe(true);
    expect(isCommitDocGlob("docs/design/*_Develop_Commit.md")).toBe(true);
    expect(isReviewDocGlob("docs/review/Code_Review_*.md")).toBe(true);
    // 222 review issue 2: an unconfigured project scans exactly the resolved
    // design/review directories — never the broad ["docs"] fallback, which
    // would put `docs/jobs/*_loop.yaml` in the archive/delete list.
    expect(config.archiveDirs).toEqual([DEFAULT_DESIGN_DIR, DEFAULT_REVIEW_DIR]);
  });

  it("keeps the default stage write scopes, with the R3Q9-A exception frozen", () => {
    const config = resolvePipelineConfig({ stages: stageMap() });
    for (const stage of READ_ONLY_STAGES) {
      expect(config.stages[stage].allowedWritePaths).toEqual([
        ...DEFAULT_READONLY_WRITE_PATHS,
        // Known baseline difference (R3Q9-A, 222 Phase 0): append-only widening.
        `${DEFAULT_DESIGN_DIR}/`,
        `${DEFAULT_REVIEW_DIR}/`,
      ]);
    }
    expect(config.stages.develop.allowedWritePaths).toEqual(["**"]);
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["docs/design/*_Plan.md"]);
    expect(config.stages.fix.allowedReadOnlyPaths).toEqual(["docs/design/*_Plan.md"]);
  });

  it("keeps the shipped template free of the removed static values", () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../template/pipeline_loop.json"), "utf-8"),
    ) as { docs?: Record<string, unknown>; archive?: { dirs?: unknown } };
    // Baseline difference (222 Phase 0): the block is empty → `docsStageDirs`
    // is `undefined` for a freshly initialised project.
    expect(template.docs).toEqual({});
    expect(template.archive?.dirs).toBeUndefined();
  });
});

// ─── Invariant 2a: stageDirs-only configuration stays self-consistent ───────

describe("222 Phase 6 — docs.stageDirs alone stays consistent", () => {
  const STAGE_DIRS = {
    plan: "spec/design",
    develop: "spec/design",
    review: "spec/review",
    fix: "spec/review",
  };

  it("keeps menu, deliverables and archive scope on the same directories", () => {
    const { config, warnings } = resolveCapturingWarnings({
      stages: stageMap(),
      docs: { stageDirs: STAGE_DIRS },
    });
    // No explicit key → the resolved block is NOT attached (baseline shape).
    expect(warnings).toEqual([]);
    expect("docsDirs" in config).toBe(false);

    // Menu (same source as the deliverables, so the two cannot diverge).
    expect(resolveStageDocDir(config, "plan").dir).toBe("spec/design");
    expect(resolveStageDocDir(config, "clarify").dir).toBe("spec/design");
    expect(resolveStageDocDir(config, "design-review").dir).toBe("spec/design");
    // A NON-DEFAULT `stageDirs.review` keeps its per-stage granularity here —
    // it is a real customisation, not the stale boilerplate value.
    expect(resolveStageDocDir(config, "review")).toEqual({ dir: "spec/review", autoMatched: false });
    expect(resolveStageDocDir(config, "fix").dir).toBe("spec/review");
    // Terminal stages have no document kind.
    expect(resolveStageDocDir(config, "completed").dir).toBe("docs");

    // Deliverables.
    const dirs = docsDirsOf(config);
    expect(dirs).toEqual({
      designDir: "spec/design",
      reviewDir: "spec/review",
      jobsDir: DEFAULT_JOBS_DIR,
    });
    expect(resolveCommitDocPath("222_Feat", dirs.designDir))
      .toBe("spec/design/222_Feat_Develop_Commit.md");
    expect(config.stages.clarify.allowedWritePaths).toContain("spec/design/");
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["spec/design/*_Plan.md"]);

    // Archive scope = the deduped stage directories.
    expect(config.archiveDirs).toEqual(["spec/design", "spec/review"]);
  });

  it("treats a stageDirs value equal to the built-in default as boilerplate", () => {
    const config = resolvePipelineConfig({
      stages: stageMap(),
      docs: { stageDirs: { plan: DEFAULT_DESIGN_DIR, review: DEFAULT_REVIEW_DIR } },
    });
    // A stale template pinning the defaults must not mask a resolved directory.
    expect(resolveStageDocDir(config, "plan").dir).toBe(DEFAULT_DESIGN_DIR);
    expect(config.archiveDirs).toEqual([DEFAULT_DESIGN_DIR, DEFAULT_REVIEW_DIR]);
  });
});

// ─── Invariant 2b: full-chain customisation ─────────────────────────────────

describe("222 Phase 6 — a configured layout follows every consumer", () => {
  let tmpRoot = "";

  /** Creates a throwaway project root with the given relative files. */
  async function makeProject(files: string[]): Promise<string> {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-docs-integration-"));
    for (const rel of files) {
      const abs = path.join(tmpRoot, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, "# doc\n", "utf8");
    }
    return tmpRoot;
  }

  afterAll(async () => {
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("follows the configured layout in one pass: scope, verify, menu, review, jobs, archive", async () => {
    const root = await makeProject([
      "spec/design/222_Feat.md",
      "spec/design/222_Feat_Plan.md",
      "spec/review/Code_Review_222_Feat_Develop_Commit_1.md",
      "spec/jobs/nightly_loop.yaml",
    ]);

    const config = resolvePipelineConfig({
      projectRoot: root,
      stages: stageMap(),
      docs: CUSTOM_DOCS,
    });

    // 1. Resolved directories (single source).
    const dirs = docsDirsOf(config);
    expect(dirs).toEqual(CUSTOM_DOCS);

    // 2. Stage write scope: append-only widening + configured read-only glob.
    for (const stage of READ_ONLY_STAGES) {
      expect(config.stages[stage].allowedWritePaths).toContain("spec/design/");
      expect(config.stages[stage].allowedWritePaths).toContain("spec/review/");
      expect(config.stages[stage].allowedWritePaths).toContain("docs/");
    }
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["spec/design/*_Plan.md"]);
    expect(config.stages.fix.allowedReadOnlyPaths).toEqual(["spec/design/*_Plan.md"]);

    // 3. Deliverable path + verify narrowing (dev/fix, review, plan).
    expect(resolveCommitDocPath("222_Feat", dirs.designDir))
      .toBe("spec/design/222_Feat_Develop_Commit.md");

    const developNarrowed = await applyConcreteStageDocPaths(
      rulesWith("spec/design/*_Develop_Commit.md"),
      config,
      makeTestMeta({ currentStage: "develop", requirementDoc: "spec/design/222_Feat.md" }),
    );
    expect(developNarrowed.path).toBe("spec/design/222_Feat_Develop_Commit.md");

    const reviewNarrowed = await applyConcreteStageDocPaths(
      rulesWith("spec/review/Code_Review_*.md"),
      config,
      makeTestMeta({ currentStage: "review", requirementDoc: "spec/design/222_Feat.md" }),
    );
    expect(reviewNarrowed.path)
      .toBe("spec/review/Code_Review_222_Feat_Develop_Commit_*.md");

    const planNarrowed = await applyConcreteStageDocPaths(
      rulesWith("spec/design/*_Plan.md"),
      config,
      makeTestMeta({ currentStage: "plan", requirementDoc: "spec/design/222_Feat.md" }),
    );
    expect(planNarrowed.path).toBe("spec/design/222_Feat_Plan.md");

    // 4. Document menu uses the SAME directory as the deliverables.
    expect(resolveStageDocDir(config, "plan")).toEqual({ dir: "spec/design", autoMatched: true });
    expect(resolveStageDocDir(config, "develop").dir).toBe("spec/design");
    expect(resolveStageDocDir(config, "review").dir).toBe("spec/design");
    expect(resolveStageDocDir(config, "fix").dir).toBe("spec/review");

    // 5. Review scanning.
    expect(await findLatestReviewReport(root, dirs.reviewDir)).toBe(
      path.join(root, "spec/review/Code_Review_222_Feat_Develop_Commit_1.md"),
    );
    expect(await findLatestReviewReport(root)).toBeNull(); // default dir is empty

    // 6. Job files: menu scan + tracked-path resolution.
    const scan = scanJobFiles(root, dirs.jobsDir);
    expect(scan.rows.map((row) => row.jobId)).toEqual(["nightly_loop"]);
    expect(scanJobFiles(root).rows).toEqual([]); // default dir is empty
    expect(resolveTrackedJobFile(root, dirs.jobsDir, "nightly_loop"))
      .toBe(path.join(root, "spec/jobs/nightly_loop.yaml"));

    // 7. Archive scope follows the resolved directories (design first, then review).
    expect(config.archiveDirs).toEqual(["spec/design", "spec/review"]);
  });

  it("keeps the dispatch conflict check happy with the configured deliverable path", async () => {
    const config = resolvePipelineConfig({
      projectRoot: "/tmp/pi-docs-integration-conflict",
      stages: stageMap(),
      docs: CUSTOM_DOCS,
    });
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: "spec/design/222_Feat.md",
    });
    const conflict = await checkDispatchConflicts(
      "develop",
      meta,
      config.stages.develop.allowedReadOnlyPaths,
      config.stages.develop.allowedWritePaths,
      () => ({ mode: "all" }),
      () => "scope",
      docsDirsOf(config).designDir,
    );
    expect(conflict).toBeNull();
  });
});

// ─── Boundary behaviour ─────────────────────────────────────────────────────

describe("222 Phase 6 — boundary configurations", () => {
  it("accepts a configured directory that equals the default (no behaviour change)", () => {
    const config = resolvePipelineConfig({
      stages: stageMap(),
      docs: { designDir: DEFAULT_DESIGN_DIR, reviewDir: DEFAULT_REVIEW_DIR },
    });
    // The block IS attached (an explicit key exists) but resolves to the defaults.
    expect(config.docsDirs).toEqual({
      designDir: DEFAULT_DESIGN_DIR,
      reviewDir: DEFAULT_REVIEW_DIR,
      jobsDir: DEFAULT_JOBS_DIR,
    });
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["docs/design/*_Plan.md"]);
    // Review issue 2: the resolved layout always wins in tier 3, defaults included.
    expect(config.archiveDirs).toEqual([DEFAULT_DESIGN_DIR, DEFAULT_REVIEW_DIR]);
  });

  it("supports a directory containing spaces", () => {
    const config = resolvePipelineConfig({
      stages: stageMap(),
      docs: { designDir: "my docs/design", reviewDir: "my docs/review" },
    });
    expect(docsDirsOf(config).designDir).toBe("my docs/design");
    expect(config.stages.clarify.allowedWritePaths).toContain("my docs/design/");
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["my docs/design/*_Plan.md"]);
  });

  it("normalizes a Windows-separator input to posix", () => {
    const { config, warnings } = resolveCapturingWarnings({
      stages: stageMap(),
      docs: { designDir: "spec\\design", reviewDir: "spec\\review" },
    });
    expect(warnings).toEqual([]);
    expect(docsDirsOf(config).designDir).toBe("spec/design");
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["spec/design/*_Plan.md"]);
  });

  it("resolves a stageDirs vs explicit-key conflict in favour of the explicit key", () => {
    const { config, warnings } = resolveCapturingWarnings({
      stages: stageMap(),
      docs: { designDir: "spec/design", stageDirs: { plan: "legacy/design" } },
    });
    expect(docsDirsOf(config).designDir).toBe("spec/design");
    // A NON-DEFAULT stageDirs entry still customises ONLY the doc menu.
    expect(resolveStageDocDir(config, "plan")).toEqual({ dir: "legacy/design", autoMatched: false });
    expect(warnings.some((w) => w.includes("overrides"))).toBe(true);
  });

  // ─── 222 review issue 3: non-canonical inputs must still be enforced ──────

  it("keeps the write whitelist and read-only protection effective for `spec//design`", () => {
    // The consumers match LITERALLY, so an un-normalized value silently disabled
    // both the deliverable write whitelist and the plan-doc protection.
    const { config, warnings } = resolveCapturingWarnings({
      stages: stageMap(),
      docs: { designDir: "spec//design", reviewDir: "spec//review" },
    });
    expect(warnings).toEqual([]);
    expect(docsDirsOf(config).designDir).toBe("spec/design");
    for (const stage of READ_ONLY_STAGES) {
      expect(isPathAllowedWrite("spec/design/222_Feat_Develop_Commit.md", config.stages[stage].allowedWritePaths))
        .toBe(true);
      expect(isPathAllowedWrite("spec/review/Code_Review_x.md", config.stages[stage].allowedWritePaths))
        .toBe(true);
    }
    expect(isPathReadOnly("spec/design/222_Feat_Plan.md", config.stages.develop.allowedReadOnlyPaths))
      .toBe(true);
    expect(isPathReadOnly("spec/design/222_Feat_Plan.md", config.stages.fix.allowedReadOnlyPaths))
      .toBe(true);
  });

  it("keeps the write whitelist and read-only protection effective for `./design`", () => {
    const { config } = resolveCapturingWarnings({
      stages: stageMap(),
      docs: { designDir: "./design", reviewDir: "./review" },
    });
    expect(docsDirsOf(config).designDir).toBe("design");
    expect(isPathAllowedWrite("design/222_Feat_Develop_Commit.md", config.stages.clarify.allowedWritePaths))
      .toBe(true);
    expect(isPathReadOnly("design/222_Feat_Plan.md", config.stages.develop.allowedReadOnlyPaths))
      .toBe(true);
  });

  it("rejects '.' so the archive scope never becomes the project root", () => {
    const { config, warnings } = resolveCapturingWarnings({
      stages: stageMap(),
      docs: { designDir: "." },
    });
    expect(docsDirsOf(config).designDir).toBe(DEFAULT_DESIGN_DIR);
    expect(warnings.some((w) => w.includes("docs.designDir"))).toBe(true);
    // The project root must never appear in the scan list / prune boundary.
    expect(config.archiveDirs).toEqual([DEFAULT_DESIGN_DIR, DEFAULT_REVIEW_DIR]);
  });
});

// ─── Invalid configuration falls back (fail-open) ───────────────────────────

describe("222 Phase 6 — invalid directories warn and fall back", () => {
  const INVALID = ["/abs/design", "C:\\abs\\design", "../escape", "a/../b", "", "   "];

  it("never throws and always resolves a usable layout", () => {
    for (const value of INVALID) {
      const { config, warnings } = resolveCapturingWarnings({
        stages: stageMap(),
        docs: { designDir: value, reviewDir: value, jobsDir: value },
      });
      expect(docsDirsOf(config)).toEqual({
        designDir: DEFAULT_DESIGN_DIR,
        reviewDir: DEFAULT_REVIEW_DIR,
        jobsDir: DEFAULT_JOBS_DIR,
      });
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every((w) => w.startsWith("[pi-pipeline] "))).toBe(true);
    }
  });

  it("warns once per invalid key without dropping the valid ones", () => {
    const { config, warnings } = resolveCapturingWarnings({
      stages: stageMap(),
      docs: { designDir: "../escape", reviewDir: "spec/review" },
    });
    expect(docsDirsOf(config).designDir).toBe(DEFAULT_DESIGN_DIR);
    expect(docsDirsOf(config).reviewDir).toBe("spec/review");
    expect(warnings.filter((w) => w.includes("docs.designDir")).length).toBe(1);
  });

  it("applies the same validation to values DERIVED from docs.stageDirs", () => {
    const { config, warnings } = resolveCapturingWarnings({
      stages: stageMap(),
      docs: { stageDirs: { plan: "../escape", review: "spec/review" } },
    });
    expect(docsDirsOf(config).designDir).toBe(DEFAULT_DESIGN_DIR);
    expect(docsDirsOf(config).reviewDir).toBe("spec/review");
    expect(warnings.some((w) => w.includes("docs.stageDirs.plan"))).toBe(true);
    // The invalid value never reaches a write scope or a read-only glob.
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["docs/design/*_Plan.md"]);
    expect(config.archiveDirs).not.toContain("../escape");
  });
});

// ─── 222 review issue 1: the real upgrade path ─────────────────────────────
//
// Every test above builds its config in memory. The failure this block pins was
// invisible from there: an INSTALLED project keeps the pre-222 template's six
// `docs.stageDirs` values on disk, and `pickStageDir` used to read
// `review: "docs/design"` as a genuine derivation → `reviewDir = docs/design`,
// which broke review discovery, fix start evidence, verify narrowing and the doc
// menu at once. The regression must therefore go through the real loader.

describe("222 review issue 1 — legacy template stageDirs upgrade path", () => {
  /** The `docs.stageDirs` block the pre-222 template shipped (verbatim). */
  const LEGACY_TEMPLATE_STAGE_DIRS = {
    clarify: "docs/design",
    plan: "docs/design",
    "design-review": "docs/design",
    develop: "docs/design",
    review: "docs/design",
    fix: "docs/review",
  };

  /** Every throwaway project root created by this block (removed in `afterAll`). */
  const createdRoots: string[] = [];

  afterAll(async () => {
    for (const root of createdRoots) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Writes a pre-222-shaped `pipeline_loop.json` (legacy `docs.stageDirs` and
   * `archive.dirs`, no `docs.*Dir` key) plus the given project files, then loads
   * it through the production loader.
   */
  async function loadLegacyProject(
    files: string[],
  ): Promise<{ root: string; config: PipelineConfig; warnings: string[] }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-docs-upgrade-"));
    createdRoots.push(root);
    for (const rel of files) {
      const abs = path.join(root, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, "# doc\n", "utf8");
    }
    const configPath = path.join(root, ".pi/pipeline_loop.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({
      stages: Object.fromEntries(ALL_STAGES.map((stage) => [stage, {}])),
      docs: { stageDirs: LEGACY_TEMPLATE_STAGE_DIRS },
    }, null, 2), "utf8");

    const json = loadJsonConfig(configPath);
    json.projectRoot = root;
    const { config, warnings } = resolveCapturingWarnings(json);
    return { root, config, warnings };
  }

  it("keeps reviewDir at docs/review (boilerplate review/fix values are skipped)", async () => {
    const { config } = await loadLegacyProject([]);
    expect(docsDirsOf(config)).toEqual({
      designDir: DEFAULT_DESIGN_DIR,
      reviewDir: DEFAULT_REVIEW_DIR,
      jobsDir: DEFAULT_JOBS_DIR,
    });
    // The block is NOT attached — exactly the unconfigured shape.
    expect("docsDirs" in config).toBe(false);
  });

  it("emits no misleading 'disagree' warning on every startup", async () => {
    const { warnings } = await loadLegacyProject([]);
    expect(warnings.filter((w) => w.includes("disagree"))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("still finds the review report in docs/review", async () => {
    const { root, config } = await loadLegacyProject([
      "docs/design/222_Feat.md",
      "docs/review/Code_Review_222_Feat_Develop_Commit_1.md",
    ]);
    expect(await findLatestReviewReport(root, docsDirsOf(config).reviewDir))
      .toBe(path.join(root, "docs/review/Code_Review_222_Feat_Develop_Commit_1.md"));
  });

  it("narrows the review verify glob to docs/review, not docs/design", async () => {
    const { config } = await loadLegacyProject([]);
    const narrowed = await applyConcreteStageDocPaths(
      rulesWith("docs/review/Code_Review_*.md"),
      config,
      makeTestMeta({
        currentStage: "review",
        requirementDoc: "docs/design/222_Feat.md",
      }),
    );
    expect(narrowed.path).toBe("docs/review/Code_Review_222_Feat_Develop_Commit_*.md");
  });

  it("puts the review and fix doc menus on docs/review", async () => {
    const { config } = await loadLegacyProject([]);
    // `review`/`fix` are the two stages the legacy block pointed at mismatched
    // directories; a boilerplate value must not leak into the menu either.
    expect(resolveStageDocDir(config, "review")).toEqual({
      dir: DEFAULT_DESIGN_DIR,
      autoMatched: true,
    });
    expect(resolveStageDocDir(config, "fix")).toEqual({
      dir: DEFAULT_REVIEW_DIR,
      autoMatched: true,
    });
  });

  it("keeps the archive scope on the two doc directories, never docs/jobs", async () => {
    const { config } = await loadLegacyProject([
      "docs/jobs/nightly_loop.yaml",
      "docs/design/1_Plan.md",
      "docs/review/r.md",
    ]);
    expect(config.archiveDirs).toEqual([DEFAULT_DESIGN_DIR, DEFAULT_REVIEW_DIR]);

    // Real scan: every file is old enough, jobsDir must stay out of the result.
    const scan = await collectArchiveTargets(config, 0, undefined, Date.now() + 86_400_000);
    const relPaths = scan.targets.map((t) => t.relPath).sort();
    expect(relPaths).toEqual(["docs/design/1_Plan.md", "docs/review/r.md"]);
    expect(relPaths.some((p) => p.startsWith("docs/jobs/"))).toBe(false);
  });
});

// ─── 222 review issue 2: the default install archive scope ─────────────────

describe("222 review issue 2 — default install archive scope", () => {
  let tmpRoot = "";

  afterAll(async () => {
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("never collects docs/jobs/*_loop.yaml under the default layout", async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-docs-archive-default-"));
    for (const rel of [
      "docs/design/1_Plan.md",
      "docs/review/r.md",
      "docs/jobs/nightly_loop.yaml",
      "docs/bug/b.md",
    ]) {
      const abs = path.join(tmpRoot, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, "# doc\n", "utf8");
    }

    const config = resolvePipelineConfig({ projectRoot: tmpRoot, stages: stageMap() });
    expect(config.archiveDirs).toEqual([DEFAULT_DESIGN_DIR, DEFAULT_REVIEW_DIR]);

    const scan = await collectArchiveTargets(config, 0, undefined, Date.now() + 86_400_000);
    const relPaths = scan.targets.map((t) => t.relPath).sort();
    // The broad ["docs"] scope used to pull in docs/jobs and docs/bug too.
    expect(relPaths).toEqual(["docs/design/1_Plan.md", "docs/review/r.md"]);
  });
});

// ─── 222 review issue 1: jobsDir nesting under a resolved docs directory ────
//
// The default layout is safe only because the archive scope happens to exclude
// jobsDir. `docs.designDir = "docs"` is a legal layout ("design documents live
// directly under docs/") that puts `docs/jobs` INSIDE the scan root, so the
// invariant must be enforced by the scanner/delete layer, not by disjointness.

describe("222 review issue 1 — jobsDir nested in the archive scope", () => {
  const createdRoots: string[] = [];

  afterAll(async () => {
    for (const root of createdRoots) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  /** Real loader: writes `.pi/pipeline_loop.json` with the given docs block. */
  async function loadProject(
    docs: Record<string, unknown>,
    files: string[],
  ): Promise<{ root: string; config: PipelineConfig }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-docs-jobs-nested-"));
    createdRoots.push(root);
    for (const rel of files) {
      const abs = path.join(root, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, "# doc\n", "utf8");
    }
    const configPath = path.join(root, ".pi/pipeline_loop.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({
      stages: Object.fromEntries(ALL_STAGES.map((stage) => [stage, {}])),
      docs,
    }, null, 2), "utf8");
    const json = loadJsonConfig(configPath);
    json.projectRoot = root;
    return { root, config: resolvePipelineConfig(json) };
  }

  it("resolves the legal nesting layout that used to delete job files", async () => {
    const { config } = await loadProject({ designDir: "docs" }, []);
    expect(docsDirsOf(config)).toEqual({
      designDir: "docs",
      reviewDir: DEFAULT_REVIEW_DIR,
      jobsDir: DEFAULT_JOBS_DIR,
    });
    // The scan list itself still covers docs/ + docs/review (the parent wins in
    // the scanner, which prunes the nested entry).
    expect(config.archiveDirs).toEqual(["docs", DEFAULT_REVIEW_DIR]);
  });

  it("never collects the job file, and delete never removes it", async () => {
    const { root, config } = await loadProject({ designDir: "docs" }, [
      "docs/1_Plan.md",
      "docs/jobs/nightly_loop.yaml",
      "docs/review/r.md",
    ]);

    const scan = await collectArchiveTargets(config, 0, undefined, Date.now() + 86_400_000);
    const relPaths = scan.targets.map((t) => t.relPath).sort();
    expect(relPaths).toEqual(["docs/1_Plan.md", "docs/review/r.md"]);
    expect(scan.skippedJobs).toBe(1);
    expect(scan.targets.map((t) => t.relPath)).not.toContain("docs/jobs/nightly_loop.yaml");

    const deletion = await deleteArchiveTargets(config, scan.targets, archiveScopeRoots(config));
    expect(deletion.errors).toEqual([]);
    expect(deletion.deleted).toBe(2);
    // The invariant the plan states unconditionally: job files are user-maintained.
    expect(fs.existsSync(path.join(root, "docs/jobs/nightly_loop.yaml"))).toBe(true);
  });

  it("honours a custom jobsDir nested inside a custom designDir", async () => {
    const { root, config } = await loadProject(
      { designDir: "spec", jobsDir: "spec/auto-jobs" },
      ["spec/old_Plan.md", "spec/auto-jobs/nightly_loop.yaml"],
    );
    const scan = await collectArchiveTargets(config, 0, undefined, Date.now() + 86_400_000);
    expect(scan.targets.map((t) => t.relPath)).toEqual(["spec/old_Plan.md"]);
    const deletion = await deleteArchiveTargets(config, scan.targets, archiveScopeRoots(config));
    expect(deletion.errors).toEqual([]);
    expect(fs.existsSync(path.join(root, "spec/auto-jobs/nightly_loop.yaml"))).toBe(true);
  });
});

// ─── 222 review issue 2: the archive scope follows a migrated layout ────────

describe("222 review issue 2 — archive scope after migration", () => {
  const createdRoots: string[] = [];

  afterAll(async () => {
    for (const root of createdRoots) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  /** Legacy six-key `stageDirs` block plus an explicit new key. */
  const LEGACY_TEMPLATE_STAGE_DIRS = {
    clarify: "docs/design",
    plan: "docs/design",
    "design-review": "docs/design",
    develop: "docs/design",
    review: "docs/design",
    fix: "docs/review",
  };

  /** Loads a real project whose config is the given docs block. */
  async function loadProject(
    docs: Record<string, unknown>,
    files: string[],
  ): Promise<{ root: string; config: PipelineConfig }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-docs-migrated-"));
    createdRoots.push(root);
    for (const rel of files) {
      const abs = path.join(root, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, "# doc\n", "utf8");
    }
    const configPath = path.join(root, ".pi/pipeline_loop.json");
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({
      stages: Object.fromEntries(ALL_STAGES.map((stage) => [stage, {}])),
      docs,
    }, null, 2), "utf8");
    const json = loadJsonConfig(configPath);
    json.projectRoot = root;
    return { root, config: resolvePipelineConfig(json) };
  }

  it("keeps the migrated deliverable directory INSIDE the archive scope", async () => {
    // The documented migration path: an installed project still carries the
    // six template `stageDirs` values and the user adds `designDir`.
    const { root, config } = await loadProject(
      { designDir: "spec/design", stageDirs: LEGACY_TEMPLATE_STAGE_DIRS },
      [
        "docs/design/old_Plan.md",
        "spec/design/222_Feat_Plan.md",
        "docs/review/old_r.md",
      ],
    );
    expect(docsDirsOf(config).designDir).toBe("spec/design");
    // Before the fix this was ["docs/design","docs/review"]: the boilerplate
    // block won and `spec/design` was never scanned.
    expect(config.archiveDirs).toEqual(["spec/design", "docs/review"]);

    const scan = await collectArchiveTargets(config, 0, undefined, Date.now() + 86_400_000);
    const relPaths = scan.targets.map((t) => t.relPath).sort();
    expect(relPaths).toEqual(["docs/review/old_r.md", "spec/design/222_Feat_Plan.md"]);
    expect(fs.existsSync(path.join(root, "spec/design/222_Feat_Plan.md"))).toBe(true);
  });

  it("keeps a reviewDir migration inside the archive scope as well", async () => {
    const { config } = await loadProject(
      { reviewDir: "spec/review", stageDirs: LEGACY_TEMPLATE_STAGE_DIRS },
      ["spec/review/Code_Review_222_Feat_Develop_Commit_1.md"],
    );
    expect(docsDirsOf(config).reviewDir).toBe("spec/review");
    expect(config.archiveDirs).toContain("spec/review");

    const scan = await collectArchiveTargets(config, 0, undefined, Date.now() + 86_400_000);
    expect(scan.targets.map((t) => t.relPath)).toContain(
      "spec/review/Code_Review_222_Feat_Develop_Commit_1.md",
    );
  });

  it("does not duplicate targets when the resolved dir nests in a stageDirs dir", async () => {
    const { config } = await loadProject(
      { designDir: "docs", stageDirs: { clarify: "docs/design" } },
      ["docs/1_Plan.md", "docs/design/2_Plan.md"],
    );
    const scan = await collectArchiveTargets(config, 0, undefined, Date.now() + 86_400_000);
    const relPaths = scan.targets.map((t) => t.relPath);
    expect(new Set(relPaths).size).toBe(relPaths.length);
  });
});