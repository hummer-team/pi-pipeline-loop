/**
 * 222 Phase 3: docs directories → stage write scope, archive scope and
 * `/pipeline-init` directory creation.
 *
 * Contract:
 * - the resolved `designDir` appears in the read-only stages' write whitelist
 *   (append-only) and in the develop/fix read-only protection glob;
 * - explicitly configured stage whitelists are never overridden;
 * - the archive scope priority is `archive.dirs` → `docs.stageDirs` →
 *   `[designDir, reviewDir]` → `["docs"]` (the last tier is not reachable from
 *   `resolvePipelineConfig`, so a default project scans the two doc dirs), and
 *   `jobsDir` is never archived;
 * - `/pipeline-init` creates design + review (but not jobs), idempotently.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { createPipelineInitCommand } from "../../commands/pipeline-init";
import { DEFAULT_DESIGN_DIR, DEFAULT_JOBS_DIR, DEFAULT_REVIEW_DIR } from "../../constants";
import { makeStageConfig, makeTestConfig } from "../helpers";
import type { DocsDirs, PipelineConfig, PipelineJsonConfig, PipelineStage } from "../../types";

const CUSTOM_DOCS = {
  designDir: "spec/design",
  reviewDir: "spec/review",
  jobsDir: "spec/jobs",
};

const ALL_STAGES: PipelineStage[] = [
  "clarify", "plan", "design-review", "develop", "review", "fix", "awaiting_human", "completed",
];

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

describe("resolvePipelineConfig scope (222 Phase 3)", () => {
  it("appends the configured design directory to the read-only stage whitelists", () => {
    const config = resolvePipelineConfig({
      stages: { clarify: {}, plan: {}, "design-review": {}, review: {} },
      docs: CUSTOM_DOCS,
    });
    for (const stage of ["clarify", "plan", "design-review", "review"] as const) {
      expect(config.stages[stage].allowedWritePaths).toContain("spec/design/");
      expect(config.stages[stage].allowedWritePaths).toContain("spec/review/");
      // The legacy entries survive (append-only, R3Q9-A).
      expect(config.stages[stage].allowedWritePaths).toContain("docs/");
    }
  });

  it("protects the plan document of the configured design directory", () => {
    const config = resolvePipelineConfig({
      stages: { develop: {}, fix: {} },
      docs: CUSTOM_DOCS,
    });
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["spec/design/*_Plan.md"]);
    expect(config.stages.fix.allowedReadOnlyPaths).toEqual(["spec/design/*_Plan.md"]);
  });

  it("never overrides an explicitly configured allowedWritePaths", () => {
    const config = resolvePipelineConfig({
      stages: { clarify: { allowedWritePaths: ["src/"] }, develop: { allowedWritePaths: ["**"] } },
      docs: CUSTOM_DOCS,
    });
    expect(config.stages.clarify.allowedWritePaths).toEqual(["src/"]);
    expect(config.stages.develop.allowedWritePaths).toEqual(["**"]);
  });

  it("respects an explicitly configured allowedReadOnlyPaths", () => {
    const config = resolvePipelineConfig({
      stages: { develop: { allowedReadOnlyPaths: ["other/*.md"] } },
      docs: CUSTOM_DOCS,
    });
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["other/*.md"]);
  });
});

describe("archiveDirs priority (222 Phase 3)", () => {
  it("tier 1: archive.dirs wins over everything", () => {
    const config = resolvePipelineConfig({
      stages: { clarify: {} },
      archive: { dirs: ["keep/me"] },
      docs: { ...CUSTOM_DOCS, stageDirs: { plan: "legacy/design" } },
    });
    expect(config.archiveDirs).toEqual(["keep/me"]);
  });

  it("tier 2: resolved dirs ∪ non-boilerplate docs.stageDirs values", () => {
    const config = resolvePipelineConfig({
      stages: { clarify: {} },
      docs: { ...CUSTOM_DOCS, stageDirs: { plan: "legacy/design", fix: "legacy/review" } },
    });
    // 222 review issue 2: the resolved layout is always part of the scope (the
    // deliverables can never fall outside the archive range), and a
    // non-boilerplate stageDirs value stays in the list so pre-migration
    // documents remain archivable.
    expect(config.archiveDirs).toEqual([
      "spec/design",
      "spec/review",
      "legacy/design",
      "legacy/review",
    ]);
  });

  it("tier 2 ignores boilerplate stageDirs values (same predicate as the derivation)", () => {
    const config = resolvePipelineConfig({
      stages: { clarify: {} },
      docs: {
        designDir: "spec/design",
        reviewDir: "spec/review",
        stageDirs: { plan: "docs/design", review: "docs/design", fix: "docs/review" },
      },
    });
    // The stale template block contributes nothing → exactly the resolved dirs.
    expect(config.archiveDirs).toEqual(["spec/design", "spec/review"]);
  });

  it("tier 3: the resolved [designDir, reviewDir] when nothing else is configured", () => {
    const config = resolvePipelineConfig({
      stages: { clarify: {} },
      docs: CUSTOM_DOCS,
    });
    expect(config.archiveDirs).toEqual(["spec/design", "spec/review"]);
  });

  it("tier 3 dedupes when both directories are the same", () => {
    const config = resolvePipelineConfig({
      stages: { clarify: {} },
      docs: { designDir: "spec/docs", reviewDir: "spec/docs/" },
    });
    expect(config.archiveDirs).toEqual(["spec/docs"]);
  });

  it("fallback: an unconfigured project scans the resolved default directories", () => {
    // Review issue 2: the pre-222 template pinned ["docs/design","docs/review"];
    // the derived chain now reproduces exactly that instead of widening to ["docs"].
    expect(resolvePipelineConfig({ stages: { clarify: {} } }).archiveDirs)
      .toEqual([DEFAULT_DESIGN_DIR, DEFAULT_REVIEW_DIR]);
  });

  it("never widens to a broad scope that would contain jobsDir", () => {
    const config = resolvePipelineConfig({ stages: { clarify: {} } });
    expect(config.archiveDirs).not.toContain(DEFAULT_JOBS_DIR);
    // A broad ["docs"] scope would make docs/jobs reachable by the scanner.
    const archiveDirs = config.archiveDirs ?? [];
    expect(archiveDirs.every((dir) => !DEFAULT_JOBS_DIR.startsWith(`${dir}/`))).toBe(true);
  });

  it("never archives jobsDir", () => {
    const config = resolvePipelineConfig({
      stages: { clarify: {} },
      docs: CUSTOM_DOCS,
    });
    expect(config.archiveDirs).not.toContain("spec/jobs");
  });

  it("keeps the resolved dirs in the scope even under a partial stageDirs customisation", () => {
    // Review issue 2: `stageDirs` alone used to REPLACE the scope, so the
    // deliverable directory could fall outside it.
    const config = resolvePipelineConfig({
      stages: { clarify: {} },
      docs: { designDir: "spec/design", stageDirs: { review: "legacy/review" } },
    });
    // reviewDir derives from the `review` key, so the union is exactly these.
    expect(config.archiveDirs).toEqual(["spec/design", "legacy/review"]);
  });
});

// ─── /pipeline-init directory creation ──────────────────────────────────────

describe("pipeline-init directory creation (222 Phase 3)", () => {
  /** Runs `/pipeline-init 0` in a throwaway project root. */
  async function runInit(
    docsOverride?: DocsDirs,
  ): Promise<{ root: string; exists: (rel: string) => boolean; cleanup: () => Promise<void> }> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-init-dirs-"));
    const command = createPipelineInitCommand(makeInitConfig(root, docsOverride));
    const result = (await command.execute({ sub: "0" })) as { success?: boolean };
    expect(result.success).toBe(true);
    return {
      root,
      exists: (rel: string) => fs.existsSync(path.join(root, rel)),
      cleanup: async () => { await fsp.rm(root, { recursive: true, force: true }); },
    };
  }

  it("creates the default design and review directories", async () => {
    const run = await runInit();
    expect(run.exists("docs/design")).toBe(true);
    expect(run.exists("docs/review")).toBe(true);
    await run.cleanup();
  });

  it("creates the CONFIGURED directories and no jobsDir", async () => {
    const run = await runInit(CUSTOM_DOCS);
    expect(run.exists("spec/design")).toBe(true);
    expect(run.exists("spec/review")).toBe(true);
    expect(run.exists("spec/jobs")).toBe(false);
    await run.cleanup();
  });

  it("is idempotent: a second run neither fails nor rewrites the directories", async () => {
    const run = await runInit(CUSTOM_DOCS);
    const probe = path.join(run.root, "spec/design/keep.md");
    await fsp.writeFile(probe, "preserve", "utf8");

    const config = makeInitConfig(run.root, CUSTOM_DOCS);
    const command = createPipelineInitCommand(config);
    const second = (await command.execute({ sub: "0" })) as { success?: boolean; content?: string };
    expect(second.success).toBe(true);
    expect(second.content).toContain("spec/design/: already exists");
    expect(await fsp.readFile(probe, "utf8")).toBe("preserve");
    await run.cleanup();
  });

  it("derives the created directories from docs.stageDirs when no explicit key exists", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-init-stage-"));
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      docs: { stageDirs: { plan: "derived/design", review: "derived/review" } },
      projectRoot: root,
    };
    const config = resolvePipelineConfig(json);
    const command = createPipelineInitCommand(config);
    const result = (await command.execute({ sub: "0" })) as { success?: boolean };
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(root, "derived/design"))).toBe(true);
    expect(fs.existsSync(path.join(root, "derived/review"))).toBe(true);
    await fsp.rm(root, { recursive: true, force: true });
  });
});