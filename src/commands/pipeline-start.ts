/**
 * @module pipeline-start
 * /pipeline-start <doc_file.md> — initializes a pipeline run from a requirement document.
 */

import fs from "node:fs";
import path from "node:path";
import type { PipelineConfig, PipelineStage, Command, SessionMeta } from "../types";
import { DEFAULT_VERIFY_FILE, DEFAULT_DECISION_SHORTCUT, resolveStagePath } from "../constants";
import { safeWriteAuditLog } from "../utils/auditLog";
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
  ui.setStage(ctx, `Pipeline → ${stage}`);
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
    blockedReason: undefined,
    terminated: undefined,
    terminateReason: undefined,
    verifyAttempts: 0,
    verifyFailures: [],
    requirementDoc,
  };
  return { pipelineId, newMeta };
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

      // Phase 5 (Bug 5): fresh start without doc_file is rejected — doc_file is required.
      // (Previous "no file → init state machine only" branch removed.)
      if (!file) {
        if (meta?.currentStage && meta.pipelineId) {
          const flowState = getFlowState(meta);

          // Aborted restart with empty requirementDoc → prompt user to provide doc_file
          if (flowState === "aborted") {
            if (!meta.requirementDoc) {
              return {
                success: false,
                error: "run /pipeline-start <doc_file> start pipeline loop",
              };
            }
            const { pipelineId, newMeta } = buildRestartMeta(meta, config, meta.requirementDoc);
            ctx?.session?.updateMeta?.(newMeta);
            syncStageStatusBar(ui, ctx);
            return {
              success: true,
              message: `Pipeline restarted as "${pipelineId}" at stage "clarify".`,
              pipelineId,
              currentStage: "clarify",
            };
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
          // Aborted restart: preserve existing requirementDoc, or use newly provided file
          // when old meta has no requirementDoc (consistent with no-file branch semantics)
          const { pipelineId, newMeta } = buildRestartMeta(meta, config, meta.requirementDoc || file);
          ctx?.session?.updateMeta?.(newMeta);
          syncStageStatusBar(ui, ctx);
          return {
            success: true,
            message: `Pipeline restarted as "${pipelineId}" at stage "clarify".`,
            pipelineId,
            currentStage: "clarify",
          };
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
