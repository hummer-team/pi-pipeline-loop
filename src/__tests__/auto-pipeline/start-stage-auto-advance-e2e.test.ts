/**
 * 224 Phase 4: the start-stage auto-advance contract pinned END TO END.
 *
 * Scope (judge rows 1–2 and 5–9 — command / audit / sidecar surfaces only;
 * row 3 (auto copy) and row 10 (other stage paragraphs) live in the Phase 3
 * rendering test to avoid maintaining one assertion twice):
 * 1. plan start dispatches its executor ONCE in the start round;
 * 2. the 223 confirm-advance path still dispatches plan exactly once;
 * 5. the evidence gate audits the new missing kinds + hints;
 * 6. a second run on a running job is a no-op with no extra cleanup;
 * 7. multi-doc seriality holds while one doc runs;
 * 8. an auto derivation to plan is not vetoed by the clarify gate;
 * 9. a deferred dispatch keeps the doc running (never failed).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, PipelineStage, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { startAutoJob } from "../../commands/pipeline-auto";
import { isAutoJobActive, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { readJobState, writeJobState, createJobState } from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "e2e_loop";
const REQUIREMENT = "docs/design/200_Feat.md";
const PLAN = "docs/design/200_Feat_Plan.md";
const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

let ROOT: string;
let audits: Array<{ stage: string; message?: Record<string, string | boolean> }>;
let errorSpy: ReturnType<typeof spyOn>;
const registry = globalThis as Record<symbol, unknown>;

function writeJob(options: { startStage: string; extraDoc?: string }): void {
  const jobPath = path.join(ROOT, "docs", "jobs", `${JOB_ID}.yaml`);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  const lines = [
    "version: 1",
    "enabled: true",
    "tier: rule",
    "docs:",
    "  list:",
    `    - doc: ${REQUIREMENT}`,
    `      startStage: ${options.startStage}`,
  ];
  if (options.extraDoc) lines.push(`    - doc: ${options.extraDoc}`);
  lines.push("  skipCompleted: false", "  onFailure: stop", "chain:", "  newSession: false");
  fs.writeFileSync(jobPath, lines.join("\n"), "utf8");
}

function writeJobYaml(raw: string): void {
  const jobPath = path.join(ROOT, "docs", "jobs", `${JOB_ID}.yaml`);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, raw, "utf8");
}

function writeFile(rel: string, content: string): void {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function writeAgentFixture(name: string): void {
  const dir = path.join(ROOT, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(SRC_ROOT, "src", "template", "agents", `${name}.md`), path.join(dir, `${name}.md`));
}

function config(opts: { completionMarker?: string } = {}): PipelineConfig {
  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: ROOT };
  const jsonPath = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  const resolved = resolvePipelineConfig(json);
  for (const stage of Object.values(resolved.stages)) {
    if (stage) delete (stage as { verify?: unknown }).verify;
  }
  const clarify = resolved.stages.clarify;
  if (opts.completionMarker && clarify) {
    (clarify as { verify?: { completionMarker?: string } }).verify = {
      completionMarker: opts.completionMarker,
    };
  }
  return { ...resolved, configSourcePath: jsonPath };
}

function makeCtx(opts: { twinStage?: PipelineStage; staticMeta?: SessionMeta } = {}) {
  let meta: SessionMeta | undefined = opts.staticMeta;
  const handoffs: string[] = [];
  return {
    ctx: {
      session: {
        getMeta: () => {
          // Deferred row: once the run is committed (pipelineId set), a
          // same-name twin reserved entry (id-less, in flight) exists — the
          // deferral gate's tier-2.5 supplement queues the spawn instead.
          if (opts.twinStage && meta?.pipelineId) {
            return {
              ...meta,
              activeSpawns: {
                ...(meta.activeSpawns ?? {}),
                [opts.twinStage]: twinEntry(),
              },
            } as SessionMeta;
          }
          return meta;
        },
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
          return meta;
        },
      },
      ui: { notify: (message: string) => undefined, select: async () => undefined },
      pi: { sendUserMessage: (message: string) => { handoffs.push(message); } },
    },
    meta: () => meta,
    handoffs,
  };
}

function twinEntry(): NonNullable<SessionMeta["activeSpawns"]>[PipelineStage] {
  return { agentName: "feat-design-plan-agent", startedAt: Date.now() - 1_000, reserved: true };
}

function probeTwinEntry(): NonNullable<SessionMeta["activeSpawns"]>[PipelineStage] {
  return { agentName: "develop-agent", agentId: "a-e2e-live", startedAt: Date.now(), source: "rpc" as const };
}

function installLiveManager(): void {
  registry[MANAGER_SYMBOL] = { getRecord: () => ({ status: "running" }), hasRunning: () => true };
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-224-e2e-"));
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  audits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push({ stage, message });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  delete registry[MANAGER_SYMBOL];
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("224 e2e — start dispatch rows (judge 1, 2)", () => {
  it("judge 1: plan start dispatches the executor ONCE in the start round", async () => {
    writeJob({ startStage: "plan" });
    writeFile(REQUIREMENT, "# requirement\n## 模型确认\nconfirmed\n");
    writeAgentFixture("feat-design-plan-agent");
    const { ctx, meta, handoffs } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    // ONE dispatch in the start round: the fallback spawn audit + the
    // `pipeline_resume_dispatch` spawn audit both appear exactly once.
    const spawnAudit = audits.filter((a) => a.stage === "stage_spawn_fallback");
    expect(spawnAudit).toHaveLength(1);
    const dispatchAudit = audits.filter((a) => a.stage === "pipeline_resume_dispatch");
    expect(dispatchAudit).toHaveLength(1);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toContain("[plugin auto-handoff] @feat-design-plan-agent");
    // No queue residue: pendingSpawns stay empty, the doc is running.
    expect(meta()?.pendingSpawns ?? {}).toEqual({});
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.status).toBe("running");
  });

  it("judge 2: the 223 confirm-advance path still dispatches plan exactly once", async () => {
    writeJob({ startStage: "clarify" });
    writeFile(REQUIREMENT, "# requirement\n## 第 1 轮\n## 模型确认\nconfirmed\n");
    writeAgentFixture("feat-design-plan-agent");
    const { ctx, meta, handoffs } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(result.message).toContain("clarify confirmed → advanced to");
    // Exactly ONE executor spawn overall (the advance) — never two.
    expect(audits.filter((a) => a.stage === "stage_spawn_fallback")).toHaveLength(1);
    expect(handoffs).toHaveLength(1);
    // Ledger/stamp residue: exactly one plan entry, no pending spawns.
    expect(Object.keys(meta()?.spawnedStages ?? {})).toEqual(["plan"]);
    expect(meta()?.pendingSpawns ?? {}).toEqual({});
  });
});

describe("224 e2e — evidence gate rows (judge 5) + auto basis (judge 8)", () => {
  it("judge 5a: plan without the confirm marker → audit missing=clarify-confirmation", async () => {
    writeJob({ startStage: "plan" });
    writeFile(REQUIREMENT, "# requirement\nno marker\n");
    writeAgentFixture("feat-design-plan-agent");
    const { ctx } = makeCtx();

    const result = await startAutoJob({
      config: config({ completionMarker: "## 模型确认" }),
      ctx,
      jobId: JOB_ID,
    });

    expect(result.success).toBe(false);
    const reject = audits.find((a) => a.stage === "pipeline_auto_start_stage_rejected");
    expect(reject?.message?.missing).toBe("clarify-confirmation");
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.status).toBe("failed");
    // The pipeline was never started.
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.lastStage).toBeUndefined();
    expect(isAutoJobActive()).toBe(false);
  });

  it("judge 5b: a confirmed _Plan.md rejects plan with a develop/auto hint", async () => {
    writeJob({ startStage: "plan" });
    writeFile(REQUIREMENT, "# requirement\n## 模型确认\nconfirmed\n");
    writeFile(PLAN, "# plan\n## User Confirmation\nconfirmed\n");
    writeAgentFixture("feat-design-plan-agent");
    const ctx = makeCtx();
    const notified: string[] = [];
    const notifyCtx = {
      ...ctx.ctx,
      ui: { notify: (message: string) => notified.push(message), select: async () => undefined },
    };

    const result = await startAutoJob({ config: config(), ctx: notifyCtx, jobId: JOB_ID });

    expect(result.success).toBe(false);
    const reject = audits.find((a) => a.stage === "pipeline_auto_start_stage_rejected");
    expect(reject?.message?.missing).toBe("plan-confirmed");
    expect(notified.some((m) => m.includes('"develop" or "auto"'))).toBe(true);
  });

  it("judge 8: auto-derived plan start keeps basis requirement (not vetoed)", async () => {
    writeJobYaml(
      [
        "version: 1",
        "enabled: true",
        "tier: rule",
        "docs:",
        "  list:",
        `    - doc: ${REQUIREMENT}`,
        "  skipCompleted: false",
        "  onFailure: stop",
        "chain:",
        "  newSession: false",
        "defaults:",
        "  startStage: auto",
      ].join("\n"),
    );
    writeFile(REQUIREMENT, "# requirement\nno marker\n");
    writeFile(PLAN, "# plan\n## 目的\nnot confirmed\n");
    writeAgentFixture("feat-design-plan-agent");
    const { ctx } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.startStageDerivation).toBe("auto");
    expect(state.docs[0]?.startStageBasis).toBe("requirement");
    expect(state.docs[0]?.status).toBe("running");
  });
});

describe("224 e2e — running doc rows (judge 6, 7)", () => {
  it("judge 6: a second run on a running job is a no-op (no extra cleanup)", async () => {
    writeJob({ startStage: "plan" });
    writeFile(REQUIREMENT, "# requirement\n## 模型确认\nconfirmed\n");
    writeAgentFixture("feat-design-plan-agent");
    const { ctx } = makeCtx();

    const first = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    expect(first.success).toBe(true);
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.status).toBe("running");
    const cleanupsAfterFirst = audits.filter((a) => a.stage === "pipeline_auto_cleanup").length;
    // Live executor evidence for the running stage (probeable, manager live):
    // the guarded second run classifies the doc as actively running.
    installLiveManager();
    (ctx.session as unknown as { updateMeta: (p: Partial<SessionMeta>) => void }).updateMeta({
      activeSpawns: {
        plan: { agentName: "feat-design-plan-agent", agentId: "a-e2e-live-6", startedAt: Date.now(), source: "rpc" },
      },
    });
    void cleanupsAfterFirst;

    const second = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(second.success).toBe(true);
    expect(second.message).toContain("already running");
    // Not closed as job_completed: no cleanup audit AT ALL, sidecar status
    // stays running, lock retained.
    expect(audits.filter((a) => a.stage === "pipeline_auto_cleanup")).toHaveLength(0);
    expect(isAutoJobActive()).toBe(true);
    expect(readJobState(ROOT, JOB_ID)?.status).toBe("running");
  });

  it("judge 7: doc1 running → doc2 is NOT started (docIndex/pipelineId/doc unchanged)", async () => {
    writeJob({ startStage: "plan", extraDoc: "docs/design/201_Feat.md" });
    writeFile(REQUIREMENT, "# requirement\n## 模型确认\nconfirmed\n");
    writeFile("docs/design/201_Feat.md", "# second requirement\n");
    writeAgentFixture("feat-design-plan-agent");
    installLiveManager();
    const pipeId = "pipe-e2e-running";
    // Seed the first doc as RUNNING with live owner evidence (the guard's subject).
    const base = createJobState({
      jobId: JOB_ID,
      jobPath: `docs/jobs/${JOB_ID}.yaml`,
      jobHash: hashJobBytes(fs.readFileSync(path.join(ROOT, "docs", "jobs", `${JOB_ID}.yaml`), "utf8")),
      docs: [REQUIREMENT, "docs/design/201_Feat.md"].map((doc) => ({ doc })),
    });
    base.docs[0]!.status = "running";
    base.docs[0]!.pipelineId = pipeId;
    base.docs[0]!.lastStage = "develop";
    await writeJobState(ROOT, { ...base, status: "running" });
    const ctxMeta = {
      pipelineId: pipeId,
      currentStage: "develop",
      requirementDoc: REQUIREMENT,
      activeSpawns: { develop: probeTwinEntry() },
    } as unknown as SessionMeta;
    const { ctx } = makeCtx({ staticMeta: ctxMeta });

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(result.message).toContain("already running");
    const side = readJobState(ROOT, JOB_ID)!;
    expect(side.docIndex).toBe(0);
    expect(side.docs[0]?.pipelineId).toBe(pipeId);
    expect(side.docs[0]?.doc).toBe(REQUIREMENT);
    expect(side.docs[1]?.status).toBe("pending");
    expect(ctxMeta.requirementDoc).toBe(REQUIREMENT);
  });
});

describe("224 e2e — deferred dispatch row (judge 9)", () => {
  it("judge 9: a live twin defers the dispatch — the doc stays running, no failed", async () => {
    writeJob({ startStage: "plan" });
    writeFile(REQUIREMENT, "# requirement\n## 模型确认\nconfirmed\n");
    writeAgentFixture("feat-design-plan-agent");
    installLiveManager();
    const { ctx, meta, handoffs } = makeCtx({ twinStage: "review" });

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    const side = readJobState(ROOT, JOB_ID)!;
    expect(side.docs[0]?.status).toBe("running");
    expect(side.docs[0]?.failReason).toBeUndefined();
    // The honest queued copy (agent name, auto-start promise), NOT a failure.
    expect(result.message).toContain("queued behind a live feat-design-plan-agent");
    expect(handoffs).toHaveLength(0);
    // The deferred audit + the enqueue side-entry exist.
    expect(audits.some((a) => a.stage === "pipeline_resume_deferred")).toBe(true);
    expect(meta()?.pendingSpawns?.plan).toBeDefined();
  });
});
