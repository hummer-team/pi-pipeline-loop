/**
 * @module design-review/entry-result
 * 193 Phase 0 (round-1 review issue 3): ONE deterministic consumer for a
 * design-review coordinator result, shared by every entry point (agent-settled
 * hook, stage_advance / pipeline_verify / pipeline_handoff tools and — from
 * Phase 3 — the resume/start commands).
 *
 * Why the previous per-entry mapping was wrong: each tool translated the
 * coordinator result with `success = action !== "frozen" && action !== "pending"`,
 * so a `verify_failed` (invalid report) was reported to the agent as SUCCESS and
 * no attempt was recorded — the corrective loop silently stopped. Here:
 *
 * - `verify_failed` on a RUNNING review/update applies `applyVerifyFail` EXACTLY
 *   ONCE (the normal retry budget) and reports success=false/passed=false plus
 *   the concrete corrective guidance (report-domain failures get the full report
 *   template from `report-feedback`, other feedback text is untouched).
 * - the hook entry consumes with `method="rule"` (may wake the model under the
 *   existing budget), tool/command entries use `method="tool"` (never wakes;
 *   guidance is shown proactively instead).
 * - a child session NEVER consumes its owner's report: it waits, records zero
 *   budget and shows no menu (no parent+child double count in one call).
 * - nothing here returns success for a non-advanced/non-routed action.
 *
 * No meta is read twice for the same decision: the caller passes the freshest
 * meta, and the RUNNING phase is derived from THAT snapshot.
 */

import type { PipelineConfig, SessionMeta, VerifyFailureItem } from "../../types";
import { applyVerifyFail } from "../verify-advance";
import type { PipelineUI } from "../pipeline-ui";
import { isChildRuntimeCtx } from "../../utils/subagent-rpc";
import type { CoordinatorResult } from "./coordinator";
import { buildDesignReviewReportFeedback } from "./report-feedback";

/** Entry that produced the coordinator result. */
export type DesignReviewEntryKind = "hook" | "tool" | "command";

/** Structured result shape tool/command entries return to the agent. */
export interface DesignReviewEntryToolResult {
  success: boolean;
  passed: boolean;
  action: string;
  message: string;
  toStage?: string;
  failures?: VerifyFailureItem[];
}

/** Normalised outcome of consuming one coordinator result. */
export interface DesignReviewEntryOutcome {
  /** True when the domain consumed this result (caller must skip ordinary logic) */
  handled: boolean;
  /** True when THIS call recorded exactly one verify-fail budget attempt */
  failureRecorded: boolean;
  /** Deferred because the session is a child subagent (zero budget recorded) */
  deferredToOwner: boolean;
  /** Human/agent visible message for this result */
  message: string;
  /** Structured result for tool/command entries (absent for the hook entry) */
  toolResult?: DesignReviewEntryToolResult;
}

/** Session context forwarded to the shared failure consumer. */
type ApplyFailCtx = Parameters<typeof applyVerifyFail>[0];

/**
 * 193 Phase 3: public alias of the shared failure-consumer context
 * (session/ui/pi/_ctx shape) so command/startup entries can consume a
 * `verify_failed` WITHOUT importing applyVerifyFail just for the cast.
 */
export type DesignReviewConsumeCtx = ApplyFailCtx;

/** Input for consuming exactly one coordinator result. */
export interface ConsumeDesignReviewResultInput {
  /** The coordinator result for THIS call (never a cached/older one) */
  result: CoordinatorResult;
  /** Freshest meta AFTER the coordinator ran (single snapshot for the decision) */
  meta: SessionMeta;
  /** Which entry is consuming the result */
  entry: DesignReviewEntryKind;
  /** Session/pi/ui context forwarded to applyVerifyFail */
  ctx: ApplyFailCtx;
  /** Pipeline configuration (budget/freeze policy) */
  config: PipelineConfig;
  /** Shared PipelineUI for TUI output */
  ui?: PipelineUI;
  /** Raw runtime ctx (when available) for owner/child role detection */
  runtimeCtx?: unknown;
}

/** True when the snapshot design-review state is an active running phase. */
function isRunningPhase(meta: SessionMeta): boolean {
  const phase = meta.designReview?.phase;
  return phase === "review_running" || phase === "update_running";
}

/** True when this session is a child subagent (owner-only consumption). */
function detectIsChild(runtimeCtx: unknown): boolean {
  try {
    return isChildRuntimeCtx(runtimeCtx);
  } catch {
    // Conservative: an unreadable role keeps the OWNER semantics (the state
    // consumer is still fail-closed on identity/commit checks).
    return false;
  }
}

/** Build the shared verify-fail input shape from raw domain failures. */
function failInputFrom(
  failures: readonly VerifyFailureItem[],
): Parameters<typeof applyVerifyFail>[3] {
  return {
    structuredResult: {
      failures: failures.map((f) => ({ ruleType: f.ruleType, detail: f.detail, group: f.group })),
    },
    ruleMissing: [],
    verifyResult: { structured: { passed: false }, overallPassed: false },
  };
}

/** Map a handled action to the honest success flag (never success by default). */
function successForAction(action: string): boolean {
  return action === "advanced" || action === "routed";
}

/**
 * Consume one design-review coordinator result for the calling entry.
 *
 * The caller MUST stop ordinary processing whenever `handled` is true, and for
 * tool/command entries return `toolResult` unchanged (it already carries the
 * honest success flag and the concrete guidance).
 */
export async function consumeDesignReviewResult(
  input: ConsumeDesignReviewResultInput,
): Promise<DesignReviewEntryOutcome> {
  const { result, meta, entry, ctx, config, ui } = input;

  if (result.status === "not-applicable") {
    return {
      handled: false,
      failureRecorded: false,
      deferredToOwner: false,
      message: "",
    };
  }

  const action = result.action;
  const reasonText = "reason" in result ? result.reason : `Design review ${action}`;
  const toStage = "toStage" in result ? result.toStage : undefined;
  const method = entry === "hook" ? "rule" : "tool";
  const running = isRunningPhase(meta);

  // ── invalid deliverable → the ONE normal verification-failure budget ──────
  if (action === "verify_failed") {
    if (!running) {
      // Not a running review/update: never a format failure, never a budget
      // attempt (a paused/ready state is consumed by the domain, not here).
      return {
        handled: true,
        failureRecorded: false,
        deferredToOwner: false,
        message: reasonText,
        toolResult: {
          success: false,
          passed: false,
          action,
          message: `Design review reported a verification failure outside a running phase (${reasonText}).`,
        },
      };
    }

    if (entry !== "hook" && detectIsChild(input.runtimeCtx)) {
      // Child sessions must not consume the owner's report: zero budget, no
      // guidance injection, no advance — the owner settle consumes it.
      return {
        handled: true,
        failureRecorded: false,
        deferredToOwner: true,
        message: "Design-review report consumption deferred to the owner session.",
        toolResult: {
          success: false,
          passed: false,
          action: "pending",
          message:
            "Design-review report is handled by the owner session. Wait for the owner; do not retry this call.",
        },
      };
    }

    const failures = "failures" in result ? [...result.failures] : [];
    const failResult = await applyVerifyFail(
      ctx,
      meta,
      meta.currentStage,
      failInputFrom(failures),
      method,
      ui,
      config,
    );

    // Report-domain failures carry the complete corrective template; every
    // other failure keeps the existing generic text (193 Phase 0 task 4).
    const reportFeedback = buildDesignReviewReportFeedback({
      meta,
      stageName: meta.currentStage,
      failures,
    });
    const guidance = reportFeedback ? reportFeedback.message : failResult.message;

    if (entry !== "hook") {
      // Tool/command entries never wake the model (method="tool"), so the
      // guidance must be visible proactively.
      try {
        ctx.ui?.notify(guidance);
      } catch {
        // Notification must never replace the failure result itself.
      }
    }

    return {
      handled: true,
      failureRecorded: true,
      deferredToOwner: false,
      message: guidance,
      toolResult:
        entry === "hook"
          ? undefined
          : {
              success: false,
              passed: false,
              action,
              message: guidance,
              failures,
            },
    };
  }

  // ── every other handled action: honest flags, no budget side effects ──────
  const success = successForAction(action);
  return {
    handled: true,
    failureRecorded: false,
    deferredToOwner: false,
    message: reasonText,
    toolResult:
      entry === "hook"
        ? undefined
        : {
            success,
            passed: success,
            action,
            message: toStage !== undefined ? `${reasonText} → ${toStage}` : reasonText,
            ...(toStage !== undefined ? { toStage } : {}),
          },
  };
}
