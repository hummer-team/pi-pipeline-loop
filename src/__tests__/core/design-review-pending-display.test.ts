/**
 * 193 Phase 3 (task 8) — review fix (issue 1): the decision-pending pause must
 * be displayed as READ-ONLY guidance on EVERY status surface:
 * - prompt dynamic context (`buildDesignReviewContext`): pending state, pinned
 *   mode, bound report and the `/pipeline-resume` instruction — and NEVER the
 *   "report is writable" advertisement that contradicts `decision-guard`;
 * - `pipeline_state` tool: decision (state/mode/report/issues) + resume
 *   guidance, with the automatic next step suppressed;
 * - `/pipeline-status`: the same pending/mode/report/resume lines;
 * - `pipeline-ui` status bar: the `awaiting-decision` token instead of a
 *   next-stage hint;
 * - the shared view builder itself (defensive on a missing decision record —
 *   an absent record never fabricates a choice or a mode).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createPromptInjector } from "../../core/prompt-injector";
import { createPipelineState } from "../../core/pipeline-state";
import { createPipelineStatusCommand } from "../../commands/pipeline-status";
import { createPipelineUI } from "../../core/pipeline-ui";
import {
  buildDesignReviewPendingDecisionView,
  DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION,
  DESIGN_REVIEW_PENDING_TARGET,
  formatDesignReviewPendingDecision,
} from "../../core/design-review/decision-display";
import type { HumanDecision } from "../../core/design-review/decision-types";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { resetPromptConfigCache } from "../../core/prompt-config";
import type { DesignReviewOperation, DesignReviewState, SessionMeta } from "../../types";

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeReviewOperation(mode: "manual" | "smart"): DesignReviewOperation {
  return {
    operationId: "op-decision-1",
    kind: "review",
    stageVisitId: 1000,
    attempt: 1,
    round: 1,
    dispatchState: "completed",
    reviewConfirmMode: mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makePendingDecision(mode: "manual" | "smart"): HumanDecision {
  return {
    state: "pending",
    decisionId: "dec-0001",
    reviewIdentity: {
      pipelineId: "pipe-test-001",
      planDoc: "/tmp/plan.md",
      authorizationId: "auth-decision",
      round: 1,
      operationId: "op-decision-1",
      stageVisitId: 1000,
    },
    reportDoc: "/tmp/docs/review-design-1-plan.md",
    reportHash: "hash-report",
    planHash: "hash-plan",
    issues: [
      { issueId: "i1", text: "issue one" },
      { issueId: "i2", text: "issue two" },
    ],
    mode,
    ownerSessionFile: "/tmp/owner-session.jsonl",
    createdAt: Date.now(),
  };
}

function pendingState(overrides?: Partial<DesignReviewState>): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/plan.md",
    planHash: "hash-plan",
    round: 1,
    authorizationId: "auth-decision",
    authorizationSource: "menu",
    reportDoc: "/tmp/docs/review-design-1-plan.md",
    phase: "paused",
    pauseReason: "decision-pending",
    operation: makeReviewOperation("manual"),
    decision: makePendingDecision("manual"),
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function pendingMeta(overrides?: Partial<DesignReviewState>): SessionMeta {
  return makeTestMeta({
    currentStage: "design-review",
    designReview: pendingState(overrides),
  });
}

afterEach(() => {
  resetPromptConfigCache();
});

// ─── shared view builder ─────────────────────────────────────────────────────

describe("193 Phase 3 (task 8): pending-decision display view", () => {
  it("null for every non decision-pending state", () => {
    expect(buildDesignReviewPendingDecisionView(undefined)).toBeNull();
    expect(buildDesignReviewPendingDecisionView(makeTestMeta())).toBeNull();
    // paused for a different reason stays outside the read-only display
    const otherPause = makeTestMeta({
      currentStage: "design-review",
      designReview: pendingState({ pauseReason: "drift" }),
    });
    expect(buildDesignReviewPendingDecisionView(otherPause)).toBeNull();
  });

  it("full pending record drives state/mode/report/issues", () => {
    const view = buildDesignReviewPendingDecisionView(pendingMeta());
    expect(view).not.toBeNull();
    expect(view!.state).toBe("pending");
    expect(view!.choice).toBeNull();
    expect(view!.mode).toBe("manual");
    expect(view!.reportDoc).toBe("/tmp/docs/review-design-1-plan.md");
    expect(view!.issueCount).toBe(2);
  });

  it("chosen record exposes the persisted choice", () => {
    const chosen: HumanDecision = {
      ...makePendingDecision("smart"),
      state: "chosen",
      choice: "revise-plan",
      source: "human",
      decidedAt: Date.now(),
    };
    const view = buildDesignReviewPendingDecisionView(
      pendingMeta({ decision: chosen }),
    );
    expect(view!.state).toBe("chosen");
    expect(view!.choice).toBe("revise-plan");
    expect(view!.mode).toBe("smart");
  });

  it("defensive without a decision record: falls back to the pinned operation mode, never invents one", () => {
    const view = buildDesignReviewPendingDecisionView(
      pendingMeta({ decision: undefined, operation: makeReviewOperation("smart") }),
    );
    expect(view!.state).toBe("pending");
    expect(view!.mode).toBe("smart"); // pinned reviewConfirmMode, not a guess
    expect(view!.reportDoc).toBe("/tmp/docs/review-design-1-plan.md");
    expect(view!.issueCount).toBe(0);

    const noEvidence = buildDesignReviewPendingDecisionView(
      pendingMeta({ decision: undefined, operation: undefined }),
    );
    expect(noEvidence!.mode).toBe("unknown");
  });
});

// ─── prompt dynamic context ──────────────────────────────────────────────────

describe("193 Phase 3 (task 8): prompt dynamic context is READ-ONLY guidance", () => {
  async function injectPrompt(meta: SessionMeta): Promise<string> {
    const config = makeTestConfig();
    const hook = createPromptInjector(config);
    const ctx = { session: { getMeta: () => meta } };
    const result = (await hook.handler(ctx as any))!;
    return result.systemPrompt ?? "";
  }

  it("decision-pending shows pending/mode/report/resume and NEVER the writable-report advertisement", async () => {
    const prompt = await injectPrompt(pendingMeta());

    expect(prompt).toContain("DESIGN-REVIEW DYNAMIC CONTEXT");
    expect(prompt).toContain("PAUSED — awaiting a HUMAN plan-revision decision");
    expect(prompt).toContain("mode: manual");
    expect(prompt).toContain("report: /tmp/docs/review-design-1-plan.md");
    expect(prompt).toContain("issues: 2");
    expect(prompt).toContain("NOTHING is writable");
    expect(prompt).toContain("there is NO automatic next step");
    expect(prompt).toContain("/pipeline-resume");
    expect(prompt).toContain("Design Review Decision");
    expect(prompt).toContain("Revise Plan / Proceed to Develop / Cancel");
    // the contradicting writable-report advertisement from the review must be gone
    expect(prompt).not.toContain("EXACTLY these files");
    expect(prompt).not.toContain("Operation: review");
  });

  it("193 round-2 fix (review issue 1): smart-pending injects NO plan-revision protocol, stays READ-ONLY guidance", async () => {
    const meta = pendingMeta({
      operation: makeReviewOperation("smart"),
      decision: makePendingDecision("smart"),
    });
    const prompt = await injectPrompt(meta);
    expect(prompt).toContain("PAUSED — awaiting a HUMAN plan-revision decision");
    expect(prompt).toContain("mode: smart");
    // the smart protocol (incl. the "append ... to the report" directive) must
    // be fully suppressed while the human decision is pending
    expect(prompt).not.toContain("append EXACTLY ONE section");
    expect(prompt).not.toContain("## Plan Revision Decision");
    expect(prompt).not.toContain("Smart Plan-Revision Decision");
  });

  it("control: smart review_running (non-pending) still injects the protocol", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: pendingState({
        phase: "review_running",
        pauseReason: undefined,
        decision: undefined,
        operation: makeReviewOperation("smart"),
      }),
    });
    const prompt = await injectPrompt(meta);
    expect(prompt).toContain("append EXACTLY ONE section");
    expect(prompt).not.toContain("PAUSED — awaiting a HUMAN plan-revision decision");
  });

  it("non-pending design-review phases show the policy-driven exact write scope", async () => {
    const running = makeTestMeta({
      currentStage: "design-review",
      designReview: pendingState({
        phase: "review_running",
        pauseReason: undefined,
        decision: undefined,
      }),
    });
    const prompt = await injectPrompt(running);
    expect(prompt).toContain("Operation: review");
    // 194 Phase 1 (C4): the advertised scope is the SAME exact list the guard
    // enforces — the bound report path and nothing else.
    expect(prompt).toContain("EXACTLY these files");
    expect(prompt).toContain("/tmp/docs/review-design-1-plan.md");
    expect(prompt).not.toContain("awaiting a HUMAN plan-revision decision");
  });
});

// ─── pipeline_state tool ─────────────────────────────────────────────────────

describe("193 Phase 3 (task 8): pipeline_state shows decision + resume, suppresses the next step", () => {
  it("decision-pending: readOnly view with decision fields, next step suppressed", async () => {
    const config = makeTestConfig();
    const tool = createPipelineState(config);
    const meta = pendingMeta();
    const ctx = { session: { getMeta: () => meta } };

    const result = (await tool.execute({}, ctx as any)) as Record<string, any>;

    expect(result.stage.next).toBeNull();
    expect(result.designReview.pauseReason).toBe("decision-pending");
    expect(result.designReview.readOnly).toBe(true);
    expect(result.designReview.decision).toEqual({
      state: "pending",
      choice: null,
      mode: "manual",
      reportDoc: "/tmp/docs/review-design-1-plan.md",
      issueCount: 2,
      // 212 Phase 3: the JSON surface carries the read-only evidence fact
      // explicitly (this surface renders no formatter suffix).
      ownerEvidence: "recorded",
    });
    expect(result.designReview.resume).toContain("/pipeline-resume");
    expect(result.designReview.resume).toContain("Design Review Decision");
  });

  it("non-pending design-review: shape unchanged, next step still advertised", async () => {
    const config = makeTestConfig();
    const tool = createPipelineState(config);
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: pendingState({
        phase: "review_running",
        pauseReason: undefined,
        decision: undefined,
      }),
    });
    const ctx = { session: { getMeta: () => meta } };

    const result = (await tool.execute({}, ctx as any)) as Record<string, any>;

    expect(result.stage.next).toBe(config.stages["design-review"].nextStage);
    expect(result.designReview.readOnly).toBeUndefined();
    expect(result.designReview.decision).toBeUndefined();
    expect(result.designReview.resume).toBeUndefined();
  });
});

// ─── /pipeline-status ────────────────────────────────────────────────────────

describe("193 Phase 3 (task 8): /pipeline-status shows pending/mode/report/resume", () => {
  async function statusContent(meta: SessionMeta): Promise<string> {
    const config = makeTestConfig();
    const command = createPipelineStatusCommand(config);
    const ctx = { session: { getMeta: () => meta } };
    const result = (await command.execute({}, ctx as any)) as { content: string };
    return result.content;
  }

  it("decision-pending adds READ-ONLY status, decision summary and resume instruction", async () => {
    const content = await statusContent(pendingMeta());
    expect(content).toContain("PAUSED — awaiting a HUMAN plan-revision decision (session is READ-ONLY).");
    expect(content).toContain("Decision: pending — mode: manual; report: /tmp/docs/review-design-1-plan.md; issues: 2");
    expect(content).toContain("Resume:");
    expect(content).toContain("/pipeline-resume");
    expect(content).toContain("Revise Plan / Proceed to Develop / Cancel");
  });

  it("non-pending design-review keeps the original section without decision lines", async () => {
    const content = await statusContent(
      makeTestMeta({
        currentStage: "design-review",
        designReview: pendingState({
          phase: "review_running",
          pauseReason: undefined,
          decision: undefined,
        }),
      }),
    );
    expect(content).toContain("## Design Review");
    expect(content).toContain("Phase: review_running");
    expect(content).not.toContain("awaiting a HUMAN plan-revision decision");
    expect(content).not.toContain("Resume:");
  });
});

// ─── pipeline-ui status bar ──────────────────────────────────────────────────

describe("193 Phase 3 (task 8): status bar shows the awaiting-decision token", () => {
  function makeUiCtx(meta: SessionMeta) {
    const notifications: string[] = [];
    const statuses: string[] = [];
    const ctx = {
      session: { getMeta: () => meta },
      ui: {
        notify: (m: string) => notifications.push(m),
        setStatus: (_k: string, m?: string) => {
          if (m !== undefined) statuses.push(m);
        },
      },
    };
    return { ctx, notifications, statuses };
  }

  it("decision-pending renders 'awaiting-decision', never an automatic next stage", () => {
    const config = makeTestConfig({ output: { pipelineStage: true } });
    const ui = createPipelineUI(config);
    const { ctx, notifications } = makeUiCtx(pendingMeta());

    ui.stageEntry(ctx, "design-review");

    expect(notifications[0]).toContain(DESIGN_REVIEW_PENDING_TARGET);
    expect(notifications[0]).not.toContain("-> develop");
    expect(notifications[0]).not.toContain("-> paused");
  });

  it("a plain paused state (other reasons) keeps the original 'paused' token", () => {
    const config = makeTestConfig({ output: { pipelineStage: true } });
    const ui = createPipelineUI(config);
    const { ctx, notifications } = makeUiCtx(
      makeTestMeta({
        currentStage: "design-review",
        designReview: pendingState({ pauseReason: "drift", decision: undefined }),
      }),
    );

    ui.stageEntry(ctx, "design-review");

    expect(notifications[0]).toContain("-> paused");
    expect(notifications[0]).not.toContain(DESIGN_REVIEW_PENDING_TARGET);
  });
});

// ─── 212 Phase 3: truthful wait copy + owner-evidence fact ───────────────────

describe("212 Phase 3: the pending copy states the truth once, on every surface", () => {
  it("the shared constant promises 'at most once' + resume — never 'will open'/'next turn'", () => {
    // Review #8: the automatic menu may already be spent, so no surface may
    // promise a future automatic popup.
    expect(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION).toContain("at most once");
    expect(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION).toContain("/pipeline-resume always re-opens");
    expect(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION).not.toContain("will open");
    expect(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION).not.toContain("on its next turn");
  });

  it("all three consumer surfaces render the SAME constant (single source of truth)", async () => {
    const meta = pendingMeta();
    // pipeline_state tool — exact identity, not a paraphrase.
    const stateTool = createPipelineState(makeTestConfig());
    const stateResult = (await stateTool.execute({}, { session: { getMeta: () => meta } } as any)) as Record<string, any>;
    expect(stateResult.designReview.resume).toBe(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION);
    // /pipeline-status command.
    const command = createPipelineStatusCommand(makeTestConfig());
    const status = (await command.execute({}, { session: { getMeta: () => meta } } as any)) as { content: string };
    expect(status.content).toContain(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION);
    // prompt dynamic context.
    const hook = createPromptInjector(makeTestConfig());
    const injected = (await hook.handler({ session: { getMeta: () => meta } } as any))!;
    expect(injected.systemPrompt ?? "").toContain(DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION);
  });

  it("view.ownerEvidence: recorded with an owner file; missing with absent or blank evidence", () => {
    expect(buildDesignReviewPendingDecisionView(pendingMeta())!.ownerEvidence).toBe("recorded");
    const noOwner = pendingMeta({
      decision: { ...makePendingDecision("manual"), ownerSessionFile: undefined },
    });
    expect(buildDesignReviewPendingDecisionView(noOwner)!.ownerEvidence).toBe("missing");
    // persisted blank ("") normalizes to ABSENT — never counted as evidence.
    const blankOwner = pendingMeta({
      decision: { ...makePendingDecision("manual"), ownerSessionFile: "   " },
    });
    expect(buildDesignReviewPendingDecisionView(blankOwner)!.ownerEvidence).toBe("missing");
  });

  it("formatter appends the owner-evidence fact ONLY when missing (display only)", () => {
    const recorded = buildDesignReviewPendingDecisionView(pendingMeta())!;
    const line = formatDesignReviewPendingDecision(recorded);
    expect(line).toContain("pending — mode: manual");
    expect(line).not.toContain("owner evidence");
    const missing = buildDesignReviewPendingDecisionView(
      pendingMeta({ decision: { ...makePendingDecision("manual"), ownerSessionFile: undefined } }),
    )!;
    expect(formatDesignReviewPendingDecision(missing)).toContain("owner evidence: missing");
  });
});
