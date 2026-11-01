/**
 * 220 Phase 1 (D5): the per-start-stage evidence matrix.
 *
 * Scope (Y3): ONLY the pure evidence judgement. Runner wiring (onFailure /
 * docIndex / audit) is covered by `start-stage-runner.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PipelineConfig } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";
import {
  checkStartStageEvidence,
  derivePlanDocPath,
} from "../../core/auto-pipeline/start-stage-evidence";

const REQUIREMENT = "docs/design/200_Feat.md";

let root: string;
let config: PipelineConfig;

async function write(relPath: string, content = "content"): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

describe("derivePlanDocPath", () => {
  it("derives the sibling plan document", () => {
    expect(derivePlanDocPath("docs/design/200_Feat.md")).toBe("docs/design/200_Feat_Plan.md");
  });

  it("never duplicates the _Plan suffix", () => {
    expect(derivePlanDocPath("docs/design/200_Feat_Plan.md")).toBe("docs/design/200_Feat_Plan.md");
  });
});

describe("checkStartStageEvidence", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-start-stage-"));
    config = makeTestConfig({ projectRoot: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clarify / plan need the requirement document", async () => {
    const meta = makeTestMeta({ requirementDoc: REQUIREMENT });
    expect(await checkStartStageEvidence({ config, meta, startStage: "clarify", projectRoot: root })).toEqual({
      ok: false,
      missing: "requirement",
    });
    await write(REQUIREMENT);
    expect(await checkStartStageEvidence({ config, meta, startStage: "clarify", projectRoot: root })).toEqual({
      ok: true,
      basis: "requirement",
    });
    expect(await checkStartStageEvidence({ config, meta, startStage: "plan", projectRoot: root })).toEqual({
      ok: true,
      basis: "requirement",
    });
  });

  it("design-review needs the derived plan only", async () => {
    await write(REQUIREMENT);
    const meta = makeTestMeta({ requirementDoc: REQUIREMENT });
    expect(
      await checkStartStageEvidence({ config, meta, startStage: "design-review", projectRoot: root }),
    ).toEqual({ ok: false, missing: "plan" });
    await write("docs/design/200_Feat_Plan.md");
    expect(
      await checkStartStageEvidence({ config, meta, startStage: "design-review", projectRoot: root }),
    ).toEqual({ ok: true, basis: "plan" });
  });

  it("develop needs the plan AND its confirmation marker", async () => {
    const meta = makeTestMeta({ requirementDoc: REQUIREMENT });
    await write("docs/design/200_Feat_Plan.md", "## 目的\nno marker");
    expect(await checkStartStageEvidence({ config, meta, startStage: "develop", projectRoot: root })).toEqual({
      ok: false,
      missing: "plan-confirmed",
    });
    await write("docs/design/200_Feat_Plan.md", "## 目的\n## User Confirmation\nok");
    expect(await checkStartStageEvidence({ config, meta, startStage: "develop", projectRoot: root })).toEqual({
      ok: true,
      basis: "plan-confirmed",
    });
  });

  it("review needs the commit document", async () => {
    const meta = makeTestMeta({ requirementDoc: REQUIREMENT });
    expect(await checkStartStageEvidence({ config, meta, startStage: "review", projectRoot: root })).toEqual({
      ok: false,
      missing: "commit",
    });
    await write("docs/design/200_Feat_Develop_Commit.md");
    expect(await checkStartStageEvidence({ config, meta, startStage: "review", projectRoot: root })).toEqual({
      ok: true,
      basis: "commit",
    });
  });

  it("fix needs a review report with a fixable verdict", async () => {
    const meta = makeTestMeta({ requirementDoc: REQUIREMENT });
    expect(await checkStartStageEvidence({ config, meta, startStage: "fix", projectRoot: root })).toEqual({
      ok: false,
      missing: "review-verdict",
    });
    await write("docs/review/Code_Review_200_Feat_Develop_Commit_1.md", "Verdict: PASS\nall good");
    expect(await checkStartStageEvidence({ config, meta, startStage: "fix", projectRoot: root })).toEqual({
      ok: false,
      missing: "review-verdict",
    });
    await write("docs/review/Code_Review_200_Feat_Develop_Commit_2.md", "## To-Fix\n- one issue");
    expect(await checkStartStageEvidence({ config, meta, startStage: "fix", projectRoot: root })).toEqual({
      ok: true,
      basis: "review-report",
    });
  });

  it("fix reads the LATEST report and never another document's report", async () => {
    await write("docs/review/Code_Review_200_Feat_Develop_Commit_1.md", "## To-Fix\n- old");
    await write("docs/review/Code_Review_999_Other_Develop_Commit_9.md", "## To-Fix\n- other doc");
    const meta = makeTestMeta({ requirementDoc: REQUIREMENT });
    // Only the own-document report counts even though another doc's report exists.
    expect(await checkStartStageEvidence({ config, meta, startStage: "fix", projectRoot: root })).toEqual({
      ok: true,
      basis: "review-report",
    });
  });

  it("unbound requirement document → missing requirement", async () => {
    const meta = makeTestMeta();
    expect(
      await checkStartStageEvidence({ config, meta, startStage: "design-review", projectRoot: root }),
    ).toEqual({ ok: false, missing: "requirement" });
  });

  it("uses the file system only (no glob helper import)", async () => {
    const source = await readFile(
      join(process.cwd(), "src/core/auto-pipeline/start-stage-evidence.ts"),
      "utf8",
    );
    expect(source.includes("globMatchFiles")).toBe(false);
    expect(source.includes("resolvePlanDocPath")).toBe(false);
  });

  it("is read-only: no file is created or modified", async () => {
    await write(REQUIREMENT);
    const before = await fs.readdir(join(root, "docs", "design"));
    await checkStartStageEvidence({
      config,
      meta: makeTestMeta({ requirementDoc: REQUIREMENT }),
      startStage: "design-review",
      projectRoot: root,
    });
    expect(await fs.readdir(join(root, "docs", "design"))).toEqual(before);
  });
});
