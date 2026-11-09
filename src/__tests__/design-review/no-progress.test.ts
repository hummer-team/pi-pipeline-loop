/**
 * 229 Phase 4 (F4): the design-review loop's no-progress accounting driven
 * through the REAL coordinator.
 *
 * Boundaries (plan Phase 4 "单元测试目标，边界"):
 * - round 1: a no-shrink FAIL record is persisted (`progressLedger.streak 1`)
 *   and the consumption still routes — the grace protects the FIRST flat round;
 * - round 2 with the same open set ⇒ the coordinator returns
 *   `{ action: "frozen", reason: "no_progress_detected" }` and NO update is
 *   dispatched;
 * - a ledger carrying a FOREIGN loop identity reads as progress (问题 20).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { SessionMeta } from "../../types";
import {
  coordinateDesignReview,
  type CoordinatorContext,
} from "../../core/design-review/coordinator";
import { createInitialState, computeHash } from "../../core/design-review/state";
import {
  makeTestConfig,
  makeTestMeta,
  reviewReportContent,
  boundReviewOperation,
} from "../helpers";
import { matchCommitExpectation } from "../../core/session-state";

const REVIEW_OP_ID = "op-review-noprogress-1";
const REVIEW_OP2_ID = "op-review-noprogress-2";

let tempDir: string;
let designDir: string;
let planDoc: string;
let planHash: string;
let config: ReturnType<typeof makeTestConfig>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(tmpdir(), "dr-noprogress-"));
  designDir = path.join(tempDir, "docs", "design");
  fs.mkdirSync(designDir, { recursive: true });
  planDoc = path.join(designDir, "229noProg_Feat_Plan.md");
  fs.writeFileSync(planDoc, "# Plan\n\noriginal\n", "utf-8");
  planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
  config = makeTestConfig({ projectRoot: tempDir });
  config.stages = {
    ...config.stages,
    plan: { ...config.stages.plan, agentPath: "agents/x.md" },
  };
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
      if (expected.operationId !== null && currentMeta.designReview?.operation?.operationId !== expected.operationId) {
        return { status: "conflict", reason: "stale_operation_binding" };
      }
      currentMeta = { ...currentMeta, ...patch };
      return { status: "persisted", meta: currentMeta };
    },
  };
}

function createCoordinatorCtx(meta: SessionMeta): CoordinatorContext {
  return {
    config,
    session: createMockSession(meta),
    ui: { notify: () => {} },
    pi: { sendUserMessage: () => {} },
    spawnOverride: async () => ({
      spawned: true,
      fallback: false,
      deferred: false,
      agentId: "agent-noprogress-1",
      dispatchOutcome: "spawned_id" as const,
    }),
  };
}

function reviewRunningMeta(round: number, opId: string, extra?: Partial<SessionMeta>): SessionMeta {
  const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
  return makeTestMeta({
    currentStage: "design-review",
    designReview: {
      ...drState,
      phase: "review_running",
      round,
      operation: boundReviewOperation(opId, planHash),
    },
    ...extra,
  });
}

function writeReport(round: number, opId: string, issueIds: string[], inputHash: string = planHash): string {
  const reportDoc = path.join(designDir, `Design_Review_${round}_229noProg_Feat_Design.md`);  // 229 F2: EVERY FAIL round carries its own ledger, so subsequent rounds
  // restate STABLE ids (no legacy synthesis inside this chain). Per the
  // same-problem-same-id rule the Issues rows reuse the SAME stable ids too,
  // so a repeated round is a verbatim open-set repetition for the rule.
  const ledgerRows = issueIds.map((id) => ({ id, status: "open" }));
  const report = reviewReportContent({
    pipelineId: "pipe-test-001",
    planDoc,
    round,
    operationId: opId,
    inputHash,
    verdict: "FAIL",
    issues: ["fee caliber defect", "missing AC coverage"],
    issueIds,
    restateLedger: ledgerRows,
  });
  fs.writeFileSync(reportDoc, report, "utf-8");
  return reportDoc;
}

describe("229 Phase 4: design-review loop no-progress (coordinator)", () => {
  it("round-2 identical set consumes the grace; round-3 same set freezes with no_progress_detected", async () => {
    // ── Round 1: FAIL with 2 blocking issues consumed (grace round).
    writeReport(1, REVIEW_OP_ID, ["DR-1-1", "DR-1-2"]);
    let ctx = createCoordinatorCtx(reviewRunningMeta(1, REVIEW_OP_ID));
    const r1 = await coordinateDesignReview(ctx, ctx.session.getMeta()!, "settle");
    if (!(r1.status === "handled" && r1.action === "routed")) {
      const dbg = ctx.session.getMeta()!;
      throw new Error(`DEBUG ${JSON.stringify({
        r1,
        phase: dbg.designReview?.phase,
        failures: dbg.verifyFailures?.slice(-3),
      })}`);
    }
    let dr = ctx.session.getMeta()!.designReview!;
    expect(dr.phase).toBe("update_running");

    // ── Round 2: the SAME open set (no shrink) — the debt freezes the loop.
    fs.writeFileSync(planDoc, "# Plan\n\nrevised content\n", "utf-8");
    const revisedHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const dr2Meta = reviewRunningMeta(2, REVIEW_OP2_ID, {
      designReview: {
        ...dr,
        phase: "review_running",
        round: 2,
        // the round transition binds the FRESH report path (per-round report)
        reportDoc: undefined,
        planHash: computeHash(fs.readFileSync(planDoc, "utf-8")),
        operation: boundReviewOperation(REVIEW_OP2_ID, revisedHash),
        // the round-1 ledger carried forward (evaluateNoProgress streak 1)
        progressLedger: dr.progressLedger,
      },
    });
    writeReport(2, REVIEW_OP2_ID, ["DR-1-1", "DR-1-2"], revisedHash);
    ctx = createCoordinatorCtx(dr2Meta);
    const r2 = await coordinateDesignReview(ctx, ctx.session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "routed").toBe(true);
    // The one-shot observation grace covers the FIRST identical flat round.
    const after2 = ctx.session.getMeta()!.designReview!;
    expect(after2.progressLedger?.streak).toBe(1);

    // ── Round 3: the SAME identical set again — the grace is consumed.
    fs.writeFileSync(planDoc, "# Plan\n\nrevised again\n", "utf-8");
    const revised2 = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const REVIEW_OP3 = "op-review-noprogress-3";
    const dr3Meta = reviewRunningMeta(3, REVIEW_OP3, {
      designReview: {
        ...after2,
        phase: "review_running",
        round: 3,
        reportDoc: undefined,
        planHash: revised2,
        operation: boundReviewOperation(REVIEW_OP3, revised2),
        progressLedger: after2.progressLedger,
      },
    });
    writeReport(3, REVIEW_OP3, ["DR-1-1", "DR-1-2"], revised2);
    ctx = createCoordinatorCtx(dr3Meta);
    const r3 = await coordinateDesignReview(ctx, ctx.session.getMeta()!, "settle");
    if (!(r3.status === "handled" && r3.action === "frozen")) {
      const dbg = ctx.session.getMeta()!;
      throw new Error(`DEBUG ${JSON.stringify({
        r3,
        phase: dbg.designReview?.phase,
        ledger: dbg.designReview?.progressLedger,
        failures: dbg.verifyFailures?.slice(-3),
      })}`);
    }
    if (r3.status === "handled" && r3.action === "frozen") {
      expect(r3.reason).toBe("no_progress_detected");
    }
    const after = ctx.session.getMeta()!;
    expect(after.designReview?.progressLedger?.streak).toBe(2);
    // NO update dispatch happened — the flow is frozen at the review round.
    expect(after.currentStage).toBe("design-review");
  });

  it("a FOREIGN loop ledger reads as progress (streak resets, 问题 20)", async () => {
    writeReport(1, REVIEW_OP_ID, ["DR-1-1"]);
    const meta = reviewRunningMeta(1, REVIEW_OP_ID, {
      designReview: {
        ...createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" }),
        phase: "review_running",
        round: 1,
        operation: boundReviewOperation(REVIEW_OP_ID, planHash),
        // a review/fix loop ledger must not pollute the design-review streak
        progressLedger: {
          loop: "reviewFix",
          round: 1,
          openIds: ["CR-9-1", "CR-9-2", "CR-9-3"],
          severityCounts: { Blocker: 3 },
          streak: 5,
        },
      } as never,
    });
    const ctx = createCoordinatorCtx(meta);
    const r = await coordinateDesignReview(ctx, ctx.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "routed").toBe(true);
    const after = ctx.session.getMeta()!.designReview!;
    expect(after.progressLedger?.loop).toBe("designReview");
    expect(after.progressLedger?.streak).toBe(0);
  });

  it("the persisted ledger carries severityById so the loop-exit release can bind the carry-over", async () => {
    // Regression: the loop-exit degraded release projects `severityById` into
    // the carry-over record and fails closed when a severity is missing. The
    // coordinator must therefore PERSIST that map — a ledger with only
    // `severityCounts` makes every design-review advance refuse.
    writeReport(1, REVIEW_OP_ID, ["DR-1-1", "DR-1-2"]);
    const ctx = createCoordinatorCtx(reviewRunningMeta(1, REVIEW_OP_ID));
    const r = await coordinateDesignReview(ctx, ctx.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "routed").toBe(true);

    const ledger = ctx.session.getMeta()!.designReview!.progressLedger!;
    expect(ledger.openIds).toEqual(["DR-1-1", "DR-1-2"]);
    // Every open id carries its resolved severity (the release never fabricates).
    expect(Object.keys(ledger.severityById ?? {}).sort()).toEqual(["DR-1-1", "DR-1-2"]);
  });
});