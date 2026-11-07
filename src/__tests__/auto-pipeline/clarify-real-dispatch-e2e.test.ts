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
 *    dispatch stamps `clarifyFinalisationRound`; the NEXT settle — driven
 *    through the REAL `agent_settled` handler, with an answered AND an
 *    unanswered round — returns `defer-to-marker` (skipping the await-answer
 *    precheck) and reaches the marker gate, which fails the document with
 *    `clarify_marker_missing` (`onExhausted: stop`).
 * 4. `self-confirm`: exactly ONE forced `full-und?` round; a SECOND missing
 *    marker is a doc failure — never a loop.
 * 5. Three-channel failure bookkeeping:
 *    - settle: covered in `clarify-dispatch-failure.test.ts` (refund pair);
 *    - startup: `/pipeline-auto` (startAutoJob) charges the startup round on
 *      success and accounts a missing executor with `channel=startup`; the
 *      success/failure facts SURVIVE the runner's trailing start stamp
 *      (226 review #1 — High);
 *    - resume: via the EXPORTED `dispatchAfterResume`, labelled
 *      `channel=resume`, with NO refund row (the startup/resume channel
 *      never reserved a round).
 * 6. `maxTotalFreezes` timing (review B-#5): the per-doc stall cap is not
 *    preempted by the freeze budget (the freeze stub BOOKS `totalFreezes`),
 *    and a settle AFTER a recovery (budget reached, no unresolvable freeze)
 *    hard-stops with `freeze_budget_exhausted` on the NEXT settle.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "../../types";
import { makeTestMeta, createMockCtx } from "../helpers";
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
import { writeJobState } from "../../core/auto-pipeline/job-state";
import { createAgentSettled } from "../../core/agent-settled";
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

/**
 * Injected freeze that ALSO books the job-level freeze counter — the same
 * single write point `freeze-autopilot` owns in production. Review B-#5 needs
 * the freeze BUDGET to really move, otherwise "the budget never preempts the
 * per-doc stall cap" would be an artefact of the stub.
 */
function countingFreeze(): ClarifyEntryDeps {
  const deps = cyclingFreeze();
  return {
    ...deps,
    freeze: (async (...args: Parameters<ClarifyEntryDeps["freeze"]>): Promise<void> => {
      REC.reasons.push(args[2] as string);
      const state = harness.state();
      state.counters.totalFreezes = (state.counters.totalFreezes ?? 0) + 1;
      await writeJobState(harness.root, state);
    }) as ClarifyEntryDeps["freeze"],
  };
}

/** Harness config with the clarify completion-marker verify block ENABLED. */
function configWithClarifyMarker(): AutoHarness["config"] {
  const clarify = harness.config.stages.clarify!;
  return {
    ...harness.config,
    stages: {
      ...harness.config.stages,
      clarify: {
        ...clarify,
        verify: { ...(clarify.verify ?? {}), require: true, completionMarker: ["## 模型确认"] },
      },
    },
  };
}

/** Meta of the OWNER session bound to the harness job (settle-side e2e). */
function makeAutoJobMeta(): SessionMeta {
  return {
    pipelineId: "pipe-226-e2e-settle",
    currentStage: "clarify",
    flowState: "running",
    stageStartTime: 1_000,
    requirementDoc: DOC,
    spawnedStages: {},
    activeSpawns: {},
    autoJob: {
      jobId: HARNESS_JOB_ID,
      jobPath: `docs/jobs/${HARNESS_JOB_ID}.yaml`,
      docIndex: 0,
      totalDocs: HARNESS_DOCS.length,
      designReviewMaxRounds: 3,
      designReviewRounds: 0,
      lastCountedDesignReviewRound: 0,
      totalLoopsBudget: 5,
    },
  } as SessionMeta;
}

/** Seed the sidecar as "the finalisation round was already dispatched". */
async function seedFinalisationDispatched(): Promise<void> {
  const state = harness.state();
  state.docs[0]!.clarifyRounds = 1;
  state.docs[0]!.clarifyFinalisationRound = 1;
  await writeJobState(harness.root, state);
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
    const { ctx, stub } = makeRealCtx(meta);

    // NO deps injected: the REAL `spawnStageSubagent` + `freezeAndPrompt` run.
    expect(await runAutoClarifyRound(ctx, harness.config, meta)).toBe("consumed");
    // The fallback lane produced a real dispatch: message carries the clarify
    // agent mention, the requirement doc and the round args.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("feat-design-plan-agent");
    expect(sentMessages[0]).toContain(DOC);
    expect(sentMessages[0]!.includes(" 1 答")).toBe(true);
    // The dispatch itself is audited on the generic stage channel.
    expect(audits.some((line) => line.includes("stage_spawn_fallback"))).toBe(true);
    // Plan Phase 4 task 1: the same-visit guard proves a REAL spawn happened
    // (and is what suppresses a duplicate dispatch for the visit).
    expect(stub.meta()?.spawnedStages?.clarify).toBe(meta.stageStartTime);
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

describe("226 Phase 4: finalisation fact + marker reachability (review #1 / B-#3)", () => {
  it("a real full-und? dispatch stamps the fact; the next round defers instead of dispatching", async () => {
    deployHarnessAgents(harness);
    writeDoc(READY_FULL_UND_DOC);
    const meta = makeMeta();
    const { ctx } = makeRealCtx(meta);

    // Round 1: the converged document dispatches the FINALISATION round.
    expect(await runAutoClarifyRound(ctx, harness.config, meta)).toBe("consumed");
    expect(sentMessages[0]).toContain("full-und?");
    expect(harness.state().docs[0]!.clarifyFinalisationRound).toBe(1);

    // Round 2: the fact blocks the dispatch and hands the settle to the marker
    // gate (no second dispatch).
    expect(await runAutoClarifyRound(ctx, harness.config, meta)).toBe("defer-to-marker");
    expect(sentMessages).toHaveLength(1);
  });

  // The deferral must survive the REAL settle chain: `agent_settled` skips the
  // await-answer precheck and hands the settle to the marker gate. Both
  // boundaries (answered / unanswered latest round) are driven through the hook.
  for (const [boundary, docText] of [
    ["answered", READY_FULL_UND_DOC],
    ["unanswered", NEEDS_CLARIFY_DOC],
  ] as const) {
    it(`${boundary} round: agent_settled reaches clarify_marker_missing (precheck skipped)`, async () => {
      writeDoc(docText);
      await seedFinalisationDispatched();
      const meta = makeAutoJobMeta();
      const ctx = createMockCtx(meta);

      await createAgentSettled(configWithClarifyMarker()).handler(ctx as never);

      // No second dispatch: the finalisation fact alone cannot start a round.
      expect(audits.some((line) => line.includes("stage_spawn_fallback"))).toBe(false);
      expect(audits.some((line) => line.includes("clarify_dispatch_deferred"))).toBe(false);
      // 226 review B-#3: the await-answer precheck is SKIPPED on
      // `defer-to-marker` (the unanswered fixture would otherwise stop here).
      expect(audits.some((line) => line.includes("verify_await_answer_deferred"))).toBe(false);
      // The settle really reached the marker gate and failed the document.
      expect(
        audits.some((line) => line.includes("clarify_completion_marker") && line.includes('"decision":"fail"')),
      ).toBe(true);
      const state = harness.state();
      expect(state.docs[0]!.status).toBe("failed");
      expect(state.docs[0]!.failReason).toBe("clarify_marker_missing");
      expect(state.status).toBe("failed");
      expect(state.stopReason).toBe("doc_failed");
    });
  }
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
  it("startup failure channel: the accounting SURVIVES the runner's start stamp and fails the doc", async () => {
    // No agents deployed ⇒ the startup dispatch cannot resolve `agentName`.
    // Fixture: the sidecar doc is PENDING (the harness installs `running`
    // shapes for the settle-side suites) pre-charged to stall 2 so the FIRST
    // startup failure reaches the per-doc stall cap → ONE deterministic doc
    // failure (the freeze auto-resume loop never gets to interfere).
    writeDoc(["# 200_Feat", ...MANDATORY].join("\n"));
    const charged = harness.state();
    charged.docs[0]!.status = "pending";
    charged.docs[0]!.lastStage = undefined;
    charged.docs[0]!.clarifyStalls = 2;
    await writeJobState(harness.root, charged);
    const stub = createSessionStub(makeTestMeta({ currentStage: "fix", pipelineId: "pipe-226-e2e-startup" }));

    const result = await startAutoJob({ config: harness.config, ctx: stub as never, jobId: HARNESS_JOB_ID });

    // 226 review #1 (High): the runner must NOT stamp its stale in-memory state
    // over the failure the startup channel already booked — the doc is really
    // finalised and the job is never resurrected to `running`.
    expect(result.success).toBe(false);
    const persisted = harness.state();
    expect(persisted.status).toBe("failed");
    expect(persisted.docs[0]!.status).toBe("failed");
    expect(persisted.docs[0]!.failReason).toBe("clarify_dispatch_failed");
    expect(persisted.docs[0]!.clarifyStalls).toBe(3);
    expect(persisted.docs[1]!.status).toBe("pending");
    // The failure is attributed to the startup channel; the exit is observable.
    expect(audits.some((line) => line.includes("clarify_dispatch_failed") && line.includes('"channel":"startup"'))).toBe(true);
    expect(audits.some((line) => line.includes("pipeline_auto_start_terminated"))).toBe(true);
    // The startup channel never reserved a round → no fake success, no refund.
    expect(audits.some((line) => line.includes('"gate":"clarify_dispatch"') && !line.includes("coalesced"))).toBe(false);
    expect(audits.some((line) => line.includes("clarify_round_refund"))).toBe(false);
  });

  it("startup success channel: the charged startup round survives the runner's start stamp", async () => {
    deployHarnessAgents(harness);
    writeDoc(["# 200_Feat", ...MANDATORY].join("\n"));
    const charged = harness.state();
    charged.docs[0]!.status = "pending";
    charged.docs[0]!.lastStage = undefined;
    await writeJobState(harness.root, charged);
    const stub = createSessionStub(
      makeTestMeta({ currentStage: "fix", pipelineId: "pipe-226-e2e-startup-ok" }),
      { pi: { sendUserMessage: (): void => undefined } },
    );

    const result = await startAutoJob({ config: harness.config, ctx: stub as never, jobId: HARNESS_JOB_ID });

    expect(result.success).toBe(true);
    // The session stub records hand-offs on its own channel (`dispatched`).
    expect(stub.dispatched).toHaveLength(1);
    expect(stub.dispatched[0]).toContain("feat-design-plan-agent");
    const persisted = harness.state();
    expect(persisted.status).toBe("running");
    expect(persisted.docs[0]!.status).toBe("running");
    expect(persisted.docs[0]!.pipelineId).toBeTruthy();
    expect(persisted.docIndex).toBe(0);
    // 226 review #1 (High): the startup round is charged to the STARTED doc —
    // it must survive the runner's trailing `state` write.
    expect(persisted.docs[0]!.clarifyRounds).toBe(1);
    expect(audits.some((line) => line.includes("clarify_dispatch") && line.includes("clarify_startup_round"))).toBe(true);
  });

  it("startup failure + onFailure:continue → the failed doc is never resurrected and docIndex follows the running doc", async () => {
    // 226 review round 2 (issue 1): doc 0 is pre-charged to the stall cap, so
    // the startup dispatch failure FINALISES it while the job stays `running`
    // (`onFailure: continue`) and the shared transaction really starts doc 1 in
    // this process. Doc 1 is fresh (its first failure only freezes), so it ends
    // up `running`. The runner must not write the pre-start state back.
    const jobPath = path.join(harness.root, "docs", "jobs", `${HARNESS_JOB_ID}.yaml`);
    fs.writeFileSync(
      jobPath,
      [
        "version: 1",
        "enabled: true",
        "tier: rule",
        "docs:",
        "  list:",
        `    - doc: ${HARNESS_DOCS[0]}`,
        `    - doc: ${HARNESS_DOCS[1]}`,
        "  onFailure: continue",
        "chain:",
        "  newSession: false",
        // Doc 1's first startup failure only freezes; `abort` keeps the job
        // `running` deterministically (a `resume` policy would re-dispatch and
        // this test is about the runner's write-back, not the retry loop).
        "freezePolicy:",
        "  onFreeze: abort",
      ].join("\n"),
      "utf8",
    );
    writeDoc(["# 200_Feat", ...MANDATORY].join("\n"), HARNESS_DOCS[0]!);
    writeDoc(["# 200_Feat", ...MANDATORY].join("\n"), HARNESS_DOCS[1]!);
    const charged = harness.state();
    charged.docs[0]!.status = "pending";
    charged.docs[0]!.lastStage = undefined;
    charged.docs[0]!.clarifyStalls = 2;
    await writeJobState(harness.root, charged);
    const stub = createSessionStub(makeTestMeta({ currentStage: "fix", pipelineId: "pipe-226-e2e-continue" }));

    const result = await startAutoJob({ config: harness.config, ctx: stub as never, jobId: HARNESS_JOB_ID });

    // The start LOST its document → report the failure, never write it back.
    expect(result.success).toBe(false);
    const persisted = harness.state();
    expect(persisted.status).toBe("running");
    // The failed doc stays failed (no `running` + `failReason` contradiction).
    expect(persisted.docs[0]!.status).toBe("failed");
    expect(persisted.docs[0]!.failReason).toBe("clarify_dispatch_failed");
    // Exactly ONE running doc, and `docIndex` is the doc that really runs.
    expect(persisted.docs.filter((doc) => doc.status === "running")).toHaveLength(1);
    expect(persisted.docs[1]!.status).toBe("running");
    expect(persisted.docIndex).toBe(1);
    expect(
      audits.some(
        (line) =>
          line.includes("pipeline_auto_start_terminated") &&
          line.includes("superseded_by_failure_accounting"),
      ),
    ).toBe(true);
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

describe("226 review round 2: a queued finalisation is never marker-guilty", () => {
  it("lost queue entry → refund + re-dispatch, never clarify_marker_missing", async () => {
    deployHarnessAgents(harness);
    writeDoc(READY_FULL_UND_DOC);
    const state = harness.state();
    state.docs[0]!.clarifyRounds = 1;
    state.docs[0]!.clarifyLastRound = 1;
    state.docs[0]!.clarifyDispatchedAt = Date.now();
    state.docs[0]!.clarifyFinalisationQueuedRound = 1;
    await writeJobState(harness.root, state);
    const meta = makeMeta(); // no pendingSpawns ⇒ the queue entry is provably gone
    const { ctx } = makeRealCtx(meta);

    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta)).toBe(true);

    const after = harness.state();
    // The document is NOT marker-guilty: the round never reached it.
    expect(after.docs[0]!.status).toBe("running");
    expect(after.docs[0]!.failReason).toBeUndefined();
    expect(sentMessages.some((message) => message.includes("full-und?"))).toBe(true);
    // The re-dispatch promoted the fact; the lost reservation was refunded, so
    // the budget still counts exactly ONE real dispatch.
    expect(after.docs[0]!.clarifyFinalisationRound).toBe(1);
    expect(after.docs[0]!.clarifyFinalisationQueuedRound).toBeUndefined();
    expect(after.docs[0]!.clarifyRounds).toBe(1);
    expect(audits.some((line) => line.includes("finalisation_queue_lost"))).toBe(true);
  });

  it("still-queued entry → the marker gate waits instead of failing the doc", async () => {
    writeDoc(READY_FULL_UND_DOC);
    const state = harness.state();
    state.docs[0]!.clarifyFinalisationQueuedRound = 1;
    await writeJobState(harness.root, state);
    const meta = {
      ...makeMeta(),
      pendingSpawns: {
        clarify: { agentName: "feat-design-plan-agent", requestedAt: Date.now(), attempts: 0 },
      },
    } as SessionMeta;
    const { ctx } = makeRealCtx(meta);

    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta)).toBe(true);

    const after = harness.state();
    expect(after.docs[0]!.status).toBe("running");
    expect(after.docs[0]!.failReason).toBeUndefined();
    expect(after.docs[0]!.clarifyFinalisationQueuedRound).toBe(1);
    expect(sentMessages).toHaveLength(0);
    expect(audits.some((line) => line.includes("finalisation_queued"))).toBe(true);
  });
});

describe("226 Phase 4: maxTotalFreezes timing (review B-#5)", () => {
  it("case A: consecutive failures reach the per-doc stall cap — the freeze budget does not preempt", async () => {
    deployHarnessAgents(harness);
    // The freeze BUDGET is 1 while the per-doc stall cap is 3: if the budget
    // preempted, the doc would stop as `freeze_budget_exhausted` after the
    // first freeze instead of walking the fixed 1 → 2 → 3 stall trajectory.
    restateJob(["  maxTotalFreezes: 2", "  maxTotalFreezes: 1"]);
    writeDoc(NEEDS_CLARIFY_DOC);
    const meta = makeMeta();
    const { ctx } = makeRealCtx(meta);
    const failingDeps = countingFreeze();

    // Three failed settles: stall 1 → 2 → 3 (trajectory pinned in unit tests).
    // The injected freeze books `totalFreezes`, so the budget really moves.
    for (let i = 0; i < 3; i++) {
      expect(await runAutoClarifyRound(ctx, configWithoutClarifyAgent(), meta, failingDeps)).toBe("consumed");
    }
    const state = harness.state();
    expect(state.counters.totalFreezes).toBe(2); // two freezes, both within the trajectory
    expect(state.docs[0]!.clarifyStalls).toBe(3);
    expect(state.docs[0]!.failReason).toBe("clarify_dispatch_failed");
    expect(state.status).toBe("failed");
    expect(audits.some((line) => line.includes("freeze_budget_exhausted"))).toBe(false);
  });

  it("case B: recovery then the NEXT settle with totalFreezes >= maxTotalFreezes → freeze_budget_exhausted", async () => {
    deployHarnessAgents(harness);
    restateJob(["  maxTotalFreezes: 2", "  maxTotalFreezes: 1"]);
    // A RECOVERED document (running, no unresolvable freeze) but the budget
    // was spent in the previous period.
    const state = harness.state();
    state.counters.totalFreezes = 1;
    await writeJobState(harness.root, state);

    const meta = makeTestMeta({ currentStage: "develop", requirementDoc: DOC });
    expect(await handleAutoSettle(makeOwnerStub(meta) as never, harness.config, meta)).toBe(true);

    const after = harness.state();
    expect(after.docs[0]!.failReason).toBe("freeze_budget_exhausted");
    // The JOB-level label stays the plain stop reason (no detail exists here).
    expect(after.stopReason).toBe("freeze_budget_exhausted");
  });
});
