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
import { writeAuditLog, safeWriteAuditLog, setAuditPipelineContext } from "../utils/auditLog";
import { createPipelineUI, syncStageStatusBar } from "./pipeline-ui";
import { isFrozen, getFlowState, markPipelineAborted, formatFrozenReason, isTerminalCompleted, formatDecisionMenuHint, inferResumeStage, ensureDecisionMenu } from "./flow-state";
// 210 Phase 2: re-arm the stage clocks when a running pipeline survives a reload.
import { armStageWatchdog } from "./stage-watchdog";
import { loadPromptConfig } from "./prompt-config";
import { registerSession, lookupParentPipeline } from "../utils/session-registry";
import { parseRequirementDocPath } from "../utils/doc-path";
import { parsePipelineIdMarker } from "../utils/pipeline-id-marker";
import { extractFirstUserMessageText } from "./session-state";
import { execSync } from "node:child_process";
import { checkTemplateDrift, formatDriftNotification } from "../utils/template-drift";
import { resolvePiWorkDir, resolveAuditDir } from "../utils/work-dir";
import { detectSessionRole } from "./session-role";
import { formatAbortedNotifyText } from "./flow-state";
import { staleConfigNotice } from "../utils/config-staleness";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { AUDIT_THROTTLE_WINDOW_MS } from "../constants";
import { probeAgentState } from "../utils/subagents-introspect";
import { maybeNotifySubagentsMentionMode } from "../utils/subagents-config-probe";
// Phase 0 (182): dispatch stage executor after choose_stage from frozen replay
import { dispatchAfterResume } from "../commands/pipeline-start";
// Phase 4 (191): design-review recovery on session start/reload
import { coordinateDesignReview, type CoordinatorResult } from "./design-review/coordinator";
import { classifyDesignReviewFlow } from "./design-review/state";
// 193 Phase 3 (tasks 1/3): shared safe builder + single honest consumer at startup
import { createDesignReviewRuntimeContext } from "./design-review/runtime-context";
import { consumeDesignReviewResult, type DesignReviewConsumeCtx } from "./design-review/entry-result";
// 194 Phase 3 (C3, task 2): child-side executor binding record after JOIN
import { recordChildBindingFromRuntimeEvidence } from "./stage-executor/runtime-binding";

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
 * 194 Phase 3 (C3, task 2): best-effort child-side executor binding record
 * after a successful JOIN. The JOIN copies the owner's meta — including any
 * CURRENT `stageExecutorRun` — but the child's identity must be proven from
 * its OWN runtime evidence (parentSession header + own session file against
 * the registry-folded binding) before anything is recorded into the child's
 * entries. Every no-evidence case stays silent-by-design (ordinary children
 * never have a run); exceptions never block session start.
 */
function recordChildExecutorBinding(ctx: RuntimeCtx, parentSession: string, sessionFile: string): void {
  try {
    const meta = ctx.session.getMeta();
    const run = meta?.stageExecutorRun;
    if (!run) return; // no closed-loop run inherited — nothing to record
    const pi = (ctx as { pi?: { appendEntry?: (customType: string, data: unknown) => void } }).pi;
    if (!pi || typeof pi.appendEntry !== "function") return;
    const sm = ((ctx._ctx as unknown) as Record<string, unknown> | undefined)?.sessionManager as
      | { getEntries?: () => readonly unknown[] }
      | undefined;
    const entries = (sm?.getEntries?.() ?? []) as Parameters<typeof recordChildBindingFromRuntimeEvidence>[0]["entries"];
    const res = recordChildBindingFromRuntimeEvidence({
      writer: { appendEntry: pi.appendEntry.bind(pi) },
      entries,
      parentSession,
      ownSessionFile: sessionFile,
      currentRun: run,
    });
    void safeWriteAuditLog("executor_child_binding", {
      action: res.recorded ? "recorded" : "skipped",
      reason: res.reason ?? "ok",
      pipelineId: meta?.pipelineId,
      stage: run.binding.stage,
      runId: run.binding.runId,
    }, res.recorded ? undefined : "warn");
  } catch {
    // Identity recording is auxiliary at startup: the runtime guard already
    // fails closed for unproven children — never block session start here.
  }
}

/**
 * 204 Phase 0: cascading JOIN identity evidence resolution.
 *
 * L1 (`parent_session`) wins and stops — the first-message marker is never read
 * on a hit, so a stale marker can never override the runtime parent relation.
 * L2 (`first_message`) requires BOTH a strictly validated `Pipeline: {id}` marker
 * and a readable target `meta.json` (the marker is used as a path component).
 * L3 (`null`) leaves the session dormant, exactly as before.
 */
async function resolveJoinTarget(
  config: PipelineConfig,
  ctx: RuntimeCtx,
  parentSession: string,
): Promise<{ pipelineId: string; via: "parent_session" | "first_message" } | null> {
  // L1: runtime parent session → registry
  const fromRegistry = await lookupParentPipeline(config, parentSession);
  if (fromRegistry) return { pipelineId: fromRegistry, via: "parent_session" };

  // L2: first user message marker, gated on a readable meta.json
  const markerId = parsePipelineIdMarker(
    extractFirstUserMessageText(ctx._ctx as Parameters<typeof extractFirstUserMessageText>[0]),
  );
  if (markerId) {
    const metaPath = path.resolve(config.projectRoot, resolveAuditDir(config), markerId, "meta.json");
    try {
      await fs.readFile(metaPath, "utf-8");
      return { pipelineId: markerId, via: "first_message" };
    } catch {
      // Unreadable marker target — fall through to L3.
    }
  }

  return null;
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
  const joinTarget = await resolveJoinTarget(config, ctx, parentSession);
  if (!joinTarget) {
    // L3 `no_evidence` — degrade to dormant with warn
    const markerPipelineId = parsePipelineIdMarker(
      extractFirstUserMessageText(ctx._ctx as Parameters<typeof extractFirstUserMessageText>[0]),
    );
    await safeWriteAuditLog(
      "session_join_missing_registry",
      { reason: "no_evidence", parentSession, sessionFile, ...(markerPipelineId ? { markerPipelineId } : {}) },
      "warn",
    );
    return false;
  }
  const parentPipelineId = joinTarget.pipelineId;

  // Read parent pipeline meta.json
  const auditDir = resolveAuditDir(config);
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
  //
  // 193 Phase 2: this whole-object write runs under the SAME exclusive commit
  // lock. If the owner advanced the shared state between our read and our
  // write (e.g. a dispatch receipt or a human decision landed), the plain
  // writer REJECTS this stale overwrite — re-read the parent meta.json once
  // and echo the FRESH snapshot; a second rejection is audited honestly.
  if (ctx.session.updateMeta({ ...parentMeta }) === undefined) {
    let recovered = false;
    try {
      const raw2 = await fs.readFile(parentMetaPath, "utf-8");
      const fresh = JSON.parse(raw2) as SessionMeta;
      if (fresh && fresh.pipelineId === parentPipelineId) {
        recovered = ctx.session.updateMeta({ ...fresh }) !== undefined;
      }
    } catch {
      // Fall through to the honest audit below.
    }
    if (!recovered) {
      await safeWriteAuditLog("session_join_meta_rejected", {
        parentPipelineId,
        parentMetaPath,
        sessionFile,
      }, "warn");
    }
  }

  // Register this session too (supports nested subagents)
  await registerSession(config, sessionFile, parentPipelineId);

  // Phase 1 (197): bind audit routing to inherited parent pipelineId.
  // No directory pre-creation needed — the parent already created it.
  setAuditPipelineContext(parentPipelineId);

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
    // 204 Phase 0: how identity was proven + whether the child session is persisted.
    via: joinTarget.via,
    persisted: sessionFile !== "",
  });

  // 194 Phase 0 (C3): a JOIN inherits the parent's meta SNAPSHOT, including
  // the latest closed-loop executor run. That record describes the OWNER's
  // dispatch — it is NEVER this child's own executor identity, so it must not
  // refresh or replace the binding this session recorded for itself
  // (stage-executor/runtime-binding.ts reads the child's OWN entries only).
  // Observability only: no behaviour or RPC count changes when inactive.
  if (parentMeta.stageExecutorRun) {
    await safeWriteAuditLog("session_join_executor_snapshot_untrusted", {
      sessionFile,
      pipelineId: parentPipelineId,
      stage: parentMeta.currentStage,
      runId: parentMeta.stageExecutorRun.binding.runId,
      agentId: parentMeta.stageExecutorRun.binding.agentId,
      runStage: parentMeta.stageExecutorRun.binding.stage,
      spawnTrigger,
    });
  }

  // Phase 4 / 180 (Q3B): out-of-band duplicate-spawn observability.
  // A JOIN driven by manual @mention / external tool (spawnTrigger =
  // "manual_or_external") while the current stage already has a live spawn record
  // is a duplicate-spawn suspect. Audit every hit; notify is throttled and
  // strictly non-blocking. `probeAgentState` fail-opens internally, so
  // "settled"/"unknown" intentionally emits nothing (avoids false positives on
  // ordinary manual @mentions).
  if (spawnTrigger === "manual_or_external") {
    const existingSpawn = parentMeta.activeSpawns?.[parentMeta.currentStage];
    if (existingSpawn) {
      const existingAgentId = existingSpawn.agentId ?? existingSpawn.agentName;
      const probe = probeAgentState(existingSpawn.agentId ?? existingSpawn.agentName);
      if (probe === "live") {
        await safeWriteAuditLog("duplicate_spawn_suspect", {
          pipelineId: parentPipelineId,
          stage: parentMeta.currentStage,
          existingAgentId,
          joiningSessionFile: sessionFile,
        });
        if (
          shouldEmitWithinWindow(
            `duplicate_spawn_suspect:${parentPipelineId}:${parentMeta.currentStage}`,
            AUDIT_THROTTLE_WINDOW_MS,
          )
        ) {
          ui.notify(
            ctx,
            `Duplicate spawn suspect: stage "${parentMeta.currentStage}" already has a live agent ` +
              `"${existingSpawn.agentName}"${existingSpawn.agentId ? ` (${existingSpawn.agentId})` : ""}. ` +
              `The joining session is allowed to continue (non-blocking). ` +
              `Plugin auto-dispatch will now defer while a same-name agent is live.`,
          );
        }
      }
    }
  }

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
          const drifts = await checkTemplateDrift(projectRoot, resolvePiWorkDir(config));
          for (const d of drifts) {
            await safeWriteAuditLog("template_drift", {
              asset: d.asset,
              deployedHash: d.deployedHash.substring(0, 12),
              repoHash: d.repoHash.substring(0, 12),
            }, "warn");
          }
          // Phase 5 / 175 (R1Q2A): notify user when ANY assets have drifted.
          // Single notification with total count + top 3 asset names + /pipeline-init guidance.
          // guide.md drift is included in the same message (no separate notify).
          const driftNotice = formatDriftNotification(drifts);
          if (driftNotice) {
            ui.notify(ctx, driftNotice);
          }
        } catch (err) {
          // Fail-open: drift check must never block session start
          const errMsg = err instanceof Error ? err.message : String(err);
          await safeWriteAuditLog("template_drift_error", { error: errMsg }, "warn");
        }
      }

      // Phase 1 / 179 (G2 layer ④): surface the agentMentions:"model" deployment
      // mode (a known @mention rewrite cause). Owner-only, throttled, read-only.
      if (!detectSessionRole(ctx).isChild) {
        await maybeNotifySubagentsMentionMode(config, {
          notify: (msg: string) => ui.notify(ctx, msg),
        });
      }

      // Preload prompt-config cache (failure silently returns {} — never blocks session start)
      await loadPromptConfig(projectRoot);

      if (!meta?.currentStage) {
        // ── Subagent/fork JOIN detection (Q7) ──────────────────────────
        const { parentSession, isSubagent } = detectSubagentSession(ctx);
        // 204 Phase 0: the JOIN entry is reachable for EVERY subagent signal —
        // a missing `parentSession` is no longer a dead end (resolveJoinTarget
        // falls back to the first-message marker evidence).
        if (isSubagent) {
          const sm = ((ctx._ctx as unknown) as Record<string, unknown>)?.sessionManager as
            | { getSessionFile?: () => string } | undefined;
          const sessionFile = sm?.getSessionFile?.() ?? "";
          const joined = await handleSubagentJoin(config, ctx, ui, parentSession ?? "", sessionFile);
          if (joined) {
            // 194 Phase 3 (C3, task 2): the JOINED child records its OWN
            // executor binding from runtime evidence — meta is inherited,
            // identity is NOT. A run bound to this child's session file gets
            // a local `pi-pipeline:executor-binding` entry (idempotent);
            // anything unprovable records nothing (overlay stays inert).
            // 204 Phase 0: L2 (`first_message`) has no runtime parent session, so
            // there is no child identity to prove — the overlay stays inert.
            if (parentSession) {
              recordChildExecutorBinding(ctx, parentSession, sessionFile);
            }
            return; // JOIN succeeded — child inherits parent pipeline
          }
          // JOIN failed (L3 no_evidence / meta read fail) — fall through to dormant
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
        // Phase 1 (197): bind audit routing to existing pipelineId on recovery entry.
        // Ensures writeAuditLog calls route to the correct pipeline directory.
        setAuditPipelineContext(meta.pipelineId);
        
        const reason = (ctx.event as Record<string, unknown> | undefined)?.reason;
        const flowState = getFlowState(meta);
        const { isChild } = detectSessionRole(ctx);

        // Phase 3 / 175 (R2Q6A): stale config check — notify once on owner session_start.
        if (!isChild) {
          const staleNotice = staleConfigNotice(config);
          if (staleNotice) {
            ui.notify(ctx, staleNotice);
          }
        }

        // Phase 4 (191): design-review recovery on session start/reload.
        // 193 Phase 3 (task 3): startup delegates through the shared safe
        // builder with provenance "startup" — it NEVER re-presents a decision
        // menu (only an explicit resume does), verifies a running report as
        // before, consumes a obtained `verify_failed` through the shared
        // tool-method consumer (ONE budget attempt, no automatic wake, the
        // corrective template is shown proactively) and then RETURNS; a
        // decision-pending/drift pause is read-only early-return so the
        // stale_startup abort below can never clobber a human-owned state.
        const drStartup = classifyDesignReviewFlow(meta);
        if (drStartup.kind === "blocked") {
          // Feature present but identity invalid → owner takeover pending.
          // Startup neither resumes ordinary logic nor aborts a domain run.
          await writeAuditLog("design_review_blocked_takeover", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
            reason: drStartup.reason ?? "identity_incomplete",
            trigger: "session_start",
          }, "warn");
          ui.notify(ctx, `Design-review loop identity incomplete — awaiting owner takeover (run /pipeline-resume).`);
          return;
        }
        if (drStartup.kind === "authorized") {
          const coordCtx = createDesignReviewRuntimeContext({
            config,
            session: ctx.session,
            interactionSource: "startup",
            roleCtx: ctx,
            rawUi: (ctx as any).ui,
            pipelineUi: ui,
            pipelineUiCtx: ctx,
            pi: (ctx as any).pi,
          });
          const coordResult: CoordinatorResult = await coordinateDesignReview(coordCtx, meta, "settle");
          if (coordResult.status === "handled") {
            syncStageStatusBar(ui, ctx);
            if (coordResult.action === "advanced" || coordResult.action === "routed") {
              ui.notify(ctx, `Design-review recovered on session start: ${coordResult.action} to "${coordResult.toStage}".`);
              return;
            }
            if (coordResult.action === "verify_failed") {
              // ONE shared honest consumption (entry "command" = tool method:
              // never wakes the model; guidance shown proactively). Then an
              // IMMEDIATE return — never stale_startup abort / ordinary
              // recovery on a domain-consumed failure.
              const freshMeta = (ctx.session.getMeta() as SessionMeta | undefined) ?? meta;
              const outcome = await consumeDesignReviewResult({
                result: coordResult,
                meta: freshMeta,
                entry: "command",
                ctx: {
                  session: ctx.session,
                  ui: (ctx as any).ui,
                  pi: (ctx as any).pi,
                  _ctx: (ctx as any)._ctx,
                  config,
                } as DesignReviewConsumeCtx,
                config,
                ui,
                runtimeCtx: ctx,
              });
              if (outcome.message) {
                ui.notify(ctx, outcome.message);
              }
              return;
            }
            if (coordResult.action === "pending") {
              ui.notify(ctx, `Design-review recovery: ${coordResult.reason}`);
              const pausedDr = ((ctx.session.getMeta() as SessionMeta | undefined) ?? meta).designReview;
              if (pausedDr && pausedDr.phase === "paused") {
                // Read-only pause (decision pending / drift park): no verify,
                // no menu, and the stale_startup abort below MUST NOT fire.
                return;
              }
              // Other pending reasons keep the historical continue semantics.
            } else if (coordResult.action === "frozen") {
              // Notify but continue to other recovery logic (frozen states are
              // not "running", so the stale_startup gate below cannot abort them).
              ui.notify(ctx, `Design-review recovery: ${coordResult.reason}`);
            } else {
              // Fail-closed honesty: a handled-but-unrecognized action must
              // never fall through to ordinary startup recovery (the union is
              // exhaustive — defensive branch for future actions).
              ui.notify(ctx, "Design-review recovery: unrecognized handled action.");
              return;
            }
          }
          // If not-applicable, continue with normal session-start logic
        }

        // Phase 3 (173) 🔴-2 + Phase 4 / 175 (R3Q2A/R2Q1A): stale_startup gate.
        // Owner-only: child sessions do NOT trigger stale_startup abort (G1 fix).
        // For child + running: emit stale_suspect audit (throttled) instead.
        // trigger.isSubagent reflects actual detection (replaces hardcoded false).
        if (reason === "startup" && flowState === "running" && !isFrozen(meta) && !isTerminalCompleted(meta)) {
          if (!isChild) {
            // Owner session: running zombie after crash/SIGKILL → stale_startup abort
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
          } else {
            // Child session: running → stale_suspect audit (throttled, no abort)
            const { sessionFile } = detectSessionRole(ctx);
            const throttleKey = `stale_suspect:${sessionFile ?? "unknown"}`;
            if (shouldEmitWithinWindow(throttleKey, AUDIT_THROTTLE_WINDOW_MS)) {
              await safeWriteAuditLog("stale_suspect", {
                pipelineId: meta.pipelineId,
                stage: meta.currentStage,
                sessionFile: sessionFile ?? "unknown",
                isSubagent: "true",
                eventReason: "startup",
              });
            }
          }
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
                `Resuming from "${inferred}" by inference${basisSuffix}. ${formatDecisionMenuHint()}`
              );
            }
            // Phase 0 (182): inject onStageChanged for choose_stage dispatch.
            // Extracted to a variable so ensureDecisionMenu and the scheduler's
            // backoff retries share the same callback.
            const onStageChangedForReplay = async (fresh: SessionMeta): Promise<void> => {
              const doc = fresh.requirementDoc ?? "";
              await dispatchAfterResume(
                { session: ctx.session, ui, pi: (ctx as any).pi, _ctx: ctx._ctx } as Parameters<typeof dispatchAfterResume>[0],
                config,
                ui,
                fresh,
                doc,
              );
            };
            // 208 Phase 2: single scheduler entry — same semantics as settle;
            // interrupted re-prompting is owned by ensureDecisionMenu.
            await ensureDecisionMenu(
              { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx },
              meta,
              config,
              // Phase 3 (173) C8: plan §3.1 dictates source="replay" for all replay reasons
              // (including startup); "startup" is not in the plan §3.3-④ source vocabulary.
              {
                source: "replay",
                onStageChanged: onStageChangedForReplay,
              },
            );
          }
          // Child sessions: frozen state is visible via registry; owner handles presentation.
        } else if (flowState === "aborted") {
          // Aborted → notify with /pipeline-start hint (existing behavior)
          ui.notify(ctx, formatAbortedNotifyText(
            meta.currentStage,
            meta.terminateReason ?? "session_quit",
            meta.requirementDoc,
          ));
        } else if (
          !isChild &&
          (reason === "reload" || reason === "resume") &&
          flowState === "running" &&
          !isFrozen(meta) &&
          !isTerminalCompleted(meta)
        ) {
          // Goal 1 (180): owner session reloaded/resumed a running (non-frozen)
          // pipeline. The session-level status bar is ephemeral and is lost on
          // reload, so restore it here — no other recovery path re-renders it.
          // Explicitly excludes reason === "startup" (stale_startup abort path)
          // and the frozen-replay / aborted branches above (regression boundary).
          syncStageStatusBar(ui, ctx);
          // 210 Phase 2: the clocks died with the previous process, and a silent
          // child hang produces NO settle to re-arm them — so this recovery path
          // re-arms against the PERSISTED `stageStartTime` (wall clock keeps the
          // remaining ceiling, idle starts from now). No-op when disabled.
          armStageWatchdog(ctx, config);
        }
      }
    },
  };
}
