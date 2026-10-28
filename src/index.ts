/**
 * @module index
 * Main entry point for @earendil-works/pi-pipeline.
 * Exports the `createPipeline` factory function and all public types.
 */

import type { PipelineConfig, ExtensionAPI, ExtensionFactory, ExecFn, AuditLogLevel } from "./types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, TEMPLATE_DIR } from "./constants";
import { initAuditLog } from "./utils/auditLog";
import { buildRuntimeCtx } from "./core/runtime-ctx";

import { parseCommandArgs } from "./utils/command-args";
// Phase 2 / 177 (D4): event-driven subagent availability latch
import { wireSubagentsReadyListener } from "./utils/subagent-availability";
import { wireSubagentLifecycleListeners, setOwnerMetaAccessor } from "./utils/subagent-lifecycle-registry";
import { registerOwnerWakeObserver, setOwnerWakeDeps } from "./core/owner-wake";
import { registerOwnerEscalationObserver, setOwnerEscalationDeps } from "./core/owner-escalation";
// 217 Phase 0 (T0.4): per-session delivery-handle registry + target-resolving
// delivery service (F1/F2 — wake the OWNER, not the last hook runner).
import { registerOwnerDelivery } from "./core/owner-delivery-registry";
import { deliverOwnerWake } from "./core/owner-delivery";
// 217 Phase 1 (T1.3): pending-spawn stall watchdog deps + enqueue-side hook.
import { setPendingSpawnStallDeps, armPendingSpawnStall } from "./core/pending-spawn-stall";
import { detectSessionRole } from "./core/session-role";
import { createPipelineUI, syncStageStatusBar } from "./core/pipeline-ui";
import { validateSubagentCreated, setOwnerSessionAccessor } from "./utils/subagent-identity";
// Phase 0 (189): DI handler for fix-executor completion (breaks circular dependency)
import { setFixExecutorCompletedHandler, setDesignReviewTerminalHandler, setPendingSpawnStallHook } from "./utils/subagent-rpc";
import { handleFixExecutorCompleted } from "./core/fix-executor-completion";
// 192 Phase 1: DI handler for design-review operation terminal evidence
import { handleDesignReviewOperationTerminal } from "./core/design-review/coordinator";


// Session lifecycle and prompt injection
import { createSessionStarter } from "./core/session-starter";
import { createPromptInjector } from "./core/prompt-injector";
// 210 Phase 7: message_end usage recorder.
import { createUsageRecorder } from "./core/usage-recorder";

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
import { createPipelineArchiveCommand } from "./commands/pipeline-archive";

// Agent settled and session shutdown lifecycle hooks
import { createAgentSettled } from "./core/agent-settled";
import { createSessionShutdown } from "./core/session-shutdown";
// 210 Phase 2: stage watchdog progress consumer wired into the leaf sink.
import { touchStageProgress } from "./core/stage-watchdog";
import { setStageProgressReporter } from "./utils/stage-progress-sink";

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

    // 210 Phase 2: wire the stage-progress sink (requirement 5.4 whitelist).
    // `utils/` modules report `spawn` and child-terminal `settle` events through
    // that leaf module because a runtime `utils → core` import is forbidden by
    // the static guard in subagent-rpc.test.ts (Phase 0 / 189). Registering the
    // consumer here (composition root) keeps `stage-watchdog` side-effect free;
    // the call is idempotent (same function pointer) and never fails.
    setStageProgressReporter(touchStageProgress);

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

    // Phase 0 / 200_Bug (G2-1, G2-2): subscribe to subagent lifecycle events
    // and maintain the in-memory registry for wake-up diagnostics.
    wireSubagentLifecycleListeners(pi);

    // Phase 1 / 200_Bug (G1-1, G1-2): register owner wake observer
    // When a subagent reaches terminal state, check if owner should be woken
    registerOwnerWakeObserver();

    // 203_Bug Phase 0 (RC1): the owner escalation observer is NOT registered
    // here. Owner and child sessions share this module in the same process, and
    // the role is only knowable from a runtime ctx — registering unconditionally
    // would subscribe the child too (duplicate wakes on a shared bus) and the
    // child's hook would overwrite the module-level deps. Registration is
    // deferred to the first OWNER hook invocation (see the hook bridge below).

    // Phase 0 (189): register fix-executor-completion handler via DI.
    // Breaks circular dependency: utils/subagent-rpc no longer imports core modules.
    setFixExecutorCompletedHandler(handleFixExecutorCompleted);

    // 192 Phase 1 (task 8): register the design-review operation-terminal
    // handler via the same DI precedent. The RPC lifecycle watcher records
    // completion evidence for the CURRENT operation only; the child never
    // advances stages itself — the owner settle chain re-verifies.
    setDesignReviewTerminalHandler(handleDesignReviewOperationTerminal);

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
    // 203_Bug Phase 0 (RC1): lazy, owner-scoped observer registration flag.
    // The first owner hook attaches the escalation observer; child sessions
    // never register it (role gate below).
    let ownerEscalationObserverAttached = false;
    const hooks = [
      createSessionStarter(config),
      // 210 Phase 0: execFn injected here (consumed by Phase 6 review change
      // evidence) — same wrapped pi.exec() the verifiers use.
      createPromptInjector(config, { execFn }),
      createToolGuard(config, { execFn }),
      createLoopBreaker(config),
      createAgentSettled(config, { execFn }),
      createSessionShutdown(config),
      // 210 Phase 7: per-stage model/token/cost aggregation from message_end
      // (R2 record-only; always-on, no config switch, no meta writes per message).
      createUsageRecorder(),
    ];
    for (const h of hooks) {
      // TSDoc: event type cast — internal Hook uses string event names,
      // SDK uses overloaded typed events. Cast needed for generic registration.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pi.on as any)(h.event, async (event: unknown, ctx: ExtensionContext) => {
        const rctx = buildRuntimeCtx(pi, ctx, event as Record<string, unknown>, config);

        // 203_Bug Phase 0 (RC1): owner/child role gate for escalation wiring.
        // Fail-open on detection errors (conservative: treat as owner).
        let isChildSession = false;
        try {
          isChildSession = detectSessionRole(rctx).isChild;
        } catch {
          isChildSession = false;
        }

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


        // Phase 0 / 200_Bug (G2-1): update the lifecycle registry meta accessor
        // so event handlers can read currentStage/pipelineId from the owner session.
        setOwnerMetaAccessor(() => rctx.session.getMeta());

        // Phase 1 / 200_Bug (G1-1, G1-2): update owner wake deps
        // so the observer can read session meta and send followUp messages.
        // 203_Bug Phase 0: the same wake/audit/status-bar channels are shared
        // with owner-escalation deps (same-source data, one set of callbacks).
        // 211 Phase 1: `wakeFollowUp` now REPORTS delivery (`true`/`false`) so
        // the escalation channel can fall back to a visible hint on failure;
        // OwnerWakeDeps keeps a `void` return type (still assignable).
        // 217 Phase 0 (T0.4): `rawFollowUp` is THIS session's raw send channel;
        // `wakeFollowUp` first tries the registry-resolved owner target and
        // falls back to this session's raw sender only when nothing resolves.
        const rawFollowUp = (summary: string): boolean => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const send = (pi as any).sendUserMessage as
            | ((msg: string, opts?: Record<string, unknown>) => unknown)
            | undefined;
          if (!send) {
            // 211 Phase 1: a missing delivery channel is also a FAILED wake —
            // observable, and callers learn they must fall back.
            const meta = rctx.session.getMeta();
            wakeAudit("owner_wake_escalation_failed", {
              pipelineId: meta?.pipelineId ?? "unknown",
              stage: meta?.currentStage ?? "unknown",
              error: "sendUserMessage unavailable",
            }, "warn");
            return false;
          }
          try {
            send(summary, { deliverAs: "followUp" });
            return true;
          } catch (err) {
            // Fail-safe: sendUserMessage errors must not crash the pipeline.
            // 208 (J5): wake failures stay observable via audit.
            const meta = rctx.session.getMeta();
            wakeAudit("owner_wake_escalation_failed", {
              pipelineId: meta?.pipelineId ?? "unknown",
              stage: meta?.currentStage ?? "unknown",
              error: err instanceof Error ? err.message : String(err),
            }, "warn");
            return false;
          }
        };
        // 217 Phase 0 (T0.4): registry-first routing — resolve the owner target
        // from run evidence (194 C3 binding → last non-child registration) and
        // only fall back to THIS session's raw sender when nothing resolves.
        const wakeFollowUp = (summary: string): boolean =>
          deliverOwnerWake(summary, rctx.session.getMeta(), () => rawFollowUp(summary)).delivered;
        // Review observation 1: optional audit level (default "info") keeps all
        // pre-211 event levels unchanged; `owner_wake_escalation_failed` is
        // written at "warn" so the guide event table stops drifting.
        const wakeAudit = (event: string, payload: Record<string, unknown>, level?: AuditLogLevel): void => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const auditLog = require("./utils/auditLog");
            auditLog.safeWriteAuditLog(event, payload, level);
          } catch {
            // Fail-safe: audit errors must not crash the pipeline
          }
        };
        const wakeSyncStatusBar = () => {
          try {
            syncStageStatusBar(createPipelineUI(config), rctx);
          } catch {
            // Fail-safe: UI errors must not crash the pipeline
          }
        };

        // 217 Phase 0 (T0.4, F1): every session registers its OWN delivery
        // handle. Re-registration on each hook invocation refreshes recency;
        // child sessions register too (their handle participates in
        // `run_binding` hits) but NEVER become fallback targets (`isChild`).
        registerOwnerDelivery({
          sessionFile: rctx.selfSessionFile ?? "",
          isChild: isChildSession,
          getMeta: () => rctx.session.getMeta(),
          sendFollowUp: rawFollowUp,
          notify: (message) => { try { rctx.ui.notify(message); } catch { /* fail-open */ } },
          audit: (event, payload) => wakeAudit(event, payload),
        });
        // 217 Phase 0 (F1): the wake WRITER side (module-level deps) is
        // owner-scoped now — same gate shape as the escalation deps below.
        // A child-bound deps snapshot would aim terminal delivery at the child
        // session and leave the owner unwoken (the 217 incident).
        if (!isChildSession) {
          setOwnerWakeDeps({
            getMeta: () => rctx.session.getMeta(),
            updateMeta: (patch) => rctx.session.updateMeta(patch),
            sendFollowUp: wakeFollowUp,
            // 217 F2: target-resolving delivery; preferred over raw sendFollowUp.
            deliver: (summary, meta) => deliverOwnerWake(summary, meta, () => rawFollowUp(summary)),
            // 217 Q8-A: one visible hint when delivery failed (throttled above).
            notifyHint: (stage) => { try { rctx.ui.notify(`${stage} confirmation is still pending. If no dialog appears, run /pipeline-resume.`); } catch { /* fail-open */ } },
            audit: wakeAudit,
            // Phase 2 / 200_Bug: fallback path - immediate status bar refresh at terminal event
            syncStatusBar: wakeSyncStatusBar,
          });
        }

        // 217 Phase 1 (T1.3, F3): pending-spawn stall watchdog assembly.
        // Deps are refreshed per hook invocation (`fire` re-reads them); the
        // enqueue-side hook is armed by BOTH roles because the child route
        // (`stage_spawn_routed_to_owner`) is where an unconsumed queue is born.
        // Delivery resolves through the registry (owner first, never the child).
        setPendingSpawnStallDeps({
          getMeta: () => rctx.session.getMeta(),
          getConfig: () => config,
          deliver: (summary, meta) => deliverOwnerWake(summary, meta, () => rawFollowUp(summary)),
          fallbackNotify: (_stage, message) => { try { rctx.ui.notify(message); } catch { /* fail-open */ } },
          audit: wakeAudit,
        });
        setPendingSpawnStallHook(
          (stage, requestedAt) =>
            armPendingSpawnStall(rctx.session.getMeta()?.pipelineId ?? "", stage, requestedAt),
        );

        // 203_Bug Phase 0 (RC1): owner escalation deps — refreshed per OWNER
        // hook invocation, same source data as owner-wake deps. Child hooks
        // must not install/overwrite them: the child shares this module, and a
        // child-bound deps snapshot would make its own broadcast self-wake
        // (writing owner_wake_escalation) while the owner stays unwoken.
        if (!isChildSession) {
          setOwnerEscalationDeps({
            getMeta: () => rctx.session.getMeta(),
            sendFollowUp: wakeFollowUp,
            syncStatusBar: wakeSyncStatusBar,
            audit: wakeAudit,
            // 211 Phase 1: actionable hint when the wake could not be delivered.
            notifyHint: (stage) => {
              try {
                rctx.ui.notify(`${stage} confirmation is still pending. If no dialog appears, run /pipeline-resume.`);
              } catch {
                // fail-open: hint errors must not crash the pipeline
              }
            },
            isOwner: true,
          });

          // Register the observer once, from the first owner hook where the
          // role is knowable. Cleanup is intentionally not wired: the plugin
          // factory has no dispose hook (same lifetime as the owner-wake
          // observer precedent).
          if (!ownerEscalationObserverAttached) {
            ownerEscalationObserverAttached = true;
            registerOwnerEscalationObserver(pi);
          }
        }
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
      // 206 Phase 4: archive command gets the wrapped execFn for system-zip DI
      createPipelineArchiveCommand(config, { execFn }),
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
