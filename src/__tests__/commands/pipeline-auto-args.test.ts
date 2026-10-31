/**
 * 219 Phase 4 (M1/M8): `/pipeline-auto` argument + token resolution.
 *
 * Key behaviors:
 * - `--job` takes a jobId only: a path separator is rejected, a missing
 *   sidecar reports a clear error.
 * - Without `--job`, the scan resolves 0 / 1 / many running jobs explicitly.
 * - M8: a dead lock holder is reclaimed automatically (audited
 *   `stale_reclaimed`); a LIVE holder with a mismatched token is refused
 *   (`stale_token`) and never yanked.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../../types";
import { makeTestConfig } from "../helpers";
import { parseCommandArgs } from "../../utils/command-args";
import { runPipelineAuto } from "../../commands/pipeline-auto";
import {
  __resetAutoJobLockForTests,
  readJobLock,
} from "../../core/auto-pipeline/config-overlay";
import { createJobState, readJobState, writeJobState } from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const DEAD_PID = 4194303;
const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/missing.md",
].join("\n");

let ROOT: string;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

function config(): PipelineConfig {
  return makeTestConfig({ projectRoot: ROOT });
}

function writeJobFile(jobId: string): void {
  const dir = path.join(ROOT, "docs", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${jobId}.yaml`), JOB_YAML, "utf8");
}

async function writeRunningSidecar(jobId: string): Promise<void> {
  const base = createJobState({
    jobId,
    jobPath: `docs/jobs/${jobId}.yaml`,
    jobHash: hashJobBytes(JOB_YAML),
    docs: [{ doc: "docs/design/missing.md" }],
  });
  await writeJobState(ROOT, { ...base, status: "running" });
}

function writeRawLock(pid: number, token: string, jobId = "alpha"): void {
  const lockPath = path.join(ROOT, ".pi", "auto_pipeline", "lock.json");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ token, jobId, pid, startedAt: 1 }, null, 2), "utf8");
}

function ctxStub() {
  return {
    session: { getMeta: () => undefined, updateMeta: () => undefined },
    ui: { notify: () => undefined, select: async () => undefined },
    pi: { sendUserMessage: () => undefined },
  };
}

function writeConfigJson(): void {
  // The overlay is computed from the JSON document the config was loaded from.
  const src = path.resolve(__dirname, "..", "..", "..");
  const json = JSON.parse(
    fs.readFileSync(path.join(src, "src", "template", "pipeline_loop.json"), "utf8"),
  ) as Record<string, unknown>;
  json.projectRoot = ROOT;
  const dest = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(json, null, 2), "utf8");
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-args-"));
  writeConfigJson();
  __resetAutoJobLockForTests();
  audits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage) => {
    audits.push(stage);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("pipeline-auto — argument parsing", () => {
  it("parses the internal continuation flags", () => {
    expect(parseCommandArgs("pipeline-auto", "--next --job alpha --token tok-1")).toEqual({
      next: true,
      job: "alpha",
      token: "tok-1",
      raw: "--next --job alpha --token tok-1",
    });
  });

  it("no args → menu shape (no next / job / token)", () => {
    expect(parseCommandArgs("pipeline-auto", "")).toEqual({ next: false, raw: "" });
  });

  it("a flag without a value does not swallow the next flag", () => {
    const parsed = parseCommandArgs("pipeline-auto", "--next --job --token tok-1");
    expect(parsed.next).toBe(true);
    expect(parsed.job).toBeUndefined();
    expect(parsed.token).toBe("tok-1");
  });
});

describe("pipeline-auto — --job only accepts a jobId", () => {
  it("a path separator is rejected", async () => {
    const result = await runPipelineAuto(config(), { next: true, job: "docs/jobs/alpha.yaml" }, ctxStub());
    expect(result.success).toBe(false);
    expect(result.error).toContain("never a path");
  });

  it("a traversal id is rejected", async () => {
    const result = await runPipelineAuto(config(), { next: true, job: "../alpha" }, ctxStub());
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid job id");
  });

  it("a missing sidecar reports the job is unknown", async () => {
    const result = await runPipelineAuto(config(), { next: true, job: "alpha" }, ctxStub());
    expect(result.success).toBe(false);
    expect(result.error).toContain("state not found");
  });
});

describe("pipeline-auto — scan fallback (no --job)", () => {
  it("zero running jobs → guidance error", async () => {
    const result = await runPipelineAuto(config(), { next: true }, ctxStub());
    expect(result.success).toBe(false);
    expect(result.error).toContain("no running auto job");
  });

  it("two running jobs → refuse and list them", async () => {
    await writeRunningSidecar("alpha");
    await writeRunningSidecar("beta");
    const result = await runPipelineAuto(config(), { next: true }, ctxStub());
    expect(result.success).toBe(false);
    expect(result.error).toContain("multiple running auto jobs");
    expect(result.error).toContain("alpha");
    expect(result.error).toContain("beta");
  });

  it("exactly one running job → it is selected", async () => {
    writeJobFile("alpha");
    await writeRunningSidecar("alpha");
    const result = await runPipelineAuto(config(), { next: true }, ctxStub());
    // The doc file is absent, so the start fails fast — proving alpha was
    // resolved by the scan and reached the runner.
    expect(result.success).toBe(false);
    expect(readJobState(ROOT, "alpha")?.docs[0]?.failReason).toContain("File not found");
  });
});

describe("pipeline-auto — M8 token resolution", () => {
  it("crash restart: dead pid + no token → reclaimed and the job runs", async () => {
    writeJobFile("alpha");
    await writeRunningSidecar("alpha");
    writeRawLock(DEAD_PID, "dead-token");

    const result = await runPipelineAuto(config(), { next: true, job: "alpha" }, ctxStub());

    // Reclaim happened (no stale_token/busy) and the run reached the dispatch.
    expect(readJobState(ROOT, "alpha")?.docs[0]?.failReason).toContain("File not found");
    expect(audits).toContain("pipeline_auto_start");
    // The stale holder was reclaimed with a NEW token.
    await Promise.resolve();
    expect(audits).toContain("pipeline_auto_lock");
  });

  it("alive pid + mismatched token → refused, lock untouched", async () => {
    writeJobFile("alpha");
    await writeRunningSidecar("alpha");
    writeRawLock(1, "live-token");

    const result = await runPipelineAuto(
      config(),
      { next: true, job: "alpha", token: "other-token" },
      ctxStub(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("token mismatch");
    const lock = readJobLock(ROOT);
    expect(lock?.pid).toBe(1);
    expect(lock?.token).toBe("live-token");
  });

  it("alive pid + matching token → adopted", async () => {
    writeJobFile("alpha");
    await writeRunningSidecar("alpha");
    writeRawLock(1, "live-token");

    const result = await runPipelineAuto(
      config(),
      { next: true, job: "alpha", token: "live-token" },
      ctxStub(),
    );

    expect(readJobState(ROOT, "alpha")?.docs[0]?.failReason).toContain("File not found");
  });
});
