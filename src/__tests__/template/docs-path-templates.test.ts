/**
 * 222 Phase 5: docs-path tokens in the shipped templates.
 *
 * Contract:
 * - `renderDocsPathTokens` resolves `{designDir}` / `{reviewDir}` / `{jobsDir}`
 *   and leaves unknown tokens untouched;
 * - `/pipeline-init` renders the tokens of every asset an agent reads DIRECTLY
 *   (four landing points: copy loop, managed block, drift expectation,
 *   conflict-check prompt) — after installation only
 *   `references/pipeline-stage-prompt.yml` may still carry a token (it is
 *   rendered at runtime / through the managed block);
 * - `guide.md` is NOT rendered (whole-file drift comparison);
 * - the drift expectation is rendered from the SAME directories as the
 *   deployment, so a customised project reports no phantom drift;
 * - runtime rendering covers the yml deliverables and the plan-stage fallback,
 *   while the `verify_extract_*` JSON examples stay untouched;
 * - the known degradation is pinned: an installed `verify.md` naming a THIRD
 *   directory keeps its glob (the fix is re-running `/pipeline-init`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createPipelineInitCommand } from "../../commands/pipeline-init";
import { createPromptInjector } from "../../core/prompt-injector";
import { parseFrontmatter, type VerifyRules } from "../../core/verify-frontmatter";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { applyConcreteStageDocPaths } from "../../core/verify-path-resolver";
import { DEFAULT_DOCS_DIRS, renderDocsPathTokens } from "../../docs-paths";
import { checkTemplateDrift } from "../../utils/template-drift";
import { makeStageConfig, makeTestConfig, makeTestMeta, writePromptYml } from "../helpers";
import type { DocsDirs, PipelineConfig, PipelineStage } from "../../types";

const CUSTOM_DIRS: DocsDirs = {
  designDir: "spec/design",
  reviewDir: "spec/review",
  jobsDir: "spec/jobs",
};

const ALL_STAGES: PipelineStage[] = [
  "clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed",
];

/** Docs-path tokens that must never survive installation (except in the yml). */
const DOCS_TOKENS = ["{designDir}", "{reviewDir}", "{jobsDir}"] as const;

/** Config accepted by `/pipeline-init`, rooted at a throwaway project directory. */
function makeInitConfig(projectRoot: string, docsDirs?: DocsDirs): PipelineConfig {
  return makeTestConfig({
    projectRoot,
    ...(docsDirs ? { docsDirs } : {}),
    stages: Object.fromEntries(
      ALL_STAGES.map((stage, index) => [
        stage,
        makeStageConfig({ nextStage: ALL_STAGES[index + 1] ?? null }),
      ]),
    ) as PipelineConfig["stages"],
  });
}

/** Creates an empty temp project root. */
async function makeTempRoot(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Installs the bundled templates into `root` (dir branch only). */
async function install(root: string, docsDirs?: DocsDirs): Promise<void> {
  const command = createPipelineInitCommand(makeInitConfig(root, docsDirs));
  const result = (await command.execute({ sub: "0" })) as { success?: boolean };
  expect(result.success).toBe(true);
  resetPromptConfigCache();
}

/** Every regular file below `dir`, as absolute paths. */
async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(abs)));
    else files.push(abs);
  }
  return files;
}

/** Reads the frontmatter of a deployed stage `verify.md` into VerifyRules. */
async function readDeployedRules(verifyMdPath: string): Promise<VerifyRules> {
  const raw = await fsp.readFile(verifyMdPath, "utf8");
  const rules = await parseFrontmatter(raw.split(/^---\s*$/m)[1].trim());
  if (!rules) throw new Error(`Failed to parse ${verifyMdPath}`);
  return rules;
}

// ─── renderDocsPathTokens (single source of rendering) ──────────────────────

describe("renderDocsPathTokens (222 Phase 5)", () => {
  it("replaces all three tokens with the resolved directories", () => {
    const text = "a={designDir} b={reviewDir} c={jobsDir}";
    expect(renderDocsPathTokens(text, CUSTOM_DIRS))
      .toBe("a=spec/design b=spec/review c=spec/jobs");
  });

  it("replaces every occurrence of a repeated token", () => {
    const text = "{designDir}/x.md\n{designDir}/y.md\n{designDir}/z.md";
    expect(renderDocsPathTokens(text, CUSTOM_DIRS)).toBe(
      "spec/design/x.md\nspec/design/y.md\nspec/design/z.md",
    );
  });

  it("leaves unknown tokens untouched (disjoint token families)", () => {
    const text = "{designDir}/{pipelineId}/{reqBase}/{completionMarker}";
    expect(renderDocsPathTokens(text, CUSTOM_DIRS))
      .toBe("spec/design/{pipelineId}/{reqBase}/{completionMarker}");
  });

  it("keeps the default layout byte-identical to the legacy literals", () => {
    expect(renderDocsPathTokens("{designDir}/*_Plan.md", DEFAULT_DOCS_DIRS))
      .toBe("docs/design/*_Plan.md");
    expect(renderDocsPathTokens("{reviewDir}/Code_Review_*.md", DEFAULT_DOCS_DIRS))
      .toBe("docs/review/Code_Review_*.md");
    expect(renderDocsPathTokens("{jobsDir}/x_loop.yaml", DEFAULT_DOCS_DIRS))
      .toBe("docs/jobs/x_loop.yaml");
  });
});

// ─── install-time rendering (landing points ① + ②) ──────────────────────────

describe("install-time docs-path rendering (222 Phase 5)", () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTempRoot("pi-docs-tokens-");
    await install(root, CUSTOM_DIRS);
  });

  afterAll(async () => {
    resetPromptConfigCache();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("renders the stage verify specs to the configured directories", async () => {
    const plan = await fsp.readFile(path.join(root, ".pi/references/plan_spec/verify.md"), "utf8");
    expect(plan).toContain('path: "spec/design/*_Plan.md"');
    expect(plan).toContain("spec/design/*_Plan.md");

    const develop = await fsp.readFile(path.join(root, ".pi/references/develop_spec/verify.md"), "utf8");
    expect(develop).toContain('path: "spec/design/*_Develop_Commit.md"');

    const review = await fsp.readFile(path.join(root, ".pi/references/review_spec/verify.md"), "utf8");
    expect(review).toContain('path: "spec/review/Code_Review_*.md"');

    const designReview = await fsp.readFile(
      path.join(root, ".pi/references/design-review_spec/verify.md"),
      "utf8",
    );
    expect(designReview).toContain("spec/design/Design_Review_*_*.md");
  });

  it("renders the commit template and the job template examples", async () => {
    const commitTemplate = await fsp.readFile(
      path.join(root, ".pi/references/develop_commit_template.md"),
      "utf8",
    );
    expect(commitTemplate).toContain("**plan doc**: `spec/design/04_feat_");

    const jobTemplate = await fsp.readFile(
      path.join(root, ".pi/auto_job_loop_template.yaml"),
      "utf8",
    );
    expect(jobTemplate).toContain("- doc: \"spec/design/200_Feat.md\"");
    expect(jobTemplate).toContain("spec/jobs/<name>_loop.yaml");
  });

  it("renders the skills, including the managed contract block (landing point ②)", async () => {
    const develop = await fsp.readFile(path.join(root, ".pi/skills/develop/SKILL.md"), "utf8");
    // Inside the managed block written by the post-copy merge loop.
    expect(develop).toContain("write a human-readable commit record to `spec/design/`");
    // Block-external path convention note (landing point ①).
    expect(develop).toContain("use user-visible paths such as `spec/design/`");

    const review = await fsp.readFile(path.join(root, ".pi/skills/review/SKILL.md"), "utf8");
    expect(review).toContain("### 8.1 Review Output Directory: `spec/review`");
    expect(review).toContain("`spec/review/Code_Review_xx_Plan_Develop_Commit_1.md`");

    const design = await fsp.readFile(path.join(root, ".pi/skills/design/SKILL.md"), "utf8");
    expect(design).toContain("`spec/design/{index}_{xxx}.md`");

    const plan = await fsp.readFile(path.join(root, ".pi/skills/plan/SKILL.md"), "utf8");
    expect(plan).toContain("`spec/design/01_e2e_flow_v1_Plan.md`");
  });

  it("keeps guide.md byte-identical to the repo source (never rendered)", async () => {
    const deployed = await fsp.readFile(path.join(root, ".pi/guide.md"), "utf8");
    const source = await fsp.readFile(path.join(__dirname, "../../template/guide.md"), "utf8");
    expect(deployed).toBe(source);
  });

  it("leaves the tokens in the yml (runtime rendering) but resolves the deliverables", async () => {
    const yml = await fsp.readFile(
      path.join(root, ".pi/references/pipeline-stage-prompt.yml"),
      "utf8",
    );
    // Legit token retention: the yml is rendered at runtime / through the block.
    expect(yml).toContain("write a human-readable commit record to `{designDir}/`");
    // LLM JSON examples are intentionally NOT tokenised (R2Q7-C).
    expect(yml).toContain('{"type": "file", "target": "docs/design/commit.md"}');
  });

  it("leaves no docs-path token outside the yml", async () => {
    const files = await walkFiles(path.join(root, ".pi"));
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = path.relative(path.join(root, ".pi"), abs);
      if (rel === path.join("references", "pipeline-stage-prompt.yml")) continue;
      const content = await fsp.readFile(abs, "utf8");
      if (DOCS_TOKENS.some((token) => content.includes(token))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// ─── drift expectation (landing point ③) ────────────────────────────────────

describe("drift expectation uses the deployed docs layout (222 Phase 5)", () => {
  /**
   * Drift that predates 222 and is unrelated to docs paths: the clarify marker
   * placeholders (`{completionMarker}` …) are resolved at install time but not
   * in the drift expectation (221), so `clarify_template.md` (whole-file hash)
   * and the `design` SKILL managed block always differ.
   */
  const PRE_EXISTING_DRIFT = ["references/clarify_template.md", "skills/design/SKILL.md"];

  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("pi-docs-drift-");
    await install(root, CUSTOM_DIRS);
  });

  afterAll(async () => {
    resetPromptConfigCache();
  });

  it("reports no NEW drift when the expectation is rendered from the same directories", async () => {
    const drifts = await checkTemplateDrift(root, ".pi", CUSTOM_DIRS);
    expect(drifts.map((d) => d.asset).sort()).toEqual(PRE_EXISTING_DRIFT);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("would report a phantom drift if the expectation used the default layout", async () => {
    // Proves the `dirs` parameter is actually load-bearing: with the default
    // layout the deployed `develop` / `fix` blocks no longer match.
    const drifts = await checkTemplateDrift(root, ".pi", DEFAULT_DOCS_DIRS);
    const assets = drifts.map((d) => d.asset);
    expect(assets).toContain("skills/develop/SKILL.md");
    expect(assets).toContain("skills/fix/SKILL.md");
    await fsp.rm(root, { recursive: true, force: true });
  });
});

// ─── runtime rendering (yml deliverables + plan fallback) ────────────────────

describe("runtime docs-path rendering (222 Phase 5)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempRoot("pi-docs-runtime-");
    resetPromptConfigCache();
  });

  afterAll(async () => {
    resetPromptConfigCache();
  });

  it("renders the injected yml deliverables with the configured design directory", async () => {
    await writePromptYml(root, [
      "develop: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_deliverables}}",
      "stage_deliverable_develop: |",
      "  - **MUST** write a commit record to `{designDir}/` (e.g. `{reqBase}_Develop_Commit.md`)",
    ].join("\n"));

    const config = makeTestConfig({ projectRoot: root, docsDirs: CUSTOM_DIRS });
    const meta = makeTestMeta({ currentStage: "develop" });
    const hook = createPromptInjector(config);
    const result = (await hook.handler({ session: { getMeta: () => meta } } as never)) as {
      systemPrompt?: string;
    };

    expect(result.systemPrompt).toContain("write a commit record to `spec/design/`");
    expect(result.systemPrompt).not.toContain("{designDir}");
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("keeps the default literal for an unconfigured project", async () => {
    await writePromptYml(root, [
      "develop: |",
      "  {{stage_deliverables}}",
      "stage_deliverable_develop: |",
      "  - **MUST** write a commit record to `{designDir}/`",
    ].join("\n"));

    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({ currentStage: "develop" });
    const hook = createPromptInjector(config);
    const result = (await hook.handler({ session: { getMeta: () => meta } } as never)) as {
      systemPrompt?: string;
    };

    expect(result.systemPrompt).toContain("write a commit record to `docs/design/`");
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("falls back to the configured design directory for the plan target file", async () => {
    // No yml deliverable for the plan stage → the deterministic naming fallback runs.
    await writePromptYml(root, 'stage_deliverable_develop: "x"\n');

    const config = makeTestConfig({ projectRoot: root, docsDirs: CUSTOM_DIRS });
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: undefined });
    const hook = createPromptInjector(config);
    const result = (await hook.handler({ session: { getMeta: () => meta } } as never)) as {
      systemPrompt?: string;
    };

    expect(result.systemPrompt).toContain("**Target file**: `spec/design/{reqBase}_Plan.md`");
    await fsp.rm(root, { recursive: true, force: true });
  });
});

// ─── known degradation: installed verify.md naming a third directory ────────

describe("known degradation after a docs-directory change (222 Phase 5)", () => {
  it("keeps the authored glob when the installed verify.md names a third directory", async () => {
    const root = await makeTempRoot("pi-docs-degrade-");
    // 1. Install with the THEN current layout.
    await install(root, CUSTOM_DIRS);
    const rules = await readDeployedRules(
      path.join(root, ".pi/references/develop_spec/verify.md"),
    );
    expect(rules.path).toBe("spec/design/*_Develop_Commit.md");

    // 2. The layout changes WITHOUT re-running /pipeline-init.
    const movedConfig = makeTestConfig({
      projectRoot: root,
      docsDirs: { designDir: "release/design", reviewDir: "release/review", jobsDir: "spec/jobs" },
    });
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: "release/design/222_Feat.md",
    });
    const narrowed = await applyConcreteStageDocPaths(rules, movedConfig, meta);

    // The stale literal matches neither the configured nor the default directory,
    // so it is preserved verbatim (no narrowing) — pinned by `/pipeline-init` rerun.
    expect(narrowed.path).toBe("spec/design/*_Develop_Commit.md");

    // 3. Re-running /pipeline-init with a force overwrite resolves the degradation.
    const command = createPipelineInitCommand(movedConfig);
    const forced = (await command.execute({ sub: "0" }, {
      ui: { select: async (): Promise<string> => "1. Force overwrite all files" },
    } as never)) as { success?: boolean };
    expect(forced.success).toBe(true);
    resetPromptConfigCache();
    const refreshed = await readDeployedRules(
      path.join(root, ".pi/references/develop_spec/verify.md"),
    );
    expect(refreshed.path).toBe("release/design/*_Develop_Commit.md");
    const afterRefresh = await applyConcreteStageDocPaths(refreshed, movedConfig, meta);
    expect(afterRefresh.path).toBe("release/design/222_Feat_Develop_Commit.md");

    resetPromptConfigCache();
    await fsp.rm(root, { recursive: true, force: true });
  });
});

// ─── shipped template invariants ────────────────────────────────────────────

describe("shipped template invariants (222 Phase 5)", () => {
  const templateDir = path.join(__dirname, "../../template");

  it("guide.md documents the layout and the re-init requirement", () => {
    const guide = fs.readFileSync(path.join(templateDir, "guide.md"), "utf8");
    expect(guide).toContain("docs.designDir");
    expect(guide).toContain("docs.reviewDir");
    expect(guide).toContain("docs.jobsDir");
    expect(guide).toContain("修改目录后必须重跑 `/pipeline-init`");
  });

  it("ships tokens only in the assets the renderers actually cover", () => {
    const withTokens = [
      "references/plan_spec/verify.md",
      "references/develop_spec/verify.md",
      "references/fix_spec/verify.md",
      "references/review_spec/verify.md",
      "references/design-review_spec/verify.md",
      "references/develop_commit_template.md",
      "auto_job_loop_template.yaml",
      "skills/design/SKILL.md",
      "skills/plan/SKILL.md",
      "skills/develop/SKILL.md",
      "skills/review/SKILL.md",
      "references/pipeline-stage-prompt.yml",
    ];
    for (const rel of withTokens) {
      const content = fs.readFileSync(path.join(templateDir, rel), "utf8");
      expect(DOCS_TOKENS.some((token) => content.includes(token))).toBe(true);
    }
    // Assets that must stay token-free (never rendered).
    for (const rel of ["guide.md", "references/clarify_template.md", "skills/fix/SKILL.md"]) {
      const content = fs.readFileSync(path.join(templateDir, rel), "utf8");
      expect(DOCS_TOKENS.some((token) => content.includes(token))).toBe(false);
    }
  });
});