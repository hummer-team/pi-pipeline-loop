/**
 * 192 Phase 3 (K02/F05): agent-settled HOOK chain wiring tests — driven
 * through the real createAgentSettled handler (not the coordinator directly),
 * proving the normal chain `agent-settled → runVerification → consume` with:
 * - valid FAIL report consumed through the hook → routed to plan update,
 *   NO ordinary confirm marker / menu involved (update isolation);
 * - pure-chat settle (non-pipeline last user message) cannot consume the
 *   report (source gate before domain consumption);
 * - child sessions never consume or mutate the authorized loop;
 * - PASS consumption enters the develop-handoff protocol (takeover retained
 *   when the dispatch channel is provably unavailable).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { SessionMeta, DesignReviewState } from "../../types";
import { createAgentSettled } from "../../core/agent-settled";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
} from "../../core/design-review/state";
import { makeTestConfig, makeTestMeta, reviewReportContent } from "../helpers";

const OP_ID = "op-hook-review-1";

describe("192 Phase 3: agent-settled shared-verification chain", () => {
  let projectRoot: string;
  let planDoc: string;
  let planHash: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-hook-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "190_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\nv1\n", "utf-8");
    planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function reviewRunningMeta(): SessionMeta {
    const base = createInitialState(planDoc, "menu", planHash, "/tmp/owner.jsonl", {
      pipelineId: "pipe-test-001",
    });
    return makeTestMeta({
      currentStage: "design-review",
      requirementDoc: "docs/190_Feat.md",
      designReview: {
        ...base,
        phase: "review_running",
        operation: {
          operationId: OP_ID,
          kind: "review",
          stageVisitId: 1000,
          attempt: 1,
          dispatchState: "dispatched",
          agentId: "agent-child-1",
          inputHash: planHash,
          round: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      loopCycleCount: 0,
    });
  }

  function makeHookCtx(meta: SessionMeta, opts?: { lastUserMessage?: string; child?: boolean }) {
    const branch: unknown[] = [];
    if (opts?.lastUserMessage !== undefined) {
      branch.push({
        type: "message",
        message: { role: "user", content: opts.lastUserMessage },
      });
    }
    let current = meta;
    const notifications: string[] = [];
    const ctx: any = {
      session: {
        getMeta: () => current,
        updateMeta: (patch: Partial<SessionMeta>) => {
          current = { ...current, ...patch };
          return current;
        },
        updateMetaVerified: (
          patch: Partial<SessionMeta>,
          _expected: unknown,
        ) => {
          current = { ...current, ...patch };
          return { status: "persisted", meta: current };
        },
      },
      ui: {
        notify: (msg: string) => { notifications.push(msg); },
        setStatus: () => {},
        confirm: async () => { throw new Error("confirm gate must not open for authorized flows"); },
        select: async () => { throw new Error("menu must not open for authorized flows"); },
      },
      _ctx: {
        sessionManager: {
          getBranch: () => branch,
          getEntries: () => [],
          getSessionFile: () => "/tmp/owner.jsonl",
          getSessionName: () => (opts?.child ? "design-review-agent#a1b2c3d4" : "owner"),
          getHeader: () => (opts?.child ? { parentSession: "/tmp/owner.jsonl" } : undefined),
        },
      },
      notifications,
    };
    return ctx;
  }

  it("valid FAIL report is consumed through the hook; NO marker/menu and no ordinary advance", async () => {
    fs.writeFileSync(deriveReportPath(planDoc, 1), reviewReportContent({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: planHash,
      verdict: "FAIL",
      issues: ["Missing error handling"],
    }), "utf-8");

    const meta = reviewRunningMeta();
    const ctx = makeHookCtx(meta, { lastUserMessage: "" });
    const hook = createAgentSettled(makeTestConfig({ projectRoot }));
    await hook.handler(ctx);

    const after: SessionMeta = ctx.session.getMeta();
    // FAIL → routed to plan for update through the domain consumption
    expect(after.currentStage).toBe("plan");
    const state = after.designReview as DesignReviewState;
    expect(state.phase).toBe("update_running");
    expect(state.operation?.kind).toBe("update");
    expect(state.operation?.operationId).not.toBe(OP_ID);
    expect(state.reviewInputReceipt?.reviewIdentity.operationId).toBe(OP_ID);
    // the plan document got NO human-confirm marker from this settle
    const planTextNow = fs.readFileSync(planDoc, "utf-8");
    expect(planTextNow).toBe("# Plan\nv1\n");
    // no crash from the tripwire confirm/select (they were never called)
  });

  it("pure-chat settle does NOT consume the report (source gate first)", async () => {
    fs.writeFileSync(deriveReportPath(planDoc, 1), reviewReportContent({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: planHash,
      verdict: "FAIL",
      issues: ["Missing error handling"],
    }), "utf-8");

    const meta = reviewRunningMeta();
    const ctx = makeHookCtx(meta, { lastUserMessage: "what is the weather today?" });
    const hook = createAgentSettled(makeTestConfig({ projectRoot }));
    await hook.handler(ctx);

    const after: SessionMeta = ctx.session.getMeta();
    expect(after.currentStage).toBe("design-review"); // untouched
    expect(after.designReview?.phase).toBe("review_running");
  });

  it("child session settle never consumes or mutates the authorized loop", async () => {
    fs.writeFileSync(deriveReportPath(planDoc, 1), reviewReportContent({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: planHash,
      verdict: "FAIL",
      issues: ["Missing error handling"],
    }), "utf-8");

    const meta = reviewRunningMeta();
    const ctx = makeHookCtx(meta, { child: true, lastUserMessage: "" });
    const hook = createAgentSettled(makeTestConfig({ projectRoot }));
    await hook.handler(ctx);

    const after: SessionMeta = ctx.session.getMeta();
    expect(after.currentStage).toBe("design-review");
    expect(after.designReview?.phase).toBe("review_running");
  });

  it("valid PASS report: hook drives the DR192-01 handoff (takeover retained when channel unavailable)", async () => {
    fs.writeFileSync(deriveReportPath(planDoc, 1), reviewReportContent({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: planHash,
      verdict: "PASS",
    }), "utf-8");

    const meta = reviewRunningMeta();
    const ctx = makeHookCtx(meta, { lastUserMessage: "" });
    const hook = createAgentSettled(makeTestConfig({ projectRoot }));
    await hook.handler(ctx);

    const after: SessionMeta = ctx.session.getMeta();
    const state = after.designReview as DesignReviewState;
    // Approval + handoff persisted and stage moved…
    expect(after.currentStage).toBe("develop");
    expect(state.approval?.reviewOperationId).toBe(OP_ID);
    // …but WITHOUT a trusted dispatch receipt the loop must stay pass_ready
    // (takeover retained) and NEVER finished (DR192-01).
    expect(state.phase).toBe("pass_ready");
    expect(state.operation?.kind).toBe("develop-handoff");
    expect(state.operation?.agentId).toBeUndefined();
    // no develop executor double dispatch happened at the hook level
  });
});
