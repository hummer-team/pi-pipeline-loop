/**
 * 192 Phase 5 (K11/F08/DR192-01): continuous design-review loop driven
 * through the REAL agent-settled hook chain in ONE session.
 *
 * - single session/meta object; advancement ONLY via hook runs;
 * - the RPC I/O boundary is the only mock (fake bus replies with REAL ids);
 * - fixtures write report/plan FILES from the prompts actually delivered;
 * - DR192-01 breakpoints injected mid-chain: interrupted before the handoff
 *   RPC (provable not-sent), unverifiable RPC window (unknown), persisted
 *   receipt + failed terminal commit; each asserts exact RPC deltas, approval,
 *   round and visit counts — never "any of pending/advanced".
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { clearAllDecisionTimers } from "../../core/flow-state";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionMeta, DesignReviewState, PipelineConfig } from "../../types";
import { createAgentSettled } from "../../core/agent-settled";
import { createSessionState } from "../../core/session-state";
import { __resetSharedStateDir } from "../../core/session-state";
import { computeHash, deriveReportPath, classifyDesignReviewFlow, createInitialState } from "../../core/design-review/state";
import { markSubagentsReady, __resetSubagentsReady } from "../../utils/subagent-availability";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, writeStandaloneUpdateDeliverables, deployDispatchAssets } from "../helpers";

// ─── harness ─────────────────────────────────────────────────────────────────

type Harness = {
  projectRoot: string;
  planDoc: string;
  config: PipelineConfig;
  session: ReturnType<typeof createSessionState>;
  hook: ReturnType<typeof createAgentSettled>;
  hookCtx: Record<string, unknown>;
  /** Owner identity switcher for the child→owner matrix (192 issue-6). */
  sessionIdentity: { file: string; name: string; header?: Record<string, unknown> };
  rpcCount: () => number;
  lastPrompt: () => string;
  failFinishOnce: { value: boolean };
  /** 192 issue-6: one-shot strict-commit failure for ANY designReview patch. */
  failAnyCommitOnce: { value: boolean };
  /** "reply" = normal; "silent" = never answer; "reject" = explicit rejection;
   *  "late" = reply queued until flushLateReplies() (late callback). */
  busMode: { value: "reply" | "silent" | "reject" | "late" };
  /** Deliver all queued "late" replies and let timers settle. */
  flushLateReplies: () => Promise<void>;
  settle: (userMessage?: string) => Promise<void>;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dr-hook-loop-"));
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "agents"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".pi", "audit"), { recursive: true });
  const planDoc = path.join(projectRoot, "docs", "191_Feat_plan.md");
  fs.writeFileSync(planDoc, "# Plan\ninitial design\n", "utf-8");
  // 192 issue-6: the requirement doc must exist for the direct-entry gate
  // (drift owner-confirm re-authorisation runs the production gate).
  fs.writeFileSync(path.join(projectRoot, "docs", "191_Feat.md"), "# Requirements\nx\n", "utf-8");

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
  // 194 Phase 2: the resource preflight runs on this harness's REAL spawn
  // path, so ship the skills/template assets a deployed project has.
  deployDispatchAssets(config);
  // develop becomes terminal in the harness so post-finish replay settles do
  // NOT auto-advance into review and pollute RPC counts.
  config.stages["develop"] = { ...config.stages["develop"]!, nextStage: null };
  void initAuditLog(config);

  const rpcPrompts: string[] = [];
  let rpcCount = 0;
  let nextId = 0;
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const failFinishOnce = { value: false };
  // 192 issue-6: one-shot STRICT-COMMIT failure for ANY designReview patch.
  // Simulates the shared meta store write failing (unavailable) so the
  // fail-closed window and later recovery are exercised in the real chain.
  const failAnyCommitOnce = { value: false };
  const busMode = { value: "reply" as "reply" | "silent" | "reject" | "late" };
  // "late": replies are QUEUED until flushLateReplies() delivers them.
  const lateQueue: Array<{ channel: string; payload: unknown }> = [];

  // REAL session adapter (local entries + shared meta.json under .pi/audit)
  const entries: unknown[] = [];
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
          if (busMode.value === "silent") return; // never answers → unknown window
          if (busMode.value === "late") {
            // The bus goes quiet for now; the reply is delivered only when
            // the test flushes it (late callback semantics).
            lateQueue.push({
              channel: `subagents:rpc:spawn:reply:${payload.requestId}`,
              payload: { success: true, data: { id } },
            });
            return;
          }
          const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
          if (busMode.value === "reject") {
            // explicit rejection: provably not dispatched via RPC; the
            // followUp fallback channel then carries NO agentId (unknown).
            setTimeout(() => {
              for (const h of handlers.get(replyChannel) ?? []) {
                h({ success: false, error: "spawn_rejected" });
              }
            }, 0);
            return;
          }
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
    sendUserMessage: (_m: string) => { /* owner followUp channel present but only used by fallback */ },
  };
  const adapterCtx = {
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
    },
  };
  const session = createSessionState(pi as never, adapterCtx as never, {
    projectRoot,
    auditDir: ".pi/audit",
  });
  // Wrap to allow injecting a ONE-SHOT terminal-commit failure (DR192-01 B)
  // and a ONE-SHOT any-designReview-commit failure (192 issue-6 shared failure).
  const origVerified = session.updateMetaVerified!;
  session.updateMetaVerified = (patch, expected) => {
    if (patch.designReview?.phase === "finished" && failFinishOnce.value) {
      failFinishOnce.value = false;
      return { status: "unavailable", reason: "injected_finish_failure" };
    }
    if (patch.designReview !== undefined && failAnyCommitOnce.value) {
      failAnyCommitOnce.value = false;
      return { status: "unavailable", reason: "injected_shared_failure" };
    }
    return origVerified.call(session, patch, expected);
  };

  const initial = makeTestMeta({
    currentStage: "design-review",
    requirementDoc: "docs/191_Feat.md",
    pipelineId: "pipe-loop-1",
    loopCycleCount: 0,
  });
  session.updateMeta(initial);

  let branchUserMessage = "docs/191_Feat.md 1 答";
  // Overridable owner identity (192 issue-6: child→owner matrix switches the
  // session file/role between settles on the SAME shared meta store).
  const sessionIdentity = { file: path.join(projectRoot, "owner.jsonl"), name: "owner", header: undefined as Record<string, unknown> | undefined };
  const hookCtx = {
    session,
    pi,
    ui: {
      notify: () => {},
      setStatus: () => {},
      select: async () => undefined,
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
    sessionIdentity,
    rpcCount: () => rpcCount,
    lastPrompt: () => rpcPrompts[rpcPrompts.length - 1] ?? "",
    failFinishOnce,
    failAnyCommitOnce,
    busMode,
    flushLateReplies: () => {
      const pending = lateQueue.splice(0, lateQueue.length);
      for (const { channel, payload } of pending) {
        for (const h of handlers.get(channel) ?? []) h(payload);
      }
      // let any writeback/terminal timers run
      return new Promise((r) => setTimeout(r, 5));
    },
    settle: async (userMessage?: string) => {
      if (userMessage !== undefined) branchUserMessage = userMessage;
      // ONE hook run; the RPC reply (setTimeout 0) is awaited inside the
      // spawn call, so writeback completes within this handler invocation.
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

// ─── artifact helpers ---------------------------------------------------------

function stateOf(h: Harness): DesignReviewState {
  return h.session.getMeta()!.designReview as DesignReviewState;
}

function authorizeReview(h: Harness) {
  const planHash = computeHash(fs.readFileSync(h.planDoc, "utf-8"));
  const dr = createInitialState(h.planDoc, "menu", planHash, undefined, {
    pipelineId: "pipe-loop-1",
    requirementDoc: "docs/191_Feat.md",
  });
  h.session.updateMeta({ currentStage: "design-review", designReview: dr });
}

function writeReport(h: Harness, verdict: "PASS" | "FAIL", issues: string[] = []) {
  const st = stateOf(h);
  const op = st.operation!;
  const lines = [
    "# Design Review Report",
    "",
    "**pipeline**: pipe-loop-1",
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

function writePlanUpdate(h: Harness) {
  // 194 Phase 1: the update writes a revised plan body PLUS its standalone
  // receipt; the plan keeps no `## Design Review Update` protocol section.
  writeStandaloneUpdateDeliverables({
    planDoc: h.planDoc,
    state: stateOf(h),
    pipelineId: h.session.getMeta()!.pipelineId ?? "unknown",
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("192 Phase 5: continuous hook-driven design-review loop", () => {
  let h: Harness;

  beforeEach(() => {
    markSubagentsReady();
    h = makeHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("single PASS chain: review dispatch → PASS → handoff → finished (real adapter, one RPC each)", async () => {
    authorizeReview(h);
    await h.settle(); // review_ready → review_running dispatch
    expect(stateOf(h).phase).toBe("review_running");
    expect(stateOf(h).operation?.kind).toBe("review");
    expect(stateOf(h).operation?.agentId).toBe("agent-rpc-1");
    expect(h.lastPrompt()).toContain(h.planDoc); // plan path + round contract
    const reviewOpId = stateOf(h).operation!.operationId;

    writeReport(h, "PASS");
    await h.settle(); // consume PASS → approval + develop + handoff RPC + finished
    expect(h.rpcCount()).toBe(2);
    const meta = h.session.getMeta()!;
    expect(meta.currentStage).toBe("develop");
    expect(stateOf(h).phase).toBe("finished");
    expect(stateOf(h).approval?.reviewOperationId).toBe(reviewOpId);
    expect(stateOf(h).operation?.kind).toBe("develop-handoff");
    expect(stateOf(h).operation?.dispatchEvidence).toBe("trusted_id");
    expect(classifyDesignReviewFlow(meta).kind).toBe("ordinary"); // takeover released

    // replay settles after finish: ordinary path, ZERO extra RPC
    await h.settle();
    await h.settle();
    expect(h.rpcCount()).toBe(2);
  });

  it("FAIL → authorized update (default template dispatched) → round-2 review → PASS", async () => {
    authorizeReview(h);
    await h.settle(); // review dispatch (rpc 1)
    expect(h.rpcCount()).toBe(1);
    writeReport(h, "FAIL", ["Missing error handling", "Incomplete API contract"]);

    await h.settle(); // consume FAIL → update dispatch (rpc 2) + plan stage
    expect(h.rpcCount()).toBe(2);
    const stFail = stateOf(h);
    expect(h.session.getMeta()!.currentStage).toBe("plan");
    expect(stFail.operation?.kind).toBe("update");
    expect(stFail.reviewInputReceipt?.issueIds).toEqual(["1", "2"]);
    // The update prompt came from the SAME selection chain (missing YAML key →
    // constants default): contains the exact section contract + report path.
    expect(h.lastPrompt()).toContain("Design Review Update");
    expect(h.lastPrompt()).toContain(stFail.reviewInputReceipt!.reportDoc);

    writePlanUpdate(h);
    await h.settle(); // update consumed → round 2 review dispatch (rpc 3)
    const st2 = stateOf(h);
    expect(st2.round).toBe(2);
    expect(st2.phase).toBe("review_running");
    expect(st2.operation?.kind).toBe("review");
    expect(st2.reviewInputReceipt).toBeUndefined(); // finite per-round receipt
    expect(h.rpcCount()).toBe(3);

    writeReport(h, "PASS");
    await h.settle(); // PASS → handoff (rpc 4) → finished
    expect(stateOf(h).phase).toBe("finished");
    expect(h.session.getMeta()!.currentStage).toBe("develop");
    expect(h.rpcCount()).toBe(4);
  });

  it("DR192-01 breakpoint: develop transition committed, handoff channel fails BEFORE RPC (provable not-sent) → resume dispatches the SAME handoff exactly once", async () => {
    authorizeReview(h);
    await h.settle(); // review rpc 1
    writeReport(h, "PASS");
    // Break the CHANNEL (not config): point develop agentPath at a missing
    // file — resolveAgentMention fails BEFORE any RPC → provable not-sent.
    const goodAgent = h.config.stages["develop"].agentPath;
    h.config.stages["develop"] = { ...h.config.stages["develop"]!, agentPath: "agents/deleted.md" };

    await h.settle(); // PASS consumed; handoff NOT dispatched
    expect(h.rpcCount()).toBe(1); // zero handoff RPC
    const stMid = stateOf(h);
    expect(h.session.getMeta()!.currentStage).toBe("develop"); // transition persisted
    expect(stMid.phase).toBe("pass_ready"); // takeover retained, NOT finished
    expect(stMid.operation?.kind).toBe("develop-handoff");
    expect(stMid.operation?.dispatchEvidence).toBe("confirmed_not_sent");
    const handoffId = stMid.operation!.operationId;
    const approvalId = stMid.approval?.reviewOperationId;
    const visits = JSON.stringify(h.session.getMeta()!.stageVisitOrder ?? null);

    // Recover the channel → resume: exactly ONE RPC for the SAME handoff
    h.config.stages["develop"] = { ...h.config.stages["develop"]!, agentPath: goodAgent };
    await h.settle();
    expect(h.rpcCount()).toBe(2); // one dispatch, no second channel
    const stEnd = stateOf(h);
    expect(stEnd.phase).toBe("finished");
    expect(stEnd.operation?.operationId).toBe(handoffId); // SAME op
    expect(stEnd.approval?.reviewOperationId).toBe(approvalId); // no re-approval
    expect(stEnd.round).toBe(1); // no round bump
    expect(JSON.stringify(h.session.getMeta()!.stageVisitOrder ?? null)).toBe(visits); // no extra visit
  });

  it("DR192-01 breakpoint: receipt persisted but terminal commit fails → re-entry finishes with ZERO extra RPC", async () => {
    authorizeReview(h);
    await h.settle(); // review rpc 1
    writeReport(h, "PASS");
    h.failFinishOnce.value = true;
    await h.settle(); // handoff rpc 2, receipt persisted, finish fails
    const st = stateOf(h);
    expect(st.phase).toBe("pass_ready"); // still under takeover
    expect(st.operation?.dispatchEvidence).toBe("trusted_id"); // receipt persisted
    const rpcs = h.rpcCount();
    expect(rpcs).toBe(2);

    await h.settle(); // re-entry: terminal-only completion
    expect(h.rpcCount()).toBe(rpcs); // RPC delta 0
    expect(stateOf(h).phase).toBe("finished");
    expect(stateOf(h).approval).toBeDefined(); // no second approval
  });

  it("DR192-01 breakpoint: handoff only via id-less fallback (unknown) → paused, automatic re-entry performs ZERO further dispatch", async () => {
    authorizeReview(h);
    await h.settle(); // review rpc 1 (replies normally)
    writeReport(h, "PASS");
    // RPC explicitly rejected → the followUp fallback sends WITHOUT an id:
    // fallback_no_id must be treated as an unverifiable window (K09), never
    // a trusted dispatch and never finished.
    h.busMode.value = "reject";
    await h.settle();
    const st = stateOf(h);
    expect(st.phase).toBe("paused");
    expect(st.pauseReason).toBe("unknown-dispatch");
    expect(st.operation?.kind).toBe("develop-handoff");
    expect(st.operation?.dispatchEvidence).toBe("unknown");
    expect(st.operation?.agentId).toBeUndefined();
    expect(h.session.getMeta()!.currentStage).toBe("develop"); // transition stands

    // Automatic re-entry (any trigger) must not blind-retry the handoff.
    const rpcs = h.rpcCount();
    await h.settle();
    await h.settle();
    expect(h.rpcCount()).toBe(rpcs); // RPC delta 0 (including fallback sends)
    expect(stateOf(h).phase).toBe("paused"); // still owner-verification pending
  });

  it("pure-chat settle never consumes the report; stage untouched", async () => {
    authorizeReview(h);
    await h.settle(); // review rpc 1
    writeReport(h, "FAIL", ["defect one"]);
    const before = h.rpcCount();
    await h.settle("what is the weather today?");
    expect(h.rpcCount()).toBe(before);
    expect(stateOf(h).phase).toBe("review_running");
    expect(h.session.getMeta()!.currentStage).toBe("design-review");
  });

  it("budget default 3: FAIL at cap → hook applies the REAL freeze (flowState blocked, report unconsumed)", async () => {
    authorizeReview(h);
    // consume two cycles first via direct state to reach the cap
    h.session.updateMeta({ loopCycleCount: 3 });
    await h.settle(); // review dispatch happens on review_ready (no budget check there? budget gate blocks it)
    // handleReviewReady budget-froze FIRST: assert real freeze, no review RPC
    expect(h.session.getMeta()!.flowState).toBe("blocked");
    expect(stateOf(h).phase).toBe("review_ready");
    expect(h.rpcCount()).toBe(0);
  });
});


// ─── 192 fix (issue 6): extended real-hook-chain matrices (plan Phase 5 task 4) ─
describe("192 issue-6: configured5 / drift-owner-confirm / child→owner / same-ms / shared-fail / late-callback", () => {
  let h: Harness;

  beforeEach(() => {
    markSubagentsReady();
    h = makeHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  // Budget-accounting reference for BOTH tests below, per recordStageVisit
  // semantics (src/utils/stage-visit.ts:42-74): loopCycleCount is a GLOBAL
  // counter that increments on every REVISIT of the target stage (already in
  // stageVisitOrder) and resets to 0 on a first visit. The chain starts with
  // an empty order, so the round-1 FAIL's "plan" transition and the round-2
  // review's "design-review" transition are first visits (count 0); the
  // round-2 FAIL / round-3 review revisits push it to 1 / 2, and the round-3
  // FAIL's "plan" REVISIT is the third increment → 3, exactly where the
  // default cap 3 freezes (cycleCount >= max) and cap 5 continues.
  it("configured maxLoopCycles=5 survives FOUR consecutive rounds (FAIL, FAIL, FAIL, PASS at round 4) — the exact chain default 3 freezes", async () => {
    // The paired default-3 test below freezes THIS chain at the round-3 FAIL;
    // proving continuation here is only meaningful against cap 3, so the
    // counters and the visit order are asserted at every step.
    h.config.maxLoopCycles = 5;
    authorizeReview(h);

    // round 1: review (rpc1) → FAIL → update (rpc2)
    await h.settle();
    expect(h.rpcCount()).toBe(1);
    writeReport(h, "FAIL", ["Defect one"]);
    await h.settle();
    expect(h.rpcCount()).toBe(2);
    expect(stateOf(h).round).toBe(1);
    expect(h.session.getMeta()!.loopCycleCount).toBe(0); // first "plan" visit
    const updateOp1 = stateOf(h).operation!.operationId;
    writePlanUpdate(h);

    // round 2: review (rpc3) → FAIL → update (rpc4)
    await h.settle();
    expect(h.rpcCount()).toBe(3);
    expect(stateOf(h).round).toBe(2);
    expect(h.session.getMeta()!.loopCycleCount).toBe(0); // first "design-review" visit
    writeReport(h, "FAIL", ["Defect two"]);
    await h.settle();
    expect(h.rpcCount()).toBe(4);
    expect(h.session.getMeta()!.loopCycleCount).toBe(1); // "plan" revisit #1
    const updateOp2 = stateOf(h).operation!.operationId;
    expect(updateOp2).not.toBe(updateOp1); // fresh update operation per round
    writePlanUpdate(h);

    // round 3: review (rpc5) → FAIL → update (rpc6) — cap 3 would freeze here
    await h.settle();
    expect(h.rpcCount()).toBe(5);
    expect(stateOf(h).round).toBe(3);
    expect(h.session.getMeta()!.loopCycleCount).toBe(2); // "design-review" revisit #1
    const reviewOp3 = stateOf(h).operation!.operationId;
    writeReport(h, "FAIL", ["Defect three"]);
    await h.settle();
    expect(h.rpcCount()).toBe(6); // NOT frozen: count 3 < configured cap 5
    const metaR3Fail = h.session.getMeta()!;
    expect(metaR3Fail.loopCycleCount).toBe(3); // "plan" revisit #2
    expect(metaR3Fail.flowState).not.toBe("blocked");
    expect(stateOf(h).phase).toBe("update_running");
    expect(stateOf(h).operation?.kind).toBe("update");
    const updateOp3 = stateOf(h).operation!.operationId;
    expect(updateOp3).not.toBe(updateOp2);
    writePlanUpdate(h);

    // round 4: review (rpc7) → PASS → handoff (rpc8) → finished
    await h.settle();
    expect(h.rpcCount()).toBe(7);
    expect(stateOf(h).round).toBe(4);
    expect(h.session.getMeta()!.loopCycleCount).toBe(4); // "design-review" revisit #2
    const reviewOp4 = stateOf(h).operation!.operationId;
    expect(reviewOp4).not.toBe(reviewOp3);
    writeReport(h, "PASS");
    await h.settle();
    expect(h.rpcCount()).toBe(8);
    // The terminal "develop" transition is a FIRST visit: it resets the global
    // counter to exactly 0 and appends the stage once (src/utils/stage-visit.ts:66-73).
    const metaEnd = h.session.getMeta()!;
    expect(stateOf(h).phase).toBe("finished");
    expect(metaEnd.currentStage).toBe("develop");
    expect(metaEnd.loopCycleCount).toBe(0);
    expect(metaEnd.stageVisitOrder).toEqual([
      "plan", "design-review", "plan", "design-review", "plan", "design-review", "develop",
    ]);
    expect(metaEnd.flowState).not.toBe("blocked");
    // approval bound to the round-4 review; every round's report kept distinct
    expect(stateOf(h).approval?.reviewOperationId).toBe(reviewOp4);
    for (const r of [1, 2, 3, 4]) {
      expect(fs.existsSync(deriveReportPath(h.planDoc, r))).toBe(true);
    }
    expect(classifyDesignReviewFlow(metaEnd).kind).toBe("ordinary");
  });

  it("default cap 3: the SAME real chain REALLY freezes at the round-3 FAIL revisit (no injected counter)", async () => {
    // No config override → coordinator's `?? 3` default applies
    // (src/core/design-review/coordinator.ts:844). This is the discriminating
    // pair for the configured-5 test above.
    authorizeReview(h);
    await h.settle(); // review r1 (rpc1)
    writeReport(h, "FAIL", ["Defect one"]);
    await h.settle(); // update r1 (rpc2)
    writePlanUpdate(h);
    await h.settle(); // review r2 (rpc3)
    writeReport(h, "FAIL", ["Defect two"]);
    await h.settle(); // update r2 (rpc4)
    writePlanUpdate(h);
    await h.settle(); // review r3 (rpc5)
    expect(stateOf(h).round).toBe(3);
    expect(h.session.getMeta()!.loopCycleCount).toBe(2);

    // Round-3 FAIL: the "plan" REVISIT reaches cycleCount 3 >= cap 3 →
    // recordStageVisit refuses, coordinator returns frozen, and the hook
    // applies the REAL freeze (agent-settled.ts:376-385 → freezeAndPrompt).
    writeReport(h, "FAIL", ["Defect three"]);
    await h.settle();
    const metaFrozen = h.session.getMeta()!;
    expect(metaFrozen.flowState).toBe("blocked");
    expect(metaFrozen.loopCycleCount).toBe(3); // counted for audit, transition refused
    expect(metaFrozen.stageVisitOrder).toEqual(["plan", "design-review", "plan", "design-review", "plan"]);
    expect(metaFrozen.currentStage).toBe("design-review"); // never moved to plan
    expect(h.rpcCount()).toBe(5); // NO update dispatch after the freeze
    // The round-3 FAIL state remains explainable/recoverable: the report is
    // still on disk UNCONSUMED and the review operation stays as it was.
    expect(fs.existsSync(deriveReportPath(h.planDoc, 3))).toBe(true);
    expect(stateOf(h).phase).toBe("review_running");
    expect(stateOf(h).operation?.kind).toBe("review");
    expect(stateOf(h).operation?.dispatchEvidence).toBe("trusted_id");
    expect(stateOf(h).reviewInputReceipt).toBeUndefined(); // receipt NOT forged on freeze

    // Automatic re-entry must not dispatch or double-count.
    await h.settle();
    expect(h.rpcCount()).toBe(5);
    expect(h.session.getMeta()!.loopCycleCount).toBe(3);
  });

  it("drift: PASS blocked → paused(drift) zero handoff; owner confirm → recompute hash/new operation/safe round → re-review PASS", async () => {
    const { executeDecision } = await import("../../core/flow-state");
    authorizeReview(h);
    await h.settle(); // review dispatch (rpc 1)
    const oldAuthId = stateOf(h).authorizationId;
    const oldPlanHash = stateOf(h).planHash!;
    const reviewOp1 = stateOf(h).operation!.operationId;
    writeReport(h, "PASS");

    // Owner edits the plan AFTER the review PASSed → plan-hash drift.
    const drifted = "# Plan\nOWNER-NEW DESIGN\n";
    fs.writeFileSync(h.planDoc, drifted, "utf-8");
    const driftedHash = computeHash(drifted);

    await h.settle(); // PASS consume → drift detected → paused(drift)
    const stP = stateOf(h);
    expect(stP.phase).toBe("paused");
    expect(stP.pauseReason).toBe("drift");
    expect(stP.operation?.kind).toBe("review"); // NEVER transitioned to develop
    expect(stP.operation?.dispatchEvidence).toBe("trusted_id");
    expect(h.rpcCount()).toBe(1); // ZERO handoff/develop RPCs
    expect(h.session.getMeta()!.currentStage).toBe("design-review");
    // the PASS report must NOT be deleted by the drift pause
    expect(fs.existsSync(deriveReportPath(h.planDoc, 1))).toBe(true);

    // Owner confirms a NEW re-review of the drifted plan through the
    // production decision path. choose_stage requires the frozen pipeline,
    // so the owner first aborts (decision menu "Abort & Exit" — which also
    // invalidates the old authorization), then re-enters design-review: the
    // direct gate recomputes hash, new authorization, safe round 2.
    const decisionCtx = {
      session: h.session,
      ui: {
        notify: () => {},
        select: async () => undefined,
        confirm: async () => true, // owner confirms "re-review new version"
      },
      _ctx: (h as unknown as { hookCtx: { _ctx: unknown } }).hookCtx._ctx,
    } as never;
    const metaPaused = h.session.getMeta()!;
    const abortRes = await executeDecision(decisionCtx, metaPaused, "abort", h.config, {});
    expect(abortRes.success).toBe(true);
    const afterAbort = h.session.getMeta()!;
    expect(afterAbort.designReview).toBeUndefined(); // old authorization fully invalidated
    expect(afterAbort.flowState).toBe("aborted");

    const res = await executeDecision(
      decisionCtx,
      afterAbort,
      "choose_stage",
      h.config,
      { targetStage: "design-review" } as never,
    );
    expect(res.success).toBe(true);
    const stNew = stateOf(h);
    expect(stNew.phase).toBe("review_ready");
    expect(stNew.authorizationId).not.toBe(oldAuthId); // NEW authorization
    expect(stNew.planHash).toBe(driftedHash); // hash RECOMPUTED from current bytes
    expect(stNew.planHash).not.toBe(oldPlanHash);
    expect(stNew.round).toBe(2); // safe round: scans existing round-1 report
    expect(stNew.reportDoc).toBe(deriveReportPath(h.planDoc, 2));
    expect(stNew.operation).toBeUndefined(); // no fabricated operation yet
    expect(h.rpcCount()).toBe(1); // entry alone dispatched nothing

    // Owner settle dispatches the NEW review bound to the recomputed hash.
    await h.settle();
    expect(h.rpcCount()).toBe(2);
    const stR2 = stateOf(h);
    expect(stR2.phase).toBe("review_running");
    expect(stR2.operation?.kind).toBe("review");
    expect(stR2.operation?.inputHash).toBe(driftedHash);
    expect(stR2.operation!.operationId).not.toBe(reviewOp1); // NEW operation

    // Round-2 PASS closes the loop.
    writeReport(h, "PASS");
    await h.settle(); // handoff (rpc 3) → finished
    expect(stateOf(h).phase).toBe("finished");
    expect(stateOf(h).approval?.reviewOperationId).toBe(stR2.operation!.operationId);
    expect(h.session.getMeta()!.currentStage).toBe("develop");
    expect(h.rpcCount()).toBe(3);
  });

  it("child settle is inert on the shared store; the owner settle then consumes (child→owner)", async () => {
    authorizeReview(h);
    await h.settle(); // owner dispatches review (rpc 1)
    writeReport(h, "FAIL", ["Missing error handling"]);

    // Switch the settle identity to a CHILD session pointing at the SAME
    // shared store: the child must not consume or mutate. (The hookCtx
    // closures read sessionIdentity's FIELDS, so mutate in place.)
    h.sessionIdentity.file = path.join(h.projectRoot, "kid.jsonl");
    h.sessionIdentity.name = "kid-runner";
    h.sessionIdentity.header = { parentSession: path.join(h.projectRoot, "owner.jsonl") };
    const beforeJson = JSON.stringify(stateOf(h));
    await h.settle();
    expect(JSON.stringify(stateOf(h))).toBe(beforeJson); // ZERO mutation
    expect(h.rpcCount()).toBe(1); // ZERO dispatch
    expect(stateOf(h).phase).toBe("review_running"); // not consumed by the child

    // Restore the owner identity (same shared store): exactly one
    // consumption, one update dispatch.
    h.sessionIdentity.file = path.join(h.projectRoot, "owner.jsonl");
    h.sessionIdentity.name = "owner";
    h.sessionIdentity.header = undefined;
    await h.settle();
    expect(h.rpcCount()).toBe(2);
    expect(stateOf(h).phase).toBe("update_running");
    expect(stateOf(h).operation?.kind).toBe("update");
  });

  it("same-millisecond visits: distinct operationIds with identical stageVisitId, no dedup swallow, correct rounds", async () => {
    // Pin the clock so the review visit and the plan/update visit land in the
    // SAME millisecond (stageVisitId collision). Identity (kind+operationId),
    // never the timestamp, must separate operations.
    const fixedNow = h.session.getMeta()!.stageStartTime ?? Date.now();
    const realNow = Date.now;
    Date.now = () => fixedNow;
    try {
      authorizeReview(h);
      await h.settle(); // review dispatch (rpc 1)
      const reviewOp = stateOf(h).operation!;
      writeReport(h, "FAIL", ["Defect A"]);
      await h.settle(); // FAIL consumed → update dispatch (rpc 2), same-ms visit
      const updateOp = stateOf(h).operation!;
      expect(updateOp.stageVisitId).toBe(reviewOp.stageVisitId); // genuinely same-ms
      expect(updateOp.operationId).not.toBe(reviewOp.operationId); // distinct identities
      expect(updateOp.kind).toBe("update");
      expect(h.rpcCount()).toBe(2);
      writePlanUpdate(h);
      await h.settle(); // update consumed → round-2 review dispatch (rpc 3)
      expect(h.rpcCount()).toBe(3);
      expect(stateOf(h).round).toBe(2);
      expect(stateOf(h).phase).toBe("review_running");
      expect(stateOf(h).operation!.operationId).not.toBe(reviewOp.operationId);
    } finally {
      Date.now = realNow;
    }
    // Real clock resumes and the chain still finishes.
    writeReport(h, "PASS");
    await h.settle(); // handoff (rpc 4)
    expect(stateOf(h).phase).toBe("finished");
    expect(h.rpcCount()).toBe(4);
  });

  it("shared-store commit failure → zero dispatch and unchanged state; next settle dispatches exactly once", async () => {
    authorizeReview(h);
    h.failAnyCommitOnce.value = true; // strict commit fails (shared store down)
    await h.settle();
    expect(h.rpcCount()).toBe(0); // fail-closed BEFORE any RPC
    expect(stateOf(h).phase).toBe("review_ready"); // nothing half-committed
    expect(stateOf(h).operation).toBeUndefined();
    // Recovery: the next settle performs the full commit + one dispatch.
    await h.settle();
    expect(h.rpcCount()).toBe(1);
    expect(stateOf(h).phase).toBe("review_running");
    expect(stateOf(h).operation?.agentId).toBe("agent-rpc-1");
  });

  it("late RPC callback: unknown-dispatch pause survives flush with ZERO re-dispatch and no fabricated trust", async () => {
    authorizeReview(h);
    // Bus goes quiet; the RPC reply arrives only AFTER the dispatch window
    // closed. A timed-out attempt is UNCONFIRMABLE → production records
    // evidence "unknown" and pauses for owner verification (K09/DR192-01).
    // The matrix point is what the LATE callback may NOT do.
    h.busMode.value = "late";
    await h.settle();
    const st = stateOf(h);
    expect(st.phase).toBe("paused");
    expect(st.pauseReason).toBe("unknown-dispatch");
    expect(st.operation?.dispatchEvidence).toBe("unknown");
    const rpcsAtPause = h.rpcCount();
    expect(rpcsAtPause).toBe(1); // exactly one emitted attempt

    // Late reply arrives: must NOT fabricate trusted_id, resume, or re-send.
    await h.flushLateReplies();
    expect(stateOf(h).phase).toBe("paused");
    expect(stateOf(h).pauseReason).toBe("unknown-dispatch");
    expect(stateOf(h).operation?.dispatchEvidence).toBe("unknown"); // never rewritten
    expect(stateOf(h).operation?.agentId).toBeUndefined(); // no id inferred from late bytes
    expect(h.rpcCount()).toBe(rpcsAtPause); // no re-dispatch on flush

    // Automatic re-entry also performs zero further dispatch (K09).
    await h.settle();
    expect(h.rpcCount()).toBe(rpcsAtPause);
    expect(stateOf(h).phase).toBe("paused");
  }, 30_000);

  it("three production entries share ONE live loop: resume(advance) dispatches the ready review, settle consumes PASS, resume takes over the not-sent handoff exactly once", async () => {
    // Plan Phase 5 task 4 "三种入口": the RESUME command entry
    // (dispatchAfterResume, src/commands/pipeline-start.ts:598) and the hook
    // settle entry must drive the SAME single business identity — no second
    // executor, no re-approval, no extra visit.
    const { dispatchAfterResume } = await import("../../commands/pipeline-start");
    authorizeReview(h);
    const notices: string[] = [];
    const fakeUi = { notify: (_c: unknown, msg: string) => { notices.push(String(msg)); } };

    // Entry 1 — production resume/advance on review_ready: dispatches exactly
    // one review (coordinator handleReviewReady accepts settle/advance,
    // src/core/design-review/coordinator.ts:209).
    await dispatchAfterResume(h.hookCtx as never, h.config, fakeUi as never, h.session.getMeta()!, h.planDoc);
    expect(h.rpcCount()).toBe(1);
    const stR = stateOf(h);
    expect(stR.phase).toBe("review_running");
    expect(stR.operation?.kind).toBe("review");
    expect(stR.operation?.agentId).toBe("agent-rpc-1");

    // Entry 2 — real hook settle consumes the PASS. The develop channel is
    // broken first, so the handoff is provably NOT sent (DR192-01 window A).
    writeReport(h, "PASS");
    const goodAgent = h.config.stages["develop"]!.agentPath;
    h.config.stages["develop"] = { ...h.config.stages["develop"]!, agentPath: "agents/deleted-192.md" };
    await h.settle();
    expect(h.rpcCount()).toBe(1); // zero handoff RPC while the channel is broken
    const stP = stateOf(h);
    expect(stP.phase).toBe("pass_ready");
    expect(stP.operation?.kind).toBe("develop-handoff");
    expect(stP.operation?.dispatchEvidence).toBe("confirmed_not_sent");
    expect(h.session.getMeta()!.currentStage).toBe("develop"); // transition stands
    const handoffId = stP.operation!.operationId;
    const approvalId = stP.approval?.reviewOperationId;
    const visits = JSON.stringify(h.session.getMeta()!.stageVisitOrder ?? null);

    // Entry 3 — production resume takeover on the develop stage with an
    // unfinished handoff operation: dispatches the SAME handoff exactly once
    // (pipeline-start.ts:613-646) and the ordinary develop spawn must NOT run.
    h.config.stages["develop"] = { ...h.config.stages["develop"]!, agentPath: goodAgent };
    await dispatchAfterResume(h.hookCtx as never, h.config, fakeUi as never, h.session.getMeta()!, h.planDoc);
    expect(h.rpcCount()).toBe(2); // one recovery dispatch, no second channel
    const stEnd = stateOf(h);
    expect(stEnd.phase).toBe("finished");
    expect(stEnd.operation?.operationId).toBe(handoffId); // SAME op
    expect(stEnd.approval?.reviewOperationId).toBe(approvalId); // no re-approval
    expect(stEnd.round).toBe(1); // no round bump
    expect(JSON.stringify(h.session.getMeta()!.stageVisitOrder ?? null)).toBe(visits); // no extra visit
    expect(classifyDesignReviewFlow(h.session.getMeta()!).kind).toBe("ordinary");
    // The resume entry reported the takeover through its own notify path.
    expect(notices.length).toBeGreaterThan(0);
  });
});

// 193 Phase 0 (test hygiene): frozen-with-pending fixtures arm real-timer
// decision-retry backoff chains (5s→60s). Clear them at file end so they can
// never leak across test files in the single `bun test` process.
afterAll(() => {
  clearAllDecisionTimers();
});
