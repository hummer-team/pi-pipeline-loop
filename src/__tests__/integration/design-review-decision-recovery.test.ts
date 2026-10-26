/**
 * 212 Bug develop Phase 3 (Unit Tests Extra): the incident's full recovery
 * chain replayed through PUBLIC entries ONLY (`coordinateDesignReview` with
 * the same actor / interaction-source inputs the plugin entries assemble via
 * `createDesignReviewRuntimeContext`; spawn via `spawnOverride`; the mock
 * speaks ONLY the UI verbs `select`/`notify`).
 *
 * The locked chain (mirrors the 2026-10-26 production log):
 * 1. the CHILD settles ⇒ the pending decision is created on the 193 owner
 *    with the ancestor recorded as owner evidence; the child is honestly
 *    refused the menu (`decision_menu_skipped role=child`, owner = parent,
 *    armedBy = child);
 * 2. the OWNER settles automatically ⇒ the decision is re-presented EXACTLY
 *    once (the 212 promise) and the one-shot budget is charged;
 * 3. the user presses Esc at that menu (`select → undefined`) ⇒ the choice
 *    stays pending with zero side effects (`decision_menu_cancelled`);
 * 4. the owner settles again automatically ⇒ NOTHING pops (0 additional
 *    menus) and the waiting audit carries the conclusive
 *    `autoReprompt: "already_presented"` reason;
 * 5. `/pipeline-resume` (settle channel, interactionSource "resume") ⇒ the
 *    menu re-opens manually (budget-independent), and choosing
 *    "Proceed to Develop" dispatches the handoff with
 *    `run.binding.ownerSessionFile` = the recorded owner.
 *
 * Boundary respected: 193 single authority is never relaxed — the owner is
 * always a non-child session with its own session file, and the child never
 * sees or answers the menu.
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
import { clearAllHumanDecisionMenus, HUMAN_DECISION_TITLE } from "../../core/design-review/human-decision";
import { createInitialState, computeHash, deriveReportPath } from "../../core/design-review/state";
import { DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION } from "../../core/design-review/decision-display";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import type { DesignReviewActorInput, DesignReviewInteractionSource } from "../../core/design-review/decision-types";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

const PIPE = "pipe-212-incident";
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

describe("212 Phase 3 integration: the incident recovery chain end to end (public entries only)", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-incident-"));
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

  it("child creation → owner auto re-present → Esc → silent settle → manual resume → develop handoff with owner binding", async () => {
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
    const spawnLog: string[] = [];
    const notifications: string[] = [];
    const selectLog: string[] = [];
    let menuShown = 0;

    function mkCtx(opts?: {
      actor?: DesignReviewActorInput;
      interactionSource?: DesignReviewInteractionSource;
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
        ...(opts?.interactionSource !== undefined ? { interactionSource: opts.interactionSource } : {}),
        spawnOverride: async (_cfg, stage) => {
          spawnLog.push(stage);
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

    // ── Step 0: dispatch the review as the child subagent ───────────────────
    let decisionId = "";
    {
      const ctx = mkCtx({ actor: { isChild: true, sessionFile: CHILD, parentSessionFile: OWNER } });
      const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
      expect(r.status === "handled" && r.action === "routed").toBe(true);
      const st = session.getMeta()!.designReview!;
      expect(st.phase).toBe("review_running");
      const reportDoc = deriveReportPath(planDoc, 1);
      fs.writeFileSync(
        reportDoc,
        report({
          planDoc,
          operationId: st.operation!.operationId,
          inputHash: computeHash(fs.readFileSync(planDoc, "utf-8")),
          verdict: "FAIL",
        }),
        "utf-8",
      );
    }

    // ── Step 1: the CHILD settles ⇒ pending created on the owner, menu denied
    {
      const r = await coordinateDesignReview(
        mkCtx({ actor: { isChild: true, sessionFile: CHILD, parentSessionFile: OWNER } }),
        session.getMeta()!,
        "settle",
      );
      expect(reasonOf(r)).toBe("decision_pending");
      const st = session.getMeta()!.designReview!;
      expect(st.decision?.state).toBe("pending");
      decisionId = st.decision!.decisionId;
      expect(st.decision?.ownerSessionFile).toBe(OWNER); // 193 owner = the main session
      const skipped = auditFindBy("decision_menu_skipped");
      expect(skipped.length).toBe(1);
      expect(skipped[0]!.message.role).toBe("child");
      const created = auditFindBy("decision_pending_created");
      expect(created.length).toBe(1);
      // 212 Phase 0 evidence chain: owner = ancestor, armer = the child itself.
      expect(created[0]!.message.ownerSessionFile).toBe(OWNER);
      expect(created[0]!.message.armedBySessionFile).toBe(CHILD);
      expect(menuShown).toBe(0); // the child NEVER sees the menu
      // The never-shown creation refused the child BEFORE the charge point,
      // so the one automatic presentation is still unspent for the owner.
      expect(session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
    }

    // ── Step 2+3: the OWNER settles automatically ⇒ the decision is
    //    re-presented EXACTLY once; Esc at that menu keeps it pending ────────
    {
      const r = await coordinateDesignReview(
        mkCtx({
          actor: { isChild: false, sessionFile: OWNER },
          select: async (title) => {
            selectLog.push(title);
            return undefined; // Esc
          },
        }),
        session.getMeta()!,
        "settle",
      );
      expect(reasonOf(r)).toBe("decision_pending");
      expect(menuShown).toBe(1); // ONE re-presentation (the 212 promise)
      expect(selectLog).toEqual([HUMAN_DECISION_TITLE]); // the frozen menu, verbatim
      const reprompt = auditFindBy("decision_auto_reprompt");
      expect(reprompt.length).toBe(1);
      expect(reprompt[0]!.message.decisionId).toBe(decisionId);
      // 212 review fix #4: the audit is written AFTER the presenter and
      // carries the truthful charge outcome — here the menu really opened.
      expect(reprompt[0]!.message.charged).toBe(true);
      const cancelled = auditFindBy("decision_menu_cancelled");
      expect(cancelled.length).toBe(1);
      expect(cancelled[0]!.message.decisionId).toBe(decisionId);
      // Esc = zero write: the choice stays pending, nothing was committed…
      expect(session.getMeta()!.designReview!.decision?.state).toBe("pending");
      // …but the menu really opened, so the one-shot budget is now SPENT.
      expect(session.getMeta()!.designReviewDecisionReprompt?.decisionId).toBe(decisionId);
    }

    // ── Step 4: another automatic settle ⇒ NEVER pops again (budget spent) ──
    {
      const awaitingBefore = auditFindBy("decision_awaiting_human").length;
      const r = await coordinateDesignReview(
        mkCtx({ actor: { isChild: false, sessionFile: OWNER }, select: async () => "Proceed to Develop" }),
        session.getMeta()!,
        "settle",
      );
      expect(reasonOf(r)).toBe("decision_pending");
      expect(menuShown).toBe(1); // still ONE overall — the core promise
      // 212 review fix #4: a settle the decider REFUSED never logs a
      // reprompt attempt at all — the audit only exists when the presenter
      // was actually entered.
      expect(auditFindBy("decision_auto_reprompt").length).toBe(1); // unchanged from step 2
      const newly = auditFindBy("decision_awaiting_human").slice(awaitingBefore);
      expect(newly.length).toBe(1);
      expect(newly[0]!.message.autoReprompt).toBe("already_presented");
      expect(newly[0]!.message.decisionId).toBe(decisionId);
      expect(session.getMeta()!.designReview!.decision?.state).toBe("pending");
      // 212 Phase 3 copy: the notice promises "at most once", never "will open".
      expect(notifications.some((n) => n.includes("at most once") && n.includes("/pipeline-resume"))).toBe(true);
    }

    // ── Step 5: manual resume re-opens the menu; the choice hands off ───────
    {
      const r = await coordinateDesignReview(
        mkCtx({
          actor: { isChild: false, sessionFile: OWNER },
          interactionSource: "resume", // what /pipeline-resume assembles
          select: async (title, options) => {
            selectLog.push(`${title}|${options.join(",")}`);
            return "Proceed to Develop";
          },
        }),
        session.getMeta()!,
        "settle",
      );
      expect(r.status === "handled" && r.action === "advanced" && (r as { toStage: string }).toStage === "develop").toBe(true);
      expect(menuShown).toBe(2); // +1: the manual path ALWAYS re-opens (budget-independent)
      const st = session.getMeta()!.designReview!;
      expect(st.decision?.state).toBe("chosen");
      if (st.decision?.state === "chosen") expect(st.decision.choice).toBe("proceed-develop");
      expect(st.phase).toBe("finished");
      expect(session.getMeta()!.currentStage).toBe("develop");
      expect(st.approval?.basis?.kind).toBe("human-override");
      expect(spawnLog).toEqual(["design-review", "develop"]);
      const run = session.getMeta()!.stageExecutorRun!;
      expect(run.binding.stage).toBe("develop");
      expect(run.binding.ownerSessionFile).toBe(OWNER); // Phase 2 evidence at work
      // The frozen menu content itself reached the user (title + options).
      expect(selectLog.some((s) => s.startsWith(HUMAN_DECISION_TITLE))).toBe(true);
      // And the Phase 3 promise text exists in the constant the surfaces share.
      expect(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION).toContain("at most once");
      expect(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION).toContain("/pipeline-resume always re-opens");
    }
  });

  // 212 review fix #4: the `decision_auto_reprompt` audit is written AFTER
  // the presenter and carries the TRUE charge outcome. A re-presentation
  // attempt that the presenter refused (before-menu drift here) opens ZERO
  // menus, must NOT charge the one-shot budget, and logs `charged:false` —
  // "audit as fact" can no longer claim a presentation that never happened.
  it("settle re-presentation refused by before-menu drift ⇒ decision_auto_reprompt{charged:false}, zero menus, budget untouched", async () => {
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
    let menuShown = 0;
    const mkDriftCtx = (actor: DesignReviewActorInput): CoordinatorContext => ({
      config,
      session,
      ui: {
        notify: () => {},
        select: async () => {
          menuShown++;
          return undefined;
        },
      },
      pi: { sendUserMessage: () => {} },
      actor,
      spawnOverride: async (_cfg, stage) => ({
        spawned: true,
        fallback: false,
        deferred: false,
        agentId: `agent-${stage}`,
        dispatchOutcome: "spawned_id" as const,
      }),
    });

    // child creates the pending (menu refused, budget unspent — incident step 1).
    const childCtx = mkDriftCtx({ isChild: true, sessionFile: CHILD, parentSessionFile: OWNER });
    const routed = await coordinateDesignReview(childCtx, session.getMeta()!, "advance");
    expect(routed.status === "handled" && routed.action === "routed").toBe(true);
    const reviewOp = session.getMeta()!.designReview!.operation!;
    const planHashAtDispatch = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(
      reportDoc,
      report({
        planDoc,
        operationId: reviewOp.operationId,
        inputHash: planHashAtDispatch,
        verdict: "FAIL",
      }),
      "utf-8",
    );
    const createdSettle = await coordinateDesignReview(childCtx, session.getMeta()!, "settle");
    expect(reasonOf(createdSettle)).toBe("decision_pending");
    const createdDecision = session.getMeta()!.designReview!.decision!;
    expect(createdDecision.state).toBe("pending");
    expect(menuShown).toBe(0); // the child never sees the menu

    // REAL mutation after the decision: the plan the report reviewed is gone.
    fs.writeFileSync(planDoc, "# Plan\n\nMUTATED after the pending decision.\n", "utf-8");

    // owner settle: the READ-ONLY decider still says "presented" (eligibility
    // is intact); the presenter's before-menu revalidation drifts ⇒ zero
    // menus, no charge, and the truthful audit.
    const ownerCtx = mkDriftCtx({ isChild: false, sessionFile: OWNER });
    const r = await coordinateDesignReview(ownerCtx, session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect(reasonOf(r)).toContain("decision_drift");
    expect(menuShown).toBe(0); // ui.select NEVER ran
    const reprompt = auditFindBy("decision_auto_reprompt");
    expect(reprompt.length).toBe(1);
    expect(reprompt[0]!.message.charged).toBe(false);
    expect(reprompt[0]!.message.decisionId).toBe(createdDecision.decisionId);
    const failed = auditFindBy("decision_revalidation_failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.message.stage).toBe("before_menu");
    // the unspent budget stays unspent (a refused attempt never charges),
    // and the drifted pause clears the stale decision honestly.
    expect(session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
    expect(session.getMeta()!.designReview!.pauseReason).toBe("drift");
    expect(session.getMeta()!.designReview!.decision).toBeUndefined();
  });
});
