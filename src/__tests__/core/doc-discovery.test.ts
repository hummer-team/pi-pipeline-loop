/**
 * 206 Phase 1: tests for the shared stage-doc directory resolver and
 * candidate discovery module (doc-discovery.ts).
 *
 * Coverage per plan:
 * - Per-stage filter rules (positive/negative) incl. `206_Feat.md`,
 *   `204_Bug_Plan.md`, `Code_Review_*.md`.
 * - Candidate count cap = 5 and mtime-descending order.
 * - Missing directory → []; `history/` subdirectory files never selected.
 * - Edge cases: empty dir, only subdirs, non-.md files, `.MD` tolerance,
 *   docsStageDirs override vs auto-match fallback, archiveDirs fallback hit/miss.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listDocCandidates,
  findLatestDocForStage,
  resolveStageDocDir,
  stageDocCandidateFilter,
} from "../../core/doc-discovery";
import { makeTestConfig } from "../helpers";
import type { PipelineConfig } from "../../types";

let ROOT: string;
let config: PipelineConfig;

beforeEach(() => {
  ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-doc-disc-"));
  config = makeTestConfig({ projectRoot: ROOT });
});

afterEach(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

async function touch(rel: string, mtimeMs: number, content = "x"): Promise<string> {
  const abs = path.join(ROOT, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf-8");
  await fsp.utimes(abs, new Date(mtimeMs), new Date(mtimeMs));
  return rel;
}

/** Fixed mtimes: file A newest, B middle, C oldest. */
const NOW = Date.now();

describe("resolveStageDocDir", () => {
  it("uses explicit docsStageDirs when configured", () => {
    const cfg = makeTestConfig({
      projectRoot: ROOT,
      docsStageDirs: { clarify: "custom/docs" },
    });
    expect(resolveStageDocDir(cfg, "clarify")).toEqual({ dir: "custom/docs", autoMatched: false });
  });

  it("falls back to built-in defaults with autoMatched=true", () => {
    expect(resolveStageDocDir(config, "clarify")).toEqual({ dir: "docs/design", autoMatched: true });
    expect(resolveStageDocDir(config, "fix")).toEqual({ dir: "docs/review", autoMatched: true });
    expect(resolveStageDocDir(config, "develop")).toEqual({ dir: "docs/design", autoMatched: true });
  });
});

describe("stageDocCandidateFilter", () => {
  it("clarify/plan accept numbered requirement docs and exclude _Plan/Code_Review", () => {
    const f = stageDocCandidateFilter("clarify");
    expect(f("206_Feat.md")).toBe(true);
    expect(f("206_Feat.MD")).toBe(true);
    expect(f("206_Feat_Plan.md")).toBe(false);
    expect(f("Code_Review_206_Feat_Develop_Commit_1.md")).toBe(false);
    expect(f("notes.md")).toBe(false);
    expect(f("README.txt")).toBe(false);
  });

  it("204_Bug_Plan.md misses for clarify but hits for design-review/develop", () => {
    expect(stageDocCandidateFilter("clarify")("204_Bug_Plan.md")).toBe(false);
    expect(stageDocCandidateFilter("plan")("204_Bug_Plan.md")).toBe(false);
    expect(stageDocCandidateFilter("design-review")("204_Bug_Plan.md")).toBe(true);
    expect(stageDocCandidateFilter("develop")("204_Bug_Plan.md")).toBe(true);
  });

  it("review accepts *_Develop_Commit.md only", () => {
    const f = stageDocCandidateFilter("review");
    expect(f("204_Bug_Develop_Commit.md")).toBe(true);
    expect(f("204_Bug_Plan.md")).toBe(false);
    expect(f("Code_Review_204_Bug_Develop_Commit_1.md")).toBe(false);
  });

  it("fix accepts Code_Review_*_Develop_Commit_N.md only", () => {
    const f = stageDocCandidateFilter("fix");
    expect(f("Code_Review_204_Bug_Develop_Commit_1.md")).toBe(true);
    expect(f("204_Bug.md")).toBe(false);
    expect(f("204_Bug_Plan.md")).toBe(false);
  });

  it("other stages always return false", () => {
    expect(stageDocCandidateFilter("awaiting_human")("anything.md")).toBe(false);
    expect(stageDocCandidateFilter("completed")("206_Feat.md")).toBe(false);
  });
});

describe("listDocCandidates", () => {
  it("returns newest-first candidates from the stage dir", async () => {
    await touch("docs/design/201_Old.md", NOW - 3000);
    await touch("docs/design/203_Mid.md", NOW - 1000);
    await touch("docs/design/204_New.md", NOW);

    const result = await listDocCandidates(config, "clarify");
    expect(result.map((c) => c.relPath)).toEqual([
      "docs/design/204_New.md",
      "docs/design/203_Mid.md",
      "docs/design/201_Old.md",
    ]);
  });

  it("caps candidates at 5", async () => {
    for (let i = 1; i <= 8; i++) {
      await touch(`docs/design/${100 + i}_Doc.md`, NOW - i * 1000);
    }
    const result = await listDocCandidates(config, "clarify");
    expect(result).toHaveLength(5);
    // Newest kept
    expect(result[0].relPath).toBe("docs/design/101_Doc.md");
  });

  it("empty dir → []", async () => {
    await fsp.mkdir(path.join(ROOT, "docs/design"), { recursive: true });
    expect(await listDocCandidates(config, "clarify")).toEqual([]);
  });

  it("missing dir → []", async () => {
    expect(await listDocCandidates(config, "clarify")).toEqual([]);
  });

  it("non-.md files and subdirectories (history/) are excluded", async () => {
    await touch("docs/design/204_Feat.md", NOW);
    await touch("docs/design/notes.txt", NOW);
    await touch("docs/design/history/200_Old.md", NOW + 1000);

    const result = await listDocCandidates(config, "clarify");
    expect(result).toHaveLength(1);
    expect(result[0].relPath).toBe("docs/design/204_Feat.md");
  });

  it("respects explicit docsStageDirs override", async () => {
    await touch("custom/docs/300_X.md", NOW);
    await touch("docs/design/301_Y.md", NOW);
    const cfg = makeTestConfig({
      projectRoot: ROOT,
      docsStageDirs: { clarify: "custom/docs" },
    });
    const result = await listDocCandidates(cfg, "clarify");
    expect(result.map((c) => c.relPath)).toEqual(["custom/docs/300_X.md"]);
  });
});

describe("findLatestDocForStage", () => {
  it("channel 1: newest candidate in stage dir", async () => {
    await touch("docs/design/203_Mid.md", NOW - 1000);
    await touch("docs/design/204_New.md", NOW);
    const latest = await findLatestDocForStage(config, "clarify");
    expect(latest?.relPath).toBe("docs/design/204_New.md");
  });

  it("channel 2: fallback across archiveDirs finds newest match", async () => {
    // Stage dir absent entirely
    await fsp.mkdir(path.join(ROOT, "docs/design"), { recursive: true });
    await touch("docs/elsewhere/202_Found.md", NOW - 5000);
    const cfg = makeTestConfig({ projectRoot: ROOT, archiveDirs: ["docs/elsewhere", "docs/other"] });
    const latest = await findLatestDocForStage(cfg, "clarify");
    expect(latest?.relPath).toBe("docs/elsewhere/202_Found.md");
  });

  it("channel 2 recurses into subdirectories and picks newest across scopes", async () => {
    await touch("docs/design/history/198_A.md", NOW - 9000);
    await touch("docs/review/deep/199_B.md", NOW - 2000);
    const cfg = makeTestConfig({ projectRoot: ROOT, archiveDirs: ["docs/design", "docs/review"] });
    const latest = await findLatestDocForStage(cfg, "clarify");
    expect(latest?.relPath).toBe("docs/review/deep/199_B.md");
  });

  it("no candidates anywhere → null", async () => {
    const cfg = makeTestConfig({ projectRoot: ROOT });
    expect(await findLatestDocForStage(cfg, "clarify")).toBeNull();
  });

  it("fix stage fallback picks newest Code_Review report from archiveDirs", async () => {
    // fix stage dir = docs/review (leave it empty); fallback scans archiveDirs
    await touch("docs/other/Code_Review_204_Bug_Develop_Commit_1.md", NOW - 4000);
    await touch("docs/design/Code_Review_204_Bug_Develop_Commit_2.md", NOW - 1000);
    const cfg = makeTestConfig({ projectRoot: ROOT, archiveDirs: ["docs/design", "docs/other"] });
    const latest = await findLatestDocForStage(cfg, "fix");
    expect(latest?.relPath).toBe("docs/design/Code_Review_204_Bug_Develop_Commit_2.md");
  });
});
