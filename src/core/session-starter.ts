/**
 * @module session-starter
 * Factory for the `session_start` hook.
 * Initializes pipeline metadata on first session start,
 * or restores session state (model) on resume.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import { writeAuditLog, safeWriteAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "./pipeline-ui";
import { isFrozen, getFlowState, markPipelineAborted, formatFrozenReason, isTerminalCompleted, formatDecisionMenuHint, inferResumeStage, promptDecisionMenu, scheduleDecisionRetry } from "./flow-state";
import { loadPromptConfig } from "./prompt-config";
import { registerSession, lookupParentPipeline } from "../utils/session-registry";
import { parseRequirementDocPath } from "../utils/doc-path";
import { extractFirstUserMessageText } from "./session-state";
import { execSync } from "node:child_process";
import { checkTemplateDrift } from "../utils/template-drift";
import { detectSessionRole } from "./session-role";
import { formatAbortedNotifyText } from "./flow-state";

// ─── Template drift one-shot check (Phase 6 / 170) ────────────────────────────

/**
 * Module-level flag ensuring the drift check runs at most once per process.
 * The check fires on the first session_start and never again.
 */
let _driftCheckDone = false;

/**
 * Test-only reset hook for the drift-check flag.
 */
export function __resetDriftCheckFlag(): void {
  _driftCheckDone = false;
}

// ─── Plugin version stamp (Phase 5 / 170) ─────────────────────────────────────

/**
 * Lazily resolved plugin version string: `{packageVersion}+{shortGitHash}`.
 * Cached at module level (process-scoped). Falls back to `"unknown"` on failure.
 */
let _pluginVersionStamp: string | null = null;

/**
 * Returns the plugin version stamp: `"{version}+{shortHash}"`.
 * Reads package.json version + git rev-parse --short HEAD.
 * Both values are cached after first resolution (process-scoped).
 * Fail-open: returns "unknown" on any error.
 *
 * Phase 0 (171): git execSync uses the package.json directory as cwd
 * so the hash always reflects the plugin repository, not the process CWD
 * (which may be a consumer/test project).
 */
function getPluginVersionStamp(): string {
  if (_pluginVersionStamp !== null) return _pluginVersionStamp;
  try {
    // Read version from package.json (relative to this compiled file)
    const pkgDir = path.resolve(__dirname, "..", "..");
    const pkgPath = path.join(pkgDir, "package.json");
    const pkgRaw = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf-8")) as { version?: string };
    const version = pkgRaw.version ?? "0.0.0";

    // Short git hash — cwd set to pkgDir so hash belongs to the plugin repo,
    // not the process CWD (which may be a consumer project).
    let shortHash = "unknown";
    try {
      shortHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8", timeout: 2000, cwd: pkgDir }).trim();
    } catch {
      // Not a git repo or git not available — use "unknown"
    }

    _pluginVersionStamp = `${version}+${shortHash}`;
  } catch {
    _pluginVersionStamp = "unknown";
  }
  return _pluginVersionStamp;
}

/**
 * Test-only reset for the plugin version stamp cache.
 * Allows tests to re-resolve the stamp after environment changes.
 */
export function __resetPluginVersionStamp(): void {
  _pluginVersionStamp = null;
}

/**
 * Detects subagent/fork session signals from the runtime context.
 *
 * Delegates to the shared detectSessionRole helper (Phase 1 / 171).
 * Returns the fields consumed by session-starter's JOIN detection logic.
 *
 * @param ctx - Runtime context with session manager access
 * @returns Object with parentSession file and detection flags
 */
function detectSubagentSession(ctx: RuntimeCtx): {
  parentSession: string | undefined;
  isSubagent: boolean;
  isFork: boolean;
} {
  const role = detectSessionRole(ctx);
  const isFork = (ctx.event as Record<string, unknown> | undefined)?.reason === "fork";
  return { parentSession: role.parentSession, isSubagent: role.isChild, isFork };
}

/**
 * Phase 5 (173) C15: Infer spawn trigger for subagent JOIN audit.
 *
 * @param parentMeta - Parent pipeline metadata
 * @param _parentPipelineId - Parent pipeline ID (for diagnostics)
 * @returns "pipeline_auto" if spawn record matches current stage within time window,
 *          "manual_or_external" otherwise
 */
function inferSpawnTrigger(parentMeta: SessionMeta, _parentPipelineId: string): "pipeline_auto" | "manual_or_external" {
  const currentStage = parentMeta.currentStage;
  const now = Date.now();
  const SPAWN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  // Check activeSpawns for current stage (has startedAt timestamp)
  const activeSpawn = parentMeta.activeSpawns?.[currentStage];
  if (activeSpawn && (now - activeSpawn.startedAt) <= SPAWN_WINDOW_MS) {
    return "pipeline_auto";
  }

  // Check spawnedStages for current stage (value is stageStartTime, not an object)
  // If the stage was spawned during the current visit (stageStartTime matches), it's auto
  const spawnedStageTime = parentMeta.spawnedStages?.[currentStage];
  if (spawnedStageTime !== undefined && spawnedStageTime === parentMeta.stageStartTime) {
    return "pipeline_auto";
  }

  // No matching spawn record → manual or external trigger
  return "manual_or_external";
}

/**
 * Handles JOIN: loads parent pipeline meta and merges into current session.
 * Returns true if JOIN succeeded, false if it fell through to missing-registry path.
 */
async function handleSubagentJoin(
  config: PipelineConfig,
  ctx: RuntimeCtx,
  ui: ReturnType<typeof createPipelineUI>,
  parentSession: string,
  sessionFile: string,
): Promise<boolean> {
  const parentPipelineId = await lookupParentPipeline(config, parentSession);
  if (!parentPipelineId) {
    // Registry miss — degrade to new pipeline with warn
    await safeWriteAuditLog(
      "session_join_missing_registry",
      { parentSession, sessionFile },
      "warn",
    );
    return false;
  }

  // Read parent pipeline meta.json
  const auditDir = config.auditDir || ".pi/audit";
  const parentMetaPath = path.resolve(config.projectRoot, auditDir, parentPipelineId, "meta.json");
  let parentMeta: SessionMeta;
  try {
    const raw = await fs.readFile(parentMetaPath, "utf-8");
    parentMeta = JSON.parse(raw) as SessionMeta;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog(
      "session_join_meta_read_fail",
      { parentPipelineId, parentMetaPath, error: errMsg },
      "warn",
    );
    return false;
  }

  // Merge parent meta into current session
  // pipelineId/currentStage/stageStartTime inherit from parent (not reset)
  ctx.session.updateMeta({ ...parentMeta });

  // Register this session too (supports nested subagents)
  await registerSession(config, sessionFile, parentPipelineId);

  // Audit JOIN event (Phase 0/171: enriched with flowState for zombie-resurrection traceability)
  // Phase 5 (173) C15: spawnTrigger field — how was this subagent spawned?
  // - "pipeline_auto": plugin auto-spawned via stage executor (activeSpawns/spawnedStages match)
  // - "manual_or_external": user @mention or external tool (no matching spawn record)
  // Limitation: fallback sendUserMessage @mention is indistinguishable from user typing,
  // so time-window association is used (registeredAt - startedAt ≤ 5min → auto).
  const spawnTrigger = inferSpawnTrigger(parentMeta, parentPipelineId);
  await safeWriteAuditLog("session_join_parent", {
    sessionFile,
    pipelineId: parentPipelineId,
    stage: parentMeta.currentStage,
    flowState: getFlowState(parentMeta),
    spawnTrigger,
  });

  // Phase 0 (171): warn when JOIN target parent is already aborted.
  // Indicates a zombie subagent joining a dead pipeline — useful for post-mortem attribution.
  if (getFlowState(parentMeta) === "aborted") {
    await safeWriteAuditLog("session_join_aborted_parent", {
      sessionFile,
      pipelineId: parentPipelineId,
      stage: parentMeta.currentStage,
    }, "warn");
  }

  // Phase 1 (170): Auto-bind requirementDoc from the subagent's first user message
  // when the parent meta has no requirementDoc bound. This covers the @mention
  // start path where the user invokes the agent with a doc path but has not yet
  // run /pipeline-start explicitly.
  if (!parentMeta.requirementDoc) {
    try {
      const firstUserMsg = extractFirstUserMessageText(ctx._ctx as Parameters<typeof extractFirstUserMessageText>[0]);
      const parsedPath = parseRequirementDocPath(firstUserMsg, (candidates) => {
        // Ambiguous: audit all candidates for diagnostics
        safeWriteAuditLog("requirement_doc_ambiguous", {
          pipelineId: parentPipelineId,
          candidates: candidates.join(", "),
        }, "warn");
      });
      if (parsedPath) {
        ctx.session.updateMeta({ requirementDoc: parsedPath });
        await safeWriteAuditLog("requirement_doc_bound", {
          pipelineId: parentPipelineId,
          stage: parentMeta.currentStage,
          requirementDoc: parsedPath,
          source: "subagent_join",
        });
      } else {
        // Phase 0 (171): make bind-miss observable (was previously silent).
        // Indicates the first user message existed but contained no parseable doc path.
        const msgForMiss = extractFirstUserMessageText(ctx._ctx as Parameters<typeof extractFirstUserMessageText>[0]);
        if (msgForMiss && msgForMiss.trim().length > 0) {
          await safeWriteAuditLog("requirement_doc_bind_missed", {
            pipelineId: parentPipelineId,
            firstMsgChars: msgForMiss.substring(0, 80),
          }, "warn");
        }
      }
    } catch (err) {
      // Fail-open: auto-bind must never block JOIN
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("requirement_doc_bind_error", {
        pipelineId: parentPipelineId,
        error: errMsg,
      }, "warn");
    }
  }

  ui.stageEntry(ctx, parentMeta.currentStage);
  return true;
}

/**
 * Creates the `session_start` hook that initializes or resumes a pipeline session.
 *
 * On a new session (no `currentStage` in metadata):
 * - Generates a unique pipelineId
 * - Loads domain configuration from domain.md (or uses default)
 * - Initializes SessionMeta with stage "clarify" and default counters
 * - Sets the model for the clarify stage if configured
 *
 * On a resumed session (existing `currentStage`):
 * - Ensures the model matches the current stage's configuration
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "session_start" event
 */
export function createSessionStarter(config: PipelineConfig): Hook<"session_start"> {
  const ui = createPipelineUI(config);
  return {
    event: "session_start",
    handler: async (ctx: RuntimeCtx): Promise<void> => {
      const projectRoot = config.projectRoot;
      const meta = ctx.session.getMeta() as SessionMeta;

      // Phase 6 (170): One-shot template drift check per process.
      // Fires on the first session_start only. Fail-open: never blocks session start.
      if (!_driftCheckDone) {
        _driftCheckDone = true;
        try {
          const drifts = await checkTemplateDrift(projectRoot);
          for (const d of drifts) {
            await safeWriteAuditLog("template_drift", {
              asset: d.asset,
              deployedHash: d.deployedHash.substring(0, 12),
              repoHash: d.repoHash.substring(0, 12),
            }, "warn");
          }
          // Phase 5 (173) C14: notify user when guide.md has drifted
          if (drifts.some(d => d.asset === "guide.md")) {
            ui.notify(ctx, "guide.md is outdated — re-run /pipeline-init to overwrite.");
          }
        } catch (err) {
          // Fail-open: drift check must never block session start
          const errMsg = err instanceof Error ? err.message : String(err);
          await safeWriteAuditLog("template_drift_error", { error: errMsg }, "warn");
        }
      }

      // Preload prompt-config cache (failure silently returns {} — never blocks session start)
      await loadPromptConfig(projectRoot);

      if (!meta?.currentStage) {
        // ── Subagent/fork JOIN detection (Q7) ──────────────────────────
        const { parentSession, isSubagent } = detectSubagentSession(ctx);
        if (isSubagent && parentSession) {
          const sm = ((ctx._ctx as unknown) as Record<string, unknown>)?.sessionManager as
            | { getSessionFile?: () => string } | undefined;
          const sessionFile = sm?.getSessionFile?.() ?? "";
          const joined = await handleSubagentJoin(config, ctx, ui, parentSession, sessionFile);
          if (joined) return; // JOIN succeeded — child inherits parent pipeline
          // JOIN failed (registry miss / meta read fail) — fall through to dormant
        } else if (isSubagent && !parentSession) {
          // Only secondary/fork signal matched but no parentSession available for lookup.
          // Audit warn so the missing-registry path is observable (plan Phase 1).
          await safeWriteAuditLog(
            "session_join_missing_registry",
            { reason: "subagent_signal_without_parent_session" },
            "warn",
          );
        }

        // Phase 2b (173) C4: V1 auto-pipeline creation REMOVED.
        // New sessions without an existing pipeline are now DORMANT — the plugin
        // does not intervene until `/pipeline-start <doc>` is explicitly invoked.
        // - No pipelineId generated
        // - No registerSession call
        // - No session_start audit log for creation
        // - No ui.stageEntry call
        // The drift check (L287-305) and prompt-config preload (L307-308) above
        // still run — they are one-shot events with no meta dependency.
        // Wake-up entry: /pipeline-start (fresh/resume/adopt) only.
      } else {
        // ── Resumed session: stale startup recovery + frozen replay ────
        const reason = (ctx.event as Record<string, unknown> | undefined)?.reason;
        const flowState = getFlowState(meta);
        const { isChild } = detectSessionRole(ctx);

        // Phase 3 (173) 🔴-2: Narrow stale_startup to running-only.
        // Previously (171): any non-aborted non-completed → stale abort.
        // Now: only running僵尸 → stale. blocked/awaiting_human → replay menu.
        if (reason === "startup" && flowState === "running" && !isTerminalCompleted(meta)) {
          // Running zombie after crash/SIGKILL → stale_startup abort
          const { sessionFile } = detectSessionRole(ctx);
          await markPipelineAborted(ctx, "stale_startup", {
            trigger: {
              sessionFile: sessionFile || undefined,
              isSubagent: false,
              eventReason: "startup",
            },
            config,
          });

          await writeAuditLog("pipeline_stale_reset", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
          });
          // markPipelineAborted already emitted the correct notify (C16).
        } else if (isFrozen(meta) && flowState !== "aborted") {
          // ── Phase 3 (173) C8: Frozen menu replay ────────────────────
          // blocked/awaiting_human → replay decision menu on all recovery reasons
          // (startup, reload, resume, new). Owner-only (child gated by P1).
          // Direct await: consistent with agent-settled.ts:98 pattern (U4 conclusion).
          if (!isChild) {
            const inferenceResult = inferResumeStage(meta, config);
            const inferred = inferenceResult.stage;
            const inferenceBasis = inferenceResult.basis;
            if (inferred) {
              // Phase 3 (173) C8: append inference basis in parens per plan §3.1
              const basisSuffix = inferenceBasis ? ` (${inferenceBasis})` : "";
              ui.notify(ctx,
                `Pipeline frozen at "${meta.currentStage}" (${formatFrozenReason(meta)}). ` +
                `Resuming from "${inferred}" by inference${basisSuffix}. ${formatDecisionMenuHint(config)}`
              );
            }
            const replayOutcome = await promptDecisionMenu(
              { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx },
              meta,
              config,
              // Phase 3 (173) C8: plan §3.1 dictates source="replay" for all replay reasons
              // (including startup); "startup" is not in the plan §3.3-④ source vocabulary.
              { source: "replay" },
            );
            if (replayOutcome === "interrupted") {
              scheduleDecisionRetry(
                { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx },
                meta,
                config,
              );
            }
          }
          // Child sessions: frozen state is visible via registry; owner handles presentation.
        } else if (flowState === "aborted") {
          // Aborted → notify with /pipeline-start hint (existing behavior)
          ui.notify(ctx, formatAbortedNotifyText(
            meta.currentStage,
            meta.terminateReason ?? "session_quit",
            meta.requirementDoc,
          ));
        }
      }
    },
  };
}
