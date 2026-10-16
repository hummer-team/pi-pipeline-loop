/**
 * 200 Bug Phase 4 — lazy reportHash re-anchor in decision revalidation (G3-1).
 *
 * When a report is rewritten inside a NON-exempt paused window (exactly the
 * scoped release Phase 3 opened for the bound review report), the decision
 * anchor must converge to the CURRENT measured hash at revalidation time —
 * it is a legal edit, not snapshot drift. Decision-anchor windows
 * (decision-pending / new-decision), identity mismatches, commit conflicts
 * and unreadable reports keep the original `report_hash_drift` refusal
 * EXACTLY as before (G3-2 exemption invariant, G3-3 fail-closed).
 *
 * The re-anchor lives inside the shared revalidation engine
 * (`revalidateHumanDecisionSnapshot`, exported for this contract unit). The
 * harness drives the REAL chain to a persisted pending decision (manual
 * confirm, no select → menu skipped, decision stays pending), then flips
 * ONLY the pause reason and rewrites the report.
 */
import { afterEach, afterAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initAuditLog, setAuditPipelineContext } from "../../utils/auditLog";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  coordinateDesignReview,
  revalidateHumanDecisionSnapshot,
  type CoordinatorContext,
} from "../../core/design-review/coordinator";
import { clearAllDecisionTimers } from "../../core/flow-state";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
} from "../../core/design-review/state";
import { clearAllHumanDecisionMenus } from "../../core/design-review/human-decision";
import type { HumanDecision } from "../../core/design-review/decision-types";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

const PIPE = "pipe-test-001";
const OWNER = "/x/owner-session.json";

/** Contract-valid FAIL report (manual mode: NO decision section). */
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

describe("200 Bug Phase 4: lazy decision reportHash re-anchor", () => {
  let projectRoot = "";
  let planDoc = "";
  let config: PipelineConfig;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dr-reanchor-"));
    planDoc = path.join(projectRoot, "docs/design/200_Bug_plan.md");
    fs.mkdirSync(path.dirname(planDoc), { recursive: true });
    fs.writeFileSync(planDoc, "# Plan\n\nPhase 0-5 tasks.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" };
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "manual" },
    };
    await initAuditLog(config);
    setAuditPipelineContext(PIPE);
  });

  afterEach(() => {
    clearAllHumanDecisionMenus();
    setAuditPipelineContext(null);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    clearAllDecisionTimers();
  });

  interface SpawnRec {
    stage: string;
    prompt?: string;
  }

  function makeCtx(
    meta: SessionMeta,
    spawnLog: SpawnRec[],
  ): { ctx: CoordinatorContext; session: ReturnType<typeof makeStrictSession> } {
    const session = makeStrictSession(meta);
    const notifications: string[] = [];
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: { notify: (m) => notifications.push(m) },
      pi: { sendUserMessage: () => {} },
      actor: { isChild: false, sessionFile: OWNER },
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

  /** Drive the REAL chain to a persisted pending decision with H1 bound. */
  async function setupPendingDecision(): Promise<{
    ctx: CoordinatorContext;
    session: ReturnType<typeof makeStrictSession>;
    decision: HumanDecision;
    reportDoc: string;
  }> {
    const spawnLog: SpawnRec[] = [];
    const { ctx, session } = makeCtx(makeMeta(), spawnLog);
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "routed").toBe(true);
    const st = session.getMeta()!.designReview!;
    expect(st.phase).toBe("review_running");
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(
      reportDoc,
      report({ planDoc, operationId: st.operation!.operationId, inputHash: planHash, verdict: "FAIL", issues: ["fix the drift guard"] }),
      "utf-8",
    );
    // Settle WITHOUT a select capability → the creation path persists the
    // pending decision (anchored at H1) and the menu is skipped.
    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    void r2;
    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("decision-pending");
    const decision = after.decision;
    expect(decision).toBeDefined();
    expect(decision!.reportHash).toBe(computeHash(fs.readFileSync(reportDoc, "utf-8")));
    return { ctx, session, decision: decision!, reportDoc };
  }

  /** Re-anchor-eligible pause: flip ONLY the reason (identity untouched). */
  function flipPauseReason(
    session: ReturnType<typeof makeStrictSession>,
    reason: string,
  ): void {
    const live = session.getMeta()!;
    const st = live.designReview!;
    session.updateMeta({
      designReview: { ...st, pauseReason: reason as never, updatedAt: st.updatedAt },
    });
  }

  function rewriteReport(reportDoc: string, operationId: string): string {
    const content = report({
      planDoc,
      operationId,
      inputHash: computeHash(fs.readFileSync(planDoc, "utf-8")),
      verdict: "FAIL",
      issues: ["legal paused-window edit: reworded the same finding"],
    });
    fs.writeFileSync(reportDoc, content, "utf-8");
    return computeHash(content);
  }

  function auditText(): string {
    const root = path.join(projectRoot, ".pi", "audit");
    if (!fs.existsSync(root)) return "";
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.name.endsWith("_audit.log")) out.push(fs.readFileSync(fp, "utf-8"));
      }
    };
    walk(root);
    return out.join("\n");
  }

  it("H1 → legal paused-window rewrite → revalidate returns ok, persists H2, audits decision_report_reanchored", async () => {
    const { ctx, session, decision, reportDoc } = await setupPendingDecision();
    const H1 = decision.reportHash;
    const H2 = rewriteReport(reportDoc, decision.reviewIdentity.operationId);
    expect(H2).not.toBe(H1);
    flipPauseReason(session, "drift");

    const rv = await revalidateHumanDecisionSnapshot(ctx, session.getMeta()!, decision);
    expect(rv.ok).toBe(true);

    const after = session.getMeta()!.designReview!;
    expect(after.decision!.reportHash).toBe(H2);
    expect(after.decision!.planHash).toBe(decision.planHash);
    expect(after.decision!.state).toBe(decision.state);
    expect(after.decision!.decisionId).toBe(decision.decisionId);
    expect(after.pauseReason).toBe("drift");
    const audit = auditText();
    expect(audit).toContain("decision_report_reanchored");
    expect(audit).toContain(H1);
    expect(audit).toContain(H2);
  });

  it("chosen records re-anchor identically (decisionState stays chosen, pinned commit)", async () => {
    const { ctx, session, decision, reportDoc } = await setupPendingDecision();
    const chosen: HumanDecision = {
      ...(decision as HumanDecision & { state: "pending" }),
      state: "chosen",
      choice: "proceed-develop",
      source: "human",
      decidedAt: 1730000000000,
    } as HumanDecision;
    session.updateMeta({
      designReview: { ...session.getMeta()!.designReview!, decision: chosen },
    });
    const H2 = rewriteReport(reportDoc, chosen.reviewIdentity.operationId);
    flipPauseReason(session, "executor-failed");

    const rv = await revalidateHumanDecisionSnapshot(ctx, session.getMeta()!, chosen);
    expect(rv.ok).toBe(true);
    const after = session.getMeta()!.designReview!;
    expect(after.decision!.reportHash).toBe(H2);
    expect(after.decision!.state).toBe("chosen");
    expect((after.decision as { choice?: string }).choice).toBe("proceed-develop");
    expect(auditText()).toContain("decision_report_reanchored");
  });

  it("exemption invariant: paused(decision-pending) with the same rewrite still report_hash_drift", async () => {
    const { ctx, session, decision, reportDoc } = await setupPendingDecision();
    const H1 = decision.reportHash;
    rewriteReport(reportDoc, decision.reviewIdentity.operationId);
    // reason NOT flipped: the menu window stays frozen (G3-2).

    const rv = await revalidateHumanDecisionSnapshot(ctx, session.getMeta()!, decision);
    expect(rv).toEqual({ ok: false, reason: "report_hash_drift" });
    expect(session.getMeta()!.designReview!.decision!.reportHash).toBe(H1);
    expect(auditText()).not.toContain("decision_report_reanchored");
  });

  it("exemption invariant: paused(new-decision) stays context-free — refusal, zero mutation, never re-anchored", async () => {
    const { ctx, session, decision, reportDoc } = await setupPendingDecision();
    const H1 = decision.reportHash;
    rewriteReport(reportDoc, decision.reviewIdentity.operationId);
    flipPauseReason(session, "new-decision");

    // new-decision is NOT an editable window (Phase 3 exemption set), so the
    // verification view is not normalized and no review context exists —
    // exactly as before Phase 4. The invariant the plan pins is the REFUSAL
    // with zero anchor mutation; the precise engine reason for a context-free
    // window is verification_unavailable (it never reaches the hash branch).
    const rv = await revalidateHumanDecisionSnapshot(ctx, session.getMeta()!, decision);
    expect(rv.ok).toBe(false);
    expect(rv).toEqual({ ok: false, reason: "verification_unavailable" });
    expect(session.getMeta()!.designReview!.decision!.reportHash).toBe(H1);
    expect(auditText()).not.toContain("decision_report_reanchored");
  });

  it("identity mismatch (other operationId) is refused as real drift, never re-anchored", async () => {
    const { ctx, session, decision, reportDoc } = await setupPendingDecision();
    const H1 = decision.reportHash;
    rewriteReport(reportDoc, decision.reviewIdentity.operationId);
    flipPauseReason(session, "executor-failed");
    const other = {
      ...decision,
      reviewIdentity: { ...decision.reviewIdentity, operationId: "op-from-another-round" },
    } as HumanDecision;

    const rv = await revalidateHumanDecisionSnapshot(ctx, session.getMeta()!, other);
    expect(rv).toEqual({ ok: false, reason: "report_hash_drift" });
    expect(session.getMeta()!.designReview!.decision!.reportHash).toBe(H1);
    expect(auditText()).not.toContain("decision_report_reanchored");
  });

  it("unreadable report (no outcome hash) is refused as before — re-anchor never substitutes a verdict", async () => {
    const { ctx, session, decision, reportDoc } = await setupPendingDecision();
    const H1 = decision.reportHash;
    flipPauseReason(session, "executor-failed");
    fs.rmSync(reportDoc);

    const rv = await revalidateHumanDecisionSnapshot(ctx, session.getMeta()!, decision);
    expect(rv.ok).toBe(false);
    expect(session.getMeta()!.designReview!.decision!.reportHash).toBe(H1);
    expect(auditText()).not.toContain("decision_report_reanchored");
  });

  it("control: unchanged report in an editable window returns ok with NO re-anchor commit", async () => {
    const { ctx, session, decision } = await setupPendingDecision();
    flipPauseReason(session, "drift");

    const rv = await revalidateHumanDecisionSnapshot(ctx, session.getMeta()!, decision);
    expect(rv.ok).toBe(true);
    expect(session.getMeta()!.designReview!.decision!.reportHash).toBe(decision.reportHash);
    expect(auditText()).not.toContain("decision_report_reanchored");
  });
});
