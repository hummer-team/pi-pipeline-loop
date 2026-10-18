/**
 * 192 fix (issue 5) — REWRITTEN full-cycle test per plan Phase 5 task 3.
 *
 * The previous version of this file was retired because its "full cycle"
 * assertions were any-of style (`["routed","pending","advanced"]` all
 * accepted) and it hand-crafted phase/round/operation between rounds,
 * skipping the real entry. Per plan Phase 5 task 3 the cycle is now driven:
 *
 * - ONE session from the ORDINARY plan stage with a REAL TUI selection
 *   ("Auto Review Plan" through the production confirm-gate handler the
 *   agent-settled hook invokes — no manually built authorization);
 * - the fake RPC bus returns REAL ids and the chain advances ONLY through
 *   real agent-settled hook runs (no ctx rebuild, no phase/round/operation
 *   written by the test);
 * - fixtures produce the report / plan update FROM the identity the running
 *   state actually bound (mirroring what the delivered prompts instruct);
 * - assertions are exact: per-transition RPC deltas, unique operation ids,
 *   report hashes (sha256 of on-disk bytes), round progression, stage
 *   transitions, budget counters, and the single-menu isolation property.
 *
 * Remaining cases (old-config compatibility, issues-precedence, Summary-
 * prose verdict rejection) keep their strong successor assertions against
 * the coordinator with bound operations — no any-of results.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { clearAllDecisionTimers } from "../../core/flow-state";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionMeta, DesignReviewState, PipelineConfig } from "../../types";
import { createAgentSettled } from "../../core/agent-settled";
import { createSessionState, matchCommitExpectation, __resetSharedStateDir } from "../../core/session-state";
import {
  computeHash,
  deriveReportPath,
  createInitialState,
  classifyDesignReviewFlow,
} from "../../core/design-review/state";
import { coordinateDesignReview, type CoordinatorContext } from "../../core/design-review/coordinator";
import { markSubagentsReady, __resetSubagentsReady } from "../../utils/subagent-availability";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import {
  makeTestConfig,
  makeTestMeta,
  reviewReportContent,
  boundReviewOperation,
  writeStandaloneUpdateDeliverables,
  deployDispatchAssets,
} from "../helpers";

// ─── full-cycle harness: ordinary plan start + real TUI menu ────────────────

type LoopHarness = {
  projectRoot: string;
  planDoc: string;
  config: PipelineConfig;
  session: ReturnType<typeof createSessionState>;
  rpcCount: () => number;
  lastPrompt: () => string;
  /** Options passed to each real ui.select menu invocation. */
  menuCalls: { options: string[]; chosen?: string }[];
  settle: (userMessage?: string) => Promise<void>;
  cleanup: () => void;
};

function makeLoopHarness(): LoopHarness {
  const projectRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-loop-rewrite-"));
  fs.mkdirSync(path.join(projectRoot, "docs", "design"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "agents"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "verify"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".pi", "audit"), { recursive: true });
  const reqDoc = path.join(projectRoot, "docs", "design", "191_Feat.md");
  const planDoc = path.join(projectRoot, "docs", "design", "191_Feat_Plan.md");
  fs.writeFileSync(reqDoc, "# Requirements\ncontent\n", "utf-8");
  fs.writeFileSync(planDoc, "# Plan\ninitial design\n", "utf-8");

  const config = makeTestConfig({ projectRoot }) as PipelineConfig;
  for (const [stage, agent] of [
    ["design-review", "design-review-agent"],
    ["plan", "plan-agent"],
    ["develop", "develop-agent"],
  ] as const) {
    const agentRel = `agents/${agent}.md`;
    fs.writeFileSync(path.join(projectRoot, agentRel), `---\nname: ${agent}\n---\nbody\n`, "utf-8");
    config.stages[stage] = { ...config.stages[stage], agentPath: agentRel };
  }
  // design-review ENABLED (menu offers Auto Review Plan only when required)
  config.stages["design-review"] = {
    ...config.stages["design-review"]!,
    verify: { require: true },
  };
  // ordinary plan stage: passing verification + MANUAL confirm (real TUI menu)
  const planVerifyFile = path.join(projectRoot, "verify", "plan-verify.md");
  fs.writeFileSync(
    planVerifyFile,
    "---\nrules:\n  requiredFiles:\n    - \"docs/design/191_Feat_Plan.md\"\n---\nplan gate\n",
    "utf-8",
  );
  config.stages["plan"] = {
    ...config.stages["plan"]!,
    verify: { require: true, verifyFile: planVerifyFile },
    confirm: { mode: "manual" },
  };
  // develop terminal: post-finish replay settles must not advance further
  config.stages["develop"] = { ...config.stages["develop"]!, nextStage: null };
  // 194 Phase 2: the resource preflight runs on this harness's REAL spawn
  // path, so ship the skills/template assets a deployed project has.
  deployDispatchAssets(config);
  void initAuditLog(config);

  // ── fake RPC bus (the ONLY mock): replies carry verifiable ids ──
  const rpcPrompts: string[] = [];
  let rpcCount = 0;
  let nextId = 0;
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const entries: unknown[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    events: {
      emit: (event: string, payload: Record<string, unknown>) => {
        if (event === "subagents:rpc:spawn") {
          rpcCount++;
          const id = `agent-loop-${++nextId}`;
          rpcPrompts.push(String(payload.prompt ?? ""));
          setTimeout(() => {
            for (const h of handlers.get(`subagents:rpc:spawn:reply:${payload.requestId}`) ?? []) {
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
    sendUserMessage: (_m: string) => {},
  };
  const adapterCtx = {
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
  };
  // REAL session adapter (local entries + shared meta.json under .pi/audit)
  const session = createSessionState(pi as never, adapterCtx as never, {
    projectRoot,
    auditDir: ".pi/audit",
  });

  // Start as an ORDINARY plan-stage session: no designReview state at all.
  session.updateMeta(
    makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/191_Feat.md",
      pipelineId: "pipe-loop-rewrite",
      loopCycleCount: 0,
    }) as SessionMeta,
  );

  let branchUserMessage = "docs/design/191_Feat.md 1 答";
  const menuCalls: { options: string[]; chosen?: string }[] = [];
  const hookCtx = {
    session,
    pi,
    ui: {
      notify: () => {},
      setStatus: () => {},
      // REAL TUI menu: production calls select(title, options[]); the
      // scripted user picks "Auto Review Plan" on the FIRST call and
      // dismisses (Esc → undefined) afterwards.
      select: async (titleOrOpts: unknown, maybeOptions?: unknown) => {
        const options = Array.isArray(maybeOptions)
          ? (maybeOptions as string[])
          : Array.isArray(titleOrOpts)
            ? (titleOrOpts as string[])
            : [];
        const call: { options: string[]; chosen?: string } = { options };
        if (menuCalls.length === 0) call.chosen = "Auto Review Plan";
        menuCalls.push(call);
        return call.chosen;
      },
      confirm: async () => false,
    },
    _ctx: {
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => [{ type: "message", message: { role: "user", content: branchUserMessage } }],
        getSessionFile: () => path.join(projectRoot, "owner.jsonl"),
        getSessionName: () => "owner",
        getHeader: () => undefined,
      },
    },
  };

  const hook = createAgentSettled(config);

  return {
    projectRoot,
    planDoc,
    config,
    session,
    rpcCount: () => rpcCount,
    lastPrompt: () => rpcPrompts[rpcPrompts.length - 1] ?? "",
    menuCalls,
    settle: async (userMessage?: string) => {
      if (userMessage !== undefined) branchUserMessage = userMessage;
      await hook.handler(hookCtx as never);
      await new Promise((r) => setTimeout(r, 5)); // flush late lifecycle timers
    },
    cleanup: () => {
      __resetSubagentsReady();
      __resetAuditDirPath();
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

function stateOf(h: LoopHarness): DesignReviewState {
  return h.session.getMeta()!.designReview as DesignReviewState;
}

/** Write the report for the CURRENT round from the identity the state bound. */
function writeReport(h: LoopHarness, verdict: "PASS" | "FAIL", issues: string[] = []) {
  const st = stateOf(h);
  const op = st.operation!;
  const lines = [
    "# Design Review Report",
    "",
    "**pipeline**: pipe-loop-rewrite",
    `**plan**: ${st.planDoc}`,
    `**round**: ${st.round}`,
    `**operation**: ${op.operationId}`,
    `**input hash**: ${op.inputHash}`,
    "",
    // 193 Phase 0: a valid report must be COMPLETE (four contract sections).
    "## Summary",
    "",
    `Round ${st.round}: reviewed ${st.planDoc} against the requirement document;`,
    "phase split, acceptance criteria and regression coverage are addressed.",
    "",
    "## Verdict",
    "",
    `**Design Review: ${verdict}**`,
    "",
    "## Issues",
    ...(issues.length > 0 ? issues.map((t, i) => `${i + 1}. ${t}`) : ["None"]),
    "",
    "## Recommendations",
    "",
    "Proceed with the plan as written; keep the per-phase acceptance criteria as",
    "the regression checklist.",
    "",
  ];
  fs.writeFileSync(deriveReportPath(st.planDoc, st.round), lines.join("\n"), "utf-8");
}

/** Apply the plan update exactly as the delivered update prompt requires. */
function writePlanUpdate(h: LoopHarness) {
  // 194 Phase 1: the update writes a revised plan body PLUS its standalone
  // receipt; the plan keeps no `## Design Review Update` protocol section.
  writeStandaloneUpdateDeliverables({
    planDoc: h.planDoc,
    state: stateOf(h),
    pipelineId: h.session.getMeta()!.pipelineId ?? "unknown",
  });
}

describe("192 full cycle (rewritten per plan Phase 5 task 3): ordinary plan + real TUI menu", () => {
  let h: LoopHarness;

  beforeEach(() => {
    markSubagentsReady();
    h = makeLoopHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("plan → menu 'Auto Review Plan' → FAIL → update → round-2 PASS → develop handoff, exact chain", async () => {
    // ── Step 1: ordinary plan settle pops the REAL menu and the user chooses
    // "Auto Review Plan": authorization is created by production code (not
    // hand-written), stage advances, and the review dispatches EXACTLY once.
    await h.settle();
    expect(h.menuCalls).toHaveLength(1);
    expect(h.menuCalls[0]!.options).toContain("Auto Review Plan");
    const meta1 = h.session.getMeta()!;
    expect(meta1.currentStage).toBe("design-review");
    const st1 = stateOf(h);
    expect(st1.authorizationSource).toBe("menu");
    expect(st1.phase).toBe("review_running");
    expect(st1.round).toBe(1);
    expect(st1.operation?.kind).toBe("review");
    const reviewOp1 = st1.operation!.operationId;
    expect(st1.operation?.agentId).toBe("agent-loop-1"); // REAL id from bus
    expect(h.rpcCount()).toBe(1);
    // D02: the menu choice is the authorization — no confirmation marker
    expect(fs.readFileSync(h.planDoc, "utf-8")).not.toContain("## 用户确认");

    // ── Step 2: FAIL report (identity from the running state) is consumed
    // through the real hook → routed to plan + update dispatched exactly once.
    writeReport(h, "FAIL", ["Missing error handling", "Incomplete API contract"]);
    await h.settle();
    expect(h.rpcCount()).toBe(2);
    const meta2 = h.session.getMeta()!;
    expect(meta2.currentStage).toBe("plan");
    const st2 = stateOf(h);
    expect(st2.phase).toBe("update_running");
    expect(st2.operation?.kind).toBe("update");
    const updateOp = st2.operation!.operationId;
    expect(updateOp).not.toBe(reviewOp1); // kinds/ops never conflated (F01)
    expect(st2.reviewInputReceipt?.reportHash).toBe(
      computeHash(fs.readFileSync(deriveReportPath(h.planDoc, 1), "utf-8")),
    );
    expect(st2.reviewInputReceipt?.issueIds).toEqual(["1", "2"]);
    // The update prompt carries the exact shipped contract text + report path.
    expect(h.lastPrompt()).toContain("Design Review Update");
    expect(h.lastPrompt()).toContain(st2.reviewInputReceipt!.reportDoc);
    // NO second menu for the authorized update (isolation property):
    expect(h.menuCalls).toHaveLength(1);

    // ── Step 3: real plan update → consumed → round-2 review dispatched once.
    writePlanUpdate(h);
    await h.settle();
    expect(h.rpcCount()).toBe(3);
    const meta3 = h.session.getMeta()!;
    expect(meta3.currentStage).toBe("design-review");
    const st3 = stateOf(h);
    expect(st3.round).toBe(2);
    expect(st3.phase).toBe("review_running");
    expect(st3.operation?.kind).toBe("review");
    const reviewOp2 = st3.operation!.operationId;
    expect(reviewOp2).not.toBe(reviewOp1); // fresh operation per round
    expect(st3.reviewInputReceipt).toBeUndefined(); // finite per-round receipt
    expect(h.menuCalls).toHaveLength(1);

    // ── Step 4: round-2 PASS → approval + develop + handoff RPC + finished.
    writeReport(h, "PASS");
    await h.settle();
    expect(h.rpcCount()).toBe(4);
    const meta4 = h.session.getMeta()!;
    expect(meta4.currentStage).toBe("develop");
    const st4 = stateOf(h);
    expect(st4.phase).toBe("finished");
    expect(st4.approval?.reviewOperationId).toBe(reviewOp2);
    expect(st4.operation?.kind).toBe("develop-handoff");
    const handoffOp = st4.operation!.operationId;
    expect(new Set([reviewOp1, updateOp, reviewOp2, handoffOp]).size).toBe(4); // unique ops
    expect(st4.operation?.dispatchEvidence).toBe("trusted_id");
    // The round-2 report hash matches the on-disk bytes exactly.
    expect(st4.approval?.reportHash).toBe(
      computeHash(fs.readFileSync(deriveReportPath(h.planDoc, 2), "utf-8")),
    );
    // Takeover released: classify says ordinary flow again.
    expect(classifyDesignReviewFlow(meta4).kind).toBe("ordinary");

    // ── Budget accounting through the cycle (production values, pinned):
    // menu visit design-review (0), FAIL routing plan (1), update consumption
    // design-review (1), PASS develop (0): loopCycleCount tracks the LAST
    // visited stage's repetitions exactly.
    expect(meta4.loopCycleCount).toBe(0);

    // Replay settles after finish: ZERO extra RPC / menu.
    await h.settle();
    await h.settle();
    expect(h.rpcCount()).toBe(4);
    expect(h.menuCalls).toHaveLength(1);
  });
});

// ─── coordinator-level strong successor cases (old any-of cases replaced) ────

function createMockSession(meta: SessionMeta) {
  let currentMeta = { ...meta };
  return {
    getMeta: () => currentMeta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      currentMeta = { ...currentMeta, ...patch };
      return currentMeta;
    },
    updateMetaVerified: (
      patch: Partial<SessionMeta>,
      expected: import("../../core/session-state").MetaCommitExpectation,
    ): import("../../types").ReliableMetaCommitResult => {
      const conflict = matchCommitExpectation(currentMeta, expected);
      if (conflict) return { status: "conflict", reason: conflict };
      currentMeta = { ...currentMeta, ...patch };
      return { status: "persisted", meta: currentMeta };
    },
  };
}

describe("192 successor cases replacing the retired any-of assertions", () => {
  let projectRoot: string;
  let planDoc: string;
  let planHash: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-loop-successor-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "plan.md");
    fs.writeFileSync(planDoc, "# Plan\nv1\n", "utf-8");
    planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
  });

  afterEach(() => {
    __resetAuditDirPath();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function reviewRunningCtx(triggerMeta?: Partial<SessionMeta>): { ctx: CoordinatorContext; meta: SessionMeta } {
    const base = createInitialState(planDoc, "menu", planHash, undefined, {
      pipelineId: "pipe-successor",
    });
    const meta = makeTestMeta({
      currentStage: "design-review",
      pipelineId: "pipe-successor",
      designReview: {
        ...base,
        phase: "review_running",
        round: 1,
        operation: boundReviewOperation("op-successor-1", planHash),
      },
      loopCycleCount: 0,
      ...triggerMeta,
    });
    return {
      ctx: {
        config: makeTestConfig({ projectRoot }),
        session: createMockSession(meta),
        ui: { notify: () => {} },
        pi: { sendUserMessage: () => {} },
        spawnOverride: async () => ({
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: "agent-successor",
          dispatchOutcome: "spawned_id" as const,
        }),
      },
      meta,
    };
  }

  it("R1 regression (strong): config without designReview state → not-applicable, meta untouched", async () => {
    const meta = makeTestMeta({ currentStage: "plan" });
    const ctx: CoordinatorContext = {
      config: makeTestConfig({ projectRoot }),
      session: createMockSession(meta),
      ui: { notify: () => {} },
    };
    const result = await coordinateDesignReview(ctx, meta, "settle");
    expect(result.status).toBe("not-applicable");
    expect(ctx.session.getMeta()).toEqual(meta); // zero mutation
  });

  it("H-1 successor (strong): PASS row + real issues → EXACTLY routed to plan, not any-of", async () => {
    const { ctx, meta } = reviewRunningCtx();
    // reviewReportContent forces the `None` sentinel whenever the verdict is
    // PASS, so the H-1 shape (canonical PASS row AND non-empty issues) must
    // be written explicitly — this is exactly the contradiction the verifier
    // must resolve as FAIL (issues precedence).
    const report = [
      "# Design Review Report",
      "",
      "**pipeline**: pipe-successor",
      `**plan**: ${planDoc}`,
      "**round**: 1",
      "**operation**: op-successor-1",
      `**input hash**: ${planHash}`,
      "",
      "## Summary",
      "",
      "Reviewed the plan against the requirement document; the two open problems",
      "below are concrete defects, not preferences.",
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
      "",
      "## Issues",
      "",
      "1. Critical bug in implementation",
      "2. Missing documentation",
      "",
      "## Recommendations",
      "",
      "Fix both issues before implementation starts.",
      "",
    ].join("\n");
    fs.writeFileSync(deriveReportPath(planDoc, 1), report, "utf-8");
    const result = await coordinateDesignReview(ctx, meta, "settle");
    // Issues take precedence: exact routing to plan (the old file accepted
    // "pending" as well; that is impossible for a properly bound operation).
    expect(result).toEqual({ status: "handled", action: "routed", toStage: "plan" });
    const after = ctx.session.getMeta()!.designReview!;
    expect(after.phase).toBe("update_running");
    expect(after.operation?.kind).toBe("update");
    expect(after.reviewInputReceipt?.issueIds).toEqual(["1", "2"]);
  });

  it("N-1 successor (strong): Summary-prose PASS with real issues → EXACTLY routed to plan (never pass_ready)", async () => {
    const { ctx, meta } = reviewRunningCtx();
    const report = [
      "# Design Review Report",
      "",
      "**pipeline**: pipe-successor",
      `**plan**: ${planDoc}`,
      "**round**: 1",
      "**operation**: op-successor-1",
      `**input hash**: ${planHash}`,
      "",
      "## Summary",
      "The review found that **Design Review: PASS** criteria were mostly met.",
      "",
      "## Verdict",
      "",
      "**Design Review: FAIL**",
      "",
      "## Issues",
      "",
      "1. Minor documentation gap",
      "",
      "## Recommendations",
      "",
      "Close the documentation gap before the next phase starts.",
      "",
    ].join("\n");
    fs.writeFileSync(deriveReportPath(planDoc, 1), report, "utf-8");
    const result = await coordinateDesignReview(ctx, meta, "settle");
    expect(result).toEqual({ status: "handled", action: "routed", toStage: "plan" });
    expect(ctx.session.getMeta()!.designReview!.phase).not.toBe("pass_ready");
  });

  it("N-1t successor (strong): prose PASS + None issues + no canonical conclusion row → EXACTLY verify_failed", async () => {
    const { ctx, meta } = reviewRunningCtx();
    const report = [
      "# Design Review Report",
      "",
      "**pipeline**: pipe-successor",
      `**plan**: ${planDoc}`,
      "**round**: 1",
      "**operation**: op-successor-1",
      `**input hash**: ${planHash}`,
      "",
      "## Summary",
      "The review concluded the criteria are acceptable.",
      "",
      // 193 Phase 0: the Verdict section is present but carries NO canonical
      // conclusion row, so the defect is exactly "no recognized conclusion".
      "## Verdict",
      "",
      "Overall acceptable, subject to the noted follow-ups.",
      "",
      "## Issues",
      "",
      "None",
      "",
      "## Recommendations",
      "",
      "Keep the current plan structure.",
      "",
    ].join("\n");
    fs.writeFileSync(deriveReportPath(planDoc, 1), report, "utf-8");
    const result = await coordinateDesignReview(ctx, meta, "settle");
    // No canonical conclusion line: invalid deliverable → normal verify-fail
    // budget signal (the old file accepted any pending + typeof reason).
    expect(result.status === "handled" && result.action === "verify_failed").toBe(true);
    expect(ctx.session.getMeta()!.designReview!.phase).toBe("review_running"); // no transition
  });

  it("budget successor (strong): at-cap FAIL → EXACTLY frozen with budget_exceeded, phase/report untouched", async () => {
    const { ctx, meta } = reviewRunningCtx({ loopCycleCount: 5 });
    fs.writeFileSync(
      deriveReportPath(planDoc, 1),
      reviewReportContent({
        pipelineId: "pipe-successor",
        planDoc,
        round: 1,
        operationId: "op-successor-1",
        inputHash: planHash,
        verdict: "FAIL",
        issues: ["Some defect"],
      }),
      "utf-8",
    );
    const result = await coordinateDesignReview(ctx, meta, "settle");
    expect(result).toEqual({ status: "handled", action: "frozen", reason: "budget_exceeded" });
    const after = ctx.session.getMeta()!;
    expect(after.designReview!.phase).toBe("review_running");
    expect(after.currentStage).toBe("design-review");
    // The frozen verdict must not consume the report or dispatch.
    expect(after.designReview!.operation?.kind).toBe("review");
  });
});

// 193 Phase 0 (test hygiene): frozen-with-pending fixtures arm real-timer
// decision-retry backoff chains (5s→60s). Clear them at file end so they can
// never leak across test files in the single `bun test` process.
afterAll(() => {
  clearAllDecisionTimers();
});
