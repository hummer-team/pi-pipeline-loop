/**
 * 200 Bug Phase 3 (G3-1 / G3-2 / G3-3): the paused write-policy matrix.
 *
 * A `paused` loop used to be one-size readonly. This suite pins the narrow
 * exception: during a NON-decision pause the CURRENT review operation's bound
 * reportDoc stays editable as an exact-path `scoped` grant (the executor must
 * be able to persist its report while the owner arranges recovery), while
 *
 *  - the decision-anchor windows (`decision-pending` / `new-decision`) keep
 *    the full freeze — the owner is reading exactly the anchored content;
 *  - `update` / `develop-handoff` operations and unbound reportDoc paths stay
 *    readonly (fail closed, unchanged semantics);
 *  - an unprovable identity still blocks BEFORE any pause handling;
 *  - a `finished` record keeps the finished-release behavior intact (G3-3).
 */
import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import type {
  DesignReviewOperation,
  DesignReviewPauseReason,
  DesignReviewState,
  SessionMeta,
} from "../../types";
import {
  describeWriteScope,
  isPausedReportEditable,
  isPathWithinWriteScope,
  resolveDesignReviewWritePolicy,
} from "../../core/design-review/write-policy";
import { createInitialState } from "../../core/design-review/state";
import { makeTestMeta } from "../helpers";

const PIPELINE = "pipe-200-paused";
const REVIEW_OP = "44444444-4444-4444-8444-444444444444";
const UPDATE_OP = "55555555-5555-4555-8555-555555555555";
const HANDOFF_OP = "66666666-6666-4666-8666-666666666666";

const PLAN_DOC = "/tmp/200-bug/docs/plan.md";
const REPORT_DOC = "/tmp/200-bug/docs/review-design-1-plan.md";

/** The eight recovery pauses that release the current report (G3-2). */
const EDITABLE_PAUSE_REASONS: DesignReviewPauseReason[] = [
  "no-change",
  "drift",
  "unavailable",
  "authorization-lost",
  "budget-exhausted",
  "unknown-dispatch",
  "update-invalid",
  "executor-failed",
];

/** The two decision-anchor windows that keep the freeze (G3-2 exemption). */
const FROZEN_PAUSE_REASONS: DesignReviewPauseReason[] = [
  "decision-pending",
  "new-decision",
];

function operation(
  kind: DesignReviewOperation["kind"],
  operationId: string,
): DesignReviewOperation {
  return {
    operationId,
    kind,
    stageVisitId: 1000,
    attempt: 1,
    dispatchState: "dispatched",
    createdAt: 1,
    updatedAt: 1,
  };
}

function stateFor(patch: Partial<DesignReviewState>): DesignReviewState {
  return {
    ...createInitialState(PLAN_DOC, "menu", "a".repeat(64), undefined, {
      pipelineId: PIPELINE,
    }),
    reportDoc: REPORT_DOC,
    ...patch,
  };
}

function metaFor(state: DesignReviewState): SessionMeta {
  return makeTestMeta({
    currentStage: "design-review",
    pipelineId: PIPELINE,
    designReview: state,
  });
}

describe("200 Phase 3: isPausedReportEditable predicate", () => {
  it("fires only for paused + bound review + non-anchor reason", () => {
    for (const reason of EDITABLE_PAUSE_REASONS) {
      expect(
        isPausedReportEditable(
          stateFor({ phase: "paused", pauseReason: reason, operation: operation("review", REVIEW_OP) }),
        ),
      ).toBe(true);
    }
  });

  it("never fires inside the decision-anchor windows", () => {
    for (const reason of FROZEN_PAUSE_REASONS) {
      expect(
        isPausedReportEditable(
          stateFor({ phase: "paused", pauseReason: reason, operation: operation("review", REVIEW_OP) }),
        ),
      ).toBe(false);
    }
  });

  it("a legacy record without pauseReason behaves like the rendered 'paused' (editable)", () => {
    expect(
      isPausedReportEditable(
        stateFor({ phase: "paused", pauseReason: undefined, operation: operation("review", REVIEW_OP) }),
      ),
    ).toBe(true);
  });

  it("excludes unbound/empty reportDoc (fail-closed preserved)", () => {
    const base = { phase: "paused" as const, pauseReason: "drift" as const, operation: operation("review", REVIEW_OP) };
    expect(isPausedReportEditable(stateFor({ ...base, reportDoc: undefined }))).toBe(false);
    expect(isPausedReportEditable(stateFor({ ...base, reportDoc: "" }))).toBe(false);
  });

  it("excludes update / develop-handoff operations and live phases", () => {
    expect(
      isPausedReportEditable(stateFor({ phase: "paused", pauseReason: "drift", operation: operation("update", UPDATE_OP) })),
    ).toBe(false);
    expect(
      isPausedReportEditable(stateFor({ phase: "paused", pauseReason: "drift", operation: operation("develop-handoff", HANDOFF_OP) })),
    ).toBe(false);
    expect(
      isPausedReportEditable(stateFor({ phase: "review_running", operation: operation("review", REVIEW_OP) })),
    ).toBe(false);
  });
});

describe("200 Phase 3: the paused write-policy matrix", () => {
  it.each(EDITABLE_PAUSE_REASONS)("paused(%s) + bound review → scoped grant of EXACTLY the reportDoc", (reason) => {
    const policy = resolveDesignReviewWritePolicy(
      metaFor(stateFor({ phase: "paused", pauseReason: reason, operation: operation("review", REVIEW_OP) })),
    );
    expect(policy.mode).toBe("scoped");
    expect(policy.operationKind).toBe("review");
    expect(policy.phase).toBe("paused");
    expect(policy.writable).toEqual([path.resolve(REPORT_DOC)]);
    // Exact-path membership: the report passes, its siblings never do.
    expect(isPathWithinWriteScope(policy, path.resolve(REPORT_DOC), path.resolve(REPORT_DOC))).toBe(true);
    const sibling = path.resolve("/tmp/200-bug/docs/review-design-2-plan.md");
    expect(isPathWithinWriteScope(policy, sibling, sibling)).toBe(false);
    expect(describeWriteScope(policy)).toContain("EXACTLY these files");
  });

  it.each(FROZEN_PAUSE_REASONS)("paused(%s) keeps the full freeze (readonly, reason named)", (reason) => {
    const policy = resolveDesignReviewWritePolicy(
      metaFor(stateFor({ phase: "paused", pauseReason: reason, operation: operation("review", REVIEW_OP) })),
    );
    expect(policy.mode).toBe("readonly");
    expect(policy.writable).toEqual([]);
    expect(policy.reason).toBe(`paused:${reason}`);
    expect(describeWriteScope(policy)).toContain("waiting for the owner");
  });

  it("paused + update operation stays readonly (receipts/planDoc not released)", () => {
    const policy = resolveDesignReviewWritePolicy(
      metaFor(stateFor({ phase: "paused", pauseReason: "update-invalid", operation: operation("update", UPDATE_OP) })),
    );
    expect(policy.mode).toBe("readonly");
    expect(policy.reason).toBe("paused:update-invalid");
  });

  it("paused + review but unbound reportDoc fails closed to readonly", () => {
    const policy = resolveDesignReviewWritePolicy(
      metaFor(stateFor({ phase: "paused", pauseReason: "drift", operation: operation("review", REVIEW_OP), reportDoc: undefined })),
    );
    expect(policy.mode).toBe("readonly");
    expect(policy.reason).toBe("paused:drift");
  });

  it("an unprovable identity blocks BEFORE the pause release", () => {
    const policy = resolveDesignReviewWritePolicy(
      metaFor(stateFor({ phase: "paused", pauseReason: "drift", authorizationId: "", operation: operation("review", REVIEW_OP) })),
    );
    expect(policy.mode).toBe("blocked");
    expect(policy.reason).toBe("design_review_identity_incomplete");
  });

  it("G3-3 regression pin: a finished record keeps the finished-release shape", () => {
    const policy = resolveDesignReviewWritePolicy(
      metaFor(stateFor({ phase: "finished", pauseReason: undefined, operation: operation("review", REVIEW_OP) })),
    );
    // Finished is the conditional ordinary release — never a paused-style
    // scoped grant, and finishedRelease stays set for the artifact guards.
    expect(policy.mode).toBe("ordinary");
    expect(policy.finishedRelease).toBe(true);
    expect(policy.writable).toEqual([]);
  });
});
