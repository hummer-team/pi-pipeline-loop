/**
 * 193 Phase 2 (Unit Tests Core #2): develop-approval authorization bases.
 *
 * Covers the approval/handoff persistence contract:
 * - a trusted PASS writes an EXPLICIT `report-pass` basis and the handoff
 *   payload stays BYTE-COMPATIBLE with the pre-193 (basis-less) hash;
 * - a human `proceed-develop` override writes a `human-override` basis bound
 *   to the decision id + issue ids + choice time, HASH-BOUND into the handoff
 *   operation inputHash (and the hash is key-order canonical);
 * - the override releases the REAL FAIL: verdict/issues stay persisted and
 *   the bound reportHash is the FAIL report's hash, never a laundered PASS;
 * - an unverified handoff receipt (fallback_no_id) can NEVER reach `finished`:
 *   the state parks paused("unknown-dispatch") with zero further dispatches.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  coordinateDesignReview,
  type CoordinatorContext,
  type CoordinatorResult,
} from "../../core/design-review/coordinator";

/** Union-safe reason read (only the handled/pending variants carry it). */
function reasonOf(r: CoordinatorResult): string {
  return (r as { reason?: string }).reason ?? "";
}
import { clearAllDecisionTimers } from "../../core/flow-state";
import {
  createInitialState,
  computeHash,
  computeHandoffInputHash,
  deriveReportPath,
} from "../../core/design-review/state";
import {
  computeAuthorizationBasisHash,
  buildHumanOverrideBasis,
} from "../../core/design-review/develop-transition";
import { applyHumanDecisionChoice, clearAllHumanDecisionMenus } from "../../core/design-review/human-decision";
import type { DesignReviewApprovalBasis } from "../../core/design-review/decision-types";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

const PIPE = "pipe-test-001";
const OWNER = "/x/owner-session.json";

function report(o: {
  planDoc: string;
  operationId: string;
  inputHash: string;
  verdict: "PASS" | "FAIL";
}): string {
  return [
    "# Design Review Report",
    "",
    `**pipeline**: ${PIPE}`,
    `**plan**: ${o.planDoc}`,
    `**round**: 1`,
    `**operation**: ${o.operationId}`,
    `**input hash**: ${o.inputHash}`,
    "",
    "## Summary",
    "",
    "Reviewed the plan against the requirement document.",
    "",
    "## Recommendations",
    "",
    "Close every listed gap before entering development.",
    "",
    "## Verdict",
    "",
    `**Design Review: ${o.verdict}**`,
    "",
    "## Issues",
    "",
    ...(o.verdict === "PASS" ? ["None"] : ["1. Missing rollback plan for the migration phase"]),
    "",
  ].join("\n");
}

describe("193 Phase 2: develop approval authorization bases", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-human-approval-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "193_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" };
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "manual" },
    };
  });

  afterEach(() => {
    clearAllHumanDecisionMenus();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    clearAllDecisionTimers();
  });

  interface SpawnRec {
    stage: string;
  }

  function makeCtx(
    meta: SessionMeta,
    spawnLog: SpawnRec[],
    opts?: {
      select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
      actor?: { isChild: boolean; sessionFile?: string };
      /** Dispatch outcome override for the DEVELOP handoff spawn. */
      handoffOutcome?: "spawned_id" | "fallback_no_id";
    },
  ): { ctx: CoordinatorContext; session: ReturnType<typeof makeStrictSession> } {
    const session = makeStrictSession(meta);
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: {
        notify: () => {},
        ...(opts?.select !== undefined ? { select: opts.select } : {}),
      },
      pi: { sendUserMessage: () => {} },
      ...(opts?.actor !== undefined ? { actor: opts.actor } : {}),
      spawnOverride: async (_cfg, stage) => {
        spawnLog.push({ stage });
        if (stage === "develop" && opts?.handoffOutcome === "fallback_no_id") {
          return { spawned: true, fallback: true, dispatchOutcome: "fallback_no_id" as const };
        }
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

  function makeMeta(): SessionMeta {
    return makeTestMeta({
      currentStage: "design-review",
      designReview: createInitialState(
        planDoc,
        "menu",
        computeHash(fs.readFileSync(planDoc, "utf-8")),
        OWNER,
        { pipelineId: PIPE },
      ),
    });
  }

  async function dispatchReview(
    ctx: CoordinatorContext,
    session: ReturnType<typeof makeStrictSession>,
  ): Promise<{ reviewOpId: string; planHash: string }> {
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "routed").toBe(true);
    return { reviewOpId: session.getMeta()!.designReview!.operation!.operationId, planHash };
  }

  function writeReport(reviewOpId: string, planHash: string, verdict: "PASS" | "FAIL"): string {
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(reportDoc, report({ planDoc, operationId: reviewOpId, inputHash: planHash, verdict }), "utf-8");
    return reportDoc;
  }

  /** Drive FAIL → menu → choice through the coordinator (manual mode). */
  async function failThenChoose(
    ctx: CoordinatorContext,
    session: ReturnType<typeof makeStrictSession>,
    choice: "Revise Plan" | "Proceed to Develop",
  ): Promise<{ reviewOpId: string; planHash: string; reportDoc: string }> {
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    const reportDoc = writeReport(reviewOpId, planHash, "FAIL");
    ctx.actor = { isChild: false, sessionFile: OWNER };
    ctx.ui!.select = async () => choice;
    return { reviewOpId, planHash, reportDoc };
  }

  it("PASS approval writes an EXPLICIT report-pass basis and the hash stays byte-compatible", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog);
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash, "PASS");

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "advanced").toBe(true);

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("finished");
    // explicit basis on NEW approvals (legacy basis-less approvals stay readable,
    // but are PASS-certifications ONLY — see the override tests)
    expect(after.approval?.basis).toEqual({ kind: "report-pass" });
    // 193 compatibility: the handoff payload is EXACTLY the pre-193 hash —
    // the optional authorizationBasisHash key is OMITTED for PASS.
    const approval = after.approval!;
    const legacyStyleHash = computeHandoffInputHash({
      reviewOperationId: approval.reviewOperationId,
      round: approval.round,
      planHash: approval.planHash,
      reportHash: approval.reportHash,
    });
    expect(after.operation?.inputHash).toBe(legacyStyleHash);
  });

  it("human override binds a human-override basis whose canonical hash is IN the handoff inputHash", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog);
    const { reviewOpId, planHash } = await failThenChoose(ctx, session, "Proceed to Develop");
    void planHash;

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "advanced" && (r2 as { toStage: string }).toStage === "develop").toBe(true);

    const after = session.getMeta()!.designReview!;
    const approval = after.approval!;
    const basis = approval.basis as Extract<DesignReviewApprovalBasis, { kind: "human-override" }>;
    expect(basis.kind).toBe("human-override");
    // bound to the persisted decision + issue ids + choice time
    expect(basis.decisionId).toBe(after.decision!.decisionId);
    expect(basis.issueIds).toEqual(["1"]);
    expect(basis.decidedAt).toBeGreaterThan(0);

    const basisHash = computeAuthorizationBasisHash(basis);
    // key-order canonical: an identically-valued differently-ordered basis hashes the same
    expect(
      computeAuthorizationBasisHash({
        decidedAt: basis.decidedAt,
        issueIds: basis.issueIds,
        kind: "human-override",
        decisionId: basis.decisionId,
      }),
    ).toBe(basisHash);

    // the handoff inputHash binds the FAIL snapshot AND the basis
    const expected = computeHandoffInputHash({
      reviewOperationId: approval.reviewOperationId,
      round: approval.round,
      planHash: approval.planHash,
      reportHash: approval.reportHash,
      authorizationBasisHash: basisHash,
    });
    expect(after.operation?.inputHash).toBe(expected);
    // …and is therefore DISTINCT from the basis-less (PASS-style) payload
    const withoutBasis = computeHandoffInputHash({
      reviewOperationId: approval.reviewOperationId,
      round: approval.round,
      planHash: approval.planHash,
      reportHash: approval.reportHash,
    });
    expect(after.operation?.inputHash).not.toBe(withoutBasis);
  });

  it("the override releases the REAL FAIL: verdict, issues and FAIL report hash stay persisted", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog);
    const { reviewOpId, planHash, reportDoc } = await failThenChoose(ctx, session, "Proceed to Develop");
    void reviewOpId;

    await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    const after = session.getMeta()!.designReview!;

    // nothing launders the FAIL into a PASS
    expect(after.outcome?.verdict).toBe("fail");
    expect(after.approval?.reportHash).toBe(after.decision?.reportHash);
    expect(after.approval?.planHash).toBe(planHash);
    expect(after.decision?.reportDoc).toBe(reportDoc);
    if (after.decision?.state === "chosen") {
      expect(after.decision.issues.length).toBe(1);
      expect(after.decision.issues[0]!.text).toContain("Missing rollback plan");
    }
    expect(after.phase).toBe("finished");
    expect(session.getMeta()!.currentStage).toBe("develop");
  });

  it("buildHumanOverrideBasis refuses anything but a chosen proceed-develop record", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog);
    await failThenChoose(ctx, session, "Revise Plan");
    await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    const dr = session.getMeta()!.designReview!;
    // revise-plan choice can NEVER build an override basis
    expect(() => buildHumanOverrideBasis(dr.decision!)).toThrow(/proceed-develop/);
    // pending (no choice) likewise
    const pending = { ...dr.decision!, state: "pending" } as unknown as Parameters<typeof buildHumanOverrideBasis>[0];
    expect(() => buildHumanOverrideBasis(pending)).toThrow(/proceed-develop/);
  });

  it("an unverified handoff receipt can NEVER reach finished — parks paused(unknown-dispatch) with zero re-dispatch", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, { handoffOutcome: "fallback_no_id" });
    await failThenChoose(ctx, session, "Proceed to Develop");

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending").toBe(true);
    expect(reasonOf(r2)).toBe("handoff_dispatch_unverified");

    const after = session.getMeta()!.designReview!;
    // receipt NOT reliably persisted → the terminal commit is refused
    expect(after.phase).not.toBe("finished");
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("unknown-dispatch");
    // the override milestones that DID persist stay intact
    expect(session.getMeta()!.currentStage).toBe("develop");
    expect(after.decision?.state).toBe("chosen");
    expect(after.approval?.basis?.kind).toBe("human-override");
    // exactly one handoff dispatch attempt — unknown evidence is never re-sent
    expect(spawnLog.map((s) => s.stage)).toEqual(["design-review", "develop"]);

    // a further ordinary settle does NOT re-dispatch and does NOT finish
    const r3 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r3.status === "handled" && r3.action === "pending").toBe(true);
    expect(session.getMeta()!.designReview!.phase).not.toBe("finished");
    expect(spawnLog.length).toBe(2);
  });

  it("a chosen decision persisted by ANOTHER writer releases develop exactly once with the override basis", async () => {
    // Entry stays pending (no actor), then a resume-like writer commits the
    // choice through the strict path; recovery must honor THAT record.
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog);
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash, "FAIL");
    const r1 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(reasonOf(r1)).toBe("decision_pending");

    const dr = session.getMeta()!.designReview!;
    const chosen = applyHumanDecisionChoice(dr.decision!, "proceed-develop", Date.now());
    const commit = session.updateMetaVerified!(
      { designReview: { ...dr, decision: chosen } },
      {
        pipelineId: PIPE,
        authorizationId: dr.authorizationId,
        round: dr.round,
        operationId: dr.operation!.operationId,
        phase: "paused",
        stateUpdatedAt: dr.updatedAt,
        decisionId: dr.decision!.decisionId,
        decisionState: "pending",
      },
    );
    expect(commit.status).toBe("persisted");

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "advanced").toBe(true);
    const after = session.getMeta()!.designReview!;
    expect(after.approval?.basis?.kind).toBe("human-override");
    expect(after.outcome?.verdict).toBe("fail");
    expect(spawnLog.map((s) => s.stage)).toEqual(["design-review", "develop"]);
  });
});
