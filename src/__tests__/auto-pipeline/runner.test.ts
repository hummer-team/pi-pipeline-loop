/**
 * 219 Phase 4: the auto-job runner (job → overlay → first doc).
 *
 * Key behaviors:
 * - `enabled: false` and missing documents fail fast (no pipeline started).
 * - `skipCompleted` skips `NEW_COMMIT_RE` docs; all-skipped → job completes.
 * - `startNewPipeline` failure NEVER advances `docIndex` and never leaves a
 *   `running` sidecar or a held lock; `onFailure` decides stop vs continue.
 * - `meta.autoJob` is written AFTER the start (buildStartMeta would erase it).
 * - `docIndex` advances only when the NEXT doc actually starts (M3), and
 *   `docs[i].lastStage` records the startup stage (H4).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { startAutoJob } from "../../commands/pipeline-auto";
import { isAutoJobActive, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { readJobState, resolveJobStatePath, writeJobState, createJobState } from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "alpha";

let ROOT: string;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

function jobYaml(
  docs: string[],
  extra?: { enabled?: boolean; startStage?: string; onFailure?: string; newSession?: boolean },
): string {
  const lines = [
    `version: 1`,
    `enabled: ${extra?.enabled ?? true}`,
    `docs:`,
    `  list:`,
  ];
  for (const doc of docs) {
    lines.push(`    - doc: ${doc}`);
    if (extra?.startStage) lines.push(`      startStage: ${extra.startStage}`);
  }
  lines.push(`  skipCompleted: true`);
  lines.push(`  onFailure: ${extra?.onFailure ?? "stop"}`);
  if (extra?.newSession !== undefined) {
    lines.push(`chain:`);
    lines.push(`  newSession: ${extra.newSession}`);
  }
  return lines.join("\n");
}

function writeJob(yaml: string): void {
  const jobPath = path.join(ROOT, "docs", "jobs", `${JOB_ID}.yaml`);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, yaml, "utf8");
}

function writeDoc(rel: string): void {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `# ${rel}\n`, "utf8");
}

function config(): PipelineConfig {
  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: ROOT };
  const jsonPath = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  // Production shape: the live config IS the resolved document (so the
  // pre-overlay values exist and the rollback copy is meaningful).
  const resolved = resolvePipelineConfig(json);
  // The runner tests focus on orchestration: strip the verify-file preflight
  // (production projects have .pi/verify/*.md deployed by /pipeline-init).
  for (const stage of Object.values(resolved.stages)) {
    if (stage) delete (stage as { verify?: unknown }).verify;
  }
  return { ...resolved, configSourcePath: jsonPath };
}

function makeCtx() {
  let meta: SessionMeta | undefined;
  const notified: string[] = [];
  const dispatched: string[] = [];
  return {
    ctx: {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
          return meta;
        },
      },
      ui: {
        notify: (message: string) => notified.push(message),
        select: async () => undefined,
      },
      pi: { sendUserMessage: (message: string) => dispatched.push(message) },
      _ctx: {
        sessionManager: {
          getBranch: () => [],
          getEntries: () => [],
          getHeader: () => ({}),
          getSessionName: () => "owner-session",
        },
      },
    },
    meta: () => meta,
    notified,
    dispatched,
  };
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-runner-"));
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
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

describe("runner — fail fast", () => {
  it("enabled:false is refused before any lock/overlay", async () => {
    writeJob(jobYaml(["docs/design/a.md"], { enabled: false }));
    const { ctx } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
    expect(isAutoJobActive()).toBe(false);
    expect(readJobState(ROOT, JOB_ID)).toBeNull();
  });

  it("an invalid job file reports every parse error and starts nothing", async () => {
    writeJob("version: 1\nenabled: true\ndocs:\n  list: []\n");
    const { ctx } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    expect(result.success).toBe(false);
    expect(result.error).toContain("docs.list");
    expect(isAutoJobActive()).toBe(false);
  });

  it("an unreadable job file is refused", async () => {
    const { ctx } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    expect(result.success).toBe(false);
    expect(result.error).toContain("unreadable");
  });
});

describe("runner — start failure handling", () => {
  it("missing document → doc failed, sidecar stopped (no running), lock released", async () => {
    writeJob(jobYaml(["docs/design/missing.md"]));
    const { ctx } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(false);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.status).toBe("failed");
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[0]?.failReason).toContain("File not found");
    expect(state.docIndex).toBe(0); // never advanced by a failed start
    expect(isAutoJobActive()).toBe(false);
    expect(audits).toContain("pipeline_auto_stop");
    expect(audits).toContain("pipeline_auto_cleanup");
  });

  it("onFailure:continue + chain.newSession:false starts the next document in the same invocation", async () => {
    writeJob(jobYaml(["docs/design/missing.md", "docs/design/ok.md"], { onFailure: "continue", newSession: false }));
    writeDoc("docs/design/ok.md");
    const { ctx, meta } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[1]?.status).toBe("running");
    expect(state.docIndex).toBe(1);
    expect(meta()?.requirementDoc).toBe("docs/design/ok.md");
  });

  it("onFailure:continue + chain.newSession dispatches the continuation command (no same-session start)", async () => {
    writeJob(jobYaml(["docs/design/missing.md", "docs/design/ok.md"], { onFailure: "continue" }));
    writeDoc("docs/design/ok.md");
    // A hook-shaped ctx: it can DISPATCH (pi.sendUserMessage) but cannot replace
    // the session — the production `agent_settled` shape.
    const { ctx, meta, dispatched } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.status).toBe("failed");
    // The NEW session owns the next doc — it must not start in this one.
    expect(state.docs[1]?.status).toBe("pending");
    expect(state.docIndex).toBe(0);
    expect(meta()?.requirementDoc).toBeUndefined();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain(`/pipeline-auto --next --job ${JOB_ID}`);
    expect(dispatched[0]).toContain("--token");
  });

  it("all documents failing with onFailure:stop stops the job immediately", async () => {
    writeJob(jobYaml(["docs/design/m1.md", "docs/design/m2.md"]));
    const { ctx } = makeCtx();
    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.status).toBe("failed");
    expect(state.docs[1]?.status).toBe("pending"); // never reached
  });
});

describe("runner — skipCompleted", () => {
  it("a NEW_COMMIT_RE document is skipped and the next one starts", async () => {
    writeJob(jobYaml(["docs/design/100_Feat_Develop_Commit.md", "docs/design/101_Feat.md"]));
    writeDoc("docs/design/101_Feat.md");
    const { ctx, meta } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.status).toBe("skipped");
    expect(state.docs[1]?.status).toBe("running");
    expect(state.docIndex).toBe(1);
    expect(meta()?.requirementDoc).toBe("docs/design/101_Feat.md");
  });

  it("all documents already shipped → job completes without starting a pipeline", async () => {
    writeJob(jobYaml(["docs/design/100_Feat_Develop_Commit.md"]));
    const { ctx, meta } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(result.message).toContain("completed");
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.status).toBe("completed");
    expect(state.docs[0]?.status).toBe("skipped");
    expect(meta()?.requirementDoc).toBeUndefined(); // no pipeline was started
    expect(isAutoJobActive()).toBe(false);
  });
});

describe("runner — startup metadata", () => {
  it("meta.autoJob is written AFTER start (not overwritten) with designReview thresholds", async () => {
    writeJob(jobYaml(["docs/design/a.md"]));
    writeDoc("docs/design/a.md");
    const { ctx, meta } = makeCtx();
    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    const written = meta()!.autoJob;
    expect(written).toBeDefined();
    expect(written?.jobId).toBe(JOB_ID);
    expect(written?.docIndex).toBe(0);
    expect(written?.totalDocs).toBe(1);
    expect(written?.designReviewMaxRounds).toBe(3); // job default
    expect(written?.designReviewRounds).toBe(0);
    expect(meta()!.currentStage).toBe("clarify");
  });

  it("startStage is honoured and recorded as docs[i].lastStage (H4)", async () => {
    writeJob(jobYaml(["docs/design/a.md"], { startStage: "plan" }));
    writeDoc("docs/design/a.md");
    const { ctx, meta } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(meta()!.currentStage).toBe("plan");
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.lastStage).toBe("plan");
  });

  it("docIndex advances only when the NEXT doc starts (M3)", async () => {
    writeJob(jobYaml(["docs/design/a.md", "docs/design/b.md"]));
    writeDoc("docs/design/a.md");
    writeDoc("docs/design/b.md");
    const cfg = config();
    const first = makeCtx();
    await startAutoJob({ config: cfg, ctx: first.ctx, jobId: JOB_ID });
    expect(readJobState(ROOT, JOB_ID)?.docIndex).toBe(0);

    // Simulate the doc finishing (Phase 5 owns the finalize transaction).
    const state = readJobState(ROOT, JOB_ID)!;
    state.docs[0]!.status = "completed";
    await writeJobState(ROOT, state);

    const second = makeCtx();
    await startAutoJob({ config: cfg, ctx: second.ctx, jobId: JOB_ID });
    expect(readJobState(ROOT, JOB_ID)?.docIndex).toBe(1);
  });

  it("overlay is applied before the doc starts and its snapshot is persisted", async () => {
    writeJob(jobYaml(["docs/design/a.md"]));
    writeDoc("docs/design/a.md");
    const cfg = config();
    const { ctx } = makeCtx();
    await startAutoJob({ config: cfg, ctx, jobId: JOB_ID });

    expect(cfg.stages.plan?.confirm?.mode).toBe("auto");
    expect(readJobState(ROOT, JOB_ID)?.overlaySnapshot?.before["stages.plan.confirm.mode"]).toBe("manual");
    expect(audits).toContain("pipeline_auto_start");
    expect(audits).toContain("pipeline_auto_job_overlay");
  });
});

describe("runner — lock guards", () => {
  it("a second job is refused while another is active (liveConfig untouched)", async () => {
    writeJob(jobYaml(["docs/design/a.md"]));
    writeDoc("docs/design/a.md");
    const cfg = config();
    const { ctx } = makeCtx();
    await startAutoJob({ config: cfg, ctx, jobId: JOB_ID });
    const before = cfg.stages.plan?.confirm?.mode;

    const other = makeCtx();
    const result = await startAutoJob({ config: cfg, ctx: other.ctx, jobId: "beta" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("another auto job is active");
    expect(cfg.stages.plan?.confirm?.mode).toBe(before);
  });

  it("a corrupt sidecar is read as missing state, never as a running job", async () => {
    writeJob(jobYaml(["docs/design/a.md"]));
    writeDoc("docs/design/a.md");
    const statePath = resolveJobStatePath(ROOT, JOB_ID);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{ not json", "utf8");

    const { ctx } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    // Corrupt → treated as no state → the job simply starts fresh.
    expect(result.success).toBe(true);
    expect(readJobState(ROOT, JOB_ID)?.status).toBe("running");
  });

  it("a pre-existing completed sidecar is reused for the hash/progress rows", async () => {
    writeJob(jobYaml(["docs/design/a.md"]));
    writeDoc("docs/design/a.md");
    const state = createJobState({
      jobId: JOB_ID,
      jobPath: `docs/jobs/${JOB_ID}.yaml`,
      jobHash: hashJobBytes(jobYaml(["docs/design/a.md"])),
      docs: [{ doc: "docs/design/a.md" }],
    });
    state.status = "completed";
    state.counters.totalLoops = 7;
    await writeJobState(ROOT, state);

    const { ctx } = makeCtx();
    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    const reloaded = readJobState(ROOT, JOB_ID)!;
    expect(reloaded.counters.totalLoops).toBe(7); // counters survive a restart
    expect(reloaded.status).toBe("running");
  });
});
