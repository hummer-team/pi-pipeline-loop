/**
 * @module pipeline-start
 * /pipeline_start <doc_file.md> — initializes a pipeline run from a requirement document.
 */

import fs from "node:fs";
import path from "node:path";
import type { PipelineConfig, Command, SessionMeta } from "../types";

export function createPipelineStartCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-start",
    description:
      "Start a new pipeline run. Reads the specified requirement document and " +
      "injects it into the clarify stage.",
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      const file = args.file as string;
      if (!file || typeof file !== "string") {
        return { success: false, error: "Usage: /pipeline_start <file.md>" };
      }

      const docPath = path.join(config.projectRoot, file);

      let content: string;
      try {
        content = fs.readFileSync(docPath, "utf-8");
      } catch {
        return {
          success: false,
          error: `File not found: ${file}`,
        };
      }

      const meta = ctx?.session?.getMetadata?.() as SessionMeta | undefined;

      if (meta?.currentStage && meta.pipelineId) {
        return {
          success: false,
          error:
            `Pipeline "${meta.pipelineId}" already running at stage "${meta.currentStage}". ` +
            `End the current session before starting a new pipeline.`,
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
        requirementDoc: file,
      };

      ctx?.session?.updateMetadata?.(newMeta);

      return {
        success: true,
        message: `Pipeline "${pipelineId}" started with document: ${file}`,
        pipelineId,
        currentStage: "clarify",
        requirementContent: content.slice(0, 500) + (content.length > 500 ? "..." : ""),
      };
    },
  };
}
