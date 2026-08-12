/**
 * @module index
 * Main entry point for @earendil-works/pi-pipeline.
 * Exports the `createPipeline` factory function and all public types.
 */

import type { PipelineConfig, ExtensionAPI, ExtensionFactory, ExecFn } from "./types";
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
import { createPipelineVerify } from "./tools/pipeline-verify";

// Commands
import { createPipelineStatusCommand } from "./commands/pipeline-status";
import { createPipelineStartCommand } from "./commands/pipeline-start";
import { createPipelineInitCommand } from "./commands/pipeline-init";

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

    // LLM stub: throws on invocation — graceful fail-closed until pi SDK provides real callLLM
    const callLLMStub = async (_prompt: string): Promise<string> => {
      throw new Error("LLM not available (pi SDK stub)");
    };

    // Wrap pi.exec() as ExecFn for DI into verifiers (avoids child_process.execSync)
    const execFn: ExecFn | undefined = pi.exec
      ? async (cmd: string, args: string[], cwd: string) => {
          const result = await pi.exec!(cmd, args, { cwd });
          return { stdout: result.stdout, stderr: result.stderr, code: result.code };
        }
      : undefined;

    // ── Hooks registration ─────────────────────────────────────────────
    // NOTE: Phase 0 transitional — real ExtensionAPI uses typed overloads for `on()`.
    // Phase 2 will bridge internal Hook shape to real SDK signatures properly.
    const hooks = [
      createSessionStarter(config),
      createPromptInjector(config),
      createToolGuard(config),
      createLoopBreaker(config),
      createAgentSettled(config, { callLLM: callLLMStub, execFn }),
      createSessionShutdown(config),
    ];
    for (const h of hooks) {
      // TSDoc: temporary cast — Phase 2 replaces with buildRuntimeCtx bridge
      (pi.on as (event: string, handler: (ctx: unknown) => unknown) => void)(h.event, h.handler as (ctx: unknown) => unknown);
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
    // TSDoc: temporary cast — Phase 2 replaces with registerTool(tool) single-object bridge
    // and registerCommand(name, options) object-style registration.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const piAny = pi as unknown as {
      registerTool(name: string, description: string, parameters: unknown, execute: (args: any, ctx?: any) => Promise<unknown>): void;
      registerCommand(name: string, description: string, execute: (args: any, ctx?: any) => Promise<unknown>): void;
    };
    for (const t of tools) {
      piAny.registerTool(t.name, t.description, t.parameters, t.execute);
    }

    // ── Conditional tool: pipeline_verify (only if any stage uses mode: "tool") ──
    const hasToolModeStage = Object.values(config.stages).some(
      (sc) => sc.verify?.mode === "tool",
    );
    if (hasToolModeStage) {
      const verifyTool = createPipelineVerify(config, {
        callLLM: callLLMStub,
        execFn,
      });
      piAny.registerTool(
        verifyTool.name,
        verifyTool.description,
        verifyTool.parameters,
        verifyTool.execute,
      );
    }

    // ── Commands registration ──────────────────────────────────────────
    const cmd = createPipelineStatusCommand(config);
    piAny.registerCommand(cmd.name, cmd.description, cmd.execute);
    const startCmd = createPipelineStartCommand(config);
    piAny.registerCommand(startCmd.name, startCmd.description, startCmd.execute);
    const initCmd = createPipelineInitCommand(config, callLLMStub);
    piAny.registerCommand(initCmd.name, initCmd.description, initCmd.execute);
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
  VerifyFailureItem,
  VerifyResultSnapshot,
  ExecFn,
} from "./types";
