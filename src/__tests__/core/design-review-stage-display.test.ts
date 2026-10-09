/**
 * 194 Phase 2 (task 5 / D2): the status-bar stage display matrix for the
 * design-review loop.
 *
 * The bar must render the REAL loop direction, per the user ruling:
 * - review_ready / review_running  → `design-review -> plan` (revision
 *   candidate — a FAIL routes back there; never the stage itself);
 * - update_ready / update_running  → `design-review -> plan` while the owner
 *   waits, and `plan -> design-review` whenever a `plan`-stage rendering runs
 *   with the loop in flight (dynamic target, NOT the ordinary plan next
 *   stage that would advertise plain development continuation);
 * - pass_ready                     → `design-review -> develop`;
 * - paused                         → a status token only (paused /
 *   awaiting-decision), never a claim of automatic advancement;
 * - finished                       → `design-review -> completed`;
 * - no designReview state           → the static config `nextStage` chain is
 *   untouched for every stage.
 *
 * Rendering stays silent end-to-end when `output.pipelineStage` is false.
 */
import { describe, it, expect } from "bun:test";
import type { DesignReviewPhase, DesignReviewState, SessionMeta } from "../../types";
import { createPipelineUI, syncStageStatusBar, STAGE_STATUS_KEY } from "../../core/pipeline-ui";
import { makeTestConfig, makeTestMeta, finalStatusText } from "../helpers";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCtx(meta: SessionMeta | undefined) {
  const notifications: string[] = [];
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  const ctx: any = {
    ui: {
      notify: (msg: string) => { notifications.push(msg); },
      setStatus: (key: string, text: string | undefined) => { statusCalls.push({ key, text }); },
    },
  };
  if (meta !== undefined) {
    ctx.session = { getMeta: () => meta };
  }
  return { ctx, notifications, statusCalls };
}

function drState(phase: DesignReviewPhase, extra: Partial<DesignReviewState> = {}): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/plan.md",
    authorizationId: "auth-123",
    authorizationSource: "direct-entry",
    round: 1,
    phase,
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  };
}

function uiEnabled() {
  return createPipelineUI(makeTestConfig({ output: { pipelineStage: true } }));
}

function lastStatus(statusCalls: Array<{ key: string; text: string | undefined }>): string {
  const text = finalStatusText(statusCalls, STAGE_STATUS_KEY);
  expect(typeof text).toBe("string");
  return text as string;
}

// ─── Owner stage (design-review) matrix ──────────────────────────────────────

describe("194 D2: design-review stage dynamic targets", () => {
  const cases: Array<[DesignReviewPhase, string, string]> = [
    ["review_ready", "-> plan", "-> design-review"],
    ["review_running", "-> plan", "-> design-review"],
    ["update_ready", "-> plan", "-> develop"],
    ["update_running", "-> plan", "-> develop"],
    ["pass_ready", "-> develop", "-> plan"],
    ["finished", "-> completed", "-> develop"],
  ];

  for (const [phase, target, forbidden] of cases) {
    it(`${phase} renders the loop-true target ${target}`, () => {
      const ui = uiEnabled();
      const meta = makeTestMeta({
        currentStage: "design-review" as SessionMeta["currentStage"],
        designReview: drState(phase),
      });
      const { ctx, notifications, statusCalls } = makeCtx(meta);

      ui.stageEntry(ctx, "design-review");

      expect(notifications.length).toBe(1);
      expect(notifications[0]).toContain("design-review");
      expect(notifications[0]).toContain(target);
      expect(notifications[0]).not.toContain(forbidden);
      // The persistent bar carries the SAME text as the notification (unified sync).
      expect(lastStatus(statusCalls)).toContain(target);
    });
  }

  it("paused shows the generic token and never claims an automatic stage", () => {
    const ui = uiEnabled();
    const meta = makeTestMeta({
      currentStage: "design-review" as SessionMeta["currentStage"],
      designReview: drState("paused", { pauseReason: "executor-failed" }),
    });
    const { ctx, notifications } = makeCtx(meta);

    ui.stageEntry(ctx, "design-review");

    expect(notifications[0]).toContain("-> paused");
    expect(notifications[0]).not.toContain("-> develop");
    expect(notifications[0]).not.toContain("-> plan");
  });

  it("decision-pending pauses render the awaiting-decision token", () => {
    const ui = uiEnabled();
    const meta = makeTestMeta({
      currentStage: "design-review" as SessionMeta["currentStage"],
      designReview: drState("paused", { pauseReason: "decision-pending" }),
    });
    const { ctx, notifications } = makeCtx(meta);

    ui.stageEntry(ctx, "design-review");

    expect(notifications[0]).toContain("-> awaiting-decision");
    expect(notifications[0]).not.toContain("-> develop");
    expect(notifications[0]).not.toContain("-> paused");
  });
});

// ─── Plan stage: dynamic design-review target only while a revision runs ────

describe("194 D2: plan stage target follows the loop, not the ordinary chain", () => {
  for (const phase of ["update_ready", "update_running"] as const) {
    it(`${phase}: plan renderings point back to design-review (not develop)`, () => {
      const ui = uiEnabled();
      const meta = makeTestMeta({
        currentStage: "plan",
        designReview: drState(phase),
      });
      const { ctx, notifications, statusCalls } = makeCtx(meta);

      ui.stageEntry(ctx, "plan");

      expect(notifications[0]).toContain("plan");
      expect(notifications[0]).toContain("-> design-review");
      expect(notifications[0]).not.toContain("-> develop");
      expect(lastStatus(statusCalls)).toContain("-> design-review");
    });
  }

  it("a paused loop rendered at the plan stage still shows a token, never an advance", () => {
    const ui = uiEnabled();
    const meta = makeTestMeta({
      currentStage: "plan",
      designReview: drState("paused", { pauseReason: "drift" }),
    });
    const { ctx, notifications } = makeCtx(meta);

    ui.stageEntry(ctx, "plan");

    expect(notifications[0]).toContain("-> paused");
    expect(notifications[0]).not.toContain("-> develop");
  });

  it("outside the loop the plan stage keeps the static config chain", () => {
    const ui = uiEnabled();
    const meta = makeTestMeta({ currentStage: "plan" });
    const { ctx, notifications } = makeCtx(meta);

    ui.stageEntry(ctx, "plan");

    // makeTestConfig wires plan -> design-review statically; the override must
    // simply be absent (same target as config), and unrelated phases must not
    // leak the paused token.
    expect(notifications[0]).toContain("-> design-review");
  });

  it("review_ready at the plan stage is NOT rewritten (loop target only for revisions)", () => {
    const ui = uiEnabled();
    const meta = makeTestMeta({
      currentStage: "plan",
      designReview: drState("review_ready"),
    });
    const { ctx, notifications } = makeCtx(meta);

    ui.stageEntry(ctx, "plan");

    // Static fallback governs (plan.nextStage = design-review in the fixture)
    // and nothing renders the old self-loop.
    expect(notifications[0]).toContain("-> design-review");
    expect(notifications[0]).not.toContain("-> plan");
  });
});

// ─── Unrelated stages keep the static chain ─────────────────────────────────

describe("194 D2: stages outside the override set are untouched", () => {
  it("develop renders static nextStage even with an open loop", () => {
    const ui = uiEnabled();
    const meta = makeTestMeta({
      currentStage: "develop",
      designReview: drState("pass_ready", {
        operation: {
          operationId: "33333333-3333-4333-8333-333333333333",
          kind: "develop-handoff",
          stageVisitId: 1000,
          attempt: 1,
          dispatchState: "dispatched",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    });
    const { ctx, notifications } = makeCtx(meta);

    ui.stageEntry(ctx, "develop");

    // develop -> review via config; no design-review tokens leak in.
    expect(notifications[0]).toContain("-> review");
    expect(notifications[0]).not.toContain("paused");
  });
});

// ─── Unified sync + output gating ────────────────────────────────────────────

describe("194 D2: syncStageStatusBar and output=false silence", () => {
  it("syncStageStatusBar renders the meta stage through the same matrix", () => {
    const ui = uiEnabled();
    const meta = makeTestMeta({
      currentStage: "design-review" as SessionMeta["currentStage"],
      designReview: drState("update_running"),
    });
    const { ctx, statusCalls } = makeCtx(meta);

    syncStageStatusBar(ui, ctx);

    expect(lastStatus(statusCalls)).toContain("design-review");
    expect(lastStatus(statusCalls)).toContain("-> plan");
  });

  it("output.pipelineStage=false: no notify and no setStatus at all", () => {
    const ui = createPipelineUI(makeTestConfig({ output: { pipelineStage: false } }));
    const meta = makeTestMeta({
      currentStage: "design-review" as SessionMeta["currentStage"],
      designReview: drState("review_running"),
    });
    const { ctx, notifications, statusCalls } = makeCtx(meta);

    syncStageStatusBar(ui, ctx);
    ui.stageEntry(ctx, "design-review");
    ui.transition(ctx, "plan", "design-review");
    ui.fail(ctx, "design-review", "paused");

    expect(notifications).toEqual([]);
    expect(statusCalls).toEqual([]);
  });

  it("transition into design-review re-renders the loop-true target of the new phase", () => {
    const ui = uiEnabled();
    // Coordinator's update_complete_rerun: transition(plan -> design-review)
    // while the freshly committed state is review_ready for the next round.
    const meta = makeTestMeta({
      currentStage: "design-review" as SessionMeta["currentStage"],
      designReview: drState("review_ready", { round: 2 }),
    });
    const { ctx, notifications } = makeCtx(meta);

    ui.transition(ctx, "plan", "design-review");

    expect(notifications[0]).toContain("design-review");
    expect(notifications[0]).toContain("-> plan");
    expect(notifications[0]).not.toContain("-> design-review");
  });
});
