/**
 * @module tool-guard
 * Factory for the `tool_call` hook.
 * Enforces tool permissions, bash command prefix restrictions,
 * file write protection, and pipeline freeze state.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";

/** Paths that agents in loop stages (develop/fix) must not modify */
const PROTECTED_PATHS = [".pi/", "AGENTS.md", ".git/"];

/**
 * Creates the `tool_call` hook that intercepts and validates tool calls.
 *
 * Performs four levels of enforcement:
 * 1. Tool permission — only tools listed in StageConfig.allowedTools
 * 2. Bash prefix — only commands matching allowedBashPrefixes
 * 3. Freeze state — blocks all tools when pipeline is "awaiting_human"
 * 4. File write protection — blocks writes to protected paths
 *
 * Also handles Plan Step switching by resetting loopCount on step change.
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "tool_call" event
 */
export function createToolGuard(config: PipelineConfig): Hook {
  return {
    event: "tool_call",
    handler: async (ctx: any): Promise<unknown> => {
      const meta = ctx.session.getMetadata() as SessionMeta;
      const stageConfig = config.stages[meta.currentStage];
      const { name: toolName, arguments: args } = ctx.toolCall;

      // 1. Tool permission check
      if (!stageConfig.allowedTools.includes(toolName)) {
        return {
          block: true,
          reason: `Tool "${toolName}" not allowed in "${meta.currentStage}" stage`,
        };
      }

      // 2. Bash command prefix check
      if (toolName === "bash") {
        const command = args.command as string;
        if (
          !stageConfig.allowedBashPrefixes.some((p: string) =>
            command.startsWith(p),
          )
        ) {
          return { block: true, reason: `Bash command not allowed` };
        }
      }

      // 3. Freeze state check (awaiting_human blocks all tools)
      if (meta.currentStage === "awaiting_human") {
        return {
          block: true,
          reason:
            "Pipeline frozen. Use /pipeline-resume or /pipeline-restart-design",
        };
      }

      // 4. File write protection for protected paths
      if (toolName === "write" || toolName === "edit") {
        const filePath = (args.file_path || args.path) as string;
        if (PROTECTED_PATHS.some((p) => filePath.includes(p))) {
          return {
            block: true,
            reason: `FORBIDDEN: Cannot modify protected path '${filePath}' during Loop.`,
          };
        }
      }

      // Plan Step switching: reset loop count when step index changes
      if (toolName === "plan_run_script") {
        const newStepIndex = args.step_index as number;
        if (newStepIndex !== meta.currentStepIndex) {
          ctx.session.updateMetadata({
            ...meta,
            currentStepIndex: newStepIndex,
            loopCount: 0,
          });
        }
      }

      return undefined;
    },
  };
}
