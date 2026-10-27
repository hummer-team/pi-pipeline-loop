/**
 * @module pipeline-status
 * Factory for the `/pipeline-status` command.
 *
 * 210 Phase 5 (requirement 5.2/5.3, Q16=A): two read-only views —
 * - running: current state + accumulated decision debt (who is waiting,
 *   for how long, what is left of the budgets) + absolute audit anchor;
 * - terminal (`completed` / `aborted`): "Last Run" summary instead of the
 *   baseline's degenerate `No active pipeline` dormant output.
 *
 * Both views are pure renders over session meta — no export, no disk writes.
 */

import type { PipelineConfig, Command, SessionMeta, PipelineStage, StageConfig } from "../types";
import { checkTemplateDrift } from "../utils/template-drift";
import { resolvePiWorkDir } from "../utils/work-dir";
import { buildProtectedPaths } from "../utils/protect";
import { isDormant, DORMANT_NO_PIPELINE_MESSAGE } from "../core/dormancy";
// 210 Phase 5: budget/cap readers reuse the production resolution helpers —
// `stage-advancer` does not import `commands/`, so this stays cycle-free.
import { resolveConfirmMaxRejections } from "../core/stage-advancer";
import { effectiveMax, remainingRoundsOf } from "../utils/stage-visit";
import { auditLogDirForPipeline } from "../utils/auditLog";
import { DEFAULT_CONFIRM_MAX_REJECTIONS, CONFIRM_GATE_REASK_MAX } from "../constants";
// 211 Phase 2: reask cap rendered as `reprompt N/CONFIRM_GATE_REASK_MAX` in the
// merged confirm-pending line below.
// 193 Phase 3 (task 8): read-only pending-decision display (shared view).
import {
  buildDesignReviewPendingDecisionView,
  formatDesignReviewPendingDecision,
  DESIGN_REVIEW_PENDING_READONLY_NOTICE,
  DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION,
} from "../core/design-review/decision-display";
// 213 Phase 0 (D17-③): ONE shared display-actor reader + its input type.
import { resolveDisplayActor } from "../core/design-review/runtime-context";
import type { DesignReviewActorInput } from "../core/design-review/decision-types";
// 210 review issue 12: single source for the /pipeline-resume guidance text
// (same hint used by the frozen notify / prompt-injector / blocked audit).
import { formatDecisionMenuHint } from "../core/flow-state";

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** Human duration: `45s` / `12m 34s` / `3h 07m`. Invalid/negative → "N/A". */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "N/A";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Local wall-clock rendering of a unix-ms timestamp; missing → "N/A". */
function fmtLocalTime(ts: number | undefined): string {
  if (!ts || ts <= 0) return "N/A";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return new Date(ts).toISOString();
  }
}

/** Audit directory anchor for the pipeline (absolute), "N/A" when uninitialized. */
function auditAnchor(meta: SessionMeta): string {
  return auditLogDirForPipeline(meta.pipelineId) ?? "N/A";
}

/**
 * Merged summary of everything currently waiting on a human decision
 * (requirement 5.2 `Pending decision`): frozen block, confirm-gate reask,
 * confirm-gate deferral stamp and the design-review pending decision.
 *
 * 210 review issue 12 (requirement 5.6): whenever anything is pending, the view
 * also states WHO is waiting (a human — the pipeline never auto-decides) and the
 * `/pipeline-resume` action that unblocks it, so the frozen state is actionable
 * from this read-only view alone. Still no writes and no new configuration.
 */
function summarizePendingDecision(meta: SessionMeta, actor?: DesignReviewActorInput): string {
  const bits: string[] = [];
  if (meta.flowState === "blocked") {
    bits.push(`blocked${meta.blockedReason ? ` (${meta.blockedReason})` : ""} [human decision]`);
  }
  // 211 Phase 2: one actionable line for both confirm-gate traces (reask and/or
  // deferral stamp). Keeps the 210 "[human confirm]" ownership tag and always
  // names the deterministic exit (/pipeline-resume, not bounded by the budget).
  const gateStage = meta.confirmGateDeferredAt?.stage ?? meta.confirmGateReask?.stage;
  if (gateStage) {
    const count = meta.confirmGateReask?.stage === gateStage ? meta.confirmGateReask.count : 0;
    bits.push(
      `confirm pending @${gateStage} (reprompt ${count}/${CONFIRM_GATE_REASK_MAX})` +
        ` - run /pipeline-resume [human confirm]`,
    );
  }
  const pending = buildDesignReviewPendingDecisionView(meta, actor);
  if (pending !== null) {
    bits.push(`design-review: ${formatDesignReviewPendingDecision(pending)} [human decision]`);
  }
  if (bits.length === 0) return "none";
  return `${bits.join("; ")}; waiting on: human - ${formatDecisionMenuHint()}`;
}
// ─── Running view ─────────────────────────────────────────────────────────────

/**
 * Renders the RUNNING status (existing baseline lines kept byte-for-byte,
 * Phase 5 decision-debt lines appended below them).
 */
export function renderRunningStatus(
  meta: SessionMeta,
  config: PipelineConfig,
  driftLine: string,
  auditDirAbs: string,
  /** 213 Phase 0 (D17-③): optional read-only caller identity; enables the
   *  honest three-state owner-evidence copy when present, byte-identical
   *  two-state rendering (unknown identity) when absent. */
  actor?: DesignReviewActorInput,
): string {
  const stageConfig: StageConfig | undefined = config.stages[meta.currentStage as PipelineStage];
  const currentSummary = meta.summaries[meta.currentStage as PipelineStage];
  // Shared with the merged `Pending decision` line (single view computation).
  const pendingDecision = buildDesignReviewPendingDecisionView(meta, actor);

  // Caps follow the EXISTING resolution conventions (plan Phase 5, task 2) —
  // no new config reading logic. The verify cap has no stage-level override in
  // the runtime types; the production chain (verify-advance.ts:756) is global
  // `maxVerifyAttempts ?? maxLoops ?? 3`.
  const verifyMax = config.maxVerifyAttempts ?? config.maxLoops ?? 3;
  const confirmMax = stageConfig
    ? resolveConfirmMaxRejections(config, stageConfig)
    : (config.maxConfirmRejections ?? DEFAULT_CONFIRM_MAX_REJECTIONS);

  const stageStartedAbs = fmtLocalTime(meta.stageStartTime);
  const stageStartedRel = meta.stageStartTime && meta.stageStartTime > 0
    ? `${fmtDuration(Date.now() - meta.stageStartTime)} ago`
    : "N/A";
  const runClock = meta.pipelineStartedAt ?? meta.stageStartTime;
  const elapsed = runClock && runClock > 0 ? fmtDuration(Date.now() - runClock) : "N/A";

  return (
    `# Pipeline Status\n` +
    `- ID: ${meta.pipelineId}\n` +
    `- Stage: ${meta.currentStage}\n` +
    `- Model: ${meta.currentModel?.modelId || "default"}\n` +
    `- Domain: ${meta.domain.id}@${meta.domain.version}\n` +
    `- Summary Status: ${currentSummary?.status || "Missing"} (Path: ${currentSummary?.path || "N/A"})\n` +
    `- Loop: ${meta.loopCount}/${meta.maxLoops} (Step: ${meta.currentStepIndex})\n` +
    `- Protected: ${buildProtectedPaths(config).join(", ")}\n` +
    driftLine +
    // 210 Phase 5: decision-debt block (every value falls back to "N/A").
    `\n- Requirement: ${meta.requirementDoc || "N/A"}\n` +
    `- Stage started: ${stageStartedAbs}${stageStartedRel !== "N/A" ? ` (${stageStartedRel})` : ""}\n` +
    `- Elapsed: ${elapsed}\n` +
    `- Verify attempts: ${meta.verifyAttempts ?? 0} / ${verifyMax}\n` +
    `- Confirm rejections: ${meta.confirmRejections ?? 0} / ${confirmMax}\n` +
    `- Loop budget: ${meta.loopCycleCount ?? 0}/${effectiveMax(meta, config)} (remaining rounds: ${remainingRoundsOf(meta, config)})\n` +
    `- Pending decision: ${summarizePendingDecision(meta, actor)}\n` +
    `- Audit: ${auditDirAbs}` +
    // Phase 4-4 (191): Display design-review state if active (kept in the running branch).
    (meta.designReview
      ? `\n\n## Design Review\n` +
        `- Phase: ${meta.designReview.phase}\n` +
        `- Round: ${meta.designReview.round}\n` +
        `- Operation: ${meta.designReview.operation?.kind || "N/A"}\n` +
        `- Plan: ${meta.designReview.planDoc}\n` +
        (meta.designReview.reportDoc ? `- Report: ${meta.designReview.reportDoc}\n` : "") +
        (meta.designReview.pauseReason ? `- Pause Reason: ${meta.designReview.pauseReason}\n` : "") +
        // 193 Phase 3 (task 8): pending human decision shows ONLY the
        // pending/mode/report/resume guidance — never an automatic next step.
        // 210 Phase 5: this block stays byte-identical (shared by consumers of
        // the 193 contract); the new `Pending decision` line is the merged view.
        (pendingDecision !== null
          ? `- Status: ${DESIGN_REVIEW_PENDING_READONLY_NOTICE}\n` +
            `- Decision: ${formatDesignReviewPendingDecision(pendingDecision)}\n` +
            `- Resume: ${DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION}\n`
          : "")
      : "")
  );
}

// ─── Terminal view ────────────────────────────────────────────────────────────

/**
 * Renders the TERMINAL ("Last Run") view for `completed` / `aborted` pipelines
 * (requirement 5.3). Read-only over meta — the fixed footer reminds that only
 * the latest run of THIS session is shown (dormant reset already dropped
 * older runs; no export, no persistence).
 */
export function renderTerminalStatus(
  meta: SessionMeta,
  config: PipelineConfig,
  auditDirAbs: string,
): string {
  const stageConfig: StageConfig | undefined = config.stages[meta.currentStage as PipelineStage];
  // Same resolution conventions as the running view (see note there).
  const verifyMax = config.maxVerifyAttempts ?? config.maxLoops ?? 3;
  const confirmMax = stageConfig
    ? resolveConfirmMaxRejections(config, stageConfig)
    : (config.maxConfirmRejections ?? DEFAULT_CONFIRM_MAX_REJECTIONS);

  const aborted = meta.flowState === "aborted";
  const flowStateLine = aborted
    ? `aborted${meta.terminateReason ? ` (reason: ${meta.terminateReason})` : ""}`
    : "completed";

  const visits = (meta.stageVisitOrder ?? []).join(" → ") || "N/A";

  const statParts: string[] = [];
  for (const [stage, snap] of Object.entries(meta.stageStats ?? {})) {
    if (!snap) continue;
    statParts.push(`${stage} ${fmtDuration(snap.durationMs)} (verify ${snap.verifyAttempts}, confirm ${snap.confirmRejections})`);
  }

  // 210 Phase 7: usage roll-up lines (requirement 5.9 display). Same 6-decimal
  // rounding convention as `collectRunAggregate` (1e-6 float tolerance rule);
  // an empty ledger degrades to "N/A", never "undefined".
  const usageEntries = Object.entries(meta.usageByStage ?? {});
  let costUsdTotal = 0;
  let totalTokens = 0;
  for (const [, snap] of usageEntries) {
    costUsdTotal += snap?.costUsd ?? 0;
    totalTokens += snap?.totalTokens ?? 0;
  }
  const costLine = usageEntries.length > 0
    ? `${String(Number(costUsdTotal.toFixed(6)))} usd (totalTokens ${totalTokens})`
    : "N/A";
  const modelParts = usageEntries.map(([stageName, snap]) => `${stageName}:${snap?.model ?? "unknown"}`);
  const modelsLine = modelParts.length > 0 ? modelParts.join(", ") : "N/A";

  const summaryParts: string[] = [];
  for (const [stage, s] of Object.entries(meta.summaries ?? {})) {
    if (s?.path) summaryParts.push(`${stage}: ${s.path}`);
  }

  return (
    `# Pipeline Status\n` +
    `## Last Run (terminal)\n` +
    `- Flow state: ${flowStateLine}\n` +
    `- Stage: ${meta.currentStage}\n` +
    `- Stage visits: ${visits}\n` +
    `- Loop cycles: ${meta.loopCycleCount ?? 0}\n` +
    `- Stage stats: ${statParts.length > 0 ? statParts.join("; ") : "N/A"}\n` +
    `- Cost: ${costLine}\n` +
    `- Models: ${modelsLine}\n` +
    `- Verify attempts: ${meta.verifyAttempts ?? 0} / ${verifyMax}\n` +
    `- Confirm rejections: ${meta.confirmRejections ?? 0} / ${confirmMax}\n` +
    `- Requirement: ${meta.requirementDoc || "N/A"}\n` +
    `- Summaries: ${summaryParts.length > 0 ? summaryParts.join("; ") : "N/A"}\n` +
    `- Audit: ${auditDirAbs}\n` +
    `\n> Note: this shows the most recent run of the CURRENT session only — no export, no persisted history.\n`
  );
}

// ─── Command factory ──────────────────────────────────────────────────────────

/** Template-drift line computation (fail-open, unchanged from baseline). */
async function computeDriftLine(config: PipelineConfig): Promise<string> {
  let driftLine = "- Template drift: 0 file(s)";
  try {
    const drifts = await checkTemplateDrift(config.projectRoot, resolvePiWorkDir(config));
    if (drifts.length > 0) {
      const names = drifts.map((d) => d.asset).join(", ");
      driftLine = `- Template drift: ${drifts.length} file(s) [${names}]`;
      // Phase 5 (173) C14: guide.md drift gets a specific hint
      if (drifts.some((d) => d.asset === "guide.md")) {
        driftLine += " — re-run /pipeline-init to overwrite";
      }
    }
  } catch {
    // Fail-open: drift check failure should not break status display
  }
  return driftLine;
}

/**
 * Creates the `/pipeline-status` command.
 *
 * Displays a comprehensive status overview including:
 * - Pipeline ID, current stage, model, domain
 * - Summary validation status
 * - Loop iteration count and step index
 * - Protected paths list
 * - 210 Phase 5: decision debt (verify/confirm/loop budgets, pending decision),
 *   requirement/plan anchors, absolute audit path; terminal runs render the
 *   read-only "Last Run" view instead of the dormant message.
 *
 * @param config - The pipeline configuration
 * @returns A Command object for the "pipeline-status" slash command
 */
export function createPipelineStatusCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-status",
    description: "Show current pipeline status",
    execute: async (_args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const rawMeta: SessionMeta | undefined = ctx.session.getMeta();
      // 210 Phase 5 entry branch (plan task 1): never-started → dormant (byte-identical baseline).
      if (!rawMeta || !rawMeta.pipelineId) {
        return { success: true, content: DORMANT_NO_PIPELINE_MESSAGE };
      }
      // Terminal states get the read-only Last Run view (Q16=A). This MUST come
      // before isDormant() — dormant condition 2/3 intentionally classifies
      // aborted/completed as silent, which is exactly what Phase 5 replaces.
      const terminal = rawMeta.flowState === "aborted" || rawMeta.currentStage === "completed";
      if (terminal) {
        return { success: true, content: renderTerminalStatus(rawMeta, config, auditAnchor(rawMeta)) };
      }
      // Defensive dormant guard (semantics unchanged for every other consumer).
      if (isDormant(rawMeta)) {
        return { success: true, content: DORMANT_NO_PIPELINE_MESSAGE };
      }
      const meta: SessionMeta = rawMeta;

      const driftLine = await computeDriftLine(config);
      // 213 Phase 0 (D17-③): resolve the CALLER identity once, read-only.
      // Absent evidence keeps the honest two-state rendering (the view then
      // behaves exactly like the pre-213 shared view).
      return {
        success: true,
        content: renderRunningStatus(meta, config, driftLine, auditAnchor(meta), resolveDisplayActor(ctx)),
      };
    },
  };
}
