/**
 * 192 Phase 3 (K02/K10): shared verification wiring tests.
 *
 * runVerification is the single trusted entry:
 * - active design-review/update contexts produce `designReviewOutcome` even
 *   when verify.require is false or config-skipped (skip cannot fabricate
 *   PASS);
 * - valid business FAIL may coexist with rulePassed=true — routing consumes
 *   the outcome, never raw rulePassed;
 * - the update context consumes the SAME meta state (no second parser);
 * - the verification service is READ-ONLY (no meta mutation, no dispatch).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { SessionMeta, DesignReviewState } from "../../types";
import { runVerification } from "../../core/auto-verifier";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
} from "../../core/design-review/state";
import { makeTestConfig, makeTestMeta, reviewReportContent } from "../helpers";

const OP_ID = "op-shared-review-1";

describe("192 Phase 3: runVerification domain outcome wiring", () => {
  let projectRoot: string;
  let planDoc: string;
  let planHash: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-shared-ver-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "190_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\ncontent\n", "utf-8");
    planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function reviewRunningState(withOperation: boolean): DesignReviewState {
    const base = createInitialState(planDoc, "menu", planHash, undefined, {
      pipelineId: "pipe-test-001",
    });
    if (!withOperation) return { ...base, phase: "review_running" };
    return {
      ...base,
      phase: "review_running",
      operation: {
        operationId: OP_ID,
        kind: "review",
        stageVisitId: 1000,
        attempt: 1,
        dispatchState: "dispatched",
        agentId: "agent-1",
        inputHash: planHash,
        round: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    };
  }

  function writePassReport(): void {
    fs.writeFileSync(deriveReportPath(planDoc, 1), reviewReportContent({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: planHash,
      verdict: "PASS",
    }), "utf-8");
  }

  function writeFailReport(): void {
    fs.writeFileSync(deriveReportPath(planDoc, 1), reviewReportContent({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: planHash,
      verdict: "FAIL",
      issues: ["Missing error handling"],
    }), "utf-8");
  }

  it("verify.require=false CANNOT skip the trusted domain contract", async () => {
    writeFailReport();
    const config = makeTestConfig({ projectRoot });
    // default makeTestConfig stages carry no verify block → require falsy
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: reviewRunningState(true),
    });
    const vr = await runVerification(config, meta, []);
    expect(vr.rulePassed).toBe(true); // ordinary rules: nothing required → pass
    expect(vr.designReviewOutcome).toBeDefined();
    // …but the DOMAIN verdict is fail: rulePassed must never mean develop
    expect(vr.designReviewOutcome?.kind).toBe("report");
    if (vr.designReviewOutcome?.kind === "report") {
      expect(vr.designReviewOutcome.verdict).toBe("fail");
      expect(vr.designReviewOutcome.issues.map((i) => i.issueId)).toEqual(["1"]);
    }
  });

  it("PASS report yields report/pass outcome bound to the current identity", async () => {
    writePassReport();
    const config = makeTestConfig({ projectRoot });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: reviewRunningState(true),
    });
    const vr = await runVerification(config, meta, []);
    const out = vr.designReviewOutcome;
    expect(out?.kind).toBe("report");
    if (out?.kind === "report") {
      expect(out.verdict).toBe("pass");
      expect(out.identity.operationId).toBe(OP_ID);
      expect(out.identity.authorizationId).toBe(meta.designReview!.authorizationId);
      expect(out.planHash).toBe(planHash);
    }
  });

  it("no operation bound (identity-incomplete running) yields NO outcome (blocked, not ordinary pass)", async () => {
    writePassReport();
    const config = makeTestConfig({ projectRoot });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: reviewRunningState(false),
    });
    const vr = await runVerification(config, meta, []);
    expect(vr.designReviewOutcome).toBeUndefined();
  });

  it("ordinary stages (no design-review state) never gain domain semantics", async () => {
    const config = makeTestConfig({ projectRoot });
    const meta = makeTestMeta({ currentStage: "develop" });
    const vr = await runVerification(config, meta, []);
    expect(vr.designReviewOutcome).toBeUndefined();
  });

  it("update context: outcome from plan snapshot + receipt (ready), read-only", async () => {
    // Set up update_running on the plan stage with a valid current section
    const reviewOp = {
      operationId: "op-consumed-review",
      kind: "review" as const,
      stageVisitId: 1,
      attempt: 1,
      dispatchState: "completed" as const,
      round: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const updatedPlan = [
      "# Plan",
      "changed content here",
      "",
      "## Design Review Update",
      "",
      `**Report**: ${deriveReportPath(planDoc, 1)}`,
      "**Round**: 1",
      "**Operation**: op-update-running-1",
      `**Baseline Hash**: ${planHash}`,
      "",
      "### Issue Dispositions",
      "",
      "| # | Issue | Disposition | Justification |",
      "|---|-------|-------------|---------------|",
      "| 1 | Missing error handling | fixed | added error handling |",
      "",
    ].join("\n");
    fs.writeFileSync(planDoc, updatedPlan, "utf-8");
    const newPlanHash = computeHash(updatedPlan);

    const base = createInitialState(planDoc, "menu", planHash, undefined, {
      pipelineId: "pipe-test-001",
    });
    const meta = makeTestMeta({
      currentStage: "plan",
      designReview: {
        ...base,
        phase: "update_running",
        operation: {
          operationId: "op-update-running-1",
          kind: "update",
          stageVisitId: 2,
          attempt: 1,
          dispatchState: "dispatched",
          agentId: "agent-u",
          round: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        reviewInputReceipt: {
          reviewIdentity: {
            pipelineId: "pipe-test-001",
            planDoc,
            authorizationId: base.authorizationId,
            round: 1,
            kind: "review",
            operationId: reviewOp.operationId,
            stageVisitId: 1,
          },
          reportDoc: deriveReportPath(planDoc, 1),
          reportHash: "a".repeat(64),
          inputPlanHash: planHash,
          issueIds: ["1"],
        },
      } satisfies DesignReviewState,
    });

    const config = makeTestConfig({ projectRoot });
    const metaBefore = JSON.stringify(meta);
    const vr = await runVerification(config, meta, []);
    const out = vr.designReviewOutcome;
    expect(out?.kind).toBe("update");
    if (out?.kind === "update") {
      expect(out.status).toBe("ready");
      expect(out.newPlanHash).toBe(newPlanHash);
      expect(out.baselinePlanHash).toBe(planHash);
      expect(out.identity.operationId).toBe("op-update-running-1");
    }
    // verification service is READ-ONLY: meta untouched
    expect(JSON.stringify(meta)).toBe(metaBefore);
  });

  it("update context with structural gap returns invalid failures (no leniency)", async () => {
    const base = createInitialState(planDoc, "menu", planHash, undefined, {
      pipelineId: "pipe-test-001",
    });
    fs.writeFileSync(planDoc, "# Plan\nchanged only\n", "utf-8");
    const meta = makeTestMeta({
      currentStage: "plan",
      designReview: {
        ...base,
        phase: "update_running",
        operation: {
          operationId: "op-update-no-section",
          kind: "update",
          stageVisitId: 2,
          attempt: 1,
          dispatchState: "dispatched",
          round: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        reviewInputReceipt: {
          reviewIdentity: {
            pipelineId: "pipe-test-001",
            planDoc,
            authorizationId: base.authorizationId,
            round: 1,
            kind: "review",
            operationId: "op-r",
            stageVisitId: 1,
          },
          reportDoc: deriveReportPath(planDoc, 1),
          reportHash: "b".repeat(64),
          inputPlanHash: planHash,
          issueIds: ["1"],
        },
      } satisfies DesignReviewState,
    });
    const config = makeTestConfig({ projectRoot });
    const vr = await runVerification(config, meta, []);
    expect(vr.designReviewOutcome?.kind).toBe("invalid");
  });

  it("verify override affects ordinary rules only — domain identity stays strict", async () => {
    writeFailReport();
    const config = makeTestConfig({ projectRoot });
    // override verifyFile to a nonexistent path: ordinary resolution would
    // fail/skip, but the trusted domain outcome MUST still be produced.
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: reviewRunningState(true),
    });
    const vr = await runVerification(config, meta, [], { verifyFile: "/nonexistent/verify.md" });
    expect(vr.designReviewOutcome?.kind).toBe("report");
    if (vr.designReviewOutcome?.kind === "report") {
      expect(vr.designReviewOutcome.verdict).toBe("fail");
    }
  });
});
