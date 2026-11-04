/**
 * 222 Phase 4: configurable job directory + tracked-job-file re-resolution.
 *
 * Contract:
 * - `resolveTrackedJobFile` prefers the configured `jobsDir`, falls back to the
 *   persisted `state.jobPath` (project-relative or absolute), and returns the
 *   configured path when neither exists;
 * - `readActiveJobContext` and `jobFileMatchesSidecar` read through the same
 *   resolver, so MOVING the job directory does not degrade into `job_drift`;
 * - `scanJobFiles` scans the configured directory only and its user-facing copy
 *   names it;
 * - the sidecar keeps writing a PROJECT-RELATIVE `jobPath` (on-disk contract
 *   unchanged by 222).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { makeTestConfig } from "../helpers";
import {
  createJobState,
  resolveTrackedJobFile,
  writeJobState,
  type AutoJobState,
} from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import {
  __resetAutoJobLockForTests,
  acquireJobLock,
  readActiveJobContext,
} from "../../core/auto-pipeline/config-overlay";
import { jobFileMatchesSidecar } from "../../core/auto-pipeline/session-continuation-recovery";
import { scanJobFiles, selectJobFromMenu } from "../../commands/pipeline-auto-menu";
import { createPipelineAutoCommand } from "../../commands/pipeline-auto";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";

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
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-222-jobdir-"));
  __resetAutoJobLockForTests();
  // Job-file read failures are audited on the error channel; keep test output clean.
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  __resetAutoJobLockForTests();
  errorSpy.mockRestore();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Write `<dir>/<JOB_ID>.yaml` and return the absolute path. */
function writeJobFile(relDir: string, yaml = JOB_YAML): string {
  const abs = path.join(ROOT, relDir);
  fs.mkdirSync(abs, { recursive: true });
  const jobPath = path.join(abs, `${JOB_ID}.yaml`);
  fs.writeFileSync(jobPath, yaml, "utf8");
  return jobPath;
}

/** Install a RUNNING sidecar the way the runner does. */
async function writeRunningSidecar(opts: {
  storedJobPath: string;
  jobHash: string;
}): Promise<AutoJobState> {
  const base = createJobState({
    jobId: JOB_ID,
    jobPath: opts.storedJobPath,
    jobHash: opts.jobHash,
    docs: [{ doc: "docs/design/200_Feat.md" }],
  });
  const running: AutoJobState = { ...base, status: "running" };
  await writeJobState(ROOT, running);
  return running;
}

describe("resolveTrackedJobFile (222 Phase 4)", () => {
  it("returns the configured directory when the file exists there", () => {
    const expected = writeJobFile("spec/jobs");
    expect(resolveTrackedJobFile(ROOT, "spec/jobs", JOB_ID, "docs/jobs/alpha_loop.yaml")).toBe(expected);
  });

  it("falls back to the persisted relative path when the configured one is missing", () => {
    const persisted = writeJobFile("docs/jobs");
    expect(resolveTrackedJobFile(ROOT, "spec/jobs", JOB_ID, "docs/jobs/alpha_loop.yaml")).toBe(persisted);
  });

  it("honours an ABSOLUTE persisted path (outside the project root)", () => {
    const outside = fs.mkdtempSync(path.join(tmpdir(), "pi-222-outside-"));
    try {
      const abs = path.join(outside, `${JOB_ID}.yaml`);
      fs.writeFileSync(abs, JOB_YAML, "utf8");
      expect(resolveTrackedJobFile(ROOT, "spec/jobs", JOB_ID, abs)).toBe(abs);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns the configured path when neither location exists", () => {
    expect(resolveTrackedJobFile(ROOT, "spec/jobs", JOB_ID, "docs/jobs/alpha_loop.yaml")).toBe(
      path.join(ROOT, "spec/jobs", `${JOB_ID}.yaml`),
    );
  });

  it("accepts an ABSOLUTE jobsDir", () => {
    const abs = fs.mkdtempSync(path.join(tmpdir(), "pi-222-absjobs-"));
    try {
      const expected = path.join(abs, `${JOB_ID}.yaml`);
      fs.writeFileSync(expected, JOB_YAML, "utf8");
      expect(resolveTrackedJobFile(ROOT, abs, JOB_ID)).toBe(expected);
    } finally {
      fs.rmSync(abs, { recursive: true, force: true });
    }
  });
});

describe("readActiveJobContext after the job directory moved (222 Phase 4)", () => {
  it("still resolves the job file from the configured jobsDir (no job_drift)", async () => {
    // The file now lives in the CONFIGURED directory; the sidecar still names
    // the pre-move path, which no longer exists.
    const moved = writeJobFile("spec/jobs");
    const state = await writeRunningSidecar({
      storedJobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: hashJobBytes(JOB_YAML),
    });
    const lock = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
    if (!lock.ok) throw new Error("lock acquire failed");

    const active = readActiveJobContext(ROOT, "spec/jobs");
    expect(active).not.toBeNull();
    expect(active!.jobId).toBe(JOB_ID);
    expect(active!.jobHash).toBe(hashJobBytes(JOB_YAML));
    // The sidecar is returned as-is: the on-disk contract is not rewritten.
    expect(active!.state.jobPath).toBe(state.jobPath);
    expect(fs.existsSync(path.join(ROOT, state.jobPath))).toBe(false);
    expect(fs.existsSync(moved)).toBe(true);
  });

  it("returns null when neither the configured nor the persisted file exists", async () => {
    await writeRunningSidecar({
      storedJobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: hashJobBytes(JOB_YAML),
    });
    const lock = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
    if (!lock.ok) throw new Error("lock acquire failed");

    expect(readActiveJobContext(ROOT, "spec/jobs")).toBeNull();
  });

  it("defaults to docs/jobs when no jobsDir is passed (unconfigured projects)", async () => {
    writeJobFile("docs/jobs");
    await writeRunningSidecar({
      storedJobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: hashJobBytes(JOB_YAML),
    });
    const lock = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
    if (!lock.ok) throw new Error("lock acquire failed");

    expect(readActiveJobContext(ROOT)).not.toBeNull();
  });
});

describe("jobFileMatchesSidecar after the job directory moved (222 Phase 4)", () => {
  it("matches through the configured jobsDir", async () => {
    writeJobFile("spec/jobs");
    const state = await writeRunningSidecar({
      storedJobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: hashJobBytes(JOB_YAML),
    });
    expect(await jobFileMatchesSidecar(ROOT, state, "spec/jobs")).toBe(true);
  });

  it("reports drift when the tracked file really changed", async () => {
    writeJobFile("spec/jobs", `${JOB_YAML}\n# edited\n`);
    const state = await writeRunningSidecar({
      storedJobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: hashJobBytes(JOB_YAML),
    });
    expect(await jobFileMatchesSidecar(ROOT, state, "spec/jobs")).toBe(false);
  });

  it("reports drift when the file is gone from both locations", async () => {
    const state = await writeRunningSidecar({
      storedJobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: hashJobBytes(JOB_YAML),
    });
    expect(await jobFileMatchesSidecar(ROOT, state, "spec/jobs")).toBe(false);
  });
});

describe("scanJobFiles / selectJobFromMenu with a configured jobsDir (222 Phase 4)", () => {
  it("scans ONLY the configured directory", () => {
    writeJobFile("spec/jobs");
    writeJobFile("docs/jobs");
    const result = scanJobFiles(ROOT, "spec/jobs");
    expect(result.rows.map((r) => r.jobId)).toEqual([JOB_ID]);
  });

  it("keeps the legacy default (docs/jobs) when the argument is omitted", () => {
    writeJobFile("docs/jobs");
    expect(scanJobFiles(ROOT).rows.map((r) => r.jobId)).toEqual([JOB_ID]);
  });

  it("still reports non-*_loop.yaml files as ignored", () => {
    writeJobFile("spec/jobs");
    fs.writeFileSync(path.join(ROOT, "spec/jobs", "notes.yaml"), "a: 1\n", "utf8");
    expect(scanJobFiles(ROOT, "spec/jobs").ignored).toEqual(["notes.yaml"]);
  });

  // 223 Phase 3: `.yml` is a peer extension for the scan and the empty-state copy.
  it("scans *_loop.yml and keeps the same jobId", () => {
    const abs = path.join(ROOT, "spec/jobs");
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, `${JOB_ID}.yml`), JOB_YAML, "utf8");
    const result = scanJobFiles(ROOT, "spec/jobs");
    expect(result.rows.map((r) => r.jobId)).toEqual([JOB_ID]);
    expect(result.rows[0]?.fileName).toBe(`${JOB_ID}.yml`);
  });

  it("names both suffixes in the empty-directory message", async () => {
    fs.mkdirSync(path.join(ROOT, "spec/jobs"), { recursive: true });
    const selection = await selectJobFromMenu({}, makeTestConfig({ projectRoot: ROOT, docsDirs: {
      designDir: "docs/design",
      reviewDir: "docs/review",
      jobsDir: "spec/jobs",
    } }));
    expect(selection.kind === "error" ? selection.error : "").toContain("spec/jobs/*_loop.yaml|yml");
  });

  it("names the configured directory in the empty-directory message", async () => {
    fs.mkdirSync(path.join(ROOT, "spec/jobs"), { recursive: true });
    const selection = await selectJobFromMenu({}, makeTestConfig({ projectRoot: ROOT, docsDirs: {
      designDir: "docs/design",
      reviewDir: "docs/review",
      jobsDir: "spec/jobs",
    } }));
    expect(selection.kind).toBe("error");
    expect(selection.kind === "error" ? selection.error : "").toContain("spec/jobs/*_loop.yaml");
  });
});

describe("/pipeline-auto honours docs.jobsDir (222 Phase 4)", () => {
  /** Ctx stub: the runner reaches `finalizeCurrentDoc`, which needs session meta. */
  function ctxStub() {
    return {
      session: { getMeta: () => undefined, updateMeta: () => undefined },
      ui: { notify: () => undefined, select: async () => undefined },
      pi: { sendUserMessage: () => undefined },
      _ctx: {},
    };
  }

  /** The overlay must be computed from the JSON document the config came from. */
  function writeConfigJson(): void {
    const src = path.resolve(__dirname, "..", "..", "..");
    const json = JSON.parse(
      fs.readFileSync(path.join(src, "src", "template", "pipeline_loop.json"), "utf8"),
    ) as Record<string, unknown>;
    json.projectRoot = ROOT;
    const dest = path.join(ROOT, ".pi", "pipeline_loop.json");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(json, null, 2), "utf8");
  }

  it("command description names the configured directory", () => {
    const config = makeTestConfig({
      projectRoot: ROOT,
      docsDirs: { designDir: "docs/design", reviewDir: "docs/review", jobsDir: "spec/jobs" },
    });
    expect(createPipelineAutoCommand(config).description).toContain("spec/jobs/*.yaml");
  });

  it("--job <id> validates the file in the configured directory", async () => {
    writeConfigJson();
    __resetFinalizeStateForTests();
    writeJobFile("spec/jobs");
    const config = makeTestConfig({
      projectRoot: ROOT,
      docsDirs: { designDir: "docs/design", reviewDir: "docs/review", jobsDir: "spec/jobs" },
    });
    const result = (await createPipelineAutoCommand(config).execute(
      { job: JOB_ID },
      ctxStub() as never,
    )) as { success: boolean; error?: string };

    // The job file was FOUND (a start may still fail for unrelated fixture
    // reasons) — the assertion is that it is not reported as missing.
    expect(result.error ?? "").not.toContain("not found");
    expect(result.error ?? "").not.toContain("unreadable");
  });

  it("--job <id> reports not-found when the file is only in the DEFAULT directory", async () => {
    writeJobFile("docs/jobs");
    const config = makeTestConfig({
      projectRoot: ROOT,
      docsDirs: { designDir: "docs/design", reviewDir: "docs/review", jobsDir: "spec/jobs" },
    });
    const result = (await createPipelineAutoCommand(config).execute(
      { job: JOB_ID },
      ctxStub() as never,
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("resumes a job whose sidecar still points at the pre-move directory", async () => {
    writeConfigJson();
    __resetFinalizeStateForTests();
    // Job file moved to the configured directory; sidecar still names docs/jobs.
    writeJobFile("spec/jobs");
    await writeRunningSidecar({
      storedJobPath: "docs/jobs/alpha_loop.yaml",
      jobHash: hashJobBytes(JOB_YAML),
    });
    const config = makeTestConfig({
      projectRoot: ROOT,
      docsDirs: { designDir: "docs/design", reviewDir: "docs/review", jobsDir: "spec/jobs" },
    });

    const result = (await createPipelineAutoCommand(config).execute(
      { job: JOB_ID },
      ctxStub() as never,
    )) as { success: boolean; error?: string };

    // Reaching the lock/start path proves the file was resolved; a "not found"
    // or "unreadable" error would mean the re-resolution failed.
    expect(result.error ?? "").not.toContain("not found");
    expect(result.error ?? "").not.toContain("unreadable");
  });

  // ─── 222 review issue 6: the sidecar never records an ABSOLUTE job path ────

  it("writes a '..'-relative jobPath when the tracked file sits outside the root", async () => {
    writeConfigJson();
    __resetFinalizeStateForTests();
    // A job file that lives OUTSIDE the project root: only reachable through an
    // absolute `docsDirs.jobsDir` (a hand-built config, like an embedder's).
    const outside = fs.mkdtempSync(path.join(tmpdir(), "pi-222-outside-job-"));
    try {
      const outsideJob = path.join(outside, `${JOB_ID}.yaml`);
      fs.writeFileSync(outsideJob, JOB_YAML, "utf8");
      const config = makeTestConfig({
        projectRoot: ROOT,
        docsDirs: { designDir: "docs/design", reviewDir: "docs/review", jobsDir: outside },
      });

      const result = (await createPipelineAutoCommand(config).execute(
        { job: JOB_ID },
        ctxStub() as never,
      )) as { success: boolean; error?: string };
      expect(result.error ?? "").not.toContain("not found");

      // The on-disk contract: PROJECT-RELATIVE, never the absolute path.
      const relPath = path.relative(ROOT, outsideJob).split(path.sep).join("/");
      const state = JSON.parse(
        fs.readFileSync(path.join(ROOT, ".pi/auto_pipeline", JOB_ID, "state.json"), "utf8"),
      ) as { jobPath: string };
      expect(path.isAbsolute(state.jobPath)).toBe(false);
      expect(state.jobPath).toBe(relPath);
      // The recorded path still resolves back to the very same file.
      expect(path.resolve(ROOT, state.jobPath)).toBe(outsideJob);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});