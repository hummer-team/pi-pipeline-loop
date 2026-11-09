/**
 * E2E: the loop-exhaustion exits on their PRODUCTION entry points.
 *
 * The pure-policy suites (`on-exhausted-advance`, `advance-decision`) prove the
 * routing matrix; this suite proves that the same exits are actually REACHABLE
 * and execute when driven through the real seams:
 * - `runFreezeAutopilot` (the only auto freeze authority) must pass the LIVE
 *   config and then either advance (awaiting_human / completed), park the
 *   frozen pipeline (await-human) or stop it (`stop`), never
 *   `freeze_unresolvable` for an exhausted loop;
 * - the loop-exhaustion attribution (`exhausted(<reason>)`) must land on the
 *   DOC receipt while the JOB label stays `freeze_unresolvable`;
 * - the two-round same-id review freeze must fire from the REAL parser (stable
 *   IDs), not only from hand-built ledger snapshots;
 * - `loop_budget_exhausted` and `degraded_pass_duplicate` must be emitted with
 *   their documented fields;
 * - the develop-handoff prompt must show the design-review carry-over.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type {
  DegradedPassRecord,
  PipelineConfig,
  ReliableMetaCommitResult,
  SessionMeta,
} from "../../types";
import { makeTestConfig, makeTestMeta, seedCompletionEvidence } from "../helpers";
import { runFreezeAutopilot } from "../../core/auto-pipeline/freeze-autopilot";
import {
  acquireJobLock,
  __resetAutoJobLockForTests,
} from "../../core/auto-pipeline/config-overlay";
import {
  createJobState,
  readJobState,
  writeJobState,
  type AutoJobState,
} from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { noteReviewRoundOutcome } from "../../core/auto-pipeline/review-no-progress";
import { coordinateDesignReview, type CoordinatorContext } from "../../core/design-review/coordinator";
import { computeHash, createInitialState } from "../../core/design-review/state";
import { executeDecision, freezeAndPrompt } from "../../core/flow-state";
import { matchCommitExpectation, type MetaCommitExpectation } from "../../core/session-state";
import { codeReviewDocFileName, reqBaseFromRequirementDoc } from "../../docs-paths";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const DOC = "docs/design/200_Feat.md";
const JOB_ID = "alpha_loop";
const JOB_REL_PATH = "docs/jobs/alpha_loop.yaml";

interface AuditRow {
  event: string;
  message?: Record<string, string | boolean>;
  level?: string;
}

let ROOT: string;
let audits: AuditRow[];

/**
 * Job fixture: the legacy freeze policy plus whatever loop-exhaustion keys a
 * case needs (only the exhaustion family may take the loop exits).
 */
function jobYaml(extra: string[] = []): string {
  return [
    "version: 1",
    "enabled: true",
    "tier: rule",
    "docs:",
    "  list:",
    `    - doc: ${DOC}`,
    "freezePolicy:",
    "  onFreeze: resume",
    "  maxAutoResumes: 2",
    "  byReason:",
    "    verify_budget: stop-and-report",
    "    aborted_by_job: abort",
    ...extra,
  ].join("\n");
}

/** Install the job file + a running sidecar + the process-level lock. */
async function installJob(input?: {
  yaml?: string;
  counters?: Partial<AutoJobState["counters"]>;
  status?: AutoJobState["status"];
}): Promise<AutoJobState> {
  const yaml = input?.yaml ?? jobYaml();
  const jobPath = path.join(ROOT, JOB_REL_PATH);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, yaml, "utf8");
  const base = createJobState({
    jobId: JOB_ID,
    jobPath: JOB_REL_PATH,
    jobHash: hashJobBytes(yaml),
    docs: [{ doc: DOC }],
  });
  const state: AutoJobState = {
    ...base,
    status: input?.status ?? "running",
    counters: { ...base.counters, ...(input?.counters ?? {}) },
  };
  await writeJobState(ROOT, state);
  const lock = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
  if (!lock.ok) throw new Error("lock acquire failed");
  return state;
}

/** Strict-capable flow ctx: the advance exit commits through `updateMetaVerified`. */
function strictCtx(meta: SessionMeta) {
  let current: SessionMeta = { ...meta };
  const notified: string[] = [];
  const session = {
    getMeta: () => current,
    updateMeta: (patch: Partial<SessionMeta>): SessionMeta => {
      current = { ...current, ...patch };
      return current;
    },
    updateMetaVerified: (
      patch: Partial<SessionMeta>,
      expected: MetaCommitExpectation,
    ): ReliableMetaCommitResult => {
      const conflict = matchCommitExpectation(current, expected);
      if (conflict) return { status: "conflict", reason: conflict };
      current = { ...current, ...patch };
      return { status: "persisted", meta: current };
    },
  };
  return {
    ctx: { session, ui: { notify: (message: string) => notified.push(message) } },
    notified,
    meta: () => current,
  };
}

/** The PRODUCT topology: design-review → develop, review → fix, fix → completed. */
function productConfig(): PipelineConfig {
  const base = makeTestConfig({ projectRoot: ROOT });
  return makeTestConfig({
    projectRoot: ROOT,
    stages: {
      ...base.stages,
      fix: { ...base.stages.fix, nextStage: "completed" },
    },
  });
}

/** A review-stage pipeline frozen by an exhausted review/fix loop. */
function reviewFrozenMeta(reason: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return makeTestMeta({
    currentStage: "review",
    pipelineId: "pipe-exit-e2e",
    flowState: "blocked",
    blockedReason: reason,
    requirementDoc: DOC,
    reviewRound: { index: 2, stageStartTime: 111, enteredAt: 111, pipelineId: "pipe-exit-e2e" },
    reviewLedger: {
      loop: "reviewFix",
      roundIndex: 2,
      pipelineId: "pipe-exit-e2e",
      openIds: ["CR-2-1"],
      severityCounts: { Medium: 1 },
      severityById: { "CR-2-1": "Medium" },
      streak: 2,
    },
    stageVisitOrder: ["plan", "develop"],
    ...overrides,
  });
}

function auditEvents(): string[] {
  return audits.map((row) => row.event);
}

function auditRow(event: string): AuditRow | undefined {
  return audits.find((row) => row.event === event);
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-exit-e2e-"));
  __resetAutoJobLockForTests();
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, ...(message !== undefined ? { message } : {}), ...(level !== undefined ? { level } : {}) });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("exhaustion exit E2E: runFreezeAutopilot advance arm", () => {
  it("reviewFix exhaustion advances to the configured awaiting_human target", async () => {
    await installJob({
      yaml: jobYaml(["onExhaustedTarget:", "  reviewFix: awaiting_human"]),
    });
    const meta = reviewFrozenMeta("no_progress_detected");
    const env = strictCtx(meta);

    const result = await runFreezeAutopilot(env.ctx, meta, productConfig(), "no_progress_detected");

    expect(result).not.toBeNull();
    expect(result?.applied).toBe(true);
    expect(result?.message).toContain("advanced to awaiting_human");
    const after = env.meta();
    expect(after.currentStage).toBe("awaiting_human");
    expect(after.flowState).toBe("running");
    expect(after.blockedReason).toBeUndefined();
    // await-human exit carries NO degraded-pass record.
    expect(after.degradedPass).toBeUndefined();
    // The auto decision is attributed to the pipeline, never to a human.
    expect(auditRow("pipeline_auto_decision")?.message).toMatchObject({
      gate: "freeze",
      action: "advance",
      basis: "loop_default",
    });
    expect(auditRow("loop_exhausted_await_human")?.message?.decision).toBe("advance");
    // The job survives: no doc failure, no stop.
    expect(readJobState(ROOT, JOB_ID)?.status).toBe("running");
  });

  it("reviewFix exhaustion advances to completed and mirrors the degraded pass to the job doc", async () => {
    await installJob();
    const meta = reviewFrozenMeta("no_progress_detected");
    // Evidence ⑤ only: the review visit is outside this fixture's history, so
    // the exit is judged on the delivery summary the fixture seeds.
    await seedCompletionEvidence(
      makeTestConfig({ projectRoot: ROOT }),
      meta,
    );
    const env = strictCtx(meta);

    const result = await runFreezeAutopilot(env.ctx, meta, productConfig(), "no_progress_detected");

    const after = env.meta();
    expect(result?.message).toContain("advanced to completed");
    expect(after.currentStage).toBe("completed");
    expect(after.degradedPass?.scope).toBe("completion");
    // The doc mirror is a fire-and-forget sidecar write: flush its promise.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const persisted = readJobState(ROOT, JOB_ID)!;
    expect(persisted.status).toBe("running");
    // Phase 6 task 4: the doc-level mirror is display data written on commit.
    expect(persisted.docs[0]?.degradedPass).toEqual({
      reason: "no_progress_detected",
      round: 2,
      severityCounts: { Medium: 1 },
    });
    expect(auditEvents()).toContain("degraded_pass_written");
    expect(auditEvents()).not.toContain("pipeline_auto_stop");
  });

  it("design-review exhaustion advances to develop through the degraded release", async () => {
    await installJob();
    const planDoc = path.join(ROOT, "docs/design/200_Feat_Plan.md");
    const meta = makeTestMeta({
      currentStage: "design-review",
      pipelineId: "pipe-exit-e2e",
      flowState: "blocked",
      blockedReason: "design_review_budget_exhausted",
      requirementDoc: DOC,
      stageVisitOrder: ["clarify", "plan"],
      designReview: {
        schemaVersion: 1,
        planDoc,
        authorizationId: "auth-e2e",
        authorizationSource: "menu",
        round: 2,
        phase: "review_running",
        planHash: "plan-hash",
        outcome: { reportHash: "report-hash", recordedAt: 1 },
        operation: {
          operationId: "op-review-e2e",
          kind: "review",
          stageVisitId: 1,
          attempt: 1,
          dispatchState: "dispatched",
          createdAt: 1,
          updatedAt: 1,
        },
        progressLedger: {
          loop: "designReview",
          round: 2,
          pipelineId: "pipe-exit-e2e",
          openIds: ["DR-1-1"],
          severityCounts: { Medium: 1 },
          severityById: { "DR-1-1": "Medium" },
          streak: 2,
        },
        authorizedAt: 1,
        updatedAt: 2,
      },
    });
    const env = strictCtx(meta);

    const result = await runFreezeAutopilot(env.ctx, meta, productConfig(), "design_review_budget_exhausted");

    const after = env.meta();
    expect(result?.message).toContain("advanced to develop");
    expect(after.currentStage).toBe("develop");
    expect(after.flowState).toBe("running");
    expect(after.designReview?.phase).toBe("finished");
    // B5: the carried set lands as a `loop-exit` record (visibility only).
    expect(after.degradedPass?.scope).toBe("loop-exit");
    expect(after.degradedPass?.openIssues).toEqual([
      { id: "DR-1-1", severity: "Medium", status: "carry-over" },
    ]);
    expect(after.exhaustedLoops?.map((entry) => entry.loop)).toEqual(["designReview"]);
  });

  it("await-human: the frozen pipeline is kept and only audited (no execution)", async () => {
    await installJob({
      yaml: jobYaml(["onExhausted:", "  reviewFix: await-human"]),
    });
    const meta = reviewFrozenMeta("no_progress_detected");
    const env = strictCtx(meta);

    const result = await runFreezeAutopilot(env.ctx, meta, productConfig(), "no_progress_detected");

    expect(result?.applied).toBe(true);
    expect(result?.message).toContain("await-human");
    const after = env.meta();
    // NOTHING executed: still frozen at the same stage.
    expect(after.currentStage).toBe("review");
    expect(after.flowState).toBe("blocked");
    expect(after.blockedReason).toBe("no_progress_detected");
    const audit = auditRow("loop_exhausted_await_human");
    expect(audit?.message?.loop).toBe("reviewFix");
    expect(audit?.message?.reason).toBe("no_progress_detected");
    expect(readJobState(ROOT, JOB_ID)?.status).toBe("running");
  });

  it("stop: the exhausted doc is receipted as exhausted(<reason>) while the job label stays freeze_unresolvable", async () => {
    await installJob({
      yaml: jobYaml(["onExhausted:", "  reviewFix: stop"]),
    });
    const meta = reviewFrozenMeta("no_progress_detected");
    const env = strictCtx(meta);

    const result = await runFreezeAutopilot(env.ctx, meta, productConfig(), "no_progress_detected");

    expect(result?.applied).toBe(true);
    const persisted = readJobState(ROOT, JOB_ID)!;
    expect(persisted.status).toBe("failed");
    expect(persisted.stopReason).toBe("freeze_unresolvable");
    // F8 attribution: the DOC receipt names the real cause.
    expect(persisted.docs[0]?.failReason).toBe("exhausted(no_progress_detected)");
    expect(auditEvents()).toContain("pipeline_auto_stop");
    // No decision was applied — the pipeline stays frozen for the operator.
    expect(env.meta().flowState).toBe("blocked");
  });

  it("a non-exhaustion reason still stops with the real freeze_unresolvable attribution", async () => {
    await installJob();
    const meta = reviewFrozenMeta("verify_budget");
    const env = strictCtx(meta);

    await runFreezeAutopilot(env.ctx, meta, productConfig(), "verify_budget");

    const persisted = readJobState(ROOT, JOB_ID)!;
    expect(persisted.stopReason).toBe("freeze_unresolvable");
    // `exhaustedDocReason` only rewrites the exhaustion family.
    expect(persisted.docs[0]?.failReason).toBe("freeze_unresolvable(verify_budget)");
  });
});

describe("exhaustion exit E2E: two-round same-id review freeze", () => {
  function report(ids: readonly string[]): string {
    return [
      "# Code Review",
      "",
      "## Review发现以下问题",
      ...ids.flatMap((id, i) => [
        `### 问题 ${String(i + 1)}`,
        `- ID: ${id}`,
        "- 问题: src/x.ts:10 实现与规划不一致",
        "- 等级：Medium",
        "- 是否修复：待修复",
        "",
      ]),
      "## 结论",
      "- 结论：不通过",
    ].join("\n");
  }

  function writeReport(round: number, ids: readonly string[]): string {
    const reviewDir = path.join(ROOT, "docs", "review");
    fs.mkdirSync(reviewDir, { recursive: true });
    const file = path.join(reviewDir, codeReviewDocFileName(reqBaseFromRequirementDoc(DOC), round));
    fs.writeFileSync(file, report(ids), "utf-8");
    return file;
  }

  it("round 2 replaying the SAME ids freezes (stable ids + consumed grace)", async () => {
    // The one-shot observation grace was already spent in a previous round.
    await installJob({ counters: { noProgressGraceUsed: { [DOC]: 1 } } });
    const env = strictCtx(
      reviewFrozenMeta("running", {
        flowState: "running",
        blockedReason: undefined,
        reviewLedger: undefined,
        stageVisitOrder: ["plan", "develop", "review"],
      }),
    );

    const round1 = await noteReviewRoundOutcome({
      config: productConfig(),
      meta: env.meta(),
      session: env.ctx.session,
      reportPath: writeReport(1, ["CR-2-1", "CR-2-2"]),
      round: 1,
    });
    expect(round1).toMatchObject({ verdict: "progress", frozen: false });
    expect(env.meta().reviewLedger?.openIds).toEqual(["CR-2-1", "CR-2-2"]);

    const round2 = await noteReviewRoundOutcome({
      config: productConfig(),
      meta: env.meta(),
      session: env.ctx.session,
      reportPath: writeReport(2, ["CR-2-1", "CR-2-2"]),
      round: 2,
    });

    expect(round2).toMatchObject({ verdict: "exhausted", frozen: true });
    const after = env.meta();
    expect(after.flowState).toBe("blocked");
    expect(after.blockedReason).toBe("no_progress_detected");
    // The freeze happens AT the review round — nothing routes onward.
    expect(after.currentStage).toBe("review");
    expect(after.reviewLedger?.openIds).toEqual(["CR-2-1", "CR-2-2"]);
  });
});

describe("exhaustion exit E2E: audit vocabulary", () => {
  it("loop_budget_exhausted carries loop / round / maxRounds / reason", async () => {
    const meta = makeTestMeta({
      currentStage: "review",
      pipelineId: "pipe-exit-e2e",
      reviewRound: { index: 4, stageStartTime: 111, enteredAt: 111, pipelineId: "pipe-exit-e2e" },
      reviewLedger: {
        loop: "reviewFix",
        roundIndex: 4,
        pipelineId: "pipe-exit-e2e",
        openIds: ["CR-4-1"],
        severityCounts: { Medium: 1 },
        streak: 2,
      },
      maxLoopCycles: 5,
    });
    const env = strictCtx(meta);

    await freezeAndPrompt(env.ctx, meta, "max_loop_cycles", productConfig());

    const row = auditRow("loop_budget_exhausted");
    expect(row?.message).toMatchObject({
      pipelineId: "pipe-exit-e2e",
      stage: "review",
      loop: "reviewFix",
      round: "4",
      maxRounds: "5",
      reason: "max_loop_cycles",
    });
    expect(row?.level).toBe("warn");
  });

  it("no_progress_detected is NOT a budget reason (no loop_budget_exhausted row)", async () => {
    const meta = makeTestMeta({
      currentStage: "review",
      pipelineId: "pipe-exit-e2e",
      reviewRound: { index: 3, stageStartTime: 111, enteredAt: 111, pipelineId: "pipe-exit-e2e" },
      reviewLedger: {
        loop: "reviewFix",
        roundIndex: 3,
        pipelineId: "pipe-exit-e2e",
        openIds: ["CR-3-1"],
        severityCounts: { Medium: 1 },
        streak: 2,
      },
    });
    const env = strictCtx(meta);

    await freezeAndPrompt(env.ctx, meta, "no_progress_detected", productConfig());

    expect(auditEvents()).not.toContain("loop_budget_exhausted");
    expect(env.meta().blockedReason).toBe("no_progress_detected");
  });

  it("a repeat advance for the SAME (pipelineId, round, reason) audits degraded_pass_duplicate once", async () => {
    const existing: DegradedPassRecord = {
      scope: "completion",
      reason: "no_progress_detected",
      pipelineId: "pipe-exit-e2e",
      docPath: DOC,
      stage: "review",
      round: 2,
      openIssues: [{ id: "CR-2-1", severity: "Medium", status: "accepted-risk" }],
      severityCounts: { Medium: 1 },
      at: 1,
    };
    const meta = reviewFrozenMeta("no_progress_detected", {
      degradedPass: existing,
      stageVisitOrder: ["plan", "develop"],
    });
    const env = strictCtx(meta);

    await executeDecision(env.ctx, meta, "advance", productConfig(), { source: "test" });

    const duplicates = audits.filter((row) => row.event === "degraded_pass_duplicate");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.message).toMatchObject({
      pipelineId: "pipe-exit-e2e",
      reason: "no_progress_detected",
      round: "2",
    });
    // The existing record is reused verbatim — never re-stamped.
    expect(env.meta().degradedPass?.at).toBe(1);
  });

  it("a FIRST advance for the same key does not audit a duplicate", async () => {
    const meta = reviewFrozenMeta("no_progress_detected", {
      stageVisitOrder: ["plan", "develop"],
    });
    const env = strictCtx(meta);

    await executeDecision(env.ctx, meta, "advance", productConfig(), { source: "test" });

    expect(auditEvents()).not.toContain("degraded_pass_duplicate");
  });
});

describe("exhaustion exit E2E: develop-handoff carry-over visibility", () => {
  /**
   * Drive the REAL coordinator pass_ready → develop-handoff dispatch and
   * capture the prompt the executor receives. The carry-over block is
   * mutually exclusive with the review findings directive (B8) and adds zero
   * bytes when no `loop-exit` record exists.
   */
  async function dispatchHandoffPrompt(degradedPass?: DegradedPassRecord): Promise<string> {
    const config = productConfig();
    const planDoc = path.join(ROOT, "docs/design/200_Feat_Plan.md");
    fs.mkdirSync(path.dirname(planDoc), { recursive: true });
    fs.writeFileSync(planDoc, "# Plan\n\ncontent\n", "utf-8");
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const base = createInitialState(planDoc, "menu", planHash, undefined, {
      pipelineId: "pipe-exit-e2e",
    });
    const handoffId = "op-handoff-carry-1";
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-exit-e2e",
      requirementDoc: DOC,
      designReview: {
        ...base,
        phase: "pass_ready",
        approval: {
          reviewOperationId: "op-review-carry-1",
          round: 1,
          planHash,
          reportHash: "c".repeat(64),
          authorizedAt: 1,
        },
        operation: {
          operationId: handoffId,
          kind: "develop-handoff",
          stageVisitId: base.authorizedAt,
          attempt: 1,
          dispatchState: "pending",
          dispatchEvidence: "confirmed_not_sent",
          round: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      ...(degradedPass !== undefined ? { degradedPass } : {}),
    });
    const env = strictCtx(meta);
    let prompt = "";
    const ctx: CoordinatorContext = {
      config,
      session: env.ctx.session,
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async (_cfg, _stage, _meta, extraArgs) => {
        prompt = extraArgs ?? "";
        return {
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: "agent-carry-1",
          dispatchOutcome: "spawned_id" as const,
        };
      },
    };

    const result = await coordinateDesignReview(ctx, env.meta(), "advance");
    expect(result.status === "handled" && result.action === "advanced").toBe(true);
    return prompt;
  }

  it("a loop-exit degraded pass renders the carry-over block in the develop prompt", async () => {
    const prompt = await dispatchHandoffPrompt({
      scope: "loop-exit",
      reason: "design_review_budget_exhausted",
      pipelineId: "pipe-exit-e2e",
      docPath: DOC,
      stage: "design-review",
      round: 2,
      openIssues: [
        { id: "DR-1-1", severity: "Medium", status: "carry-over" },
        { id: "DR-1-2", severity: "Low", status: "carry-over" },
      ],
      severityCounts: { Medium: 1, Low: 1 },
      at: 1,
    });

    expect(prompt).toContain("[auto-pipeline] Carry-over from design-review (accepted by advance):");
    expect(prompt).toContain("DR-1-1 | Medium");
    expect(prompt).toContain("DR-1-2 | Low");
  });

  it("no loop-exit record ⇒ the develop prompt stays byte-identical (zero carry-over bytes)", async () => {
    const prompt = await dispatchHandoffPrompt();

    // The prompt is real (handoff task), just without the carry-over block.
    expect(prompt).toContain("Plan to implement (read-only):");
    expect(prompt).not.toContain("Carry-over from design-review");
  });
});