/**
 * @module pipeline-start
 * /pipeline-start <doc_file.md> — initializes a pipeline run from a requirement document.
 */

import fs from "node:fs";
import path from "node:path";
import type { PipelineConfig, PipelineStage, Command, SessionMeta } from "../types";
import {
  DEFAULT_VERIFY_FILE,
  DEFAULT_DECISION_SHORTCUT,
  resolveStagePath,
  RESUMABLE_STAGES,
} from "../constants";
import { safeWriteAuditLog, safeWriteStageAudit } from "../utils/auditLog";
import { getFlowState } from "../core/flow-state";
import { createPipelineUI } from "../core/pipeline-ui";

/**
 * Writes the persistent TUI status bar showing current pipeline stage.
 * Safely no-ops when ctx/ui is unavailable or output.pipelineStage is off.
 *
 * @param ui - PipelineUI instance
 * @param ctx - Extension context (uses session.getMeta for dynamic stage)
 */
function syncStageStatusBar(ui: ReturnType<typeof createPipelineUI>, ctx?: any): void {
  const stage = ctx?.session?.getMeta?.()?.currentStage ?? "clarify";
  ui.setStage(ctx, stage);
}

/**
 * Checks that all 5 active stages have agentPath configured.
 * Skips disabled stages (require: false in JSON config).
 * Returns array of stage names missing agentPath.
 */
function checkAgentPaths(config: PipelineConfig): PipelineStage[] {
  const activeStages: PipelineStage[] = [
    "clarify", "plan", "develop", "review", "fix",
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
 * Checks for missing verify.md files across all stages that require verification.
 *
 * @param config - Pipeline configuration
 * @returns Array of stage names whose verify.md is missing
 */
function checkVerifyFiles(config: PipelineConfig): PipelineStage[] {
  const missingStages: PipelineStage[] = [];
  const activeStages: PipelineStage[] = [
    "clarify", "plan", "develop", "review", "fix",
  ];

  for (const stage of activeStages) {
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
  const newMeta: SessionMeta = {
    currentStage: "clarify",
    stageStartTime: Date.now(),
    pipelineId,
    domain: meta.domain ?? { id: "general", version: "latest", skillPath: "" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: config.maxLoops || 3,
    maxLoopCycles: config.maxLoopCycles ?? 3,
    flowState: "running",
    verifyAttempts: 0,
    verifyFailures: [],
    requirementDoc,

    // RC3: explicitly clear stage-chain residue so the new clarify pipeline does not
    // inherit old plan/develop chain state via updateMeta's spread merge semantics.
    // Without these explicit clears, stale fields from the previous pipeline would
    // persist and risk pipeline-handoff cycle-detection misfires / stale contextFiles.
    previousStage: undefined,
    stageVisitOrder: undefined,
    contextFiles: undefined,
    violations: [],
    advancedThisTurn: undefined,
    loopCycleCount: undefined,
    verifyConfigError: undefined,
    blockedReason: undefined,
    terminated: undefined,
    terminateReason: undefined,
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
function buildResumeVisitOrder(
  config: PipelineConfig,
  stage: PipelineStage,
): PipelineStage[] {
  const sequence: PipelineStage[] = [];
  let s: PipelineStage | null = "clarify";
  const visited = new Set<string>();

  for (let i = 0; i < 16 && s && !visited.has(s); i++) {
    sequence.push(s);
    if (s === stage) break;
    visited.add(s);
    const stageConf: import("../types").StageConfig | undefined = config.stages[s];
    if (!stageConf) break;
    const next: PipelineStage | null = stageConf.nextStage;
    if (next === null) break;
    s = next;
  }

  // Defensive fallback: chain did not reach target stage
  if (sequence[sequence.length - 1] !== stage) {
    return [stage];
  }
  return sequence;
}

/**
 * Builds SessionMeta for a pipeline resume (aborted restart preserving stage position).
 *
 * Field rebuild contract:
 * - Preserve: pipelineId, currentStage, requirementDoc, domain, summaries, contextFiles, maxLoops/maxLoopCycles
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
function buildResumeMeta(
  meta: SessionMeta,
  config: PipelineConfig,
): SessionMeta {
  return {
    // Preserved fields
    pipelineId: meta.pipelineId,
    currentStage: meta.currentStage,
    requirementDoc: meta.requirementDoc,
    domain: meta.domain ?? { id: "general", version: "latest", skillPath: "" },
    summaries: meta.summaries ?? {},
    contextFiles: meta.contextFiles,
    maxLoops: config.maxLoops ?? meta.maxLoops ?? 3,
    maxLoopCycles: config.maxLoopCycles ?? meta.maxLoopCycles ?? 3,

    // Rebuilt fields
    previousStage: resolvePreviousStage(config, meta.currentStage),
    stageVisitOrder: buildResumeVisitOrder(config, meta.currentStage),

    // Cleared counters / transient state
    loopCount: 0,
    currentStepIndex: 0,
    verifyAttempts: 0,
    verifyFailures: [],
    violations: [],
    advancedThisTurn: undefined,
    loopCycleCount: undefined,
    verifyConfigError: undefined,

    // Cleared terminal / blocked state
    blockedReason: undefined,
    terminated: undefined,
    terminateReason: undefined,

    // Lifecycle
    flowState: "running",
    stageStartTime: Date.now(),
  };
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
): Promise<{ success: boolean; message?: string; error?: string; pipelineId?: string; currentStage?: PipelineStage }> {
  const resumable = RESUMABLE_STAGES.includes(meta.currentStage);
  const sameDoc = !!file && !!meta.requirementDoc && file === meta.requirementDoc;
  const resumeEligible = resumable && (sameDoc || (!file && !!meta.requirementDoc));

  // --- Resume branch ---
  if (resumeEligible) {
    const newMeta = buildResumeMeta(meta, config);
    ctx?.session?.updateMeta?.(newMeta);
    syncStageStatusBar(ui, ctx);

    // Dual audit events for resume
    await safeWriteStageAudit(config, "pipeline_start", newMeta, {
      command: file ? `/pipeline-start ${file}` : "/pipeline-start",
      file: file || "(none)",
      mode: "resume",
      previousStage: meta.currentStage,
    });
    await safeWriteStageAudit(config, "pipeline_resumed", newMeta, {
      fromStage: meta.currentStage,
      toStage: newMeta.currentStage,
      reason: "pipeline_start_resume",
      requirementDoc: newMeta.requirementDoc ?? "",
    });

    return {
      success: true,
      message: `Pipeline resumed at stage "${newMeta.currentStage}".`,
      pipelineId: newMeta.pipelineId,
      currentStage: newMeta.currentStage,
    };
  }

  // --- Terminal stage: completed → require fresh start ---
  if (meta.currentStage === "completed") {
    return {
      success: false,
      error: "Pipeline already completed. Use /pipeline-start <file> to start a new pipeline.",
    };
  }

  // --- Frozen stage: awaiting_human → require decision menu ---
  if (meta.currentStage === "awaiting_human") {
    const shortcutKey = config.decisionShortcutKey ?? DEFAULT_DECISION_SHORTCUT;
    return {
      success: false,
      error: `Pipeline is at awaiting_human stage. Press ${shortcutKey} to open the decision menu.`,
    };
  }

  // --- No requirementDoc && no file → prompt user ---
  if (!meta.requirementDoc && !file) {
    return {
      success: false,
      error: "run /pipeline-start <doc_file> start pipeline loop",
    };
  }

  // --- Start new pipeline (different file, or no requirementDoc with file provided) ---
  const { pipelineId, newMeta } = buildRestartMeta(meta, config, meta.requirementDoc || file);
  ctx?.session?.updateMeta?.(newMeta);
  syncStageStatusBar(ui, ctx);
  await safeWriteStageAudit(config, "pipeline_start", newMeta, {
    command: file ? `/pipeline-start ${file}` : "/pipeline-start",
    file: file || "(none)",
    previousStage: meta.currentStage,
  });
  return {
    success: true,
    message: `Pipeline restarted as "${pipelineId}" at stage "clarify".`,
    pipelineId,
    currentStage: "clarify",
  };
}

export function createPipelineStartCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-start",
    description:
      "Start a new pipeline run. Optionally reads the specified requirement document and " +
      "injects it into the clarify stage. Without a file, initializes the state machine only.",
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      const file = (args.file as string) || "";
      const ui = createPipelineUI(config);

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

      // Phase 5 (Bug 5): fresh start without doc_file is rejected — doc_file is required.
      // (Previous "no file → init state machine only" branch removed.)
      if (!file) {
        if (meta?.currentStage && meta.pipelineId) {
          const flowState = getFlowState(meta);

          // Aborted → unified resume/new decision matrix
          if (flowState === "aborted") {
            return handleAbortedPipeline(ctx, meta, file, ui, config);
          }

          // Running or blocked → reject with shortcut hint
          const shortcutKey = config.decisionShortcutKey ?? DEFAULT_DECISION_SHORTCUT;
          return {
            success: false,
            error:
              `Pipeline "${meta.pipelineId}" already running at stage "${meta.currentStage}" (${flowState}). ` +
              `Press ${shortcutKey} to open the decision menu to handle it.`,
          };
        }

        // Fresh start without doc_file → reject, do NOT initialize state machine
        return {
          success: false,
          error: "run /pipeline-start <doc_file> start pipeline loop",
        };
      }

      // File provided — fresh start path (aborted restart preserves existing requirementDoc)
      if (meta?.currentStage && meta.pipelineId) {
        const flowState = getFlowState(meta);

        if (flowState === "aborted") {
          return handleAbortedPipeline(ctx, meta, file, ui, config);
        }

        // Running or blocked → reject with shortcut hint
        const shortcutKey = config.decisionShortcutKey ?? DEFAULT_DECISION_SHORTCUT;
        return {
          success: false,
          error:
            `Pipeline "${meta.pipelineId}" already running at stage "${meta.currentStage}" (${flowState}). ` +
            `Press ${shortcutKey} to open the decision menu to handle it.`,
        };
      }

      const docPath = path.join(config.projectRoot, file);

      let content: string;
      try {
        content = fs.readFileSync(docPath, "utf-8");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await safeWriteAuditLog("pipeline_start_error", { file, error: errMsg }, "error");
        return {
          success: false,
          error: `File not found: ${file} (${errMsg})`,
        };
      }

      // Check for missing verify.md files
      const missingStages = checkVerifyFiles(config);
      if (missingStages.length > 0) {
        return {
          success: false,
          error: `verify.md missing for stages: [${missingStages.join(", ")}]`,
          missingStages,
          suggestion: "Run /pipeline-init 1 to generate verify.md files",
        };
      }

      const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const newMeta: SessionMeta = {
        currentStage: "clarify",
        stageStartTime: Date.now(),
        pipelineId,
        domain: { id: "general", version: "latest", skillPath: "" },
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: config.maxLoops || 3,
        maxLoopCycles: config.maxLoopCycles ?? 3,
        flowState: "running",
        requirementDoc: file,
      };

      ctx?.session?.updateMeta?.(newMeta);
      syncStageStatusBar(ui, ctx);

      // Audit successful fresh start
      await safeWriteStageAudit(config, "pipeline_start", newMeta, {
        command: `/pipeline-start ${file}`,
        file,
        previousStage: "none",
      });

      return {
        success: true,
          message: `Pipeline "${pipelineId}" started with document: ${file}. ` +
            `Next: run @feat-design-plan-agent ${file} 1 to start requirement clarification`,
        pipelineId,
        currentStage: "clarify",
        requirementContent: content.slice(0, 500) + (content.length > 500 ? "..." : ""),
      };
    },
  };
}
