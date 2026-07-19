/**
 * @module index
 * Main entry point for @earendil-works/pi-pipeline.
 * Exports the `createPipeline` factory function and all public types.
 */

import type {
  PipelineConfig,
  PipelinePlugin,
  Hook,
  Tool,
  Command,
} from "./types";

// ─── Factory Function ────────────────────────────────────────────────────────

/**
 * Creates a pipeline plugin for the pi agent.
 *
 * Accepts a project-specific `PipelineConfig` that maps each of the 8 pipeline
 * stages to its agent, skill, tool restrictions, and transition rules.
 * Returns a `PipelinePlugin` object containing hooks, tools, and commands
 * that the pi SDK will register.
 *
 * @param config - The pipeline configuration provided by the consuming project
 * @returns A `PipelinePlugin` ready to be registered with the pi SDK
 *
 * @example
 * ```ts
 * import { createPipeline } from "@earendil-works/pi-pipeline";
 *
 * const plugin = createPipeline({
 *   projectRoot: __dirname,
 *   stages: {
 *     understand: { agentFile: "./agents/understand.md", skillPath: "./skills/understand", ... },
 *     // ... all 8 stages
 *   },
 * });
 * ```
 */
export function createPipeline(config: PipelineConfig): PipelinePlugin {
  // Phase 0 stub — hooks, tools, and commands will be populated in Phases 1-4.
  const hooks: Hook[] = [];
  const tools: Tool[] = [];
  const commands: Command[] = [];

  return {
    hooks,
    tools,
    commands,
  };
}

// ─── Type Re-exports ─────────────────────────────────────────────────────────

export type {
  PipelineStage,
  StageConfig,
  PipelineConfig,
  SessionMeta,
  SummaryMeta,
  DomainConfig,
  Hook,
  Tool,
  Command,
  PipelinePlugin,
} from "./types";
