/**
 * 193 Phase 1 (Unit Tests Core #2): SMART plan-revision decision contract.
 *
 * Covers the machine protocol end to end:
 * - the pure parser (`parseDesignReviewSmartDecision`) over ONE cleaned
 *   snapshot: unique section (English + Chinese aliases), BINARY action tokens
 *   (revise-plan / request-human; proceed-develop explicitly rejected),
 *   non-placeholder reason, duplicate-agreeing vs contradictory rows, inert
 *   content that can NEVER fake the fields, section-scoped collection so
 *   suggestion prose is not parsed as fields;
 * - the trusted verifier gate: FAIL under smart mode requires the section
 *   (missing/malformed ⇒ INVALID — correction, never routing), PASS is exempt,
 *   non-smart consumers ignore it entirely, and the decision is attributed to
 *   the SAME reportHash the verdict came from;
 * - coordinator routing: revise-plan keeps the existing authorized update
 *   routing, request-human parks conservatively (Phase 2 wires the menu), and
 *   the corrective feedback states the conditional requirement only in smart
 *   mode.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../../types";
import {
  parseDesignReviewSmartDecision,
  PLAN_REVISION_DECISION_HEADING_PATTERN,
} from "../../../core/design-review/smart-decision";
import { stripInertLines } from "../../../core/design-review/report-sections";
import {
  computeReportHash,
  verifyDesignReviewReportSnapshot,
  type DesignReviewReportExpectation,
} from "../../../core/verifiers/design-review-verifier";
import { buildDesignReviewReportFeedback } from "../../../core/design-review/report-feedback";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
} from "../../../core/design-review/state";
import { coordinateDesignReview, type CoordinatorContext } from "../../../core/design-review/coordinator";
import { makeTestConfig, makeTestMeta, makeStrictSession, boundReviewOperation } from "../../helpers";

// ─── report fixtures ─────────────────────────────────────────────────────────

const PIPE = "pipe-test-001";

function decisionSection(body: string[], heading = "## Plan Revision Decision"): string[] {
  return ["", heading, "", ...body, ""];
}

/**
 * Complete contract-valid report. `decision` is appended verbatim (already
 * formatted section lines) or omitted.
 */
function report(o: {
  planDoc: string;
  round?: number;
  operationId: string;
  inputHash: string;
  verdict: "PASS" | "FAIL";
  issues?: string[];
  decision?: string[] | null;
}): string {
  const lines = [
    "# Design Review Report",
    "",
    `**pipeline**: ${PIPE}`,
    `**plan**: ${o.planDoc}`,
    `**round**: ${o.round ?? 1}`,
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
  ];
  if (o.decision !== null && o.decision !== undefined) {
    lines.push(...decisionSection(o.decision));
  } else if (o.decision === undefined) {
    // default: no decision section
  }
  return lines.join("\n");
}

function parse(lines: string[]) {
  return parseDesignReviewSmartDecision(stripInertLines(lines.join("\n")));
}

function actionReason(action: string, reason = "Plan gaps are fixable by an authorized revision pass.") {
  return [`**action**: ${action}`, `**reason**: ${reason}`];
}

describe("193 Phase 1: parseDesignReviewSmartDecision (machine protocol)", () => {
  it("accepts the two binary actions with a substantive reason", () => {
    for (const token of ["revise-plan", "request-human"] as const) {
      const res = parse(report({
        planDoc: "/x/plan.md", operationId: "op-1", inputHash: "h1", verdict: "FAIL",
        decision: actionReason(token),
      }).split("\n"));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.decision.action).toBe(token);
    }
  });

  it("accepts the Chinese heading alias and case-insensitive labels", () => {
    const res = parse([
      "## 计划修订决策",
      "",
      "**Action**: revise-plan",
      "**Reason**: 计划内问题可由授权修订解决。",
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.decision.reason).toBe("计划内问题可由授权修订解决。");
  });

  it("normalizes markdown-emphasized values (**action**: **revise-plan**)", () => {
    const res = parse(["## Plan Revision Decision", "", "**action**: **revise-plan**", "**reason**: real justification here"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.decision.action).toBe("revise-plan");
  });

  it("rejects proceed-develop with a dedicated NEVER message", () => {
    const res = parse(report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "h1", verdict: "FAIL",
      decision: actionReason("proceed-develop"),
    }).split("\n"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failures.join(" | ")).toMatch(/unknown \*\*action\*\* token "proceed-develop"/);
      expect(res.failures.join(" | ")).toMatch(/NEVER release development/);
    }
  });

  it("rejects any other unknown action token", () => {
    const res = parse(["## Plan Revision Decision", "", "**action**: approve", "**reason**: because"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failures[0]).toMatch(/unknown \*\*action\*\* token "approve" — allowed: revise-plan \| request-human/);
  });

  it("rejects a missing section", () => {
    const res = parse(["## Summary", "", "real content", ""]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failures[0]).toMatch(/missing ## Plan Revision Decision section/);
  });

  it("rejects duplicated sections", () => {
    const res = parse([
      ...["## Plan Revision Decision", "", "**action**: revise-plan", "**reason**: a"],
      ...["## Plan Revision Decision", "", "**action**: revise-plan", "**reason**: a"],
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failures[0]).toMatch(/appears 2 times — exactly one is required/);
  });

  it("tolerates duplicated fields ONLY when values agree", () => {
    const ok = parse([
      "## Plan Revision Decision",
      "",
      "**action**: revise-plan",
      "**action**: revise-plan",
      "**reason**: same justification",
      "**reason**: same justification",
    ]);
    expect(ok.ok).toBe(true);
    const bad = parse([
      "## Plan Revision Decision",
      "",
      "**action**: revise-plan",
      "**action**: request-human",
      "**reason**: same justification",
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failures[0]).toMatch(/mutually exclusive \*\*action\*\* values/);
  });

  it("reports missing action and missing reason together", () => {
    const res = parse(["## Plan Revision Decision", "", "some prose without fields"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failures.join(" | ")).toMatch(/missing \*\*action\*\*: field/);
      expect(res.failures.join(" | ")).toMatch(/missing \*\*reason\*\*: field/);
    }
  });

  it("rejects placeholder and blank reasons", () => {
    const placeholder = parse(["## Plan Revision Decision", "", "**action**: revise-plan", "**reason**: {todo}"]);
    expect(placeholder.ok).toBe(false);
    if (!placeholder.ok) expect(placeholder.failures[0]).toMatch(/empty or an unfilled placeholder/);

    const blank = parse(["## Plan Revision Decision", "", "**action**: revise-plan", "**reason**: <待填写>"]);
    expect(blank.ok).toBe(false);
  });

  it("inert content (code fence) can NEVER fake the decision section", () => {
    const res = parse([
      "## Summary",
      "",
      "```markdown",
      "## Plan Revision Decision",
      "",
      "**action**: revise-plan",
      "**reason**: inside a fence is not a real decision",
      "```",
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failures[0]).toMatch(/missing ## Plan Revision Decision section/);
  });

  it("collects fields ONLY inside the section (suggestion prose is never a field)", () => {
    const res = parse([
      "## Recommendations",
      "",
      "**action**: revise-plan",
      "**reason**: prose suggestion outside any decision section",
      "",
      "## Verdict",
      "",
      "**Design Review: FAIL**",
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failures[0]).toMatch(/missing ## Plan Revision Decision section/);
  });

  it("exports the heading anchor used by the parser", () => {
    expect(PLAN_REVISION_DECISION_HEADING_PATTERN).toContain("Plan Revision Decision");
    expect(PLAN_REVISION_DECISION_HEADING_PATTERN).toContain("计划修订决策");
  });
});

describe("193 Phase 1: verifier smart decision gate (ONE snapshot)", () => {
  const expectation = (planDoc: string, operationId: string, inputHash: string): DesignReviewReportExpectation => ({
    pipelineId: PIPE,
    planDoc,
    round: 1,
    operationId,
    inputHash,
  });
  const OPTS = (smart: boolean) => ({ smartDecisionMode: smart });

  it("valid FAIL + smart ⇒ fail with decision from the SAME reportHash", () => {
    const content = report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1", verdict: "FAIL",
      decision: actionReason("revise-plan", "All issues are addressable in the plan."),
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(true));
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") {
      expect(v.smartDecision).toEqual({ action: "revise-plan", reason: "All issues are addressable in the plan." });
      expect(v.reportHash).toBe(computeReportHash(content));
    }
  });

  it("valid FAIL + smart + request-human ⇒ decision carried for the park route", () => {
    const content = report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1", verdict: "FAIL",
      decision: actionReason("request-human", "Requirement conflict needs the product owner."),
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(true));
    expect(v.verdict === "fail" && v.smartDecision?.action).toBe("request-human");
  });

  it("FAIL + smart WITHOUT the section ⇒ INVALID (correction, never routed)", () => {
    const content = report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1", verdict: "FAIL", decision: null,
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(true));
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" | ")).toMatch(/missing ## Plan Revision Decision section/);
      expect(v.reportHash).toBe(computeReportHash(content));
    }
  });

  it("FAIL + smart with proceed-develop ⇒ INVALID, NOT fail (never routed)", () => {
    const content = report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1", verdict: "FAIL",
      decision: actionReason("proceed-develop"),
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(true));
    expect(v.verdict).toBe("invalid");
  });

  it("PASS + smart is EXEMPT (section absent or ignored when present)", () => {
    const clean = report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1", verdict: "PASS", decision: null,
    });
    const v1 = verifyDesignReviewReportSnapshot(clean, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(true));
    expect(v1.verdict).toBe("pass");

    const withSection = report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1", verdict: "PASS",
      decision: actionReason("request-human"),
    });
    const v2 = verifyDesignReviewReportSnapshot(withSection, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(true));
    expect(v2.verdict).toBe("pass");
    if (v2.verdict !== "invalid") expect(v2.smartDecision).toBeUndefined();
  });

  it("non-smart modes ignore the field entirely (no requirement, no attach)", () => {
    const noSection = report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1", verdict: "FAIL", decision: null,
    });
    const vAuto = verifyDesignReviewReportSnapshot(noSection, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(false));
    expect(vAuto.verdict).toBe("fail");
    if (vAuto.verdict === "fail") expect(vAuto.smartDecision).toBeUndefined();

    const withSection = report({
      planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1", verdict: "FAIL",
      decision: actionReason("revise-plan"),
    });
    const vFlagged = verifyDesignReviewReportSnapshot(withSection, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(false));
    expect(vFlagged.verdict === "fail" && vFlagged.smartDecision).toBeUndefined();
  });

  it("identity/structure rules run BEFORE the decision gate on the same snapshot", () => {
    const staleIdentity = report({
      planDoc: "/x/plan.md", operationId: "OTHER-OP", inputHash: "hash-1", verdict: "FAIL",
      decision: actionReason("revise-plan"),
    });
    const v1 = verifyDesignReviewReportSnapshot(staleIdentity, expectation("/x/plan.md", "op-1", "hash-1"), OPTS(true));
    expect(v1.verdict).toBe("invalid");
    if (v1.verdict === "invalid") {
      expect(v1.failures.join(" | ")).toMatch(/operation/i);
      expect(v1.failures.join(" | ")).not.toMatch(/Plan Revision Decision/);
    }
  });

  it("FAIL conclusion without issue items also requires the decision under smart", () => {
    const base = { planDoc: "/x/plan.md", operationId: "op-1", inputHash: "hash-1" };
    const noItems = report({ ...base, verdict: "FAIL", issues: ["None"], decision: null });
    const v1 = verifyDesignReviewReportSnapshot(noItems, expectation(base.planDoc, base.operationId, base.inputHash), OPTS(true));
    expect(v1.verdict).toBe("invalid");
    if (v1.verdict === "invalid") expect(v1.failures.join(" | ")).toMatch(/missing ## Plan Revision Decision/);

    const withDecision = report({ ...base, verdict: "FAIL", issues: ["None"], decision: actionReason("request-human", "Ambiguous conclusion needs a human call.") });
    const v2 = verifyDesignReviewReportSnapshot(withDecision, expectation(base.planDoc, base.operationId, base.inputHash), OPTS(true));
    expect(v2.verdict === "fail" && v2.smartDecision?.action).toBe("request-human");
  });
});

describe("193 Phase 1: coordinator smart FAIL routing (revise-plan routes, request-human parks)", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-smart-route-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".pi", "references"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "193_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" };
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "smart" },
    };
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

  async function dispatchReview(
    ctx: CoordinatorContext,
    session: ReturnType<typeof makeStrictSession>,
  ): Promise<{ reviewOpId: string; planHash: string }> {
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "routed").toBe(true);
    const st = session.getMeta()!.designReview!;
    expect(st.phase).toBe("review_running");
    expect(st.operation?.reviewConfirmMode).toBe("smart");
    return { reviewOpId: st.operation!.operationId, planHash };
  }

  function writeFailReport(reviewOpId: string, planHash: string, decisionBody: string[] | null): string {
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(reportDoc, report({
      planDoc, operationId: reviewOpId, inputHash: planHash, verdict: "FAIL", decision: decisionBody,
    }), "utf-8");
    return reportDoc;
  }

  it("revise-plan decision routes to the authorized plan update (update prompt carries NO smart guidance)", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: createInitialState(planDoc, "menu", computeHash(fs.readFileSync(planDoc, "utf-8")), undefined, { pipelineId: PIPE }),
    });
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const { ctx, session } = makeCtx(meta, spawnLog);

    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    expect(spawnLog[0].prompt).toContain("## Design Review Smart Plan-Revision Decision");

    writeFailReport(reviewOpId, planHash, actionReason("revise-plan", "All listed gaps are plan-internal."));
    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "routed" && (r2 as { toStage: string }).toStage === "plan").toBe(true);

    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("update_running");
    expect(after.operation?.kind).toBe("update");
    expect(spawnLog.length).toBe(2);
    // Update dispatch NEVER receives the review decision guidance
    expect(spawnLog[1].prompt).not.toContain("## Design Review Smart Plan-Revision Decision");
  });

  it("request-human decision parks with pending smart_request_human — zero update dispatch", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: createInitialState(planDoc, "menu", computeHash(fs.readFileSync(planDoc, "utf-8")), undefined, { pipelineId: PIPE }),
    });
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const { ctx, session } = makeCtx(meta, spawnLog);

    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeFailReport(reviewOpId, planHash, actionReason("request-human", "The requirement conflict needs the owner."));

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && r2.reason === "smart_request_human").toBe(true);

    const after = session.getMeta()!.designReview!;
    // NEVER falls through to the legacy automatic update: still review_running
    expect(after.phase).toBe("review_running");
    expect(after.operation?.kind).toBe("review");
    expect(spawnLog.length).toBe(1);
  });

  it("FAIL without the decision section becomes a corrective verify_failed (not a routed FAIL)", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: createInitialState(planDoc, "menu", computeHash(fs.readFileSync(planDoc, "utf-8")), undefined, { pipelineId: PIPE }),
    });
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const { ctx, session } = makeCtx(meta, spawnLog);

    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    writeFailReport(reviewOpId, planHash, null);

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "verify_failed").toBe(true);
    if (r2.status === "handled" && r2.action === "verify_failed") {
      expect(r2.failures.map((f) => f.detail).join(" | ")).toMatch(/missing ## Plan Revision Decision/);
      expect(r2.failures.every((f) => f.ruleType === "designReviewReport")).toBe(true);
    }
    expect(spawnLog.length).toBe(1); // no update dispatch
  });

  it("trusted no-issue PASS under smart is exempt and advances (no decision needed)", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: createInitialState(planDoc, "menu", computeHash(fs.readFileSync(planDoc, "utf-8")), undefined, { pipelineId: PIPE }),
    });
    const spawnLog: Array<{ stage: string; prompt?: string }> = [];
    const { ctx, session } = makeCtx(meta, spawnLog);

    const { reviewOpId, planHash } = await dispatchReview(ctx, session);
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(reportDoc, report({
      planDoc, operationId: reviewOpId, inputHash: planHash, verdict: "PASS", decision: null,
    }), "utf-8");

    const r2 = await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "advanced").toBe(true);
    // develop-handoff dispatch never carries the review guidance
    expect(spawnLog.length).toBe(2);
    expect(spawnLog[1].stage).toBe("develop");
    expect(spawnLog[1].prompt).not.toContain("## Design Review Smart Plan-Revision Decision");
  });
});

describe("193 Phase 1: corrective feedback states the conditional decision requirement", () => {
  function feedbackMeta(pinned: "smart" | "auto" | undefined): SessionMeta {
    const planDoc = "/abs/docs/193_Feat_plan.md";
    const dr = createInitialState(planDoc, "menu", "hash-1", undefined, { pipelineId: PIPE });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: {
        ...dr,
        phase: "review_running",
        operation: {
          ...boundReviewOperation("op-smart-fb", "hash-1"),
          ...(pinned !== undefined ? { reviewConfirmMode: pinned } : {}),
        },
      },
    });
    return meta;
  }

  const failures = [
    { ruleType: "designReviewReport", detail: "missing ## Plan Revision Decision section", timestamp: 1 },
  ];

  it("smart-pinned review gets the decision section guidance", () => {
    const fb = buildDesignReviewReportFeedback({
      meta: feedbackMeta("smart"),
      stageName: "design-review",
      failures,
    });
    expect(fb).not.toBeNull();
    expect(fb!.message).toContain("SMART decision mode governs this review");
    expect(fb!.message).toContain("## Plan Revision Decision");
    expect(fb!.message).toContain('revise-plan | request-human ("proceed-develop" is NEVER valid');
  });

  it("auto-pinned review keeps the original feedback untouched", () => {
    const fb = buildDesignReviewReportFeedback({
      meta: feedbackMeta("auto"),
      stageName: "design-review",
      failures,
    });
    expect(fb).not.toBeNull();
    expect(fb!.message).not.toContain("SMART decision mode");
  });

  it("legacy unpinned review keeps the original feedback (failures text remains authoritative)", () => {
    const fb = buildDesignReviewReportFeedback({
      meta: feedbackMeta(undefined),
      stageName: "design-review",
      failures,
    });
    expect(fb).not.toBeNull();
    expect(fb!.message).not.toContain("SMART decision mode");
    expect(fb!.failures.join(" ")).toContain("missing ## Plan Revision Decision section");
  });
});
