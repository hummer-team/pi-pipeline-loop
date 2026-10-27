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
 *
 * 213 Phase 2 (D15) additions:
 * - `resolveCurrentDocOption` truth table (rel/abs normalization, rule ① nulls).
 * - `listDocCandidates(..., currentDoc)`: pinned first row, stage-filter exemption,
 *   absolute-path dedupe, limit accounting, invalid-doc fallback, and the
 *   byte-identical behavior when `currentDoc` is absent.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listDocCandidates,
  findLatestDocForStage,
  resolveCurrentDocOption,
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

// ─── 213 Phase 2 (D15): the current requirement doc as a first-class candidate ─

describe("resolveCurrentDocOption (213 Phase 2 / D15)", () => {
  it("relative path inside the project → posix relPath + absolute absPath", async () => {
    const rel = await touch("docs/design/204_Bug_Plan.md", NOW);
    expect(await resolveCurrentDocOption(config, rel)).toEqual({
      relPath: "docs/design/204_Bug_Plan.md",
      absPath: path.join(ROOT, "docs/design/204_Bug_Plan.md"),
    });
  });

  it("absolute path inside the project → stored back as project-relative posix", async () => {
    await touch("docs/design/204_Bug_Plan.md", NOW);
    const got = await resolveCurrentDocOption(config, path.join(ROOT, "docs/design/204_Bug_Plan.md"));
    expect(got?.relPath).toBe("docs/design/204_Bug_Plan.md");
  });

  it("missing file / directory / blank / undefined → null (rule ①: invalid never lists)", async () => {
    expect(await resolveCurrentDocOption(config, "docs/design/ghost.md")).toBeNull();
    await fsp.mkdir(path.join(ROOT, "docs/design"), { recursive: true });
    expect(await resolveCurrentDocOption(config, "docs/design")).toBeNull();
    expect(await resolveCurrentDocOption(config, "   ")).toBeNull();
    expect(await resolveCurrentDocOption(config, undefined)).toBeNull();
  });
});

describe("listDocCandidates with currentDoc (213 Phase 2 / D15)", () => {
  it("pins the current doc FIRST and EXEMPT from the stage filter", async () => {
    // design-review candidates are *_Plan.md; a requirement doc does not match
    await touch("docs/design/14_Feat.md", NOW - 500);
    await touch("docs/design/13_Other_Plan.md", NOW);
    const result = await listDocCandidates(config, "design-review", 5, "docs/design/14_Feat.md");
    expect(result[0]!.relPath).toBe("docs/design/14_Feat.md");
    expect(result[0]!.isCurrent).toBe(true);
    expect(result[1]!.relPath).toBe("docs/design/13_Other_Plan.md");
    expect(result[1]!.isCurrent).toBeUndefined();
    expect(result).toHaveLength(2);
  });

  it("deduplicates by ABSOLUTE path — absolute + relative spellings yield one row", async () => {
    const rel = await touch("docs/design/204_Bug_Plan.md", NOW);
    await touch("docs/design/203_Old_Plan.md", NOW - 1000);
    const result = await listDocCandidates(config, "design-review", 5, path.join(ROOT, rel));
    // The pinned row displays project-relative posix; the discovered twin is gone.
    expect(result.map((c) => c.relPath)).toEqual([
      "docs/design/204_Bug_Plan.md",
      "docs/design/203_Old_Plan.md",
    ]);
    expect(result[0]!.isCurrent).toBe(true);
  });

  it("counts toward the limit: 1 pinned + at most limit-1 discovered", async () => {
    await touch("docs/design/14_Feat.md", NOW);
    for (let i = 1; i <= 6; i++) {
      await touch(`docs/design/${200 + i}_Plan.md`, NOW - i * 1000);
    }
    const result = await listDocCandidates(config, "design-review", 5, "docs/design/14_Feat.md");
    expect(result).toHaveLength(5);
    expect(result.map((c) => c.relPath)).toEqual([
      "docs/design/14_Feat.md",
      "docs/design/201_Plan.md",
      "docs/design/202_Plan.md",
      "docs/design/203_Plan.md",
      "docs/design/204_Plan.md",
    ]);
  });

  it("invalid currentDoc → no pinned row, discovered list unchanged (rule ①)", async () => {
    await touch("docs/design/204_Bug_Plan.md", NOW);
    const without = await listDocCandidates(config, "design-review");
    const withGhost = await listDocCandidates(config, "design-review", 5, "docs/design/ghost_Plan.md");
    expect(withGhost).toEqual(without);
    expect(withGhost.some((c) => c.isCurrent === true)).toBe(false);
  });

  it("explicit `undefined` currentDoc → the legacy path unchanged (incl. findLatestDocForStage)", async () => {
    await touch("docs/design/201_Old.md", NOW - 3000);
    await touch("docs/design/204_New.md", NOW);
    const legacy = await listDocCandidates(config, "clarify");
    const explicit = await listDocCandidates(config, "clarify", 5, undefined);
    expect(explicit).toEqual(legacy);
    // findLatestDocForStage never passes currentDoc → channel-1 rows carry no isCurrent.
    const latest = await findLatestDocForStage(config, "clarify");
    expect(latest?.relPath).toBe("docs/design/204_New.md");
    expect(latest?.isCurrent).toBeUndefined();
  });
});
