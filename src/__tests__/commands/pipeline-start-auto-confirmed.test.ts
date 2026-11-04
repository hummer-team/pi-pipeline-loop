/**
 * 223 Phase 2: `/pipeline-start` on an already-confirmed document — the
 * deferred-advance contract, observed end to end.
 *
 * Why the advance is DEFERRED here (and not done in the command round):
 * `buildStartMeta` deliberately clears `autoJob` (`buildNewPeriodResetFields`),
 * so when `maybeAutoLaunchClarify` runs the auto contract is not established
 * yet. The command therefore reports `clarifyAdvancePending: true` and the auto
 * runner (`startPendingDoc`) stamps `meta.autoJob` and THEN calls
 * `advanceConfirmedClarifyOnStartup`. This suite pins that hand-off:
 *
 * - the command result stays `currentStage: "clarify"` with the pending flag —
 *   no half-truth about a stage the session is not on yet, and NO
 *   `clarify_startup_advanced` audit in that round;
 * - the `pipeline_start` audit still records `startStage: "clarify"` (the
 *   startup stage is not rewritten by the advance — convergence item 3);
 * - after the runner-style `autoJob` stamp the advance happens in the SAME
 *   round: the session meta reaches the next stage, `clarify_startup_advanced`
 *   names exactly that stage, and the target is the configured `nextStage`.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import { createPipelineStartCommand, resumePipeline } from "../../commands/pipeline-start";
import { advanceConfirmedClarifyOnStartup } from "../../core/clarify-startup-advance";
import { createPipelineUI } from "../../core/pipeline-ui";
import { startAutoJob } from "../../commands/pipeline-auto";
import { writeJobState } from "../../core/auto-pipeline/job-state";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import {
  createAutoHarness,
  createSessionStub,
  HARNESS_DOCS,
  HARNESS_JOB_ID,
  type AutoHarness,
} from "../auto-pipeline/auto-harness";
import { auditLogFileFor, makeTestMeta } from "../helpers";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOC = HARNESS_DOCS[0]!;

const MANDATORY = [
  "## 目标",
  "Advance the confirmed clarify round at startup.",
  "## 范围",
  "The start round only.",
  "## 验收标准",
  "The session reaches the next stage.",
];

/** A document the SHARED decision layer derives as `confirmed`. */
const CONFIRMED_DOC = [
  "# 223_Bug",
  ...MANDATORY,
  "",
  "# 第 1 轮澄清",
  "- **方案 A** self-answer",
  "答：方案 A",
  "full-und? 理解确认：是",
  "",
  "## 模型确认",
  "是",
].join("\n");

let harness: AutoHarness;
let sent: Array<{ msg: string; opts?: unknown }>;
let safeAudits: string[];
let errorSpy: ReturnType<typeof spyOn>;

function writeDoc(text: string): void {
  const abs = path.join(harness.projectRoot, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/** Stage agent definitions (the command refuses to start without them). */
function writeStageAgents(): void {
  const dir = path.join(harness.projectRoot, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [
    "feat-design-plan-agent",
    "design-review-agent",
    "develop-agent",
    "code-review-agent",
    "code-review-withfix-agent",
  ]) {
    fs.writeFileSync(path.join(dir, `${name}.md`), "---\nname: test-agent\ntools: read\n---\nagent body\n", "utf8");
  }
}

/** The production clarify contract the derivation parses (`deployClarifySpec`). */
function deployClarifySpec(): void {
  const target = path.join(harness.projectRoot, ".pi", "references", "clarify_spec", "verify.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"), target);
}

/** The real audit log of one pipeline (written by `writeStageAudit`). */
async function readPipelineAudit(pipelineId: string | undefined): Promise<string> {
  if (!pipelineId) return "";
  try {
    return await readFile(auditLogFileFor(path.join(harness.projectRoot, ".pi", "audit"), pipelineId), "utf-8");
  } catch {
    return "";
  }
}

function safeEvents(stage: string): string[] {
  return safeAudits.filter((line) => line.startsWith(`${stage} `));
}

/** A fresh (no pipeline yet) session context for the command. */
function makeCommandCtx() {
  const stub = createSessionStub(undefined);
  return {
    stub,
    ctx: {
      session: stub.session,
      ui: stub.ui,
      pi: { sendUserMessage: (msg: string, opts?: unknown) => { sent.push({ msg, opts }); } },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    },
  };
}

/** What the auto runner stamps after `startNewPipeline` returns (M2). */
function autoJobBlock(): NonNullable<SessionMeta["autoJob"]> {
  return {
    jobId: HARNESS_JOB_ID,
    jobPath: `docs/jobs/${HARNESS_JOB_ID}.yaml`,
    docIndex: 0,
    totalDocs: HARNESS_DOCS.length,
  };
}

beforeEach(async () => {
  __resetAutoJobLockForTests();
  harness = createAutoHarness();
  await harness.install();
  writeDoc(CONFIRMED_DOC);
  writeStageAgents();
  deployClarifySpec();
  await initAuditLog(harness.config);
  sent = [];
  safeAudits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    safeAudits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  harness.dispose();
});

describe("/pipeline-start on a confirmed document — deferred advance", () => {
  it("reports the pending advance instead of a stage the session is not on yet", async () => {
    const { ctx } = makeCommandCtx();

    const result = (await createPipelineStartCommand(harness.config).execute({ file: DOC }, ctx as never)) as {
      success: boolean;
      error?: string;
      currentStage?: PipelineStage;
      pipelineId?: string;
      clarifyAdvancePending?: boolean;
    };

    expect(result.success).toBe(true);
    // Truth ①: the session really is still on clarify at this instant.
    expect(result.currentStage).toBe<PipelineStage>("clarify");
    expect(ctx.session.getMeta()?.currentStage).toBe<PipelineStage>("clarify");
    // Truth ②: the advance is explicitly owed, not silently dropped.
    expect(result.clarifyAdvancePending).toBe(true);
    // Nothing advanced in this round → no advance audit yet.
    expect(safeEvents("clarify_startup_advanced")).toHaveLength(0);
  });

  it("keeps the startup stage in the pipeline_start audit", async () => {
    const { ctx } = makeCommandCtx();

    const result = (await createPipelineStartCommand(harness.config).execute({ file: DOC }, ctx as never)) as {
      success: boolean;
      pipelineId?: string;
    };

    expect(result.success).toBe(true);
    const log = await readPipelineAudit(result.pipelineId);
    expect(log).toContain("pipeline_start");
    // The advance (when it happens) must never rewrite the recorded startup
    // stage — the audit says how the run STARTED, the advance audit says where
    // it went.
    expect(log).toMatch(/pipeline_start \| pipelineId=.* \| .*startStage=clarify/);
  });

  it("the runner-side advance lands on the SAME stage the audit names", async () => {
    const { ctx } = makeCommandCtx();
    const result = (await createPipelineStartCommand(harness.config).execute({ file: DOC }, ctx as never)) as {
      success: boolean;
      pipelineId?: string;
      clarifyAdvancePending?: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.clarifyAdvancePending).toBe(true);

    // The auto runner stamps the contract AFTER the start (M2) …
    ctx.session.updateMeta({ autoJob: autoJobBlock() });
    const freshMeta = ctx.session.getMeta() as SessionMeta;

    // … and only then performs the deferred advance, in the same round.
    const outcome = await advanceConfirmedClarifyOnStartup(
      { session: ctx.session, pi: ctx.pi },
      harness.config,
      freshMeta,
      createPipelineUI(harness.config),
    );

    const expectedTarget = harness.config.stages.clarify?.nextStage as PipelineStage;
    expect(outcome).toEqual({ advanced: true, toStage: expectedTarget });
    expect(ctx.session.getMeta()?.currentStage).toBe(expectedTarget);

    // Return truth, session meta and audit agree on the target stage.
    const advanced = safeEvents("clarify_startup_advanced");
    expect(advanced).toHaveLength(1);
    expect(advanced[0]).toContain(`"toStage":"${expectedTarget}"`);
    expect(advanced[0]).toContain(`"requirementDoc":"${DOC}"`);

    // The sidecar follows the same target (single write point).
    expect(harness.state().docs[0]!.lastStage).toBe<PipelineStage>(expectedTarget);
    // The startup-stage audit is unchanged by the advance.
    const log = await readPipelineAudit(result.pipelineId);
    expect(log).toMatch(/pipeline_start \| pipelineId=.* \| .*startStage=clarify/);
  });
});

// 223 review issue 7 (M6): the PRODUCTION consumer of `clarifyAdvancePending`
// is the auto runner (`startPendingDoc`), not a hand-written replay. This case
// drives the real `startAutoJob` so the wiring, the message truth and the
// sidecar/stage bookkeeping are all pinned together.
describe("the auto runner consumes the pending advance itself", () => {
  it("startAutoJob advances the confirmed document and reports it in the message", async () => {
    // Hand the document back to the runner: the harness pre-installs a RUNNING
    // sidecar, which would look like a continuation rather than a first start.
    const state = harness.state();
    state.docs[0]!.status = "pending";
    await writeJobState(harness.projectRoot, state);
    __resetAutoJobLockForTests();

    const { ctx } = makeCommandCtx();
    const result = await startAutoJob({ config: harness.config, ctx: ctx as never, jobId: HARNESS_JOB_ID });

    expect(result.success).toBe(true);
    const expectedTarget = harness.config.stages.clarify?.nextStage as PipelineStage;
    // Truth ①: the message states the advance it really performed.
    expect(result.message ?? "").toContain(`clarify confirmed → advanced to ${expectedTarget}`);
    // Truth ②: the advance audit names exactly that stage, once.
    const advanced = safeEvents("clarify_startup_advanced");
    expect(advanced).toHaveLength(1);
    expect(advanced[0]).toContain(`"toStage":"${expectedTarget}"`);
    // Truth ③: no CLARIFY executor was dispatched for an already-confirmed doc
    // — the only handoff is the NEXT stage's executor.
    expect(safeEvents("stage_spawn_fallback").some((line) => line.includes('"stage":"clarify"'))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.startsWith("[plugin auto-handoff]")).toBe(true);
    // Truth ④: the sidecar follows the stage it is really on.
    expect(harness.state().docs[0]!.lastStage).toBe<PipelineStage>(expectedTarget);
  });
});

/**
 * 223 review issue 1 (High) regression net: the RESUME host advances the
 * confirmed clarify stage in place, so its return value / message must report
 * the stage the session really reached — not the landing stage it resumed from.
 */
describe("/pipeline-resume on a confirmed document — advance truth", () => {
  const PIPELINE_ID = "pipe-223-resume";

  function makeResumeCtx() {
    const meta = makeTestMeta({
      currentStage: "clarify",
      flowState: "running",
      requirementDoc: DOC,
      pipelineId: PIPELINE_ID,
    });
    const stub = createSessionStub(meta);
    const ctx = {
      session: stub.session,
      ui: stub.ui,
      pi: { sendUserMessage: (msg: string, opts?: unknown) => { sent.push({ msg, opts }); } },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    };
    return { meta, stub, ctx };
  }

  it("reports the stage the session reached, matching the persisted meta and the audit", async () => {
    const state = harness.state();
    state.docs[0]!.pipelineId = PIPELINE_ID;
    await writeJobState(harness.projectRoot, state);

    const { meta, stub, ctx } = makeResumeCtx();
    const result = await resumePipeline(
      ctx,
      meta,
      harness.config,
      createPipelineUI(harness.config),
      DOC,
      "resume_menu_restore",
    );
    const expectedTarget = harness.config.stages.clarify?.nextStage as PipelineStage;

    // Persisted truth first: the advance really happened.
    expect(stub.meta()?.currentStage).toBe(expectedTarget);
    // Return truth: no stale "clarify" claim (invariant 5).
    expect(result.success).toBe(true);
    expect(result.currentStage).toBe(expectedTarget);
    expect(result.message).toBe(
      `Pipeline resumed at stage "clarify" and advanced to "${expectedTarget}".`,
    );
    // Audit truth: exactly one advance row naming the same stage.
    const advanced = safeEvents("clarify_startup_advanced");
    expect(advanced).toHaveLength(1);
    expect(advanced[0]).toContain(`"toStage":"${expectedTarget}"`);
  });

  it("keeps the plain resume message when nothing was advanced", async () => {
    // No active auto job → the startup round dispatches normally and the stage
    // stays put; the message must stay the historical one.
    await harness.install({ status: "completed" });
    __resetAutoJobLockForTests();
    const { meta, stub, ctx } = makeResumeCtx();
    const result = await resumePipeline(
      ctx,
      meta,
      harness.config,
      createPipelineUI(harness.config),
      DOC,
      "resume_menu_restore",
    );

    expect(stub.meta()?.currentStage).toBe<PipelineStage>("clarify");
    expect(result.currentStage).toBe<PipelineStage>("clarify");
    expect(result.message).toBe(`Pipeline resumed at stage "clarify".`);
  });
});

/**
 * 223 review issue 2 (Medium) regression net: a host WITHOUT the auto runner's
 * consumer must not hand the user "Next: run @feat-design-plan-agent …" for an
 * already-confirmed document — that instruction can neither spawn nor advance.
 */
describe("/pipeline-start on a confirmed document — the deferred advance is honest", () => {
  it("states the deferral in the message instead of the clarify-run hint", async () => {
    const { ctx } = makeCommandCtx();
    const result = (await createPipelineStartCommand(harness.config).execute({ file: DOC }, ctx as never)) as {
      success: boolean;
      message?: string;
    };
    const expectedTarget = harness.config.stages.clarify?.nextStage as PipelineStage;

    expect(result.success).toBe(true);
    expect(result.message ?? "").toContain(`clarify confirmed; the advance to "${expectedTarget}" is deferred`);
    expect(result.message ?? "").not.toContain("@feat-design-plan-agent");
  });

  it("notifies once and leaves the pending audit row as the observable trace", async () => {
    const { stub, ctx } = makeCommandCtx();
    await createPipelineStartCommand(harness.config).execute({ file: DOC }, ctx as never);

    // The pending state is user-visible exactly once …
    const deferred = stub.notified.filter((m) => m.includes("deferred to the auto runner"));
    expect(deferred).toHaveLength(1);
    const expectedTarget = harness.config.stages.clarify?.nextStage as PipelineStage;
    expect(deferred[0]).toContain(`"${expectedTarget}"`);
    // … the plan router writes the audit row (never a silent "nobody advanced") …
    const pending = safeEvents("clarify_startup_advance_pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain('"reason":"autojob_contract_pending"');
    // … and nothing advanced in this host.
    expect(safeEvents("clarify_startup_advanced")).toHaveLength(0);
  });
});
