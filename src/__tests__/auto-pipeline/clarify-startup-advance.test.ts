/**
 * 223 Phase 2: the `confirmed` clarify document advances INSIDE the start round.
 *
 * Sealed behaviors (223_Bug_Plan.md Phase 2, "单元测试目标"):
 * - a document that already carries `## 模型确认` advances `clarify → nextStage`
 *   in the SAME round: `currentStage` really moves, the next stage executor is
 *   dispatched, and `clarify_startup_advanced` records the transition;
 * - the auto-job sidecar is settled too: the per-doc clarify counters are
 *   REFUNDED (all `undefined`, the same shape `clarify-entry`'s confirmed
 *   branch writes) so a later re-run does not trip the Phase 1 budget gate, and
 *   `lastStage` follows the advance;
 * - marker missing (including an unbound `requirementDoc`) and a missing
 *   `nextStage` are honest `{ advanced: false }` outcomes: one narrow audit
 *   each, ZERO spawn, ZERO freeze — the existing settle semantics keep owning
 *   the document;
 * - `autoAdvanceAfterVerify` refusal (`!advanced`) is not retried with a spawn.
 *
 * The module lives in `src/core/` on purpose (see its header): the INV-2 source
 * guard proves the `auto-pipeline/` directory never starts/advances a pipeline
 * itself, so the advance is triggered explicitly by the COMMAND round.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import { advanceConfirmedClarifyOnStartup } from "../../core/clarify-startup-advance";
import { createPipelineUI } from "../../core/pipeline-ui";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { writeJobState } from "../../core/auto-pipeline/job-state";
import { isClarifyRoundBudgetExhausted } from "../../core/auto-pipeline/clarify-round-budget";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestMeta } from "../helpers";
import {
  createAutoHarness,
  createSessionStub,
  HARNESS_DOCS,
  HARNESS_JOB_ID,
  type AutoHarness,
} from "./auto-harness";

const DOC = HARNESS_DOCS[0]!;

/** Mandatory sections + the final marker section (line start, never fenced). */
const CONFIRMED_DOC = [
  "# 223_Bug",
  "## 目标",
  "Advance a documented-confirmed clarify round without a subagent.",
  "## 范围",
  "The startup round only.",
  "## 验收标准",
  "The stage moves and the counters are refunded.",
  "",
  "## 模型确认",
  "是",
].join("\n");

/** Same document WITHOUT the marker → the gate must not let it through. */
const UNCONFIRMED_DOC = [
  "# 223_Bug",
  "## 目标",
  "Advance a documented-confirmed clarify round without a subagent.",
  "## 范围",
  "The startup round only.",
  "## 验收标准",
  "The stage moves and the counters are refunded.",
].join("\n");

let harness: AutoHarness;
let audits: string[];
let sent: Array<{ msg: string; opts?: unknown }>;
let errorSpy: ReturnType<typeof spyOn>;

/** Every `safeWriteAuditLog` call as `<stage> <json>`. */
function gateEvents(stage: string): string[] {
  return audits.filter((line) => line.startsWith(`${stage} `));
}

function writeDoc(text: string): void {
  const abs = path.join(harness.projectRoot, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/**
 * The next stage's agent definition, so `resolveAgentMention` resolves a real
 * mention and the dispatch is observable (the fallback channel is a plain
 * `pi.sendUserMessage`, no event bus needed).
 */
function writePlanAgent(): void {
  const abs = path.join(harness.projectRoot, ".pi", "agents", "feat-design-plan-agent.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "---\nname: test-agent\ntools: read\n---\nagent body\n", "utf8");
}

function makeMeta(over?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    currentStage: "clarify",
    flowState: "running",
    requirementDoc: DOC,
    pipelineId: "pipe-223-clarify-advance",
    autoJob: {
      jobId: HARNESS_JOB_ID,
      jobPath: `docs/jobs/${HARNESS_JOB_ID}.yaml`,
      docIndex: 0,
      totalDocs: HARNESS_DOCS.length,
    },
    ...over,
  });
}

/** Build the runtime context the startup advance consumes. */
function makeCtx(meta: SessionMeta) {
  const stub = createSessionStub(meta);
  return {
    stub,
    ctx: { session: stub.session, pi: { sendUserMessage: (msg: string, opts?: unknown) => { sent.push({ msg, opts }); } }, ui: stub.ui },
  };
}

/**
 * The harness DELETES every stage's `verify` block. The advance only prechecks
 * completion markers when the clarify stage DECLARES them (settle-side parity:
 * "not configured / empty array" means "do not precheck"), so a case that needs
 * the marker gate must supply it explicitly.
 */
function withMarkers(markers: string[]): PipelineConfig {
  return {
    ...harness.config,
    stages: {
      ...harness.config.stages,
      clarify: { ...harness.config.stages.clarify!, verify: { require: true, completionMarker: markers } },
    },
  } as PipelineConfig;
}

/** Seed the per-doc clarify counters the way an exhausted round would leave them. */
async function seedExhaustedCounters(): Promise<void> {
  const state = harness.state();
  Object.assign(state.docs[0]!, {
    clarifyRounds: 5,
    clarifyLastRound: 5,
    clarifyDispatchedAt: 1,
    clarifyStalls: 2,
    clarifyStallSignature: "spawn-full-und:ready:5",
    clarifyStallDocLength: 10,
    clarifyNeedsClarifyStreak: 2,
  });
  await writeJobState(harness.projectRoot, state);
}

beforeEach(async () => {
  __resetAutoJobLockForTests();
  harness = createAutoHarness();
  await harness.install();
  writeDoc(CONFIRMED_DOC);
  writePlanAgent();
  audits = [];
  sent = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  harness.dispose();
});

describe("confirmed document — advance inside the start round", () => {
  it("moves clarify → plan, dispatches the next executor and audits the transition", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, harness.config, meta, createPipelineUI(harness.config));

    expect(outcome).toEqual({ advanced: true, toStage: "plan" });
    // Return truth and the session meta agree.
    expect(ctx.session.getMeta()?.currentStage).toBe<PipelineStage>("plan");
    // The next stage executor was really dispatched (fallback channel proves a
    // message was handed to the host for the PLAN stage).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.startsWith("[plugin auto-handoff] @test-agent")).toBe(true);
    expect(gateEvents("stage_spawn_fallback").some((line) => line.includes('"stage":"plan"'))).toBe(true);
    // The transition is audited with the confirmed-marker trigger.
    const advanced = gateEvents("clarify_startup_advanced");
    expect(advanced).toHaveLength(1);
    expect(advanced[0]).toContain('"fromStage":"clarify"');
    expect(advanced[0]).toContain('"toStage":"plan"');
    expect(advanced[0]).toContain('"trigger":"confirmed_marker"');
    // No "rule verification passed" claim is fabricated on this path.
    expect(gateEvents("auto_verify_pass")).toHaveLength(0);
  });

  it("refunds the per-doc clarify counters so a re-run is not budget-exhausted", async () => {
    await seedExhaustedCounters();
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    await advanceConfirmedClarifyOnStartup(ctx, harness.config, meta, createPipelineUI(harness.config));

    const progress = harness.state().docs[0]!;
    // `resetClarifyCounters` CLEARS (undefined), it does not zero the counters.
    expect(progress.clarifyRounds).toBeUndefined();
    expect(progress.clarifyLastRound).toBeUndefined();
    expect(progress.clarifyDispatchedAt).toBeUndefined();
    expect(progress.clarifyStalls).toBeUndefined();
    expect(progress.clarifyStallSignature).toBeUndefined();
    expect(progress.clarifyStallDocLength).toBeUndefined();
    expect(progress.clarifyNeedsClarifyStreak).toBeUndefined();
    // The budget gate that would have frozen the re-run is now satisfied.
    expect(isClarifyRoundBudgetExhausted(progress.clarifyRounds ?? 0, harness.job.clarify.maxRounds)).toBe(false);
    // Same accounting semantics as the settle-side confirmed branch.
    expect(gateEvents("pipeline_auto_decision").some((line) => line.includes('"gate":"clarify_confirmed"'))).toBe(true);
    // Sidecar truth follows the advance.
    expect(progress.lastStage).toBe<PipelineStage>("plan");
  });
});

describe("not advanced — every refusal is honest and side-effect free", () => {
  it("marker missing: reason marker_missing, zero spawn, zero freeze", async () => {
    writeDoc(UNCONFIRMED_DOC);
    const config = withMarkers(["## 模型确认"]);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, config, meta, createPipelineUI(config));

    expect(outcome).toEqual({ advanced: false, reason: "marker_missing" });
    expect(ctx.session.getMeta()?.currentStage).toBe<PipelineStage>("clarify");
    expect(sent).toHaveLength(0);
    // Freeze would have produced a `pipeline_blocked` audit — none here.
    expect(gateEvents("pipeline_blocked")).toHaveLength(0);
    const blocked = gateEvents("clarify_startup_advance_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain('"reason":"marker_missing"');
    expect(gateEvents("clarify_startup_advanced")).toHaveLength(0);
    // The sidecar counters are untouched.
    expect(harness.state().docs[0]!.clarifyRounds ?? 0).toBe(0);
  });

  it("nextStage null: reason no_next_stage, zero spawn", async () => {
    const config = {
      ...harness.config,
      stages: {
        ...harness.config.stages,
        clarify: { ...harness.config.stages.clarify!, nextStage: null },
      },
    } as PipelineConfig;
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, config, meta, createPipelineUI(config));

    expect(outcome).toEqual({ advanced: false, reason: "no_next_stage" });
    expect(sent).toHaveLength(0);
    const blocked = gateEvents("clarify_startup_advance_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain('"reason":"no_next_stage"');
    expect(gateEvents("clarify_startup_advanced")).toHaveLength(0);
  });

  it("requirementDoc unbound: same marker_missing refusal (no crash, no spawn)", async () => {
    const config = withMarkers(["## 模型确认"]);
    const meta = makeMeta({ requirementDoc: undefined });
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, config, meta, createPipelineUI(config));

    expect(outcome).toEqual({ advanced: false, reason: "marker_missing" });
    expect(sent).toHaveLength(0);
    expect(gateEvents("clarify_startup_advance_blocked")).toHaveLength(1);
    expect(gateEvents("clarify_startup_advanced")).toHaveLength(0);
  });

  // 223 review issue 6 (M5): "no completionMarker configured" is NOT "no marker
  // on disk" — the settle side treats it as "do not precheck", and the startup
  // seam must agree or a project with a custom/absent marker could never escape
  // clarify again.
  it("no completionMarker configured: the gate is skipped (settle-side parity)", async () => {
    writeDoc(UNCONFIRMED_DOC);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, harness.config, meta, createPipelineUI(harness.config));

    expect(outcome).toEqual({ advanced: true, toStage: "plan" });
    expect(gateEvents("clarify_startup_advance_blocked")).toHaveLength(0);
  });

  // 223 review issue 17 (L8): the module is only meaningful in clarify. A stray
  // call from another stage must refuse for a REASON instead of advancing.
  it("currentStage is not clarify: reason stage_mismatch", async () => {
    const meta = makeMeta({ currentStage: "develop" });
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, harness.config, meta, createPipelineUI(harness.config));

    expect(outcome).toEqual({ advanced: false, reason: "stage_mismatch" });
    expect(sent).toHaveLength(0);
    expect(gateEvents("clarify_startup_advanced")).toHaveLength(0);
    // 223 review issue 4 (L1): the gate order is TOTAL — even the caller-defect
    // refusal leaves exactly one blocked row (`advanced:"false"`), so the module
    // header and the implementation now agree.
    const blocked = gateEvents("clarify_startup_advance_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain('"reason":"stage_mismatch"');
    expect(blocked[0]).toContain('"advanced":"false"');
  });
});

/**
 * 223 review issue 6 (L2): the sidecar truth must follow the advance on the
 * RESUME host too, where `buildResumeMeta` has already cleared `meta.autoJob`.
 * Ownership is then proven by the doc's recorded `pipelineId`.
 */
describe("sidecar truth on a host without the autoJob contract", () => {
  it("writes lastStage when the sidecar doc belongs to the same pipelineId", async () => {
    const state = harness.state();
    state.docs[0]!.pipelineId = "pipe-223-sidecar";
    await writeJobState(harness.projectRoot, state);

    const meta = makeMeta({ pipelineId: "pipe-223-sidecar", autoJob: undefined });
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, harness.config, meta, createPipelineUI(harness.config));

    expect(outcome).toEqual({ advanced: true, toStage: "plan" });
    expect(harness.state().docs[0]!.lastStage).toBe<PipelineStage>("plan");
  });
});

/**
 * 223 review issue 8 (L4): the gate accepted only the CONFIGURED marker while
 * the derivation that produced the `confirmed` plan also accepts the protocol
 * defaults — a custom marker + a default-marker document used to be "confirmed
 * but neither spawned nor advanced". The gate now uses the derivation's set,
 * while the "nothing configured ⇒ no gate" switch is unchanged.
 */
describe("marker gate mirrors the derivation's accepted set", () => {
  it("custom marker configured + default marker on disk: advances instead of marker_missing", async () => {
    writeDoc(CONFIRMED_DOC);
    const config = withMarkers(["## 自定义确认"]);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, config, meta, createPipelineUI(config));

    expect(outcome).toEqual({ advanced: true, toStage: "plan" });
    expect(ctx.session.getMeta()?.currentStage).toBe<PipelineStage>("plan");
    expect(gateEvents("clarify_startup_advance_blocked")).toHaveLength(0);
  });

  it("custom marker configured + no marker at all: still a marker_missing refusal", async () => {
    writeDoc(UNCONFIRMED_DOC);
    const config = withMarkers(["## 自定义确认"]);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    const outcome = await advanceConfirmedClarifyOnStartup(ctx, config, meta, createPipelineUI(config));

    expect(outcome).toEqual({ advanced: false, reason: "marker_missing" });
    const blocked = gateEvents("clarify_startup_advance_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain('"reason":"marker_missing"');
  });
});
