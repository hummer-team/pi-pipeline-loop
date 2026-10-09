/**
 * @module design-review/dispatch-task
 * 194 Phase 2 (D3/D6, task 1): build the ACTUAL task input for a design-review
 * closed-loop dispatch, by operation kind.
 *
 * The defect this module removes: every kind used to share one producer that
 * picked the input path with
 * `kind === "review" ? planDoc : (reportDoc ?? planDoc)` and a bare
 * `"<path> <round>"` prompt. For a develop handoff that handed the executor the
 * REVIEW REPORT as its task input (and a plan-less one-line prompt), so the
 * child "developed the report" instead of the plan, and the bare path made the
 * dispatched turn look like ordinary chat to the settle gate (D6).
 *
 * Contract (plan Phase 2 task 1):
 * - `review`         → stage design-review: plan under review, run identity,
 *   the report path it must PRODUCE, and the absolute report-template resource.
 * - `update`         → stage plan: the ORIGINAL plan to revise, the consumed
 *   report, the pinned standalone receipt document, the operation identity,
 *   plus the already-rendered authorized update prompt.
 * - `develop-handoff`→ stage develop: the ORIGINAL plan's Phases as the task,
 *   the develop deliverables, historical receipts explicitly NOT the task and
 *   the review report as read-only background only.
 *
 * The prompt is the whole RPC input, so it carries its own identity; every line
 * is derived from plugin-persisted state, never from model-supplied arguments.
 * The develop prompt opens with the plugin's trusted pipeline-turn signature
 * (`Begin the develop stage work now.`), which is what keeps a dispatched
 * executor turn out of the ordinary-chat branch of the settle gate.
 */
import type { DesignReviewOperationKind } from "../../types";
import { formatDesignReviewSpawnPrompt } from "./dispatch";

/** Trusted pipeline-turn signature prefix (see constants PIPELINE_TURN_SIGNATURES). */
const PIPELINE_TURN_PREFIX = "Begin the ";

/** Spawn stage a design-review operation dispatches into. */
export type DesignReviewDispatchStage = "design-review" | "plan" | "develop";

/** Everything the task builder needs, all plugin-derived and already persisted. */
export interface DesignReviewDispatchTaskInput {
  /** The operation kind that governs which task this dispatch is. */
  kind: DesignReviewOperationKind;
  /** Pipeline identity (from meta). */
  pipelineId: string;
  /** Absolute plan document — the object under review, revision or development. */
  planDoc: string;
  /** Absolute report document — output (review) or consumed input (update). */
  reportDoc: string;
  /** Design-review round. */
  round: number;
  /** Operation id of THIS dispatch. */
  operationId: string;
  /**
   * Update only: the pinned standalone receipt document path (C1). Absent for
   * a pre-194 legacy operation, whose receipt lives in the plan body.
   */
  receiptDoc?: string;
  /** Review only: absolute path of the deployed report template resource. */
  templateDoc?: string;
  /** Update only: the already-rendered, already-authorized update prompt. */
  updatePrompt?: string;
  /** Review only: smart plan-revision decision guidance (never for other kinds). */
  reviewGuidance?: string;
}

/** A completed dispatch task: exactly what the RPC receives. */
export interface DesignReviewDispatchTask {
  /** Stage the subagent runs. */
  stage: DesignReviewDispatchStage;
  /** Verbatim RPC prompt. */
  prompt: string;
  /** Spawn description (audit/UI). */
  description: string;
}

/** Identity header shared by every design-review dispatch. */
function identityLines(input: DesignReviewDispatchTaskInput): string[] {
  return [
    `Pipeline: ${input.pipelineId}`,
    `Round: ${input.round}`,
    `Operation: ${input.operationId}`,
  ];
}

/** review → design-review: review the plan, produce exactly this report. */
function buildReviewTask(input: DesignReviewDispatchTaskInput): DesignReviewDispatchTask {
  const lines = [
    formatDesignReviewSpawnPrompt("review", input.planDoc, input.round),
    "",
    "TASK: design review of the implementation plan (round " + String(input.round) + ").",
    ...identityLines(input),
    `Plan under review (read-only): ${input.planDoc}`,
    `Report to produce (the ONLY writable file): ${input.reportDoc}`,
  ];
  if (input.templateDoc !== undefined) {
    lines.push(`Report template (read this ABSOLUTE path directly, no directory search): ${input.templateDoc}`);
  }
  const guidance = input.reviewGuidance !== undefined ? `\n\n---\n\n${input.reviewGuidance}` : "";
  return {
    stage: "design-review",
    prompt: `${lines.join("\n")}${guidance}`,
    description: `Design review round ${input.round}: ${input.planDoc}`,
  };
}

/** update → plan: revise the ORIGINAL plan and write the standalone receipt. */
function buildPlanRevisionTask(input: DesignReviewDispatchTaskInput): DesignReviewDispatchTask {
  const lines = [
    formatDesignReviewSpawnPrompt("update", input.reportDoc, input.round),
    "",
    "TASK: revise the implementation plan according to the review findings.",
    ...identityLines(input),
    `Plan to revise in place (edit its own Phases): ${input.planDoc}`,
    `Consumed review report (read-only): ${input.reportDoc}`,
  ];
  if (input.receiptDoc !== undefined) {
    lines.push(
      `Update receipt to produce (a STANDALONE document, never a plan-body section): ${input.receiptDoc}`,
    );
  }
  // The rendered prompt carries the full authorized contract (issues, baseline
  // hash, disposition protocol); it stays the body of the dispatch.
  const body = input.updatePrompt !== undefined ? `\n\n---\n\n${input.updatePrompt}` : "";
  return {
    stage: "plan",
    prompt: `${lines.join("\n")}${body}`,
    description: `Design review update round ${input.round}: ${input.planDoc}`,
  };
}

/**
 * develop-handoff → develop: implement the ORIGINAL plan. The report is
 * background only and historical update receipts are explicitly NOT the task.
 */
function buildDevelopTask(input: DesignReviewDispatchTaskInput): DesignReviewDispatchTask {
  const lines = [
    // The trusted signature prefix keeps this plugin-dispatched turn out of the
    // ordinary-chat branch of the settle gate (D6).
    `${PIPELINE_TURN_PREFIX}develop stage work now. Pipeline: ${input.pipelineId}. ` +
      `Plan doc: ${input.planDoc} — implement it (contains the approved design)`,
    "",
    `TASK: develop the approved plan. Requirement and clarification conclusions ` +
      `are already folded into it.`,
    ...identityLines(input),
    `Plan to implement (read-only): ${input.planDoc}`,
    "Work through the plan Phase by Phase, in its declared order.",
    "Deliverables: code changes, `bun run typecheck` + `bun run build` + `bun test` passing, " +
      "per-phase commits, and the develop summary document.",
    `Review report (read-only BACKGROUND, not a task input): ${input.reportDoc}`,
    "Historical `## Design Review Update` sections and plan-update receipts are NOT tasks: " +
      "do not re-open, re-revise or replay them.",
  ];
  return {
    stage: "develop",
    prompt: lines.join("\n"),
    description: `Develop handoff round ${input.round}: ${input.planDoc}`,
  };
}

/**
 * Build the dispatch task for one design-review operation.
 *
 * The switch is EXHAUSTIVE: a kind outside the closed-loop vocabulary produces
 * `null`, and the caller must block the dispatch rather than guess a task —
 * that is how a stale or fabricated operation cannot hijack a stage.
 */
export function buildDesignReviewDispatchTask(
  input: DesignReviewDispatchTaskInput,
): DesignReviewDispatchTask | null {
  switch (input.kind) {
    case "review":
      return buildReviewTask(input);
    case "update":
      return buildPlanRevisionTask(input);
    case "develop-handoff":
      return buildDevelopTask(input);
    default: {
      // Exhaustiveness guard: new kinds must be handled explicitly.
      const unhandled: never = input.kind;
      void unhandled;
      return null;
    }
  }
}
