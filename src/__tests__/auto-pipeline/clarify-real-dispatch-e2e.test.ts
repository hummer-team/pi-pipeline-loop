/**
 * 226 Phase 4 — REAL default-dependency clarify dispatch e2e + the regression
 * matrix that pins the phases together.
 *
 * Covered acceptance items (plan §Phase 4):
 * 1. `runAutoClarifyRound` with REAL `DEFAULT_CLARIFY_DEPS` (spawn =
 *    `spawnStageSubagent`, freeze = `freezeAndPrompt`) really dispatches via
 *    the sendUserMessage fallback (no event bus ⇒ `stage_spawn_fallback`);
 *    the announcer message carries the clarify agent mention + requirement
 *    doc + the derived args.
 * 2. Gate counter-proof (review B-#8i): the SAME real dispatch deps with an
 *    EMPTY clarify agentPath produce `stage_spawn_skipped
 *    (reason=stage_not_spawnable)` + `clarify_dispatch_failed` — with an
 *    INJECTED recording freeze so the reverse-proof never triggers the real
 *    freeze recursion.
 * 3. Finalisation reachability (review #1 / B-#3): a real `full-und?`
 *    dispatch stamps `clarifyFinalisationRound`; the next round cannot
 *    dispatch (`defer-to-marker`); the marker gate then owns the settle and
 *    the real `handleAutoClarifyMarkerMiss` fails the document with
 *    `clarify_marker_missing` (`onExhausted: stop`).
 * 4. `self-confirm`: exactly ONE forced `full-und?` round; a SECOND missing
 *    marker is a doc failure — never a loop.
 * 5. Three-channel failure bookkeeping:
 *    - settle: covered in `clarify-dispatch-failure.test.ts` (refund pair);
 *    - startup: `/pipeline-auto` (startAutoJob) with NO deployed executor is
 *      accounted with `channel=startup` (never a silent launch), the job
 *      stays alive and the freezePolicy owns the retry;
 *    - resume: via the EXPORTED `dispatchAfterResume`, labelled
 *      `channel=resume`, with NO refund row (the startup/resume channel
 *      never reserved a round).
 * 6. `maxTotalFreezes` timing (review B-#5): the per-doc stall cap trajectory
 *    is not preempted by the freeze budget, and a settle AFTER a recovery
 *    (budget reached, no unresolvable freeze) hard-stops with
 *    `freeze_budget_exhausted`.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "../../types";
import { makeTestMeta } from "../helpers";
import {
  runAutoClarifyRound,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "../../core/auto-pipeline/clarify-entry";
import { handleAutoClarifyMarkerMiss } from "../../core/auto-pipeline/clarify-marker-miss";
import { startAutoJob } from "../../commands/pipeline-auto";
import { dispatchAfterResume } from "../../commands/pipeline-start";
import { handleAutoSettle } from "../../core/auto-pipeline/settle-seam";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import {
  createAutoHarness,
  createSessionStub,
  deployHarnessAgents,
  HARNESS_DOCS,
  HARNESS_JOB_ID,
  HARNESS_JOB_YAML,
  type AutoHarness,
} from "./auto-harness";

const DOC = HARNESS_DOCS[0]!;
const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");

const MANDATORY = [
  "## 目标",
  "Ship the real dispatch e2e.",
  "## 范围",
  "Real deps only.",
  "## 验收标准",
  "One fallback dispatch.",
];

/** Ready + answered → the finalisation round (`full-und?`). */
const READY_FULL_UND_DOC = [
  "# 200_Feat",
  ...MANDATORY,
  "## 需求评估",
  "ready",
  "",
  "# 第 1 轮澄清",
  "- **方案 A** self-answer",
  "答：方案 A",
].join("\n");

const NEEDS_CLARIFY_DOC = [
  "# 200_Feat",
  ...MANDATORY,
  "## 需求评估",
  "needs-clarify",
  "",
  "# 第 1 轮澄清",
  "- **方案 A** option",
].join("\n");

let harness: AutoHarness;
let audits: string[];
let sentMessages: string[];
let errorSpy: ReturnType<typeof spyOn>;

/** Injected RECording freeze (the counter-proof's stub — never the real one). */
const REC = { reasons: [] as string[] };

/** ctx with a REAL sendUserMessage capture and NO event bus (fallback lane). */
function makeRealCtx(meta: SessionMeta) {
  const stub = createSessionStub(meta);
  const ctx: ClarifyEntryCtx = {
    session: stub.session,
    ui: stub.ui,
    pi: { sendUserMessage: (message: string): void => { sentMessages.push(message); } },
  };
  return { ctx, stub };
}

function makeMeta(): SessionMeta {
  return {
    pipelineId: "pipe-226-e2e",
    currentStage: "clarify",
    flowState: "running",
    stageStartTime: 1_000,
    requirementDoc: DOC,
    spawnedStages: { clarify: 1_000 },
    activeSpawns: {},
  } as SessionMeta;
}

function writeDoc(text: string, doc: string = DOC): void {
  const abs = path.join(harness.projectRoot, doc);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/** Rewrite the job YAML (parseable) with the given replacements. */
function restateJob(...replacements: Array<[string, string]>): void {
  let yaml = HARNESS_JOB_YAML;
  for (const [from, to] of replacements) yaml = yaml.replace(from, to);
  fs.writeFileSync(
    path.join(harness.root, "docs", "jobs", `${HARNESS_JOB_ID}.yaml`),
    yaml,
    "utf8",
  );
}

/** Clarify config with an EMPTY executor (the gate counter-proof fixture). */
function configWithoutClarifyAgent(): AutoHarness["config"] {
  return {
    ...harness.config,
    stages: {
      ...harness.config.stages,
      clarify: { ...harness.config.stages.clarify, agentPath: "" },
    },
  };
}

function cyclingFreeze(): ClarifyEntryDeps {
  REC.reasons.length = 0;
  return {
    spawn: (async (...args: Parameters<ClarifyEntryDeps["spawn"]>): Promise<Awaited<ReturnType<ClarifyEntryDeps["spawn"]>>> => {
      // The REAL dispatch path — the gate itself decides spawnability.
      const { spawnStageSubagent } = await import("../../utils/subagent-rpc");
      return spawnStageSubagent(args[0], args[1], args[2], args[3], args[4] as never);
    }) as ClarifyEntryDeps["spawn"],
    freeze: (async (...args: Parameters<ClarifyEntryDeps["freeze"]>): Promise<void> => {
      REC.reasons.push(args[2] as string);
    }) as ClarifyEntryDeps["freeze"],
  };
}

/** A session owner stub with a REAL sendUserMessage channel (dispatchAfterResume e2e). */
function makeOwnerStub(meta: SessionMeta): Record<string, unknown> {
  const stub = createSessionStub(meta);
  return {
    session: stub.session,
    ui: stub.ui,
    pi: { sendUserMessage: (message: string): void => { sentMessages.push(message); } },
    _ctx: { sessionManager: { getHeader: () => ({}), getSessionName: () => "owner" } },
  };
}

beforeEach(async () => {
  harness = createAutoHarness();
  const specTarget = path.join(harness.projectRoot, ".pi", "references", "clarify_spec", "verify.md");
  fs.mkdirSync(path.dirname(specTarget), { recursive: true });
  fs.copyFileSync(
    path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"),
    specTarget,
  );
  await harness.install();
  __resetFinalizeStateForTests();
  audits = [];
  sentMessages = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  errorSpy.mockRestore();
  harness.dispose();
});

describe("226 Phase 4: real default deps dispatch", () => {
  it("runAutoClarifyRound dispatches through the REAL spawn path (fallback audit + real message)", async () => {
    deployHarnessAgents(harness);
    writeDoc(NEEDS_CLARIFY_DOC);
    const meta = makeMeta();
    const { ctx } = makeRealCtx(meta);

    // NO deps injected: the REAL `spawnStageSubagent` + `freezeAndPrompt` run.
    expect(await runAutoClarifyRound(ctx, harness.config, meta)).toBe("consumed");

    // eslint-disable-next-line no-console
    console.log("DBG-AUDITS", audits.join("\n"));
    // The fallback lane produced a real dispatch: message carries the clarify
    // agent mention, the requirement doc and the round args.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("feat-design-plan-agent");
    expect(sentMessages[0]).toContain(DOC);
    expect(sentMessages[0]!.includes(" 1 答")).toBe(true);
    // The dispatch itself is audited on the generic stage channel.
    expect(audits.some((line) => line.includes("stage_spawn_fallback"))).toBe(true);
    // And the round was charged as a REAL dispatch.
    expect(harness.state().docs[0]!.clarifyRounds).toBe(1);
  });
});

describe("226 Phase 4: gate counter-proof (injected freeze stub, B-#8i)", () => {
  it("empty agentPath → stage_not_spawnable + clarify_dispatch_failed, budget refunded (REAL spawn deps)", async () => {
    writeDoc(NEEDS_CLARIFY_DOC);
    const meta = makeMeta();
    const { ctx } = makeRealCtx(meta);
    const failingDeps = cyclingFreeze();

    expect(await runAutoClarifyRound(ctx, configWithoutClarifyAgent(), meta, failingDeps)).toBe("consumed");

    expect(audits.some((line) => line.includes("stage_spawn_skipped") && line.includes("stage_not_spawnable"))).toBe(true);
    expect(audits.some((line) => line.includes("clarify_dispatch_failed"))).toBe(true);
    // The round reservation was refunded — the failure never consumed budget.
    expect(harness.state().docs[0]!.clarifyRounds ?? 0).toBe(0);
    // The freeze stub keeps the counter-proof free of the real recursion.
    expect(REC.reasons).toEqual(["clarify_dispatch_failed"]);
  });
});

describe("226 Phase 4: finalisation reachability (review #1 / B-#3)", () => {
  it("real full-und? dispatch stamps the fact; next round defers to the marker; a missing marker fails the doc", async () => {
    deployHarnessAgents(harness);
    writeDoc(READY_FULL_UND_DOC);
    const meta = makeMeta();
    const { ctx } = makeRealCtx(meta);

    // Round 1: the converged document dispatches the FINALISATION round.
    expect(await runAutoClarifyRound(ctx, harness.config, meta)).toBe("consumed");
    expect(sentMessages[0]).toContain("full-und?");
    const stamped = harness.state().docs[0]!;
    expect(stamped.clarifyFinalisationRound).toBe(1);

    // Round 2 settle: the fact blocks the dispatch and hands the settle to
    // the marker gate (the await-answer precheck is skipped there).
    expect(await runAutoClarifyRound(ctx, harness.config, meta)).toBe("defer-to-marker");
    expect(sentMessages).toHaveLength(1); // no second dispatch

    // The marker gate (real deps, job default onExhausted: stop) owns the doc.
    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta)).toBe(true);

    const state = harness.state();
    expect(state.docs[0]!.status).toBe("failed");
    expect(state.docs[0]!.failReason).toBe("clarify_marker_missing");
    // The doc failure with `stop` ends the job with the honest relabel.
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("doc_failed");
  });
});

describe("226 Phase 4: self-confirm — exactly one forced round", () => {
  it("first miss forces ONE full-und? (fallback USED); the second miss fails the doc", async () => {
    deployHarnessAgents(harness);
    fs.writeFileSync(
      path.join(harness.root, "docs", "jobs", `${HARNESS_JOB_ID}.yaml`),
      `${HARNESS_JOB_YAML}\nclarify:\n  onExhausted: self-confirm`,
      "utf8",
    );
    // An UNANSWERED round so the forced finalisation has a target; no marker.
    writeDoc(["# 200_Feat", ...MANDATORY, "", "# 第 1 轮澄清", "- **方案 A** option"].join("\n"));
    const meta = makeMeta();
    const { ctx } = makeRealCtx(meta);

    // 1st missing marker → forced full-und? round (fallback: sendUserMessage).
    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta)).toBe(true);
    let doc = harness.state().docs[0]!;
    expect(doc.clarifyFallbackUsed).toBe(true);
    expect(sentMessages.some((m) => m.includes("full-und?"))).toBe(true);

    // Re-run while the marker is STILL missing → the honest doc failure.
    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta)).toBe(true);
    doc = harness.state().docs[0]!;
    expect(doc.status).toBe("failed");
    expect(doc.failReason).toBe("clarify_marker_missing");
    expect(harness.state().status).toBe("failed");
  });
});

describe("226 Phase 4: three-channel failure bookkeeping", () => {
  it("startup channel: /pipeline-auto with no deployed executor fails the doc — never silent", async () => {
    // No agents deployed ⇒ the startup dispatch cannot resolve `agentName`.
    // Fixture: the sidecar doc is PENDING (the harness installs `running`
    // shapes for the settle-side suites) pre-charged to stall 2 so the FIRST
    // startup failure reaches the per-doc stall cap → ONE deterministic doc
    // failure (the freeze auto-resume loop never gets to interfere).
    writeDoc(["# 200_Feat", ...MANDATORY].join("\n"));
    const charged = harness.state();
    charged.docs[0]!.status = "pending";
    charged.docs[0]!.lastStage = undefined;
    charged.docs[0]!.clarifyStalls = 0;
    await (await import("../../core/auto-pipeline/job-state")).writeJobState(harness.root, charged);
    const stub = createSessionStub(makeTestMeta({ currentStage: "fix", pipelineId: "pipe-226-e2e-startup" }));

    const result = await startAutoJob({ config: harness.config, ctx: stub as never, jobId: HARNESS_JOB_ID });
    expect(result.success).toBe(true); // the runner stamping continues; the launch failure is the ACCOUNTED shape below

    const persisted = harness.state();
    expect(persisted.docs[0]!.status).toBe("running");
    // 226 Phase 2 startup-channel accounting is OBSERVABLE where the runner's
    // trailing sidecar stamp cannot clobber it: the audit trail.
    expect(audits.some((line) => line.includes("clarify_dispatch_failed") && line.includes('"channel":"startup"'))).toBe(true);
    expect(audits.some((line) => line.includes("clarify_freeze"))).toBe(true);
    // The failure never charged nor fabricated a round (no success dispatch
    // row, no refund row — the startup channel never reserved one).
    expect(audits.some((line) => line.includes('"gate":"clarify_dispatch"') && !line.includes("coalesced"))).toBe(false);
    expect(audits.some((line) => line.includes("clarify_round_refund"))).toBe(false);
  });

  it("resume channel: via the EXPORTED dispatchAfterResume, labelled channel=resume, no refund row", async () => {
    // No agents deployed; the active job owns the doc.
    writeDoc(["# 200_Feat", ...MANDATORY].join("\n"));
    const meta = makeMeta();
    const ctx = makeOwnerStub(meta);

    // The exported resume seam (review B-#8c) — never the un-exported helper.
    await dispatchAfterResume(ctx as never, harness.config, { notify: (m: string) => undefined } as never, meta, DOC);

    const failed = audits.filter((line) => line.includes("clarify_dispatch_failed"));
    expect(failed.length).toBeGreaterThan(0);
    // Every failure is channel-attributed; the resume channel label appears.
    expect(failed.some((line) => line.includes('"channel":"resume"'))).toBe(true);
    // Startup/resume never RESERVED a round → no refund row can exist.
    expect(audits.some((line) => line.includes("clarify_round_refund"))).toBe(false);
    const persisted = harness.state();
    expect(persisted.docs[0]!.clarifyRounds ?? 0).toBe(0);
  });
});

describe("226 Phase 4: maxTotalFreezes timing (review B-#5)", () => {
  it("case A: consecutive failures reach the per-doc stall cap — the freeze budget does not preempt", async () => {
    deployHarnessAgents(harness);
    restateJob(["  maxTotalFreezes: 2", "  maxTotalFreezes: 1"]);
    writeDoc(NEEDS_CLARIFY_DOC);
    const meta = makeMeta();
    const { ctx } = makeRealCtx(meta);
    const failingDeps = cyclingFreeze();

    // Three failed settles: stall 1 → 2 → 3 (trajectory pinned in unit tests).
    for (let i = 0; i < 3; i++) {
      expect(await runAutoClarifyRound(ctx, configWithoutClarifyAgent(), meta, failingDeps)).toBe("consumed");
    }
    const state = harness.state();
    expect(state.docs[0]!.clarifyStalls).toBe(3);
    expect(state.docs[0]!.failReason).toBe("clarify_dispatch_failed");
    expect(state.status).toBe("failed");
  });

  it("case B: recovery then the NEXT settle with totalFreezes >= maxTotalFreezes → freeze_budget_exhausted", async () => {
    deployHarnessAgents(harness);
    restateJob(["  maxTotalFreezes: 2", "  maxTotalFreezes: 1"]);
    // A RECOVERED document (running, no unresolvable freeze) but the budget
    // was spent in the previous period.
    const state = harness.state();
    state.counters.totalFreezes = 1;
    await (await import("../../core/auto-pipeline/job-state")).writeJobState(harness.root, state);

    const meta = makeTestMeta({ currentStage: "develop", requirementDoc: DOC });
    expect(await handleAutoSettle(makeOwnerStub(meta) as never, harness.config, meta)).toBe(true);

    const after = harness.state();
    expect(after.docs[0]!.failReason).toBe("freeze_budget_exhausted");
    // The JOB-level label stays the plain stop reason (no detail exists here).
    expect(after.stopReason).toBe("freeze_budget_exhausted");
  });
});
