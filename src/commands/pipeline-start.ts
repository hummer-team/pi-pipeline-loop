/**
 * @module pipeline-start
 * /pipeline_start <doc_file.md> — initializes a pipeline run from a requirement document.
 */

import fs from "node:fs";
import path from "node:path";
import type { PipelineConfig, PipelineStage, Command, SessionMeta } from "../types";
import { DEFAULT_VERIFY_FILE, resolveStagePath } from "../constants";
import { safeWriteAuditLog } from "../utils/auditLog";

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

export function createPipelineStartCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-start",
    description:
      "Start a new pipeline run. Optionally reads the specified requirement document and " +
      "injects it into the clarify stage. Without a file, initializes the state machine only.",
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      const file = (args.file as string) || "";

      const meta = ctx?.session?.getMeta?.();

      if (meta?.currentStage && meta.pipelineId) {
        return {
          success: false,
          error:
            `Pipeline "${meta.pipelineId}" already running at stage "${meta.currentStage}". ` +
            `End the current session before starting a new pipeline.`,
        };
      }

      // No file provided — initialize state machine only
      if (!file) {
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
        };

        ctx?.session?.updateMeta?.(newMeta);

        return {
          success: true,
          message: `Pipeline "${pipelineId}" initialized at stage "clarify". ` +
            `下一步请输入 @feat-design-plan-agent <需求文档路径> 1 开始需求澄清`,
          pipelineId,
          currentStage: "clarify",
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

      return {
        success: true,
        message: `Pipeline "${pipelineId}" started with document: ${file}. ` +
          `下一步请输入 @feat-design-plan-agent ${file} 1 开始需求澄清`,
        pipelineId,
        currentStage: "clarify",
        requirementContent: content.slice(0, 500) + (content.length > 500 ? "..." : ""),
      };
    },
  };
}
