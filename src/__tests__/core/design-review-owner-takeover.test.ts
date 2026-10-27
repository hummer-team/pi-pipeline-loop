/**
 * 213_Bug Phase 1 (Unit Tests Core): the explicit, audited owner takeover on
 * the resume channel.
 *
 * Locked semantics (plan P1):
 * - `evaluateTakeoverOffer` is a PURE verdict with an order-locked chain:
 *   channel → child → identity → capability → ownership (five refusal reasons);
 * - confirmation rides the SAME select control, echoes the original owner,
 *   and any non-affirmative answer is a refusal (fail closed);
 * - `commitOwnerTakeover` writes BOTH owner fields in ONE strict commit with
 *   CAS anchors (`stateUpdatedAt` + `decisionId` + `decisionState:"pending"`),
 *   never touches `armedBySessionFile`, and audits exactly one
 *   `decision_owner_takeover` on success (nothing on failure);
 * - the presenter's FIVE-STEP audit order: a successful takeover leaves NO
 *   `decision_menu_skipped`; a decline leaves `decision_takeover_declined`
 *   (audit AND result reason); a failed commit leaves
 *   `decision_takeover_commit_failed:<reason>` with zero state writes;
 * - settle / tool / startup / advance and child callers: byte-identical 212
 *   refusals (zero confirmations, zero writes);
 * - the automatic-presentation budget is NEVER touched by this channel (D11).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  coordinateDesignReview,
  type CoordinatorContext,
} from "../../core/design-review/coordinator";
import {
  commitOwnerTakeover,
  confirmOwnerTakeover,
  evaluateTakeoverOffer,
  OWNER_TAKEOVER_CANCEL_OPTION,
  OWNER_TAKEOVER_CONFIRM_OPTION,
} from "../../core/design-review/owner-takeover";
import { clearAllDecisionTimers } from "../../core/flow-state";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
} from "../../core/design-review/state";
import {
  buildPendingHumanDecision,
  clearAllHumanDecisionMenus,
  HUMAN_DECISION_OPTIONS,
  HUMAN_DECISION_TITLE,
} from "../../core/design-review/human-decision";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import type {
  DesignReviewActorInput,
  HumanDecision,
  HumanDecisionRecordBase,
} from "../../core/design-review/decision-types";
import type { DesignReviewState } from "../../types";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";

const PIPE = "pipe-213-tk";
const GONE = "/x/gone-child-session.json";
const PARENT = "/x/parent-session.json";
const S2 = "/x/third-session.json";

// ─── audit capture (same pattern as the 212 owner-evidence tests) ────────────

interface AuditRec {
  event: string;
  message: Record<string, unknown>;
  /** Captured severity (issue 5: control-failure audit must be ERROR-level). */
  level?: string;
}

interface AuditApi {
  records: AuditRec[];
  use(): void;
  reset(): void;
  findBy(action: string): AuditRec[];
  actions(): string[];
}

function makeAuditCapture(): AuditApi {
  const records: AuditRec[] = [];
  const api: AuditApi = {
    records,
    use() {
      records.length = 0;
      __setSafeWriteAuditLogOverride(async (event, message, level) => {
        records.push({ event, message: message as Record<string, unknown>, level });
      });
    },
    reset() {
      __setSafeWriteAuditLogOverride(null);
    },
    findBy(action: string) {
      return records.filter((r) => r.message?.action === action);
    },
    actions() {
      return records.map((r) => String(r.message?.action ?? ""));
    },
  };
  return api;
}

const audit = makeAuditCapture();

// ─── evaluateTakeoverOffer — pure verdict, order-locked ──────────────────────

describe("213 P1: evaluateTakeoverOffer verdicts (order: channel → child → identity → capability → ownership)", () => {
  const actor: DesignReviewActorInput = { isChild: false, sessionFile: PARENT };

  it("ONLY the resume channel may be offered (settle/tool/startup/auto/absent ⇒ not_resume_channel)", () => {
    for (const source of [undefined, "auto", "tool", "startup"] as const) {
      expect(
        evaluateTakeoverOffer({ interactionSource: source, actor, ownerFile: GONE, hasUI: true }),
      ).toEqual({ offer: false, reason: "not_resume_channel" });
    }
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor, ownerFile: GONE, hasUI: true }),
    ).toEqual({ offer: true });
  });

  it("a child is never offered — and the CHILD refusal outranks identity/capability gaps", () => {
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor: { isChild: true, sessionFile: GONE }, ownerFile: PARENT, hasUI: true }),
    ).toEqual({ offer: false, reason: "child_session" });
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor: { isChild: true }, ownerFile: PARENT, hasUI: false }),
    ).toEqual({ offer: false, reason: "child_session" });
  });

  it("absent or blank actor file ⇒ no_actor_identity (nothing bindable, and it outranks the capability check)", () => {
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor: undefined, ownerFile: GONE, hasUI: true }),
    ).toEqual({ offer: false, reason: "no_actor_identity" });
    for (const blank of [undefined, "", "   "]) {
      expect(
        evaluateTakeoverOffer({ interactionSource: "resume", actor: { isChild: false, sessionFile: blank }, ownerFile: GONE, hasUI: false }),
      ).toEqual({ offer: false, reason: "no_actor_identity" });
    }
  });

  it("no declared interactive UI ⇒ no_ui (a blank-file actor is still refused by identity FIRST)", () => {
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor, ownerFile: GONE, hasUI: false }),
    ).toEqual({ offer: false, reason: "no_ui" });
  });

  it("the recorded owner IS this session ⇒ owner_provable (the normal path already answers)", () => {
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor, ownerFile: PARENT, hasUI: true }),
    ).toEqual({ offer: false, reason: "owner_provable" });
  });

  it("D8: MISSING owner evidence is takeover-able too (offer even with ownerFile undefined)", () => {
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor, ownerFile: undefined, hasUI: true }),
    ).toEqual({ offer: true });
  });

  it("blank-padded recorded owner normalizes before comparison", () => {
    expect(
      evaluateTakeoverOffer({ interactionSource: "resume", actor: { isChild: false, sessionFile: ` ${PARENT} ` }, ownerFile: PARENT, hasUI: true }),
    ).toEqual({ offer: false, reason: "owner_provable" });
  });
});

// ─── confirmOwnerTakeover — SAME control, echoing copy, fail-closed ─────────

describe("213 P1: confirmOwnerTakeover", () => {
  interface MenuCall { title: string; options: readonly string[] }

  it("only the exact confirm option is acceptance; Cancel / unknown / Esc ⇒ refused; throw / absent control ⇒ unavailable", async () => {
    const calls: MenuCall[] = [];
    const router =
      (answer: string | undefined) =>
      async (title: string, options: readonly string[]): Promise<string | undefined> => {
        calls.push({ title, options });
        return answer;
      };
    const facts = { ownerLabel: GONE, decisionId: "dec-213", round: 1 };
    expect(await confirmOwnerTakeover(router(OWNER_TAKEOVER_CONFIRM_OPTION), facts)).toBe("accepted");
    expect(await confirmOwnerTakeover(router(OWNER_TAKEOVER_CANCEL_OPTION), facts)).toBe("refused");
    expect(await confirmOwnerTakeover(router("Revise Plan"), facts)).toBe("refused");
    expect(await confirmOwnerTakeover(router(undefined), facts)).toBe("refused");
    expect(
      await confirmOwnerTakeover(async () => {
        throw new Error("menu crash");
      }, facts),
    ).toBe("unavailable");
    expect(await confirmOwnerTakeover(undefined, facts)).toBe("unavailable");
    // Exactly the two fixed options, confirm first.
    expect(calls[0]!.options).toEqual([OWNER_TAKEOVER_CONFIRM_OPTION, OWNER_TAKEOVER_CANCEL_OPTION]);
  });

  // 213_Bug review (issue 5): a control failure must be VISIBLE to the caller —
  // the hook fires exactly on `unavailable`, with the honest cause, and never
  // on a human answer (accepted/refused).
  it("issue 5: onControlFailure fires exactly for unavailable (no-control / control-threw), never for a human answer", async () => {
    const failures: Array<{ cause: string; error?: unknown }> = [];
    const facts = {
      ownerLabel: GONE,
      decisionId: "dec-1",
      round: 1,
      onControlFailure: (d: { cause: string; error?: unknown }) => {
        failures.push(d);
      },
    };
    const ok = async (): Promise<string | undefined> => OWNER_TAKEOVER_CONFIRM_OPTION;
    const cancel = async (): Promise<string | undefined> => OWNER_TAKEOVER_CANCEL_OPTION;
    expect(await confirmOwnerTakeover(ok, facts)).toBe("accepted");
    expect(await confirmOwnerTakeover(cancel, facts)).toBe("refused");
    expect(failures.length).toBe(0); // human answers never trip the failure hook
    expect(await confirmOwnerTakeover(undefined, facts)).toBe("unavailable");
    expect(failures).toEqual([{ cause: "no-control" }]);
    const boom = async (): Promise<string> => {
      throw new Error("menu crash");
    };
    expect(await confirmOwnerTakeover(boom, facts)).toBe("unavailable");
    expect(failures.length).toBe(2);
    expect(failures[1]!.cause).toBe("control-threw");
    expect((failures[1]!.error as Error).message).toBe("menu crash");
  });

  it("the copy echoes the ORIGINAL owner verbatim (D10) — recorded file and 'not recorded' both named", async () => {
    const titles: string[] = [];
    const spy = async (title: string): Promise<string | undefined> => {
      titles.push(title);
      return undefined;
    };
    await confirmOwnerTakeover(spy, { ownerLabel: GONE, decisionId: "dec-1", round: 2 });
    await confirmOwnerTakeover(spy, { ownerLabel: "not recorded", decisionId: "dec-1", round: 2 });
    expect(titles[0]).toContain(`Original owner: ${GONE}`);
    expect(titles[1]).toContain("Original owner: not recorded");
    expect(titles[0]).toContain("dec-1");
    expect(titles[0]).toContain("round 2");
  });
});

// ─── commitOwnerTakeover — ONE strict dual-field commit + one audit ─────────

function makeDecisionFixture(overrides?: Partial<HumanDecisionRecordBase>): HumanDecision {
  return {
    state: "pending",
    decisionId: "dec-213",
    reviewIdentity: {
      pipelineId: PIPE,
      planDoc: "/tmp/plan.md",
      authorizationId: "auth-213",
      round: 1,
      operationId: "op-213",
      stageVisitId: 1000,
    },
    reportDoc: "/tmp/report.md",
    reportHash: "h-report",
    planHash: "h-plan",
    issues: [],
    mode: "manual",
    ownerSessionFile: GONE,
    armedBySessionFile: GONE,
    createdAt: 1000,
    ...overrides,
  };
}

function makeDrFixture(decision: HumanDecision, overrides?: Partial<DesignReviewState>): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/plan.md",
    planHash: "h-plan",
    round: 1,
    authorizationId: "auth-213",
    authorizationSource: "menu",
    reportDoc: "/tmp/report.md",
    phase: "paused",
    pauseReason: "decision-pending",
    authorizedAt: 900,
    updatedAt: 1100,
    decision,
    ...overrides,
  } as DesignReviewState;
}

function makeCtxWithSession(session: CoordinatorContext["session"]): CoordinatorContext {
  return {
    config: makeTestConfig(),
    session,
    actor: { isChild: false, sessionFile: PARENT },
    interactionSource: "resume",
  } as CoordinatorContext;
}

describe("213 P1: commitOwnerTakeover strict commit + audit", () => {
  it("success: BOTH owner fields move, armedBySessionFile stays byte-identical, exactly one decision_owner_takeover audit", async () => {
    audit.use();
    const decision = makeDecisionFixture();
    const drState = makeDrFixture(decision);
    const meta = makeTestMeta({ pipelineId: PIPE, currentStage: "design-review", designReview: drState as unknown as DesignReviewState });
    const session = makeStrictSession(meta);
    const ctx = makeCtxWithSession(session);

    const res = await commitOwnerTakeover(ctx, { meta, drState, decision, actorSessionFile: PARENT });
    expect(res.status).toBe("persisted");
    if (res.status !== "persisted") throw new Error("unreachable");
    // Both fields persisted on the live session meta.
    const fresh = session.getMeta()!.designReview!;
    expect(fresh.ownerSessionFile).toBe(PARENT);
    expect(fresh.decision!.ownerSessionFile).toBe(PARENT);
    // armedBy provenance NEVER rewritten.
    expect(fresh.decision!.armedBySessionFile).toBe(GONE);
    // decisionId/state survive untouched.
    expect(fresh.decision!.decisionId).toBe("dec-213");
    expect(fresh.decision!.state).toBe("pending");
    const takeovers = audit.findBy("decision_owner_takeover");
    expect(takeovers.length).toBe(1);
    expect(takeovers[0]!.message).toMatchObject({
      decisionId: "dec-213",
      round: "1",
      from: GONE,
      to: PARENT,
      actor: PARENT,
      previousEvidence: "recorded",
      pipelineId: PIPE,
    });
  });

  it("previousEvidence has BOTH vocabulated values: 'missing' (no recorded owner ⇒ from=not_recorded) vs 'recorded'", async () => {
    audit.use();
    const bare = makeDecisionFixture({ ownerSessionFile: undefined });
    const drState = makeDrFixture(bare, { ownerSessionFile: undefined });
    const meta = makeTestMeta({ pipelineId: PIPE, currentStage: "design-review", designReview: drState as unknown as DesignReviewState });
    const ctx = makeCtxWithSession(makeStrictSession(meta));
    const res = await commitOwnerTakeover(ctx, { meta, drState, decision: bare, actorSessionFile: PARENT });
    expect(res.status).toBe("persisted");
    const t = audit.findBy("decision_owner_takeover");
    expect(t.length).toBe(1);
    expect(t[0]!.message).toMatchObject({ from: "not_recorded", previousEvidence: "missing", to: PARENT });
  });

  it("failure arms: strict `unavailable` and CAS `conflict` both ⇒ status failed, ZERO takeover audits", async () => {
    audit.use();
    const decision = makeDecisionFixture();
    const drState = makeDrFixture(decision);
    const meta = makeTestMeta({ pipelineId: PIPE, currentStage: "design-review", designReview: drState as unknown as DesignReviewState });

    // unavailable (append fails on the simulated adapter)
    const dead = makeStrictSession(meta, { appendFails: true });
    const r1 = await commitOwnerTakeover(makeCtxWithSession(dead), { meta, drState, decision, actorSessionFile: PARENT });
    expect(r1).toEqual({ status: "failed", reason: "unavailable:local_append_failed" });
    expect(dead.getMeta()!.designReview!.decision!.ownerSessionFile).toBe(GONE);

    // conflict: the SECOND commit anchored on the PRE-first-takeover snapshot
    const live = makeStrictSession(meta);
    const ok = await commitOwnerTakeover(makeCtxWithSession(live), { meta, drState, decision, actorSessionFile: PARENT });
    expect(ok.status).toBe("persisted");
    const stale = await commitOwnerTakeover(makeCtxWithSession(live), { meta, drState, decision, actorSessionFile: S2 });
    expect(stale.status).toBe("failed");
    expect(String((stale as { reason: string }).reason)).toContain("conflict:");
    // The winner's binding survives; the loser never overwrote it.
    expect(live.getMeta()!.designReview!.ownerSessionFile).toBe(PARENT);
    expect(audit.findBy("decision_owner_takeover").length).toBe(1);
  });

  it("repeated takeover (fresh snapshots, reload-changes-session-file shape): two audits, the second FROM is the first TO", async () => {
    audit.use();
    const decision = makeDecisionFixture();
    const drState = makeDrFixture(decision);
    let meta = makeTestMeta({ pipelineId: PIPE, currentStage: "design-review", designReview: drState as unknown as DesignReviewState });
    const live = makeStrictSession(meta);

    const first = await commitOwnerTakeover(makeCtxWithSession(live), { meta, drState, decision, actorSessionFile: PARENT });
    expect(first.status).toBe("persisted");
    // Re-read the rebound snapshot (the reload shape) and take over AGAIN.
    meta = live.getMeta()!;
    const dr2 = meta.designReview!;
    const second = await commitOwnerTakeover(
      makeCtxWithSession(live),
      { meta, drState: dr2, decision: dr2.decision!, actorSessionFile: S2 },
    );
    expect(second.status).toBe("persisted");
    const takeovers = audit.findBy("decision_owner_takeover");
    expect(takeovers.length).toBe(2);
    expect(takeovers[0]!.message).toMatchObject({ from: GONE, to: PARENT });
    expect(takeovers[1]!.message).toMatchObject({ from: PARENT, to: S2, previousEvidence: "recorded" });
  });

  it("CAS boundary (documented): a legacy record WITHOUT updatedAt degrades the revision anchor — both explicit takeovers succeed, each leaving its own trail", async () => {
    audit.use();
    const decision = makeDecisionFixture();
    // Legacy shape: no `updatedAt` on the state ⇒ `stateUpdatedAt` anchor is
    // absent and the conflict check cannot order the two writers.
    const drState = { ...makeDrFixture(decision), updatedAt: undefined as unknown as number };
    const meta = makeTestMeta({ pipelineId: PIPE, currentStage: "design-review", designReview: drState as unknown as DesignReviewState });
    const live = makeStrictSession(meta);
    const ctx = makeCtxWithSession(live);
    const a = await commitOwnerTakeover(ctx, { meta, drState, decision, actorSessionFile: PARENT });
    const b = await commitOwnerTakeover(ctx, { meta, drState, decision, actorSessionFile: S2 });
    expect(a.status).toBe("persisted");
    // Same pre-rollback anchors still match, so the second succeeds too —
    // each with its own audit line (the documented degradation).
    expect(b.status).toBe("persisted");
    expect(audit.findBy("decision_owner_takeover").length).toBe(2);
  });
});

// ─── presenter wiring: the 212 incident shape end-to-end ────────────────────

function report(o: { planDoc: string; operationId: string; inputHash: string; verdict: "PASS" | "FAIL"; issues?: string[] }): string {
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

describe("213 P1: presenter takeover wiring on the resume channel (five-step audit order)", () => {
  let projectRoot: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-takeover-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "213_Bug_plan.md");
    fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" };
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      confirm: { mode: "manual" },
    };
    __resetMemoryThrottle();
  });

  afterEach(() => {
    audit.reset();
    clearAllHumanDecisionMenus();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    clearAllDecisionTimers();
  });

  interface MenuCall { title: string; options: readonly string[] }

  function makeHarness(): {
    session: ReturnType<typeof makeStrictSession>;
    mkCtx: (opts?: {
      actor?: DesignReviewActorInput;
      interactionSource?: "auto" | "tool" | "startup" | "resume";
      select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
      sessionOverride?: CoordinatorContext["session"];
    }) => CoordinatorContext;
    menuCalls: MenuCall[];
    notifications: string[];
    /** Drives a REAL FAIL to a pending decision whose recorded owner is GONE
     *  (the 212 incident shape: the record points at a session that cannot
     *  answer — pre-213 it stayed pending forever). */
    createPendingOwnedByGone: () => Promise<string>;
  } {
    const session = makeStrictSession(
      makeTestMeta({
        pipelineId: PIPE,
        currentStage: "design-review",
        // STATE-level owner absent — the decision-level record is the
        // read-side winner (resolveDecisionOwnerFile precedence).
        designReview: createInitialState(
          planDoc,
          "menu",
          computeHash(fs.readFileSync(planDoc, "utf-8")),
          undefined,
          { pipelineId: PIPE },
        ),
      }),
    );
    const menuCalls: MenuCall[] = [];
    const notifications: string[] = [];

    function mkCtx(opts?: {
      actor?: DesignReviewActorInput;
      interactionSource?: "auto" | "tool" | "startup" | "resume";
      select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
      sessionOverride?: CoordinatorContext["session"];
    }): CoordinatorContext {
      const ctx: CoordinatorContext = {
        config,
        session: opts?.sessionOverride ?? session,
        ui: {
          notify: (m) => notifications.push(m),
          ...(opts?.select !== undefined ? { select: opts.select } : {}),
        },
        pi: { sendUserMessage: () => {} },
        ...(opts?.actor !== undefined ? { actor: opts.actor } : {}),
        ...(opts?.interactionSource !== undefined ? { interactionSource: opts.interactionSource } : {}),
        spawnOverride: async (_cfg, stage) => ({
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: `agent-${stage}-1`,
          dispatchOutcome: "spawned_id" as const,
        }),
      };
      return ctx;
    }

    async function createPendingOwnedByGone(): Promise<string> {
      // 1. authorize + dispatch the review (non-child owner-actor settles the
      //    flow; the recorded state is `review_running` with a real operation).
      const dispatchCtx = mkCtx({ actor: { isChild: false, sessionFile: GONE } });
      const routed = await coordinateDesignReview(dispatchCtx, session.getMeta()!, "advance");
      expect(routed.status === "handled" && routed.action === "routed").toBe(true);
      const running = session.getMeta()!.designReview!;
      const reviewOpId = running.operation!.operationId;
      const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
      // 2. FAIL report on disk.
      const reportDoc = deriveReportPath(planDoc, 1);
      fs.writeFileSync(reportDoc, report({ planDoc, operationId: reviewOpId, inputHash: planHash, verdict: "FAIL" }), "utf-8");
      // 3. the GONE session settles: creation binds decision owner = GONE; the
      //    presenter refuses a menu (no select) and the decision stays pending.
      const settleCtx = mkCtx({ actor: { isChild: false, sessionFile: GONE } });
      const pending = await coordinateDesignReview(settleCtx, session.getMeta()!, "settle");
      expect(pending.status === "handled" && pending.action === "pending").toBe(true);
      const decision = session.getMeta()!.designReview!.decision!;
      expect(decision.state).toBe("pending");
      expect(decision.ownerSessionFile).toBe(GONE);
      return decision.decisionId;
    }

    return { session, mkCtx, menuCalls, notifications, createPendingOwnedByGone };
  }

  /** Routes the takeover confirmation and the decision menu apart by title. */
  function router(h: { menuCalls: MenuCall[] }, takeoverAnswer: "confirm" | "cancel", decisionAnswer?: string) {
    return async (title: string, options: readonly string[]): Promise<string | undefined> => {
      h.menuCalls.push({ title, options });
      if (title.includes("Owner takeover required")) {
        return takeoverAnswer === "confirm" ? OWNER_TAKEOVER_CONFIRM_OPTION : OWNER_TAKEOVER_CANCEL_OPTION;
      }
      return decisionAnswer;
    };
  }

  it("incident regression — takeover CONFIRMED: menu pops on the rebound snapshot and the choice lands; one takeover audit, ZERO menu_skipped", async () => {
    const h = makeHarness();
    const decisionId = await h.createPendingOwnedByGone();
    audit.use(); // fresh capture for the resume run alone

    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
      select: router(h, "confirm", "Proceed to Develop"),
    });
    const r = await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(r.status).toBe("handled");
    expect((r as { action: string }).action).not.toBe("pending");

    // The takeover confirmation came FIRST, then the real decision menu.
    expect(h.menuCalls.length).toBe(2);
    expect(h.menuCalls[0]!.title).toContain("Owner takeover required");
    expect(h.menuCalls[0]!.title).toContain(`Original owner: ${GONE}`);
    expect(h.menuCalls[1]!.title).toBe(HUMAN_DECISION_TITLE);
    expect(h.menuCalls[1]!.options).toEqual(HUMAN_DECISION_OPTIONS);

    // BOTH owner fields rebound, provenance untouched, choice persisted.
    const dr = h.session.getMeta()!.designReview!;
    expect(dr.ownerSessionFile).toBe(PARENT);
    expect(dr.decision!.ownerSessionFile).toBe(PARENT);
    expect(dr.decision!.armedBySessionFile).toBe(GONE);
    expect(dr.decision!.state).toBe("chosen");
    expect(dr.decision!.decisionId).toBe(decisionId);

    // FIVE-STEP audit honesty: exactly ONE takeover, NO contradictory skip.
    expect(audit.findBy("decision_owner_takeover").length).toBe(1);
    expect(audit.findBy("decision_menu_skipped").length).toBe(0);
    expect(audit.findBy("decision_choice_persisted").length).toBe(1);

    // D11: the automatic presentation budget was NEVER touched.
    expect(h.session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
  });

  it("takeover DECLINED: audit AND result carry decision_takeover_declined; zero state writes; the decision menu never pops", async () => {
    const h = makeHarness();
    await h.createPendingOwnedByGone();
    const before = h.session.getMeta()!;
    const beforeJson = JSON.stringify(before.designReview);
    audit.use();

    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
      select: router(h, "cancel"),
    });
    const r = await coordinateDesignReview(resumeCtx, before, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect((r as { reason: string }).reason).toBe("decision_takeover_declined");

    expect(h.menuCalls.length).toBe(1); // only the confirmation was asked
    expect(h.menuCalls[0]!.title).toContain("Owner takeover required");
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.message).toMatchObject({
      reason: "decision_takeover_declined",
      role: "unknown",
      source: "session-file",
    });
    expect(audit.findBy("decision_owner_takeover").length).toBe(0);
    // ZERO writes: the design-review state is byte-identical.
    expect(JSON.stringify(h.session.getMeta()!.designReview)).toBe(beforeJson);
  });

  // 213_Bug review (issue 5): a thrown confirmation dialog is a CONTROL failure.
  // It must be recorded as an ERROR-level audit with the raw cause and named
  // `decision_takeover_unavailable` — never `decision_takeover_declined`, which
  // would claim a human refusal that never happened.
  it("takeover CONTROL CRASH: error-level control_failure audit + unavailable skip word; declined NEVER appears; zero writes", async () => {
    const h = makeHarness();
    const decisionId = await h.createPendingOwnedByGone();
    const beforeJson = JSON.stringify(h.session.getMeta()!.designReview);
    audit.use();

    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
      select: async (title: string, options: readonly string[]) => {
        h.menuCalls.push({ title, options });
        throw new Error("host dialog crash");
      },
    });
    const r = await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect((r as { reason: string }).reason).toBe("decision_takeover_unavailable");

    // The confirmation WAS attempted (control existed), then crashed.
    expect(h.menuCalls.length).toBe(1);
    expect(h.menuCalls[0]!.title).toContain("Owner takeover required");

    // ONE error-level control-failure line carrying the full truth.
    const controlFailures = audit.findBy("decision_takeover_control_failure");
    expect(controlFailures.length).toBe(1);
    expect(controlFailures[0]!.level).toBe("error");
    expect(controlFailures[0]!.message).toMatchObject({
      decisionId,
      round: "1",
      ownerLabel: GONE,
      cause: "control-threw",
      error: "host dialog crash",
    });

    // The skip audit uses the NEW honest word; the human-facing "declined"
    // word is absent from every captured line.
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.message.reason).toBe("decision_takeover_unavailable");
    expect(audit.actions()).not.toContain("decision_takeover_declined");
    expect(audit.findBy("decision_owner_takeover").length).toBe(0);
    // ZERO writes: fail closed, state byte-identical.
    expect(JSON.stringify(h.session.getMeta()!.designReview)).toBe(beforeJson);
  });

  it("commit FAILED (conflict): decision_takeover_commit_failed:<reason> skip audit + zero writes + pending result", async () => {
    const h = makeHarness();
    await h.createPendingOwnedByGone();
    const beforeJson = JSON.stringify(h.session.getMeta()!.designReview);
    audit.use();

    // Hostile adapter: reads work, EVERY strict commit honestly conflicts.
    const hostile: CoordinatorContext["session"] = {
      getMeta: () => h.session.getMeta(),
      updateMeta: (patch: Partial<SessionMeta>) => {
        void patch;
        return undefined;
      },
      updateMetaVerified: () => ({ status: "conflict", reason: "state_drifted" }),
    } as unknown as CoordinatorContext["session"];

    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
      sessionOverride: hostile,
      select: router(h, "confirm"),
    });
    const r = await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect((r as { reason: string }).reason).toBe("decision_pending");

    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.length).toBe(1);
    expect(String(skipped[0]!.message.reason)).toBe("decision_takeover_commit_failed:conflict:state_drifted");
    expect(audit.findBy("decision_owner_takeover").length).toBe(0);
    // The decision menu was NEVER reached (only the confirmation was asked).
    expect(h.menuCalls.length).toBe(1);
    expect(JSON.stringify(h.session.getMeta()!.designReview)).toBe(beforeJson);
  });

  it("CHILD on resume: 193 verbatim refusal (role=child, reason=never own), zero confirmation, zero writes", async () => {
    const h = makeHarness();
    await h.createPendingOwnedByGone();
    const beforeJson = JSON.stringify(h.session.getMeta()!.designReview);
    audit.use();

    const childCtx = h.mkCtx({
      actor: { isChild: true, sessionFile: "/x/child-run.json", parentSessionFile: PARENT },
      interactionSource: "resume",
      select: router(h, "confirm"),
    });
    const r = await coordinateDesignReview(childCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.message).toMatchObject({
      role: "child",
      source: "child-flag",
      reason: "subagent sessions never own human decisions",
    });
    expect(h.menuCalls.length).toBe(0);
    expect(audit.findBy("decision_owner_takeover").length).toBe(0);
    expect(JSON.stringify(h.session.getMeta()!.designReview)).toBe(beforeJson);
  });

  it("NON-resume channels keep the byte-identical 212 refusal (owner-settle with a foreign record ⇒ evidence.reason skip, no confirmation ever asked)", async () => {
    const h = makeHarness();
    await h.createPendingOwnedByGone();
    audit.use();

    // The 212 incident channel: an owner-ish settle from ANOTHER session file
    // (interactionSource absent ⇒ automatic).
    const settleCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      select: router(h, "confirm"),
    });
    const r = await coordinateDesignReview(settleCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect(h.menuCalls.length).toBe(0); // never even offered
    expect(audit.findBy("decision_owner_takeover").length).toBe(0);
    // The refusal rides the automatic settle notice path, not the presenter:
    // the waiting-notice audit carries the truthful not_owner reason.
    const awaiting = audit.findBy("decision_awaiting_human");
    expect(awaiting.length).toBe(1);
    expect(awaiting[0]!.message.autoReprompt).toBe("not_owner");
  });

  it("resume WITHOUT an interactive control: no_ui verdict ⇒ the 212 evidence-reason skip stays verbatim", async () => {
    const h = makeHarness();
    await h.createPendingOwnedByGone();
    audit.use();

    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
      // no select: the legacy fallback ⇒ hasInteractiveUI false ⇒ step 2.
    });
    const r = await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.message.reason).toBe("actor session file does not match the authorized owner");
    expect(audit.findBy("decision_owner_takeover").length).toBe(0);
  });

  it("resume with a BLANK actor session file ⇒ no_actor_identity ⇒ the 212 skip, no confirmation, no writes", async () => {
    const h = makeHarness();
    await h.createPendingOwnedByGone();
    const beforeJson = JSON.stringify(h.session.getMeta()!.designReview);
    audit.use();

    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: "   " },
      interactionSource: "resume",
      select: router(h, "confirm"),
    });
    const r = await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    const skipped = audit.findBy("decision_menu_skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.message.reason).toBe("actor session file does not match the authorized owner");
    expect(h.menuCalls.length).toBe(0);
    expect(audit.findBy("decision_owner_takeover").length).toBe(0);
    expect(JSON.stringify(h.session.getMeta()!.designReview)).toBe(beforeJson);
  });

  it("MISSING-evidence takeover (D8): the 212 evidence-insufficient audit stays FIRST (pre-takeover fact), then exactly one takeover with from=not_recorded; no skip; menu lands", async () => {
    const h = makeHarness();
    // Create the pending decision through a CHILD-without-ancestor settle:
    // nothing bindable is recorded ⇒ decision owner evidence is ABSENT.
    const dispatchCtx = h.mkCtx({ actor: { isChild: false, sessionFile: PARENT } });
    const routed = await coordinateDesignReview(dispatchCtx, h.session.getMeta()!, "advance");
    expect(routed.status === "handled" && routed.action === "routed").toBe(true);
    const running = h.session.getMeta()!.designReview!;
    const planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(reportDoc, report({ planDoc, operationId: running.operation!.operationId, inputHash: planHash, verdict: "FAIL" }), "utf-8");
    const orphanCtx = h.mkCtx({ actor: { isChild: false } });
    const created = await coordinateDesignReview(orphanCtx, h.session.getMeta()!, "settle");
    expect(created.status === "handled" && created.action === "pending").toBe(true);
    expect(h.session.getMeta()!.designReview!.decision!.ownerSessionFile).toBeUndefined();
    audit.use();

    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
      select: router(h, "confirm", "Cancel"),
    });
    const r = await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(r.status === "handled" && r.action === "pending").toBe(true); // Cancel keeps it pending

    const insufficient = audit.findBy("decision_owner_evidence_insufficient");
    const takeovers = audit.findBy("decision_owner_takeover");
    expect(insufficient.length).toBe(1);
    expect(insufficient[0]!.message.stage).toBe("resume");
    expect(takeovers.length).toBe(1);
    expect(takeovers[0]!.message).toMatchObject({ from: "not_recorded", to: PARENT, previousEvidence: "missing" });
    expect(audit.findBy("decision_menu_skipped").length).toBe(0);
    // Order: the pre-takeover fact FIRST, the takeover AFTER.
    expect(audit.actions().indexOf("decision_owner_evidence_insufficient"))
      .toBeLessThan(audit.actions().indexOf("decision_owner_takeover"));
    // The rebound owner now makes the decision answerable in PARENT.
    const dr = h.session.getMeta()!.designReview!;
    expect(dr.ownerSessionFile).toBe(PARENT);
    expect(dr.decision!.ownerSessionFile).toBe(PARENT);
  });

  it("repeated takeover across reloads (flow shape): second resume from a THIRD file takes over from PARENT; two audits, zero skips", async () => {
    const h = makeHarness();
    await h.createPendingOwnedByGone();
    audit.use();

    const first = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
      select: router(h, "confirm", "Cancel"),
    });
    await coordinateDesignReview(first, h.session.getMeta()!, "settle");
    // A reload swaps the session file again ⇒ another unprovable record.
    const second = h.mkCtx({
      actor: { isChild: false, sessionFile: S2 },
      interactionSource: "resume",
      select: router(h, "confirm", "Cancel"),
    });
    await coordinateDesignReview(second, h.session.getMeta()!, "settle");

    const takeovers = audit.findBy("decision_owner_takeover");
    expect(takeovers.length).toBe(2);
    expect(takeovers[0]!.message).toMatchObject({ from: GONE, to: PARENT });
    expect(takeovers[1]!.message).toMatchObject({ from: PARENT, to: S2 });
    expect(audit.findBy("decision_menu_skipped").length).toBe(0);
    expect(h.session.getMeta()!.designReview!.ownerSessionFile).toBe(S2);
  });

  it("D11 budget lock: a takeover on resume never charges or clears the automatic budget stamp", async () => {
    const h = makeHarness();
    await h.createPendingOwnedByGone();
    audit.use();
    // Even a SUCCESSFUL takeover+choice leaves the stamp absent.
    const resumeCtx = h.mkCtx({
      actor: { isChild: false, sessionFile: PARENT },
      interactionSource: "resume",
      select: router(h, "confirm", "Revise Plan"),
    });
    await coordinateDesignReview(resumeCtx, h.session.getMeta()!, "settle");
    expect(h.session.getMeta()!.designReviewDecisionReprompt).toBeUndefined();
    expect(audit.findBy("decision_auto_reprompt").length).toBe(0);
    expect(audit.findBy("decision_auto_reprompt_stamp_failed").length).toBe(0);
  });
});
