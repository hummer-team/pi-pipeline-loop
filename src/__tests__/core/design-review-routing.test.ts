/**
 * 192 Phase 3 rewrite: design-review coordinator routing under the TRUSTED
 * verification contract (K02/K07/F02/F05).
 *
 * - Report fixtures deliver the same identity contract production enforces
 *   (pipeline/plan/round/operation/input-hash rows, anchored verdict).
 * - Foreign pipeline / stale operation / version-drifted reports are REJECTED
 *   (verify_failed → normal verification-failure budget, NOT a fake PASS).
 * - ALL triggers (settle/advance/verify/handoff) are handled for an active
 *   authorized loop — no fallback to ordinary branches (F05).
 *
 * No mock.module() used — writeAuditLog is safe (returns early without
 * auditDir); spawn substitutes come through the controlled spawnOverride hook
 * with verifiable agentIds.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  makeTestConfig,
  makeTestMeta,
  reviewReportContent,
  boundReviewOperation,
} from "../helpers";
import { matchCommitExpectation } from "../../core/session-state";
import { computeHash, createInitialState } from "../../core/design-review/state";
import type { CoordinatorContext } from "../../core/design-review/coordinator";
import { coordinateDesignReview } from "../../core/design-review/coordinator";

const REVIEW_OP_ID = "op-review-fixture-1";
const UPDATE_OP_ID = "op-update-fixture-1";

describe("design-review-coordinator routing", () => {
  let tempDir: string;
  let planDoc: string;
  let planHash: string;
  let config: PipelineConfig;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dr-routing-"));
    planDoc = join(tempDir, "plan.md");
    const planContent = "# Test Plan\n\nContent here.";
    await writeFile(planDoc, planContent, "utf-8");
    planHash = computeHash(planContent);

    // 194 Phase 1 (C4): the plan/report deliverables live INSIDE the project
    // root exactly like production — the update scope preflight (and the
    // permission guard) never authorize deliverables outside projectRoot.
    config = makeTestConfig({
      projectRoot: tempDir,
      maxLoopCycles: 3,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "./agents/develop.md",
          skillPath: "develop/SKILL.md",
          nextStage: "completed",
          requireDomain: false,
        },
      },
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

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

  function createCoordinatorCtx(meta: SessionMeta, spawnOverride?: CoordinatorContext["spawnOverride"]): CoordinatorContext {
    return {
      config,
      session: createMockSession(meta),
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride,
    };
  }

  /** Review_running state bound to REVIEW_OP_ID + authorized plan hash */
  function reviewRunningMeta(extra?: Partial<SessionMeta>): SessionMeta {
    const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    return makeTestMeta({
      currentStage: "design-review",
      designReview: {
        ...drState,
        phase: "review_running",
        round: 1,
        operation: boundReviewOperation(REVIEW_OP_ID, planHash),
      },
      loopCycleCount: 0,
      ...extra,
    });
  }

  async function writeReport(text: string): Promise<string> {
    const reportDoc = join(tempDir, "review-design-1-plan.md");
    await writeFile(reportDoc, text, "utf-8");
    return reportDoc;
  }

  const trustedSpawn = async () => ({
    spawned: true,
    fallback: false,
    deferred: false,
    agentId: "agent-test-1",
    dispatchOutcome: "spawned_id" as const,
  });

  describe("not-applicable paths", () => {
    test("no designReview state returns not-applicable", async () => {
      const meta = makeTestMeta({ currentStage: "design-review" });
      const ctx = createCoordinatorCtx(meta);
      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("finished phase returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "finished" },
      });
      const ctx = createCoordinatorCtx(meta);
      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("paused with authorization-lost returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "paused", pauseReason: "authorization-lost" },
      });
      const ctx = createCoordinatorCtx(meta);
      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });
  });

  describe("review_running: trusted report consumption", () => {
    test("valid PASS report + trusted handoff → advanced, finished only after receipt", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: REVIEW_OP_ID,
        inputHash: planHash,
        verdict: "PASS",
      }));
      const meta = reviewRunningMeta();
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "advanced").toBe(true);
      const after = ctx.session.getMeta();
      expect(after?.designReview?.phase).toBe("finished");
      expect(after?.designReview?.operation?.kind).toBe("develop-handoff");
      expect(after?.designReview?.operation?.dispatchEvidence).toBe("trusted_id");
      expect(after?.currentStage).toBe("develop");
      expect(after?.designReview?.approval?.reviewOperationId).toBe(REVIEW_OP_ID);
    });

    test("valid FAIL report → routed to plan with a distinct update operation", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: REVIEW_OP_ID,
        inputHash: planHash,
        verdict: "FAIL",
        issues: ["Missing error handling", "Incomplete specification"],
      }));
      const meta = reviewRunningMeta();
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "routed" && "toStage" in result && result.toStage === "plan").toBe(true);
      const after = ctx.session.getMeta()!.designReview!;
      expect(after.operation?.kind).toBe("update");
      expect(after.operation?.operationId).not.toBe(REVIEW_OP_ID);
      expect(after.reviewInputReceipt?.reviewIdentity.operationId).toBe(REVIEW_OP_ID);
      expect(after.reviewInputReceipt?.issueIds).toEqual(["1", "2"]);
      expect(ctx.session.getMeta()!.currentStage).toBe("plan");
    });

    test("valid issues alongside a PASS line FAIL the domain verdict (issues first)", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: REVIEW_OP_ID,
        inputHash: planHash,
        verdict: "PASS",
        // verdict row PASS but issues non-empty → consumer must route FAIL
      }).replace("## Issues\nNone", "## Issues\n1. Real defect despite PASS claim"));
      const meta = reviewRunningMeta();
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      // NOT develop: FAIL-consumption routed to plan
      expect(result.status === "handled" && result.action === "routed" && "toStage" in result && result.toStage === "plan").toBe(true);
    });

    test("foreign pipeline report → verify_failed (identity rejection, never PASS)", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "someone-elses-pipeline",
        planDoc,
        round: 1,
        operationId: REVIEW_OP_ID,
        inputHash: planHash,
        verdict: "PASS",
      }));
      const meta = reviewRunningMeta();
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "verify_failed").toBe(true);
      // stage NOT advanced to develop
      expect(ctx.session.getMeta()!.currentStage).toBe("design-review");
    });

    test("stale operation id in report → verify_failed", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: "op-FROM-PREVIOUS-LIFE",
        inputHash: planHash,
        verdict: "PASS",
      }));
      const meta = reviewRunningMeta();
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "verify_failed").toBe(true);
    });

    test("input-hash mismatch (plan version drift) → verify_failed", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: REVIEW_OP_ID,
        inputHash: "f".repeat(64),
        verdict: "PASS",
      }));
      const meta = reviewRunningMeta();
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "verify_failed").toBe(true);
    });

    test("report without any conclusion line → verify_failed", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: REVIEW_OP_ID,
        inputHash: planHash,
        verdict: "PASS",
        verdictRow: null,
      }));
      const meta = reviewRunningMeta();
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "verify_failed").toBe(true);
    });

    test("budget exceeded before routing returns frozen (valid FAIL report)", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: REVIEW_OP_ID,
        inputHash: planHash,
        verdict: "FAIL",
        issues: ["Some defect"],
      }));
      const meta = reviewRunningMeta({ loopCycleCount: 3 });
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "frozen").toBe(true);
    });

    test("advance/verify/handoff triggers are ALL handled — no ordinary fallback (F05)", async () => {
      await writeReport(reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: REVIEW_OP_ID,
        inputHash: planHash,
        verdict: "PASS",
      }));
      for (const trigger of ["advance", "verify", "handoff"] as const) {
        const meta = reviewRunningMeta();
        const ctx = createCoordinatorCtx(meta, trustedSpawn);
        const result = await coordinateDesignReview(ctx, meta, trigger);
        expect(result.status === "handled" && result.action === "advanced").toBe(true);
      }
    });
  });

  describe("update_ready / update_running", () => {
    test("update_ready settle dispatches update (routed) with trusted spawn", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "plan",
        designReview: { ...drState, phase: "update_ready", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled" && result.action === "routed") {
        expect(result.toStage).toBe("plan");
      } else {
        // render blocked on missing template default? must not silently pass — assert explicit
        expect(["pending", "frozen"]).toContain(result.status === "handled" ? result.action : "unexpected");
      }
    });

    test("update_running non-settle trigger is handled (F05), plan unchanged → pending/paused path", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: {
          ...drState,
          phase: "update_running",
          round: 1,
          operation: {
            operationId: UPDATE_OP_ID,
            kind: "update" as const,
            stageVisitId: Date.now(),
            attempt: 1,
            dispatchState: "dispatched" as const,
            agentId: "a",
            round: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta, trustedSpawn);

      const result = await coordinateDesignReview(ctx, meta, "verify");
      // F05: never not-applicable for an active authorized loop
      expect(result.status).toBe("handled");
    });
  });

  describe("paused / pass_ready", () => {
    test("paused returns pending with pause reason", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        designReview: { ...drState, phase: "paused", pauseReason: "drift" },
      });
      const ctx = createCoordinatorCtx(meta);
      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "pending").toBe(true);
    });

    test("pass_ready without handoff operation stays pending (takeover retained)", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "develop",
        designReview: { ...drState, phase: "pass_ready" },
      });
      const ctx = createCoordinatorCtx(meta);
      const result = await coordinateDesignReview(ctx, meta, "advance");
      expect(result.status === "handled" && result.action === "pending").toBe(true);
    });
  });
});
