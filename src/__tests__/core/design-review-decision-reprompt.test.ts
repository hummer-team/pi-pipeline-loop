/**
 * 212 Phase 1 (Unit Tests Core): the one-shot AUTO presentation budget for a
 * pending design-review decision.
 *
 * Locked semantics:
 * - `decideAutoReprompt` is a pure first-match chain: not_settle → disabled
 *   → already_presented → in_flight → no_select → no_owner_evidence (absent
 *   recorded owner, 212 review fix #1) / not_owner → presented;
 * - the budget is charged ONLY at the single presenter call site, immediately
 *   before `ui.select` (creation path and settle path share it);
 * - refusals that never opened a menu (in_flight / no_select / not_owner /
 *   no_owner_evidence / drift) NEVER write the stamp;
 * - `/pipeline-resume` never reads and never writes the budget;
 * - config `designReview.decisionAutoReprompt: "off"` disables automatic
 *   re-presentation (notify + resume only); default (absent) = "once";
 * - BOTH assembly points: loadJsonConfig → resolvePipelineConfig keeps the
 *   block, and unconfigured projects keep `"designReview" in config === false`;
 * - meta reset: new period CLEARS the stamp, continue-resume keeps it.
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
import { clearAllDecisionTimers } from "../../core/flow-state";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
} from "../../core/design-review/state";
import {
  beginHumanDecisionMenu,
  buildPendingHumanDecision,
  clearAllHumanDecisionMenus,
  endHumanDecisionMenu,
  HUMAN_DECISION_OPTIONS,
  HUMAN_DECISION_TITLE,
} from "../../core/design-review/human-decision";
import {
  decideAutoReprompt,
  formatDecisionWaitNotice,
  markDecisionRePresented,
  resolveDecisionAutoRepromptMode,
  wasDecisionRePresented,
  type DecideAutoRepromptInput,
} from "../../core/design-review/decision-reprompt";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import type { DesignReviewActorInput, HumanDecision } from "../../core/design-review/decision-types";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

function reasonOf(r: CoordinatorResult): string {
  return (r as { reason?: string }).reason ?? "";
}

const PIPE = "pipe-reprompt-001";
const OWNER = "/x/owner-session.json";
const CHILD = "/x/child-session.json";

// ─── pure decideAutoReprompt / budget helpers ────────────────────────────────

function pendingDecision(): HumanDecision {
  return buildPendingHumanDecision({
    reviewIdentity: {
      pipelineId: PIPE,
      planDoc: "docs/plan.md",
      authorizationId: "auth-1",
      round: 1,
      operationId: "op-1",
      stageVisitId: 1,
    },
    reportDoc: "docs/design/1_Feat_design_review_report.md",
    reportHash: "hash-report",
    planHash: "hash-plan",
    issues: [{ issueId: "i-1", text: "Missing rollback plan" }],
    mode: "manual",
    ownerSessionFile: OWNER,
  });
}

function baseInput(overrides: Partial<DecideAutoRepromptInput> = {}): DecideAutoRepromptInput {
  const decision = pendingDecision();
  return {
    config: makeTestConfig(),
    meta: makeTestMeta({ pipelineId: PIPE }),
    decision,
    trigger: "settle",
    interactionSource: undefined, // absent ⇒ treated as "auto"
    actor: { isChild: false, sessionFile: OWNER },
    ownerFile: OWNER,
    hasSelect: true,
    menuInFlight: false,
    ...overrides,
  };
}

describe("212 Phase 1: resolveDecisionAutoRepromptMode", () => {
  it("defaults to 'once' when unconfigured", () => {
    expect(resolveDecisionAutoRepromptMode(makeTestConfig())).toBe("once");
  });
  it("honors explicit 'once' and explicit 'off'", () => {
    expect(
      resolveDecisionAutoRepromptMode(makeTestConfig({ designReview: { decisionAutoReprompt: "once" } })),
    ).toBe("once");
    expect(
      resolveDecisionAutoRepromptMode(makeTestConfig({ designReview: { decisionAutoReprompt: "off" } })),
    ).toBe("off");
  });
});

describe("212 Phase 1: wasDecisionRePresented / markDecisionRePresented", () => {
  it("matches the decisionId exactly (a stale stamp for ANOTHER id never blocks)", () => {
    const meta = makeTestMeta({
      designReviewDecisionReprompt: { decisionId: "old-id", at: 1 },
    });
    expect(wasDecisionRePresented(meta, "old-id")).toBe(true);
    expect(wasDecisionRePresented(meta, "new-id")).toBe(false);
    expect(wasDecisionRePresented(makeTestMeta(), "any")).toBe(false);
  });

  it("marks via session.updateMeta with decisionId + timestamp", () => {
    let patch: Partial<SessionMeta> | undefined;
    const session = {
      updateMeta: (p: Partial<SessionMeta>) => {
        patch = p;
        return undefined;
      },
      getMeta: () => undefined,
    };
    markDecisionRePresented(session, "dec-42");
    expect(patch?.designReviewDecisionReprompt?.decisionId).toBe("dec-42");
    expect(patch?.designReviewDecisionReprompt!.at).toBeGreaterThan(0);
  });
});

describe("212 Phase 1: decideAutoReprompt first-match chain (all reasons)", () => {
  it("presents on a plain owner settle (interactionSource absent = auto)", () => {
    const d = decideAutoReprompt(baseInput());
    expect(d).toEqual({ reprompt: true, reason: "presented" });
  });

  it("rejects trigger != settle (advance / tool / startup)", () => {
    for (const trigger of ["advance", "tool", "startup", "notify"]) {
      expect(decideAutoReprompt(baseInput({ trigger }))).toEqual({
        reprompt: false,
        reason: "not_settle",
      });
    }
  });

  it("rejects non-auto interaction sources even on settle", () => {
    for (const source of ["tool", "startup"] as const) {
      expect(decideAutoReprompt(baseInput({ interactionSource: source }))).toEqual({
        reprompt: false,
        reason: "not_settle",
      });
    }
    // "resume" is handled by the coordinator BEFORE this chain; the chain
    // itself still refuses it (resume never goes through the auto entry).
    expect(decideAutoReprompt(baseInput({ interactionSource: "resume" }))).toEqual({
      reprompt: false,
      reason: "not_settle",
    });
  });

  it("reports 'disabled' when the rollback switch is off", () => {
    const d = decideAutoReprompt(
      baseInput({ config: makeTestConfig({ designReview: { decisionAutoReprompt: "off" } }) }),
    );
    expect(d).toEqual({ reprompt: false, reason: "disabled" });
  });

  it("reports 'already_presented' only for the SAME decisionId", () => {
    const decision = pendingDecision();
    const stamped = makeTestMeta({
      designReviewDecisionReprompt: { decisionId: decision.decisionId, at: 5 },
    });
    expect(decideAutoReprompt(baseInput({ decision, meta: stamped }))).toEqual({
      reprompt: false,
      reason: "already_presented",
    });
    const otherStamp = makeTestMeta({
      designReviewDecisionReprompt: { decisionId: "someone-else", at: 5 },
    });
    expect(decideAutoReprompt(baseInput({ decision, meta: otherStamp }))).toEqual({
      reprompt: true,
      reason: "presented",
    });
  });

  it("reports 'in_flight' and NEVER consumes the budget", () => {
    const input = baseInput({ menuInFlight: true });
    expect(decideAutoReprompt(input)).toEqual({ reprompt: false, reason: "in_flight" });
    expect(input.meta.designReviewDecisionReprompt).toBeUndefined();
  });

  it("reports 'no_select' when the UI has no select control", () => {
    expect(decideAutoReprompt(baseInput({ hasSelect: false }))).toEqual({
      reprompt: false,
      reason: "no_select",
    });
  });

  it("reports 'not_owner' for child / absent / mismatched actor (never consumes)", () => {
    const actors: Array<DesignReviewActorInput | undefined> = [
      { isChild: true, sessionFile: CHILD, parentSessionFile: OWNER },
      undefined,
      { isChild: false, sessionFile: "/x/impostor.json" },
    ];
    for (const actor of actors) {
      const input = baseInput({ actor });
      expect(decideAutoReprompt(input)).toEqual({ reprompt: false, reason: "not_owner" });
      expect(input.meta.designReviewDecisionReprompt).toBeUndefined();
    }
  });

  it("reports 'no_owner_evidence' (NOT 'not_owner') when owner evidence is missing — 212 review fix #1", () => {
    // Absent recorded owner ⇒ unanswerable on EVERY channel (settle AND
    // resume share the 193 single authority). The distinct reason lets the
    // waiting notice state that fact instead of advertising /pipeline-resume.
    const noOwner = baseInput({ ownerFile: undefined });
    expect(decideAutoReprompt(noOwner)).toEqual({ reprompt: false, reason: "no_owner_evidence" });
    expect(noOwner.meta.designReviewDecisionReprompt).toBeUndefined();
    // a child actor in the SAME missing-evidence state reports the stronger
    // fact too (evidence absence outranks actor mismatch for the copy).
    const childNoOwner = baseInput({
      ownerFile: undefined,
      actor: { isChild: true, sessionFile: CHILD },
    });
    expect(decideAutoReprompt(childNoOwner)).toEqual({ reprompt: false, reason: "no_owner_evidence" });
  });

  it("channel check precedes config check (advance+off ⇒ not_settle, first match)", () => {
    const d = decideAutoReprompt(
      baseInput({
        trigger: "advance",
        config: makeTestConfig({ designReview: { decisionAutoReprompt: "off" } }),
      }),
    );
    expect(d.reason).toBe("not_settle");
  });
});

describe("212 Phase 1: formatDecisionWaitNotice copy", () => {
  it("already_presented states the once-promise and resume", () => {
    const copy = formatDecisionWaitNotice("r.md", "already_presented");
    expect(copy).toContain("at most once");
    expect(copy).toContain("/pipeline-resume");
  });
  it("disabled states auto presentation is off and resume", () => {
    const copy = formatDecisionWaitNotice("r.md", "disabled");
    expect(copy).toContain("disabled");
    expect(copy).toContain("/pipeline-resume");
  });
  it("not_settle / not_owner WITH recorded evidence keep the neutral resume hint", () => {
    for (const reason of ["not_settle", "not_owner"] as const) {
      const copy = formatDecisionWaitNotice("r.md", reason, false);
      expect(copy).toContain("Use /pipeline-resume to present");
      expect(copy).not.toContain("at most once");
      expect(copy).not.toContain("Owner evidence is missing");
    }
  });
  it("in_flight states the open menu instead of promising a new one (212 round-2 review fix #1)", () => {
    const copy = formatDecisionWaitNotice("r.md", "in_flight", false);
    expect(copy).toContain("already open");
    expect(copy).toContain("answer it there");
    expect(copy).not.toContain("Use /pipeline-resume to present");
    expect(copy).not.toContain("at most once");
  });
  it("no_select states the missing-UI fact, resume is conditioned on an interactive owner session (212 round-2 review fix #1)", () => {
    const copy = formatDecisionWaitNotice("r.md", "no_select", false);
    expect(copy).toContain("no interactive UI");
    expect(copy).toContain("interactive owner session");
    expect(copy).not.toContain("Use /pipeline-resume to present");
    expect(copy).not.toContain("at most once");
  });
  it("no_owner_evidence mirrors the STATE face — never advertises /pipeline-resume (212 review fix #1)", () => {
    const copy = formatDecisionWaitNotice("r.md", "no_owner_evidence");
    // same facts as decision-display.ts's `ownerEvidence: missing` line:
    expect(copy).toContain("Owner evidence is missing");
    expect(copy).toContain("Re-authorize");
    expect(copy).toContain("/pipeline-quit");
    // the honest refusal: resume CANNOT present the menu in this state —
    // no promise of the path that the original 212 incident lacked.
    expect(copy).not.toContain("Use /pipeline-resume to present");
    expect(copy).not.toContain("re-opens it");
    expect(copy).not.toContain("at most once");
  });
  it("the owner-evidence FACT outranks EVERY refusal reason — same honest copy, zero resume promises (212 round-2 review fix #1)", () => {
    // not_settle / in_flight / no_select / not_owner / disabled /
    // already_presented all fall back to the no_owner_evidence wording when
    // evidence is missing: resume shares the single authority and cannot
    // answer there either, so promising it would repeat the 212 symptom.
    for (const reason of [
      "not_settle",
      "disabled",
      "already_presented",
      "in_flight",
      "no_select",
      "not_owner",
      "no_owner_evidence",
    ] as const) {
      const copy = formatDecisionWaitNotice("r.md", reason, true);
      expect(copy).toContain("Owner evidence is missing");
      expect(copy).toContain("Re-authorize");
      expect(copy).toContain("/pipeline-quit");
      expect(copy).not.toContain("Use /pipeline-resume");
      expect(copy).not.toContain("re-opens it");
      expect(copy).not.toContain("at most once");
    }
  });
});

// ─── coordinator-level one-shot flow ─────────────────────────────────────────

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

describe("212 Phase 1: coordinator-level one-shot auto re-presentation", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-reprompt-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "212_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" };
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "manual" },
    };
    // in-memory throttle is process-global — clear between tests so
    // notify/audit assertions are deterministic.
    __resetMemoryThrottle();
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
  interface MenuCall {
    title: string;
    options: readonly string[];
  }

  function makeHarness(): {
    session: ReturnType<typeof makeStrictSession>;
    mkCtx: (opts?: {
      actor?: DesignReviewActorInput;
      interactionSource?: "auto" | "tool" | "startup" | "resume";
      select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
    }) => CoordinatorContext;
    dispatchReview: (actor: DesignReviewActorInput) => Promise<{ reviewOpId: string; planHash: string }>;
    writeFailReport: (reviewOpId: string, planHash: string) => void;
    createPendingViaChild: () => Promise<string>;
    spawnLog: SpawnRec[];
    menuCalls: MenuCall[];
    notifications: string[];
  } {
    // Fresh initial state per harness: authorized design-review bound to the
    // OWNER session file (createInitialState keeps 193 single authority).
    const session = makeStrictSession(
      makeTestMeta({
        pipelineId: PIPE,
        currentStage: "design-review",
        designReview: createInitialState(
          planDoc,
          "menu",
          computeHash(fs.readFileSync(planDoc, "utf-8")),
          OWNER,
          { pipelineId: PIPE },
        ),
      }),
    );
    const spawnLog: SpawnRec[] = [];
    const menuCalls: MenuCall[] = [];
    const notifications: string[] = [];

    function mkCtx(opts?: {
      actor?: DesignReviewActorInput;
      interactionSource?: "auto" | "tool" | "startup" | "resume";
      select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
    }): CoordinatorContext {
      const ctx: CoordinatorContext = {
        config,
        session,
        ui: {
          notify: (m) => notifications.push(m),
          ...(opts?.select !== undefined ? { select: opts.select } : {}),
        },
        pi: { sendUserMessage: () => {} },
        ...(opts?.actor !== undefined ? { actor: opts.actor } : {}),
        ...(opts?.interactionSource !== undefined ? { interactionSource: opts.interactionSource } : {}),
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

    /** Create a child-bound pending decision (child settle, menu refused). */
    async function createPendingViaChild(): Promise<string> {
      const { reviewOpId, planHash } = await dispatchReview({ isChild: false, sessionFile: OWNER });
      writeFailReport(reviewOpId, planHash);
      const childCtx = mkCtx({
        actor: { isChild: true, sessionFile: CHILD, parentSessionFile: OWNER },
        // child windows have no UI capability — the real noOp select returns
        // undefined; a present select must still NEVER be reached for a child.
        select: async (title, options) => {
          menuCalls.push({ title, options });
          return undefined;
        },
      });
      const r = await coordinateDesignReview(childCtx, session.getMeta()!, "settle");
      expect(r.status === "handled" && r.action === "pending" && reasonOf(r) === "decision_pending").toBe(true);
      const decision = session.getMeta()!.designReview!.decision!;
      expect(decision.state).toBe("pending");
      // 212 Phase 0 binding + Phase 1 budget: child never opens the menu and
      // the never-shown creation must NOT charge the automatic budget.
      expect(menuCalls.length).toBe(0);
      expect(session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
      return decision.decisionId;
    }

    return { session, mkCtx, dispatchReview, writeFailReport, createPendingViaChild, spawnLog, menuCalls, notifications };
  }

  it("child creates pending (no menu, budget UNCHARGED) → owner settle presents exactly ONCE → Esc keeps pending → second settle never re-pops → resume re-pops without touching the stamp", async () => {
    const h = makeHarness();
    const decisionId = await h.createPendingViaChild();

    // 1st owner settle: the ONLY automatic re-presentation → menu opens once.
    const ownerEscCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return undefined; // Esc
      },
    });
    const r1 = await coordinateDesignReview(ownerEscCtx, h.session.getMeta()!, "settle");
    expect(r1.status === "handled" && r1.action === "pending" && reasonOf(r1) === "decision_pending").toBe(true);
    expect(h.menuCalls.length).toBe(1);
    expect(h.menuCalls[0]!.title).toBe(HUMAN_DECISION_TITLE);
    expect([...h.menuCalls[0]!.options]).toEqual([...HUMAN_DECISION_OPTIONS]);
    // the stamp is now charged for THIS decisionId (menu actually opened)
    const stamp = h.session.getMeta()!.designReviewDecisionReprompt;
    expect(stamp?.decisionId).toBe(decisionId);
    expect(stamp!.at).toBeGreaterThan(0);
    // Esc semantics: pending stays, ZERO visits/RPC/handoff, no spawn growth
    expect(h.session.getMeta()!.designReview!.decision?.state).toBe("pending");
    expect(h.session.getMeta()!.currentStage).toBe("design-review");
    expect(h.spawnLog.map((s) => s.stage)).toEqual(["design-review"]);

    // 2nd owner settle: budget spent ⇒ NO menu, notify carries the once-promise.
    __resetMemoryThrottle(); // deterministic notify (5s window is process-global)
    const ownerCtx2 = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return undefined;
      },
    });
    const r2 = await coordinateDesignReview(ownerCtx2, h.session.getMeta()!, "settle");
    expect(r2.status === "handled" && r2.action === "pending" && reasonOf(r2) === "decision_pending").toBe(true);
    expect(h.menuCalls.length).toBe(1); // still the first menu only
    expect(h.notifications.some((n) => n.includes("at most once") && n.includes("/pipeline-resume"))).toBe(true);
    // the stamp is untouched (already_presented never re-arms anything)
    expect(h.session.getMeta()!.designReviewDecisionReprompt?.decisionId).toBe(decisionId);
    expect(h.session.getMeta()!.designReviewDecisionReprompt?.at).toBe(stamp!.at);

    // explicit resume: re-pops despite the spent budget, and NEVER re-stamps.
    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      interactionSource: "resume",
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return undefined;
      },
    });
    const r3 = await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(r3.status === "handled" && r3.action === "pending" && reasonOf(r3) === "decision_pending").toBe(true);
    expect(h.menuCalls.length).toBe(2); // resume re-opened the menu
    expect(h.session.getMeta()!.designReview!.decision?.state).toBe("pending");
    expect(h.session.getMeta()!.designReviewDecisionReprompt?.decisionId).toBe(decisionId);
    expect(h.session.getMeta()!.designReviewDecisionReprompt?.at).toBe(stamp!.at);
    expect(h.spawnLog.length).toBe(1); // still zero dispatch besides the review
  });

  it("creation path CHARGES: owner-created menu + Esc ⇒ the next settle never re-pops", async () => {
    const h = makeHarness();
    const { reviewOpId, planHash } = await h.dispatchReview({ isChild: false, sessionFile: OWNER });
    h.writeFailReport(reviewOpId, planHash);

    // owner settle creates the pending AND presents (one menu, charged there).
    const createCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return undefined; // Esc right away
      },
    });
    const r1 = await coordinateDesignReview(createCtx, h.session.getMeta()!, "settle");
    expect(r1.status === "handled" && r1.action === "pending").toBe(true);
    expect(h.menuCalls.length).toBe(1);
    const decisionId = h.session.getMeta()!.designReview!.decision!.decisionId;
    const stamp = h.session.getMeta()!.designReviewDecisionReprompt;
    expect(stamp?.decisionId).toBe(decisionId);

    // next ordinary settle: the creation already spent the budget.
    __resetMemoryThrottle();
    const nextCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return undefined;
      },
    });
    const r2 = await coordinateDesignReview(nextCtx, h.session.getMeta()!, "settle");
    expect(reasonOf(r2)).toBe("decision_pending");
    expect(h.menuCalls.length).toBe(1); // NO re-popup (existing 193 contract holds)
    expect(h.notifications.some((n) => n.includes("at most once"))).toBe(true);
  });

  it('rollback switch "off" ⇒ zero automatic menus; resume still works and never stamps', async () => {
    config.designReview = { decisionAutoReprompt: "off" };
    const h = makeHarness();
    await h.createPendingViaChild();

    // owner settle: disabled ⇒ no menu, no stamp, notify explains the switch.
    const ownerCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return undefined;
      },
    });
    const r1 = await coordinateDesignReview(ownerCtx, h.session.getMeta()!, "settle");
    expect(reasonOf(r1)).toBe("decision_pending");
    expect(h.menuCalls.length).toBe(0);
    expect(h.session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
    expect(h.notifications.some((n) => n.includes("disabled") && n.includes("/pipeline-resume"))).toBe(true);

    // resume: the manual channel is never blocked by the switch.
    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      interactionSource: "resume",
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return undefined;
      },
    });
    const r2 = await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(reasonOf(r2)).toBe("decision_pending");
    expect(h.menuCalls.length).toBe(1);
    // "off" mode + resume ⇒ the budget stays untouched (never read, never written)
    expect(h.session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
  });

  it("default (unconfigured) ⇒ the owner settle presents exactly once; Cancel keeps cleanliness", async () => {
    const h = makeHarness();
    await h.createPendingViaChild();
    const ownerCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return "Cancel";
      },
    });
    const r = await coordinateDesignReview(ownerCtx, h.session.getMeta()!, "settle");
    expect(reasonOf(r)).toBe("decision_pending");
    expect(h.menuCalls.length).toBe(1);
    // Cancel ⇒ pending, zero visit/handoff (cleanliness: existing semantics)
    expect(h.session.getMeta()!.designReview!.decision?.state).toBe("pending");
    expect(h.spawnLog.map((s) => s.stage)).toEqual(["design-review"]);
  });

  it("menu already in flight ⇒ settle reports in_flight and the stamp is NEVER written", async () => {
    const h = makeHarness();
    const decisionId = await h.createPendingViaChild();
    // simulate an open menu (single-flight held elsewhere) arriving settle.
    expect(beginHumanDecisionMenu(decisionId)).toBe(true);
    try {
      const ownerCtx = h.mkCtx({
        actor: { isChild: false, sessionFile: OWNER },
        select: async (title, options) => {
          h.menuCalls.push({ title, options });
          return undefined;
        },
      });
      const r = await coordinateDesignReview(ownerCtx, h.session.getMeta()!, "settle");
      expect(reasonOf(r)).toBe("decision_pending");
      expect(h.menuCalls.length).toBe(0);
      expect(h.session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
    } finally {
      endHumanDecisionMenu(decisionId);
    }
  });

  it("owner WITHOUT select ⇒ refusal never charges, budget untouched", async () => {
    const h = makeHarness();
    await h.createPendingViaChild();
    const ownerCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      // no select control at all
    });
    const r = await coordinateDesignReview(ownerCtx, h.session.getMeta()!, "settle");
    expect(reasonOf(r)).toBe("decision_pending");
    expect(h.menuCalls.length).toBe(0);
    expect(h.session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
  });

  it("non-owner actor (mismatched file) ⇒ not_owner refusal never charges", async () => {
    const h = makeHarness();
    await h.createPendingViaChild();
    const impostorCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: "/x/impostor.json" },
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return "Proceed to Develop";
      },
    });
    const r = await coordinateDesignReview(impostorCtx, h.session.getMeta()!, "settle");
    expect(reasonOf(r)).toBe("decision_pending");
    expect(h.menuCalls.length).toBe(0);
    expect(h.session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
    expect(h.session.getMeta()!.designReview!.decision?.state).toBe("pending");
  });

  it("advance trigger ⇒ not_settle even for a genuine owner with fresh budget", async () => {
    const h = makeHarness();
    await h.createPendingViaChild();
    const ownerCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: OWNER },
      select: async (title, options) => {
        h.menuCalls.push({ title, options });
        return undefined;
      },
    });
    const r = await coordinateDesignReview(ownerCtx, h.session.getMeta()!, "advance");
    expect(reasonOf(r)).toBe("decision_pending");
    expect(h.menuCalls.length).toBe(0);
    expect(h.session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
  });
});

// ─── config end-to-end (F13: BOTH assembly points must connect) ──────────────

describe("212 Phase 1: designReview block survives loadJsonConfig → resolvePipelineConfig", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-reprompt-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeJson(obj: unknown): string {
    const p = path.join(tmpRoot, "pipeline_loop.json");
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
    return p;
  }

  it('"off" survives the full JSON chain ⇒ config.designReview.decisionAutoReprompt === "off"', () => {
    const jsonPath = writeJson({
      stages: { clarify: { nextStage: "plan" } },
      designReview: { decisionAutoReprompt: "off" },
    });
    const json = loadJsonConfig(jsonPath);
    // assembly point 1 keeps the normalized block in the raw config ...
    expect(json.designReview).toEqual({ decisionAutoReprompt: "off" });
    // ... and assembly point 2 attaches it to the FINAL PipelineConfig.
    const config = resolvePipelineConfig(json);
    expect(config.designReview?.decisionAutoReprompt).toBe("off");
    // the coordinator-side resolver honors it without any extra wiring
    expect(resolveDecisionAutoRepromptMode(config)).toBe("off");
  });

  it("unconfigured ⇒ no designReview field on EITHER output (deep-equality shape stays)", () => {
    const jsonPath = writeJson({ stages: { clarify: { nextStage: "plan" } } });
    const json = loadJsonConfig(jsonPath);
    expect("designReview" in json).toBe(false);
    const config = resolvePipelineConfig(json);
    expect("designReview" in config).toBe(false);
    expect(resolveDecisionAutoRepromptMode(config)).toBe("once");
  });

  it('"once" is kept verbatim; invalid values warn and stay absent', () => {
    const onceJson = resolvePipelineConfig(
      loadJsonConfig(writeJson({
        stages: { clarify: {} },
        designReview: { decisionAutoReprompt: "once" },
      })),
    );
    expect(onceJson.designReview).toEqual({ decisionAutoReprompt: "once" });

    const badJson = resolvePipelineConfig(
      loadJsonConfig(writeJson({
        stages: { clarify: {} },
        designReview: { decisionAutoReprompt: "always" },
      })),
    );
    expect("designReview" in badJson).toBe(false);
  });

  it("resolvePipelineConfig also guards directly-constructed json (double insurance)", () => {
    const direct = resolvePipelineConfig({
      stages: { clarify: {} },
      designReview: { decisionAutoReprompt: "off" },
    });
    expect(direct.designReview).toEqual({ decisionAutoReprompt: "off" });
    const directBad = resolvePipelineConfig({
      stages: { clarify: {} },
      designReview: { decisionAutoReprompt: "yes" as unknown as "once" },
    });
    expect("designReview" in directBad).toBe(false);
  });
});
