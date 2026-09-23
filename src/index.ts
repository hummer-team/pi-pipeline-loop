/**
 * @module index
 * Main entry point for @earendil-works/pi-pipeline.
 * Exports the `createPipeline` factory function and all public types.
 */

import type { PipelineConfig, ExtensionAPI, ExtensionFactory, ExecFn } from "./types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, TEMPLATE_DIR } from "./constants";
import { initAuditLog } from "./utils/auditLog";
import { buildRuntimeCtx } from "./core/runtime-ctx";

import { parseCommandArgs } from "./utils/command-args";
// Phase 2 / 177 (D4): event-driven subagent availability latch
import { wireSubagentsReadyListener } from "./utils/subagent-availability";
import { validateSubagentCreated, setOwnerSessionAccessor } from "./utils/subagent-identity";


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
import { createPipelineVerify } from "./tools/pipeline-verify";

// Commands
import { createPipelineStatusCommand } from "./commands/pipeline-status";
import { createPipelineStartCommand } from "./commands/pipeline-start";
import { createPipelineInitCommand } from "./commands/pipeline-init";
import { createPipelineQuitCommand } from "./commands/pipeline-quit";
import { createPipelineResumeCommand } from "./commands/pipeline-resume";

// Agent settled and session shutdown lifecycle hooks
import { createAgentSettled } from "./core/agent-settled";
import { createSessionShutdown } from "./core/session-shutdown";

// JSON config loader
import { loadJsonConfig, resolvePipelineConfig } from "./core/json-config-loader";
import * as fsSync from "node:fs";
import * as pathMod from "node:path";

// ─── Factory Function ────────────────────────────────────────────────────────

/**
 * Creates a pipeline extension for the Pi agent.
 *
 * @deprecated Use {@link createPipelineFromJson} instead, which accepts a
 * pipeline_loop.json config file and provides sensible defaults for all stages.
 *
 * Accepts a project-specific `PipelineConfig` that maps each of the 7 pipeline
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
  *     clarify: { agentPath: ".pi/agents/clarify.md", skillPath: "design-und/SKILL.md", ... },
 *     // ... all 7 stages
 *   },
 * });
 * ```
 */
export function createPipeline(config: PipelineConfig): ExtensionFactory {
  return async (pi: ExtensionAPI): Promise<void> => {
    // Initialize audit log directory (resolves path + creates if needed)
    await initAuditLog(config);

    // Wrap pi.exec() as ExecFn for DI into verifiers (avoids child_process.execSync)
    const execFn: ExecFn | undefined = pi.exec
      ? async (cmd: string, args: string[], cwd: string) => {
          const result = await pi.exec!(cmd, args, { cwd });
          return { stdout: result.stdout, stderr: result.stderr, code: result.code };
        }
      : undefined;

    // Phase 2 / 177 (D4): subscribe to the `subagents:ready` availability
    // announcement. The latch replaces timeout-based ping probing; when false,
    // spawn paths fall back immediately (zero dead wait).
    wireSubagentsReadyListener(pi);

    // G4 (188): validate spawned subagent type against pipeline stage config.
    // subagents:created fires for Agent-tool spawns only (not RPC spawns from this plugin).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((pi as any).events?.on) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pi as any).events.on("subagents:created", async (event: { id: string; type: string; description?: string; isBackground?: boolean }) => {
        await validateSubagentCreated(event, config, pi);
      });
    }

    // ── Hooks registration (bridge: SDK (event, ctx) → internal RuntimeCtx) ──
    const hooks = [
      createSessionStarter(config),
      createPromptInjector(config),
      createToolGuard(config, { execFn }),
      createLoopBreaker(config),
      createAgentSettled(config, { execFn }),
      createSessionShutdown(config),
    ];
    for (const h of hooks) {
      // TSDoc: event type cast — internal Hook uses string event names,
      // SDK uses overloaded typed events. Cast needed for generic registration.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pi.on as any)(h.event, async (event: unknown, ctx: ExtensionContext) => {
        const rctx = buildRuntimeCtx(pi, ctx, event as Record<string, unknown>, config);

        // G4 (188): update the module-level owner session accessor so that
        // validateSubagentCreated (triggered by the global subagents:created
        // event, which has no per-session ctx) can read the owner session's
        // currentStage through the real ExtensionContext.sessionManager path.
        // Updated on every hook invocation — always reflects latest state.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setOwnerSessionAccessor(
          () => rctx.session.getMeta(),
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            events: (pi as any).events,
            ui: ctx.ui ? { notify: (msg: string) => ctx.ui.notify(msg) } : undefined,
          },
        );

        return h.handler(rctx);
      });
    }

    // ── Model selection recording (Q4-A: read-only observation) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pi.on as any)("model_select", async (event: any, ctx: ExtensionContext) => {
      const rctx = buildRuntimeCtx(pi, ctx, undefined, config);
      const meta = rctx.session.getMeta();
      if (meta && event?.model) {
        rctx.session.updateMeta({
          currentModel: {
            provider: event.model.provider ?? "unknown",
            modelId: event.model.modelId ?? event.model.id ?? "unknown",
          },
        });
      }
    });

    // ── Tools registration (bridge: SDK registerTool(object) → internal Tool) ──
    const tools = [
      createStageAdvancer(config, { execFn }),
      createLoopChecker(config),
      createPipelineState(config),
      createGenerateSummary(config),
      createValidateSummary(config),
      createPipelineHandoff(config),
    ];
    for (const t of tools) {
      // TSDoc: parameters cast — internal JSON Schema passed to TypeBox TSchema slot.
      // Runtime: pi-ai validation.js has non-TypeBox fallback path for plain JSON Schema.
      pi.registerTool({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: t.parameters as never,
        execute: async (_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) => {
          const rctx = buildRuntimeCtx(pi, ctx, undefined, config);
          const result = await t.execute(params, rctx);
          return {
            content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }],
            details: result,
          };
        },
      });
    }

    // ── Conditional tool: pipeline_verify (only if any stage uses mode: "tool") ──
    const hasToolModeStage = Object.values(config.stages).some(
      (sc) => sc.verify?.mode === "tool",
    );
    if (hasToolModeStage) {
      const verifyTool = createPipelineVerify(config, { execFn });
      pi.registerTool({
        name: verifyTool.name,
        label: verifyTool.name,
        description: verifyTool.description,
        parameters: verifyTool.parameters as never,
        execute: async (_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) => {
          const rctx = buildRuntimeCtx(pi, ctx, undefined, config);
          const result = await verifyTool.execute(params, rctx);
          return {
            content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }],
            details: result,
          };
        },
      });
    }

    // ── Commands registration (bridge: SDK registerCommand(name, { handler }) → internal Command) ──
    const commands = [
      createPipelineStatusCommand(config),
      createPipelineStartCommand(config),
      createPipelineInitCommand(config),
      createPipelineQuitCommand(config),
      createPipelineResumeCommand(config),
    ];
    for (const cmd of commands) {
      pi.registerCommand(cmd.name, {
        description: cmd.description,
        handler: async (args: string, ctx: ExtensionContext) => {
          const rctx = buildRuntimeCtx(pi, ctx, undefined, config);
          const parsed = parseCommandArgs(cmd.name, args);
          const result = await cmd.execute(parsed, rctx);
          if (result && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (r.error) ctx.ui.notify(String(r.error), "error");
            else if (r.message) ctx.ui.notify(String(r.message));
            else if (r.content) ctx.ui.notify(String(r.content));
          }
        },
      });
    }


  };
}

/**
 * Loads a pipeline_loop.json file and returns a fully-resolved PipelineConfig
 * with staleness-tracking fields (configSourcePath / configLoadedMtimeMs)
 * injected. Exported for testability — createPipelineFromJson delegates here.
 *
 * Fail-open on IO errors: if stat fails, the config is returned without the
 * staleness fields (isConfigStale will then return false).
 *
 * @param jsonPath - Path to the pipeline_loop.json file
 * @returns PipelineConfig with injected staleness fields
 */
export function loadPipelineConfigFromJson(jsonPath: string): PipelineConfig {
  const json = loadJsonConfig(jsonPath);
  const config = resolvePipelineConfig(json);

  // Phase 3 / 175: inject config-source tracking fields so that isConfigStale()
  // can detect mtime changes after load. Fail-open on IO errors (no injection).
  try {
    const absPath = pathMod.isAbsolute(jsonPath)
      ? jsonPath
      : pathMod.resolve(process.cwd(), jsonPath);
    const stat = fsSync.statSync(absPath);
    config.configSourcePath = absPath;
    config.configLoadedMtimeMs = stat.mtimeMs;
  } catch {
    // IO failure (file missing, permissions) → fail-open: staleness detection disabled
  }

  return config;
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
  const config = loadPipelineConfigFromJson(resolvedPath);
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
 * falls back to the bundled template in memory (zero disk writes) and
 * registers the full plugin — so that `/pipeline-init` remains usable
 * to materialise the configuration.
 *
 * Design invariants (184_Bug):
 * - The load path NEVER throws — all errors degrade to "Pipeline disabled"
 *   with an error-level log.
 * - Fallback registration sets `config.isFallbackTemplate = true` so
 *   audit-log init is skipped (zero disk writes) and restart hints fire.
 *
 * @param pi - The pi SDK ExtensionAPI instance
 */
export default async function initPipeline(pi: ExtensionAPI): Promise<void> {
  const defaultPath = `${CONFIG_DIR_NAME}/pipeline_loop.json`;

  try {
    // Fast path: config file exists on disk → standard registration
    if (fsSync.existsSync(defaultPath)) {
      const factory = createPipelineFromJson(defaultPath);
      await factory(pi);
      return;
    }

    // Fallback path: config file absent → resolve bundled template in memory.
    // Zero disk writes — no directory creation, no audit log init.
    const templateJsonPath = pathMod.join(TEMPLATE_DIR, "pipeline_loop.json");
    if (!fsSync.existsSync(templateJsonPath)) {
      // Template itself is missing — log error and disable (no throw).
      console.error(
        `[pi-pipeline] Bundled template not found at ${templateJsonPath}. Pipeline disabled.`,
      );
      console.warn(`[pi-pipeline] ${defaultPath} not found. Pipeline disabled.`);
      return;
    }

    const templateJson = loadJsonConfig(templateJsonPath);
    const config = resolvePipelineConfig(templateJson);
    config.isFallbackTemplate = true;
    // resolvePipelineConfig guarantees projectRoot (defaults to process.cwd())

    console.warn(
      `[pi-pipeline] ${defaultPath} not found — running on built-in template defaults. ` +
      `No configuration has been written to disk. ` +
      `Run /pipeline-init to materialise the config, then restart pi for file-based config to take effect.`,
    );

    const factory = createPipeline(config);
    await factory(pi);
  } catch (err) {
    // Catch-all: any unexpected error during bootstrap must NOT propagate.
    // Log at error level with context and degrade to disabled.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[pi-pipeline] Fatal error during pipeline bootstrap: ${errMsg}. Pipeline disabled.`,
    );
    console.warn(`[pi-pipeline] ${defaultPath} not found. Pipeline disabled.`);
  }
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
  ConfirmMode,
  ConfirmConfig,
  ConfirmJsonConfig,
  StageJsonConfig,
  PipelineJsonConfig,
  VerifyFailureItem,
  VerifyResultSnapshot,
  ExecFn,
  FlowState,
  StartStageMode,
} from "./types";
