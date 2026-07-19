/**
 * @module index
 * Main entry point for @earendil-works/pi-pipeline.
 * Exports the `createPipeline` factory function and all public types.
 */

import type { PipelineConfig, ExtensionAPI, ExtensionFactory } from "./types";

// Session lifecycle and prompt injection
import { createSessionStarter } from "./core/session-starter";
import { createPromptInjector } from "./core/prompt-injector";

// Tool safety and loop circuit breaker
import { createToolGuard } from "./core/tool-guard";
import { createLoopBreaker } from "./core/loop-breaker";

// Stage management tools
import { createStageAdvancer } from "./core/stage-advancer";
import { createLoopChecker } from "./core/loop-checker";
import { createPipelineState } from "./core/pipeline-state";

// Orchestration tools
import { createGenerateSummary } from "./tools/generate-summary";
import { createValidateSummary } from "./tools/validate-summary";
import { createPipelineHandoff } from "./tools/pipeline-handoff";

// Commands and session end audit
import { createPipelineStatusCommand } from "./commands/pipeline-status";
import { createSessionEnder } from "./core/session-ender";

// ─── Factory Function ────────────────────────────────────────────────────────

/**
 * Creates a pipeline extension for the Pi agent.
 *
 * Accepts a project-specific `PipelineConfig` that maps each of the 8 pipeline
 * stages to its agent, skill, tool restrictions, and transition rules.
 * Returns an `ExtensionFactory` that registers all hooks, tools, and commands
 * directly with the Pi SDK via the ExtensionAPI.
 *
 * @param config - The pipeline configuration provided by the consuming project
 * @returns An `ExtensionFactory` to be invoked by the Pi SDK at extension load time
 *
 * @example
 * ```ts
 * import { createPipeline } from "@earendil-works/pi-pipeline";
 *
 * export default createPipeline({
 *   projectRoot: __dirname,
 *   stages: {
 *     clarify: { agentFile: "./agents/clarify.md", skillPath: "design-und/SKILL.md", ... },
 *     // ... all 8 stages
 *   },
 * });
 * ```
 */
export function createPipeline(config: PipelineConfig): ExtensionFactory {
  return async (pi: ExtensionAPI): Promise<void> => {
    // ── Hooks registration ─────────────────────────────────────────────
    const hooks = [
      createSessionStarter(config),
      createPromptInjector(config),
      createToolGuard(config),
      createLoopBreaker(config),
      createSessionEnder(config),
    ];
    for (const h of hooks) {
      pi.on(h.event, h.handler);
    }

    // ── Tools registration ─────────────────────────────────────────────
    const tools = [
      createStageAdvancer(config),
      createLoopChecker(config),
      createPipelineState(config),
      createGenerateSummary(config),
      createValidateSummary(config),
      createPipelineHandoff(config),
    ];
    for (const t of tools) {
      pi.registerTool(t.name, t.description, t.parameters, t.execute);
    }

    // ── Commands registration ──────────────────────────────────────────
    const cmd = createPipelineStatusCommand(config);
    pi.registerCommand(cmd.name, cmd.description, cmd.execute);
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
