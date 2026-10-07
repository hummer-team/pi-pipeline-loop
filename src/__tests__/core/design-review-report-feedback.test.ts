/**
 * 193 Phase 0 (Unit Tests Core #2): the report-domain CORRECTIVE FEEDBACK and
 * the ONE honest shared consumer for design-review coordinator results.
 *
 * Proves the contract-critical behaviors (requirement 193 Q1-A/Q5-A, review
 * round-1 issue 3):
 * - only design-review REPORT failures render the corrective template; update
 *   deliverables and every other stage keep their existing feedback;
 * - identity rows come from the TRUSTED persisted context, never from failure
 *   prose;
 * - `applyVerifyFail` keeps the existing budget/freeze/wake policy, surfaces
 *   the template on every path (wake, no-pi notify, overflow return) and stops
 *   waking once frozen;
 * - `consumeDesignReviewResult` records EXACTLY ONE budget attempt per entry,
 *   defers child sessions with zero budget and never reports a non-advanced /
 *   non-routed action as success.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta, VerifyFailureItem } from "../../types";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { computeHash, createInitialState } from "../../core/design-review/state";
import {
  DESIGN_REVIEW_REPORT_RULE_TYPE,
  buildDesignReviewReportFeedback,
  isDesignReviewReportFailure,
} from "../../core/design-review/report-feedback";
import { applyVerifyFail } from "../../core/verify-advance";
import {
  consumeDesignReviewResult,
  type DesignReviewEntryOutcome,
} from "../../core/design-review/entry-result";
import { clearAllDecisionTimers } from "../../core/flow-state";
import { createPipelineUI } from "../../core/pipeline-ui";
import type { CoordinatorResult } from "../../core/design-review/coordinator";

const PIPELINE_ID = "pipe-feedback-193";
const OP_ID = "op-feedback-review-1";

/** Marker phrase unique to the corrective report template. */
const TEMPLATE_MARKER = "Identity this report MUST carry";

let projectRoot: string;
let planDoc: string;
let planHash: string;

beforeEach(async () => {
  projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-feedback-"));
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  planDoc = path.join(projectRoot, "docs", "193_Feat_plan.md");
  fs.writeFileSync(planDoc, "# Plan\nv1\n", "utf-8");
  planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
  await initAuditLog(makeTestConfig({ projectRoot }));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

afterAll(() => {
  // Decision retry chains are real timers; never let them leak across files.
  clearAllDecisionTimers();
  __resetAuditDirPath();
});

/** Trusted design-review context meta (report domain). */
function reviewMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  const base = createInitialState(planDoc, "menu", planHash, "/tmp/owner.jsonl", {
    pipelineId: PIPELINE_ID,
  });
  return makeTestMeta({
    pipelineId: PIPELINE_ID,
    currentStage: "design-review",
    requirementDoc: "docs/193_Feat.md",
    designReview: {
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
    },
    ...overrides,
  });
}

/** Trusted PLAN-stage context meta (update deliverable domain). */
function updateMeta(): SessionMeta {
  const base = createInitialState(planDoc, "menu", planHash, "/tmp/owner.jsonl", {
    pipelineId: PIPELINE_ID,
  });
  return makeTestMeta({
    pipelineId: PIPELINE_ID,
    currentStage: "plan",
    designReview: {
      ...base,
      phase: "update_running",
      operation: {
        operationId: "op-feedback-update-1",
        kind: "update",
        stageVisitId: 1001,
        attempt: 1,
        dispatchState: "dispatched",
        agentId: "agent-2",
        round: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  });
}

function reportFailure(detail: string): VerifyFailureItem {
  return { ruleType: DESIGN_REVIEW_REPORT_RULE_TYPE, detail, timestamp: Date.now() };
}

function ordinaryFailure(detail: string): VerifyFailureItem {
  return { ruleType: "keywords", detail, timestamp: Date.now() };
}

describe("193 Phase 0: report-failure detection is domain-scoped", () => {
  it("design-review REPORT failure inside a trusted review context matches", () => {
    expect(
      isDesignReviewReportFailure({
        meta: reviewMeta(),
        stageName: "design-review",
        failures: [reportFailure("missing **operation** identity field")],
      }),
    ).toBe(true);
  });

  it("other stages never match (the template cannot leak)", () => {
    for (const stage of ["plan", "develop", "review", "fix"] as const) {
      expect(
        isDesignReviewReportFailure({
          meta: makeTestMeta({ currentStage: stage }),
          stageName: stage,
          failures: [reportFailure("anything")],
        }),
      ).toBe(false);
    }
  });

  it("update deliverables never match", () => {
    expect(
      isDesignReviewReportFailure({
        meta: updateMeta(),
        stageName: "plan",
        failures: [{ ...reportFailure("update deliverable invalid"), ruleType: "designReviewUpdate" }],
      }),
    ).toBe(false);
    // even a report-typed failure is not a report domain outside review_running
    expect(
      isDesignReviewReportFailure({
        meta: updateMeta(),
        stageName: "design-review",
        failures: [reportFailure("anything")],
      }),
    ).toBe(false);
  });

  it("ordinary rule failures never match", () => {
    expect(
      isDesignReviewReportFailure({
        meta: reviewMeta(),
        stageName: "design-review",
        failures: [ordinaryFailure("Missing keywords: DONE")],
      }),
    ).toBe(false);
  });

  it("a meta without an authorized review state never matches", () => {
    expect(
      isDesignReviewReportFailure({
        meta: makeTestMeta({ currentStage: "design-review" }),
        stageName: "design-review",
        failures: [reportFailure("anything")],
      }),
    ).toBe(false);
  });
});

describe("193 Phase 0: corrective feedback renders the TRUSTED identity", () => {
  it("non-report domain returns null (caller keeps ordinary text)", () => {
    expect(
      buildDesignReviewReportFeedback({
        meta: makeTestMeta({ currentStage: "develop" }),
        stageName: "develop",
        failures: [ordinaryFailure("nope")],
      }),
    ).toBeNull();
  });

  it("renders the real report path, identity values and every defect", () => {
    const feedback = buildDesignReviewReportFeedback({
      meta: reviewMeta(),
      stageName: "design-review",
      failures: [
        reportFailure("missing **operation** identity field"),
        reportFailure("Summary section has no content (blank lines, unfilled placeholders or inert examples do not count)"),
      ],
    });
    expect(feedback).not.toBeNull();
    const msg = feedback!.message;
    // report path comes from the trusted persisted state
    expect(msg).toContain(feedback!.reportDoc);
    expect(feedback!.reportDoc).toBe(
      path.join(path.dirname(planDoc), "review-design-1-" + path.basename(planDoc)),
    );
    // identity rows carry the CURRENT run's real values
    expect(msg).toContain(`**pipeline**: ${PIPELINE_ID}`);
    expect(msg).toContain(`**plan**: ${path.resolve(planDoc)}`);
    expect(msg).toContain("**round**: 1");
    expect(msg).toContain(`**operation**: ${OP_ID}`);
    expect(msg).toContain(`**input hash**: ${planHash}`);
    // every defect is echoed
    expect(msg).toContain("missing **operation** identity field");
    expect(msg).toContain("Summary section has no content");
    // all four sections and the sentinel rule are declared
    for (const heading of ["## Summary", "## Issues", "## Recommendations", "## Verdict"]) {
      expect(msg).toContain(heading);
    }
    expect(msg).toContain("None");
    expect(msg).toContain("Aliases:");
    // corrective scope: fix the report in place, never touch plan/develop
    expect(msg).toContain("Fix ONLY this report file");
    expect(msg).toContain("never be routed to develop");
    expect(msg).toContain(TEMPLATE_MARKER);
  });

  it("identity is NEVER reverse-inferred from failure prose", () => {
    // The defect text quotes a forged identity value; the rendered rows must
    // still show the trusted persisted values.
    const feedback = buildDesignReviewReportFeedback({
      meta: reviewMeta(),
      stageName: "design-review",
      failures: [reportFailure('pipeline identity mismatch: report="pipe-forged-999" current="' + PIPELINE_ID + '"')],
    });
    const msg = feedback!.message;
    const identityRowLines = msg
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("**pipeline**:"));
    expect(identityRowLines.length).toBeGreaterThan(0);
    for (const line of identityRowLines) {
      expect(line).toBe(`**pipeline**: ${PIPELINE_ID}`);
    }
  });
});

/** Minimal session ctx for the shared failure path. */
function makeCtx(
  meta: SessionMeta,
  opts?: {
    pi?: { sendUserMessage?: (msg: string, o?: Record<string, unknown>) => void };
    select?: (msg: string, options: unknown[]) => Promise<string | undefined>;
  },
) {
  let current = meta;
  const notifications: string[] = [];
  const ctx = {
    session: {
      getMeta: () => current,
      updateMeta: (patch: Partial<SessionMeta>) => {
        current = { ...current, ...patch };
        return current;
      },
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      setStatus: () => {},
      ...(opts?.select ? { select: opts.select } : {}),
    },
    pi: opts?.pi,
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    notifications,
    get currentMeta() {
      return current;
    },
  };
  return ctx;
}

function configWithBudget(maxVerifyAttempts: number): PipelineConfig {
  return makeTestConfig({ projectRoot, maxVerifyAttempts });
}

describe("193 Phase 0: applyVerifyFail keeps the existing budget policy", () => {
  it("rule method wakes the model with the corrective template (one wake)", async () => {
    const woken: string[] = [];
    const meta = reviewMeta();
    const ctx = makeCtx(meta, {
      pi: { sendUserMessage: (msg) => { woken.push(msg); } },
    });
    const result = await applyVerifyFail(
      ctx as never,
      ctx.currentMeta,
      "design-review",
      {
        structuredResult: { failures: [{ ruleType: DESIGN_REVIEW_REPORT_RULE_TYPE, detail: "missing **round** identity field" }] },
        ruleMissing: [],
        verifyResult: null,
      },
      "rule",
      createPipelineUI(configWithBudget(3)),
      configWithBudget(3),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain(TEMPLATE_MARKER);
    expect(woken.length).toBe(1);
    expect(woken[0]).toContain(TEMPLATE_MARKER);
    expect(woken[0]).toContain(`**round**: 1`);
    expect(ctx.currentMeta.verifyAttempts).toBe(1);
    expect(ctx.currentMeta.flowState).toBeUndefined();
  });

  it("a throwing wake channel does not replace the failure result", async () => {
    const meta = reviewMeta();
    const ctx = makeCtx(meta, {
      pi: {
        sendUserMessage: () => {
          throw new Error("channel closed");
        },
      },
    });
    const result = await applyVerifyFail(
      ctx as never,
      ctx.currentMeta,
      "design-review",
      {
        structuredResult: { failures: [{ ruleType: DESIGN_REVIEW_REPORT_RULE_TYPE, detail: "nope" }] },
        ruleMissing: [],
        verifyResult: null,
      },
      "rule",
      undefined,
      configWithBudget(3),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain(TEMPLATE_MARKER);
  });

  it("rule method with NO pi channel still shows the guidance", async () => {
    const meta = reviewMeta();
    const ctx = makeCtx(meta);
    const result = await applyVerifyFail(
      ctx as never,
      ctx.currentMeta,
      "design-review",
      {
        structuredResult: { failures: [{ ruleType: DESIGN_REVIEW_REPORT_RULE_TYPE, detail: "nope" }] },
        ruleMissing: [],
        verifyResult: null,
      },
      "rule",
      undefined,
      configWithBudget(3),
    );
    expect(result.success).toBe(false);
    expect(ctx.notifications.some((n) => n.includes(TEMPLATE_MARKER))).toBe(true);
  });

  it("budget overflow freezes, returns the template and NEVER wakes", async () => {
    const woken: string[] = [];
    const meta = reviewMeta({ verifyAttempts: 2 });
    const ctx = makeCtx(meta, {
      pi: { sendUserMessage: (msg) => { woken.push(msg); } },
    });
    const result = await applyVerifyFail(
      ctx as never,
      ctx.currentMeta,
      "design-review",
      {
        structuredResult: { failures: [{ ruleType: DESIGN_REVIEW_REPORT_RULE_TYPE, detail: "nope" }] },
        ruleMissing: [],
        verifyResult: null,
      },
      "rule",
      undefined,
      configWithBudget(3),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("pipeline frozen");
    expect(result.message).toContain(TEMPLATE_MARKER);
    expect(woken.length).toBe(0);
    expect(ctx.currentMeta.verifyAttempts).toBe(3);
  });

  it("ordinary (non-report) failures keep the existing generic text", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = makeCtx(meta);
    const result = await applyVerifyFail(
      ctx as never,
      ctx.currentMeta,
      "develop",
      {
        structuredResult: { failures: [{ ruleType: "keywords", detail: "Missing keywords: DONE" }] },
        ruleMissing: ["DONE"],
        verifyResult: null,
      },
      "rule",
      undefined,
      configWithBudget(3),
    );
    expect(result.success).toBe(false);
    expect(result.message).not.toContain(TEMPLATE_MARKER);
    expect(result.message).toContain("SKILL output format requirements");
  });

  it("report feedback is written to the audit trail (stage=report_contract)", async () => {
    const meta = reviewMeta();
    const ctx = makeCtx(meta);
    await applyVerifyFail(
      ctx as never,
      ctx.currentMeta,
      "design-review",
      {
        structuredResult: { failures: [{ ruleType: DESIGN_REVIEW_REPORT_RULE_TYPE, detail: "audit me" }] },
        ruleMissing: [],
        verifyResult: null,
      },
      "rule",
      undefined,
      configWithBudget(3),
    );
    const logPath = path.join(projectRoot, ".pi", "audit", getDateAuditFileName());
    const content = fs.readFileSync(logPath, "utf-8");
    expect(content).toContain("design_review_report_feedback");
    expect(content).toContain("report_contract");
  });
});

describe("193 Phase 0: consumeDesignReviewResult is honest and counts once", () => {
  const failResult: CoordinatorResult = {
    status: "handled",
    action: "verify_failed",
    failures: [reportFailure("Issues section has no content")],
  };

  it("not-applicable is never handled (ordinary flow continues)", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = makeCtx(meta);
    const outcome = await consumeDesignReviewResult({
      result: { status: "not-applicable" },
      meta,
      entry: "tool",
      ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi },
      config: configWithBudget(3),
    });
    expect(outcome.handled).toBe(false);
    expect(outcome.toolResult).toBeUndefined();
    expect(ctx.currentMeta.verifyAttempts).toBeUndefined();
  });

  it("tool entry records exactly ONE budget and never reports success", async () => {
    const meta = reviewMeta();
    const ctx = makeCtx(meta);
    const outcome = await consumeDesignReviewResult({
      result: failResult,
      meta: ctx.currentMeta,
      entry: "tool",
      ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi },
      config: configWithBudget(3),
      runtimeCtx: ctx,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.failureRecorded).toBe(true);
    expect(outcome.toolResult).toBeDefined();
    expect(outcome.toolResult!.success).toBe(false);
    expect(outcome.toolResult!.passed).toBe(false);
    expect(outcome.toolResult!.action).toBe("verify_failed");
    expect(outcome.toolResult!.message).toContain(TEMPLATE_MARKER);
    expect(ctx.currentMeta.verifyAttempts).toBe(1);
    // tool entries show the guidance proactively (they never wake the model)
    expect(ctx.notifications.some((n) => n.includes(TEMPLATE_MARKER))).toBe(true);
  });

  it("hook entry consumes with method=rule and returns no toolResult", async () => {
    const woken: string[] = [];
    const meta = reviewMeta();
    const ctx = makeCtx(meta, { pi: { sendUserMessage: (m) => { woken.push(m); } } });
    const outcome = await consumeDesignReviewResult({
      result: failResult,
      meta: ctx.currentMeta,
      entry: "hook",
      ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi },
      config: configWithBudget(3),
      runtimeCtx: ctx,
    });
    expect(outcome.toolResult).toBeUndefined();
    expect(woken.length).toBe(1);
    expect(ctx.currentMeta.verifyAttempts).toBe(1);
    // the hook does not double-notify what it already woke the model with
    expect(ctx.notifications.filter((n) => n.includes(TEMPLATE_MARKER)).length).toBe(0);
  });

  it("a child session defers to its owner with ZERO budget", async () => {
    const meta = reviewMeta();
    const ctx = makeCtx(meta);
    const childRuntime = {
      _ctx: {
        sessionManager: {
          getHeader: () => ({ parentSession: "/tmp/owner.jsonl" }),
          getSessionName: () => "design-review-agent#a1b2c3d4",
        },
      },
    };
    const outcome = await consumeDesignReviewResult({
      result: failResult,
      meta: ctx.currentMeta,
      entry: "tool",
      ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi },
      config: configWithBudget(3),
      runtimeCtx: childRuntime,
    });
    expect(outcome.deferredToOwner).toBe(true);
    expect(outcome.failureRecorded).toBe(false);
    expect(outcome.toolResult!.action).toBe("pending");
    expect(outcome.toolResult!.success).toBe(false);
    expect(ctx.currentMeta.verifyAttempts).toBeUndefined();
    expect(ctx.notifications.length).toBe(0);
  });

  it("verify_failed outside a running phase records no budget", async () => {
    const meta = reviewMeta({ designReview: { ...createInitialState(planDoc, "menu", planHash, "/tmp/o.jsonl", { pipelineId: PIPELINE_ID }), phase: "paused" } });
    const ctx = makeCtx(meta);
    const outcome = await consumeDesignReviewResult({
      result: failResult,
      meta: ctx.currentMeta,
      entry: "tool",
      ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi },
      config: configWithBudget(3),
      runtimeCtx: ctx,
    });
    expect(outcome.failureRecorded).toBe(false);
    expect(outcome.toolResult!.success).toBe(false);
    expect(outcome.toolResult!.message).toContain("outside a running phase");
    expect(ctx.currentMeta.verifyAttempts).toBeUndefined();
  });

  it("only advanced/routed map to success (pending/frozen are honest)", async () => {
    const cases: Array<[string, boolean]> = [
      ["advanced", true],
      ["routed", true],
      ["pending", false],
      ["frozen", false],
    ];
    for (const [action, success] of cases) {
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = makeCtx(meta);
      const result = (
        action === "advanced" || action === "routed"
          ? { status: "handled", action, toStage: "review" }
          : { status: "handled", action, reason: `${action} for test` }
      ) as CoordinatorResult;
      const outcome = await consumeDesignReviewResult({
        result,
        meta,
        entry: "tool",
        ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi },
        config: configWithBudget(3),
        runtimeCtx: ctx,
      });
      expect([action, outcome.toolResult?.success, outcome.toolResult?.passed]).toEqual([
        action,
        success,
        success,
      ]);
      if (success) expect(outcome.toolResult!.message).toContain("→ review");
    }
  });

  it("UPDATE-domain failures record budget but never render the report template", async () => {
    // update_running IS a running phase (budget applies), but the failure
    // belongs to the update deliverable domain → existing generic text only.
    const meta = updateMeta();
    const ctx = makeCtx(meta);
    const outcome: DesignReviewEntryOutcome = await consumeDesignReviewResult({
      result: {
        status: "handled",
        action: "verify_failed",
        failures: [{ ...reportFailure("update deliverable invalid"), ruleType: "designReviewUpdate" }],
      },
      meta: ctx.currentMeta,
      entry: "tool",
      ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi },
      config: configWithBudget(3),
      runtimeCtx: ctx,
    });
    expect(outcome.failureRecorded).toBe(true);
    expect(outcome.toolResult!.success).toBe(false);
    expect(outcome.toolResult!.message).not.toContain(TEMPLATE_MARKER);
    expect(outcome.toolResult!.message).toContain("SKILL output format requirements");
    expect(ctx.currentMeta.verifyAttempts).toBe(1);
  });
});
