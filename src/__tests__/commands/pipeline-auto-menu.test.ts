/**
 * 219 Phase 4 (R5Q3-A + M2): the `/pipeline-auto` job menu.
 *
 * Key behaviors:
 * - Only `docs/jobs/*.yaml` (no recursion), ≤5 newest by mtime.
 * - Row copy carries progress, the `续跑 i/N` marker for running jobs and the
 *   `（job 已变更）` drift marker.
 * - Empty directory / no UI / cancel are typed results (one user message).
 * - A corrupt sidecar and a competing active job are refused BEFORE any
 *   overlay is applied.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../../types";
import { makeTestConfig } from "../helpers";
import {
  formatJobMenuLabel,
  scanJobFiles,
  selectJobFromMenu,
} from "../../commands/pipeline-auto-menu";
import { runPipelineAuto } from "../../commands/pipeline-auto";
import {
  acquireJobLock,
  __resetAutoJobLockForTests,
  isAutoJobActive,
} from "../../core/auto-pipeline/config-overlay";
import {
  createJobState,
  readJobState,
  writeJobState,
} from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";

const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/a.md",
  "    - doc: docs/design/b.md",
].join("\n");

let ROOT: string;
let errorSpy: ReturnType<typeof spyOn>;

function config(): PipelineConfig {
  return makeTestConfig({ projectRoot: ROOT });
}

function writeJobFile(jobId: string, yaml = JOB_YAML, mtimeMs?: number): string {
  const dir = path.join(ROOT, "docs", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  const jobPath = path.join(dir, `${jobId}.yaml`);
  fs.writeFileSync(jobPath, yaml, "utf8");
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    fs.utimesSync(jobPath, seconds, seconds);
  }
  return jobPath;
}

async function writeSidecar(
  jobId: string,
  overrides?: Partial<Parameters<typeof writeJobState>[1]>,
): Promise<void> {
  const jobPath = `docs/jobs/${jobId}.yaml`;
  const base = createJobState({
    jobId,
    jobPath,
    jobHash: hashJobBytes(JOB_YAML),
    docs: [{ doc: "docs/design/a.md" }, { doc: "docs/design/b.md" }],
  });
  await writeJobState(ROOT, { ...base, ...(overrides as object) });
}

function ctxWithSelect(answers: Array<string | undefined>) {
  const notified: string[] = [];
  const queue = [...answers];
  return {
    ctx: {
      ui: {
        select: async () => queue.shift(),
        notify: (message: string) => notified.push(message),
      },
      session: { getMeta: () => undefined, updateMeta: () => undefined },
    },
    notified,
  };
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-menu-"));
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async () => undefined);
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("job-menu — discovery", () => {
  it("takes the 5 newest job files by mtime", () => {
    for (let i = 0; i < 7; i++) {
      writeJobFile(`job${i}`, JOB_YAML, 1_700_000_000_000 + i * 1000);
    }
    const rows = scanJobFiles(ROOT);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.jobId)).toEqual(["job6", "job5", "job4", "job3", "job2"]);
  });

  it("ignores non-yaml files and unsafe names", () => {
    writeJobFile("alpha");
    fs.writeFileSync(path.join(ROOT, "docs", "jobs", "notes.md"), "x", "utf8");
    fs.writeFileSync(path.join(ROOT, "docs", "jobs", "bad name.yaml"), JOB_YAML, "utf8");
    const rows = scanJobFiles(ROOT);
    expect(rows.map((r) => r.jobId)).toEqual(["alpha"]);
  });

  it("missing directory → empty scan", () => {
    expect(scanJobFiles(ROOT)).toEqual([]);
  });
});

describe("job-menu — literals", () => {
  it("progress copy with completed rows", async () => {
    writeJobFile("alpha");
    const base = createJobState({
      jobId: "alpha",
      jobPath: "docs/jobs/alpha.yaml",
      jobHash: hashJobBytes(JOB_YAML),
      docs: [{ doc: "docs/design/a.md" }, { doc: "docs/design/b.md" }],
    });
    base.docs[0]!.status = "completed";
    await writeJobState(ROOT, base);

    const [row] = scanJobFiles(ROOT);
    expect(formatJobMenuLabel(row!)).toContain("（1/2 已完成）");
    expect(formatJobMenuLabel(row!)).not.toContain("续跑");
  });

  it("running rows add the resume marker", async () => {
    writeJobFile("alpha");
    await writeSidecar("alpha", { status: "running", docIndex: 1 } as never);
    const [row] = scanJobFiles(ROOT);
    expect(formatJobMenuLabel(row!)).toContain("续跑 2/2");
  });

  it("drifted rows add the drift marker", async () => {
    writeJobFile("alpha");
    await writeSidecar("alpha", { jobHash: "stale-hash" } as never);
    const [row] = scanJobFiles(ROOT);
    expect(row?.drifted).toBe(true);
    expect(formatJobMenuLabel(row!)).toContain("job 已变更");
  });

  it("corrupt sidecars are flagged, never silently treated as fresh", () => {
    writeJobFile("alpha");
    const statePath = path.join(ROOT, ".pi", "auto_pipeline", "alpha", "state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "not json", "utf8");
    const [row] = scanJobFiles(ROOT);
    expect(row?.corrupt).toBe(true);
    expect(formatJobMenuLabel(row!)).toContain("进度状态损坏");
  });
});

describe("job-menu — selection", () => {
  it("empty directory → guidance error", async () => {
    const { ctx } = ctxWithSelect([]);
    const result = await selectJobFromMenu(ctx, config());
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error).toContain("auto_job_example.yaml");
  });

  it("no ui.select → error", async () => {
    writeJobFile("alpha");
    const result = await selectJobFromMenu({}, config());
    expect(result.kind).toBe("error");
  });

  it("cancel returns a cancelled result", async () => {
    writeJobFile("alpha");
    const { ctx } = ctxWithSelect(["Cancel"]);
    expect((await selectJobFromMenu(ctx, config())).kind).toBe("cancelled");
  });

  it("an unknown selection is treated as cancel", async () => {
    writeJobFile("alpha");
    const { ctx } = ctxWithSelect(["nonsense"]);
    expect((await selectJobFromMenu(ctx, config())).kind).toBe("cancelled");
  });
});

describe("job-menu — command guards", () => {
  it("a corrupt sidecar refuses to start", async () => {
    writeJobFile("alpha");
    const statePath = path.join(ROOT, ".pi", "auto_pipeline", "alpha", "state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "garbage", "utf8");
    const { ctx } = ctxWithSelect([formatJobMenuLabel(scanJobFiles(ROOT)[0]!)]);
    const result = await runPipelineAuto(config(), {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("corrupt");
  });

  it("another active job refuses BEFORE the overlay is touched", async () => {
    writeJobFile("alpha");
    const cfg = config();
    const lock = acquireJobLock({ projectRoot: ROOT, jobId: "beta" });
    expect(lock.ok).toBe(true);
    const modeBefore = cfg.stages.plan?.confirm?.mode;

    const { ctx } = ctxWithSelect([formatJobMenuLabel(scanJobFiles(ROOT)[0]!)]);
    const result = await runPipelineAuto(cfg, {}, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("another auto job is active");
    expect(cfg.stages.plan?.confirm?.mode).toBe(modeBefore);
  });

  it("drift + 取消 leaves the sidecar untouched", async () => {
    writeJobFile("alpha");
    await writeSidecar("alpha", { jobHash: "stale-hash" } as never);
    const before = readJobState(ROOT, "alpha");
    const { ctx } = ctxWithSelect([formatJobMenuLabel(scanJobFiles(ROOT)[0]!), "取消"]);
    const result = await runPipelineAuto(config(), {}, ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain("cancelled");
    expect(readJobState(ROOT, "alpha")?.jobHash).toBe(before?.jobHash);
  });

  it("drift + 重新开始 rewrites the sidecar with the new hash", async () => {
    writeJobFile("alpha");
    await writeSidecar("alpha", { jobHash: "stale-hash" } as never);
    const { ctx } = ctxWithSelect([formatJobMenuLabel(scanJobFiles(ROOT)[0]!), "重新开始"]);
    await runPipelineAuto(config(), {}, ctx);

    const refreshed = readJobState(ROOT, "alpha");
    expect(refreshed?.jobHash).toBe(hashJobBytes(JOB_YAML));
    // The restart rebuilt the progress rows; the first doc then failed fast
    // (its file is absent) and the second one stayed untouched.
    expect(refreshed?.docIndex).toBe(0);
    expect(refreshed?.docs[1]?.status).toBe("pending");
  });

  it("a completed sidecar asks restart/cancel and keeps the state on cancel", async () => {
    writeJobFile("alpha");
    await writeSidecar("alpha", { status: "completed" } as never);
    const { ctx } = ctxWithSelect([formatJobMenuLabel(scanJobFiles(ROOT)[0]!), "取消"]);
    const result = await runPipelineAuto(config(), {}, ctx);
    expect(result.message).toContain("cancelled");
    expect(readJobState(ROOT, "alpha")?.status).toBe("completed");
  });

  it("重新开始 on a completed sidecar REBUILDS the progress (no 'already finished')", async () => {
    writeJobFile("alpha");
    // Every doc already completed: without a rebuild `pickNextDoc` finds
    // nothing and the job ends as `job_completed` ("already finished").
    await writeSidecar("alpha", {
      status: "completed",
      docs: [
        { doc: "docs/design/a.md", status: "completed", updatedAt: 0 },
        { doc: "docs/design/b.md", status: "completed", updatedAt: 0 },
      ],
      docIndex: 1,
    } as never);
    const { ctx } = ctxWithSelect([formatJobMenuLabel(scanJobFiles(ROOT)[0]!), "重新开始"]);
    const result = await runPipelineAuto(config(), {}, ctx);

    // The rebuild restarted at doc 1; its file is absent, so the runner fails
    // fast — the point is that the job did NOT report "already finished".
    expect(result.message ?? "").not.toContain("already finished");
    const state = readJobState(ROOT, "alpha")!;
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[1]?.status).toBe("pending");
    expect(state.docIndex).toBe(0);
  });

  it("selecting a job starts it (document missing → fail-fast but START was audited)", async () => {
    writeJobFile("alpha");
    await writeSidecar("alpha", { status: "completed" } as never);
    // Restart → then start; the doc file does not exist, so the runner fails
    // fast — the interesting part is that the selection reached the runner.
    const { ctx, notified } = ctxWithSelect([formatJobMenuLabel(scanJobFiles(ROOT)[0]!), "重新开始"]);
    const result = await runPipelineAuto(config(), {}, ctx);
    expect(result.success).toBe(false);
    expect(notified.length).toBeGreaterThan(0);
    expect(isAutoJobActive()).toBe(false);
  });
});
