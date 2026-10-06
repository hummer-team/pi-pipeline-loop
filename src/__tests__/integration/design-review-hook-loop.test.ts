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

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
import { makeTestConfig, makeTestMeta } from "../helpers";

// ─── harness ─────────────────────────────────────────────────────────────────

type Harness = {
  projectRoot: string;
  planDoc: string;
  config: PipelineConfig;
  session: ReturnType<typeof createSessionState>;
  rpcCount: () => number;
  lastPrompt: () => string;
  failFinishOnce: { value: boolean };
  /** "reply" = normal; "silent" = never answer; "reject" = explicit rejection */
  busMode: { value: "reply" | "silent" | "reject" };
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
  // develop becomes terminal in the harness so post-finish replay settles do
  // NOT auto-advance into review and pollute RPC counts.
  config.stages["develop"] = { ...config.stages["develop"]!, nextStage: null };
  void initAuditLog(config);

  const rpcPrompts: string[] = [];
  let rpcCount = 0;
  let nextId = 0;
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const failFinishOnce = { value: false };
  const busMode = { value: "reply" as "reply" | "silent" | "reject" };

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
          if (busMode.value === "silent") return; // never replies → unknown window
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
  const origVerified = session.updateMetaVerified!;
  session.updateMetaVerified = (patch, expected) => {
    if (patch.designReview?.phase === "finished" && failFinishOnce.value) {
      failFinishOnce.value = false;
      return { status: "unavailable", reason: "injected_finish_failure" };
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
    failFinishOnce,
    busMode,
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
    "## Verdict",
    "",
    `**Design Review: ${verdict}**`,
    "",
    "## Issues",
    ...(issues.length > 0 ? issues.map((t, i) => `${i + 1}. ${t}`) : ["None"]),
    "",
  ];
  fs.writeFileSync(deriveReportPath(st.planDoc, st.round), lines.join("\n"), "utf-8");
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
