/**
 * 192 Phase 1 (F01): operation-cycle tests on a SINGLE session.
 *
 * review_ready → review_running (trusted dispatch) → verified FAIL consumed
 * → update operation of a DIFFERENT kind/id dispatched exactly once with a
 * FRESH visit — while the report's review attribution is preserved in the
 * bounded input receipt. Late results of the consumed review operation can
 * no longer overwrite the current update operation.
 *
 * This phase drives consumption through credible result fixtures (report
 * files + controlled spawn); Phase 5 replaces the fixture layer with the
 * real hook verification chain.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta, DesignReviewState } from "../../types";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
} from "../../core/design-review/state";
import { coordinateDesignReview } from "../../core/design-review/coordinator";
import type { CoordinatorContext } from "../../core/design-review/coordinator";
import { writebackDesignReviewResult, isCurrentOperation } from "../../core/design-review/dispatch";
import { matchCommitExpectation } from "../../core/session-state";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

describe("192 Phase 1: single-session operation cycle (F01 capture)", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-cycle-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".pi", "references"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "190_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
    // Minimal update template so Phase 1 rendering succeeds (YAML source
    // selection is Phase 2 work).
    fs.writeFileSync(
      path.join(projectRoot, ".pi", "references", "design-review-update-prompt.md"),
      "Apply the review report updates to the existing plan.",
      "utf-8",
    );
    config = makeTestConfig({ projectRoot });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" };
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeCtx(
    meta: SessionMeta,
    spawnLog: Array<{ stage: string; prompt?: string }>,
  ): { ctx: CoordinatorContext; session: ReturnType<typeof makeStrictSession> } {
    const session = makeStrictSession(meta);
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async (_cfg, stage, _m, extraArgs) => {
        spawnLog.push({ stage, ...(extraArgs !== undefined ? { prompt: extraArgs } : {}) });
        // Controlled RPC stand-in returning a VERIFIABLE agent id
        return {
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: `agent-${stage}-${spawnLog.length}`,
          dispatchOutcome: "spawned_id" as const,
        };
      },
    };
    return { ctx, session };
  }

  it("FAIL consumption produces a distinct update operation with fresh visit and preserved review receipt", async () => {
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const dr = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({ currentStage: "design-review", designReview: dr });
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const { ctx, session } = makeCtx(meta, spawnLog);

    // ── 1. review_ready → dispatch review (advance trigger)
    const r1 = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r1.status).toBe("handled");
    if (r1.status === "handled" && r1.action === "routed") expect(r1.toStage).toBe("design-review");

    const afterReview = session.getMeta()!.designReview!;
    expect(afterReview.phase).toBe("review_running");
    expect(afterReview.operation?.kind).toBe("review");
    const reviewOpId = afterReview.operation!.operationId;
    // Review inputHash is the authorized plan hash (identity binding)
    expect(afterReview.operation?.inputHash).toBe(planHash);
    // Trusted dispatch receipt recorded with the real agent id
    expect(afterReview.operation?.dispatchState).toBe("dispatched");
    expect(afterReview.operation?.agentId).toBe("agent-design-review-1");
    expect(afterReview.operation?.dispatchEvidence).toBe("trusted_id");
    expect(spawnLog.length).toBe(1);

    // ── 2. Write a FAIL report and settle → consume + dispatch update
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(reportDoc, [
      "# Design Review Report",
      "",
      `**pipeline**: ${meta.pipelineId}`,
      `**plan**: ${planDoc}`,
      "**round**: 1",
      "",
      "## Verdict",
      "",
      "**Design Review: FAIL**",
      "",
      "## Issues",
      "1. Missing error handling",
      "2. Incomplete specification",
      "",
    ].join("\n"), "utf-8");

    const settleMeta = session.getMeta()!;
    const r2 = await coordinateDesignReview(ctx, settleMeta, "settle");
    expect(r2.status).toBe("handled");
    if (r2.status === "handled" && "toStage" in r2) expect(r2.toStage).toBe("plan");
    expect(r2.status === "handled" && r2.action === "routed").toBe(true);

    const afterFail = session.getMeta()!.designReview!;
    // F01 regression guards:
    //  - the NEW operation must be kind "update" (NOT the reused "review")
    //  - and carry a DIFFERENT operationId
    expect(afterFail.phase).toBe("update_running");
    expect(afterFail.operation?.kind).toBe("update");
    const updateOpId = afterFail.operation!.operationId;
    expect(updateOpId).not.toBe(reviewOpId);

    // Fresh visit: the update op is bound to the NEW plan-stage visit, not
    // the stale review stageStartTime.
    const planStageMeta = session.getMeta()!;
    expect(planStageMeta.currentStage).toBe("plan");
    expect(afterFail.operation?.stageVisitId).toBe(planStageMeta.stageStartTime);
    expect(planStageMeta.stageStartTime).not.toBe(settleMeta.stageStartTime);

    // Bounded input receipt keeps the CONSUMED review's attribution
    const receipt = afterFail.reviewInputReceipt!;
    expect(receipt).toBeDefined();
    expect(receipt.reviewIdentity.operationId).toBe(reviewOpId);
    expect(receipt.reviewIdentity.kind).toBe("review");
    expect(receipt.reportDoc).toBe(reportDoc);
    expect(receipt.reportHash).toBeDefined();
    expect(afterFail.outcome!.reportHash).toBe(receipt.reportHash);
    expect(receipt.inputPlanHash).toBe(planHash);
    expect(receipt.issueIds).toEqual(["1", "2"]);
    expect(afterFail.outcome?.verdict).toBe("fail");

    // Update dispatched exactly once (total spawns: review + update = 2)
    expect(spawnLog.length).toBe(2);
    expect(spawnLog[1]!.stage).toBe("plan");
    expect(afterFail.operation?.dispatchState).toBe("dispatched");
    expect(afterFail.operation?.agentId).toBe("agent-plan-2");
    expect(afterFail.operation?.dispatchEvidence).toBe("trusted_id");

    // ── 3. A LATE result of the consumed review operation must not touch
    //        the CURRENT update operation.
    const late = writebackDesignReviewResult(session, reviewOpId, "agent-ghost", "completed");
    expect(late).toBeUndefined();
    const still = session.getMeta()!.designReview!;
    expect(still.operation?.operationId).toBe(updateOpId);
    expect(still.operation?.dispatchState).toBe("dispatched");
    expect(isCurrentOperation(still, reviewOpId, 1)).toBe(false);

    // ── 4. Plan updated + settle → NEW round with a NEW review operation.
    // 192 Phase 2 contract: association fields bound to the CURRENT update
    // operation + one disposition row per consumed issue.
    fs.writeFileSync(planDoc, [
      "# Plan",
      "",
      "## Design Review Update",
      "",
      `**Report**: ${reportDoc}`,
      "**Round**: 1",
      `**Operation**: ${updateOpId}`,
      `**Baseline Hash**: ${planHash}`,
      "",
      "### Issue Dispositions",
      "",
      "| # | Issue | Disposition | Justification |",
      "|---|-------|-------------|---------------|",
      "| 1 | Missing error handling | fixed | added error handling section |",
      "| 2 | Incomplete specification | fixed | expanded specification |",
      "",
      "### Changes Made",
      "",
      "- New section: error handling; expanded spec details.",
      "",
    ].join("\n"), "utf-8");

    const r3 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r3.status === "handled" && r3.action === "routed").toBe(true);

    const round2 = session.getMeta()!.designReview!;
    expect(round2.phase).toBe("review_running");
    expect(round2.round).toBe(2);
    expect(round2.operation?.kind).toBe("review");
    expect(round2.operation?.operationId).not.toBe(updateOpId);
    // inputHash now binds the NEW plan hash, not the old FAIL report's plan
    expect(round2.operation?.inputHash).toBe(computeHash(fs.readFileSync(planDoc, "utf-8")));
    expect(round2.reportDoc).toBe(deriveReportPath(planDoc, 2));
    // Finite receipts: the update-round input receipt is cleared for the new round
    expect(round2.reviewInputReceipt).toBeUndefined();
    // fresh visit binding again
    const drStageMeta = session.getMeta()!;
    expect(drStageMeta.currentStage).toBe("design-review");
    expect(round2.operation?.stageVisitId).toBe(drStageMeta.stageStartTime);
    // exactly one more dispatch (review round 2): 3 total
    expect(spawnLog.length).toBe(3);
  });

  it("PASS keeps pass_ready takeover until receipt+finished and NEVER finishes before the handoff receipt", async () => {
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const dr = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({ currentStage: "design-review", designReview: dr });
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const { ctx, session } = makeCtx(meta, spawnLog);

    // Dispatch review
    await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    const reviewOpId = session.getMeta()!.designReview!.operation!.operationId;

    // PASS report
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(reportDoc, [
      "# Design Review Report",
      "",
      `**pipeline**: ${meta.pipelineId}`,
      `**plan**: ${planDoc}`,
      "**round**: 1",
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
      "",
      "## Issues",
      "None",
      "",
    ].join("\n"), "utf-8");

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "advanced").toBe(true);

    const after = session.getMeta()!;
    // DR192-01 order: approval + develop-handoff operation + finished —
    // handoff is its OWN kind, and finished implies a persisted receipt.
    expect(after.currentStage).toBe("develop");
    const state = after.designReview!;
    expect(state.phase).toBe("finished");
    expect(state.approval?.reviewOperationId).toBe(reviewOpId);
    expect(state.approval?.reportHash).toBeDefined();
    expect(state.operation?.kind).toBe("develop-handoff");
    expect(state.operation?.operationId).not.toBe(reviewOpId);
    expect(state.operation?.dispatchEvidence).toBe("trusted_id");
    expect(state.operation?.agentId).toBe("agent-develop-2");
    expect(spawnLog.length).toBe(2); // review + handoff, no more
  });

  it("blocked update config (empty key) keeps update_ready with spawn=0 — never a fake update_running", async () => {
    // 192 Phase 2 (K05): an explicitly EMPTY update key is a configuration
    // ERROR (not "unconfigured"): dispatch must block with ZERO spawns and
    // the state must stay update_ready WITHOUT a fabricated update_running.
    const refDir = path.join(projectRoot, ".pi", "references");
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, "pipeline-stage-prompt.yml"), "design_review_update_prompt: \"\"\n", "utf-8");
    const { resetPromptConfigCache } = await import("../../core/prompt-config");
    resetPromptConfigCache();
    try {
      const planHashB = computeHash(fs.readFileSync(planDoc, "utf-8"));
      const drB = createInitialState(planDoc, "menu", planHashB, undefined, { pipelineId: "pipe-test-001" });
      const metaB = makeTestMeta({ currentStage: "design-review", designReview: drB });
      const spawnLogB: Array<{ stage: string; prompt?: string }> = [];
      const { ctx, session } = makeCtx(metaB, spawnLogB);

      await coordinateDesignReview(ctx, session.getMeta()!, "advance"); // review dispatch

      const reportDocB = deriveReportPath(planDoc, 1);
      fs.writeFileSync(reportDocB, [
        "# Design Review Report",
        "",
        `**pipeline**: ${metaB.pipelineId}`,
        `**plan**: ${planDoc}`,
        "**round**: 1",
        "",
        "## Verdict",
        "",
        "**Design Review: FAIL**",
        "",
        "## Issues",
        "1. Missing error handling",
        "",
      ].join("\n"), "utf-8");

      const r = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
      expect(r.status === "handled" && r.action === "pending").toBe(true);
      if (r.status === "handled" && r.action === "pending") {
        expect(r.reason).toBe("update_prompt_render_failed");
      }
      const state = session.getMeta()!.designReview!;
      expect(state.phase).toBe("update_ready");
      expect(state.operation).toBeUndefined(); // never a fake update_running
      expect(spawnLogB.length).toBe(1); // ONLY the review — zero update spawn
      // Attribution survived for a later retry after config repair
      expect(state.reviewInputReceipt?.issueIds).toEqual(["1"]);

      // Repair the config -> retry from update_ready dispatches exactly once
      fs.writeFileSync(path.join(refDir, "pipeline-stage-prompt.yml"), "design_review_update_prompt: |\n  REPAIRED TEXT {planDoc}\n", "utf-8");
      resetPromptConfigCache();
      const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
      expect(r2.status === "handled" && r2.action === "routed").toBe(true);
      expect(spawnLogB.length).toBe(2);
      expect(session.getMeta()!.designReview!.operation?.kind).toBe("update");
      expect(session.getMeta()!.designReview!.phase).toBe("update_running");
    } finally {
      resetPromptConfigCache();
    }
  });

  it("handoff: receipt persisted but finished-commit failure → re-entry finishes with ZERO extra RPC", async () => {
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const dr = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({ currentStage: "design-review", designReview: dr });

    let spawnCount = 0;
    // Strict session that fails ONLY the finished terminal commit once
    let failFinishedOnce = true;
    let current: SessionMeta = { ...meta };
    const session = {
      getMeta: () => current,
      updateMeta: (patch: Partial<SessionMeta>) => {
        current = { ...current, ...patch };
        return current;
      },
      updateMetaVerified: (
        patch: Partial<SessionMeta>,
        expected: import("../../core/session-state").MetaCommitExpectation,
      ): import("../../types").ReliableMetaCommitResult => {
        if (patch.designReview?.phase === "finished" && failFinishedOnce) {
          failFinishedOnce = false; // fail this one only
          return { status: "unavailable", reason: "injected_finish_failure" };
        }
        const conflict = matchCommitExpectation(current, expected);
        if (conflict) return { status: "conflict", reason: conflict };
        current = { ...current, ...patch };
        return { status: "persisted", meta: current };
      },
    };
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async () => {
        spawnCount++;
        return {
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: `agent-handoff-${spawnCount}`,
          dispatchOutcome: "spawned_id" as const,
        };
      },
    };

    // review dispatch
    await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    const reviewOpId = session.getMeta()!.designReview!.operation!.operationId;

    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(reportDoc, [
      "# Design Review Report",
      "",
      `**pipeline**: ${meta.pipelineId}`,
      `**plan**: ${planDoc}`,
      "**round**: 1",
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
      "",
      "## Issues",
      "None",
      "",
    ].join("\n"), "utf-8");

    // PASS settle: receipt persists, the FINISHED commit fails → pending
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    if (r.status === "handled" && r.action === "pending") {
      expect(r.reason).toBe("handoff_finish_pending");
    }

    const mid = session.getMeta()!;
    // Takeover state retained: pass_ready + persisted trusted receipt on the handoff
    expect(mid.designReview?.phase).toBe("pass_ready");
    expect(mid.designReview?.operation?.kind).toBe("develop-handoff");
    expect(mid.designReview?.operation?.dispatchEvidence).toBe("trusted_id");
    expect(mid.currentStage).toBe("develop");
    const handoffOpId = mid.designReview!.operation!.operationId;
    const visitsBefore = JSON.stringify(mid.stageVisitOrder);
    const spawnsAfterFirstPass = spawnCount; // review + handoff = 2

    // Re-entry (any trigger): finishes ONLY. ZERO extra RPC.
    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "advanced").toBe(true);
    expect(spawnCount).toBe(spawnsAfterFirstPass); // RPC delta 0
    const after = session.getMeta()!;
    expect(after.designReview?.phase).toBe("finished");
    // no duplicate visit / approval churn / round increment / new op
    expect(JSON.stringify(after.stageVisitOrder)).toBe(visitsBefore);
    expect(after.designReview?.round).toBe(1);
    expect(after.designReview?.approval?.reviewOperationId).toBe(reviewOpId);
    expect(after.designReview?.operation?.operationId).toBe(handoffOpId);
  });
});
