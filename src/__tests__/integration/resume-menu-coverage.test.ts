/**
 * 213 Phase 4 — the per-state coverage table of `/pipeline-resume`
 * (`213_Bug.md` §六, 7 rows) and the five explicit 212→213 policy deviations
 * (plan §「对 212 锁定裁定的显式修正」) turned into executable assertions.
 *
 * Every row locks BOTH halves of the D2 verdict: "which menu the user
 * actually sees" (kind + FIRST item) and "nothing else happened" (meta writes
 * counted through the session's `metadataUpdates`, the three timer families
 * probed through the runtime's read-only probes). Rows where the design-review
 * domain is involved run against the REAL coordinator: pending-decision rows
 * ship a genuine plan + FAIL report on disk (the before-menu revalidation
 * re-hashes both), and `review_running` needs no files at all — the same
 * proven shapes as the P3 dispatch file.
 *
 * The 212 deviations are locked at their own boundaries:
 *  #1/#4 takeover exception is resume-channel-only (pure `evaluateTakeoverOffer`
 *      per channel + the command-level success trail);
 *  #2 `armedBySessionFile` survives a successful takeover byte-identical;
 *  #3 without an explicit takeover NOTHING is rewritten (decline ⇒ the domain
 *      state is byte-for-byte the pre-run snapshot);
 *  #5 the `not_owner` / `no_owner_evidence` / `not_settle` copies carry the
 *      takeover exit for NON-child callers and stay 212-VERBATIM for children
 *      (direct `formatDecisionWaitNotice` calls, byte equality).
 *
 * Cross-state rows follow ONLY the P3 dispatch order of THIS command
 * (1 no-meta → 2 design-review → 3 aborted → 4 confirm gate → 5 running →
 * 6 frozen); `/pipeline-start`'s different order is deliberately not cited.
 *
 * Spies: `mock.module` on `pipeline-start` counts `startNewPipeline` entries
 * and delegates to the REAL function always (the plan's "zero startNewPipeline
 * calls" locks are proven at the exact seam the command uses). The original
 * bindings are captured BEFORE mocking and reinstated in `afterAll`.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, jest, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import * as pipelineStartReal from "../../commands/pipeline-start";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { runningStatusMessage } from "../../commands/pipeline-resume-menu";
import {
  buildPendingHumanDecision,
  clearAllHumanDecisionMenus,
  HUMAN_DECISION_OPTIONS,
  HUMAN_DECISION_TITLE,
} from "../../core/design-review/human-decision";
import {
  evaluateTakeoverOffer,
  OWNER_TAKEOVER_CANCEL_OPTION,
  OWNER_TAKEOVER_CONFIRM_OPTION,
} from "../../core/design-review/owner-takeover";
import { formatDecisionWaitNotice } from "../../core/design-review/decision-reprompt";
import { createInitialState, computeHash, deriveReportPath } from "../../core/design-review/state";
import {
  __hasDecisionDeadline,
  __hasDecisionTimer,
  __hasStageWatchdog,
  clearAllDecisionTimers,
} from "../../core/decision-menu-runtime";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { __setSafeWriteAuditLogOverride, initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import type { DesignReviewState, SessionMeta } from "../../types";

// ─── pipeline-start spy (see header) ─────────────────────────────────────────

const REAL_START_NEW_PIPELINE = pipelineStartReal.startNewPipeline;

let startNewPipelineCalls = 0;

mock.module("../../commands/pipeline-start", () => ({
  ...pipelineStartReal,
  startNewPipeline: (
    ...args: Parameters<typeof REAL_START_NEW_PIPELINE>
  ): ReturnType<typeof REAL_START_NEW_PIPELINE> => {
    startNewPipelineCalls++;
    return REAL_START_NEW_PIPELINE(...args);
  },
}));

afterAll(() => {
  mock.module("../../commands/pipeline-start", () => ({
    ...pipelineStartReal,
    startNewPipeline: REAL_START_NEW_PIPELINE,
  }));
});

// ─── shared recording harness ────────────────────────────────────────────────

interface AuditRec {
  event: string;
  message: Record<string, unknown>;
}

interface MenuCall {
  title: string;
  options: string[];
}

let audits: AuditRec[] = [];
let pidCounter = 0;

function nextPipe(tag: string): string {
  pidCounter++;
  return `pipe-213cov-${tag}-${pidCounter}`;
}

beforeEach(() => {
  audits = [];
  startNewPipelineCalls = 0;
  __resetMemoryThrottle();
  __setSafeWriteAuditLogOverride(async (event, message) => {
    audits.push({ event, message: (message ?? {}) as Record<string, unknown> });
  });
});

afterEach(() => {
  jest.useRealTimers();
  __setSafeWriteAuditLogOverride(null);
  clearAllDecisionTimers();
  clearAllHumanDecisionMenus();
});

/**
 * Command context with a recording select. `answers` = queue (undefined when
 * exhausted = Esc); `router` routes by title (takeover vs decision dialogs);
 * `slowEsc` = the 208 test-7 recipe (advance past the interrupt threshold so
 * an undefined answer reads as an explicit user Esc, not a streaming crash).
 */
function makeCovCtx(
  meta: SessionMeta,
  opts?: {
    sessionFile?: string;
    answers?: Array<string | undefined>;
    router?: (title: string, options: string[]) => string | undefined;
    slowEsc?: boolean;
  },
) {
  const ctx = createMockCtx(meta, opts?.sessionFile !== undefined ? { sessionFile: opts.sessionFile } : undefined);
  const calls: MenuCall[] = [];
  let idx = 0;
  ctx.ui.select = async (title: string, options: string[]) => {
    calls.push({ title, options: [...options] });
    if (opts?.slowEsc) {
      jest.advanceTimersByTime(1600);
      return undefined;
    }
    if (opts?.router) return opts.router(title, [...options]);
    const ans = opts?.answers !== undefined && idx < opts.answers.length ? opts.answers[idx] : undefined;
    idx++;
    return ans;
  };
  const notifications: string[] = [];
  ctx.ui.notify = (msg: string) => {
    notifications.push(msg);
  };
  return { ctx, calls, notifications };
}

async function runResume(config: ReturnType<typeof makeTestConfig>, ctx: ReturnType<typeof createMockCtx>): Promise<Record<string, unknown>> {
  const cmd = createPipelineResumeCommand(config);
  return (await cmd.execute({}, ctx as never)) as Record<string, unknown>;
}

function actions(event: string): unknown[] {
  return audits.filter((a) => a.event === event).map((a) => a.message.action);
}

/** Zero-timer probe over the THREE families for one pipeline id. */
function assertNoTimers(pipelineId: string): void {
  expect(__hasDecisionTimer(pipelineId)).toBe(false);
  expect(__hasDecisionDeadline(pipelineId)).toBe(false);
  expect(__hasStageWatchdog(pipelineId)).toBe(false);
}

// ─── the REAL pending-decision fixture (presentable: files bind the hashes) ──

/** The report shape the shared verification engine parses (same binding
 *  lines as the 212/213 coordinator fixtures). */
function covReport(o: {
  pipelineId: string;
  planDoc: string;
  operationId: string;
  inputHash: string;
}): string {
  return [
    "# Design Review Report",
    "",
    `**pipeline**: ${o.pipelineId}`,
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
    "**Design Review: FAIL**",
    "",
    "## Issues",
    "",
    "1. Missing rollback plan for the migration phase",
    "",
  ].join("\n");
}

interface CovFixture {
  root: string;
  meta: SessionMeta;
  pipelineId: string;
  decisionId: string;
  ownerFile: string | undefined;
}

/**
 * A paused/decision-pending design-review domain backed by REAL files so the
 * presenter's before-menu revalidation genuinely passes: plan doc, bound FAIL
 * report, operation ⇄ decision identity consistency.
 */
function makeDecisionFixture(tag: string, opts: {
  ownerSessionFile: string | undefined;
  lifecycle: "blocked" | "aborted" | "running";
}): CovFixture {
  const pipelineId = nextPipe(tag);
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-213-cov-"));
  fs.mkdirSync(path.join(root, "docs", "design"), { recursive: true });
  const planDoc = path.join(root, "docs", `213Cov_${tag}_plan.md`);
  fs.writeFileSync(planDoc, `# Plan for ${tag}\n\nLocked by the 213 coverage suite.\n`, "utf-8");
  const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
  const operationId = `op-${tag}-${pipelineId}`;
  const initial = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId });
  const reportDoc = deriveReportPath(planDoc, 1);
  fs.mkdirSync(path.dirname(reportDoc), { recursive: true });
  const reportContent = covReport({ pipelineId, planDoc, operationId, inputHash: planHash });
  fs.writeFileSync(reportDoc, reportContent, "utf-8");
  const reportHash = computeHash(reportContent);
  const owner = opts.ownerSessionFile;
  const decision = buildPendingHumanDecision({
    reviewIdentity: {
      pipelineId,
      planDoc,
      authorizationId: initial.authorizationId,
      round: 1,
      operationId,
      stageVisitId: 11,
    },
    reportDoc,
    reportHash,
    planHash,
    issues: [{ issueId: "i-1", text: "Missing rollback plan for the migration phase" }],
    mode: "manual",
    ...(owner !== undefined ? { ownerSessionFile: owner, armedBySessionFile: owner } : {}),
  });
  const drState: DesignReviewState = {
    ...initial,
    round: 1,
    phase: "paused",
    pauseReason: "decision-pending",
    reportDoc,
    operation: {
      operationId,
      kind: "review",
      stageVisitId: 11,
      attempt: 1,
      round: 1,
      dispatchState: "completed",
      agentId: `agent-${tag}`,
      inputHash: planHash,
      outputHash: reportHash,
      createdAt: 1_000,
      updatedAt: 1_050,
    },
    decision,
    updatedAt: 1100,
  };
  const meta = makeTestMeta({
    pipelineId,
    currentStage: "design-review",
    ...(opts.lifecycle === "aborted" ? { flowState: "aborted" as const, terminateReason: "session_quit" } : {}),
    ...(opts.lifecycle === "blocked" ? { flowState: "blocked" as const } : {}),
    designReview: drState,
  });
  return { root, meta, pipelineId, decisionId: decision.decisionId, ownerFile: owner };
}

// ─── identity-complete authorized loop WITHOUT files (review_running) ────────

function reviewRunningDr(tag: string): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: `/tmp/213-cov-${tag}-plan.md`,
    planHash: "ph-cov",
    round: 1,
    authorizationId: `auth-cov-${tag}`,
    authorizationSource: "menu",
    phase: "review_running",
    authorizedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  };
}

// ═══ the 7-row coverage table (213_Bug.md §六) ═══════════════════════════════

describe("213 P4 coverage row 1: no meta / no pipelineId ⇒ error hint, NO menu, zero side effects", () => {
  it("absent meta: exact error, zero dialogs, zero audits, zero writes", async () => {
    const meta = makeTestMeta({ pipelineId: nextPipe("r1") });
    const h = makeCovCtx(meta);
    (h.ctx.session as unknown as { getMeta: () => SessionMeta | undefined }).getMeta = () => undefined;
    const out = await runResume(makeTestConfig(), h.ctx);

    expect(out["error"]).toBe("No active pipeline. Run /pipeline-start <doc_file> to begin.");
    expect(h.calls.length).toBe(0);
    expect(audits.length).toBe(0);
    expect(h.ctx.metadataUpdates.length).toBe(0);
  });

  it("blank pipelineId: the same honest error, no menu opened", async () => {
    const meta = makeTestMeta({ pipelineId: "" });
    const h = makeCovCtx(meta);
    const out = await runResume(makeTestConfig(), h.ctx);

    expect(out["error"]).toContain("No active pipeline");
    expect(h.calls.length).toBe(0);
  });
});

describe("213 P4 coverage row 2: design-review identity incomplete ⇒ actionable rebuild menu", () => {
  /** Identity-INCOMPLETE (no authorizationId/planDoc) ⇒ classify blocked. */
  function blockedMeta(tag: string): SessionMeta {
    return makeTestMeta({
      currentStage: "design-review",
      pipelineId: nextPipe(tag),
      designReview: { schemaVersion: 1, round: 1, phase: "review_running" } as unknown as DesignReviewState,
    });
  }

  it("menuCapable: rebuild skeleton with the degraded default row + takeover audit + ZERO writes (Esc)", async () => {
    const meta = blockedMeta("r2");
    const pipe = meta.pipelineId;
    const snapshot = JSON.parse(JSON.stringify(meta));
    const h = makeCovCtx(meta); // Esc ⇒ cancel
    const out = await runResume(makeTestConfig(), h.ctx);

    // The 212 dead-end (notify + return) is gone: a menu really opens.
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.title).toContain('Design-review identity incomplete at "design-review"');
    // No readable requirement doc on this meta ⇒ the honest degraded default row.
    expect(h.calls[0]!.options[0]).toBe('Rebuild from "design-review" (no default document)');
    expect(h.calls[0]!.options[2]).toBe("Cancel");
    expect((out["message"] as string)).toContain("Resume cancelled");

    // The takeover audit stays and gains its menu fact; nothing else happens.
    const takeover = audits.find((a) => a.event === "design_review_blocked_takeover");
    expect(takeover?.message["reason"]).toBe("identity_incomplete");
    expect(takeover?.message["action"]).toBe("menu_presented");
    expect(audits.some((a) => a.event === "resume_skipped_no_menu")).toBe(false);

    // No side effects: zero writes, byte-identical meta, zero timers.
    expect(h.ctx.metadataUpdates.length).toBe(0);
    expect(h.ctx.session.getMeta()).toEqual(snapshot);
    assertNoTimers(pipe);
  });

  it("reverse: declared hasUI false ⇒ honest no-UI exit, no menu, branch named in the audit", async () => {
    const meta = blockedMeta("r2noui");
    const pipe = meta.pipelineId;
    const snapshot = JSON.parse(JSON.stringify(meta));
    const ctx = createMockCtx(meta);
    (ctx as { hasUI?: boolean }).hasUI = false;
    let selectUsed = false;
    ctx.ui.select = async () => {
      selectUsed = true;
      return undefined;
    };
    const out = await runResume(makeTestConfig(), ctx);

    expect((out["message"] as string)).toContain("No interactive UI");
    expect(selectUsed).toBe(false);
    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip?.message["reason"]).toBe("no_ui");
    expect(skip?.message["branch"]).toBe("identity-incomplete");
    expect(audits.find((a) => a.event === "design_review_blocked_takeover")?.message["action"]).toBeUndefined();
    expect(ctx.metadataUpdates.length).toBe(0);
    expect(ctx.session.getMeta()).toEqual(snapshot);
    assertNoTimers(pipe);
  });
});

describe("213 P4 coverage row 3: authorized + paused/decision-pending ⇒ the review decision menu (REAL coordinator)", () => {
  const OWNER = "/x/cov-owner-session.json";

  it("owner match: HUMAN_DECISION_TITLE with 'Revise Plan' first; Esc ⇒ exit sentence, zero writes, zero timers", async () => {
    const fx = makeDecisionFixture("r3a", { ownerSessionFile: OWNER, lifecycle: "blocked" });
    const snapshot = JSON.parse(JSON.stringify(fx.meta));
    const h = makeCovCtx(fx.meta, { sessionFile: OWNER });
    const out = await runResume(makeTestConfig(), h.ctx);

    try {
      expect(h.calls.length).toBe(1); // the decision menu ONLY (no second menu, D10)
      expect(h.calls[0]!.title).toBe(HUMAN_DECISION_TITLE);
      expect(h.calls[0]!.options).toEqual([...HUMAN_DECISION_OPTIONS]);
      expect(h.calls[0]!.options[0]).toBe("Revise Plan");
      const message = out["message"] as string;
      expect(message).toContain("Design-review recovery pending: decision_pending.");
      expect(message).toContain("Run /pipeline-resume again to take over this decision");
      expect(message).toContain("re-authorize this design-review round");
      expect(message).toContain("/pipeline-quit");
      expect(actions("design_review_coordinator")).toContain("decision_menu_cancelled");

      expect(h.ctx.metadataUpdates.length).toBe(0);
      expect(h.ctx.session.getMeta()).toEqual(snapshot);
      assertNoTimers(fx.pipelineId);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  // 213_Bug review (issue 4①): the D18 capability gate INSIDE the coordinator —
  // a declared `hasUI: false` must override the PRESENT select control. The
  // owner matches, the control exists, yet no menu may open; the skip audit
  // attributes the honest capability word (this was the migrated predicate's
  // zero-wiring-coverage gap).
  it("issue 4: owner match + declared hasUI:false WITH a present select ⇒ menu never opens, skip audit names the host declaration, zero writes", async () => {
    const fx = makeDecisionFixture("r3d18", { ownerSessionFile: OWNER, lifecycle: "blocked" });
    const snapshot = JSON.parse(JSON.stringify(fx.meta));
    const h = makeCovCtx(fx.meta, { sessionFile: OWNER });
    (h.ctx as { hasUI?: boolean }).hasUI = false; // declared false — select still present
    const out = await runResume(makeTestConfig(), h.ctx);

    try {
      // ZERO dialogs of ANY kind: the capability gate refuses before the menu.
      expect(h.calls.length).toBe(0);
      expect((out["message"] as string)).toContain("Design-review recovery pending: decision_pending.");

      const skipped = audits.filter((a) => a.message.action === "decision_menu_skipped");
      expect(skipped.length).toBe(1);
      expect(skipped[0]!.message).toMatchObject({
        reason: "no interactive ui declared by host",
        capability: "hasUI",
        decisionId: fx.decisionId,
      });
      // A refusal that never opened a menu never charges (D11) and writes nothing.
      expect((h.ctx.session.getMeta() as SessionMeta).designReviewDecisionReprompt).toBeUndefined();
      expect(h.ctx.metadataUpdates.length).toBe(0);
      expect(h.ctx.session.getMeta()).toEqual(snapshot);
      assertNoTimers(fx.pipelineId);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("the 212 incident shape: non-owner CONFIRMS the takeover ⇒ rebound snapshot presents ⇒ armedBySessionFile untouched, ONE takeover audit, ZERO decision_menu_skipped (deviations #1/#2/#4)", async () => {
    const GONE = "/x/cov-gone-session.json";
    const PARENT = "/x/cov-parent-session.json";
    const fx = makeDecisionFixture("r3b", { ownerSessionFile: GONE, lifecycle: "blocked" });
    const h = makeCovCtx(fx.meta, {
      sessionFile: PARENT,
      router: (title) => (title.includes("Owner takeover required") ? OWNER_TAKEOVER_CONFIRM_OPTION : undefined),
    });
    const out = await runResume(makeTestConfig(), h.ctx);

    try {
      // Confirmation FIRST, then the real decision menu on the rebound record.
      expect(h.calls.length).toBe(2);
      expect(h.calls[0]!.title).toContain("Owner takeover required");
      expect(h.calls[0]!.title).toContain(`Original owner: ${GONE}`);
      expect(h.calls[1]!.title).toBe(HUMAN_DECISION_TITLE);
      expect((out["message"] as string)).toContain("Design-review recovery pending: decision_pending.");

      // BOTH owner fields rebound to this session; the armed provenance NEVER
      // moves (deviation #2); decision identity survives.
      const dr = (h.ctx.session.getMeta() as SessionMeta).designReview!;
      expect(dr.ownerSessionFile).toBe(PARENT);
      expect(dr.decision!.ownerSessionFile).toBe(PARENT);
      expect(dr.decision!.armedBySessionFile).toBe(GONE);
      expect(dr.decision!.decisionId).toBe(fx.decisionId);
      expect(dr.decision!.state).toBe("pending");

      // Five-step audit honesty: exactly ONE takeover, NO contradictory skip
      // (deviation #1/#4 — the menu really opened).
      expect(actions("design_review_coordinator")).toContain("decision_owner_takeover");
      expect(audits.filter((a) => a.message.action === "decision_menu_skipped").length).toBe(0);
      // D11: the automatic presentation budget was never touched.
      expect((h.ctx.session.getMeta() as SessionMeta).designReviewDecisionReprompt).toBeUndefined();

      // The takeover commit is the ONLY write; no timers, no startNewPipeline.
      expect(h.ctx.metadataUpdates.length).toBe(1);
      assertNoTimers(fx.pipelineId);
      expect(startNewPipelineCalls).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("reverse (decline): confirming NO ⇒ only the confirmation asked, skip audit with the declined word, domain state byte-identical (deviation #3)", async () => {
    const GONE = "/x/cov-gone-session.json";
    const PARENT = "/x/cov-parent-session.json";
    const fx = makeDecisionFixture("r3c", { ownerSessionFile: GONE, lifecycle: "blocked" });
    const beforeJson = JSON.stringify(fx.meta.designReview);
    const h = makeCovCtx(fx.meta, {
      sessionFile: PARENT,
      router: (title) => (title.includes("Owner takeover required") ? OWNER_TAKEOVER_CANCEL_OPTION : undefined),
    });
    const out = await runResume(makeTestConfig(), h.ctx);

    try {
      expect(h.calls.length).toBe(1); // the decision menu NEVER pops on a decline
      expect(h.calls[0]!.title).toContain("Owner takeover required");
      expect((out["message"] as string)).toContain("decision_takeover_declined");

      const skipped = audits.filter((a) => a.message.action === "decision_menu_skipped");
      expect(skipped.length).toBe(1);
      expect(skipped[0]!.message["reason"]).toBe("decision_takeover_declined");
      expect(actions("design_review_coordinator")).not.toContain("decision_owner_takeover");

      // 存量 never rewritten without an EXPLICIT takeover: zero writes and the
      // domain state byte-for-byte identical (deviation #3).
      expect(h.ctx.metadataUpdates.length).toBe(0);
      expect(JSON.stringify((h.ctx.session.getMeta() as SessionMeta).designReview)).toBe(beforeJson);
      assertNoTimers(fx.pipelineId);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("deviation #1/#4 pure boundary: the offer exists on the resume channel ONLY — every automatic source keeps the 212 refusal", () => {
    const actor = { isChild: false, sessionFile: "/x/cov-parent.json" };
    const ownerFile = "/x/cov-gone.json";
    expect(evaluateTakeoverOffer({ interactionSource: "resume", actor, ownerFile, hasUI: true })).toEqual({ offer: true });
    for (const channel of ["auto", "tool", "startup", "advance"] as const) {
      expect(
        evaluateTakeoverOffer({
          interactionSource: channel as "resume" | undefined,
          actor,
          ownerFile,
          hasUI: true,
        }),
      ).toEqual({ offer: false, reason: "not_resume_channel" });
    }
    // The recorded owner is this session ⇒ nothing to take over (212 default
    // owner-only presentation stays the rule, the takeover the single exception).
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor, ownerFile: "/x/cov-parent.json", hasUI: true }),
    ).toEqual({ offer: false, reason: "owner_provable" });
  });
});

describe("213 P4 coverage row 4: authorized + review_running ⇒ running skeleton, FIRST row Continue (default), meta field-by-field unchanged (REAL coordinator)", () => {
  it("acceptance row 4 verbatim: skeleton menu with the exact default label and ZERO writes", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      pipelineId: nextPipe("r4"),
      designReview: reviewRunningDr("r4"),
    });
    const snapshot = JSON.parse(JSON.stringify(meta));
    const h = makeCovCtx(meta); // Esc ⇒ cancel
    const out = await runResume(makeTestConfig(), h.ctx);

    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.title).toContain('Pipeline is running at "design-review"');
    expect(h.calls[0]!.options[0]).toBe('Continue current stage "design-review" (default)');
    expect(h.calls[0]!.options[1]).toBe("Start a new pipeline at a chosen stage…");
    expect(h.calls[0]!.options[2]).toBe("Cancel");
    expect((out["message"] as string)).toContain("Resume cancelled");

    // The row-4 lock: NOTHING was written, the meta is identical FIELD BY FIELD.
    const fresh = h.ctx.session.getMeta() as SessionMeta;
    expect(h.ctx.metadataUpdates.length).toBe(0);
    expect(fresh).toEqual(snapshot);
    expect(fresh.pipelineId).toBe(meta.pipelineId);
    expect(fresh.currentStage).toBe("design-review");
    expect(fresh.designReview?.phase).toBe("review_running");
    expect(fresh.designReview?.updatedAt).toBe(meta.designReview?.updatedAt);
    // The honest pending reason was recorded by the coordinator itself.
    expect(audits.some((a) => a.event === "design_review_coordinator")).toBe(true);
    assertNoTimers(meta.pipelineId);
  });

  it("reverse: choosing 'new pipeline' opens the stage menu FIRST — a cancel there starts NOTHING (zero startNewPipeline entries, zero writes)", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      pipelineId: nextPipe("r4rev"),
      designReview: reviewRunningDr("r4rev"),
    });
    const snapshot = JSON.parse(JSON.stringify(meta));
    const h = makeCovCtx(meta, {
      router: (title) => (title.includes("choose an action") ? "Start a new pipeline at a chosen stage…" : undefined),
    });
    const out = await runResume(makeTestConfig(), h.ctx);

    expect(h.calls.length).toBe(2);
    expect(h.calls[1]!.title).toBe("Start the new pipeline at which stage:");
    expect((out["message"] as string)).toBe("Resume cancelled. Nothing was started.");
    expect(startNewPipelineCalls).toBe(0);
    expect(h.ctx.metadataUpdates.length).toBe(0);
    expect(h.ctx.session.getMeta()).toEqual(snapshot);
    assertNoTimers(meta.pipelineId);
  });
});

describe("213 P4 coverage row 5: aborted ⇒ restore-default skeleton (no more /pipeline-start dead-end)", () => {
  function abortedMeta(tag: string): SessionMeta {
    return makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      pipelineId: nextPipe(tag),
      flowState: "aborted",
      terminateReason: "session_quit",
      requirementDoc: undefined,
    });
  }

  it("menu: 'Restore stage \"develop\" (no default document)' FIRST; Esc keeps every abort fact byte-identical (zero writes, zero timers)", async () => {
    const meta = abortedMeta("r5");
    const snapshot = JSON.parse(JSON.stringify(meta));
    const h = makeCovCtx(meta);
    const out = await runResume(makeTestConfig(), h.ctx);

    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.title).toContain('Pipeline aborted at "develop"');
    // 213 review (issue 6): the aborted diagnostic fact stays user-visible in
    // the skeleton title (pre-213 sentence carried `(<terminateReason>)`).
    expect(h.calls[0]!.title).toContain("(session_quit)");
    expect(h.calls[0]!.options[0]).toBe('Restore stage "develop" (no default document)');
    expect((out["message"] as string)).toContain("Resume cancelled");
    expect((h.ctx.session.getMeta() as SessionMeta).terminateReason).toBe("session_quit");
    expect(h.ctx.metadataUpdates.length).toBe(0);
    expect(h.ctx.session.getMeta()).toEqual(snapshot);
    assertNoTimers(meta.pipelineId);
    expect(startNewPipelineCalls).toBe(0);
  });

  it("restore selection: pipelineId + stage kept, terminateReason cleared, ONE pipeline_resumed(reason=resume_menu_restore) audit, zero startNewPipeline", async () => {
    const TMP = path.join(tmpdir(), `pi-resume-213-restore-${Date.now()}-${pidCounter}`);
    fs.mkdirSync(path.join(TMP, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = abortedMeta("r5b");
    const h = makeCovCtx(meta, {
      router: (title, options) => (title.startsWith('Pipeline aborted at "develop"') ? options[0] : undefined),
    });
    const out = await runResume(config, h.ctx);

    const fresh = h.ctx.session.getMeta() as SessionMeta;
    expect((out["message"] as string)).toContain('Pipeline resumed at stage "develop"');
    // The restore keeps the RUN: same pipelineId, same stage, abort facts cleared.
    expect(fresh.pipelineId).toBe(meta.pipelineId);
    expect(fresh.currentStage).toBe("develop");
    expect(fresh.terminateReason).toBeUndefined();
    expect(fresh.terminated).toBeUndefined();
    // Exactly the single resume write; the destructive branch was never entered.
    expect(h.ctx.metadataUpdates.length).toBe(1);
    expect(startNewPipelineCalls).toBe(0);

    // safeWriteStageAudit bypasses the override and lands in the audit file.
    const auditContent = await fs.promises.readFile(
      auditLogFileFor(path.join(TMP, ".pi", "audit"), meta.pipelineId),
      "utf-8",
    );
    expect(auditContent).toContain("pipeline_resumed");
    expect(auditContent).toContain("resume_menu_restore");

    await fs.promises.rm(TMP, { recursive: true, force: true });
  });
});

describe("213 P4 coverage row 6: running (non-frozen) ⇒ actionable skeleton, not the read-only notice", () => {
  it("continue-current is the byte-identical pre-213 status sentence with ZERO writes / spawns / timers", async () => {
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: nextPipe("r6") });
    const snapshot = JSON.parse(JSON.stringify(meta));
    const h = makeCovCtx(meta, {
      router: (title, options) => (title.includes("choose an action") ? options[0] : undefined),
    });
    const out = await runResume(makeTestConfig(), h.ctx);

    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.title).toContain('Pipeline is running at "develop"');
    expect(h.calls[0]!.options[0]).toBe('Continue current stage "develop" (default)');
    // D4: the message is EXACTLY the pre-213 read-only notice, and nothing else.
    const message = out["message"] as string;
    expect(message).toBe(runningStatusMessage(meta));
    expect(message).toContain("No resume needed.");
    expect(h.ctx.metadataUpdates.length).toBe(0);
    expect(h.ctx.session.getMeta()).toEqual(snapshot);
    assertNoTimers(meta.pipelineId);
    expect(startNewPipelineCalls).toBe(0);
  });

  it("reverse: declared hasUI false ⇒ noUiExit('running'), honest sentence + branch in the audit, zero writes", async () => {
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: nextPipe("r6noui") });
    const ctx = createMockCtx(meta);
    (ctx as { hasUI?: boolean }).hasUI = false;
    let selectUsed = false;
    ctx.ui.select = async () => {
      selectUsed = true;
      return undefined;
    };
    const out = await runResume(makeTestConfig(), ctx);

    expect((out["message"] as string)).toContain("No interactive UI");
    expect(selectUsed).toBe(false);
    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip?.message["branch"]).toBe("running");
    expect(ctx.metadataUpdates.length).toBe(0);
    assertNoTimers(meta.pipelineId);
  });
});

describe("213 P4 coverage row 7: frozen awaiting_human ⇒ the GENERIC requestDecision menu, untouched by 213", () => {
  it("generic 6-item menu with NO new-by-stage item; slow Esc ⇒ zero writes, no retry timer, takeover/wording never advertised", async () => {
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      previousStage: "develop",
      pipelineId: nextPipe("r7"),
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const snapshot = JSON.parse(JSON.stringify(meta));
    jest.useFakeTimers();
    const h = makeCovCtx(meta, { slowEsc: true });
    const out = await runResume(makeTestConfig(), h.ctx);

    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.title).toBe("Pipeline blocked: loop_overflow. Choose an action:");
    // The frozen channel keeps its OWN menu (208 attribution untouched)…
    expect(h.calls[0]!.options).toEqual(["Resume", "Skip", "Rollback", "Restart & New", "Abort & Exit", "Choose stage…"]);
    // …and the 213 skeleton labels must NOT leak into it (D13: the command adds
    // no new-pipeline semantics item on this branch).
    expect(h.calls[0]!.options.some((o) => o.includes("Start a new pipeline"))).toBe(false);
    expect(h.calls[0]!.options.some((o) => o.includes("Restore stage"))).toBe(false);
    expect((out["message"] as string)).toContain("Pipeline remains frozen");

    expect(actions("design_review_coordinator")).not.toContain("decision_owner_takeover");
    expect(audits.some((a) => a.event === "decision_menu_presented")).toBe(true);
    expect(audits.some((a) => a.event === "pipeline_decision_cancelled")).toBe(true);
    expect(audits.some((a) => a.event === "resume_skipped_no_menu")).toBe(false);

    // Esc is zero-write and leaves no retry clock behind.
    expect(h.ctx.metadataUpdates.length).toBe(0);
    expect(h.ctx.session.getMeta()).toEqual(snapshot);
    expect(__hasDecisionTimer(meta.pipelineId)).toBe(false);
    expect(startNewPipelineCalls).toBe(0);
  });
});

// ═══ cross-state cases — decided ONLY by the P3 dispatch order of THIS command ═══

describe("213 P4 cross-state: dispatch precedence (steps 2 > 3 > 5, frozen last)", () => {
  const OWNER = "/x/cov-x-owner.json";

  it("aborted + decision-pending + valid authorization ⇒ the review decision menu (step 2 beats step 3), NO aborted skeleton", async () => {
    const fx = makeDecisionFixture("x1", { ownerSessionFile: OWNER, lifecycle: "aborted" });
    const snapshot = JSON.parse(JSON.stringify(fx.meta));
    const h = makeCovCtx(fx.meta, { sessionFile: OWNER });
    const out = await runResume(makeTestConfig(), h.ctx);

    try {
      expect(h.calls.length).toBe(1);
      expect(h.calls[0]!.title).toBe(HUMAN_DECISION_TITLE);
      expect(h.calls.some((c) => c.title.includes("Pipeline aborted at"))).toBe(false);
      expect((out["message"] as string)).toContain("Design-review recovery pending");
      expect(h.ctx.metadataUpdates.length).toBe(0);
      expect(h.ctx.session.getMeta()).toEqual(snapshot);
      assertNoTimers(fx.pipelineId);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  // 213_Bug review (issue 2): a non-RESUMABLE stage's aborted skeleton now
  // LEADS with the new-build itself — no lying "Restore" row. Upgraded from the
  // former "Esc ⇒ cancel only" version (which had frozen the mismatch in).
  it("aborted + awaiting_human (non-RESUMABLE): first row IS the new build (never 'Restore'); choosing it pops the stage menu; cancel ⇒ zero writes", async () => {
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      previousStage: "develop",
      pipelineId: nextPipe("x2"),
      flowState: "aborted",
      terminateReason: "user_quit",
    });
    const snapshot = JSON.parse(JSON.stringify(meta));
    const h = makeCovCtx(meta, {
      // skeleton default row (the new-build) → Esc at the stage menu ⇒ cancel.
      router: (title, options) => (title.includes("Pipeline aborted at") ? options[0] : undefined),
    });
    const out = await runResume(makeTestConfig(), h.ctx);

    // The skeleton is honest BY CONSTRUCTION (issue 2): row 0 recreates, no restore row.
    expect(h.calls.length).toBe(2);
    expect(h.calls[0]!.title).toContain('Pipeline aborted at "awaiting_human"');
    // Issue 6: the aborted facts live in the title (pre-213 diagnostics kept).
    expect(h.calls[0]!.title).toContain("(user_quit)");
    expect(h.calls[0]!.title).toContain("cannot be restored in place");
    expect(h.calls[0]!.options[0]).toBe("Start a new pipeline at a chosen stage… (default)");
    expect(h.calls[0]!.options.some((o) => o.startsWith("Restore stage"))).toBe(false);
    // First-row semantics = NEW BUILD: the stage menu opens (second dialog)…
    expect(h.calls[1]!.title).toBe("Start the new pipeline at which stage:");
    // …and cancelling there starts nothing, writes nothing.
    expect((out["message"] as string)).toContain("Nothing was started");
    expect(h.ctx.metadataUpdates.length).toBe(0);
    expect(h.ctx.session.getMeta()).toEqual(snapshot);
    expect(h.calls.some((c) => c.title.includes("Pipeline blocked:"))).toBe(false);
    assertNoTimers(meta.pipelineId);
  });

  it("running + paused/decision-pending (valid authorization) ⇒ the review decision menu (step 2 beats step 5), NO running skeleton", async () => {
    const fx = makeDecisionFixture("x3", { ownerSessionFile: OWNER, lifecycle: "running" });
    const snapshot = JSON.parse(JSON.stringify(fx.meta));
    const h = makeCovCtx(fx.meta, { sessionFile: OWNER });
    const out = await runResume(makeTestConfig(), h.ctx);

    try {
      expect(h.calls.length).toBe(1);
      expect(h.calls[0]!.title).toBe(HUMAN_DECISION_TITLE);
      expect(h.calls.some((c) => c.title.includes("Pipeline is running at"))).toBe(false);
      expect((out["message"] as string)).toContain("Design-review recovery pending");
      expect(h.ctx.metadataUpdates.length).toBe(0);
      expect(h.ctx.session.getMeta()).toEqual(snapshot);
      assertNoTimers(fx.pipelineId);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// ═══ deviation #5: the copy locks (non-child carries the takeover exit; child verbatim) ═══

describe("213 P4 deviation #5: wait-notice copies — one honest exit more for NON-child callers, 212 VERBATIM for children", () => {
  const report = "docs/design/213Cov_report.md";
  const base =
    `Design review FAILED and awaits a human plan-revision decision (report: ${report}).`;

  it("not_owner: the child keeps the 212 legacy sentence byte-for-byte; the non-child keeps it too AND gains the takeover exit", () => {
    const child = formatDecisionWaitNotice(report, "not_owner", { ownerEvidenceMissing: false, hasSelect: true, isChild: true });
    const legacy =
      `${base} Owner evidence is recorded but this session cannot prove it — ` +
      `run /pipeline-resume in the recorded owner session; if that session no ` +
      `longer exists, re-authorize this design-review round or use /pipeline-quit.`;
    expect(child).toBe(legacy); // verbatim, nothing appended
    expect(child).not.toContain("take over");

    const owner = formatDecisionWaitNotice(report, "not_owner", { ownerEvidenceMissing: false, hasSelect: true, isChild: false });
    expect(owner).toBe(`${legacy} Or run /pipeline-resume here to take over this decision (explicit confirmation, audited).`);
  });

  it("no_owner_evidence: the child keeps the 212 'neither the automatic menu nor /pipeline-resume' sentence; the non-child gains the takeover exit", () => {
    const child = formatDecisionWaitNotice(report, "no_owner_evidence", { ownerEvidenceMissing: true, hasSelect: true, isChild: true });
    expect(child).toBe(
      `${base} Owner evidence is missing — neither the automatic menu nor ` +
      `/pipeline-resume can answer this decision. ` +
      `Re-authorize this design-review round or use /pipeline-quit.`,
    );
    expect(child).not.toContain("take over");

    const owner = formatDecisionWaitNotice(report, "no_owner_evidence", { ownerEvidenceMissing: true, hasSelect: true, isChild: false });
    expect(owner).toContain("run /pipeline-resume to take over the decision (explicit confirmation, audited)");
    expect(owner).toContain("re-authorize this design-review round");
  });

  it("not_settle (the 213 incident defect): the child keeps the bare 212 hint; the non-child hint honestly flags the possible takeover gate", () => {
    const child = formatDecisionWaitNotice(report, "not_settle", { ownerEvidenceMissing: false, hasSelect: true, isChild: true });
    expect(child).toBe(`${base} Use /pipeline-resume to present the decision menu.`);

    const owner = formatDecisionWaitNotice(report, "not_settle", { ownerEvidenceMissing: false, hasSelect: true, isChild: false });
    expect(owner).toContain("(you may be asked to take over this decision first)");
  });
});
