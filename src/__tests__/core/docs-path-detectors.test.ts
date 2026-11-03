/**
 * 222 Phase 1: verify-glob detectors, concrete-path narrowing and the plan
 * confirm-marker rule.
 *
 * Contract:
 * - the detectors accept BOTH the configured-directory glob and the legacy
 *   default-directory glob (so an already-installed verify.md keeps working);
 * - `applyConcreteStageDocPaths` narrows those globs to the configured layout;
 * - `resolveCommitDocPath` / `getStageDeliverableExemptions` honour the
 *   configured design directory.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyConcreteStageDocPaths,
  getStageDeliverableExemptions,
  isCommitDocGlob,
  isPlanDocGlob,
  isReviewDocGlob,
  resolveCommitDocPath,
} from "../../core/verify-path-resolver";
import { buildPlanConfirmMarkerRule } from "../../core/stage-advancer";
import { buildCommitDocGlob, buildPlanDocGlob, buildReviewDocGlob } from "../../docs-paths";
import type { PipelineConfig, SessionMeta } from "../../types";
import type { VerifyRules } from "../../core/verify-frontmatter";
import { makeTestMeta } from "../helpers";

const DESIGN_DIR = "spec/design";
const REVIEW_DIR = "spec/review";

/** Minimal config carrying only what the resolver reads. */
function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    projectRoot: "/tmp/pi-docs-detectors",
    stages: {},
    ...overrides,
  } as unknown as PipelineConfig;
}

const CONFIGURED = makeConfig({
  docsDirs: { designDir: DESIGN_DIR, reviewDir: REVIEW_DIR, jobsDir: "spec/jobs" },
});

describe("isPlanDocGlob", () => {
  it("matches the default literal and its Windows variant", () => {
    expect(isPlanDocGlob("docs/design/*_Plan.md")).toBe(true);
    expect(isPlanDocGlob("docs\\design\\*_Plan.md")).toBe(true);
  });

  it("matches the configured-directory literal and its Windows variant", () => {
    expect(isPlanDocGlob("spec/design/*_Plan.md", DESIGN_DIR)).toBe(true);
    expect(isPlanDocGlob("spec\\design\\*_Plan.md", DESIGN_DIR)).toBe(true);
  });

  it("rejects a third directory (no over-matching)", () => {
    expect(isPlanDocGlob("other/design/*_Plan.md", DESIGN_DIR)).toBe(false);
  });

  it("rejects the legacy `*_plan.md` spelling (201 hard switch)", () => {
    expect(isPlanDocGlob("docs/design/*_plan.md")).toBe(false);
    expect(isPlanDocGlob("spec/design/*_plan.md", DESIGN_DIR)).toBe(false);
  });
});

describe("isCommitDocGlob", () => {
  it("recognises both families in both directories", () => {
    for (const dir of ["docs/design", DESIGN_DIR]) {
      expect(isCommitDocGlob(buildCommitDocGlob(dir), DESIGN_DIR)).toBe(true);
      expect(isCommitDocGlob(buildCommitDocGlob(dir, true), DESIGN_DIR)).toBe(true);
      expect(isCommitDocGlob(buildCommitDocGlob(dir).replace(/\//g, "\\"), DESIGN_DIR)).toBe(true);
    }
  });

  it("rejects another directory and a bare file name", () => {
    expect(isCommitDocGlob("other/*_Develop_Commit.md", DESIGN_DIR)).toBe(false);
    expect(isCommitDocGlob("*_Develop_Commit.md", DESIGN_DIR)).toBe(false);
  });
});

describe("isReviewDocGlob", () => {
  it("recognises both families in both directories", () => {
    for (const dir of ["docs/review", REVIEW_DIR]) {
      expect(isReviewDocGlob(buildReviewDocGlob(dir), REVIEW_DIR)).toBe(true);
      expect(isReviewDocGlob(buildReviewDocGlob(dir, true), REVIEW_DIR)).toBe(true);
      expect(isReviewDocGlob(buildReviewDocGlob(dir).replace(/\//g, "\\"), REVIEW_DIR)).toBe(true);
    }
  });

  it("rejects the design directory (a plan doc is never a review report)", () => {
    expect(isReviewDocGlob(buildReviewDocGlob("docs/design"), REVIEW_DIR)).toBe(false);
  });
});

describe("resolveCommitDocPath", () => {
  it("defaults to the built-in design directory", () => {
    expect(resolveCommitDocPath("222_Feat")).toBe("docs/design/222_Feat_Develop_Commit.md");
  });

  it("honours a custom directory and tolerates trailing slashes", () => {
    expect(resolveCommitDocPath("222_Feat", DESIGN_DIR))
      .toBe("spec/design/222_Feat_Develop_Commit.md");
    expect(resolveCommitDocPath("222_Feat", `${DESIGN_DIR}//`))
      .toBe("spec/design/222_Feat_Develop_Commit.md");
  });

  it("never returns an empty or malformed value for an empty requirement base", () => {
    const value = resolveCommitDocPath("");
    expect(value).toBe("docs/design/_Develop_Commit.md");
    expect(value.startsWith("docs/design/")).toBe(true);
  });
});

describe("getStageDeliverableExemptions", () => {
  const meta = makeTestMeta({ requirementDoc: "spec/design/222_Feat.md" });

  it("exempts the commit doc in the default directory", () => {
    expect(getStageDeliverableExemptions(meta, "develop"))
      .toEqual(["docs/design/222_Feat_Develop_Commit.md"]);
  });

  it("exempts the commit doc in a custom directory", () => {
    expect(getStageDeliverableExemptions(meta, "fix", DESIGN_DIR))
      .toEqual(["spec/design/222_Feat_Develop_Commit.md"]);
  });

  it("returns nothing for a non-deliverable stage or a missing requirement doc", () => {
    expect(getStageDeliverableExemptions(meta, "plan", DESIGN_DIR)).toEqual([]);
    expect(getStageDeliverableExemptions(makeTestMeta({ requirementDoc: undefined }), "develop"))
      .toEqual([]);
  });
});

describe("buildPlanConfirmMarkerRule", () => {
  it("defaults to the built-in design directory", () => {
    expect(buildPlanConfirmMarkerRule()).toEqual({
      path: "docs/design/*_Plan.md",
      pattern: "^## (用户确认|User Confirmation)",
    });
  });

  it("points at the configured design directory", () => {
    expect(buildPlanConfirmMarkerRule(DESIGN_DIR).path).toBe("spec/design/*_Plan.md");
  });
});

// ─── applyConcreteStageDocPaths: detector wiring ─────────────────────────────

describe("applyConcreteStageDocPaths narrowing", () => {
  let tmpRoot: string;

  /** Creates a temp project root with the given relative files. */
  async function makeProject(files: string[]): Promise<string> {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-docs-narrow-"));
    for (const rel of files) {
      const abs = path.join(tmpRoot, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, "# doc\n", "utf8");
    }
    return tmpRoot;
  }

  function rulesWith(relPaths: string[]): VerifyRules {
    return {
      keywords: [],
      mode: "and",
      path: relPaths[0],
      requiredFiles: [...relPaths],
      fileContentPattern: relPaths.map((p) => ({ path: p, pattern: "^x$" })),
    };
  }

  it("narrows CONFIGURED-directory commit globs (closure wiring)", async () => {
    const root = await makeProject([`${DESIGN_DIR}/222_Feat.md`]);
    const config = makeConfig({
      projectRoot: root,
      docsDirs: { designDir: DESIGN_DIR, reviewDir: REVIEW_DIR, jobsDir: "spec/jobs" },
    });
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: `${DESIGN_DIR}/222_Feat.md`,
    });
    const result = await applyConcreteStageDocPaths(
      rulesWith([buildCommitDocGlob(DESIGN_DIR), buildCommitDocGlob(DESIGN_DIR, true)]),
      config,
      meta,
    );
    expect(result.requiredFiles).toEqual([
      "spec/design/222_Feat_Develop_Commit.md",
      "spec/design/222_Feat_Develop_Commit.md",
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("narrows CONFIGURED-directory review globs (closure wiring)", async () => {
    const root = await makeProject([`${DESIGN_DIR}/222_Feat.md`]);
    const config = makeConfig({
      projectRoot: root,
      docsDirs: { designDir: DESIGN_DIR, reviewDir: REVIEW_DIR, jobsDir: "spec/jobs" },
    });
    const meta = makeTestMeta({
      currentStage: "review",
      requirementDoc: `${DESIGN_DIR}/222_Feat.md`,
    });
    const result = await applyConcreteStageDocPaths(
      rulesWith([buildReviewDocGlob(REVIEW_DIR), buildReviewDocGlob(REVIEW_DIR, true)]),
      config,
      meta,
    );
    expect(result.requiredFiles).toEqual([
      "spec/review/Code_Review_222_Feat_Develop_Commit_*.md",
      "spec/review/Code_Review_222_Feat_Develop_Commit_*.md",
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("narrows LEGACY default-directory globs too (already-installed verify.md)", async () => {
    const root = await makeProject([`${DESIGN_DIR}/222_Feat.md`]);
    const config = makeConfig({
      projectRoot: root,
      docsDirs: { designDir: DESIGN_DIR, reviewDir: REVIEW_DIR, jobsDir: "spec/jobs" },
    });
    const meta = makeTestMeta({
      currentStage: "fix",
      requirementDoc: `${DESIGN_DIR}/222_Feat.md`,
    });
    const result = await applyConcreteStageDocPaths(
      rulesWith(["docs/design/*_Develop_Commit.md"]),
      config,
      meta,
    );
    expect(result.requiredFiles).toEqual(["spec/design/222_Feat_Develop_Commit.md"]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps the authored glob when its directory matches neither the configured nor the default one", async () => {
    // 222 Phase 5 known regression: a template installed BEFORE the layout
    // change carries a third directory. The glob is preserved (no narrowing).
    const root = await makeProject([`${DESIGN_DIR}/222_Feat.md`]);
    const config = makeConfig({
      projectRoot: root,
      docsDirs: { designDir: DESIGN_DIR, reviewDir: REVIEW_DIR, jobsDir: "spec/jobs" },
    });
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: `${DESIGN_DIR}/222_Feat.md`,
    });
    const result = await applyConcreteStageDocPaths(
      rulesWith(["other/design/*_Develop_Commit.md"]),
      config,
      meta,
    );
    expect(result.requiredFiles).toEqual(["other/design/*_Develop_Commit.md"]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("narrows the plan glob to the concrete plan path via the mtime fallback", async () => {
    const root = await makeProject([`${DESIGN_DIR}/222_Feat_Plan.md`]);
    const config = makeConfig({
      projectRoot: root,
      docsDirs: { designDir: DESIGN_DIR, reviewDir: REVIEW_DIR, jobsDir: "spec/jobs" },
    });
    // No requirementDoc → resolvePlanDocPath falls back to the configured glob.
    const meta = makeTestMeta({ currentStage: "plan" });
    const result = await applyConcreteStageDocPaths(
      rulesWith([buildPlanDocGlob(DESIGN_DIR)]),
      config,
      meta,
    );
    // Guard: without requirementDoc the rules are returned untouched.
    expect(result.requiredFiles).toEqual([buildPlanDocGlob(DESIGN_DIR)]);

    const metaWithDoc = makeTestMeta({
      currentStage: "plan",
      requirementDoc: `${DESIGN_DIR}/222_Feat.md`,
    });
    const narrowed = await applyConcreteStageDocPaths(
      rulesWith([buildPlanDocGlob(DESIGN_DIR)]),
      config,
      metaWithDoc,
    );
    expect(narrowed.requiredFiles).toEqual(["spec/design/222_Feat_Plan.md"]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("leaves rules untouched for a stage without doc rules", async () => {
    const config = CONFIGURED;
    const meta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: `${DESIGN_DIR}/222_Feat.md`,
    });
    const authored = rulesWith([buildPlanDocGlob(DESIGN_DIR)]);
    expect(await applyConcreteStageDocPaths(authored, config, meta)).toEqual(authored);
  });
});