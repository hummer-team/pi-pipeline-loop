/**
 * 193 Phase 4 (tasks 4/5): the CONFIRMED decision semantics driven through
 * the REAL agent-settled → coordinator → strict-commit → RPC chain, in one
 * session with the REAL shared-meta adapter (harness shape of the 192
 * hook-loop file). Every branch is asserted with EXACT counts — RPC
 * dispatches, menu presentations, develop visits, rounds, operation
 * identities — never "any of pending/advanced", and strict commits are
 * never mocked into success: the crashed-lock and cross-process races make
 * them honestly FAIL or honestly conflict.
 *
 * Chains (plan Phase 4 task 4):
 * - auto: invalid report → ONE honest budget attempt → FAIL → authorized
 *   update → round-2 PASS → develop; zero menus; replays add zero RPC;
 * - manual: FAIL creation menu → Cancel keeps pending; ordinary settles never
 *   re-present; /pipeline-resume re-presents → Revise Plan → update → PASS →
 *   develop with EXACTLY one develop visit;
 * - manual human release: "Proceed to Develop" acts at creation; verdict
 *   stays a genuine FAIL; finished only after the trusted receipt;
 * - smart: revise-plan updates automatically (guidance rides ONLY the exact
 *   review prompt, both rounds); request-human → menu → Cancel → startup
 *   read-only (never the stale_startup abort) → resume → human choice;
 * - PASS in every mode: zero menus, zero model wakes.
 *
 * Failure chains (plan Phase 4 task 5, decision-loop subset; the unknown
 * dispatch window stays covered by the 192 hook-loop file):
 * - cross-process choice race through the REAL compare-and-set (the
 *   concurrently persisted choice wins; the late selection has ZERO action);
 * - crashed residual .meta-write-lock (pending survives honestly; manual
 *   cleanup recovers the SAME decision);
 * - report drift after pending parks paused("drift") and clears the stale
 *   decision;
 * - broken smart YAML blocks the dispatch with ZERO RPC; a fixed file is
 *   re-read by the next preparation (explicit reload recovery).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { ConfirmMode, DesignReviewState, PipelineConfig, SessionMeta } from "../../types";
import { createAgentSettled } from "../../core/agent-settled";
import { createSessionState, __resetSharedStateDir } from "../../core/session-state";
import {
  metaLockDirPath,
  META_LOCK_OWNER_FILE,
} from "../../core/pipeline-meta-transaction";
import {
  classifyDesignReviewFlow,
  computeHash,
  createInitialState,
  deriveReportPath,
} from "../../core/design-review/state";
import {
  applyHumanDecisionChoice,
  clearAllHumanDecisionMenus,
  HUMAN_DECISION_TITLE,
} from "../../core/design-review/human-decision";
import { clearAllDecisionTimers, getFlowState } from "../../core/flow-state";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { createSessionStarter } from "../../core/session-starter";
import { markSubagentsReady, __resetSubagentsReady } from "../../utils/subagent-availability";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";

const PIPE = "pipe-decision-1";

// ─── harness (real adapter, real strict commits, RPC bus is the only mock) ──

type Harness = {
  projectRoot: string;
  planDoc: string;
  config: PipelineConfig;
  session: ReturnType<typeof createSessionState>;
  hook: ReturnType<typeof createAgentSettled>;
  hookCtx: Record<string, unknown>;
  /** Menu/select titles in call order. */
  menuCalls: string[];
  /** Scripted select returns (undefined when exhausted = Esc). */
  selectQueue: Array<string | undefined>;
  /** Runs INSIDE the human-decision select before the late answer returns. */
  race: { fn?: () => void | Promise<void> };
  /** pi.sendUserMessage wake records. */
  sends: string[];
  /** ui.notify records. */
  notes: string[];
  rpcCount: () => number;
  lastPrompt: () => string;
  settle: (userMessage?: string) => Promise<void>;
  resume: (args?: Record<string, unknown>) => Promise<{ message?: string }>;
  startup: () => Promise<void>;
  cleanup: () => void;
};

function makeHarness(opts: { confirmMode?: ConfirmMode } = {}): Harness {
  const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-decision-loop-"));
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  const planDoc = path.join(projectRoot, "docs", "193_Feat_plan.md");
  fs.writeFileSync(planDoc, "# Plan\n\nOriginal content.\n", "utf-8");
  fs.writeFileSync(path.join(projectRoot, "docs", "193_Feat.md"), "# Requirements\nx\n", "utf-8");

  const config = makeTestConfig({ projectRoot }) as PipelineConfig;
  for (const [stage, agent] of [
    ["design-review", "design-review-agent"],
    ["plan", "plan-agent"],
    ["develop", "develop-agent"],
  ] as const) {
    const agentRel = `agents/${agent}.md`;
    fs.mkdirSync(path.join(projectRoot, "agents"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, agentRel), `---\nname: ${agent}\n---\nbody\n`, "utf-8");
    config.stages[stage] = { ...config.stages[stage], agentPath: agentRel };
  }
  // Confirmation mode under test (pinned per review dispatch at prep time).
  config.stages["design-review"] = {
    ...config.stages["design-review"]!,
    confirm: { mode: opts.confirmMode ?? "auto" },
  };
  // develop terminal: post-finish replay settles do NOT advance into review.
  config.stages["develop"] = { ...config.stages["develop"]!, nextStage: null };
  void initAuditLog(config);

  const rpcPrompts: string[] = [];
  let rpcCount = 0;
  let nextId = 0;
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const entries: unknown[] = [];
  const sends: string[] = [];
  const notes: string[] = [];
  const menuCalls: string[] = [];
  const selectQueue: Array<string | undefined> = [];
  const race = { fn: undefined as (() => void | Promise<void>) | undefined };
  const sessionIdentity = {
    file: path.join(projectRoot, "owner.jsonl"),
    name: "owner",
    header: undefined as Record<string, unknown> | undefined,
  };

  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    events: {
      emit: (event: string, payload: Record<string, unknown>) => {
        if (event === "subagents:rpc:spawn") {
          rpcCount++;
          const id = `agent-rpc-${++nextId}`;
          rpcPrompts.push(String(payload.prompt ?? ""));
          const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
          setTimeout(() => {
            for (const h of handlers.get(replyChannel) ?? []) {
              h({ success: true, data: { id } });
            }
          }, 0);
        }
      },
      on: (event: string, h: (p: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), h]);
      },
      off: (event: string, h: (p: unknown) => void) => {
        handlers.set(event, (handlers.get(event) ?? []).filter((x) => x !== h));
      },
    },
    sendUserMessage: (m: string) => {
      sends.push(m);
    },
  };
  const adapterCtx = {
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
    },
  };
  // REAL session adapter: shared meta.json + strict commits with the real
  // .meta-write-lock (nothing here mocks a commit into success).
  const session = createSessionState(pi as never, adapterCtx as never, {
    projectRoot,
    auditDir: ".pi/audit",
  });

  const initial = makeTestMeta({
    currentStage: "design-review",
    requirementDoc: "docs/193_Feat.md",
    pipelineId: PIPE,
    loopCycleCount: 0,
  });
  session.updateMeta(initial);

  let branchUserMessage = "docs/193_Feat.md 1 答";
  const hookCtx = {
    session,
    pi,
    ui: {
      notify: (m: string) => {
        notes.push(m);
      },
      setStatus: () => {},
      select: async (title: string, _options: readonly string[]) => {
        menuCalls.push(title);
        if (title === HUMAN_DECISION_TITLE && race.fn) await race.fn();
        return selectQueue.length ? selectQueue.shift() : undefined;
      },
      confirm: async () => false,
    },
    _ctx: {
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => [
          { type: "message", message: { role: "user", content: branchUserMessage } },
        ],
        getSessionFile: () => sessionIdentity.file,
        getSessionName: () => sessionIdentity.name,
        getHeader: () => sessionIdentity.header,
      },
    },
  };

  const hook = createAgentSettled(config);

  return {
    projectRoot,
    planDoc,
    config,
    session,
    hook,
    hookCtx,
    menuCalls,
    selectQueue,
    race,
    sends,
    notes,
    rpcCount: () => rpcCount,
    lastPrompt: () => rpcPrompts[rpcPrompts.length - 1] ?? "",
    settle: async (userMessage?: string) => {
      if (userMessage !== undefined) branchUserMessage = userMessage;
      await hook.handler(hookCtx as never);
      await new Promise((r) => setTimeout(r, 5)); // flush RPC reply timers
    },
    resume: async (args: Record<string, unknown> = {}) => {
      const cmd = createPipelineResumeCommand(config);
      return (await cmd.execute(args as never, hookCtx as never)) as { message?: string };
    },
    startup: async () => {
      const starter = createSessionStarter(config);
      await starter.handler({ ...hookCtx, event: { reason: "startup" } } as never);
    },
    cleanup: () => {
      __resetSubagentsReady();
      __resetAuditDirPath();
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

// ─── artifact helpers ---------------------------------------------------------

function stateOf(h: Harness): DesignReviewState {
  return h.session.getMeta()!.designReview as DesignReviewState;
}

function authorizeReview(h: Harness) {
  const planHash = computeHash(fs.readFileSync(h.planDoc, "utf-8"));
  // Bind the decision to the SAME owner file the hook ctx reports, so the
  // human-decision eligibility check has real matching evidence.
  const dr = createInitialState(h.planDoc, "menu", planHash, ownerFile(h), {
    pipelineId: PIPE,
    requirementDoc: "docs/193_Feat.md",
  });
  h.session.updateMeta({ currentStage: "design-review", designReview: dr });
}

function ownerFile(h: Harness): string {
  return (h.hookCtx._ctx as { sessionManager: { getSessionFile: () => string } })
    .sessionManager.getSessionFile();
}

function writeReport(
  h: Harness,
  verdict: "PASS" | "FAIL",
  issues: string[] = [],
  smartDecision?: { action: "revise-plan" | "request-human"; reason: string },
) {
  const st = stateOf(h);
  const op = st.operation!;
  const lines = [
    "# Design Review Report",
    "",
    `**pipeline**: ${PIPE}`,
    `**plan**: ${st.planDoc}`,
    `**round**: ${st.round}`,
    `**operation**: ${op.operationId}`,
    `**input hash**: ${op.inputHash}`,
    "",
    "## Summary",
    "",
    `Round ${st.round}: reviewed ${st.planDoc} against the requirement document;`,
    "phase split, acceptance criteria and regression coverage are addressed.",
    "",
    "## Recommendations",
    "",
    "Proceed with the plan as written; keep the per-phase acceptance criteria",
    "as the regression checklist.",
    "",
    "## Verdict",
    "",
    `**Design Review: ${verdict}**`,
    "",
    "## Issues",
    ...(issues.length > 0 ? issues.map((t, i) => `${i + 1}. ${t}`) : ["None"]),
    "",
  ];
  if (smartDecision) {
    lines.push("## Plan Revision Decision", "", `**action**: ${smartDecision.action}`, `**reason**: ${smartDecision.reason}`, "");
  }
  fs.writeFileSync(deriveReportPath(st.planDoc, st.round), lines.join("\n"), "utf-8");
}

function writeGarbageReport(h: Harness) {
  const st = stateOf(h);
  fs.writeFileSync(deriveReportPath(st.planDoc, st.round), "not a contract report\n", "utf-8");
}

function writePlanUpdate(h: Harness) {
  const st = stateOf(h);
  const updateOp = st.operation!;
  const receipt = st.reviewInputReceipt!;
  const lines = [
    "# Plan",
    "updated design content",
    "",
    "## Design Review Update",
    "",
    `**Report**: ${receipt.reportDoc}`,
    `**Round**: ${st.round}`,
    `**Operation**: ${updateOp.operationId}`,
    `**Baseline Hash**: ${receipt.inputPlanHash}`,
    "",
    "### Issue Dispositions",
    "",
    "| # | Issue | Disposition | Justification |",
    "|---|-------|-------------|---------------|",
    ...receipt.issueIds.map((id) => `| ${id} | defect ${id} | fixed | amended section ${id} |`),
    "",
    "### Changes Made",
    "",
    `- addressed ${receipt.issueIds.length} issue(s) inline`,
    "",
  ];
  fs.writeFileSync(h.planDoc, lines.join("\n"), "utf-8");
}

function humanMenus(h: Harness): number {
  return h.menuCalls.filter((t) => t === HUMAN_DECISION_TITLE).length;
}

function developVisits(h: Harness): number {
  return (h.session.getMeta()!.stageVisitOrder ?? []).filter((s) => s === "develop").length;
}

/** Plant a crashed holder's residual exclusive lock (real EEXIST path). */
function plantCrashLock(h: Harness) {
  const lockDir = metaLockDirPath(path.resolve(h.projectRoot, ".pi", "audit"), PIPE);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, META_LOCK_OWNER_FILE),
    JSON.stringify({ token: "crashed-owner", pid: 999_999, host: os.hostname(), createdAt: Date.now() }),
    "utf-8",
  );
  return lockDir;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("193 Phase 4: decision chains through the real hook chain", () => {
  const created: Harness[] = [];
  const mk = (opts?: { confirmMode?: ConfirmMode }) => {
    const h = makeHarness(opts);
    created.push(h);
    return h;
  };

  beforeEach(() => {
    markSubagentsReady();
  });

  afterEach(() => {
    clearAllHumanDecisionMenus();
    while (created.length) created.pop()!.cleanup();
  });

  afterAll(() => {
    clearAllDecisionTimers();
  });

  it("auto: invalid report costs ONE budget attempt, then FAIL → update → round-2 PASS → develop, zero menus", async () => {
    const h = mk();
    authorizeReview(h);
    await h.settle(); // review dispatch (rpc 1)
    expect(h.rpcCount()).toBe(1);
    const round1OpId = stateOf(h).operation!.operationId;

    // A contract-invalid report is NEVER routed: exactly ONE budget
    // attempt is recorded and the review window stays open for correction.
    writeGarbageReport(h);
    await h.settle();
    expect((h.session.getMeta() as SessionMeta).verifyAttempts).toBe(1);
    expect(stateOf(h).phase).toBe("review_running");
    expect(h.session.getMeta()!.currentStage).toBe("design-review");
    expect(h.rpcCount()).toBe(1);
    expect(humanMenus(h)).toBe(0);

    // Corrected valid FAIL → authorized update (auto mode: no human menu).
    writeReport(h, "FAIL", ["Missing error handling", "Incomplete API contract"]);
    await h.settle();
    expect(h.rpcCount()).toBe(2);
    expect(h.session.getMeta()!.currentStage).toBe("plan");
    expect(stateOf(h).operation?.kind).toBe("update");
    expect(stateOf(h).reviewInputReceipt?.issueIds).toEqual(["1", "2"]);

    writePlanUpdate(h);
    await h.settle(); // update consumed → round 2 review (rpc 3)
    const st2 = stateOf(h);
    expect(st2.round).toBe(2);
    expect(st2.phase).toBe("review_running");
    expect(st2.operation?.kind).toBe("review");
    expect(st2.operation!.operationId).not.toBe(round1OpId); // fresh identity
    expect(st2.planHash).toBe(computeHash(fs.readFileSync(h.planDoc, "utf-8")));
    expect(h.rpcCount()).toBe(3);

    writeReport(h, "PASS");
    await h.settle(); // PASS → handoff (rpc 4) → finished
    expect(stateOf(h).phase).toBe("finished");
    expect(h.session.getMeta()!.currentStage).toBe("develop");
    expect(stateOf(h).approval?.reviewOperationId).toBe(st2.operation!.operationId);
    expect(h.rpcCount()).toBe(4);
    expect(humanMenus(h)).toBe(0); // AUTO mode never presents a menu
    expect(classifyDesignReviewFlow(h.session.getMeta()!).kind).toBe("ordinary");

    // replay settles after finish: zero extra RPC, zero extra visits
    await h.settle();
    await h.settle();
    expect(h.rpcCount()).toBe(4);
    expect(developVisits(h)).toBe(1);
  });

  it("manual: FAIL menu → Cancel keeps pending, settles never re-present, resume re-presents → Revise Plan → develop with ONE visit", async () => {
    const h = mk({ confirmMode: "manual" });
    authorizeReview(h);
    await h.settle(); // review dispatch (rpc 1)
    writeReport(h, "FAIL", ["Missing rollback plan"]);
    h.selectQueue.push("Cancel");

    await h.settle(); // creation presents EXACTLY ONE menu; Cancel keeps pending
    expect(humanMenus(h)).toBe(1);
    expect(stateOf(h).phase).toBe("paused");
    expect(stateOf(h).pauseReason).toBe("decision-pending");
    expect(stateOf(h).decision?.state).toBe("pending");
    expect(h.rpcCount()).toBe(1);

    await h.settle(); // ordinary settle: read-only wait, NO re-presentation
    expect(humanMenus(h)).toBe(1);
    expect(stateOf(h).decision?.state).toBe("pending");

    // A dismissed re-presentation (Esc) keeps the decision pending too...
    const resEsc = await h.resume();
    expect(humanMenus(h)).toBe(2);
    expect(resEsc.message ?? "").toContain("Design-review recovery pending");
    expect(stateOf(h).decision?.state).toBe("pending");

    // ...while an explicit resume with a REAL choice acts on the recovery.
    h.selectQueue.push("Revise Plan");
    const res = await h.resume();
    expect(humanMenus(h)).toBe(3);
    expect(res.message ?? "").toContain("Design-review");
    // the chosen recovery acted: authorized update dispatch, exactly one
    expect(stateOf(h).decision?.state).toBe("chosen");
    expect((stateOf(h).decision as { choice?: string }).choice).toBe("revise-plan");
    expect(h.rpcCount()).toBe(2);
    expect(h.session.getMeta()!.currentStage).toBe("plan");
    expect(stateOf(h).operation?.kind).toBe("update");

    writePlanUpdate(h);
    await h.settle(); // consumed → round-2 review (rpc 3)
    expect(stateOf(h).round).toBe(2);
    expect(h.rpcCount()).toBe(3);
    writeReport(h, "PASS");
    await h.settle(); // PASS → develop (rpc 4); trusted PASS needs NO menu
    expect(humanMenus(h)).toBe(3); // menu count unchanged for the PASS release
    expect(stateOf(h).phase).toBe("finished");
    expect(h.session.getMeta()!.currentStage).toBe("develop");
    expect(h.rpcCount()).toBe(4);
    expect(developVisits(h)).toBe(1);
  });

  it("manual human release: Proceed to Develop acts AT CREATION; verdict stays FAIL; finished only after trusted receipt", async () => {
    const h = mk({ confirmMode: "manual" });
    authorizeReview(h);
    await h.settle(); // review dispatch (rpc 1)
    const reviewOpId = stateOf(h).operation!.operationId;
    writeReport(h, "FAIL", ["Missing rollback plan"]);
    h.selectQueue.push("Proceed to Develop");

    await h.settle(); // menu (creation) → choice → develop handoff (rpc 2)
    expect(humanMenus(h)).toBe(1);
    const st = stateOf(h);
    expect(st.decision?.state).toBe("chosen");
    expect((st.decision as { choice?: string }).choice).toBe("proceed-develop");
    expect(st.outcome?.verdict).toBe("fail"); // REAL FAIL preserved, never faked
    expect(st.approval?.basis?.kind).toBe("human-override");
    if (st.approval?.basis?.kind === "human-override") {
      expect(st.approval.basis.decisionId).toBe(st.decision!.decisionId);
    }
    expect(st.phase).toBe("finished");
    expect(st.operation?.kind).toBe("develop-handoff");
    expect(st.operation?.dispatchEvidence).toBe("trusted_id"); // receipt BEFORE finish
    expect(st.approval?.reviewOperationId).toBe(reviewOpId);
    expect(h.session.getMeta()!.currentStage).toBe("develop");
    expect(h.rpcCount()).toBe(2);
    expect(developVisits(h)).toBe(1);
    expect(h.sends.length).toBe(0); // a UI decision never wakes the model
  });

  it("smart revise-plan: guidance rides ONLY the exact review prompt; update flows with zero menus", async () => {
    const h = mk({ confirmMode: "smart" });
    authorizeReview(h);
    await h.settle(); // review dispatch (rpc 1) with built-in default guidance
    const round1OpId = stateOf(h).operation!.operationId;
    expect(h.rpcCount()).toBe(1);
    // the EXACT review prompt carries the smart protocol bound to this op
    expect(h.lastPrompt()).toContain("Design Review Smart Plan-Revision Decision");
    expect(h.lastPrompt()).toContain(round1OpId);

    writeReport(h, "FAIL", ["Missing error handling"], {
      action: "revise-plan",
      reason: "every listed gap is fixable inside the plan document itself",
    });
    await h.settle(); // declared revise-plan → automatic update (rpc 2)
    expect(humanMenus(h)).toBe(0);
    expect(stateOf(h).decision).toBeUndefined(); // no human record for revise-plan
    expect(h.rpcCount()).toBe(2);
    expect(h.session.getMeta()!.currentStage).toBe("plan");
    expect(stateOf(h).operation?.kind).toBe("update");
    // the update dispatch NEVER carries the review decision protocol
    expect(h.lastPrompt()).not.toContain("Design Review Smart Plan-Revision Decision");

    writePlanUpdate(h);
    await h.settle(); // round-2 review re-prepared with the SAME guidance (rpc 3)
    expect(h.rpcCount()).toBe(3);
    expect(stateOf(h).round).toBe(2);
    expect(h.lastPrompt()).toContain("Design Review Smart Plan-Revision Decision");
    expect(h.lastPrompt()).toContain("round 2");

    writeReport(h, "PASS");
    await h.settle();
    expect(stateOf(h).phase).toBe("finished");
    expect(h.session.getMeta()!.currentStage).toBe("develop");
    expect(h.rpcCount()).toBe(4);
    expect(humanMenus(h)).toBe(0);
    expect(developVisits(h)).toBe(1);
  });

  it("smart request-human → menu → Cancel → startup read-only (NO stale abort, NO menu) → resume → human choice", async () => {
    const h = mk({ confirmMode: "smart" });
    authorizeReview(h);
    await h.settle(); // rpc 1
    writeReport(h, "FAIL", ["Requirement conflict on rollout order"], {
      action: "request-human",
      reason: "the rollout order needs the owner's product decision",
    });
    h.selectQueue.push("Cancel");
    await h.settle(); // creation menu (1) → Cancel keeps pending
    expect(humanMenus(h)).toBe(1);
    expect(stateOf(h).phase).toBe("paused");
    expect(stateOf(h).pauseReason).toBe("decision-pending");

    // reload/startup: read-only wait — no menu, no stale_startup abort, no wake
    await h.startup();
    expect(humanMenus(h)).toBe(1);
    const m = h.session.getMeta() as SessionMeta;
    expect(getFlowState(m)).toBe("running");
    expect(m.terminateReason).toBeUndefined();
    expect(h.rpcCount()).toBe(1);
    expect(h.sends.length).toBe(0);
    expect(h.notes.some((n) => n.includes("Design-review recovery: decision_pending"))).toBe(true);

    // explicit resume re-presents; the human releases to develop
    h.selectQueue.push("Proceed to Develop");
    const res = await h.resume();
    expect(humanMenus(h)).toBe(2);
    expect(res.message ?? "").toContain('advanced to "develop"');
    const st = stateOf(h);
    expect(st.decision?.state).toBe("chosen");
    expect(st.outcome?.verdict).toBe("fail");
    expect(st.phase).toBe("finished");
    expect(h.session.getMeta()!.currentStage).toBe("develop");
    expect(h.rpcCount()).toBe(2);
    expect(developVisits(h)).toBe(1);
    expect(h.sends.length).toBe(0); // command entries never wake the model
  });

  it("PASS needs ZERO menus in every confirmation mode (trusted PASS releases automatically)", async () => {
    for (const mode of ["auto", "manual", "smart"] as ConfirmMode[]) {
      const h = mk({ confirmMode: mode });
      authorizeReview(h);
      await h.settle(); // review dispatch (rpc 1)
      writeReport(h, "PASS");
      await h.settle(); // PASS → develop (rpc 2)
      const st = stateOf(h);
      expect(st.phase).toBe("finished");
      expect(h.session.getMeta()!.currentStage).toBe("develop");
      expect(st.decision).toBeUndefined(); // no human record was ever created
      expect(humanMenus(h)).toBe(0);
      expect(h.rpcCount()).toBe(2);
      expect(h.sends.length).toBe(0);
      expect(developVisits(h)).toBe(1);
    }
  });

  it("failure chain: cross-process choice race — concurrently persisted choice WINS, late selection has ZERO action", async () => {
    const h = mk({ confirmMode: "manual" });
    authorizeReview(h);
    await h.settle(); // rpc 1
    writeReport(h, "FAIL", ["Missing rollback plan"]);
    h.selectQueue.push("Proceed to Develop");
    // WHILE the menu is open, another process strictly commits "Revise Plan"
    // first — through the SAME real compare-and-set (no mocked success).
    h.race.fn = () => {
      const cur = h.session.getMeta()!;
      const dr = cur.designReview!;
      const chosen = applyHumanDecisionChoice(dr.decision!, "revise-plan", Date.now());
      const commit = h.session.updateMetaVerified!(
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
    };

    await h.settle(); // creation menu: the LATE "Proceed" conflicts → zero action
    expect(humanMenus(h)).toBe(1);
    const st = stateOf(h);
    expect(st.decision?.state).toBe("chosen");
    expect((st.decision as { choice?: string }).choice).toBe("revise-plan"); // the racer wins
    expect(st.approval).toBeUndefined(); // the late proceed-develop did NOTHING
    expect(h.session.getMeta()!.currentStage).toBe("design-review");
    expect(h.rpcCount()).toBe(1); // no develop handoff, no update yet

    // the persisted (concurrent) choice acts on the NEXT resume WITHOUT a menu
    const res = await h.resume();
    expect(humanMenus(h)).toBe(1); // no re-presentation for a chosen decision
    expect(res.message ?? "").toContain("Design-review");
    expect(h.rpcCount()).toBe(2);
    expect(h.session.getMeta()!.currentStage).toBe("plan");
    expect(stateOf(h).operation?.kind).toBe("update");

    writePlanUpdate(h);
    await h.settle(); // round-2 review (rpc 3)
    expect(stateOf(h).round).toBe(2);
    writeReport(h, "PASS");
    await h.settle(); // PASS → develop (rpc 4)
    expect(h.session.getMeta()!.currentStage).toBe("develop");
    expect(h.rpcCount()).toBe(4);
    expect(humanMenus(h)).toBe(1);
    expect(developVisits(h)).toBe(1);
  });

  it("failure chain: crashed residual .meta-write-lock keeps the decision pending; manual cleanup recovers the SAME decision", async () => {
    const h = mk({ confirmMode: "manual" });
    authorizeReview(h);
    await h.settle(); // rpc 1
    writeReport(h, "FAIL", ["Missing rollback plan"]);
    h.selectQueue.push("Cancel");
    await h.settle(); // creation menu (1) → pending
    expect(humanMenus(h)).toBe(1);

    const lockDir = plantCrashLock(h);
    // resume re-presents; the choice commit hits the residual EXCLUSIVE lock
    // and fails CLOSED — pending survives, nothing is advanced, no wake.
    h.selectQueue.push("Proceed to Develop");
    const res = await h.resume();
    expect(humanMenus(h)).toBe(2);
    const stMid = stateOf(h);
    expect(stMid.decision?.state).toBe("pending"); // commit refused, record intact
    expect(stMid.phase).toBe("paused");
    expect(stMid.pauseReason).toBe("decision-pending");
    expect(h.session.getMeta()!.currentStage).toBe("design-review");
    expect(h.rpcCount()).toBe(1);
    expect(h.sends.length).toBe(0);
    expect(res.message ?? "").toContain("Design-review recovery pending");

    // manual cleanup → the SAME decision completes normally on retry
    fs.rmSync(lockDir, { recursive: true, force: true });
    h.selectQueue.push("Proceed to Develop");
    const res2 = await h.resume();
    expect(humanMenus(h)).toBe(3);
    expect(res2.message ?? "").toContain('advanced to "develop"');
    const st = stateOf(h);
    expect(st.decision?.state).toBe("chosen");
    expect(st.decision!.decisionId).toBe(stMid.decision!.decisionId); // SAME decision
    expect(st.phase).toBe("finished");
    expect(h.rpcCount()).toBe(2);
    expect(developVisits(h)).toBe(1);
  });

  it("failure chain: report drift after pending parks paused(drift) — decision cleared, zero action, zero later menus", async () => {
    const h = mk({ confirmMode: "manual" });
    authorizeReview(h);
    await h.settle(); // rpc 1
    writeReport(h, "FAIL", ["Missing rollback plan"]);
    h.selectQueue.push("Cancel");
    await h.settle(); // creation menu (1) → pending
    expect(humanMenus(h)).toBe(1);

    // the report file changes AFTER the decision snapshot was bound
    const reportDoc = deriveReportPath(h.planDoc, 1);
    fs.appendFileSync(reportDoc, "2. Additional late-discovered gap\n");

    // Drift is caught by the BEFORE-menu revalidation: a stale menu is never
    // even presented (presentation count stays at the single creation popup).
    const res = await h.resume();
    expect(humanMenus(h)).toBe(1); // drifted evidence pops NO menu at all
    expect(res.message ?? "").toContain("report_hash_drift");
    const st = stateOf(h);
    expect(st.phase).toBe("paused");
    expect(st.pauseReason).toBe("drift");
    expect(st.decision).toBeUndefined(); // stale decision cleared — new round required
    expect(h.rpcCount()).toBe(1); // zero action from the drifted choice
    expect(h.session.getMeta()!.currentStage).toBe("design-review");

    // neither an ordinary settle nor a later resume pops a menu again
    await h.settle();
    const res2 = await h.resume();
    expect(humanMenus(h)).toBe(1);
    expect(res2.message ?? "").toContain("Design-review"); // domain-owned, never generic
    expect(h.rpcCount()).toBe(1);
  });

  it("failure chain: broken smart YAML blocks dispatch with ZERO RPC; the fixed file is re-read by the next preparation", async () => {
    const h = mk({ confirmMode: "smart" });
    const yml = path.join(h.projectRoot, ".pi", "references", "pipeline-stage-prompt.yml");
    fs.mkdirSync(path.dirname(yml), { recursive: true });
    fs.writeFileSync(yml, 'design_review_smart_decision_prompt: "unclosed\n', "utf-8");

    authorizeReview(h);
    await h.settle(); // preparation BLOCKS: explicit config error is never a default swap
    expect(h.rpcCount()).toBe(0);
    expect(stateOf(h).phase).toBe("review_ready"); // recoverable, dispatch never sent
    expect(h.session.getMeta()!.currentStage).toBe("design-review");
    expect(humanMenus(h)).toBe(0);

    // fix the file; the next preparation reloads by actual path (no cache lock-in)
    fs.writeFileSync(
      yml,
      "design_review_smart_decision_prompt: |\n   FIXED CUSTOM GUIDANCE round {round}\n",
      "utf-8",
    );
    await h.settle(); // now the review dispatches with the CUSTOM guidance
    expect(h.rpcCount()).toBe(1);
    expect(stateOf(h).phase).toBe("review_running");
    expect(h.lastPrompt()).toContain("FIXED CUSTOM GUIDANCE");
    expect(h.lastPrompt()).toContain("round 1");

    // and the custom text rides only review prompts (same guarantee as default)
    writeReport(h, "FAIL", ["Missing error handling"], {
      action: "revise-plan",
      reason: "every listed gap is fixable inside the plan document itself",
    });
    await h.settle();
    expect(h.lastPrompt()).not.toContain("FIXED CUSTOM GUIDANCE");
    expect(stateOf(h).operation?.kind).toBe("update");
    expect(humanMenus(h)).toBe(0);
  });
});
