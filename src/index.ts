/**
 * @module index
 * Main entry point for @earendil-works/pi-pipeline.
 * Exports the `createPipeline` factory function and all public types.
 */

import type { PipelineConfig, ExtensionAPI, ExtensionFactory, ExecFn } from "./types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DECISION_SHORTCUT } from "./constants";
import { initAuditLog } from "./utils/auditLog";
import { buildRuntimeCtx } from "./core/runtime-ctx";
import { buildDecisionMenu, executeDecision, labelToDecision } from "./core/flow-state";
import type { PipelineDecision } from "./core/flow-state";
import { safeWriteAuditLog } from "./utils/auditLog";
import { parseCommandArgs } from "./utils/command-args";

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
 *     clarify: { agentFile: "./agents/clarify.md", skillPath: "design-und/SKILL.md", ... },
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
        const rctx = buildRuntimeCtx(pi, ctx, event as Record<string, unknown>);
        return h.handler(rctx);
      });
    }

    // ── Model selection recording (Q4-A: read-only observation) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pi.on as any)("model_select", async (event: any, ctx: ExtensionContext) => {
      const rctx = buildRuntimeCtx(pi, ctx);
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
          const rctx = buildRuntimeCtx(pi, ctx);
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
          const rctx = buildRuntimeCtx(pi, ctx);
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
    ];
    for (const cmd of commands) {
      pi.registerCommand(cmd.name, {
        description: cmd.description,
        handler: async (args: string, ctx: ExtensionContext) => {
          const rctx = buildRuntimeCtx(pi, ctx);
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

    // ── Shortcut registration: pipeline decision menu ──
    const shortcutKey = config.decisionShortcutKey ?? DEFAULT_DECISION_SHORTCUT;
    if (typeof pi.registerShortcut === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pi.registerShortcut as any)(shortcutKey, {
        description: "Pipeline decision menu",
        handler: async (ctx: ExtensionContext) => {
          const rctx = buildRuntimeCtx(pi, ctx);
          const meta = rctx.session.getMeta();
          if (!meta) return;

          const menu = buildDecisionMenu(meta);
          if (!menu) {
            ctx.ui.notify("Pipeline aborted. Use /pipeline-start to begin a new run.");
            return;
          }

          await safeWriteAuditLog("pipeline_shortcut_opened", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
          });

          if (typeof ctx.ui?.select === "function") {
            try {
              const selection = await ctx.ui.select(
                "Pipeline decision menu:",
                menu,
              );
              if (selection === undefined) {
                await safeWriteAuditLog("pipeline_decision_cancelled", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                });
                return;
              }

              // Map label back to decision key using shared helper
              const decision: PipelineDecision | undefined = labelToDecision(selection);
              if (decision) {
                // Re-read meta after UI delay to get fresh state
                const freshMeta = rctx.session.getMeta();
                if (freshMeta) {
                  await executeDecision(rctx, freshMeta, decision, config);
                }
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await safeWriteAuditLog("pipeline_shortcut_error", {
                pipelineId: meta.pipelineId,
                error: errMsg,
              }, "error");
            }
          }
        },
      });
    }
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
  FlowState,
} from "./types";
