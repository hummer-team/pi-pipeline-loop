/**
 * 193 Phase 3 (tasks 5/6): the executor-level flow guard and the RECHECK
 * barrier.
 *
 * Acceptance covered here:
 * - while the design-review domain is NOT legitimately ended (active or
 *   identity-blocked), `skip` and `choose_stage` toward develop/review/fix/
 *   awaiting_human/completed are REFUSED with actionable guidance and ZERO
 *   state touch (the guard runs before any invalidate/updateMeta/transition);
 * - upstream escapes (rollback, choose_stage → clarify/plan, re-review via
 *   choose_stage → design-review, abort/resume/restart) stay allowed;
 * - an upstream rollback ARMS the recheck marker in the SAME strict/legacy
 *   transaction that clears the authorization;
 * - while the marker is armed, ordinary forward releases — generic decisions,
 *   verify-pass advance, handoff — are refused until a new pipeline/review
 *   takes over; old markers never cross pipeline ids; restart clears them;
 * - frozen decisions of OTHER features (no domain, no marker) are unchanged.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { DesignReviewState, PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import { executeDecision, clearAllDecisionTimers } from "../../core/flow-state";
import {
  guardGenericFlowDecision,
  checkRecheckForwardRelease,
  isDesignReviewRecheckBarrierActive,
  DESIGN_REVIEW_BLOCKED_FORWARD_STAGES,
} from "../../core/design-review/flow-decision-guard";
import { applyVerifyPass } from "../../core/verify-advance";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";

const PIPE = "pipe-test-001";

function activeState(): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/plan.md",
    planHash: "abc123",
    round: 1,
    authorizationId: "auth-1",
    authorizationSource: "menu",
    phase: "review_ready",
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function markerMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    currentStage: "design-review",
    designReviewRecheck: { pipelineId: PIPE, planDoc: "/tmp/plan.md" },
    ...overrides,
  });
}

// ─── pure guard: domain-active refusals ──────────────────────────────────────

describe("193 Phase 3: guardGenericFlowDecision (domain active)", () => {
  let config: PipelineConfig;
  beforeEach(() => { config = makeTestConfig(); });
  afterAll(() => { clearAllDecisionTimers(); });

  const activeMeta = (): SessionMeta =>
    makeTestMeta({ currentStage: "design-review", designReview: activeState() });

  it("skip is refused while the loop is active", () => {
    const v = guardGenericFlowDecision({ decision: "skip", meta: activeMeta(), config });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("domain_active_skip_blocked");
      expect(v.message).toContain("skip");
    }
  });

  it("every forward-release jump target is refused while active", () => {
    for (const target of DESIGN_REVIEW_BLOCKED_FORWARD_STAGES) {
      const v = guardGenericFlowDecision({
        decision: "choose_stage",
        targetStage: target,
        meta: activeMeta(),
        config,
      });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("domain_active_forward_jump_blocked");
    }
  });

  it("upstream jumps (clarify/plan) and re-review (design-review) stay allowed", () => {
    for (const target of ["clarify", "plan", "design-review"] as PipelineStage[]) {
      const v = guardGenericFlowDecision({
        decision: "choose_stage",
        targetStage: target,
        meta: activeMeta(),
        config,
      });
      expect(v.ok).toBe(true);
    }
  });

  it("resume/rollback/abort/restart are never refused by the guard", () => {
    for (const decision of ["resume", "rollback", "abort", "restart"] as const) {
      const v = guardGenericFlowDecision({ decision, meta: activeMeta(), config });
      expect(v.ok).toBe(true);
    }
  });

  it("an identity-BLOCKED domain (feature present, identity invalid) is refused too", () => {
    const blocked = makeTestMeta({
      currentStage: "design-review",
      designReview: { phase: "review_running" } as unknown as DesignReviewState,
    });
    expect(guardGenericFlowDecision({ decision: "skip", meta: blocked, config }).ok).toBe(false);
    expect(
      guardGenericFlowDecision({ decision: "choose_stage", targetStage: "develop", meta: blocked, config }).ok,
    ).toBe(false);
  });

  it("frozen decisions for OTHER features (no domain, no marker) are unchanged", () => {
    const plain = makeTestMeta({ currentStage: "develop" });
    expect(guardGenericFlowDecision({ decision: "skip", meta: plain, config }).ok).toBe(true);
    expect(
      guardGenericFlowDecision({ decision: "choose_stage", targetStage: "completed", meta: plain, config }).ok,
    ).toBe(true);
  });
});

// ─── pure guard: RECHECK barrier window ──────────────────────────────────────

describe("193 Phase 3: guardGenericFlowDecision (recheck barrier)", () => {
  let config: PipelineConfig;
  beforeEach(() => { config = makeTestConfig(); });

  it("forward jumps are refused while the marker is armed", () => {
    for (const target of DESIGN_REVIEW_BLOCKED_FORWARD_STAGES) {
      const v = guardGenericFlowDecision({
        decision: "choose_stage",
        targetStage: target,
        meta: markerMeta(),
        config,
      });
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.code).toBe("recheck_forward_jump_blocked");
        expect(v.message).toContain("RECHECK barrier");
        expect(v.message).toContain("/tmp/plan.md");
      }
    }
  });

  it("skip whose stage-chain target moves forward is refused; upstream skip is not", () => {
    // design-review → nextStage develop: refused
    const forward = guardGenericFlowDecision({ decision: "skip", meta: markerMeta(), config });
    expect(forward.ok).toBe(false);
    if (!forward.ok) expect(forward.code).toBe("recheck_skip_blocked");

    // plan → nextStage design-review: allowed (upstream/into-review movement)
    const upstream = guardGenericFlowDecision({
      decision: "skip",
      meta: markerMeta({ currentStage: "plan" }),
      config,
    });
    expect(upstream.ok).toBe(true);
  });

  it("a marker from an OLD pipeline never blocks the new one", () => {
    const meta = makeTestMeta({
      currentStage: "plan",
      designReviewRecheck: { pipelineId: "pipe-OLD", planDoc: "/tmp/plan.md" },
    });
    expect(isDesignReviewRecheckBarrierActive(meta)).toBe(false);
    expect(
      guardGenericFlowDecision({ decision: "choose_stage", targetStage: "develop", meta, config }).ok,
    ).toBe(true);
  });

  it("a finished state next to a marker keeps the conservative block", () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: { ...activeState(), phase: "finished" },
      designReviewRecheck: { pipelineId: PIPE, planDoc: "/tmp/plan.md" },
    });
    expect(
      guardGenericFlowDecision({ decision: "choose_stage", targetStage: "develop", meta, config }).ok,
    ).toBe(false);
  });
});

// ─── shared release-site predicate ───────────────────────────────────────────

describe("193 Phase 3: checkRecheckForwardRelease", () => {
  it("blocks forward targets while armed, allows upstream targets", () => {
    expect(checkRecheckForwardRelease(markerMeta(), "develop").blocked).toBe(true);
    expect(checkRecheckForwardRelease(markerMeta(), "completed").blocked).toBe(true);
    expect(checkRecheckForwardRelease(markerMeta(), "clarify").blocked).toBe(false);
    expect(checkRecheckForwardRelease(markerMeta(), "design-review").blocked).toBe(false);
  });

  it("an ACTIVE domain is not the marker window (coordinator governs it)", () => {
    const active = makeTestMeta({ currentStage: "design-review", designReview: activeState() });
    expect(checkRecheckForwardRelease(active, "develop").blocked).toBe(false);
  });

  it("no marker / no target → never blocked", () => {
    expect(checkRecheckForwardRelease(makeTestMeta(), "develop").blocked).toBe(false);
    expect(checkRecheckForwardRelease(markerMeta(), undefined).blocked).toBe(false);
  });
});

// ─── executor integration: refusal has ZERO side effects ────────────────────

function makeFlowCtx(meta: SessionMeta) {
  const updates: Partial<SessionMeta>[] = [];
  return {
    updates,
    ctx: {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          updates.push(patch);
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: { notify: (_m: string) => {} },
    },
  };
}

describe("193 Phase 3: executeDecision consults the guard BEFORE any state touch", () => {
  let config: PipelineConfig;
  beforeEach(() => { config = makeTestConfig(); });

  it("active domain + skip → refused; authorization untouched; zero updates", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      currentStage: "design-review",
      designReview: activeState(),
    });
    const { ctx, updates } = makeFlowCtx(meta);

    const result = await executeDecision(ctx as never, meta, "skip", config, { source: "replay" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("skip");
    expect(meta.designReview).toBeDefined();
    expect(updates.length).toBe(0);
  });

  it("active domain + choose_stage → develop → refused with zero side effects", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      currentStage: "design-review",
      designReview: activeState(),
    });
    const { ctx, updates } = makeFlowCtx(meta);

    const result = await executeDecision(
      ctx as never, meta, "choose_stage", config, { targetStage: "develop" },
    );

    expect(result.success).toBe(false);
    expect(meta.designReview).toBeDefined();
    expect(updates.length).toBe(0);
  });

  it("choose_stage → plan (upstream) clears the authorization AND arms the marker atomically", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      currentStage: "design-review",
      designReview: activeState(),
    });
    const { ctx } = makeFlowCtx(meta);

    const result = await executeDecision(
      ctx as never, meta, "choose_stage", config, { targetStage: "plan" },
    );

    expect(result.success).toBe(true);
    expect(meta.designReview).toBeUndefined();
    // task 6: the SAME transaction armed the recheck barrier
    expect(meta.designReviewRecheck).toEqual({ pipelineId: PIPE, planDoc: "/tmp/plan.md" });
  });

  it("rollback from design-review arms the marker", async () => {
    const meta = makeTestMeta({
      flowState: "blocked",
      currentStage: "design-review",
      previousStage: "plan",
      designReview: activeState(),
    });
    const { ctx } = makeFlowCtx(meta);

    const result = await executeDecision(ctx as never, meta, "rollback", config);

    expect(result.success).toBe(true);
    expect(meta.designReview).toBeUndefined();
    expect(meta.designReviewRecheck?.planDoc).toBe("/tmp/plan.md");
  });

  it("while armed, the NEXT generic forward decision is refused with RECHECK guidance", async () => {
    const meta = markerMeta({ flowState: "blocked" });
    const { ctx } = makeFlowCtx(meta);

    const result = await executeDecision(
      ctx as never, meta, "choose_stage", config, { targetStage: "review" },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("RECHECK barrier");
  });

  it("restart drops the marker (a truly new pipeline never inherits it)", async () => {
    const meta = markerMeta({ flowState: "blocked" });
    const { ctx, updates } = makeFlowCtx(meta);

    const result = await executeDecision(ctx as never, meta, "restart", config);

    expect(result.success).toBe(true);
    const cleared = updates.some((u) => "designReviewRecheck" in u && u.designReviewRecheck === undefined);
    expect(cleared).toBe(true);
  });

  it("skip on a plain (no-domain no-marker) frozen pipeline keeps original semantics", async () => {
    const meta = makeTestMeta({ flowState: "blocked", currentStage: "develop" });
    const { ctx } = makeFlowCtx(meta);

    const result = await executeDecision(ctx as never, meta, "skip", config);

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("review");
  });
});

// ─── ordinary RELEASE sites honour the barrier ──────────────────────────────

describe("193 Phase 3: verify-pass and handoff honour the recheck barrier", () => {
  let TMP: string;
  let config: PipelineConfig;

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(tmpdir(), "dr-recheck-"));
    config = makeTestConfig({ projectRoot: TMP });
  });

  it("applyVerifyPass refuses a marker-active forward advance BEFORE counting the visit", async () => {
    const meta = markerMeta({ flowState: "running" });
    const updates: Partial<SessionMeta>[] = [];
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          updates.push(patch);
          Object.assign(meta, patch);
          return meta;
        },
      },
    };

    const res = await applyVerifyPass(
      ctx as never,
      meta,
      "design-review" as PipelineStage,
      "develop" as PipelineStage,
      { verifyResult: { passed: true, failures: [] } } as never,
      { method: "tool", returnResult: true } as never,
    );

    expect(res.success).toBe(false);
    expect(res.passed).toBe(true);
    expect(res.message).toContain("RECHECK barrier");
    // refused release consumed NO budget and moved NOTHING
    expect(updates.length).toBe(0);
    expect(meta.currentStage).toBe("design-review");
  });

  it("the handoff tool refuses a marker-active forward handoff", async () => {
    const meta = markerMeta({ flowState: "running" });
    const ctx = createMockCtx(meta);
    const tool = createPipelineHandoff(config);

    const result = await tool.execute({ nextStage: "develop" }, ctx as never) as
      { success?: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("RECHECK barrier");
    expect(meta.currentStage).toBe("design-review");
  });

  it("without the marker the handoff proceeds past the barrier (regression)", async () => {
    const meta = makeTestMeta({ currentStage: "plan", flowState: "running" });
    const ctx = createMockCtx(meta);
    const tool = createPipelineHandoff(config);

    const result = await tool.execute({ nextStage: "design-review" }, ctx as never) as
      { error?: string };

    // NOT the barrier refusal (may still fail later for unrelated reasons)
    expect(result.error ?? "").not.toContain("RECHECK barrier");
  });
});
