/**
 * 224 Phase 1: the start-stage dispatch decision, mapping, copy and wiring.
 *
 * Scope: the PURE matrix (`shouldDispatchStartStage`, `mapSpawnResultToOutcome`,
 * `describeStartDispatch`, `checkStartDispatchable`, the stamp re-check) plus
 * the COMMAND wiring (`startAutoJob` → dispatch in the same round). Outcomes
 * are covered by the 9-row exhaustive table of 224_Bug_Plan.md Phase 1.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, PipelineStage, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { startAutoJob } from "../../commands/pipeline-auto";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { readJobState } from "../../core/auto-pipeline/job-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import {
  checkStartDispatchable,
  describeStartDispatch,
  hasStartDispatchChannel,
  isFatalStartDispatchOutcome,
  isStartStageAlreadyDispatched,
  mapSpawnResultToOutcome,
  shouldDispatchStartStage,
} from "../../core/auto-pipeline/start-stage-dispatch";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "dispatch_loop";
const REQUIREMENT = "docs/design/200_Feat.md";
const FALLBACK_AUDIT = "stage_spawn_fallback";
const UNEXECUTABLE_AUDIT = "pipeline_auto_start_stage_unexecutable";

let ROOT: string;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

function jobYaml(startStage: string): string {
  return [
    "version: 1",
    "enabled: true",
    "tier: rule",
    "docs:",
    "  list:",
    `    - doc: ${REQUIREMENT}`,
    `      startStage: ${startStage}`,
    "  skipCompleted: false",
    "  onFailure: stop",
    "chain:",
    "  newSession: false",
  ].join("\n");
}

function writeJob(yaml: string): void {
  const jobPath = path.join(ROOT, "docs", "jobs", `${JOB_ID}.yaml`);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, yaml, "utf8");
}

function writeFile(rel: string, content: string): void {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function writeAgentFixtures(): void {
  const dir = path.join(ROOT, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [
    "feat-design-plan-agent",
    "design-review-agent",
    "develop-agent",
    "code-review-agent",
    "code-review-withfix-agent",
  ]) {
    fs.copyFileSync(
      path.join(SRC_ROOT, "src", "template", "agents", `${name}.md`),
      path.join(dir, `${name}.md`),
    );
  }
}

function config(): PipelineConfig {
  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: ROOT };
  const jsonPath = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  const resolved = resolvePipelineConfig(json);
  for (const stage of Object.values(resolved.stages)) {
    if (stage) delete (stage as { verify?: unknown }).verify;
  }
  return { ...resolved, configSourcePath: jsonPath };
}

function makeCtx(opts: { pi?: Record<string, unknown> | null } = {}) {
  let meta: SessionMeta | undefined;
  const notified: string[] = [];
  const handoffs: string[] = [];
  return {
    ctx: {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
          return meta;
        },
      },
      ui: { notify: (message: string) => notified.push(message), select: async () => undefined },
      ...(opts.pi === null ? {} : { pi: opts.pi ?? { sendUserMessage: (message: string) => { handoffs.push(message); } } }),
    },
    meta: () => meta,
    notified,
    handoffs,
  };
}

/**
 * One agent fixture copy + the requirement doc, BEFORE startAutoJob, and a
 * wiring runner: returns the startAutoJob result plus the job sidecar.
 */
async function runPlanStart(opts: { pi?: Record<string, unknown> | null } = {}): Promise<{
  result: Awaited<ReturnType<typeof startAutoJob>>;
  state: NonNullable<ReturnType<typeof readJobState>>;
  handoffs: string[];
}> {
  writeJob(jobYaml("plan"));
  writeFile(REQUIREMENT, "# requirement\n");
  if (opts.pi !== null) writeAgentFixtures();
  const { ctx, handoffs } = makeCtx(opts);
  const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
  return { result, state: readJobState(ROOT, JOB_ID)!, handoffs };
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-224-dispatch-"));
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

describe("224 phase 1 — pure start-stage dispatch matrix", () => {
  it("only a real spec-jump stage is dispatched", () => {
    expect(shouldDispatchStartStage({ stage: "clarify", clarifyAdvanceHandled: false })).toBe(false);
    expect(shouldDispatchStartStage({ stage: "completed", clarifyAdvanceHandled: false })).toBe(false);
    expect(shouldDispatchStartStage({ stage: "awaiting_human", clarifyAdvanceHandled: false })).toBe(false);
    expect(shouldDispatchStartStage({ stage: "plan", clarifyAdvanceHandled: true })).toBe(false);
    for (const stage of ["plan", "design-review", "develop", "review", "fix"] as PipelineStage[]) {
      expect(shouldDispatchStartStage({ stage, clarifyAdvanceHandled: false })).toBe(true);
    }
  });

  it("isFatalStartDispatchOutcome only for conflict_blocked/not_sent", () => {
    expect(isFatalStartDispatchOutcome("conflict_blocked")).toBe(true);
    expect(isFatalStartDispatchOutcome("not_sent")).toBe(true);
    for (const outcome of [
      "spawned", "fallback", "deferred", "queued", "already_running",
      "unknown", "handled_elsewhere", "not_applicable",
    ] as const) {
      expect(isFatalStartDispatchOutcome(outcome)).toBe(false);
    }
  });

  it("maps the EXISTING spawn result exhaustively (9-row table)", () => {
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, dispatchOutcome: "conflict_blocked" })).toBe("conflict_blocked");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, queuedForOwner: true })).toBe("queued");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, dispatchOutcome: "queued_owner" })).toBe("queued");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, deferred: true })).toBe("deferred");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, dispatchOutcome: "deferred" })).toBe("deferred");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, dispatchOutcome: "skipped_duplicate" })).toBe("already_running");
    expect(mapSpawnResultToOutcome({ spawned: true, fallback: true })).toBe("fallback");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, dispatchOutcome: "fallback_no_id" })).toBe("fallback");
    expect(mapSpawnResultToOutcome({ spawned: true, fallback: false })).toBe("spawned");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, dispatchOutcome: "unknown" })).toBe("unknown");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false, dispatchOutcome: "strict_blocked" })).toBe("handled_elsewhere");
    expect(mapSpawnResultToOutcome({ spawned: false, fallback: false })).toBe("not_sent");
    // Priority: an explicit conflict beats the boolean flags.
    expect(mapSpawnResultToOutcome({ spawned: true, fallback: false, queuedForOwner: true, dispatchOutcome: "conflict_blocked" })).toBe("conflict_blocked");
  });

  it("produces ONE honest sentence per outcome (agent name, no enum leaks)", () => {
    const ctx = { stage: "plan" as PipelineStage, agentName: "feat-design-plan-agent" };
    expect(describeStartDispatch("spawned", ctx)).toBe("dispatched feat-design-plan-agent for stage plan");
    expect(describeStartDispatch("fallback", ctx)).toBe("dispatched feat-design-plan-agent for stage plan");
    expect(describeStartDispatch("queued", ctx)).toBe("queued behind a live feat-design-plan-agent; it starts automatically when the current run settles");
    expect(describeStartDispatch("deferred", ctx)).toBe("queued behind a live feat-design-plan-agent; it starts automatically when the current run settles");
    expect(describeStartDispatch("already_running", ctx)).toBe("feat-design-plan-agent is already running for stage plan");
    expect(describeStartDispatch("unknown", ctx)).toBe("dispatch outcome unknown for stage plan; verify before re-running");
    expect(describeStartDispatch("handled_elsewhere", ctx)).toBe("handed to the existing decision chain (no new dispatch)");
    expect(describeStartDispatch("not_applicable", ctx)).toBe("no plugin dispatch needed for stage plan");
    // No internal enum word leaks into user-facing copy.
    for (const outcome of [
      "spawned", "fallback", "queued", "deferred", "already_running",
      "unknown", "handled_elsewhere", "not_applicable",
    ] as const) {
      const copy = describeStartDispatch(outcome, ctx);
      for (const leak of ["fallback_no_id", "queued_owner", "spawned_id", "strict_blocked", "skipped_duplicate", "not_sent"]) {
        expect(copy.includes(leak)).toBe(false);
      }
    }
    // Boundary: an unconfigured agent keeps the honest placeholder (no throw).
    expect(describeStartDispatch("spawned", { stage: "plan", agentName: "(unconfigured agent)" })).toBe(
      "dispatched (unconfigured agent) for stage plan",
    );
  });

  it("hasStartDispatchChannel accepts the RPC channel too", () => {
    expect(hasStartDispatchChannel(undefined)).toBe(false);
    expect(hasStartDispatchChannel({})).toBe(false);
    expect(hasStartDispatchChannel({ sendUserMessage: () => undefined })).toBe(true);
    expect(hasStartDispatchChannel({ events: { emit: () => undefined } })).toBe(true);
  });

  it("checkStartDispatchable requires BOTH agent mapping and a channel", () => {
    const stageConfig = { agentPath: "agents/develop.md" } as never;
    const cfgWithAgent = { stages: { develop: stageConfig }, projectRoot: ROOT } as unknown as PipelineConfig;
    const cfgWithoutAgent = { stages: { review: null }, projectRoot: ROOT } as unknown as PipelineConfig;
    // no_agent: unconfigured agent path
    expect(checkStartDispatchable({ config: cfgWithoutAgent, stage: "review", pi: { sendUserMessage: () => undefined } })).toEqual({ ok: false, reason: "no_agent" });
    // no_channel: agent resolvable, pi silent
    fs.mkdirSync(path.join(ROOT, "agents"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "agents", "develop.md"), "name: develop-agent\n", "utf8");
    expect(checkStartDispatchable({ config: cfgWithAgent, stage: "develop", pi: undefined })).toEqual({ ok: false, reason: "no_channel" });
    // both resolvable
    expect(checkStartDispatchable({ config: cfgWithAgent, stage: "develop", pi: { sendUserMessage: () => undefined } })).toEqual({ ok: true });
  });

  it("stamp re-check: only a visit-stamped stage counts as already running", () => {
    expect(isStartStageAlreadyDispatched(undefined, "plan")).toBe(false);
    expect(isStartStageAlreadyDispatched({}, "plan")).toBe(false);
    expect(isStartStageAlreadyDispatched({ spawnedStages: { plan: 42 }, stageStartTime: 42 }, "plan")).toBe(true);
    // A stamp of ANOTHER stage (or another visit time) does not match.
    expect(isStartStageAlreadyDispatched({ spawnedStages: { plan: 7 }, stageStartTime: 42 }, "plan")).toBe(false);
    expect(isStartStageAlreadyDispatched({ spawnedStages: { develop: 42 }, stageStartTime: 42 }, "plan")).toBe(false);
  });
});

describe("224 phase 1 — auto runner dispatch wiring", () => {
  it("plan start with a stub channel dispatches EXACTLY once (fallback handoff)", async () => {
    const { result, state, handoffs } = await runPlanStart();
    expect(result.success).toBe(true);
    expect(state.docs[0]?.status).toBe("running");
    // One followUp handoff for the plan executor (both audit + message proof).
    expect(audits.filter((stage) => stage === FALLBACK_AUDIT)).toHaveLength(1);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toContain("[plugin auto-handoff] @feat-design-plan-agent");
    // Outcome lands in the runner message (agent name, honest sentence).
    expect(result.message).toContain("; dispatched feat-design-plan-agent for stage plan");
    // The auto track NEVER prints the human-track manual hint.
    expect(result.message).not.toContain("Run the plan agent to continue");
  });

  it("advance-handled clarify dispatches are never doubled", async () => {
    // A confirmed clarify starts the advance chain, which dispatches the plan
    // executor itself; the start-stage dispatch must therefore SKIP.
    writeJob(jobYaml("clarify"));
    writeFile(REQUIREMENT, "# requirement\n## 第 1 轮\n## 模型确认\nconfirmed\n");
    writeAgentFixtures();
    const { ctx } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    expect(result.success).toBe(true);
    // Exactly ONE executor spawn overall (the plan advance), one clean chain.
    expect(audits.filter((stage) => stage === FALLBACK_AUDIT)).toHaveLength(1);
    expect(result.message).toContain("clarify confirmed → advanced to");
    expect(result.message).not.toContain("; dispatched");
  });

  it("a missing dispatch channel fails the doc BEFORE any pipeline exists", async () => {
    const { result, state } = await runPlanStart({ pi: null });
    expect(result.success).toBe(false);
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[0]?.failReason).toBe("start_stage_unexecutable");
    expect(state.docs[0]?.lastStage).toBeUndefined();
    expect(state.docIndex).toBe(0);
    const unexecutable = audits.filter((stage) => stage === UNEXECUTABLE_AUDIT);
    expect(unexecutable).toHaveLength(1);
    // The P-A pre-check fires BEFORE startNewPipeline — never a pipeline audit.
    expect(audits).not.toContain("pipeline_start");
  });

  it("unconfigured agent mapping fails the doc BEFORE the pipeline exists", async () => {
    writeJob(jobYaml("plan"));
    writeFile(REQUIREMENT, "# requirement\n");
    // No agent fixture: resolveAgentMention returns null → no_agent.
    const { ctx } = makeCtx();
    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });
    expect(result.success).toBe(false);
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.failReason).toBe("start_stage_unexecutable");
    expect(audits).not.toContain("pipeline_start");
  });

  it("unreadable session meta at the dispatch seam does not throw (fail-open)", async () => {
    writeJob(jobYaml("plan"));
    writeFile(REQUIREMENT, "# requirement\n");
    writeAgentFixtures();
    let meta: SessionMeta | undefined;
    const ctx = {
      session: {
        // Once the run is committed (pipelineId set = post-start), the session
        // truth becomes unreadable — the dispatch seam fail-opens.
        getMeta: () => (meta?.pipelineId ? undefined : meta),
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
          return meta;
        },
      },
      ui: { notify: (message: string) => undefined, select: async () => undefined },
      pi: { sendUserMessage: () => undefined },
    };
    const result = await startAutoJob({ config: config(), ctx: ctx as never, jobId: JOB_ID });
    expect(result.success).toBe(true);
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.status).toBe("running");
    // No dispatch was attempted (no fallback audit), nothing fatal was reported.
    expect(audits).not.toContain(FALLBACK_AUDIT);
    expect(audits).not.toContain(UNEXECUTABLE_AUDIT);
  });
});
