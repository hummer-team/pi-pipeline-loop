/**
 * 223 Phase 3: `*_loop.yml` is a first-class auto-job file.
 *
 * Contract:
 * - `.yaml` and `.yml` are peers; `jobId` stays the FULL stem in both cases, so
 *   the sidecar directory (`.pi/auto_pipeline/{jobId}/`) is shared;
 * - `resolveTrackedJobFile` order: `<jobsDir>/<jobId>.yaml` → `<jobsDir>/<jobId>.yml`
 *   → persisted `state.jobPath` → configured `.yaml` fallback;
 * - `findJobFileCandidates` reports what actually exists (the ambiguity audit
 *   input) without changing the resolver signature;
 * - `--job` tolerates a trailing `.yaml`/`.yml` but still rejects path-like
 *   arguments (the extension is stripped BEFORE `isValidJobId`).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  findJobFileCandidates,
  resolveTrackedJobFile,
  stripJobFileExtension,
} from "../../core/auto-pipeline/job-state";
import { scanJobFiles } from "../../commands/pipeline-auto-menu";

const JOB_ID = "alpha_loop";
const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "tier: rule",
  "docs:",
  "  list:",
  "    - doc: docs/design/200_Feat.md",
].join("\n");

let ROOT: string;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-223-suffix-"));
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Write `<relDir>/<JOB_ID><ext>` and return the absolute path. */
function writeJob(relDir: string, ext: ".yaml" | ".yml"): string {
  const abs = path.join(ROOT, relDir);
  fs.mkdirSync(abs, { recursive: true });
  const jobPath = path.join(abs, `${JOB_ID}${ext}`);
  fs.writeFileSync(jobPath, JOB_YAML, "utf8");
  return jobPath;
}

describe("resolveTrackedJobFile — .yaml / .yml are peers", () => {
  it("1. prefers the configured .yaml", () => {
    const yamlPath = writeJob("spec/jobs", ".yaml");
    writeJob("spec/jobs", ".yml");
    expect(resolveTrackedJobFile(ROOT, "spec/jobs", JOB_ID)).toBe(yamlPath);
  });

  it("2. falls back to the configured .yml when .yaml is absent", () => {
    const ymlPath = writeJob("spec/jobs", ".yml");
    expect(resolveTrackedJobFile(ROOT, "spec/jobs", JOB_ID)).toBe(ymlPath);
  });

  it("3. falls back to the persisted jobPath when neither suffix exists in jobsDir", () => {
    const persisted = writeJob("docs/jobs", ".yml");
    expect(resolveTrackedJobFile(ROOT, "spec/jobs", JOB_ID, "docs/jobs/alpha_loop.yml")).toBe(persisted);
  });

  it("4. returns the configured .yaml path when nothing exists (readable failure path)", () => {
    const expected = path.join(ROOT, "spec/jobs", `${JOB_ID}.yaml`);
    expect(resolveTrackedJobFile(ROOT, "spec/jobs", JOB_ID)).toBe(expected);
  });

  it("honours an ABSOLUTE jobsDir", () => {
    const absDir = path.join(ROOT, "elsewhere", "jobs");
    fs.mkdirSync(absDir, { recursive: true });
    const ymlPath = path.join(absDir, `${JOB_ID}.yml`);
    fs.writeFileSync(ymlPath, JOB_YAML, "utf8");
    expect(resolveTrackedJobFile(ROOT, absDir, JOB_ID)).toBe(ymlPath);
  });
});

describe("findJobFileCandidates", () => {
  it("returns both candidates in .yaml-then-.yml order when both exist", () => {
    const yamlPath = writeJob("spec/jobs", ".yaml");
    const ymlPath = writeJob("spec/jobs", ".yml");
    expect(findJobFileCandidates(ROOT, "spec/jobs", JOB_ID)).toEqual([yamlPath, ymlPath]);
  });

  it("returns a single candidate when only one suffix exists", () => {
    const ymlPath = writeJob("spec/jobs", ".yml");
    expect(findJobFileCandidates(ROOT, "spec/jobs", JOB_ID)).toEqual([ymlPath]);
  });

  it("returns an empty list for a missing directory (never throws)", () => {
    expect(findJobFileCandidates(ROOT, "spec/jobs", JOB_ID)).toEqual([]);
  });
});

describe("--job suffix normalization", () => {
  it("strips a trailing .yaml or .yml and leaves a bare stem untouched", () => {
    expect(stripJobFileExtension("alpha_loop.yaml")).toBe("alpha_loop");
    expect(stripJobFileExtension("alpha_loop.yml")).toBe("alpha_loop");
    expect(stripJobFileExtension("alpha_loop")).toBe("alpha_loop");
  });

  it("is case-sensitive: .YAML / .YML are NOT treated as extensions", () => {
    expect(stripJobFileExtension("alpha_loop.YAML")).toBe("alpha_loop.YAML");
    expect(stripJobFileExtension("alpha_loop.YML")).toBe("alpha_loop.YML");
  });

  it("leaves a path-like argument intact so the caller still rejects it", () => {
    // `.yaml` is stripped, but the remaining `docs/alpha_loop` is not a job id.
    expect(stripJobFileExtension("docs/alpha_loop.yaml")).toBe("docs/alpha_loop");
  });
});

describe("scanJobFiles — suffix ambiguity", () => {
  it("keeps one row per stem and flags the duplicate suffix", () => {
    writeJob("docs/jobs", ".yaml");
    writeJob("docs/jobs", ".yml");
    const rows = scanJobFiles(ROOT).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobId).toBe(JOB_ID);
    expect(rows[0]?.fileName).toBe(`${JOB_ID}.yaml`);
    expect(rows[0]?.suffixAmbiguous).toBe(true);
  });

  it("does not flag a lone .yml row", () => {
    writeJob("docs/jobs", ".yml");
    const rows = scanJobFiles(ROOT).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.suffixAmbiguous).toBeUndefined();
  });

  it("scans the configured jobsDir for .yml files too", () => {
    writeJob("spec/jobs", ".yml");
    expect(scanJobFiles(ROOT, "spec/jobs").rows.map((r) => r.jobId)).toEqual([JOB_ID]);
  });
});