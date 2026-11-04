/**
 * 224 Phase 2: the running-doc terminal guard.
 *
 * Scope: the pure classifier matrix (`classifyRunningDoc`) plus the COMMAND
 * wiring — a `running` doc is neither closed as a fake `job_completed` nor
 * followed by a second doc, and the refusal performs ZERO writes (sidecar
 * baseline: only the `updatedAt` ramp `startAutoJob` itself made).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineJsonConfig, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { startAutoJob } from "../../commands/pipeline-auto";
import { isAutoJobActive, acquireJobLock, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { readJobState, writeJobState, createJobState, type AutoJobState } from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { ACTIVE_SPAWN_TTL_MS } from "../../constants";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import {
  classifyRunningDoc,
  describeAlreadyRunning,
  findRunningDoc,
  type RunningDocHit,
} from "../../core/auto-pipeline/running-doc-guard";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "guard_loop";
const DOCS = ["docs/design/a.md", "docs/design/b.md"];
const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "tier: rule",
  "docs:",
  "  list:",
  `    - doc: ${DOCS[0]}`,
  `    - doc: ${DOCS[1]}`,
  "  skipCompleted: false",
  "  onFailure: stop",
  "chain:",
  "  newSession: false",
].join("\n");

/** Manager singleton symbol (mirrors subagents-introspect's probe seam). */
const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
const registry = globalThis as Record<symbol, unknown>;

let ROOT: string;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

function installManager(record: { status?: string }): void {
  registry[MANAGER_SYMBOL] = { getRecord: () => record, hasRunning: () => true };
}

function uninstallManager(): void {
  delete registry[MANAGER_SYMBOL];
}

function setupRoot(): void {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-224-guard-"));
  const jobPath = path.join(ROOT, "docs", "jobs", `${JOB_ID}.yaml`);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, JOB_YAML, "utf8");
}

function config(): Parameters<typeof startAutoJob>[0]["config"] {
  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: ROOT };
  const jsonPath = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  const resolved = resolvePipelineConfig(json);
  for (const stage of Object.values(resolved.stages)) {
    if (stage) delete (stage as { verify?: unknown }).verify;
  }
  return resolved;
}

/** Seeds a sidecar whose FIRST doc is `running` and locks it (pre-start shape). */
async function seedRunningState(): Promise<AutoJobState> {
  const base = createJobState({
    jobId: JOB_ID,
    jobPath: `docs/jobs/${JOB_ID}.yaml`,
    jobHash: hashJobBytes(JOB_YAML),
    docs: DOCS.map((doc) => ({ doc })),
  });
  base.docs[0]!.status = "running";
  base.docs[0]!.lastStage = "develop";
  base.docs[0]!.updatedAt = 1000;
  const state: AutoJobState = {
    ...base,
    status: "running",
    updatedAt: 1000,
    // The guard MUST run before applyOverlay: a seeded snapshot proves nothing
    // rewrote it.
    overlaySnapshot: {
      appliedAt: 900,
      jobHash: base.jobHash,
      before: {},
      entries: [],
    },
  };
  await writeJobState(ROOT, state);
  const lock = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
  if (!lock.ok) throw new Error("seed lock failed");
  return state;
}

function writeDoc(rel: string): void {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `# ${rel}\n`, "utf8");
}

function makeCtx(opts: { meta?: SessionMeta } = {}) {
  let meta: SessionMeta | undefined = opts.meta ?? undefined;
  return {
    ctx: {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
          return meta;
        },
      },
      ui: { notify: (message: string) => undefined, select: async () => undefined },
      pi: { sendUserMessage: () => undefined },
    },
    meta: () => meta,
  };
}

/** Sidecar snapshot for the zero-write baseline (updatedAt normalized away). */
function sidecarBaseline(): Record<string, unknown> | null {
  const state = readJobState(ROOT, JOB_ID);
  if (!state) return null;
  const { updatedAt: _updatedAt, ...rest } = state as AutoJobState & Record<string, unknown>;
  return rest as Record<string, unknown>;
}

beforeEach(() => {
  setupRoot();
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
  uninstallManager();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("guard — classifyRunningDoc pure matrix", () => {
  const hit: RunningDocHit = { index: 0, doc: DOCS[0]!, stage: "develop", pipelineId: "pipe-1" };

  function ev(overrides: Partial<Parameters<typeof classifyRunningDoc>[1]>): Parameters<typeof classifyRunningDoc>[1] {
    return {
      metaPipelineId: "pipe-1",
      metaStage: "develop",
      hasPendingSpawn: false,
      probeAgent: () => "unknown",
      now: 1000,
      ...overrides,
    };
  }

  it("meta belongs elsewhere / stage mismatch → stalled", () => {
    expect(classifyRunningDoc(hit, ev({ metaPipelineId: "pipe-2" }))).toBe("stalled");
    expect(classifyRunningDoc(hit, ev({ metaStage: "review" }))).toBe("stalled");
  });

  it("a queued pending spawn means a live chain (no probe needed)", () => {
    expect(classifyRunningDoc(hit, ev({ hasPendingSpawn: true }))).toBe("running");
  });

  it("probe live → running; probe unknown degrades on the TTL; settled → stalled", () => {
    const withAgent = { agentId: "a1", startedAt: 900 };
    expect(classifyRunningDoc(hit, ev({ activeSpawn: withAgent, probeAgent: () => "live" }))).toBe("running");
    // unknown + inside TTL → running (fail-open probe parity with 218).
    expect(classifyRunningDoc(hit, ev({ activeSpawn: withAgent }))).toBe("running");
    expect(classifyRunningDoc(hit, ev({ activeSpawn: withAgent, now: 900 + (31 * 60_000) }))).toBe("stalled");
    expect(classifyRunningDoc(hit, ev({ activeSpawn: withAgent, probeAgent: () => "settled" }))).toBe("stalled");
  });

  it("a reserved (id-less) in-flight dispatch degrades on the TTL too", () => {
    expect(classifyRunningDoc(hit, ev({ activeSpawn: { reserved: true, startedAt: 999 } }))).toBe("running");
    expect(classifyRunningDoc(
      hit,
      ev({ activeSpawn: { reserved: true, startedAt: 0 }, now: ACTIVE_SPAWN_TTL_MS }),
    )).toBe("stalled");
  });

  it("no evidence at all → stalled", () => {
    expect(classifyRunningDoc(
      { ...hit, stage: undefined },
      ev({ metaStage: undefined, metaPipelineId: undefined }),
    )).toBe("stalled");
  });
});

describe("guard — describeAlreadyRunning copy + audit", () => {
  const hit: RunningDocHit = { index: 0, doc: DOCS[0]!, stage: "develop", pipelineId: "pipe-1" };

  it("mode running → the wait message; mode stalled → the resume message", () => {
    const running = describeAlreadyRunning({ jobId: JOB_ID, totalDocs: 2, hit, mode: "running" });
    expect(running.message).toContain(`Auto job "${JOB_ID}": doc 1/2 (${DOCS[0]}) is already running at stage "develop"`);
    expect(running.message).toContain("Wait for it to settle (or run /pipeline-resume)");
    const stalled = describeAlreadyRunning({ jobId: JOB_ID, totalDocs: 2, hit, mode: "stalled" });
    expect(stalled.message).toContain('recorded as running at stage "develop"');
    expect(stalled.message).toContain("Run /pipeline-resume to continue");
    // The audit row always carries the required fields.
    expect(running.audit).toEqual({ jobId: JOB_ID, doc: DOCS[0], stage: "develop", mode: "running" });
  });

  it("a legacy sidecar without lastStage keeps the honest (unknown) stage", () => {
    const legacy = describeAlreadyRunning({
      jobId: JOB_ID, totalDocs: 2, hit: { ...hit, stage: undefined }, mode: "stalled",
    });
    expect(legacy.message).toContain('stage "(unknown)"');
    expect(legacy.audit.stage).toBe("(unknown)");
  });
});

describe("guard — findRunningDoc", () => {
  function partialState(docs: AutoJobState["docs"]): AutoJobState {
    return { ...createJobState({ jobId: "j", jobPath: "p", jobHash: "h", docs: [{ doc: "d" }] }), docs } as AutoJobState;
  }

  it("finds the first running doc; all-terminal state is not a hit", () => {
    expect(findRunningDoc(partialState([
      { doc: DOCS[0]!, status: "completed", updatedAt: 0 },
      { doc: DOCS[1]!, status: "running", updatedAt: 0, lastStage: "develop" },
    ]))).toEqual({ index: 1, doc: DOCS[1], stage: "develop", pipelineId: undefined });
    expect(findRunningDoc(partialState([
      { doc: DOCS[0]!, status: "completed", updatedAt: 0 },
      { doc: DOCS[1]!, status: "pending", updatedAt: 0 },
    ]))).toBeNull();
  });
});

describe("guard — the wiring refuses a running doc without side effects", () => {
  it("single running doc with LIVE evidence → mode running, no second start, zero writes", async () => {
    installManager({ status: "running" });
    const pipeId = "pipe-live-1";
    await writeJobState(ROOT, await seedRunningState());
    const before = sidecarBaseline();
    const ctxMeta = {
      pipelineId: pipeId,
      currentStage: "develop",
      activeSpawns: {
        develop: {
          agentName: "develop-agent",
          agentId: "a-live",
          startedAt: Date.now(),
          source: "rpc",
        },
      },
    } as unknown as SessionMeta;
    const { ctx } = makeCtx({ meta: ctxMeta });

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(result.message).toContain("already running at stage");
    expect(result.message).toContain("Wait for it to settle");
    expect(audits).toContain("pipeline_auto_already_running");
    expect(audits).not.toContain("pipeline_auto_cleanup");
    // Zero-write baseline: nothing but updatedAt moved.
    expect(sidecarBaseline()).toEqual(before);
    expect(isAutoJobActive()).toBe(true);
    // The guard ran BEFORE applyOverlay — the seeded snapshot survived.
    expect(readJobState(ROOT, JOB_ID)?.overlaySnapshot?.appliedAt).toBe(900);
  });

  it("single running doc with NO live evidence → mode stalled + resume guide", async () => {
    await writeJobState(ROOT, await seedRunningState());
    // The owner session truth belongs to ANOTHER run → ownership mismatch.
    const ctxMeta = { pipelineId: "pipe-other", currentStage: "review" } as unknown as SessionMeta;
    const { ctx } = makeCtx({ meta: ctxMeta });

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(result.message).toContain("no live executor exists");
    expect(result.message).toContain("Run /pipeline-resume to continue");
    expect(audits).toContain("pipeline_auto_already_running");
    expect(sidecarBaseline()).toEqual(sidecarBaseline()); // stable read shape
  });

  it("running doc + pending doc → the SECOND doc is NOT started (serial invariant)", async () => {
    installManager({ status: "running" });
    const pipeId = "pipe-rp-3";
    await writeJobState(ROOT, await seedRunningState());
    writeDoc(DOCS[1]!);
    const ctxMeta = {
      pipelineId: pipeId,
      currentStage: "develop",
      activeSpawns: {
        develop: {
          agentName: "develop-agent",
          agentId: "a-live-rp",
          startedAt: Date.now(),
          source: "rpc",
        },
      },
    } as unknown as SessionMeta;
    const { ctx } = makeCtx({ meta: ctxMeta });

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    const side = readJobState(ROOT, JOB_ID)!;
    expect(side.docs[0]?.status).toBe("running");
    expect(side.docs[1]?.status).toBe("pending");
    expect(side.docIndex).toBe(0);
    expect(side.docs[1]?.pipelineId).toBeUndefined();
  });

  it("all-terminal state still finalizes the job (the guard does not block completion)", async () => {
    const state = await seedRunningState();
    state.docs[0]!.status = "completed";
    state.docs[1]!.status = "skipped";
    await writeJobState(ROOT, state);
    const { ctx } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(audits).not.toContain("pipeline_auto_already_running");
    expect(readJobState(ROOT, JOB_ID)?.status).toBe("completed");
  });

  it("normal serial continuation (doc0 completed, doc1 pending) still starts doc1", async () => {
    const state = await seedRunningState();
    state.docs[0]!.status = "completed";
    await writeJobState(ROOT, state);
    writeDoc(DOCS[1]!);
    const { ctx } = makeCtx();
    const agentDir = path.join(ROOT, ".pi", "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.copyFileSync(
      path.join(SRC_ROOT, "src", "template", "agents", "feat-design-plan-agent.md"),
      path.join(agentDir, "feat-design-plan-agent.md"),
    );

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    const side = readJobState(ROOT, JOB_ID)!;
    expect(side.docIndex).toBe(1);
    expect(side.docs[1]?.status).toBe("running");
    expect(audits).not.toContain("pipeline_auto_already_running");
  });
});
