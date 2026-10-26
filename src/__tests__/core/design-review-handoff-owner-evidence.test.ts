/**
 * 212 Bug Phase 2 (Unit Tests Core): the proceed-develop owner-evidence guard.
 *
 * Locked semantics:
 * - a PROVABLE child without any observable ancestor must never reach the
 *   develop dispatch — the block happens BEFORE prepareDevelopTransition
 *   (no visit, no approval, no send-intent, 0 RPC, spawnLog untouched);
 * - the recorded choice is NEVER rolled back: phase stays paused
 *   ("decision-pending") with decision.state === "chosen"; the owner's next
 *   settle / resume re-enters the chosen-recovery branch and dispatches
 *   normally (recovery proven — not a deadlock);
 * - a child WITH a provable ancestor handoffs normally and the 194 run binds
 *   the ANCESTOR file (caller-resolved evidence at the develop handoff);
 * - review/update dispatch (dispatchOperation) passes NO resolved evidence:
 *   its run semantics stay pre-212 verbatim (honest skip + audit);
 * - BOUNDARY (documented, locked): `ctx.actor === undefined` and a NON-child
 *   with no session file keep the pre-212 behaviour — the handoff RUNS and
 *   the run side skips honestly. These environments have no substitute owner
 *   source; blocking them would wedge a runnable pipeline forever. The
 *   incident's `11:41:38 run_skip_no_owner_evidence` (evidence WITHOUT any
 *   session file, NOT a child) is exactly this boundary — deliberately NOT
 *   "fixed" by widening the guard.
 * - regression: `run_skip_no_owner_evidence` only appears when no evidence is
 *   resolvable — it NEVER co-occurs with `handoff_blocked_no_owner_evidence`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  coordinateDesignReview,
  type CoordinatorContext,
  type CoordinatorResult,
} from "../../core/design-review/coordinator";
import { isBlockedChildWithoutOwnerEvidence } from "../../core/design-review/owner-evidence";
import {
  applyHumanDecisionChoice,
  clearAllHumanDecisionMenus,
} from "../../core/design-review/human-decision";
import { createInitialState, computeHash, deriveReportPath } from "../../core/design-review/state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import type { DesignReviewActorInput } from "../../core/design-review/decision-types";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

const PIPE = "pipe-212-handoff";
const OWNER = "/x/owner-session.json";
const CHILD = "/x/child-session.json";

function reasonOf(r: CoordinatorResult): string {
  return (r as { reason?: string }).reason ?? "";
}

interface AuditRec {
  event: string;
  message: Record<string, unknown>;
  level?: string;
}

const auditRecords: AuditRec[] = [];

function auditUse(): void {
  auditRecords.length = 0;
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    auditRecords.push({ event, message: (message ?? {}) as Record<string, unknown>, ...(level !== undefined ? { level } : {}) });
  });
}

function auditFindBy(action: string): AuditRec[] {
  return auditRecords.filter((r) => r.message.action === action);
}

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

// ─── pure predicate ──────────────────────────────────────────────────────────

describe("212 Phase 2: isBlockedChildWithoutOwnerEvidence (the ONLY blocked actor)", () => {
  it("child WITH a provable ancestor ⇒ false (the handoff may speak for the owner)", () => {
    expect(
      isBlockedChildWithoutOwnerEvidence({ isChild: true, sessionFile: CHILD, parentSessionFile: OWNER }),
    ).toBe(false);
  });
  it("child WITHOUT an ancestor ⇒ true (exact blocked case)", () => {
    expect(isBlockedChildWithoutOwnerEvidence({ isChild: true, sessionFile: CHILD })).toBe(true);
    expect(
      isBlockedChildWithoutOwnerEvidence({ isChild: true, sessionFile: CHILD, parentSessionFile: "   " }),
    ).toBe(true);
  });
  it("non-child without a file ⇒ false (pre-212 behaviour preserved)", () => {
    expect(isBlockedChildWithoutOwnerEvidence({ isChild: false })).toBe(false);
    expect(isBlockedChildWithoutOwnerEvidence({ isChild: false, sessionFile: "" })).toBe(false);
  });
  it("absent actor ⇒ false (no evidence source is NOT provably unauthorized)", () => {
    expect(isBlockedChildWithoutOwnerEvidence(undefined)).toBe(false);
  });
});

// ─── coordinator-level guard scenarios ───────────────────────────────────────

describe("212 Phase 2: proceed-develop handoff guard (coordinator)", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-handoff-owner-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "212_Bug_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" };
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "manual" },
    };
    __resetMemoryThrottle();
    auditUse();
  });

  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
    clearAllHumanDecisionMenus();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  interface SpawnRec {
    stage: string;
  }

  function makeHarness() {
    const initial: SessionMeta = makeTestMeta({
      pipelineId: PIPE,
      currentStage: "design-review",
      designReview: createInitialState(
        planDoc,
        "menu",
        computeHash(fs.readFileSync(planDoc, "utf-8")),
        OWNER,
        { pipelineId: PIPE },
      ),
    });
    const session = makeStrictSession(initial);
    const spawnLog: SpawnRec[] = [];
    const notifications: string[] = [];
    let menuShown = 0;

    function mkCtx(opts?: {
      actor?: DesignReviewActorInput;
      select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
    }): CoordinatorContext {
      const ctx: CoordinatorContext = {
        config,
        session,
        ui: {
          notify: (m) => notifications.push(m),
          ...(opts?.select !== undefined
            ? {
                select: async (title, options) => {
                  menuShown++;
                  return opts.select!(title, options);
                },
              }
            : {}),
        },
        pi: { sendUserMessage: () => {} },
        ...(opts?.actor !== undefined ? { actor: opts.actor } : {}),
        spawnOverride: async (_cfg, stage) => {
          spawnLog.push({ stage });
          return {
            spawned: true,
            fallback: false,
            deferred: false,
            agentId: `agent-${stage}-${spawnLog.length}`,
            dispatchOutcome: "spawned_id" as const,
          };
        },
      };
      return ctx;
    }

    async function dispatchReview(actor: DesignReviewActorInput): Promise<{ reviewOpId: string; planHash: string }> {
      const ctx = mkCtx({ actor });
      const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
      expect(r.status === "handled" && r.action === "routed").toBe(true);
      const st = session.getMeta()!.designReview!;
      expect(st.phase).toBe("review_running");
      return { reviewOpId: st.operation!.operationId, planHash: computeHash(fs.readFileSync(planDoc, "utf-8")) };
    }

    function writeFailReport(reviewOpId: string, planHash: string): void {
      const reportDoc = deriveReportPath(planDoc, 1);
      fs.writeFileSync(
        reportDoc,
        report({ planDoc, operationId: reviewOpId, inputHash: planHash, verdict: "FAIL" }),
        "utf-8",
      );
    }

    /**
     * Build the crash-after-choice state: the strict choice commit persisted
     * `proceed-develop`, but the dispatch never ran (the exact precondition
     * the chosen-recovery branch handles). Creation stays on the honest path:
     * owner settle creates the pending decision and Esc keeps it pending.
     */
    async function setupChosenProceedDevelop(): Promise<string> {
      const { reviewOpId, planHash } = await dispatchReview({ isChild: false, sessionFile: OWNER });
      writeFailReport(reviewOpId, planHash);
      const createCtx = mkCtx({
        actor: { isChild: false, sessionFile: OWNER },
        select: async () => undefined, // Esc ⇒ pending stays
      });
      const r = await coordinateDesignReview(createCtx, session.getMeta()!, "settle");
      expect(reasonOf(r)).toBe("decision_pending");
      const dr = session.getMeta()!.designReview!;
      const decision = dr.decision!;
      expect(decision.state).toBe("pending");
      const chosen = applyHumanDecisionChoice(decision, "proceed-develop", Date.now());
      session.updateMeta({ designReview: { ...dr, decision: chosen } });
      return decision.decisionId;
    }

    return {
      session,
      mkCtx,
      dispatchReview,
      writeFailReport,
      setupChosenProceedDevelop,
      spawnLog,
      notifications,
      menuCount: () => menuShown,
    };
  }

  it("child WITHOUT an ancestor blocks the handoff before prepare: choice kept, 0 new spawn, no run_skip co-write", async () => {
    const h = makeHarness();
    const decisionId = await h.setupChosenProceedDevelop();
    const spawnCountBefore = h.spawnLog.length;
    const runBefore = h.session.getMeta()!.stageExecutorRun; // the OWNER-issued review run from setup
    expect(runBefore?.binding.stage).toBe("design-review");

    const blockedCtx = h.mkCtx({
      actor: { isChild: true, sessionFile: CHILD }, // no parentSessionFile
      select: async () => "Proceed to Develop", // must NEVER reach a menu here
    });
    const r = await coordinateDesignReview(blockedCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending" && reasonOf(r) === "handoff_blocked_no_owner_evidence").toBe(true);

    // NO rollback of the recorded choice (locked persistence contract):
    const after = h.session.getMeta()!;
    expect(after.designReview!.phase).toBe("paused");
    expect(after.designReview!.pauseReason).toBe("decision-pending");
    const chosenAfter = after.designReview!.decision!;
    expect(chosenAfter.state).toBe("chosen");
    if (chosenAfter.state === "chosen") expect(chosenAfter.choice).toBe("proceed-develop");
    expect(after.designReview!.decision?.decisionId).toBe(decisionId);
    // zero visit / approval / send-intent / spawn / RPC beyond the setup state
    expect(h.spawnLog.length).toBe(spawnCountBefore);
    expect(after.currentStage).toBe("design-review");
    expect(after.designReview!.operation?.kind).toBe("review"); // no develop-handoff op created
    // the run record still belongs to the setup review — NO develop run
    expect(h.session.getMeta()!.stageExecutorRun?.binding.stage).toBe("design-review");
    // chosen state must NOT pop a menu (state !== "pending")
    expect(h.menuCount()).toBe(1); // only the Esc'd creation menu
    // audit: blocked event exists, and it NEVER co-occurs with run_skip
    const blocked = auditFindBy("handoff_blocked_no_owner_evidence");
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.message.decisionId).toBe(decisionId);
    expect(blocked[0]!.level).toBe("error");
    expect(auditFindBy("run_skip_no_owner_evidence").length).toBe(0);
    // operator guidance
    expect(h.notifications.some((n) => n.includes("no provable owner session") && n.includes("/pipeline-resume"))).toBe(true);
  });

  it("after the block, the owner's settle retries the chosen recovery and dispatches normally (NOT a deadlock)", async () => {
    const h = makeHarness();
    await h.setupChosenProceedDevelop();
    const blockedCtx = h.mkCtx({ actor: { isChild: true, sessionFile: CHILD } });
    const r1 = await coordinateDesignReview(blockedCtx, h.session.getMeta()!, "settle");
    expect(reasonOf(r1)).toBe("handoff_blocked_no_owner_evidence");

    // owner settles the SAME chosen record: revalidate + act, dispatch runs.
    const ownerCtx = h.mkCtx({ actor: { isChild: false, sessionFile: OWNER } });
    const r2 = await coordinateDesignReview(ownerCtx, h.session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "advanced" && (r2 as { toStage: string }).toStage === "develop").toBe(true);

    const after = h.session.getMeta()!;
    expect(after.currentStage).toBe("develop");
    expect(after.designReview!.phase).toBe("finished");
    expect(after.designReview!.decision?.state).toBe("chosen"); // never rolled back, now dispatched
    expect(after.designReview!.approval?.basis?.kind).toBe("human-override");
    expect(h.spawnLog.map((s) => s.stage)).toEqual(["design-review", "develop"]);
    // the 194 run binds the OWNER file (caller-resolved evidence at the handoff)
    const run = after.stageExecutorRun!;
    expect(run.binding.stage).toBe("develop");
    expect(run.binding.ownerSessionFile).toBe(OWNER);
    // blocked event happened once (first settle); the retry wrote no new one
    expect(auditFindBy("handoff_blocked_no_owner_evidence").length).toBe(1);
    expect(auditFindBy("run_skip_no_owner_evidence").length).toBe(0);
  });

  it("child WITH a provable ancestor handoffs normally and the run binds the PARENT file", async () => {
    const h = makeHarness();
    await h.setupChosenProceedDevelop();
    const childCtx = h.mkCtx({
      actor: { isChild: true, sessionFile: CHILD, parentSessionFile: OWNER },
    });
    const r = await coordinateDesignReview(childCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "advanced" && (r as { toStage: string }).toStage === "develop").toBe(true);

    expect(auditFindBy("handoff_blocked_no_owner_evidence").length).toBe(0);
    expect(h.spawnLog.map((s) => s.stage)).toEqual(["design-review", "develop"]);
    const run = h.session.getMeta()!.stageExecutorRun!;
    expect(run.binding.stage).toBe("develop");
    // THE Phase 2 fix: a child handoff now resolves the nearest provable
    // ancestor for the run instead of silently skipping it.
    expect(run.binding.ownerSessionFile).toBe(OWNER);
  });

  it("review/update dispatch (dispatchOperation) under a child keeps the pre-212 honest skip — zero run-semantics drift", async () => {
    const h = makeHarness();
    // The guard covers the DEVELOP HANDOFF only (caller-injected evidence);
    // dispatchOperation passes NO third argument, so a child's review dispatch
    // behaves exactly like before 212: dispatch proceeds, run honestly skips.
    await h.dispatchReview({ isChild: true, sessionFile: CHILD });
    expect(h.spawnLog.map((s) => s.stage)).toEqual(["design-review"]);
    expect(h.session.getMeta()!.stageExecutorRun).toBeUndefined();
    expect(auditFindBy("run_skip_no_owner_evidence").length).toBe(1);
    expect(auditFindBy("handoff_blocked_no_owner_evidence").length).toBe(0);
  });

  it("boundary: non-child WITHOUT a session file keeps pre-212 behaviour — handoff runs, run honestly skips", async () => {
    const h = makeHarness();
    await h.setupChosenProceedDevelop();
    const noFileCtx = h.mkCtx({ actor: { isChild: false } });
    const r = await coordinateDesignReview(noFileCtx, h.session.getMeta()!, "settle");
    // NOT blocked: a runnable pipeline is never wedged for a missing evidence
    // source it cannot substitute (documented boundary, locked).
    expect(r.status === "handled" && r.action === "advanced" && (r as { toStage: string }).toStage === "develop").toBe(true);
    expect(auditFindBy("handoff_blocked_no_owner_evidence").length).toBe(0);
    // the run side stays honest: no evidence ⇒ skip + audit, never a fake run
    expect(auditFindBy("run_skip_no_owner_evidence").length).toBe(1);
    expect(h.session.getMeta()!.stageExecutorRun?.binding.stage).toBe("design-review"); // setup's owner-issued run, un-superseded
  });
});
