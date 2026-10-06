/**
 * 192 Phase 4: DR192-01 recovery-window assertions + real budget freeze.
 *
 * Six-window matrix (coordinator/RPC level, RPC = spawnOverride call count):
 * 1. PASS transition reliably committed, interrupted BEFORE RPC (confirmed
 *    not-sent) → resume still under takeover; same handoff dispatches exactly
 *    once; approval/round/visit unchanged.
 * 2. send-intent only (no provable dispatch state) → pause; automatic resume
 *    performs ZERO RPC.
 * 3. trusted receipt persisted but finished failed → re-entry completes ONLY
 *    the terminal commit; RPC delta 0 (cycle file covers; asserted again here
 *    through the resume entry).
 * 4. After reliable finish → develop normal lifecycle (classify → ordinary).
 * Budget: default 3 freezes via the HOOK (flowState actually blocked), not
 * just a returned string.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { SessionMeta, DesignReviewState, DesignReviewOperation } from "../../types";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
  classifyDesignReviewFlow,
  isDevelopHandoffOperation,
} from "../../core/design-review/state";
import { coordinateDesignReview, type CoordinatorContext } from "../../core/design-review/coordinator";
import { matchCommitExpectation } from "../../core/session-state";
import { makeTestConfig, makeTestMeta, reviewReportContent, boundReviewOperation } from "../helpers";

const OP = "op-budget-review-1";

function makeStrictSession(initial: SessionMeta) {
  let current = { ...initial };
  return {
    getMeta: () => current,
    updateMeta: (patch: Partial<SessionMeta>) => { current = { ...current, ...patch }; return current; },
    updateMetaVerified: (
      patch: Partial<SessionMeta>,
      expected: import("../../core/session-state").MetaCommitExpectation,
    ): import("../../types").ReliableMetaCommitResult => {
      const conflict = matchCommitExpectation(current, expected);
      if (conflict) return { status: "conflict", reason: conflict };
      current = { ...current, ...patch };
      return { status: "persisted", meta: current };
    },
    replace: (m: SessionMeta) => { current = m; },
  };
}

describe("192 Phase 4: DR192-01 handoff windows + budget freeze", () => {
  let projectRoot: string;
  let planDoc: string;
  let planHash: string;
  let config: ReturnType<typeof makeTestConfig>;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-budget-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "190_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\nv1\n", "utf-8");
    planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
    config = makeTestConfig({ projectRoot });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function passReadyHandoffState(evidence: DesignReviewOperation["dispatchEvidence"], dispatchState?: DesignReviewOperation["dispatchState"]): { meta: SessionMeta; handoffId: string; authId: string } {
    const base = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const handoffId = "op-handoff-budget-1";
    const state: DesignReviewState = {
      ...base,
      phase: "pass_ready",
      approval: { reviewOperationId: OP, round: 1, planHash, reportHash: "c".repeat(64), authorizedAt: Date.now() },
      operation: {
        operationId: handoffId,
        kind: "develop-handoff",
        stageVisitId: base.authorizedAt,
        attempt: 1,
        dispatchState: dispatchState ?? "pending",
        dispatchEvidence: evidence,
        round: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(evidence === "trusted_id" ? { agentId: "agent-budget-handoff" } : {}),
      },
    };
    const meta = makeTestMeta({ currentStage: "develop", designReview: state, loopCycleCount: 1 });
    return { meta, handoffId, authId: base.authorizationId };
  }

  it("window: confirmed not-sent after reliable develop transition → resume dispatches SAME handoff once, no re-approval/visit/round", async () => {
    const { meta, handoffId } = passReadyHandoffState("confirmed_not_sent");
    let spawns = 0;
    const session = makeStrictSession(meta);
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async () => {
        spawns++;
        return { spawned: true, fallback: false, deferred: false, agentId: "agent-handoff-1", dispatchOutcome: "spawned_id" as const };
      },
    };
    const visitsBefore = JSON.stringify(meta.stageVisitOrder ?? null);

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "advanced").toBe(true);
    expect(spawns).toBe(1); // exactly one handoff RPC
    const after = session.getMeta()!;
    expect(after.designReview?.phase).toBe("finished");
    expect(after.designReview?.operation?.operationId).toBe(handoffId); // SAME op
    expect(after.designReview?.round).toBe(1); // no round bump
    expect(after.designReview?.approval?.reviewOperationId).toBe(OP); // no re-approval
    expect(JSON.stringify(after.stageVisitOrder ?? null)).toBe(visitsBefore); // no extra visit
    // classification now releases takeover
    expect(classifyDesignReviewFlow(after).kind).toBe("ordinary");
    expect(isDevelopHandoffOperation(after)).toBe(false);
  });

  it("window: send-intent without provable dispatch → pause; automatic resume performs ZERO RPC", async () => {
    const { meta } = passReadyHandoffState("send_intent");
    let spawns = 0;
    const session = makeStrictSession(meta);
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async () => {
        spawns++;
        return { spawned: true, fallback: false, deferred: false, agentId: "x", dispatchOutcome: "spawned_id" as const };
      },
    };

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "pending").toBe(true);
    expect(spawns).toBe(0); // NEVER blind re-dispatch
    const paused = session.getMeta()!;
    expect(paused.designReview?.phase).toBe("paused");
    expect(paused.designReview?.pauseReason).toBe("unknown-dispatch");

    // Any further automatic entry keeps staying pending (no RPC)
    await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    await coordinateDesignReview(ctx, session.getMeta()!, "verify");
    await coordinateDesignReview(ctx, session.getMeta()!, "handoff");
    expect(spawns).toBe(0);
  });

  it("window: receipt persisted, finished failed → re-entry finishes with RPC delta 0", async () => {
    const { meta, handoffId } = passReadyHandoffState("trusted_id", "dispatched");
    let spawns = 0;
    const session = makeStrictSession(meta);
    const ctx: CoordinatorContext = {
      config,
      session,
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async () => {
        spawns++;
        return { spawned: true, fallback: false, deferred: false, agentId: "x", dispatchOutcome: "spawned_id" as const };
      },
    };

    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "advanced").toBe(true);
    expect(spawns).toBe(0); // success receipt already persisted → finish-only
    const after = session.getMeta()!;
    expect(after.designReview?.phase).toBe("finished");
    expect(after.designReview?.operation?.operationId).toBe(handoffId);
  });

  it("budget default 3: FAIL consumption at cap FREEZES via the hook (flowState actually blocked)", async () => {
    // report present; loopCycleCount at cap → coordinator frozen; hook must
    // translate that into a REAL freeze (flowState blocked), not just a string.
    fs.writeFileSync(deriveReportPath(planDoc, 1), reviewReportContent({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP,
      inputHash: planHash,
      verdict: "FAIL",
      issues: ["defect"],
    }), "utf-8");
    const base = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: {
        ...base,
        phase: "review_running",
        operation: boundReviewOperation(OP, planHash),
      },
      loopCycleCount: 3, // == default maxLoopCycles
    });
    const session = makeStrictSession(meta);
    let menuOpened = false;
    const ctx: any = {
      session,
      ui: {
        notify: () => {},
        setStatus: () => {},
        select: async () => { menuOpened = true; return undefined; },
        confirm: async () => false,
      },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [], getSessionFile: () => "/tmp/o.jsonl", getSessionName: () => "owner", getHeader: () => undefined } },
    };
    const { createAgentSettled } = await import("../../core/agent-settled");
    const hook = createAgentSettled(config);
    await hook.handler(ctx);

    const after: SessionMeta = session.getMeta();
    // The frozen budget must actually block the pipeline (freezeAndPrompt ran).
    expect(after.flowState).toBe("blocked");
    expect(menuOpened).toBe(true);
    expect(after.designReview?.phase).toBe("review_running"); // report NOT consumed
  });
});
