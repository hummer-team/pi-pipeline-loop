/**
 * @module pipeline-start
 * /pipeline-start <doc_file.md> — initializes a pipeline run from a requirement document.
 * Supports three startup modes (config.startStageMode):
 * - "auto": Zero-interaction default (fresh → clarify; aborted → resume/new matrix).
 * - "confirm": Lightweight confirmation on resume-eligible aborted pipelines.
 * - "ask": Interactive TUI menu (new/resume/spec/cancel) with spec-stage jump.
 */

import fs from "node:fs";
import path from "node:path";
import type { PipelineConfig, PipelineStage, Command, SessionMeta, StartStageMode } from "../types";
import {
  AUDIT_THROTTLE_WINDOW_MS,
  DEFAULT_VERIFY_FILE,
  resolveStagePath,
  RESUMABLE_STAGES,
  DEFAULT_MAX_LOOP_CYCLES,
  MAX_DOC_CANDIDATES,
} from "../constants";
import { safeWriteAuditLog, safeWriteStageAudit, writeAuditLog, prepareAuditPipelineLog } from "../utils/auditLog";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { getFlowState, isFrozen, formatFrozenReason, requestDecision, resolveDecisionReason, formatDecisionMenuHint } from "../core/flow-state";
// 210 review issue 2: the first stage visit of a run must own its clocks —
// arm/clear the opt-in stage watchdog at the start & dispatch entry points.
import { armStageWatchdog } from "../core/stage-watchdog";
import { createPipelineUI, syncStageStatusBar } from "../core/pipeline-ui";
import { buildStageSequence } from "../utils/stage-sequence";
import {
  checkTemplateResidues,
  computeResidueFingerprint,
  readResidueGateStatus,
  writeResidueGateStatus,
} from "../core/template-residue-check";
import { registerSession } from "../utils/session-registry";
import { spawnClarifySubagent, spawnStageSubagent, watchSubagentLifecycle, resolveAgentMention } from "../utils/subagent-rpc";
import { buildNewPeriodResetFields } from "../core/meta-reset";
// 210 Phase 7: restart/resume clears the in-process usage ledger.
import { resetUsage } from "../core/usage-recorder";
// Phase 0 (182): name-probe for out-of-band agent detection before dispatch
import { findLiveAgentByName } from "../utils/subagents-introspect";
import { isSubagentsReady } from "../utils/subagent-availability";
import { scanAuditFlows } from "../utils/doc-flow-index";
import { deriveClarifyForwardArgs } from "../utils/clarify-args";
import { loadVerifyContractAnchors } from "../utils/contract-loader";
import { staleConfigNotice } from "../utils/config-staleness";
import { resolveAuditDir, resolvePiWorkDir } from "../utils/work-dir";
import { appendPipelineIdMarker } from "../utils/pipeline-id-marker";
// Round 5 (N-3): coordinator for design-review dispatch
import { coordinateDesignReview } from "../core/design-review/coordinator";
import { classifyDesignReviewFlow, isDevelopHandoffOperation } from "../core/design-review/state";
// 206 Phase 2: doc-candidate menu for empty-file starts
import {
  listDocCandidates,
  findLatestDocForStage,
  resolveCurrentDocOption,
  type DocCandidate,
} from "../core/doc-discovery";
// 193 Phase 3 (tasks 1/2): shared safe coordinator builder + single consumer
import { createDesignReviewRuntimeContext } from "../core/design-review/runtime-context";
import { consumeDesignReviewResult, type DesignReviewConsumeCtx } from "../core/design-review/entry-result";
// 194 Phase 3 (task 7, review issue 3): a new pipeline start invalidates a stale executor binding
import { invalidateExecutorRunOnBoundary } from "../core/stage-executor/recovery";

/**
 * Checks that all 5 active stages have agentPath configured.
 * Skips disabled stages (require: false in JSON config).
 * Returns array of stage names missing agentPath.
 */
function checkAgentPaths(config: PipelineConfig): PipelineStage[] {
  const activeStages: PipelineStage[] = [
    "clarify", "plan", "design-review", "develop", "review", "fix",
  ];
  const missing: PipelineStage[] = [];
  for (const stage of activeStages) {
    const stageConfig = config.stages[stage];
    // Skip disabled stages (aligned with checkVerifyFiles filter style)
    if (stageConfig?.disabled) continue;
    if (!stageConfig?.agentPath) {
      missing.push(stage);
    }
  }
  return missing;
}

/**
 * 147 Phase 6: Template-residue gate check.
 *
 * Blocks pipeline-start when `.pi/skills/` or `.pi/agents/` files still carry
 * unresolved `Template-TODO` placeholders. The check is pure-rule (no LLM).
 *
 * Short-circuit: if the persistent gate status file reports `passed=true` AND
 * the current fingerprint matches, the check is skipped entirely (cross-restart
 * idempotent).
 *
 * Failure modes:
 * - Clean residues → write gate status + proceed (return null).
 * - Residues + TUI available → block with a 2-choice select (re-check / cancel).
 * - Residues + no TUI → degrade to non-blocking notify + audit; proceed.
 *
 * @returns null when the check passes / degrades, or `{ success: false, error }`
 *   when the user cancels startup.
 */
async function templateResidueGate(
  config: PipelineConfig,
  ctx?: any,
): Promise<null | { success: false; error: string }> {
  // Short-circuit: persisted pass + matching fingerprint → skip re-scan
  try {
    const status = readResidueGateStatus(config.projectRoot, config.auditDir);
    if (status?.passed === true) {
      const currentFp = computeResidueFingerprint(config.projectRoot, resolvePiWorkDir(config));
      if (status.fingerprint === currentFp) {
        // Fingerprints match — cached pass is still valid
        return null;
      }
      // Fingerprint drift — file content changed, re-check
    }
  } catch {
    // Any read failure → fail-open, proceed to full scan
  }

  const result = checkTemplateResidues(config.projectRoot, resolvePiWorkDir(config));

  if (result.clean) {
    // Clean → persist gate status for future short-circuit
    try {
      const fingerprint = computeResidueFingerprint(config.projectRoot, resolvePiWorkDir(config));
      writeResidueGateStatus(config.projectRoot, {
        passed: true,
        checkedAt: new Date().toISOString(),
        fingerprint,
      }, config.auditDir);
    } catch {
      // Write failure → fail-open (already clean, no blocking needed)
    }
    await safeWriteAuditLog("pipeline_start_template_residue_passed", {
      scanned: String(result.scanned),
    });
    return null;
  }

  // Residues found — hitList is recomputed inside the loop after each recheck
  // so that subsequent iterations display fresh file:line entries (Medium #2 fix).
  let hitList = result.hits
    .map(h => `  - ${h.file}:${h.line}: ${h.marker}`)
    .join("\n");

  const hasTui = typeof ctx?.ui?.select === "function";
  if (!hasTui) {
    // No TUI — degrade to non-blocking notify + audit
    const msg = `Template residue check: ${result.hits.length} unresolved placeholder(s). Fix Template-TODO markers before /pipeline-start.`;
    ctx?.ui?.notify?.(msg);
    if (ctx?.ui?.content) {
      try {
        ctx.ui.content(`# Template residue check (degraded — no TUI)\n\n${hitList}`);
      } catch {
        // content write failure is non-blocking
      }
    }
    await safeWriteAuditLog("pipeline_start_template_residue_degraded", {
      hits: String(result.hits.length),
      scanned: String(result.scanned),
    }, "warn");
    // Fail-open — don't write gate status, proceed
    return null;
  }

  // TUI available → blocking 2-choice loop
  while (true) {
    const choice: string | undefined = await ctx.ui.select(
      `Template residue check: ${result.hits.length} unresolved placeholder(s) found.\n${hitList}\n\nPlease fix Template-TODO markers before starting the pipeline.`,
      [
        "1. I've fixed them — re-check",
        "2. Cancel startup",
      ],
    );

    if (!choice || choice === "2" || choice === "2. Cancel startup") {
      await safeWriteAuditLog("pipeline_start_template_residue_blocked", {
        hits: String(result.hits.length),
        scanned: String(result.scanned),
        action: "cancelled",
      }, "warn");
      return {
        success: false,
        error: "Template residue check blocked pipeline start. Fix Template-TODO placeholders first.",
      };
    }

    // Re-check
    const recheck = checkTemplateResidues(config.projectRoot, resolvePiWorkDir(config));
    if (recheck.clean) {
      try {
        const fingerprint = computeResidueFingerprint(config.projectRoot, resolvePiWorkDir(config));
        writeResidueGateStatus(config.projectRoot, {
          passed: true,
          checkedAt: new Date().toISOString(),
          fingerprint,
        }, config.auditDir);
      } catch {
        // Write failure → fail-open
      }
      await safeWriteAuditLog("pipeline_start_template_residue_passed", {
        scanned: String(recheck.scanned),
        retries: "1",
      });
      return null;
    }
    // Still residues → loop with updated hit list
    result.hits.length = 0;
    result.hits.push(...recheck.hits);
    result.scanned = recheck.scanned;
    // Recompute hitList so the next iteration shows fresh file:line entries
    hitList = result.hits
      .map(h => `  - ${h.file}:${h.line}: ${h.marker}`)
      .join("\n");
  }
}

/**
 * Collects all stages reachable from `startStage` by following nextStage links.
 * Delegates to the authoritative `buildStageSequence` walker; wraps the result
 * in a Set for O(1) membership checks.
 *
 * @param config - Pipeline configuration
 * @param startStage - The starting stage
 * @returns Set of reachable stage names
 */
export function collectStagesFrom(
  config: PipelineConfig,
  startStage: PipelineStage,
): Set<PipelineStage> {
  return new Set<PipelineStage>(buildStageSequence(config, startStage));
}

/**
 * Checks for missing verify.md files across stages reachable from `startStage`.
 * When startStage is "clarify" (default), this is equivalent to checking all
 * active stages (backward compatible). When startStage is a later stage (e.g.
 * "develop"), only develop and its successors are checked.
 *
 * @param config - Pipeline configuration
 * @param startStage - The starting stage to check from (default "clarify")
 * @returns Array of stage names whose verify.md is missing
 */
function checkVerifyFiles(config: PipelineConfig, startStage: PipelineStage = "clarify"): PipelineStage[] {
  const missingStages: PipelineStage[] = [];
  const reachable = collectStagesFrom(config, startStage);
  const activeStages: PipelineStage[] = [
    "clarify", "plan", "design-review", "develop", "review", "fix",
  ];

  for (const stage of activeStages) {
    if (!reachable.has(stage)) continue;
    const stageConfig = config.stages[stage];
    if (!stageConfig.verify?.require) continue;

    const verifyFile = stageConfig.verify.verifyFile
      ? path.isAbsolute(stageConfig.verify.verifyFile)
        ? stageConfig.verify.verifyFile
        : path.join(config.projectRoot, stageConfig.verify.verifyFile)
      : path.join(config.projectRoot, resolveStagePath(DEFAULT_VERIFY_FILE, stage));

    if (!fs.existsSync(verifyFile)) {
      missingStages.push(stage);
    }
  }

  return missingStages;
}

/**
 * Builds the reset SessionMeta for an aborted pipeline restart.
 *
 * Shared by the no-file and with-file aborted-restart branches to eliminate
 * duplication and ensure consistent field initialization.
 *
 * @param meta - Current (aborted) session metadata
 * @param config - Pipeline configuration (for maxLoops / maxLoopCycles)
 * @param requirementDoc - The requirement doc path to set (may come from meta or new file)
 */
function buildRestartMeta(
  meta: SessionMeta,
  config: PipelineConfig,
  requirementDoc: string | undefined,
): { pipelineId: string; newMeta: SessionMeta } {
  const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 210 Phase 7: restart starts a clean usage ledger — drop the superseded
  // pipeline's in-process accumulator (its `usageByStage` meta is cleared by
  // the reset checklist below).
  resetUsage(meta.pipelineId);
  const newMeta: SessionMeta = {
    // 203_Bug Phase 1: single-source new-period reset checklist (unified口径
    // with executeDecision("restart")) — stage chain, spawn residue, design
    // review session state, and all cyclic counters.
    ...buildNewPeriodResetFields(meta, config),

    currentStage: "clarify",
    stageStartTime: Date.now(),
    pipelineId,
    domain: meta.domain ?? { id: "general", version: "latest", skillPath: "" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: config.maxLoops || 3,
    maxLoopCycles: config.maxLoopCycles ?? DEFAULT_MAX_LOOP_CYCLES,
    flowState: "running",
    verifyAttempts: 0,
    verifyFailures: [],
    requirementDoc,
  };
  return { pipelineId, newMeta };
}

/**
 * Builds SessionMeta for a new pipeline start (fresh / spec-stage jump).
 * Generalizes buildRestartMeta to support custom startStage.
 *
 * When startStage is "clarify" (default), behavior is identical to buildRestartMeta.
 * When startStage is a later stage (spec jump), previousStage and stageVisitOrder
 * are rebuilt to form a valid stage chain from "clarify" to startStage.
 *
 * @param meta - Current session metadata (may be empty for fresh start)
 * @param config - Pipeline configuration
 * @param requirementDoc - The requirement doc path
 * @param startStage - Starting stage (default "clarify")
 */
export function buildStartMeta(
  meta: SessionMeta | undefined,
  config: PipelineConfig,
  requirementDoc: string,
  startStage: PipelineStage = "clarify",
): { pipelineId: string; newMeta: SessionMeta } {
  const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 210 Phase 7: a new period (fresh or spec jump) starts with a clean usage
  // ledger — drop any pending accumulator of the superseded pipeline.
  if (meta?.pipelineId) resetUsage(meta.pipelineId);

  // For spec-stage jump, rebuild stage chain from clarify to startStage
  const previousStage = startStage === "clarify"
    ? undefined
    : resolvePreviousStage(config, startStage);
  const stageVisitOrder = startStage === "clarify"
    ? ["clarify"] as PipelineStage[]
    : buildResumeVisitOrder(config, startStage);

  const newMeta: SessionMeta = {
    // 203_Bug Phase 1: single-source new-period reset checklist (unified口径
    // with executeDecision("restart") / buildRestartMeta).
    ...buildNewPeriodResetFields(meta, config),

    currentStage: startStage,
    stageStartTime: Date.now(),
    pipelineId,
    domain: meta?.domain ?? { id: "general", version: "latest", skillPath: "" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: config.maxLoops || 3,
    maxLoopCycles: config.maxLoopCycles ?? DEFAULT_MAX_LOOP_CYCLES,
    flowState: "running",
    verifyAttempts: 0,
    verifyFailures: [],
    requirementDoc,

    // Spec jump: rebuilt stage chain (overrides the builder's clarify defaults)
    previousStage,
    stageVisitOrder,
  };
  return { pipelineId, newMeta };
}

/**
 * Resolves the previous stage for a given stage by scanning config.stages
 * for the entry whose nextStage matches. Returns undefined when no such
 * entry exists (defensive: guards against misconfigured chains).
 *
 * Note: this function intentionally does NOT fall back to meta.previousStage;
 * when the config chain is incomplete the caller (buildResumeMeta) writes
 * previousStage=undefined so that stale values from prior runs are cleared
 * by updateMeta's spread merge.
 *
 * @param config - Pipeline configuration
 * @param stage - The target stage
 * @returns The preceding stage name, or undefined if unresolvable
 */
function resolvePreviousStage(
  config: PipelineConfig,
  stage: PipelineStage,
): PipelineStage | undefined {
  for (const s of Object.keys(config.stages) as PipelineStage[]) {
    if (config.stages[s]?.nextStage === stage) {
      return s;
    }
  }
  return undefined;
}

/**
 * Builds the stage visit order from "clarify" up to and including `stage`,
 * by walking the config.stages[s].nextStage chain. If the chain does not
 * reach the target stage (misconfiguration), falls back to [stage].
 *
 * @param config - Pipeline configuration
 * @param stage - The target stage (inclusive endpoint)
 * @returns Ordered stage sequence ending at `stage`
 */
export function buildResumeVisitOrder(
  config: PipelineConfig,
  stage: PipelineStage,
): PipelineStage[] {
  // Build full chain from clarify; slice up to and including target stage
  const sequence = buildStageSequence(config, "clarify");
  const targetIdx = sequence.indexOf(stage);
  // Defensive fallback: chain did not reach target stage (misconfiguration)
  return targetIdx === -1 ? [stage] : sequence.slice(0, targetIdx + 1);
}

/**
 * Builds SessionMeta for a pipeline resume (aborted restart preserving stage position).
 *
 * Field rebuild contract:
 * - Preserve: pipelineId, currentStage, requirementDoc, domain, summaries, contextFiles, maxLoops/maxLoopCycles
 * - Preserve (210 review issue 2, High): pipelineStartedAt — a resume CONTINUES the
 *   same run (same pipelineId, summaries/commit docs stay on disk), so the period
 *   clock must not be rebased or commit-proof C2 would reject every pre-abort commit
 * - Preserve (210 review round 3 issue 2, Medium): stageStats / usageByStage — the
 *   sibling period-evidence fields keep the same whole-run scope as the clock
 *   (terminal aggregate must not mix periods)
 * - Stamp (210 review round 3 issue 1, High): periodResumedAt — marks the period as
 *   resumed so commit-proof C2 treats the re-entered develop visit as a re-entry
 *   instead of a genuine first visit with a fresh stage clock
 * - Rebuild: previousStage (from config chain), stageVisitOrder (from clarify to currentStage)
 * - Clear: loopCount, currentStepIndex, verifyAttempts, verifyFailures, violations,
 *          advancedThisTurn, loopCycleCount, verifyConfigError, blockedReason,
 *          terminated, terminateReason
 * - Set: flowState="running", stageStartTime=Date.now()
 *
 * @param meta - Current (aborted) session metadata
 * @param config - Pipeline configuration
 * @returns New SessionMeta with preserved pipelineId and rebuilt stage chain fields
 */
// review#2: export buildResumeMeta so review tests can assert its behavior
// directly (activeSpawns clearing on resume) without going through full command execute.
export function buildResumeMeta(
  meta: SessionMeta,
  config: PipelineConfig,
): SessionMeta {
  // 210 Phase 7 + review round 3 issue 2: the IN-PROCESS pending accumulator
  // is cleared (its un-flushed delta belonged to the aborted segment and the
  // abort terminal already flushed the rest), while the persisted
  // `usageByStage` / `stageStats` snapshots stay with the period below — a
  // resume CONTINUES the same run.
  resetUsage(meta.pipelineId);
  return {
    // 203_Bug Phase 1: new-period clear list inlined here for unified口径 —
    // the same cyclic counters / residue clears as a fresh start.
    ...buildNewPeriodResetFields(meta, config),

    // Preserved fields (resume semantics unchanged: pipelineId, stage,
    // design-review authorization kept for recovery)
    pipelineId: meta.pipelineId,
    currentStage: meta.currentStage,
    requirementDoc: meta.requirementDoc,
    domain: meta.domain ?? { id: "general", version: "latest", skillPath: "" },
    summaries: meta.summaries ?? {},
    contextFiles: meta.contextFiles,
    maxLoops: config.maxLoops ?? meta.maxLoops ?? 3,
    maxLoopCycles: meta.maxLoopCycles ?? config.maxLoopCycles ?? DEFAULT_MAX_LOOP_CYCLES,
    // Phase 4 (191): preserve designReview authorization on resume for recovery —
    // if the pipeline was aborted during design-review stages, the authorization
    // must be retained so recovery can resume from where it left off.
    designReview: meta.designReview,

    // Rebuilt fields
    previousStage: resolvePreviousStage(config, meta.currentStage),
    stageVisitOrder: buildResumeVisitOrder(config, meta.currentStage),

    // Lifecycle
    flowState: "running",
    stageStartTime: Date.now(),

    // 210 review issue 2 (High): keep the ORIGINAL period clock on resume.
    // The spread of buildNewPeriodResetFields rebases `pipelineStartedAt` to
    // "now", which would make every legitimate commit produced by the
    // pre-abort develop visit look older than the run and get rejected by
    // commit-proof C2 (`commit_after_stage_start`). A resume is not a new
    // period — only restart / re-init truly rebase (they discard the old
    // run's deliverables). A legacy meta without the field (or a genuinely
    // fresh clock) still gets Date.now().
    pipelineStartedAt: meta.pipelineStartedAt ?? Date.now(),

    // 210 review round 3 issue 2 (Medium): symmetric preservation — the two
    // sibling period-evidence fields continue the same run as the clock.
    // `flushUsageToMeta` merges into the existing `usageByStage` base and
    // `recordStageStats` overwrites per stage, so a stage re-run after the
    // resume adds / replaces entries without double counting.
    stageStats: meta.stageStats,
    usageByStage: meta.usageByStage,

    // 210 review round 3 issue 1 (High): stamp the period as resumed. The
    // rebuilt `stageVisitOrder` flattens the pre-abort develop visit away
    // (develop appears exactly once), so commit-proof C2 cannot tell this
    // re-entry from a genuine first visit and would take the resume-rebased
    // `stageStartTime` as the strict first-visit baseline — the marker makes
    // `resolveCommitProofClockBaseline` fall back to the period clock instead.
    periodResumedAt: Date.now(),

    // Required-numeric baseline (removed from the legacy explicit block; now
    // anchored explicitly because the builder is a Partial)
    loopCount: 0,
    currentStepIndex: 0,
  };
}

/**
 * Unified resume execution path shared by auto / confirm / ask branches.
 *
 * Centralizes buildResumeMeta → updateMeta → syncStageStatusBar → dual audit
 * (pipeline_start + pipeline_resumed) so that future field / audit changes
 * need only be made in one place (DRY).
 *
 * @param ctx - pi extension context
 * @param meta - Current (aborted) session metadata
 * @param config - Pipeline configuration
 * @param ui - PipelineUI instance
 * @param file - User-supplied file argument (may be empty)
 * @param reason - Audit reason tag (pipeline_start_resume / _confirm_resume / _ask_resume)
 */
export async function resumePipeline(
  ctx: any,
  meta: SessionMeta,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  file: string,
  reason: string,
  forwardArgs?: string,
): Promise<{ success: boolean; message?: string; pipelineId?: string; currentStage?: PipelineStage }> {
  const newMeta = buildResumeMeta(meta, config);
  ctx?.session?.updateMeta?.(newMeta);
  syncStageStatusBar(ui, ctx);

  // 210 review issue 2: arm the new stage visit immediately after the resumed
  // meta is committed. `dispatchAfterResume` also arms (below), but it is
  // skipped entirely when no requirement doc is recoverable — the clocks must
  // not depend on that branch.
  armStageWatchdog(ctx, config, { progressSource: "stage_advance" });

  await safeWriteStageAudit(config, "pipeline_start", newMeta, {
    command: file ? `/pipeline-start ${file}` : "/pipeline-start",
    file: file || "(none)",
    mode: "resume",
    previousStage: meta.currentStage,
  });
  await safeWriteStageAudit(config, "pipeline_resumed", newMeta, {
    fromStage: meta.currentStage,
    toStage: newMeta.currentStage,
    reason,
    requirementDoc: newMeta.requirementDoc ?? "",
  });

  // Phase 3 (171): dispatch after resume — stage-aware subagent relay
  const doc = newMeta.requirementDoc ?? file;
  if (doc) {
    await dispatchAfterResume(ctx, config, ui, newMeta, doc, forwardArgs);
  }

  return {
    success: true,
    message: `Pipeline resumed at stage "${newMeta.currentStage}".`,
    pipelineId: newMeta.pipelineId,
    currentStage: newMeta.currentStage,
  };
}

/**
 * Phase 0 (182): Builds an onStageChanged callback for use in freezeAndPrompt
 * and promptDecisionMenu callers.
 *
 * The callback dispatches the stage executor after choose_stage so the TUI
 * reflects the new stage and the agent is spawned automatically.
 *
 * @param ctx - FlowStateCtx (session + ui + _ctx)
 * @param config - Pipeline config
 * @returns onStageChanged callback
 */
export function buildOnStageChangedCallback(
  ctx: { session: unknown; ui?: unknown; _ctx?: unknown },
  config: PipelineConfig,
): (freshMeta: SessionMeta) => Promise<void> {
  const pipelineUI = createPipelineUI(config);
  return async (freshMeta: SessionMeta): Promise<void> => {
    const doc = freshMeta.requirementDoc ?? "";
    await dispatchAfterResume(ctx, config, pipelineUI, freshMeta, doc);
  };
}

/**
 * Phase 3 (171): stage-aware dispatch after pipeline resume.
 *
 * For the resumed stage, spawn the appropriate subagent:
 * - clarify: derive/forward args like maybeAutoLaunchClarify
 * - plan/develop/review/fix: spawn the stage subagent directly
 *
 * User forwardArgs are transparently passed through when non-empty.
 */
export async function dispatchAfterResume(
  ctx: any,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  meta: SessionMeta,
  doc: string,
  forwardArgs?: string,
): Promise<void> {
  const stage = meta.currentStage;

  // 210 review issue 2 (plan Phase 2 task 3): this helper is the shared "a new
  // stage visit starts working now" point for resume, choose_stage aftermath and
  // replay dispatch. Without arming HERE the first stage of a run (and every
  // dispatch-only transition) had no wall-clock/idle clock until the first
  // settle/verify/advance — a subagent that hangs silently in its FIRST turn
  // produced no `stage_watchdog_timeout` at all. Idempotent per stage visit and
  // a no-op (clears) when `watchdog` is not enabled, so unconfigured projects
  // keep the baseline exactly.
  armStageWatchdog(ctx, config, { progressSource: "spawn" });

  if (stage === "clarify") {
    await maybeAutoLaunchClarify(ctx, config, ui, meta, doc, forwardArgs);
    return;
  }

  // 192 Phase 4 (DR192-01): resume of an UNFINISHED develop-handoff stays under
  // domain takeover even though currentStage already equals "develop". The
  // ordinary develop spawn below must never re-dispatch the executor while the
  // handoff receipt/finished protocol is incomplete.
  if (stage === "develop") {
    const freshMetaD = ctx.session?.getMeta?.() ?? meta;
    if (
      freshMetaD
      && classifyDesignReviewFlow(freshMetaD).kind !== "ordinary"
      && isDevelopHandoffOperation(freshMetaD)
    ) {
      // 193 Phase 3 (task 1): shared safe builder (receiver-preserving UI
      // binding + honest role evidence + provenance "resume").
      const takeoverCtx = createDesignReviewRuntimeContext({
        config,
        session: ctx.session,
        interactionSource: "resume",
        roleCtx: ctx,
        rawUi: ctx.ui,
        pipelineUi: ui,
        pipelineUiCtx: ctx,
        pi: ctx.pi,
        spawnOverride: ctx.spawnOverride,
      });
      try {
        const takeoverResult = await coordinateDesignReview(takeoverCtx, freshMetaD, "advance");
        if (takeoverResult.status === "handled" && takeoverResult.action === "verify_failed") {
          // 193 Phase 3 (task 2): ONE shared honest consumption at the
          // command entry (tool method: proactive guidance, no wake), then
          // an IMMEDIATE return — never generic fallthrough.
          const freshAfter = ctx.session?.getMeta?.() ?? freshMetaD;
          const outcome = await consumeDesignReviewResult({
            result: takeoverResult,
            meta: freshAfter,
            entry: "command",
            ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi, _ctx: ctx._ctx, config } as DesignReviewConsumeCtx,
            config,
            ui,
            runtimeCtx: ctx,
          });
          if (outcome.message) {
            ui.notify(ctx, outcome.message);
          }
        }
        await safeWriteAuditLog("design_review_handoff_takeover_resume", {
          pipelineId: freshMetaD.pipelineId,
          action: takeoverResult.status === "handled" ? takeoverResult.action : takeoverResult.status,
          trigger: "dispatch_after_resume",
        });
      } catch (err) {
        await safeWriteAuditLog("design_review_handoff_takeover_error", {
          pipelineId: freshMetaD.pipelineId,
          error: err instanceof Error ? err.message : String(err),
        }, "error");
      }
      return;
    }
  }

  // Round 5 (N-3): Dispatch design-review via coordinator instead of skipping.
  // This ensures choose_stage → design-review immediately dispatches the review agent
  // in the current session, rather than waiting for next settle/resume compensation.
  if (stage === "design-review") {
    const freshMeta = ctx.session?.getMeta?.() ?? meta;
    if (!freshMeta) {
      await safeWriteAuditLog("pipeline_resume_dispatch_failed", {
        stage,
        pipelineId: meta.pipelineId,
        reason: "no_meta_available",
      });
      return;
    }

    // Build coordinator context — 193 Phase 3 (task 1): shared safe builder
    // (same shape everywhere: receiver-preserving UI, actor evidence,
    // provenance "resume").
    const coordinatorCtx = createDesignReviewRuntimeContext({
      config,
      session: ctx.session,
      interactionSource: "resume",
      roleCtx: ctx,
      rawUi: ctx.ui,
      pipelineUi: ui,
      pipelineUiCtx: ctx,
      pi: ctx.pi,
      // Pass through spawnOverride test hook if provided (for testability)
      spawnOverride: ctx.spawnOverride,
    });

    try {
      const coordinatorResult = await coordinateDesignReview(coordinatorCtx, freshMeta, "advance");
      
      if (coordinatorResult.status === "handled" && coordinatorResult.action === "routed") {
        ui.notify(ctx, `Design review agent dispatched via coordinator.`);
        await safeWriteAuditLog("design_review_coordinator_dispatch", {
          stage,
          pipelineId: meta.pipelineId,
          trigger: "dispatch_after_resume",
          action: coordinatorResult.action,
        });
      } else if (coordinatorResult.status === "handled" && coordinatorResult.action === "pending") {
        ui.notify(ctx, `Design review dispatch pending: ${coordinatorResult.reason}`);
        await safeWriteAuditLog("design_review_coordinator_dispatch", {
          stage,
          pipelineId: meta.pipelineId,
          trigger: "dispatch_after_resume",
          action: "pending",
          reason: coordinatorResult.reason,
        });
      } else if (coordinatorResult.status === "handled" && coordinatorResult.action === "frozen") {
        // 192 Phase 4 (task 8): real freeze on budget exhaustion at resume
        const { freezeAndPrompt } = await import("../core/flow-state");
        await freezeAndPrompt(
          { session: ctx.session, ui, pi: ctx.pi, _ctx: ctx._ctx } as Parameters<typeof freezeAndPrompt>[0],
          ctx.session.getMeta() ?? freshMeta,
          coordinatorResult.reason,
          config,
          { ui },
        );
        await safeWriteAuditLog("design_review_coordinator_dispatch", {
          stage,
          pipelineId: meta.pipelineId,
          trigger: "dispatch_after_resume",
          action: "frozen",
        });
      } else if (coordinatorResult.status === "handled" && coordinatorResult.action === "verify_failed") {
        // 193 Phase 3 (task 2): dispatchAfterResume consumes the obtained
        // `verify_failed` through the ONE shared honest consumer (tool
        // method: format/identity/template guidance shown proactively, one
        // budget attempt, NO model wake) and RETURNS immediately — never a
        // followUp send, never the generic dispatch fallthrough.
        const freshAfter = ctx.session?.getMeta?.() ?? freshMeta;
        const outcome = await consumeDesignReviewResult({
          result: coordinatorResult,
          meta: freshAfter,
          entry: "command",
          ctx: { session: ctx.session, ui: ctx.ui, pi: ctx.pi, _ctx: ctx._ctx, config } as DesignReviewConsumeCtx,
          config,
          ui,
          runtimeCtx: ctx,
        });
        if (outcome.message) {
          ui.notify(ctx, outcome.message);
        }
        await safeWriteAuditLog("design_review_coordinator_dispatch", {
          stage,
          pipelineId: meta.pipelineId,
          trigger: "dispatch_after_resume",
          action: "verify_failed",
          failureRecorded: String(outcome.failureRecorded),
        });
        return;
      } else if (coordinatorResult.status === "handled") {
        // Other handled actions: advanced
        await safeWriteAuditLog("design_review_coordinator_dispatch", {
          stage,
          pipelineId: meta.pipelineId,
          trigger: "dispatch_after_resume",
          action: coordinatorResult.action,
          status: coordinatorResult.status,
        });
      } else {
        // not-applicable
        await safeWriteAuditLog("design_review_coordinator_dispatch", {
          stage,
          pipelineId: meta.pipelineId,
          trigger: "dispatch_after_resume",
          status: coordinatorResult.status,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("design_review_coordinator_dispatch_error", {
        stage,
        pipelineId: meta.pipelineId,
        trigger: "dispatch_after_resume",
        error: errMsg,
      }, "error");
    }
    return;
  }

  // plan/develop/review/fix: spawn stage subagent via existing helper
  // Phase 0 (182): name-probe check before spawning — if a same-name agent is
  // already live (manual/out-of-band), skip the spawn to avoid duplicate execution.
  const expectedAgent = resolveAgentMention(config, stage);
  if (expectedAgent) {
    const nameProbe = findLiveAgentByName(expectedAgent);
    if (nameProbe) {
      ui.notify(ctx, `Agent "${expectedAgent}" is already running (id ${nameProbe.agentId}). Skipping duplicate spawn.`);
      await safeWriteAuditLog("pipeline_resume_dispatch_skipped", {
        stage,
        pipelineId: meta.pipelineId,
        reason: "manual_live_probe",
        agentId: nameProbe.agentId,
      });
      return;
    }
  }

  // Phase 3 (171) High B: append user focus for non-clarify stages when forwardArgs present
  const extraArgs = forwardArgs?.trim() ? `\n\nUser focus: ${forwardArgs.trim()}` : undefined;
  // review#2 M3: pass session handle so spawnStageSubagent can write activeSpawns entry
  // (writeGuard + lifecycle cleanup) on resume-dispatch path; without it, aborted→resume→spawn
  // leaves activeSpawns blind to the in-run probe and the "await…勿重复" clause never injects.
  const session = ctx?.session
    ? {
        getMeta: () => ctx.session.getMeta?.() as SessionMeta | undefined,
        updateMeta: (patch: Partial<SessionMeta>) => ctx.session.updateMeta?.(patch),
      }
    : undefined;
  const result = await spawnStageSubagent(ctx?.pi, config, stage, meta, {
    ui: { notify: (msg: string) => ui.notify(ctx, msg) },
    extraArgs,
    session,
    runtimeCtx: ctx,
  });

  if (result.dispatchOutcome === "conflict_blocked") {
    // 195 Phase 2: configuration conflict — UI already notified, no manual prompt needed
    const { emitDispatchConflictBlocked } = await import("../utils/dispatch-conflict-audit");
    await emitDispatchConflictBlocked("pipeline_resume", {
      stage,
      requirementDoc: doc,
      pipelineId: meta.pipelineId,
      reason: "configuration_conflict",
    });
  } else if (result.spawned) {
    await safeWriteAuditLog("pipeline_resume_dispatch", {
      stage,
      requirementDoc: doc,
      pipelineId: meta.pipelineId,
      forwardArgs: forwardArgs ? "yes" : "no",
      ...(forwardArgs?.trim() ? { forwardArgsContent: forwardArgs.trim().substring(0, 120) } : {}),
    });
  } else if (result.deferred) {
    // Phase 2 / 179 (G3): spawn is queued behind a live same-agent twin in
    // another stage. The dequeue will fire automatically once the old twin
    // settles — do NOT prompt the user to run manually, which would cause
    // dual execution with the pending dequeue.
    await safeWriteAuditLog("pipeline_resume_deferred", {
      stage,
      requirementDoc: doc,
      pipelineId: meta.pipelineId,
      reason: "subagent_deferred",
    });
  } else if (!result.fallback) {
    // Not spawned, not deferred, and no fallback (e.g. non-spawnable stage) → notify
    ui.notify(ctx, `Pipeline resumed at "${stage}". Run the ${stage} agent to continue.`);
  }
}

/**
 * 206 Phase 2: local minimal structural view of the host context used by the
 * doc-candidate menu. Declared instead of `any` (code-spec rule) because the
 * pi SDK exposes the TUI dialogs on `ctx.ui` only in some hosts; the plugin
 * relies on these optional methods only when present.
 *
 * 213 Phase 2 (D14): exported — `/pipeline-resume`'s new-branch flow drives
 * the SAME menu shell through `promptDocSelection`.
 */
export type DocMenuCtx = {
  ui?: {
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    input?: (message: string) => Promise<string | undefined>;
  };
};

/**
 * 206 Phase 2: manual-path input for the doc-candidate menu.
 * Returns the entered path resolved to a project-relative file argument, or
 * `null` when the input dialog is unavailable / the value is invalid.
 *
 * The host input dialog lives on `ctx.ui.input` (SDK TUI surface); the call is
 * made as a method so the host's `this` receiver is preserved.
 */
async function promptManualDocPath(
  ctx: DocMenuCtx | undefined,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
): Promise<string | null> {
  const uiCtx = ctx?.ui;
  if (typeof uiCtx?.input !== "function") {
    ui.notify(ctx, "Manual path input unavailable in this session.");
    return null;
  }
  const raw = await uiCtx.input("Enter requirement document path (relative to project root):");
  if (!raw || raw.trim().length === 0) return null;
  const cleaned = raw.trim();
  const abs = path.isAbsolute(cleaned) ? cleaned : path.join(config.projectRoot, cleaned);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    ui.notify(ctx, `Path is not an existing file: ${cleaned}`);
    return null;
  }
  // Always return a project-relative path: downstream consumers re-root with
  // `path.join(projectRoot, docFile)`, which would corrupt an absolute input.
  const relInside = path.relative(config.projectRoot, abs);
  return relInside.split(path.sep).join("/");
}

/**
 * 206 Phase 2: interactive document-candidate menu for empty-file starts
 * (206_Feat Round 2/3/4 decisions):
 *
 * - No TUI (`ctx.ui.select` missing) → `null`; the caller degrades to the
 *   original "run /pipeline-start <doc_file>" error message.
 * - Candidates exist → single-select (≤5, mtime desc) + manual input + cancel.
 * - No candidates → cross-`archiveDirs` fallback auto-picks the newest match
 *   (with an English notify); nothing at all → manual input / cancel.
 *
 * 213 Phase 2 (D14/D15) `currentDoc` additions:
 * - `currentDoc` (typically `meta.requirementDoc`) is pinned as the FIRST row
 *   with a ` (default)` suffix; selection resolves by OPTION INDEX (labels are
 *   no longer string-reversible once suffixed).
 * - A supplied-but-unresolvable `currentDoc` never blocks the menu; the title
 *   gains `(current requirement doc missing: <raw>)` (rule ①).
 * - The "auto-select the latest doc" fallback fires ONLY when no `currentDoc`
 *   was supplied — a resume caller that passed one always gets the explicit
 *   manual/cancel menu instead.
 *
 * @param stage - The starting stage; drives the stage-specific candidate filter
 * @param reason - Audit reason tag ("start", or "resume_new" for the 213 branch)
 * @returns Selected file path, or `null` when the user cancelled / no UI
 */
export async function promptDocSelection(
  ctx: DocMenuCtx | undefined,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  stage: PipelineStage,
  reason: string,
  currentDoc?: string,
): Promise<string | null> {
  const uiCtx = ctx?.ui;
  if (typeof uiCtx?.select !== "function") {
    return null; // caller degrades to original error message
  }

  // Rule ① display hint: a supplied current doc that cannot be resolved is
  // announced in the title instead of appearing as a row.
  const currentMissingSuffix = currentDoc !== undefined
    && (await resolveCurrentDocOption(config, currentDoc)) === null
    ? ` (current requirement doc missing: ${currentDoc})`
    : "";
  const selectTitle = `Select document for the "${stage}" stage:${currentMissingSuffix}`;

  const candidates = await listDocCandidates(config, stage, MAX_DOC_CANDIDATES, currentDoc);
  if (candidates.length > 0) {
    const labels = candidates.map((c: DocCandidate) =>
      c.isCurrent ? `${c.relPath} (default)` : c.relPath);
    const options = [
      ...labels,
      "Manual input path",
      "Cancel",
    ];
    const choice = await uiCtx.select(selectTitle, options);
    if (!choice || choice === "Cancel") return null;
    if (choice === "Manual input path") {
      return promptManualDocPath(ctx, config, ui);
    }
    // 213 Phase 2: index mapping — ` (default)`-suffixed labels can no longer
    // be matched by string equality against `relPath`.
    const idx = options.indexOf(choice);
    if (idx >= 0 && idx < candidates.length) {
      const picked = candidates[idx];
      if (picked) return picked.relPath;
    }
    return promptManualDocPath(ctx, config, ui);
  }

  // No candidates → cross-archiveDirs fallback: auto-select newest match (Q2-A).
  // 213 Phase 2 (D14): ONLY when the caller did not supply a currentDoc — an
  // explicitly passed one that failed to resolve must NOT silently auto-pick
  // another document.
  if (currentDoc === undefined) {
    const latest = await findLatestDocForStage(config, stage);
    if (latest) {
      ui.notify(ctx, `Auto-selected latest document: ${latest.relPath}`);
      await safeWriteAuditLog("pipeline_start_doc_menu_autoselect", {
        stage,
        reason,
        requirementDoc: latest.relPath,
      });
      return latest.relPath;
    }
  }

  // Nothing anywhere → manual input / cancel
  const emptyChoice = await uiCtx.select(
    `No candidate document found for ${stage}.${currentMissingSuffix}`,
    ["Manual input path", "Cancel"],
  );
  if (emptyChoice !== "Manual input path") return null;
  return promptManualDocPath(ctx, config, ui);
}

/**
 * Unified new-pipeline execution path for fresh / spec-stage / ask-new flows.
 *
 * Steps:
 * 1. Read requirement file (error → audit + reject)
 * 2. checkVerifyFiles(config, startStage) — only checks reachable stages
 * 3. buildStartMeta → updateMeta → syncStageStatusBar → audit
 * 4. Return success with pipelineId, currentStage, requirementContent
 *
 * @param ctx - pi extension context
 * @param config - Pipeline configuration
 * @param ui - PipelineUI instance
 * @param file - Requirement doc file path (relative to projectRoot)
 * @param startStage - Starting stage (default "clarify")
 * @param existingMeta - Existing meta (may be undefined for fresh start)
 */
export async function startNewPipeline(
  ctx: any,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  file: string,
  startStage: PipelineStage = "clarify",
  existingMeta?: SessionMeta,
  forwardArgs?: string,
): Promise<{
  success: boolean;
  message?: string;
  error?: string;
  pipelineId?: string;
  currentStage?: PipelineStage;
  requirementContent?: string;
  missingStages?: PipelineStage[];
  suggestion?: string;
}> {
  // 206 Phase 2 (integration point A): empty-file starts open the interactive
  // doc-candidate menu. Cancel / no-UI / invalid manual input keep the ORIGINAL
  // error string for backward compatibility with existing tests and users.
  let docFile = file;
  if (!file) {
    const selected = await promptDocSelection(ctx, config, ui, startStage, "start");
    if (selected === null) {
      return {
        success: false,
        error: "run /pipeline-start <doc_file> start pipeline loop",
      };
    }
    docFile = selected;
  }

  // Step 1: Read requirement file
  // Absolute docFile values are used verbatim; a bare `path.join` would re-root
  // them under projectRoot and break the lookup (206 review issue 2).
  const docPath = path.isAbsolute(docFile) ? docFile : path.join(config.projectRoot, docFile);
  let content: string;
  try {
    content = fs.readFileSync(docPath, "utf-8");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("pipeline_start_error", { file: docFile, error: errMsg }, "error");
    return {
      success: false,
      error: `File not found: ${docFile} (${errMsg})`,
    };
  }

  // Step 2: Check verify.md files (only for reachable stages from startStage)
  const missingStages = checkVerifyFiles(config, startStage);
  if (missingStages.length > 0) {
    return {
      success: false,
      error: `verify.md missing for stages: [${missingStages.join(", ")}]`,
      missingStages,
      suggestion: "Run /pipeline-init 1 to generate verify.md files",
    };
  }

  // Detect if this is a restart (existing meta was aborted) for message wording
  // Must check BEFORE updateMeta which mutates the existingMeta object in-place
  const isRestart = existingMeta && getFlowState(existingMeta) === "aborted";
  // Phase 2b (173) D2: detect completed wake-up for superseded message
  const isCompletedWake = existingMeta?.currentStage === "completed";

  // 194 Phase 3 (task 7, review issue 3): starting a NEW pipeline is a
  // boundary — a stale closed-loop executor binding must be invalidated
  // BEFORE the fresh meta is written (updateMeta merges, so the old run
  // would otherwise survive under the new pipelineId). The strict-commit
  // clear runs only once every pre-check above has passed; the resume
  // paths (same pipelineId) intentionally KEEP the binding for D4
  // breakpoint recovery.
  if (ctx?.session) {
    await invalidateExecutorRunOnBoundary({ session: ctx.session, reason: "pipeline_start" });
  }

  // Step 3: Build meta and initialize
  const { pipelineId, newMeta } = buildStartMeta(existingMeta, config, docFile, startStage);
  await prepareAuditPipelineLog(pipelineId);
  ctx?.session?.updateMeta?.(newMeta);
  syncStageStatusBar(ui, ctx);

  // 210 review issue 2 (plan Phase 2 task 3 / acceptance「子代理静默挂起」): the
  // fresh run's FIRST stage visit (`clarify`, or the spec-jump stage) gets its
  // clocks immediately after the new meta is committed. Previously the clocks
  // only appeared at the first settle/verify/advance, so a subagent that hangs
  // silently in its very first turn never produced `stage_watchdog_timeout`.
  // No-op + clear when `watchdog` is not enabled (constraint 4).
  armStageWatchdog(ctx, config, { progressSource: "spawn" });

  // Register session → pipeline mapping (fail-open, covers restart with new pipelineId)
  const sessionFile = ctx?._ctx?.sessionManager?.getSessionFile?.() as string | undefined;
  if (sessionFile) {
    await registerSession(config, sessionFile, pipelineId);
  }

  // Step 4: Audit (with mode and startStage fields for traceability)
  const auditMode = startStage === "clarify" ? "fresh" : "spec";
  await safeWriteStageAudit(config, "pipeline_start", newMeta, {
    command: `/pipeline-start ${docFile}`,
    file: docFile,
    mode: auditMode,
    startStage,
    previousStage: auditMode === "fresh" ? "none" : (existingMeta?.currentStage ?? "none"),
  });
  const messagePrefix = isRestart
    ? `Pipeline restarted as "${pipelineId}" at stage "${startStage}".`
    : `Pipeline "${pipelineId}" started with document: ${docFile}.`;
  // Phase 2b (173) D2: completed wake-up superseded message
  const supersededSuffix = isCompletedWake
    ? ` Previous pipeline at "completed" superseded by new run.`
    : "";
  const messageSuffix = startStage === "clarify"
    ? ` Next: run @feat-design-plan-agent ${docFile} ${forwardArgs || "1"} to start requirement clarification`
    : "";

  // Phase 2 (144) + Phase 3 (171): Auto-launch clarify subagent with forwardArgs passthrough
  if (startStage === "clarify") {
    await maybeAutoLaunchClarify(ctx, config, ui, newMeta, docFile, forwardArgs);
  }

  // spec→plan: no subagent injection (plan agent is task-invoked by main agent),
  // but still emit a notify hint so the user knows the next step (Medium #3).
  if (startStage === "plan") {
    ui.notify(ctx, `Pipeline started at stage "plan". Run the plan agent to continue.`);
  }

  return {
    success: true,
    message: messagePrefix + supersededSuffix + messageSuffix,
    pipelineId,
    currentStage: startStage,
    requirementContent: content.slice(0, 500) + (content.length > 500 ? "..." : ""),
  };
}

/**
 * Auto-launches the clarify subagent via pi-subagents RPC spawn.
 *
 * Phase 3 (171): Accepts optional user-supplied forwardArgs (transparent passthrough).
 * When forwardArgs is empty, derives from document text via deriveClarifyForwardArgs.
 *
 * Derivation outcomes:
 * - "1" / "full-und?" → spawn clarify subagent with `${file} ${derivedArgs}`
 * - "await-answer" / "confirmed" → do not spawn, notify user guidance
 *
 * Flow: resolve agentName → ping → spawn → success audit; any failure → fallback to
 * pi.sendUserMessage + TUI notify + fallback audit.
 *
 * @param ctx - pi extension context (uses ctx.pi.events + ctx.pi.sendUserMessage)
 * @param config - Pipeline configuration
 * @param ui - PipelineUI instance for notify
 * @param meta - Newly initialized session metadata
 * @param file - The requirement doc file path
 * @param forwardArgs - User-supplied forward args (overrides derivation when non-empty)
 */
async function maybeAutoLaunchClarify(
  ctx: any,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  meta: SessionMeta,
  file: string,
  forwardArgs?: string,
): Promise<void> {
  const agentName = resolveAgentMention(config, "clarify");

  // Phase 3 (171) + Phase 1 (175): determine effective args (explicit > derived)
  let effectiveArgs: string;
  let skipSpawn = false;
  let skipMessage = "";
  // Phase 1 / 175 (R2Q2A): track args source for faithful display and audit
  let argsSource: "user" | "derived" = "derived";
  // Phase 1 / 175: derived round number for notify text (undefined when explicit)
  let derivedRound: number | undefined;

  if (forwardArgs && forwardArgs.trim()) {
    // Explicit user args → transparent passthrough (Q3-A)
    effectiveArgs = forwardArgs.trim();
    argsSource = "user";
  } else {
    // Derive from document text
    try {
      const docPath = path.resolve(config.projectRoot, file);
      const docText = fs.readFileSync(docPath, "utf-8");

      // Phase 2 / 176: load runtime anchors from the deployed verify.md.
      // Missing roundHeading → fail-open fresh(1) + throttled notify + error audit.
      // Non-roundHeading issues are logged for audit but do NOT trigger fresh fallback.
      const { anchors, issues } = await loadVerifyContractAnchors(config, "clarify");
      if (!anchors.roundHeading) {
        await safeWriteAuditLog("contract_anchor_unavailable", {
          requirementDoc: file,
          pipelineId: meta.pipelineId,
          stage: "clarify",
          missingKeys: "roundHeading",
          issues: issues.join("; "),
        }, "error");
        if (shouldEmitWithinWindow(`contract_anchor_unavailable:clarify:${meta.pipelineId}`, AUDIT_THROTTLE_WINDOW_MS)) {
          ui.notify(ctx, "Clarify runtime contract anchor unavailable in verify.md. Falling back to fresh(1). Run /pipeline-init to restore the default declarations.");
        }
        effectiveArgs = "1";
        argsSource = "derived";
      } else {
        // Log non-roundHeading issues for audit without changing behavior
        if (issues.length > 0) {
          await safeWriteAuditLog("contract_anchor_issues", {
            requirementDoc: file,
            pipelineId: meta.pipelineId,
            stage: "clarify",
            issues: issues.join("; "),
          }, "warn");
        }
        const derived = deriveClarifyForwardArgs(docText, anchors);
        switch (derived.kind) {
        case "fresh":
          effectiveArgs = "1";
          break;
        case "full-und?":
          effectiveArgs = "full-und?";
          derivedRound = derived.round;
          break;
        case "await-answer":
          skipSpawn = true;
          skipMessage = `Round ${derived.round} has no answers yet. Answer in the clarification 答/Answer fields, then re-mention @agent ${file} ${derived.round} 答.`;
          effectiveArgs = "";
          derivedRound = derived.round;
          break;
        case "confirmed":
          skipSpawn = true;
          skipMessage = `Round ${derived.round} clarification confirmed. Awaiting marker verification.`;
          effectiveArgs = "";
          derivedRound = derived.round;
          break;
        }
      }
    } catch {
      // Fail-open: file read error → fallback to "1"
      effectiveArgs = "1";
    }
  }

  if (skipSpawn) {
    ui.notify(ctx, skipMessage);
    await safeWriteAuditLog("pipeline_start_launch_skipped", {
      requirementDoc: file,
      pipelineId: meta.pipelineId,
      stage: "clarify",
      reason: skipMessage.substring(0, 80),
    });
    return;
  }

  if (!agentName) {
    // No agentPath configured → notify fallback
    ui.notify(ctx, `Next: run @feat-design-plan-agent ${file} ${effectiveArgs}`);
    return;
  }

  // 204 Phase 0: carry the `Pipeline: {id}` marker so the spawned clarify session
  // can JOIN back even when it is in-memory (no `parentSession` header).
  const prompt = appendPipelineIdMarker(`${file} ${effectiveArgs}`.trim(), meta.pipelineId);
  const message = `@${agentName} ${prompt}`;

  // Phase 1 / 175 (R2Q2A): description — explicit carries args verbatim;
  // derived carries ONLY file (no round/args suffix to avoid misleading labels).
  const description = argsSource === "user"
    ? `Clarify: ${file} ${effectiveArgs}`.trim()
    : `Clarify: ${file}`;

  // Phase 1 / 175 (R2Q2A): one-time English notify for derived args source.
  // Does NOT block the flow — purely informational.
  if (argsSource === "derived") {
    const roundInfo = derivedRound !== undefined ? `round ${derivedRound}` : "fresh";
    ui.notify(ctx, `Clarify args derived from document state (${roundInfo}). Prompt/description reflect document status, not user-supplied parameters.`);
  }

  // Try RPC path when the subagents availability latch is set (Phase 2 / 177 D4).
  // No ping: the latch is event-driven; when false we fall back immediately.
  if (ctx?.pi?.events && isSubagentsReady()) {
    const spawnResult = await spawnClarifySubagent(ctx.pi, {
      agentName,
      prompt,
      description,
    });

    if (spawnResult.ok) {
      // RPC success: audit + watch lifecycle, no manual @ hint needed
      await safeWriteAuditLog("pipeline_start_launch_rpc", {
        agentName,
        requirementDoc: file,
        pipelineId: meta.pipelineId,
        subagentId: spawnResult.id,
        stage: "clarify",
        argsSource,
        ...(derivedRound !== undefined ? { derivedRound: String(derivedRound) } : {}),
      });
      // Hold the cleanup function and self-unregister after lifecycle event
      // (or on failure) to avoid listener leak on shared channels.
      const cleanup = watchSubagentLifecycle(ctx.pi, spawnResult.id, () => {
        cleanup();
      });
      return;
    }
    // Spawn failed → fall through to sendUserMessage fallback
  }

  // Fallback: sendUserMessage + TUI notification + audit
  if (typeof ctx?.pi?.sendUserMessage === "function") {
    try {
      ctx.pi.sendUserMessage(message, { expandPromptTemplates: true });
    } catch {
      // sendUserMessage failure is non-fatal; fall through to notify
    }
  }

  ui.notify(ctx, `Next: run ${message} manually if not auto-started.`);
  await safeWriteAuditLog("pipeline_start_launch", {
    agentName,
    requirementDoc: file,
    pipelineId: meta.pipelineId,
    stage: "clarify",
    fallback: "true",
    argsSource,
    ...(derivedRound !== undefined ? { derivedRound: String(derivedRound) } : {}),
  });
}

/**
 * Unified handler for the aborted pipeline branch in /pipeline-start.
 *
 * Decision matrix:
 * - resumable && (sameDoc || (!file && requirementDoc exists)) → resume (preserve stage position)
 * - completed → error: prompt user to start a new pipeline
 * - awaiting_human → error: prompt user to open decision menu
 * - no requirementDoc && no file → error: prompt user to provide doc_file
 * - else (different file provided) → start new pipeline (existing buildRestartMeta path)
 *
 * @param ctx - pi extension context
 * @param meta - Current session metadata (already validated as aborted)
 * @param file - User-supplied file argument (may be empty)
 * @param ui - PipelineUI instance for TUI status bar sync
 * @param config - Pipeline configuration
 */
async function handleAbortedPipeline(
  ctx: any,
  meta: SessionMeta,
  file: string,
  ui: ReturnType<typeof createPipelineUI>,
  config: PipelineConfig,
  forwardArgs?: string,
): Promise<{ success: boolean; message?: string; error?: string; pipelineId?: string; currentStage?: PipelineStage }> {
  const resumable = RESUMABLE_STAGES.includes(meta.currentStage);
  const sameDoc = !!file && !!meta.requirementDoc && file === meta.requirementDoc;
  const resumeEligible = resumable && (sameDoc || (!file && !!meta.requirementDoc));

  // --- Resume branch ---
  if (resumeEligible) {
    return resumePipeline(ctx, meta, config, ui, file, "pipeline_start_resume", forwardArgs);
  }

  // --- Terminal stage: completed → Phase 2b (173) D2: allow fresh start ---
  // completed = dormant, can be woken by /pipeline-start with a new pipelineId.
  // Old meta.json stays on disk as historical audit; new run supersedes it.
  // Fall through to fresh start logic below (do NOT return error).

  // --- Frozen stage: awaiting_human → require decision menu ---
  if (meta.currentStage === "awaiting_human") {
    return {
      success: false,
      error: `Pipeline is at awaiting_human stage. ${formatDecisionMenuHint()}`,
    };
  }

  // --- No requirementDoc && no file → 206 Phase 2 (integration point D):
  // pass through to the unified new-pipeline path, where the doc-candidate
  // menu fires and degrades to the original error string on cancel/no-UI.
  if (!meta.requirementDoc && !file && meta.currentStage !== "completed") {
    return startNewPipeline(ctx, config, ui, file, "clarify", meta, forwardArgs);
  }

  // --- Start new pipeline (different file, or no requirementDoc with file provided) ---
  // For completed: always go to fresh start (new pipelineId supersedes old).
  // For other stages with existing doc: doc-switch branch.
  if (meta.requirementDoc && meta.currentStage !== "completed") {
    // Different doc: prefer user's new file; defensive fallback to existing doc
    // review#2 M2: forwardArgs passthrough preserved across doc-switch branch
    return startNewPipeline(ctx, config, ui, file || meta.requirementDoc, "clarify", meta, forwardArgs);
  }

  // No existing requirementDoc or completed → use new file via unified path
  // 206 Phase 2 (integration point D): empty-file aborted starts open the
  // doc-candidate menu instead of rejecting outright.
  return startNewPipeline(ctx, config, ui, file || meta.requirementDoc || "", "clarify", meta, forwardArgs);
}

export function createPipelineStartCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-start",
    description:
      "Start a new pipeline run. Optionally reads the specified requirement document and " +
      "injects it into the clarify stage. Without a file, initializes the state machine only.",
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      const file = (args.file as string) || "";
      const forwardArgs = (args.forwardArgs as string) || "";
      const ui = createPipelineUI(config);
      const mode: StartStageMode = config.startStageMode ?? "auto";

      // Phase 3 / 175 (R2Q6A): stale config check at command entry point.
      const staleNotice = staleConfigNotice(config);
      if (staleNotice) {
        ui.notify(ctx, staleNotice);
      }

      const meta = ctx?.session?.getMeta?.();

      // Phase 1 (140): validate agentPath for all 5 active stages before any startup
      const missingAgentPaths = checkAgentPaths(config);
      if (missingAgentPaths.length > 0) {
        await safeWriteAuditLog("pipeline_start_config_error", {
          missingStages: missingAgentPaths.join(","),
          error: "agentPath not configured for active stage(s)",
        }, "warn");
        return {
          success: false,
          error:
            `pipeline_loop.json missing agentPath for stage(s): [${missingAgentPaths.join(", ")}]. ` +
            `Add agentPath to each active stage config, e.g. ".pi/agents/develop-agent.md".`,
        };
      }

      // 147 Phase 6: Template-residue gate (after checkAgentPaths, before branch判定)
      // Blocks when Template-TODO placeholders remain in .pi/skills/ or .pi/agents/.
      // Persists pass-status to disk so subsequent restarts short-circuit via fingerprint.
      const gateResult = await templateResidueGate(config, ctx);
      if (gateResult !== null) {
        return gateResult;
      }

      // ── Branch: existing pipeline state ──────────────────────────────────
      if (meta?.currentStage && meta.pipelineId) {
        // Phase 2b (173) D2: completed → fall through to fresh start (not rejected).
        // Completed = dormant; /pipeline-start wakes with new pipelineId.
        if (meta.currentStage === "completed") {
          // Fall through to fresh start below — do NOT return error
        } else {
          const flowState = getFlowState(meta);

          // Aborted → mode-specific handling (must be checked first, even for awaiting_human stage)
          if (flowState === "aborted") {
            return handleAbortedWithMode(ctx, meta, file, ui, config, mode, forwardArgs);
          }

          // Review round 6 fix: awaiting_human must be checked BEFORE flowState running/blocked.
          // awaiting_human is a frozen state (isFrozen returns true) regardless of flowState.
          // stage-advancer transitions to awaiting_human without setting flowState, so
          // awaiting_human can exist with flowState="running". If we check flowState first,
          // the "running" branch would reject before reaching awaiting_human.
          // Reordering ensures awaiting_human always prompts the decision menu.
          // Note: aborted + awaiting_human is handled above (aborted branch takes precedence).

          // 208 Phase 3 (G1/G2/G3): shared frozen-menu entry for awaiting_human and
          // blocked. The scheduler's interrupted backoff retry, the timer mutex and
          // accurate no-menu attribution all live inside `ensureDecisionMenu`, now
          // reached through `requestDecision`. The command owns the single
          // user-facing message: notifyOnUnavailable: false suppresses the runtime
          // notify and the returned error is the only channel.
          // 210 review issue 3: routed through `requestDecision` so a freeze left
          // over by a previous process re-arms the decision-wait deadline (and
          // converges policy → abort headless) when `decisionPolicy` is enabled.
          const presentFrozenDecisionMenu = async (
            frozenMeta: SessionMeta,
            noMenuHeaderFactory: (fresh: SessionMeta) => string,
          ): Promise<{ success: boolean; message?: string; error?: string }> => {
            // Phase 0 (182): dispatch stage executor after choose_stage
            const pipelineUI = createPipelineUI(config);
            const onStageChanged = async (fresh: SessionMeta): Promise<void> => {
              const doc = fresh.requirementDoc ?? "";
              await dispatchAfterResume(ctx, config, pipelineUI, fresh, doc);
            };
            const menu = await requestDecision(
              { session: ctx.session, ui: ctx.ui, _ctx: ctx?._ctx },
              frozenMeta,
              config,
              resolveDecisionReason(frozenMeta),
              {
                source: "command",
                onStageChanged,
                notifyOnUnavailable: false, // command returns the message; no second notify
                notifyOnCancel: false, // same single-channel rule for Esc / cancelled input
              },
            );
            // `null` — the provider chain resolved WITHOUT a menu (policy applied,
            // or converged to abort). Report the resulting state honestly instead
            // of falling through to the menu-outcome table.
            if (menu === null) {
              const fresh = (ctx.session.getMeta() as SessionMeta | undefined) ?? frozenMeta;
              const flowState = getFlowState(fresh);
              if (flowState === "aborted") {
                return {
                  success: false,
                  error:
                    `Decision provider chain aborted the pipeline at "${fresh.currentStage}" ` +
                    `(${fresh.terminateReason ?? "decision_policy"}).`,
                };
              }
              if (isFrozen(fresh)) {
                return {
                  success: false,
                  error: `Pipeline remains frozen at "${fresh.currentStage}" (${formatFrozenReason(fresh)}). ${formatDecisionMenuHint()}`,
                };
              }
              syncStageStatusBar(ui, ctx);
              return {
                success: true,
                message: `Decision policy resolved the freeze. Pipeline at stage "${fresh.currentStage}".`,
              };
            }
            const retrySeconds = Math.max(1, Math.round((menu.retryDelayMs ?? 5000) / 1000));
            if (menu.outcome === "decided" && menu.applied) {
              return { success: true, message: "Decision executed." };
            }
            if (menu.outcome === "decided") {
              const retryNote = menu.retryArmed
                ? ` The menu will reopen automatically in ~${retrySeconds}s.`
                : " Run /pipeline-resume to try again.";
              return { success: false, error: `Decision not applied: ${menu.message ?? "unknown reason"}.${retryNote}` };
            }
            if (menu.outcome === "interrupted") {
              // Only promise an automatic reopen when a retry timer was armed.
              const reopen = menu.retryArmed
                ? `it will reopen automatically in ~${retrySeconds}s.`
                : "run /pipeline-resume to reopen it.";
              return { success: false, error: `Decision menu interrupted; ${reopen}` };
            }
            // cancelled (primary Esc / secondary Esc / cancelled budget input):
            // the pipeline stays frozen. The command owns the single message —
            // `notifyOnCancel: false` suppressed the runtime notify.
            if (menu.outcome === "cancelled") {
              const fresh = (ctx.session.getMeta() as SessionMeta | undefined) ?? frozenMeta;
              return {
                success: false,
                error: `Pipeline remains frozen at "${fresh.currentStage}" (${formatFrozenReason(fresh)}). ${formatDecisionMenuHint()}`,
              };
            }
            // no-menu: keep stage + freeze reason (do not degrade to
            // a bare "Pipeline frozen").
            const freshMeta = (ctx.session.getMeta() as SessionMeta | undefined) ?? frozenMeta;
            const unavailable = menu.unavailableReason ?? "unknown";
            const header = noMenuHeaderFactory(freshMeta);
            return {
              success: false,
              error: `${header}. No decision menu is available (${unavailable}); ${formatDecisionMenuHint()}`,
            };
          };

          if (meta.currentStage === "awaiting_human") {
            return presentFrozenDecisionMenu(meta, (fresh) =>
              `Pipeline is at awaiting_human stage${fresh.blockedReason ? ` (${formatFrozenReason(fresh)})` : ""}`,
            );
          }

          // Running → reject with decision menu hint (prevent double-start)
          if (flowState === "running") {
            return {
              success: false,
              error:
                `Pipeline "${meta.pipelineId}" already running at stage "${meta.currentStage}" (${flowState}). ` +
                `Open the decision menu to proceed.`,
            };
          }

          // Phase 3 (173) C10①: blocked → owner-side decision menu (source="command").
          if (flowState === "blocked") {
            return presentFrozenDecisionMenu(meta, (fresh) =>
              `Pipeline frozen at "${fresh.currentStage}" (${formatFrozenReason(fresh)})`,
            );
          }
        }
      }

      // ── Branch: fresh start (no existing pipeline) ──────────────────────
      // 206 Phase 2 (integration point B): no file no longer rejects here —
      // control flows to startNewPipeline / handleAskMenu, where the
      // doc-candidate menu (integration point A) handles empty-file starts
      // and degrades to the original error message on cancel / no-UI.

      // Phase 3 (171) Q4-A: scan auditDir for adoptable non-terminal flows before fresh start.
      // If the current session has no usable pipeline but an aborted flow exists for the same doc,
      // adopt it (pipelineId preserved) instead of creating a new one.
      if (mode === "auto") {
        try {
          const candidates = await scanAuditFlows(config.projectRoot, resolveAuditDir(config), file);
          if (candidates.length > 0) {
            // Phase 3 (171) M1: scan ALL candidates for running/blocked before adopting.
            // scanAuditFlows returns non-terminal flows sorted by stageStartTime desc.
            // If any candidate is running/blocked (in another session), reject — no double-start.
            const activeCandidate = candidates.find(
              c => c.flowState === "running" || c.flowState === "blocked"
            );
            if (activeCandidate) {
              return {
                success: false,
                error: `Pipeline "${activeCandidate.pipelineId}" is already ${activeCandidate.flowState} at stage "${activeCandidate.stage}" in another session. Open the decision menu there.`,
              };
            }
            // All candidates are aborted → adopt the most recent one
            const top = candidates.find(c => c.flowState === "aborted");
            if (top) {
              const adoptedMeta: SessionMeta = {
                currentStage: top.stage,
                stageStartTime: Date.now(),
                pipelineId: top.pipelineId,
                domain: { id: "general", version: "latest", skillPath: "" },
                summaries: {},
                loopCount: 0,
                currentStepIndex: 0,
                maxLoops: config.maxLoops || 3,
                flowState: "aborted",
                requirementDoc: top.requirementDoc,
              };
              await safeWriteAuditLog("pipeline_start_adopted", {
                mode: "adopt",
                fromStage: top.stage,
                requirementDoc: top.requirementDoc ?? "",
                sourceFile: file,
                adoptedPipelineId: top.pipelineId,
              });
              // Phase 3 (171) M2: register session → adopted pipelineId so subagent JOINs
              // find the correct mapping (mirrors startNewPipeline registerSession call)
              const adoptedSessionFile = ctx?._ctx?.sessionManager?.getSessionFile?.() as string | undefined;
              if (adoptedSessionFile) {
                await registerSession(config, adoptedSessionFile, top.pipelineId);
              }
              return resumePipeline(ctx, adoptedMeta, config, ui, file, "pipeline_start_adopted", forwardArgs);
            }
          }
        } catch (e: unknown) {
          // Fail-open: scan error does not block fresh start
          safeWriteAuditLog("pipeline_start_scan_error", {
            mode: "auto",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Fresh start with file → mode-specific handling
      if (mode === "ask") {
        // review#2 M2: forward existing meta + forwardArgs to ask menu on fresh-start path
        return handleAskMenu(ctx, config, ui, file, meta, forwardArgs);
      }

      // auto/confirm fresh start: both go to clarify directly
      return startNewPipeline(ctx, config, ui, file, "clarify", meta, forwardArgs);
    },
  };
}

/**
 * Handles aborted pipeline with mode-specific behavior.
 * - auto: existing 142 matrix (resume/new unchanged)
 * - confirm: resume-eligible → confirm dialog → resume or cancel
 * - ask: TUI menu (resume/new/spec/cancel)
 */
async function handleAbortedWithMode(
  ctx: any,
  meta: SessionMeta,
  file: string,
  ui: ReturnType<typeof createPipelineUI>,
  config: PipelineConfig,
  mode: StartStageMode,
  forwardArgs?: string,
): Promise<unknown> {
  const resumable = RESUMABLE_STAGES.includes(meta.currentStage);
  const sameDoc = !!file && !!meta.requirementDoc && file === meta.requirementDoc;
  const resumeEligible = resumable && (sameDoc || (!file && !!meta.requirementDoc));

  // ── auto mode: existing 142 matrix unchanged ──
  if (mode === "auto") {
    return handleAbortedPipeline(ctx, meta, file, ui, config, forwardArgs);
  }

  // ── confirm mode ──
  if (mode === "confirm") {
    if (resumeEligible) {
      // A3: if ui.confirm is unavailable → fall back to auto behavior + notify
      if (typeof ctx?.ui?.confirm !== "function") {
        ctx?.ui?.notify?.("TUI confirm unavailable — falling back to auto mode");
        return handleAbortedPipeline(ctx, meta, file, ui, config, forwardArgs);
      }
      const confirmed = await ctx.ui.confirm(
        `Resume at "${meta.currentStage}"? [Confirm / Cancel]`,
      );
      if (confirmed) {
        return resumePipeline(ctx, meta, config, ui, file, "pipeline_start_confirm_resume", forwardArgs);
      }
      // Cancelled → no meta change
      return { success: false, error: "Pipeline start cancelled." };
    }
    // Not resume-eligible → same as auto (new pipeline or error)
    return handleAbortedPipeline(ctx, meta, file, ui, config, forwardArgs);
  }

  // ── ask mode ──
  if (mode === "ask") {
    return handleAskMenu(ctx, config, ui, file || meta.requirementDoc || "", meta, forwardArgs);
  }

  // Fallback (should never reach)
  return handleAbortedPipeline(ctx, meta, file, ui, config, forwardArgs);
}

/**
 * Builds the list of spec-eligible stages for the ask menu.
 * Excludes awaiting_human and completed (not startable).
 * Only includes enabled stages (not disabled).
 */
export function getSpecEligibleStages(config: PipelineConfig): PipelineStage[] {
  const eligible: PipelineStage[] = [];
  const order: PipelineStage[] = ["clarify", "plan", "design-review", "develop", "review", "fix"];
  for (const stage of order) {
    const stageConf = config.stages[stage];
    if (stageConf?.disabled) continue;
    eligible.push(stage);
  }
  return eligible;
}

/**
 * TUI ask menu handler: presents new/resume/spec/cancel options.
 * SDK select has no default-index → priority item placed first.
 * A3 degradation: if ui.select unavailable → fall back to auto + notify.
 */
async function handleAskMenu(
  ctx: any,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  file: string,
  existingMeta: SessionMeta | undefined,
  forwardArgs?: string,
): Promise<unknown> {
  // A3: no TUI → degrade to auto + notify
  if (typeof ctx?.ui?.select !== "function") {
    ctx?.ui?.notify?.("TUI select unavailable — falling back to auto mode");
    if (existingMeta && getFlowState(existingMeta) === "aborted") {
      return handleAbortedPipeline(ctx, existingMeta, file, ui, config, forwardArgs);
    }
    return startNewPipeline(ctx, config, ui, file, "clarify", existingMeta, forwardArgs);
  }

  // Resume eligibility must mirror auto mode's resumeEligible logic
  // (sameDoc || (!file && requirementDoc)), otherwise a user-supplied different
  // doc would still show the resume option and default-highlight it (Medium #2).
  const sameDoc = existingMeta
    ? !!file && !!existingMeta.requirementDoc && file === existingMeta.requirementDoc
    : false;
  const resumeEligible = existingMeta
    ? RESUMABLE_STAGES.includes(existingMeta.currentStage) &&
      (sameDoc || (!file && !!existingMeta.requirementDoc))
    : false;

  // Build options: priority item first (simulate default highlight)
  const options: string[] = [];
  if (resumeEligible) {
    options.push(`Resume stage (${existingMeta!.currentStage})`);
  }
  options.push("New pipeline");
  options.push("Spec stage");
  options.push("Cancel");

  const selection = await ctx.ui.select("Pipeline start mode:", options);

  // Cancel / select returns undefined
  if (!selection) {
    return { success: false, error: "Pipeline start cancelled." };
  }

  // ── Resume ──
  if (selection.startsWith("Resume stage")) {
    if (!existingMeta) {
      return { success: false, error: "No pipeline to resume." };
    }
    return resumePipeline(ctx, existingMeta, config, ui, file, "pipeline_start_ask_resume", forwardArgs);
  }

  // ── New pipeline ──
  if (selection === "New pipeline") {
    // A1: if there's an unfinished pipeline → discard confirmation
    if (existingMeta && getFlowState(existingMeta) === "aborted") {
      if (typeof ctx?.ui?.confirm === "function") {
        const confirmed = await ctx.ui.confirm(
          "Discard unfinished pipeline and start new?",
        );
        if (!confirmed) {
          return { success: false, error: "Pipeline start cancelled." };
        }
      }
    }
    // 206 Phase 2 (integration point C): empty-file starts no longer reject
    // here — startNewPipeline fires the doc-candidate menu after this existing
    // menu flow (Round 2 Q1-A timing) and keeps the original error on cancel.
    // review#2 M2: forwardArgs passthrough on ask-menu "New pipeline" branch
    return startNewPipeline(ctx, config, ui, file, "clarify", existingMeta, forwardArgs);
  }

  // ── Spec stage ──
  if (selection === "Spec stage") {
    const eligibleStages = getSpecEligibleStages(config);
    const stageLabels = eligibleStages.map((s) => `Start at: ${s}`);

    const stageSelection = await ctx.ui.select("Select starting stage:", stageLabels);
    if (!stageSelection) {
      return { success: false, error: "Pipeline start cancelled." };
    }

    // Parse selected stage from label "Start at: {stage}"
    const selectedStage = stageSelection.replace("Start at: ", "") as PipelineStage;

    // A1: discard confirmation for unfinished pipeline
    if (existingMeta && getFlowState(existingMeta) === "aborted") {
      if (typeof ctx?.ui?.confirm === "function") {
        const confirmed = await ctx.ui.confirm(
          "Discard unfinished pipeline and start new?",
        );
        if (!confirmed) {
          return { success: false, error: "Pipeline start cancelled." };
        }
      }
    }

    // 206 Phase 2 (integration point C): no file → doc-candidate menu inside
    // startNewPipeline keeps the original cancel/no-UI error message.
    // review#2 M2: forwardArgs passthrough on ask-menu "Spec stage" branch
    return startNewPipeline(ctx, config, ui, file, selectedStage, existingMeta, forwardArgs);
  }

  // ── Cancel ──
  return { success: false, error: "Pipeline start cancelled." };
}
