/**
 * @module index
 * Main entry point for @earendil-works/pi-pipeline.
 * Exports the `createPipeline` factory function and all public types.
 */

import type { PipelineConfig, ExtensionAPI, ExtensionFactory } from "./types";
import { initAuditLog } from "./utils/auditLog";

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
import { createRequestBashPermission } from "./tools/request-bash-permission";

// Commands
import { createPipelineStatusCommand } from "./commands/pipeline-status";
import { createPipelineStartCommand } from "./commands/pipeline-start";

// Agent settled and session shutdown lifecycle hooks
import { createAgentSettled } from "./core/agent-settled";
import { createSessionShutdown } from "./core/session-shutdown";

// JSON config loader
import { loadJsonConfig, resolvePipelineConfig } from "./core/json-config-loader";

// ─── Factory Function ────────────────────────────────────────────────────────

/**
 * Creates a pipeline extension for the Pi agent.
 *
 * @deprecated Use {@link createPipelineFromJson} instead, which accepts a
 * pipeline_loop.json config file and provides sensible defaults for all stages.
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
    // Initialize audit log directory (resolves path + creates if needed)
    await initAuditLog(config);

    // ── Hooks registration ─────────────────────────────────────────────
    const hooks = [
      createSessionStarter(config),
      createPromptInjector(config),
      createToolGuard(config),
      createLoopBreaker(config),
      createAgentSettled(config),
      createSessionShutdown(config),
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
      createRequestBashPermission(),
    ];
    for (const t of tools) {
      pi.registerTool(t.name, t.description, t.parameters, t.execute);
    }

    // ── Commands registration ──────────────────────────────────────────
    const cmd = createPipelineStatusCommand(config);
    pi.registerCommand(cmd.name, cmd.description, cmd.execute);
    const startCmd = createPipelineStartCommand(config);
    pi.registerCommand(startCmd.name, startCmd.description, startCmd.execute);
  };
}

/**
 * Creates a pipeline extension from a pipeline_loop.json configuration file.
 * This is the simplified entry point — the JSON file only needs stage
 * orchestration data; all other fields receive sensible defaults.
 *
 * @param jsonPath - Path to the pipeline_loop.json file (default: ".pi/pipeline_loop.json")
 * @returns An ExtensionFactory to be invoked by the Pi SDK at extension load time
 */
export function createPipelineFromJson(jsonPath?: string): ExtensionFactory {
  const resolvedPath = jsonPath ?? ".pi/pipeline_loop.json";
  const json = loadJsonConfig(resolvedPath);
  const config = resolvePipelineConfig(json);
  return createPipeline(config);
}

// ─── Default Export (pi agent plugin entry point) ────────────────────────────

/**
 * Default export — pi agent plugin entry point.
 *
 * Called by the pi agent when it discovers this package via
 * `package.json` → `"pi.extensions": ["./index.ts"]`.
 *
 * Auto-loads `.pi/pipeline_loop.json` and registers all hooks, tools,
 * and commands with the pi ExtensionAPI. If the config file is missing,
 * logs a warning and gracefully degrades (no registration).
 *
 * @param pi - The pi SDK ExtensionAPI instance
 */
export default async function initPipeline(pi: ExtensionAPI): Promise<void> {
  const fs = await import("node:fs");
  const defaultPath = ".pi/pipeline_loop.json";

  if (!fs.existsSync(defaultPath)) {
    console.warn(
      `[pi-pipeline] ${defaultPath} not found. Pipeline disabled.`
    );
    return;
  }

  const factory = createPipelineFromJson(defaultPath);
  await factory(pi);
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
  VerifyConfig,
  VerifyJsonConfig,
  StageJsonConfig,
  PipelineJsonConfig,
} from "./types";
