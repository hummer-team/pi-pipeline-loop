/**
 * @module stage-exit-refusal
 * 216_Bug (P3): refusal / defer accounting for the AUTO advance chain.
 *
 * One refusal truth (`transition_commit | bound_exit_refused`) already exists in
 * verify-advance; this module only decides what the AUTO chain does next:
 *   1st cause (child origin) → wake the owner ONCE (running-state arm, no freeze)
 *   2nd same cause           → freeze the stage and raise the decision menu
 *   same stage visit #2      → abort (the menu would only repeat the same dead end)
 *
 * Guards (all zero-side-effect):
 * - flow != "running"  → skipped (a frozen pipeline never grows the counter: R4-Q4-A)
 * - stage mismatch     → skipped (a stale child write must not resurrect a cleared counter)
 *
 * NOT counted here: recheck_blocked / budget_exceeded (their own convergence) and
 * the tool path (216 §4) — see review R6-4.
 */
import type { PipelineConfig, PipelineStage, SessionMeta, StageExitRefusal } from "../../types";
import { STAGE_EXIT_REFUSED_ESCALATION_REASON, STAGE_EXIT_REFUSED_OVERFLOW_REASON } from "../../constants";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { broadcastEscalation } from "../../utils/escalation-bus";
import { detectHostRole, freezeAndPrompt, getFlowState, markPipelineAborted } from "../flow-state";
import type { FlowStateCtx } from "../flow-state";

/** A defer/refusal on the SAME cause escalates once, then freezes. */
export const STAGE_EXIT_REFUSED_FREEZE_THRESHOLD = 2;

/**
 * Freezes burned inside ONE stage visit before the pipeline aborts instead of
 * re-opening the menu.
 * Source of truth: 216_Bug.md「full-und §2 冻结语义表」(`frozenCount>=1`) — it
 * supersedes the older `>=2` wording in R3-Q5-A / the R5 body (review R6-13).
 */
export const MAX_STAGE_EXIT_REFUSAL_FREEZES_PER_VISIT = 1;

export type StageExitRefusalOutcome = "skipped" | "counted" | "escalated" | "frozen" | "aborted";

/** Same members as StageExitCaller minus "tool" (tool path never counts, 216 §4). */
export type StageExitRefusalSource = "auto_advance" | "fix_executor" | "confirm_approve" | "hook_settle";

export interface StageExitRefusalCtx {
  session: FlowStateCtx["session"];
  /**
   * 216 review R6-7: role evidence is part of the CONTRACT. Without it,
   * detectSessionRole degrades to owner and a child-triggered freeze would
   * pop the menu in the child TUI (or abort via decision_provider_absent).
   */
  _ctx?: unknown;
  pi?: unknown;
  ui?: FlowStateCtx["ui"];
}

/** The only cast: `_ctx` is opaque pass-through (same idiom as flow-state's buildRoleCtxForGate). */
function toFlowCtx(ctx: StageExitRefusalCtx): FlowStateCtx {
  return { session: ctx.session, ui: ctx.ui, pi: ctx.pi, _ctx: ctx._ctx } as unknown as FlowStateCtx;
}

export async function recordStageExitRefusal(
  ctx: StageExitRefusalCtx,
  config: PipelineConfig,
  input: {
    stage: PipelineStage;
    fromStage: PipelineStage;
    toStage: PipelineStage | null;
    reason: string;
    source: StageExitRefusalSource;
  },
  hooks: { onStageChanged?: (meta: SessionMeta) => Promise<void> } = {},
): Promise<StageExitRefusalOutcome> {
  const flowCtx = toFlowCtx(ctx);
  const fresh = ctx.session.getMeta();
  // F4 + R4-Q4-A: stale or frozen writers are no-ops (zero write, zero audit).
  if (!fresh || getFlowState(fresh) !== "running" || fresh.currentStage !== input.stage) {
    return "skipped";
  }

  const prev = fresh.stageExitRefusal;
  const sameCause = prev !== undefined
    && prev.stage === input.stage
    && prev.fromStage === input.fromStage
    && prev.toStage === input.toStage
    && prev.reason === input.reason;
  // Freeze budget is scoped to the STAGE VISIT, not to one cause: a different
  // cause must not buy a second menu inside the same visit (216 R5-Q5-A).
  const sameVisit = prev !== undefined && prev.stage === input.stage;

  const count = sameCause && prev !== undefined ? prev.count + 1 : 1;
  const frozenCount = sameVisit && prev !== undefined ? prev.frozenCount : 0;
  const base: StageExitRefusal = {
    stage: input.stage, fromStage: input.fromStage, toStage: input.toStage,
    reason: input.reason, count, frozenCount, lastAt: Date.now(),
  };

  if (count < STAGE_EXIT_REFUSED_FREEZE_THRESHOLD) {
    // R6-4: an OWNER caller already sees the refusal in its own turn — waking
    // itself would cost an extra model turn and is not a cross-session handoff.
    if (detectHostRole(flowCtx) !== "child") {
      ctx.session.updateMeta({ stageExitRefusal: base });
      return "counted";
    }
    const at = Date.now();
    ctx.session.updateMeta({ stageExitRefusal: { ...base, escalatedAt: at } });
    broadcastEscalation(ctx.pi, {
      pipelineId: fresh.pipelineId,
      stage: input.stage,
      reason: STAGE_EXIT_REFUSED_ESCALATION_REASON,
      at,
    });
    await safeWriteAuditLog("stage_exit_refusal_escalated", {
      pipelineId: fresh.pipelineId, stage: input.stage, fromStage: input.fromStage,
      toStage: input.toStage ?? "none", reason: input.reason, count: String(count), source: input.source,
    }, "warn");
    return "escalated";
  }

  await safeWriteAuditLog("stage_exit_refusal_overflow", {
    pipelineId: fresh.pipelineId, stage: input.stage, fromStage: input.fromStage,
    toStage: input.toStage ?? "none", reason: input.reason, count: String(count),
    frozenCount: String(frozenCount), source: input.source,
  }, "warn");

  // Same stage visit already burned its menu: the root cause is unresolved.
  if (frozenCount >= MAX_STAGE_EXIT_REFUSAL_FREEZES_PER_VISIT) {
    ctx.session.updateMeta({ stageExitRefusal: base });
    await markPipelineAborted(flowCtx, STAGE_EXIT_REFUSED_OVERFLOW_REASON, { config });
    return "aborted";
  }

  ctx.session.updateMeta({ stageExitRefusal: { ...base, frozenCount: frozenCount + 1 } });
  await freezeAndPrompt(flowCtx, fresh, STAGE_EXIT_REFUSED_OVERFLOW_REASON, config, {
    ...(ctx.ui ? { ui: ctx.ui } : {}),
    ...(hooks.onStageChanged ? { onStageChanged: hooks.onStageChanged } : {}),
  });
  return "frozen";
}
