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

// Phase 1: Session lifecycle and prompt injection
import { createSessionStarter } from "./core/session-starter";
import { createPromptInjector } from "./core/prompt-injector";

// Phase 2: Tool safety and loop circuit breaker
import { createToolGuard } from "./core/tool-guard";
import { createLoopBreaker } from "./core/loop-breaker";

// Phase 2 (tools): Stage management tools
import { createStageAdvancer } from "./core/stage-advancer";
import { createLoopChecker } from "./core/loop-checker";
import { createPipelineState } from "./core/pipeline-state";

// Phase 3: Orchestration tools
import { createGenerateSummary } from "./tools/generate-summary";
import { createValidateSummary } from "./tools/validate-summary";
import { createPipelineHandoff } from "./tools/pipeline-handoff";

// Phase 4: Commands and session end audit
import { createPipelineStatusCommand } from "./commands/pipeline-status";
import { createSessionEnder } from "./core/session-ender";

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
 *     clarify: { agentFile: "./agents/clarify.md", skillPath: "design-und/SKILL.md", ... },
 *     // ... all 8 stages
 *   },
 * });
 * ```
 */
export function createPipeline(config: PipelineConfig): PipelinePlugin {
  // ── Hooks ────────────────────────────────────────────────────────────
  const hooks: Hook[] = [
    // Phase 1: Session lifecycle and prompt injection
    createSessionStarter(config),
    createPromptInjector(config),
    // Phase 2: Tool safety guard and loop circuit breaker
    createToolGuard(config),
    createLoopBreaker(config),
    // Phase 4: Session end audit logging
    createSessionEnder(config),
  ];

  // ── Tools ────────────────────────────────────────────────────────────
  const tools: Tool[] = [
    // Phase 2: Stage management tools
    createStageAdvancer(config),
    createLoopChecker(config),
    createPipelineState(config),
    // Phase 3: Orchestration tools
    createGenerateSummary(config),
    createValidateSummary(config),
    createPipelineHandoff(config),
  ];

  // ── Commands ─────────────────────────────────────────────────────────
  const commands: Command[] = [
    // Phase 4: Status query command
    createPipelineStatusCommand(config),
  ];

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
  ExtensionAPI,
  ExtensionFactory,
} from "./types";
