/**
 * 194 Phase 2 (task 1): unit tests for the per-kind dispatch task producer.
 *
 * Guards the defect removal: a develop handoff must be built from the ORIGINAL
 * PLAN (not the review report), every dispatch must carry its own identity,
 * the develop prompt must open with the trusted pipeline-turn signature, the
 * smart-plan guidance must stay on review dispatches only, and an unknown
 * kind must produce `null` so the coordinator blocks instead of guessing.
 */
import { describe, expect, test } from "bun:test";
import type { DesignReviewOperationKind } from "../../types";
import {
  buildDesignReviewDispatchTask,
  type DesignReviewDispatchTaskInput,
} from "../../core/design-review/dispatch-task";

const PIPELINE = "pipe-194-test";
const PLAN = "docs/design/179_Bug_plan.md";
const REPORT = "docs/design/179_Bug_18_review_report.md";
const RECEIPT = "docs/design/179_Bug_18_update_receipt.md";
const TEMPLATE = "/abs/project/.pi/references/design_review_report_template.md";

/** Base input: every test overrides only what its assertion is about. */
function baseInput(kind: DesignReviewOperationKind): DesignReviewDispatchTaskInput {
  return {
    kind,
    pipelineId: PIPELINE,
    planDoc: PLAN,
    reportDoc: REPORT,
    round: 18,
    operationId: "op-uuid-18",
  };
}

describe("194 Phase 2: buildDesignReviewDispatchTask — review", () => {
  test("dispatches stage design-review with the plan as object under review", () => {
    const task = buildDesignReviewDispatchTask(baseInput("review"));
    expect(task).not.toBeNull();
    expect(task!.stage).toBe("design-review");
    // Legacy-compatible first line: "<plan> <round>" (escaped spaces).
    expect(task!.prompt.split("\n")[0]).toBe(`${PLAN} 18`);
    expect(task!.prompt).toContain(`Plan under review (read-only): ${PLAN}`);
    // The report is what the review must PRODUCE, not an input.
    expect(task!.prompt).toContain(`Report to produce (the ONLY writable file): ${REPORT}`);
  });

  test("carries run identity (pipeline / round / operation)", () => {
    const task = buildDesignReviewDispatchTask(baseInput("review"))!;
    expect(task.prompt).toContain(`Pipeline: ${PIPELINE}`);
    expect(task.prompt).toContain(`Round: 18`);
    expect(task.prompt).toContain(`Operation: op-uuid-18`);
  });

  test("embeds the absolute template path when preflight resolved one", () => {
    const task = buildDesignReviewDispatchTask({ ...baseInput("review"), templateDoc: TEMPLATE })!;
    expect(task.prompt).toContain(
      `Report template (read this ABSOLUTE path directly, no directory search): ${TEMPLATE}`,
    );
  });

  test("omits the template line when the resource is not deployed", () => {
    const task = buildDesignReviewDispatchTask(baseInput("review"))!;
    expect(task.prompt).not.toContain("Report template");
  });

  test("appends smart-plan guidance when provided", () => {
    const task = buildDesignReviewDispatchTask({
      ...baseInput("review"),
      reviewGuidance: "## Design Review Smart Plan-Revision Decision\n...",
    })!;
    expect(task.prompt).toContain("## Design Review Smart Plan-Revision Decision");
  });

  test("description names the round and the plan", () => {
    const task = buildDesignReviewDispatchTask(baseInput("review"))!;
    expect(task.description).toContain("round 18");
    expect(task.description).toContain(PLAN);
  });
});

describe("194 Phase 2: buildDesignReviewDispatchTask — update", () => {
  test("dispatches stage plan revising the ORIGINAL plan in place", () => {
    const task = buildDesignReviewDispatchTask(baseInput("update"));
    expect(task).not.toBeNull();
    expect(task!.stage).toBe("plan");
    // First line keeps the legacy form keyed to the consumed REPORT.
    expect(task!.prompt.split("\n")[0]).toBe(`${REPORT} 18`);
    expect(task!.prompt).toContain(`Plan to revise in place (edit its own Phases): ${PLAN}`);
    expect(task!.prompt).toContain(`Consumed review report (read-only): ${REPORT}`);
  });

  test("pins the standalone receipt document for a 194 update operation", () => {
    const task = buildDesignReviewDispatchTask({ ...baseInput("update"), receiptDoc: RECEIPT })!;
    expect(task.prompt).toContain(
      `Update receipt to produce (a STANDALONE document, never a plan-body section): ${RECEIPT}`,
    );
  });

  test("omits the receipt line for a legacy operation without an artifact", () => {
    const task = buildDesignReviewDispatchTask(baseInput("update"))!;
    expect(task.prompt).not.toContain("Update receipt to produce");
  });

  test("keeps the rendered authorized update prompt as the body", () => {
    const task = buildDesignReviewDispatchTask({
      ...baseInput("update"),
      updatePrompt: "AUTHORIZED UPDATE BODY",
    })!;
    expect(task.prompt).toContain("AUTHORIZED UPDATE BODY");
  });

  test("never carries review guidance", () => {
    const task = buildDesignReviewDispatchTask({
      ...baseInput("update"),
      reviewGuidance: "## Design Review Smart Plan-Revision Decision",
    })!;
    expect(task.prompt).not.toContain("Smart Plan-Revision Decision");
  });
});

describe("194 Phase 2: buildDesignReviewDispatchTask — develop handoff", () => {
  test("dispatches stage develop from the ORIGINAL plan (D3)", () => {
    const task = buildDesignReviewDispatchTask(baseInput("develop-handoff"));
    expect(task).not.toBeNull();
    expect(task!.stage).toBe("develop");
    expect(task!.prompt).toContain(`Plan to implement (read-only): ${PLAN}`);
    // The report is background only — it must never appear as the task input.
    expect(task!.prompt).toContain(`Review report (read-only BACKGROUND, not a task input): ${REPORT}`);
    // Regression guard for D3: the first line is the trusted signature, never
    // the legacy bare "<report> <round>" form the shared producer used to emit.
    expect(task!.prompt.split("\n")[0]).not.toBe(`${REPORT} 18`);
    expect(task!.prompt.split("\n")[0]).toContain("Begin the develop stage work now");
  });

  test("opens with the trusted pipeline-turn signature (D6)", () => {
    const task = buildDesignReviewDispatchTask(baseInput("develop-handoff"))!;
    // The settle gate matches PIPELINE_TURN_SIGNATURES via startsWith.
    expect(task.prompt.startsWith("Begin the ")).toBe(true);
    expect(task.prompt.split("\n")[0]).toContain("develop stage work now");
  });

  test("names develop deliverables and phase-by-phase execution", () => {
    const task = buildDesignReviewDispatchTask(baseInput("develop-handoff"))!;
    expect(task.prompt).toContain("Work through the plan Phase by Phase");
    expect(task.prompt).toContain("bun run typecheck");
  });

  test("explicitly excludes historical receipts from the task", () => {
    const task = buildDesignReviewDispatchTask(baseInput("develop-handoff"))!;
    expect(task.prompt).toContain("are NOT tasks");
  });

  test("never carries review guidance", () => {
    const task = buildDesignReviewDispatchTask({
      ...baseInput("develop-handoff"),
      reviewGuidance: "GUIDANCE-MUST-NOT-APPEAR",
    })!;
    expect(task.prompt).not.toContain("GUIDANCE-MUST-NOT-APPEAR");
  });
});

describe("194 Phase 2: buildDesignReviewDispatchTask — kind closure", () => {
  test("unknown kind returns null (no guessed task)", () => {
    const bogus = baseInput("review");
    (bogus as { kind: unknown }).kind = "stage-hijack";
    expect(buildDesignReviewDispatchTask(bogus)).toBeNull();
  });

  test("every closed-loop kind produces a task", () => {
    for (const kind of ["review", "update", "develop-handoff"] as const) {
      expect(buildDesignReviewDispatchTask(baseInput(kind))).not.toBeNull();
    }
  });
});

describe("194 Phase 2: buildDesignReviewDispatchTask — special paths", () => {
  const SPACED_PLAN = "docs/design/My Bug Plan.md";

  test("review first line escapes spaces like the legacy producer", () => {
    const task = buildDesignReviewDispatchTask({ ...baseInput("review"), planDoc: SPACED_PLAN })!;
    expect(task.prompt.split("\n")[0]).toBe("docs/design/My\\ Bug\\ Plan.md 18");
    // Identity lines keep the raw path (they are prose, not a command).
    expect(task.prompt).toContain(`Plan under review (read-only): ${SPACED_PLAN}`);
  });

  test("develop prompt carries the raw spaced plan path and stays signature-first", () => {
    const task = buildDesignReviewDispatchTask({
      ...baseInput("develop-handoff"),
      planDoc: SPACED_PLAN,
    })!;
    expect(task.prompt.startsWith("Begin the ")).toBe(true);
    expect(task.prompt).toContain(`Plan to implement (read-only): ${SPACED_PLAN}`);
  });
});
