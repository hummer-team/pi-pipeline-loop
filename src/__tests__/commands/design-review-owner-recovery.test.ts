/**
 * 192 Phase 4 (task 5/7, DR192-01): owner recovery entries must honour the
 * SAME takeover condition. dispatchAfterResume with currentStage="develop"
 * while a develop-handoff is unfinished routes through the domain takeover —
 * the ordinary resume path may not start a second executor; when the handoff
 * is finished/complete the ordinary develop dispatch resumes normally.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { SessionMeta, DesignReviewState, DesignReviewOperation } from "../../types";
import { dispatchAfterResume } from "../../commands/pipeline-start";
import { createInitialState, classifyDesignReviewFlow } from "../../core/design-review/state";
import { matchCommitExpectation } from "../../core/session-state";
import { makeTestConfig, makeTestMeta } from "../helpers";

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
      if (conflict) return { status: "conflict" as const, reason: conflict };
      current = { ...current, ...patch };
      return { status: "persisted" as const, meta: current };
    },
  };
}

function handoffMeta(
  evidence: DesignReviewOperation["dispatchEvidence"],
  state: "pending" | "dispatched" | "completed",
): SessionMeta {
  const base = createInitialState("/tmp/docs/p_plan.md", "menu", "a".repeat(64), undefined, { pipelineId: "pipe-test-001" });
  const dr: DesignReviewState = {
    ...base,
    phase: state === "completed" ? "finished" : "pass_ready",
    approval: { reviewOperationId: "op-r", round: 1, planHash: "a".repeat(64), reportHash: "b".repeat(64), authorizedAt: 1 },
    operation: {
      operationId: "op-handoff-1",
      kind: "develop-handoff",
      stageVisitId: 1,
      attempt: 1,
      dispatchState: state,
      dispatchEvidence: evidence,
      ...(state === "dispatched" ? { agentId: "agent-h" } : {}),
      round: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  };
  return makeTestMeta({ currentStage: "develop", designReview: dr });
}

describe("192 Phase 4: dispatchAfterResume handoff takeover", () => {
  let projectRoot: string;
  beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-owner-")); });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  function makeCtx(meta: SessionMeta, opts?: { failSpawn?: boolean }) {
    const session = makeStrictSession(meta);
    const sends: string[] = [];
    let spawnCalls = 0;
    const ctx: any = {
      session,
      pi: { sendUserMessage: (m: string) => { sends.push(m); } },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [], getSessionFile: () => "/tmp/owner.jsonl", getSessionName: () => "owner", getHeader: () => undefined } },
      spawnOverride: async () => {
        spawnCalls++;
        if (opts?.failSpawn) return { spawned: false, fallback: false, deferred: false, dispatchOutcome: "not_sent" as const };
        return { spawned: true, fallback: false, deferred: false, agentId: "agent-dev-1", dispatchOutcome: "spawned_id" as const };
      },
    };
    return { ctx, session, sends, spawnCount: () => spawnCalls };
  }

  const ui: any = { notify: () => {}, setStatus: () => {}, select: async () => undefined, confirm: async () => false };

  it("unfinished handoff (confirmed not-sent): takeover dispatches ONCE, never via ordinary path twice", async () => {
    const meta = handoffMeta("confirmed_not_sent", "pending");
    const { ctx, session, spawnCount } = makeCtx(meta);
    await dispatchAfterResume(ctx, makeTestConfig({ projectRoot }), ui, session.getMeta()!, "docs/x.md");
    expect(spawnCount()).toBe(1); // exactly one handoff dispatch via coordinator
    expect(session.getMeta().designReview?.phase).toBe("finished");
  });

  it("unfinished handoff with unverifiable intent: takeover keeps pending and performs ZERO dispatch", async () => {
    const meta = handoffMeta("send_intent", "pending");
    const { ctx, session, spawnCount, sends } = makeCtx(meta);
    await dispatchAfterResume(ctx, makeTestConfig({ projectRoot }), ui, session.getMeta()!, "docs/x.md");
    expect(spawnCount()).toBe(0);
    // no ordinary develop executor wake either (no second channel)
    expect(sends.filter((s) => s.includes("[plugin auto-handoff]")).length).toBe(0);
    // takeover retained: still pass_ready/paused unknown, NOT finished
    const st = session.getMeta().designReview!;
    expect(st.phase === "pass_ready" || st.phase === "paused").toBe(true);
    expect(st.phase).not.toBe("finished");
  });

  it("trusted receipt persisted (dispatched) → takeover ONLY finishes, zero dispatch", async () => {
    const meta = handoffMeta("trusted_id", "dispatched");
    const { ctx, session, spawnCount } = makeCtx(meta);
    await dispatchAfterResume(ctx, makeTestConfig({ projectRoot }), ui, session.getMeta()!, "docs/x.md");
    expect(spawnCount()).toBe(0);
    expect(session.getMeta().designReview?.phase).toBe("finished");
  });

  it("finished loop releases takeover → classify ordinary (no domain interception)", async () => {
    const meta = handoffMeta("trusted_id", "completed");
    expect(classifyDesignReviewFlow(meta).kind).toBe("ordinary");
  });
});
