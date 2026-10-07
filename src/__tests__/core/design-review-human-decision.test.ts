/**
 * 193 Phase 2 (Unit Tests Core #2): the human plan-revision decision menu.
 *
 * Covers the locked menu semantics end to end:
 * - the three English choices (Revise Plan / Proceed to Develop / Cancel) and
 *   their exact persistence consequences (one strict commit per transition);
 * - the pending record binds the REAL FAIL snapshot (identity + hashes +
 *   issues) — creation happens BEFORE any menu, with zero visits/RPC;
 * - interaction eligibility: verified non-child owner only; child, unknown
 *   role, impostor session file or a missing select NEVER show the menu;
 * - Cancel / Esc / exception / commit failure keep the decision `pending`
 *   with no automatic re-popup;
 * - single-flight per decision id (UI overlap guard, not a transaction);
 * - after-menu drift (report hash, verdict flip to PASS, plan change) parks
 *   paused("drift") and CLEARS the stale decision — a fresh PASS is never
 *   treated as the old approval;
 * - a concurrently persisted choice wins; the late selection conflicts with
 *   zero action;
 * - chosen recovery acts WITHOUT re-showing the menu and adds exactly ONE
 *   develop visit;
 * - a new round clears the stale decision.
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
  deriveReportPath,
} from "../../core/design-review/state";
import {
  applyHumanDecisionChoice,
  beginHumanDecisionMenu,
  buildHumanDecisionSummary,
  buildPendingHumanDecision,
  clearAllHumanDecisionMenus,
  endHumanDecisionMenu,
  isHumanDecisionMenuInFlight,
  mapHumanDecisionSelection,
  presentHumanDecisionMenu,
  resolveDesignReviewActorEvidence,
  HUMAN_DECISION_OPTIONS,
  HUMAN_DECISION_TITLE,
  HUMAN_DECISION_MAX_ISSUES,
} from "../../core/design-review/human-decision";
import type { HumanDecision } from "../../core/design-review/decision-types";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

const PIPE = "pipe-test-001";
const OWNER = "/x/owner-session.json";

// ─── contract-valid report fixture (manual mode: NO decision section) ────────

function report(o: {
  planDoc: string;
  operationId: string;
  inputHash: string;
  verdict: "PASS" | "FAIL";
  issues?: string[];
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
    "Reviewed the plan against the requirement document; gaps are listed below.",
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
    ...(o.verdict === "PASS" ? ["None"] : (o.issues ?? ["1. Missing rollback plan for the migration phase"])),
    "",
  ].join("\n");
}

describe("193 Phase 2: human decision menu flow (coordinator)", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-human-decision-"));
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
    prompt?: string;
  }
  interface MenuCall {
    title: string;
    options: readonly string[];
  }

  function makeCtx(
    meta: SessionMeta,
    spawnLog: SpawnRec[],
    opts?: {
      select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
      actor?: { isChild: boolean; sessionFile?: string };
    },
  ): { ctx: CoordinatorContext; session: ReturnType<typeof makeStrictSession>; notifications: string[] } {
    const session = makeStrictSession(meta);
    const notifications: string[] = [];
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: {
        notify: (m) => notifications.push(m),
        ...(opts?.select !== undefined ? { select: opts.select } : {}),
      },
      pi: { sendUserMessage: () => {} },
      ...(opts?.actor !== undefined ? { actor: opts.actor } : {}),
      spawnOverride: async (_cfg, stage, _m, extraArgs) => {
        spawnLog.push({ stage, ...(extraArgs !== undefined ? { prompt: extraArgs } : {}) });
        return {
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: `agent-${stage}-${spawnLog.length}`,
          dispatchOutcome: "spawned_id" as const,
        };
      },
    };
    return { ctx, session, notifications };
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
    const st = session.getMeta()!.designReview!;
    expect(st.phase).toBe("review_running");
    return { reviewOpId: st.operation!.operationId, planHash };
  }

  function writeReport(reviewOpId: string, planHash: string, o?: { verdict?: "PASS" | "FAIL"; issues?: string[] }): string {
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(
      reportDoc,
      report({ planDoc, operationId: reviewOpId, inputHash: planHash, verdict: o?.verdict ?? "FAIL", ...(o?.issues !== undefined ? { issues: o.issues } : {}) }),
      "utf-8",
    );
    return reportDoc;
  }

  // ── the three choices ──────────────────────────────────────────────────────

  it("Revise Plan persists the choice and routes the authorized plan revision (real FAIL kept)", async () => {
    const spawnLog: SpawnRec[] = [];
    const menuCalls: MenuCall[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        menuCalls.push({ title, options });
        return "Revise Plan";
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "routed" && (r2 as { toStage: string }).toStage === "plan").toBe(true);

    // exact English protocol strings
    expect(menuCalls.length).toBe(1);
    expect(menuCalls[0]!.title).toBe(HUMAN_DECISION_TITLE);
    expect([...menuCalls[0]!.options]).toEqual(["Revise Plan", "Proceed to Develop", "Cancel"]);

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("update_running");
    expect(after.operation?.kind).toBe("update");
    // the REAL FAIL outcome stays persisted — routing a revision never launders it
    expect(after.outcome?.verdict).toBe("fail");
    // the choice is persisted with human provenance bound to the FAIL snapshot
    expect(after.decision?.state).toBe("chosen");
    if (after.decision?.state === "chosen") {
      expect(after.decision.choice).toBe("revise-plan");
      expect(after.decision.source).toBe("human");
      expect(after.decision.decidedAt).toBeGreaterThan(0);
    }
    expect(after.decision?.mode).toBe("manual");
    // exactly one extra dispatch (the authorized update) — no develop, no second menu
    expect(spawnLog.map((s) => s.stage)).toEqual(["design-review", "plan"]);
  });

  it("Proceed to Develop releases the REAL FAIL via a hash-bound human override", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session, notifications } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => "Proceed to Develop",
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "advanced" && (r2 as { toStage: string }).toStage === "develop").toBe(true);

    // the menu was preceded by the English issue summary notification
    expect(notifications.some((n) => n.includes("Open issues"))).toBe(true);

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("finished");
    expect(session.getMeta()!.currentStage).toBe("develop");
    // verdict stays a genuine FAIL — the override RELEASES it, it never fakes a PASS
    expect(after.outcome?.verdict).toBe("fail");
    expect(after.decision?.state).toBe("chosen");
    if (after.decision?.state === "chosen") expect(after.decision.choice).toBe("proceed-develop");
    // approval carries the human-override basis bound to the decision
    expect(after.approval?.basis?.kind).toBe("human-override");
    if (after.approval?.basis?.kind === "human-override") {
      expect(after.approval.basis.decisionId).toBe(after.decision!.decisionId);
      expect(after.approval.basis.issueIds.length).toBeGreaterThan(0);
    }
    expect(spawnLog.map((s) => s.stage)).toEqual(["design-review", "develop"]);
  });

  it("Cancel keeps the decision pending with zero visits, dispatches and stage change", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => "Cancel",
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const before = session.getMeta()!;
    const r2 = await coordinateDesignReview(ctx, before, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && r2.reason === "decision_pending").toBe(true);

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("decision-pending");
    expect(after.decision?.state).toBe("pending");
    expect(after.operation?.kind).toBe("review");
    expect(session.getMeta()!.currentStage).toBe("design-review");
    // no budget burn: loop counters untouched, review is still the current op
    expect(session.getMeta()!.loopCycleCount).toBe(before.loopCycleCount);
    expect(spawnLog.length).toBe(1);
  });

  // ── fail-closed menu outcomes ──────────────────────────────────────────────

  it("a throwing select keeps the decision pending (never a guessed choice)", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => {
        throw new Error("ui channel closed");
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && r2.reason === "decision_pending").toBe(true);
    expect(session.getMeta()!.designReview!.decision?.state).toBe("pending");
    expect(spawnLog.length).toBe(1);
  });

  it("Esc (undefined selection) keeps the decision pending", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => undefined,
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && r2.reason === "decision_pending").toBe(true);
    expect(session.getMeta()!.designReview!.decision?.state).toBe("pending");
  });

  it("choice-commit failure stays pending and the NEXT settle never re-pops the menu", async () => {
    const spawnLog: SpawnRec[] = [];
    const menuCalls: MenuCall[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        menuCalls.push({ title, options });
        return "Revise Plan";
      },
    });
    // Inject exactly ONE failure on the choice commit (decisionId + pending
    // anchor + chosen patch) — everything else goes through honestly.
    const orig = session.updateMetaVerified!;
    let injected = false;
    session.updateMetaVerified = (patch, expected) => {
      if (
        !injected &&
        expected.decisionId !== undefined &&
        expected.decisionState === "pending" &&
        patch.designReview?.decision?.state === "chosen"
      ) {
        injected = true;
        return { status: "unavailable", reason: "injected" };
      }
      return orig(patch, expected);
    };
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending").toBe(true);
    expect(reasonOf(r2).startsWith("decision_choice_commit_failed:unavailable:injected")).toBe(true);
    expect(injected).toBe(true);

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("decision-pending");
    expect(after.decision?.state).toBe("pending"); // the choice never landed
    expect(spawnLog.length).toBe(1);

    // ordinary settle: waiting notice ONLY — NO automatic re-popup, no action
    const r3 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r3.status === "handled" && r3.action === "pending" && r3.reason === "decision_pending").toBe(true);
    expect(menuCalls.length).toBe(1);
    expect(spawnLog.length).toBe(1);
  });

  // ── eligibility (owner evidence) ───────────────────────────────────────────

  it("an unknown actor (absent evidence) never sees the menu — decision stays pending", async () => {
    const spawnLog: SpawnRec[] = [];
    let menuShown = 0;
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      select: async () => {
        menuShown++;
        return "Proceed to Develop"; // an evil selection must never be reachable
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && r2.reason === "decision_pending").toBe(true);
    expect(menuShown).toBe(0);
    expect(session.getMeta()!.designReview!.decision?.state).toBe("pending");
    expect(spawnLog.length).toBe(1);
  });

  it("a child session never sees the menu even with a matching file", async () => {
    const spawnLog: SpawnRec[] = [];
    let menuShown = 0;
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: true, sessionFile: OWNER },
      select: async () => {
        menuShown++;
        return "Proceed to Develop";
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && r2.reason === "decision_pending").toBe(true);
    expect(menuShown).toBe(0);
    expect(spawnLog.length).toBe(1);
  });

  it("an impostor session file (mismatch with the recorded owner) is not the owner", async () => {
    const spawnLog: SpawnRec[] = [];
    let menuShown = 0;
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: "/x/impostor.json" },
      select: async () => {
        menuShown++;
        return "Proceed to Develop";
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && r2.reason === "decision_pending").toBe(true);
    expect(menuShown).toBe(0);
    // the state's recorded owner is untouched by the impostor settle
    expect(session.getMeta()!.designReview?.ownerSessionFile).toBe(OWNER);
  });

  it("owner WITHOUT a select control stays pending, and a later settle adds no menu/budget/dispatch", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      // no select at all
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending" && r.reason === "decision_pending").toBe(true);
    const rev1 = session.getMeta()!.designReview!;
    expect(rev1.phase).toBe("paused");
    expect(rev1.pauseReason).toBe("decision-pending");

    // repeated settles (e.g. idle agent hooks) never create a second commit,
    // never re-verify, never dispatch
    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    const r3 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(reasonOf(r2) === "decision_pending" && reasonOf(r3) === "decision_pending").toBe(true);
    expect(session.getMeta()!.designReview!.decision?.state).toBe("pending");
    expect(spawnLog.length).toBe(1);
  });

  // ── concurrency + drift ────────────────────────────────────────────────────

  it("a concurrently persisted choice wins — the late menu selection conflicts with ZERO action", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => "Proceed to Develop",
    });
    // While the menu is open, ANOTHER writer persists "Revise Plan" first.
    ctx.ui!.select = async () => {
      const cur = session.getMeta()!;
      const dr = cur.designReview!;
      const chosen = applyHumanDecisionChoice(dr.decision!, "revise-plan", Date.now());
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
      return "Proceed to Develop"; // our (now late) selection
    };
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && r2.reason === "decision_pending").toBe(true);

    const after = session.getMeta()!.designReview!;
    // the OTHER writer's choice stands — ours was refused after the menu check
    expect(after.decision?.state).toBe("chosen");
    if (after.decision?.state === "chosen") expect(after.decision.choice).toBe("revise-plan");
    expect(after.approval).toBeUndefined();
    // zero action from the late selection: no develop dispatch, no stage move
    expect(spawnLog.length).toBe(1);
    expect(session.getMeta()!.currentStage).toBe("design-review");
  });

  it("report hash drift during the menu parks paused(drift), clears the decision, ZERO action", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => {
        const reportDoc = deriveReportPath(planDoc, 1);
        const content = fs.readFileSync(reportDoc, "utf-8");
        fs.writeFileSync(
          reportDoc,
          content.replace(
            "1. Missing rollback plan for the migration phase",
            "1. Missing rollback plan for the migration phase\n2. Additional late-discovered gap",
          ),
          "utf-8",
        );
        return "Revise Plan";
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending").toBe(true);
    expect(reasonOf(r2)).toBe("decision_drift:report_hash_drift");

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("drift");
    expect(after.decision).toBeUndefined(); // stale choice cleared — new round required
    expect(spawnLog.length).toBe(1);
  });

  it("a fresh PASS replacing the FAIL report is NEVER treated as the old approval", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => "Proceed to Develop",
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);
    // During the menu, the reviewer re-runs the report and it now says PASS.
    ctx.ui!.select = async () => {
      writeReport(reviewOpId, planHash, { verdict: "PASS" });
      return "Proceed to Develop";
    };

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending").toBe(true);
    expect(reasonOf(r2)).toBe("decision_drift:verdict_not_fail");

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("drift");
    expect(after.decision).toBeUndefined();
    expect(after.approval).toBeUndefined(); // a new PASS does NOT auto-approve develop
    expect(session.getMeta()!.currentStage).toBe("design-review");
    expect(spawnLog.length).toBe(1);
  });

  it("plan content drift during the menu parks paused(drift) with plan_drift", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => {
        fs.appendFileSync(planDoc, "\nUnreviewed sneaky content.\n", "utf-8");
        return "Proceed to Develop";
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending").toBe(true);
    expect(reasonOf(r2)).toBe("decision_drift:plan_drift");
    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("drift");
    expect(after.decision).toBeUndefined();
    expect(spawnLog.length).toBe(1);
  });

  // ── chosen recovery ────────────────────────────────────────────────────────

  it("a persisted chosen decision is ACTED on recovery — no re-popup, exactly ONE develop visit", async () => {
    const spawnLog: SpawnRec[] = [];
    let menuShown = 0;
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      // no actor on the first settle: pending is created, menu skipped
      select: async () => {
        menuShown++;
        return "Cancel";
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeReport(reviewOpId, planHash);
    const r1 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r1.status === "handled" && r1.action === "pending" && r1.reason === "decision_pending").toBe(true);

    // The human choice arrives through a separate strict commit (e.g. a
    // resume path persists it); then the crash-like settle RECOVERS it.
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
    const visitsBefore = (session.getMeta().stageVisitOrder ?? []).filter((s) => s === "develop").length;

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "advanced" && (r2 as { toStage: string }).toStage === "develop").toBe(true);

    // recovery NEVER re-shows the menu
    expect(menuShown).toBe(0);
    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("finished");
    expect(after.approval?.basis?.kind).toBe("human-override");
    // exactly ONE fresh develop visit was added by the recovery action
    const visitsAfter = (session.getMeta().stageVisitOrder ?? []).filter((s) => s === "develop").length;
    expect(visitsAfter - visitsBefore).toBe(1);
    expect(spawnLog.map((s) => s.stage)).toEqual(["design-review", "develop"]);
  });

  // ── new round clearing ─────────────────────────────────────────────────────

  it("the next review round clears the stale chosen decision", async () => {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => "Revise Plan",
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    const reportDoc = writeReport(reviewOpId, planHash);

    // chosen → routed to the authorized update
    await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    const updateDr = session.getMeta()!.designReview!;
    expect(updateDr.phase).toBe("update_running");
    const updateOpId = updateDr.operation!.operationId;

    // plan agent completes the revision (192 Phase 2 update contract)
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
      "| 1 | Missing rollback plan for the migration phase | fixed | added rollback coverage |",
      "",
      "### Changes Made",
      "",
      "- New section: rollback coverage.",
      "",
    ].join("\n"), "utf-8");

    const r3 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r3.status === "handled" && r3.action === "routed").toBe(true);

    const round2 = session.getMeta()!.designReview!;
    expect(round2.round).toBe(2);
    expect(round2.phase).toBe("review_running");
    // the stale human decision from round 1 is GONE — a new FAIL needs a new record
    expect(round2.decision).toBeUndefined();
    expect(spawnLog.length).toBe(3);
  });

  // ── pending-creation integrity ─────────────────────────────────────────────

  it("pending creation binds identity + real FAIL verdict in ONE commit BEFORE any menu", async () => {
    const spawnLog: SpawnRec[] = [];
    const seenDecisionStates: string[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog, {
      actor: { isChild: false, sessionFile: OWNER },
      select: async () => {
        // At menu time the PERSISTED record must already be the pending one
        const dr = session.getMeta()!.designReview!;
        seenDecisionStates.push(String(dr.decision?.state));
        seenDecisionStates.push(String(dr.phase));
        seenDecisionStates.push(String(dr.pauseReason));
        seenDecisionStates.push(String(dr.outcome?.verdict));
        return "Cancel";
      },
    });
    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    const reportDoc = writeReport(reviewOpId, planHash);

    await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(seenDecisionStates).toEqual(["pending", "paused", "decision-pending", "fail"]);

    const dr = session.getMeta()!.designReview!;
    expect(dr.decision?.reviewIdentity.operationId).toBe(dr.operation?.operationId);
    expect(dr.decision?.reviewIdentity.authorizationId).toBe(dr.authorizationId);
    expect(dr.decision?.reviewIdentity.pipelineId).toBe(PIPE);
    expect(dr.decision?.reportDoc).toBe(reportDoc);
    expect(dr.decision?.planHash).toBe(planHash);
    expect(dr.decision?.reportHash.length).toBeGreaterThan(0);
    expect(dr.decision?.issues.length).toBe(1);
  });
});

// ─── pure module units ───────────────────────────────────────────────────────

describe("193 Phase 2: human-decision module units", () => {
  afterAll(() => {
    clearAllHumanDecisionMenus();
    clearAllDecisionTimers();
  });

  it("mapHumanDecisionSelection maps ONLY the two affirmative labels", () => {
    expect(mapHumanDecisionSelection("Revise Plan")).toBe("revise-plan");
    expect(mapHumanDecisionSelection("Proceed to Develop")).toBe("proceed-develop");
    expect(mapHumanDecisionSelection("Cancel")).toBeUndefined();
    expect(mapHumanDecisionSelection("")).toBeUndefined();
    expect(mapHumanDecisionSelection("Approve Everything")).toBeUndefined();
    expect(mapHumanDecisionSelection(undefined)).toBeUndefined();
    expect(mapHumanDecisionSelection(null)).toBeUndefined();
  });

  it("exposes the exact English menu protocol", () => {
    expect(HUMAN_DECISION_TITLE).toBe("Design Review Decision");
    expect([...HUMAN_DECISION_OPTIONS]).toEqual(["Revise Plan", "Proceed to Develop", "Cancel"]);
  });

  const pendingInput = (count: number) => ({
    reviewIdentity: {
      pipelineId: "pipe-x",
      planDoc: "/x/plan.md",
      authorizationId: "auth-x",
      round: 1,
      operationId: "op-x",
      stageVisitId: 1,
    },
    reportDoc: "/x/round1_report.md",
    reportHash: "h".repeat(64),
    planHash: "p".repeat(64),
    issues: Array.from({ length: count }, (_, i) => ({ issueId: String(i + 1), text: `Issue ${i + 1}` })),
    mode: "manual" as const,
    ownerSessionFile: "/x/owner.json",
  });

  it("buildPendingHumanDecision binds the snapshot, caps issues, ids uniquely", () => {
    const a = buildPendingHumanDecision(pendingInput(3));
    const b = buildPendingHumanDecision(pendingInput(3));
    expect(a.state).toBe("pending");
    expect(a.decisionId).not.toBe(b.decisionId);
    expect(a.issues.length).toBe(3);
    expect(a.ownerSessionFile).toBe("/x/owner.json");
    const big = buildPendingHumanDecision(pendingInput(HUMAN_DECISION_MAX_ISSUES + 20));
    expect(big.issues.length).toBe(HUMAN_DECISION_MAX_ISSUES);
    const noOwner = buildPendingHumanDecision({ ...pendingInput(1), ownerSessionFile: undefined });
    expect("ownerSessionFile" in noOwner).toBe(false);
  });

  it("applyHumanDecisionChoice keeps bindings and refuses a second choice", () => {
    const p = buildPendingHumanDecision(pendingInput(2));
    const c = applyHumanDecisionChoice(p, "proceed-develop", 1234);
    if (c.state !== "chosen") throw new Error("expected chosen");
    expect(c.decisionId).toBe(p.decisionId);
    expect(c.reviewIdentity).toEqual(p.reviewIdentity);
    expect(c.reportHash).toBe(p.reportHash);
    expect(c.issues).toEqual(p.issues);
    expect(c.mode).toBe("manual");
    expect(c.source).toBe("human");
    expect(c.decidedAt).toBe(1234);
    expect(() => applyHumanDecisionChoice(c, "revise-plan", 5678)).toThrow(/pending/);
  });

  it("buildHumanDecisionSummary lists every issue id, the report and the choices (English)", () => {
    const p = buildPendingHumanDecision(pendingInput(2));
    const s = buildHumanDecisionSummary(p);
    expect(s).toContain("/x/round1_report.md");
    expect(s).toContain("[1] Issue 1");
    expect(s).toContain("[2] Issue 2");
    expect(s).toContain("revise the plan");
    expect(s).toContain("proceed to develop");
    expect(s).toContain("cancel");
  });

  it("resolveDesignReviewActorEvidence is fail-closed for every non-owner case", () => {
    expect(resolveDesignReviewActorEvidence(undefined, "/x/owner.json").role).toBe("unknown");
    expect(resolveDesignReviewActorEvidence({ isChild: true, sessionFile: "/x/owner.json" }, "/x/owner.json").role).toBe("child");
    expect(resolveDesignReviewActorEvidence({ isChild: false }, "/x/owner.json").role).toBe("unknown");
    expect(resolveDesignReviewActorEvidence({ isChild: false, sessionFile: "/x/a.json" }, undefined).role).toBe("unknown");
    expect(resolveDesignReviewActorEvidence({ isChild: false, sessionFile: "/x/a.json" }, "/x/b.json").role).toBe("unknown");
    const ok = resolveDesignReviewActorEvidence({ isChild: false, sessionFile: "/x/a.json" }, "/x/a.json");
    expect(ok.role).toBe("owner");
    expect(ok.source).toBe("session-file");
  });

  it("single-flight permits exactly one concurrent menu per decision id", () => {
    const id = "decision-single-flight";
    expect(beginHumanDecisionMenu(id)).toBe(true);
    expect(beginHumanDecisionMenu(id)).toBe(false);
    expect(isHumanDecisionMenuInFlight(id)).toBe(true);
    endHumanDecisionMenu(id);
    expect(isHumanDecisionMenuInFlight(id)).toBe(false);
    expect(beginHumanDecisionMenu(id)).toBe(true);
    clearAllHumanDecisionMenus();
    expect(isHumanDecisionMenuInFlight(id)).toBe(false);
  });

  it("presentHumanDecisionMenu: no select ⇒ undefined; exact protocol; exceptions ⇒ undefined", async () => {
    const p = buildPendingHumanDecision(pendingInput(1));
    expect(await presentHumanDecisionMenu(undefined, undefined, p)).toBeUndefined();

    const calls: Array<[string, readonly string[]]> = [];
    const notified: string[] = [];
    const sel = async (title: string, options: readonly string[]) => {
      calls.push([title, options]);
      return "Revise Plan";
    };
    expect(await presentHumanDecisionMenu(sel, (m) => notified.push(m), p)).toBe("revise-plan");
    expect(calls[0]![0]).toBe(HUMAN_DECISION_TITLE);
    expect([...calls[0]![1]]).toEqual([...HUMAN_DECISION_OPTIONS]);
    expect(notified.length).toBe(1);

    const boom = async () => {
      throw new Error("channel closed");
    };
    expect(await presentHumanDecisionMenu(boom, () => {
      throw new Error("notify channel closed too"); // notify must not block
    }, p)).toBeUndefined();

    expect(await presentHumanDecisionMenu(async () => "Proceed to Develop", undefined, p)).toBe("proceed-develop");
    expect(await presentHumanDecisionMenu(async () => "Cancel", undefined, p)).toBeUndefined();
  });

  it("HumanDecision typing round-trips through JSON persistence losslessly", () => {
    const p = buildPendingHumanDecision(pendingInput(2));
    const clone = JSON.parse(JSON.stringify(p)) as HumanDecision;
    expect(clone).toEqual(p);
    const c = applyHumanDecisionChoice(clone, "revise-plan", 7);
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });
});
