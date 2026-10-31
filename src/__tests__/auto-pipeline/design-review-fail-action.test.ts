/**
 * 219 Phase 3 §4 (G4) — `designReview.failAction` consumption.
 *
 * Review 219 issue 2: the schema parsed `"auto-revise" | "stop"` but NOTHING
 * read it, so a job that asked "FAIL stops this document" kept revising until
 * some other budget happened to trip. These tests pin the two behaviours:
 * - `stop` → the coordinator hands the doc to the Phase 5 transaction
 *   (`handleDocFailure`, stop reason `budget_exhausted`);
 * - `auto-revise` (and human mode) → the existing revise-plan route is intact.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  boundReviewOperation,
  makeTestConfig,
  makeTestMeta,
  reviewReportContent,
} from "../helpers";
import { matchCommitExpectation } from "../../core/session-state";
import { computeHash, createInitialState } from "../../core/design-review/state";
import {
  coordinateDesignReview,
  type CoordinatorContext,
} from "../../core/design-review/coordinator";
import {
  acquireJobLock,
  __resetAutoJobLockForTests,
} from "../../core/auto-pipeline/config-overlay";
import { createJobState, readJobState, writeJobState } from "../../core/auto-pipeline/job-state";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const JOB_ID = "alpha";
const REVIEW_OP_ID = "op-review-fail-action";

function jobYaml(failAction: "auto-revise" | "stop"): string {
  return [
    "version: 1",
    "enabled: true",
    "docs:",
    "  list:",
    "    - doc: docs/design/plan.md",
    "designReview:",
    "  mode: auto",
    "  maxRounds: 3",
    `  failAction: ${failAction}`,
  ].join("\n");
}

let ROOT: string;
let planDoc: string;
let planHash: string;
let config: PipelineConfig;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "pi-219-fail-action-"));
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async () => undefined);

  planDoc = join(ROOT, "plan.md");
  const planContent = "# Test Plan\n\nContent here.";
  await writeFile(planDoc, planContent, "utf-8");
  planHash = computeHash(planContent);
  config = makeTestConfig({ projectRoot: ROOT });
});

afterEach(async () => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  await rm(ROOT, { recursive: true, force: true });
});

/** Install a running job (sidecar + process lock) with the requested failAction. */
async function installJob(failAction: "auto-revise" | "stop"): Promise<void> {
  const jobDir = join(ROOT, "docs", "jobs");
  fs.mkdirSync(jobDir, { recursive: true });
  const yaml = jobYaml(failAction);
  fs.writeFileSync(join(jobDir, `${JOB_ID}.yaml`), yaml, "utf8");

  const state = createJobState({
    jobId: JOB_ID,
    jobPath: `docs/jobs/${JOB_ID}.yaml`,
    jobHash: "hash",
    docs: [{ doc: "docs/design/plan.md" }],
  });
  state.status = "running";
  state.docs[0]!.status = "running";
  await writeJobState(ROOT, state);

  const lock = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
  if (!lock.ok) throw new Error("fail-action harness: lock acquire failed");
}

function createMockSession(meta: SessionMeta) {
  let currentMeta = { ...meta };
  return {
    getMeta: () => currentMeta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      currentMeta = { ...currentMeta, ...patch };
      return currentMeta;
    },
    updateMetaVerified: (
      patch: Partial<SessionMeta>,
      expected: import("../../core/session-state").MetaCommitExpectation,
    ): import("../../types").ReliableMetaCommitResult => {
      const conflict = matchCommitExpectation(currentMeta, expected);
      if (conflict) return { status: "conflict", reason: conflict };
      currentMeta = { ...currentMeta, ...patch };
      return { status: "persisted", meta: currentMeta };
    },
  };
}

async function failRoundMeta(): Promise<{ meta: SessionMeta; ctx: CoordinatorContext }> {
  await writeFile(
    join(ROOT, "Design_Review_1_plan_Design.md"),
    reviewReportContent({
      pipelineId: "pipe-fail-action",
      planDoc,
      round: 1,
      operationId: REVIEW_OP_ID,
      inputHash: planHash,
      verdict: "FAIL",
      issues: ["Missing error handling"],
    }),
    "utf-8",
  );
  const drState = createInitialState(planDoc, "menu", planHash, undefined, {
    pipelineId: "pipe-fail-action",
  });
  const meta = makeTestMeta({
    pipelineId: "pipe-fail-action",
    currentStage: "design-review",
    designReview: {
      ...drState,
      phase: "review_running",
      round: 1,
      operation: boundReviewOperation(REVIEW_OP_ID, planHash, 1),
    },
    loopCycleCount: 0,
    autoJob: {
      jobId: JOB_ID,
      jobPath: `docs/jobs/${JOB_ID}.yaml`,
      docIndex: 0,
      totalDocs: 1,
      designReviewMaxRounds: 3,
      designReviewRounds: 0,
      lastCountedDesignReviewRound: 0,
    },
  });
  const ctx: CoordinatorContext = {
    config,
    session: createMockSession(meta),
    ui: { notify: () => {} },
    pi: { sendUserMessage: () => {} },
    spawnOverride: async () => ({
      spawned: true,
      fallback: false,
      deferred: false,
      agentId: "agent-fail-action",
      dispatchOutcome: "spawned_id" as const,
    }),
  };
  return { meta, ctx };
}

describe("design-review failAction (G4)", () => {
  it("failAction:stop ends the DOC through handleDocFailure (no revise dispatch)", async () => {
    await installJob("stop");
    const { meta, ctx } = await failRoundMeta();

    const result = await coordinateDesignReview(ctx, meta, "settle");

    expect(result).toEqual({ status: "handled", action: "pending", reason: "auto_fail_action_stop" });
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[0]?.failReason).toBe("design_review_fail_action_stop");
    // onFailure defaults to "stop" → the job is terminal, never left running.
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("budget_exhausted");
    // No update operation was created (the release invalidates the loop, so the
    // operation may be cleared; it must never be a revise dispatch).
    expect(ctx.session.getMeta()!.designReview?.operation?.kind ?? "none").not.toBe("update");
    expect(ctx.session.getMeta()!.currentStage).toBe("design-review");
  });

  it("failAction:auto-revise keeps the existing revise-plan route", async () => {
    await installJob("auto-revise");
    const { meta, ctx } = await failRoundMeta();

    const result = await coordinateDesignReview(ctx, meta, "settle");

    expect(result.status === "handled" && result.action === "routed" && "toStage" in result && result.toStage === "plan").toBe(true);
    expect(ctx.session.getMeta()!.designReview?.operation?.kind).toBe("update");
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.status).toBe("running");
  });
});
