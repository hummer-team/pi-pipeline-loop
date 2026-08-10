/**
 * @module tool-guard
 * Factory for the `tool_call` hook.
 * Enforces tool permissions, bash command prefix restrictions,
 * file write protection, and pipeline freeze state.
 */

import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { PROTECTED_PATHS } from "../constants";
import { getFileHash } from "../utils/hash";

/**
 * Creates the `tool_call` hook that intercepts and validates tool calls.
 *
 * Performs four levels of enforcement:
 * 1. Tool permission — only tools listed in StageConfig.allowedTools
 * 2. Bash prefix — only commands matching allowedBashPrefixes
 * 3. Freeze state — blocks all tools when pipeline is "awaiting_human"
 * 4. File write protection — blocks writes to protected paths
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
      if (!(stageConfig.allowedTools || []).includes(toolName)) {
        return {
          block: true,
          reason: `Tool "${toolName}" not allowed in "${meta.currentStage}" stage`,
        };
      }

      // 2. Bash command prefix check
      if (toolName === "bash") {
        const command = args.command as string;
        const mergedPrefixes = [
          ...(stageConfig.allowedBashPrefixes || []),
          ...(meta.tempAllowedBash || []),
        ];
        if (
          !mergedPrefixes.some((p: string) => command.startsWith(p))
        ) {
          return {
            block: true,
            reason: `Bash command "${command}" not in allowedBashPrefixes.`,
            suggestAsk: true,
            blockedCommand: command,
          };
        }
      }

      // 3. Termination / freeze state check
      if (meta.terminated) {
        return {
          block: true,
          reason: `Pipeline terminated: ${meta.terminateReason || "unknown"}`,
        };
      }
      if (meta.currentStage === "awaiting_human") {
        return {
          block: true,
          reason:
            "Pipeline frozen. Contact the user to resume the pipeline",
        };
      }

      // 4. File write protection for protected paths
      if (toolName === "write" || toolName === "edit") {
        const filePath = (args.file_path || args.path) as string;
        const normalizedPath = path.normalize(filePath);
        const pathComponents = normalizedPath.split(path.sep);

        const isProtected = PROTECTED_PATHS.some((p) => {
          const normalizedP = path.normalize(p).replace(/\/+$/, "");
          // Check if the protected path appears as a component of the file path.
          // This avoids false positives like .pipelines/ matching .pi/,
          // .gitignore matching .git/, or .github/ matching .git/.
          return pathComponents.includes(normalizedP);
        });

        if (isProtected) {
          return {
            block: true,
            reason: `FORBIDDEN: Cannot modify protected path '${filePath}' during Loop.`,
          };
        }

        // Record oldHash for diff archiving in loop-breaker
        const hash = await getFileHash(filePath);
        (ctx.toolCall as Record<string, unknown>).oldHash = hash;
      }

      return undefined;
    },
  };
}

// Re-exported from the centralized auditLog module for backward compatibility.
export { getDateAuditFileName } from "../utils/auditLog";
