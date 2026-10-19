/**
 * 206 Phase 3: tests for the archive engine (scanner + runner pure logic
 * and edge cases).
 *
 * Coverage per plan:
 * - Strict `>` time boundary (exactly N days not included; N days + 1ms included).
 * - `history/` participates; non-.md files participate; recursed dirs.
 * - Active requirementDoc + same-base Plan/Commit/Design_Review/Code_Review excluded.
 * - Symlinks skipped.
 * - `resolveArchiveDestDir`: relative → `$HOME`, `~` expansion, absolute,
 *   `..` → fallback default.
 * - `buildArchiveZipName` / `formatArchiveTimestamp`: fixed date with the
 *   207 millisecond tail.
 * - 207 naming contract: `sanitizeArchiveName`, `buildArchiveZipPath`
 *   (deterministic) and the fail-closed `assertZipPathAvailable`.
 * - `createArchiveZip`: fake execFn asserts batched argv + failure-keeps-source;
 *   `probeZipAvailable` availability both ways.
 * - `deleteArchiveTargets`: deletes files + prunes empty dirs + preserves
 *   scope roots + single-file failure does not abort the rest.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
import { resolveArchiveScope, collectArchiveTargets, isActivePipelineDoc } from "../../core/archive/scanner";
import {
  formatArchiveTimestamp,
  buildArchiveZipName,
  sanitizeArchiveName,
  buildArchiveZipPath,
  assertZipPathAvailable,
  resolveArchiveDestDir,
  probeZipAvailable,
  createArchiveZip,
  deleteArchiveTargets,
} from "../../core/archive/runner";
import { makeTestConfig } from "../helpers";

let ROOT: string;

beforeEach(() => {
  ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-archive-"));
});

afterEach(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
});

/** Writes a file and forces its mtime. */
async function touch(rel: string, mtimeMs: number, content = "x"): Promise<string> {
  const abs = path.join(ROOT, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf-8");
  await fsp.utimes(abs, new Date(mtimeMs), new Date(mtimeMs));
  return abs;
}

const NOW = 1_800_000_000_000; // fixed "now"
const DAY = 86_400_000;

function defaultConfig(): PipelineConfig {
  return makeTestConfig({
    projectRoot: ROOT,
    archiveDirs: ["docs/design", "docs/review"],
    auditDir: ".pi/audit",
  });
}

describe("resolveArchiveScope (206 Phase 3)", () => {
  it("merges archiveDirs with the constant .pi/audit and dedupes", async () => {
    await fsp.mkdir(path.join(ROOT, "docs/design"), { recursive: true });
    await fsp.mkdir(path.join(ROOT, ".pi/audit"), { recursive: true });
    const config = makeTestConfig({
      projectRoot: ROOT,
      archiveDirs: ["docs/design", "docs/design", ".pi/audit"],
      auditDir: ".pi/audit",
    });
    const { scopes, missingDirs } = await resolveArchiveScope(config);
    expect(scopes.map((s) => s.relDir)).toEqual(["docs/design", ".pi/audit"]);
    expect(missingDirs).toEqual([]);
  });

  it("reports missing directories without throwing", async () => {
    await fsp.mkdir(path.join(ROOT, ".pi/audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: ROOT, archiveDirs: ["docs/missing"] });
    const { scopes, missingDirs } = await resolveArchiveScope(config);
    // Constant .pi/audit still resolves; only the configured dir is missing
    expect(scopes.map((s) => s.relDir)).toEqual([".pi/audit"]);
    expect(missingDirs).toEqual(["docs/missing"]);
  });
});

describe("collectArchiveTargets (206 Phase 3)", () => {
  it("strict > boundary: exactly N days excluded, N days + 1ms included", async () => {
    await fsp.mkdir(path.join(ROOT, ".pi/audit"), { recursive: true });
    await touch("docs/design/APrecise.md", NOW - 7 * DAY); // exactly 7d → excluded
    await touch("docs/design/BPrecise.md", NOW - (7 * DAY + 1)); // 7d+1ms → included

    const result = await collectArchiveTargets(defaultConfig(), 7, undefined, NOW);
    expect(result.targets.map((t) => path.basename(t.relPath))).toEqual(["BPrecise.md"]);
  });

  it("recursive scan includes all file types and history/ (no exclusions)", async () => {
    await touch("docs/design/201_Feat.md", NOW - 20 * DAY);
    await touch("docs/design/history/198_Old.md", NOW - 25 * DAY);
    await touch("docs/design/notes.txt", NOW - 30 * DAY);
    await touch(".pi/audit/20260901_audit.log", NOW - 15 * DAY);

    const result = await collectArchiveTargets(defaultConfig(), 7, undefined, NOW);
    const names = result.targets.map((t) => path.basename(t.relPath)).sort();
    expect(names).toEqual([
      "198_Old.md",
      "201_Feat.md",
      "20260901_audit.log",
      "notes.txt",
    ]);
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  it("active requirementDoc and same-base derivatives are protected", async () => {
    const base = NOW - 30 * DAY;
    await touch("docs/design/204_Bug.md", base);
    await touch("docs/design/204_Bug_Plan.md", base);
    await touch("docs/design/204_Bug_Develop_Commit.md", base);
    await touch("docs/design/Design_Review_2_204_Bug_Design.md", base);
    await touch("docs/review/Code_Review_204_Bug_Develop_Commit_3.md", base);
    await touch("docs/design/205_Free.md", base); // unrelated → collected

    const result = await collectArchiveTargets(defaultConfig(), 7, "docs/design/204_Bug.md", NOW);
    await fsp.mkdir(path.join(ROOT, ".pi/audit"), { recursive: true });
    const names = result.targets.map((t) => path.basename(t.relPath)).sort();
    expect(names).toEqual(["205_Free.md"]);
    expect(result.skippedActive).toBe(5);
  });

  it("symlinks are skipped defensively", async () => {
    const real = await touch("docs/design/201_Real.md", NOW - 20 * DAY);
    await fsp.mkdir(path.join(ROOT, "docs/design"), { recursive: true });
    try {
      await fsp.symlink(real, path.join(ROOT, "docs/design/201_Link.md"));
    } catch {
      // Symlink unsupported in this environment → skip assertion safely
      return;
    }
    const result = await collectArchiveTargets(defaultConfig(), 7, undefined, NOW);
    expect(result.targets).toHaveLength(1); // only the real file, not the link
  });
});

describe("isActivePipelineDoc (206 Phase 3)", () => {
  it("matches requirement doc and same-base derivatives", () => {
    expect(isActivePipelineDoc("docs/design/204_Bug.md", "docs/design/204_Bug.md")).toBe(true);
    expect(isActivePipelineDoc("docs/design/204_Bug_Plan.md", "docs/design/204_Bug.md")).toBe(true);
    expect(isActivePipelineDoc("docs/design/204_Bug_Develop_Commit.md", "docs/design/204_Bug.md")).toBe(true);
    expect(isActivePipelineDoc("docs/design/Design_Review_1_204_Bug_Design.md", "docs/design/204_Bug.md")).toBe(true);
    expect(isActivePipelineDoc("docs/review/Code_Review_204_Bug_Develop_Commit_9.md", "docs/design/204_Bug.md")).toBe(true);
  });

  it("does not match unrelated docs or different bases", () => {
    expect(isActivePipelineDoc("docs/design/205_Other.md", "docs/design/204_Bug.md")).toBe(false);
    expect(isActivePipelineDoc("docs/design/2042_Bug_Plan.md", "docs/design/204_Bug.md")).toBe(false);
  });

  it("empty activeDoc → never active", () => {
    expect(isActivePipelineDoc("docs/design/204_Bug.md", undefined)).toBe(false);
    expect(isActivePipelineDoc("docs/design/204_Bug.md", "")).toBe(false);
  });
});

describe("resolveArchiveDestDir / archive naming contract (206 Phase 3 + 207 Phase 1)", () => {
  it("relative dest resolves under the user home", () => {
    const dest = resolveArchiveDestDir("pi-pipeline-archive");
    expect(dest.absDir).toBe(path.join(os.homedir(), "pi-pipeline-archive"));
    expect(dest.relDisplay).toBe(path.join(os.homedir(), "pi-pipeline-archive"));
  });

  it("~ dest is expanded; absolute dest kept as-is", () => {
    expect(resolveArchiveDestDir("~/my-archives").absDir).toBe(path.join(os.homedir(), "my-archives"));
    const abs = path.join(ROOT, "abs-dest");
    expect(resolveArchiveDestDir(abs).absDir).toBe(abs);
  });

  it("empty or .. destination falls back to the default", () => {
    expect(resolveArchiveDestDir("").absDir).toBe(path.join(os.homedir(), "pi-pipeline-archive"));
    expect(resolveArchiveDestDir(undefined).absDir).toBe(path.join(os.homedir(), "pi-pipeline-archive"));
    expect(resolveArchiveDestDir("../escape").absDir).toBe(path.join(os.homedir(), "pi-pipeline-archive"));
  });

  it("formatArchiveTimestamp pads the millisecond tail to 3 digits", () => {
    const d = new Date(2026, 9, 19, 14, 25, 7, 420); // Oct 19 2026 14:25:07.420
    expect(formatArchiveTimestamp(d)).toBe("2026_10_19_142507420");
    // millisecond boundaries: 0 / 7 / 999 all pad to 3 digits
    expect(formatArchiveTimestamp(new Date(2026, 0, 2, 3, 4, 5, 0))).toBe("2026_01_02_030405000");
    expect(formatArchiveTimestamp(new Date(2026, 0, 2, 3, 4, 5, 7))).toBe("2026_01_02_030405007");
    expect(formatArchiveTimestamp(new Date(2026, 0, 2, 3, 4, 5, 999))).toBe("2026_01_02_030405999");
  });

  it("buildArchiveZipName: no suffix keeps legacy shape; suffix is appended", () => {
    const d = new Date(2026, 9, 19, 14, 25, 7, 420);
    expect(buildArchiveZipName(d)).toBe("2026_10_19_142507420_pipeline");
    expect(buildArchiveZipName(d, "pi-pipeline-loop")).toBe(
      "2026_10_19_142507420_pipeline_pi-pipeline-loop",
    );
  });

  it("sanitizeArchiveName: whitespace/separators/reserved chars → single dash", () => {
    expect(sanitizeArchiveName("my project")).toBe("my-project");
    expect(sanitizeArchiveName("a/b\\c:d")).toBe("a-b-c-d");
    expect(sanitizeArchiveName("a?b*c")).toBe("a-b-c");
    expect(sanitizeArchiveName("a  --  b")).toBe("a-b");
    // leading/trailing `.`/`-` stripped (double-pass: replace exposes new edges)
    expect(sanitizeArchiveName("-.my-project.-")).toBe("my-project");
    expect(sanitizeArchiveName(". / . .")).toBe("");
    // Unicode preserved
    expect(sanitizeArchiveName("我的 项目")).toBe("我的-项目");
    expect(sanitizeArchiveName("Über-Projekt 🚀")).toBe("Über-Projekt-🚀");
  });

  it("sanitizeArchiveName caps at 64 code points and blocks traversal", () => {
    expect(Array.from(sanitizeArchiveName("a".repeat(70))).length).toBe(64);
    // path traversal: `../evil` → separators/space replaced, edges stripped
    expect(sanitizeArchiveName("../evil")).toBe("evil");
    expect(sanitizeArchiveName("..\\..\\evil")).toBe("evil");
    // pure separators / empty become empty (no suffix)
    expect(sanitizeArchiveName("///")).toBe("");
    expect(sanitizeArchiveName(".")).toBe("");
    expect(sanitizeArchiveName("")).toBe("");
  });

  it("buildArchiveZipPath builds the deterministic absolute path", () => {
    const d = new Date(2026, 9, 19, 14, 25, 7, 420);
    expect(buildArchiveZipPath(ROOT, undefined, d)).toBe(
      path.join(ROOT, "2026_10_19_142507420_pipeline.zip"),
    );
    expect(buildArchiveZipPath(ROOT, "pi-pipeline-loop", d)).toBe(
      path.join(ROOT, "2026_10_19_142507420_pipeline_pi-pipeline-loop.zip"),
    );
  });

  it("assertZipPathAvailable resolves when absent, rejects existing file/dir", async () => {
    await fsp.mkdir(ROOT, { recursive: true });
    const missing = path.join(ROOT, "missing.zip");
    await expect(assertZipPathAvailable(missing)).resolves.toBeUndefined();

    // Broken symlink follows `stat` semantics → ENOENT branch → resolves
    const target = path.join(ROOT, "gone.txt");
    await fsp.writeFile(target, "z");
    const link = path.join(ROOT, "dangling.zip");
    await fsp.symlink(target, link);
    await fsp.rm(target);
    await expect(assertZipPathAvailable(link)).resolves.toBeUndefined();

    // Existing file → fail-closed
    const existing = path.join(ROOT, "taken.zip");
    await fsp.writeFile(existing, "z");
    await expect(assertZipPathAvailable(existing)).rejects.toThrow(/already exists/);

    // Existing directory → also fail-closed
    const dir = path.join(ROOT, "adir.zip");
    await fsp.mkdir(dir);
    await expect(assertZipPathAvailable(dir)).rejects.toThrow(/already exists/);
  });

  it("assertZipPathAvailable rejects non-ENOENT stat errors (ENOTDIR via file-parent)", async () => {
    await fsp.mkdir(ROOT, { recursive: true });
    const file = path.join(ROOT, "plainfile");
    await fsp.writeFile(file, "z");
    // path under a regular file → ENOTDIR, must be rethrown (not swallowed)
    const underFile = path.join(file, "nested.zip");
    await expect(assertZipPathAvailable(underFile)).rejects.toThrow();
  });
});

describe("probeZipAvailable / createArchiveZip (206 Phase 3)", () => {
  const fakeExec = (responses: Array<{ stdout: string; stderr: string; code: number }>) => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    let i = 0;
    const fn = async (cmd: string, args: string[], cwd: string) => {
      calls.push({ cmd, args, cwd });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    };
    return { fn, calls };
  };

  it("probeZipAvailable: false without execFn, true on code 0, false on exception", async () => {
    expect(await probeZipAvailable(undefined)).toBe(false);
    const ok = fakeExec([{ stdout: "", stderr: "", code: 0 }]);
    expect(await probeZipAvailable(ok.fn as never)).toBe(true);
    const bad = fakeExec([{ stdout: "", stderr: "", code: 127 }]);
    expect(await probeZipAvailable(bad.fn as never)).toBe(false);
    const throwing = async () => {
      throw new Error("spawn ENOENT");
    };
    expect(await probeZipAvailable(throwing as never)).toBe(false);
  });

  it("createArchiveZip batches argv under MAX_ARG_CHARS and succeeds", async () => {
    await fsp.mkdir(ROOT, { recursive: true });
    const zipStub = path.join(ROOT, "fake.zip");
    await fsp.writeFile(zipStub, "PK\x05\x06"); // pre-seed non-empty archive shell
    const runner = fakeExec([
      { stdout: "", stderr: "", code: 0 },
      { stdout: "", stderr: "", code: 0 },
    ]);
    const config = defaultConfig();
    const targets = [
      { relPath: "docs/design/a.md" },
      { relPath: "docs/design/b.md" },
      { relPath: "docs/design/c.md" },
    ];
    const result = await createArchiveZip(runner.fn as never, config, zipStub, targets);
    expect(result.ok).toBe(true);
    // Single batch expected for small targets
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args.slice(0, 3)).toEqual(["-q", "-X", zipStub]);
    expect(runner.calls[0].args.slice(3)).toEqual(["docs/design/a.md", "docs/design/b.md", "docs/design/c.md"]);
    expect(runner.calls[0].cwd).toBe(config.projectRoot);
  });

  it("createArchiveZip failure batch → ok:false with error (never deletes source)", async () => {
    const runner = fakeExec([
      { stdout: "", stderr: "zip error: nothing to do", code: 12 },
    ]);
    const zipStub = path.join(ROOT, "stub.zip");
    await fsp.writeFile(zipStub, "zip");
    const result = await createArchiveZip(runner.fn as never, defaultConfig(), zipStub, [
      { relPath: "docs/design/a.md" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(12);
    expect(result.error).toContain("zip error");
    // Source untouched (only ran zip; deletion is a separate explicit step)
    expect(fsSync.existsSync(zipStub)).toBe(true);
  });

  it("createArchiveZip without execFn → ok:false zip exec unavailable", async () => {
    const result = await createArchiveZip(undefined, defaultConfig(), "/tmp/x.zip", [
      { relPath: "a.md" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("zip exec unavailable");
  });

  it("createArchiveZip with empty targets → ok:false no targets", async () => {
    const runner = fakeExec([{ stdout: "", stderr: "", code: 0 }]);
    const result = await createArchiveZip(runner.fn as never, defaultConfig(), "/tmp/y.zip", []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no targets");
    expect(runner.calls).toHaveLength(0);
  });
});

describe("deleteArchiveTargets (206 Phase 3)", () => {
  it("deletes files, prunes empty dirs, preserves scope roots, keeps failures non-fatal", async () => {
    // Nested dir chain under a scope root + a protected audit file + a locked file
    const a = await touch("docs/design/nested/deep/201_Old.md", NOW - 20 * DAY);
    const b = await touch("docs/design/202_Old.md", NOW - 20 * DAY);
    const auditFile = await touch(".pi/audit/pipe-old/log/20260901_audit.log", NOW - 20 * DAY);
    const docsDesignRoot = path.join(ROOT, "docs/design");

    const result = await deleteArchiveTargets(
      defaultConfig(),
      [{ absPath: a }, { absPath: b }, { absPath: auditFile }],
      [docsDesignRoot, path.join(ROOT, ".pi/audit")],
    );
    expect(result.errors).toEqual([]);
    expect(result.deleted).toBe(3);
    // nested/deep pruned; scope root docs/design survives (b removed but dir stays)
    expect(fsSync.existsSync(path.join(ROOT, "docs/design/nested/deep"))).toBe(false);
    expect(fsSync.existsSync(path.join(ROOT, "docs/design"))).toBe(true);
    // audit pipe-old/log content root survives
    expect(fsSync.existsSync(path.join(ROOT, ".pi/audit"))).toBe(true);
  });

  it("records a per-file failure and continues with the remaining deletions", async () => {
    const keep = await touch("docs/design/201_Keep.md", NOW - 20 * DAY);
    const gone = await touch("docs/design/202_Vanish.md", NOW - 20 * DAY);
    await fsp.rm(gone); // disappear before delete → rm fails
    const result = await deleteArchiveTargets(
      defaultConfig(),
      [{ absPath: gone }, { absPath: keep }],
      [path.join(ROOT, "docs/design")],
    );
    expect(result.deleted).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(fsSync.existsSync(keep)).toBe(false);
  });
});
