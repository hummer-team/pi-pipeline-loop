/**
 * @module session-starter
 * Factory for the `session_start` hook.
 * Initializes pipeline metadata on first session start,
 * or restores session state (model) on resume.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { PipelineConfig, Hook, SessionMeta, DomainConfig } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import { writeAuditLog, safeWriteAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "./pipeline-ui";
import { isFrozen, getFlowState, markPipelineAborted, formatFrozenReason, isTerminalCompleted } from "./flow-state";
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
 * Attempts to load a DomainConfig from a domain.md file.
 * Expects optional YAML-style frontmatter with `id` and `version` fields.
 * Falls back to the default general domain if the file is missing or unparseable.
 *
 * @param domainFilePath - Absolute path to the domain.md file
 * @returns Parsed DomainConfig or the default fallback
 */
async function loadDomainFromFile(domainFilePath: string): Promise<DomainConfig> {
  const defaultDomain: DomainConfig = { id: "general", version: "latest", skillPath: "" };

  try {
    const content = await fs.readFile(domainFilePath, "utf-8");

    // Attempt to parse YAML-style frontmatter (between --- delimiters)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const idMatch = frontmatter.match(/^id:\s*(.+)$/m);
      const versionMatch = frontmatter.match(/^version:\s*(.+)$/m);

      if (idMatch) {
        return {
          id: idMatch[1].trim(),
          version: versionMatch ? versionMatch[1].trim() : "latest",
          skillPath: domainFilePath,
        };
      }
    }

    // No frontmatter found — use filename as domain id
    const basename = path.basename(domainFilePath, ".md");
    return {
      id: basename,
      version: "latest",
      skillPath: domainFilePath,
    };
  } catch {
    // File doesn't exist or can't be read — use default
    return defaultDomain;
  }
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
  await safeWriteAuditLog("session_join_parent", {
    sessionFile,
    pipelineId: parentPipelineId,
    stage: parentMeta.currentStage,
    flowState: getFlowState(parentMeta),
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
          if (joined) return; // JOIN succeeded — skip new pipeline creation
          // JOIN failed (registry miss / meta read fail) — fall through to new pipeline
        } else if (isSubagent && !parentSession) {
          // Only secondary/fork signal matched but no parentSession available for lookup.
          // Audit warn so the missing-registry path is observable (plan Phase 1).
          await safeWriteAuditLog(
            "session_join_missing_registry",
            { reason: "subagent_signal_without_parent_session" },
            "warn",
          );
        }

        // ── New pipeline: initialize metadata ──────────────────────────
        const pipelineId = `pipe-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

        // Load domain configuration
        const domainDir = config.domainDir || ".pi/domains";
        const domainFilePath = path.join(projectRoot, domainDir, "domain.md");
        const domain = await loadDomainFromFile(domainFilePath);

        const sessionMeta: SessionMeta = {
          currentStage: "clarify",
          stageStartTime: Date.now(),
          pipelineId,
          domain,
          summaries: {},
          loopCount: 0,
          currentStepIndex: 0,
          maxLoops: config.maxLoops || 3,
          flowState: "running",
          stageVisitOrder: ["clarify"],
          terminalCompact: undefined,
          // Phase 1 (169) P2-8 fix: explicitly clear spawnedStages so the new pipeline's
          // idempotency guard starts fresh (no residue from a prior run on the same session).
          spawnedStages: undefined,
        };

        ctx.session.updateMeta(sessionMeta);

        // Register session → pipeline mapping (fail-open)
        const sm = ((ctx._ctx as unknown) as Record<string, unknown>)?.sessionManager as
          | { getSessionFile?: () => string } | undefined;
        const sessionFile = sm?.getSessionFile?.() ?? "";
        if (sessionFile) {
          await registerSession(config, sessionFile, pipelineId);
        }

        // Write session_start audit log
        // Phase 5 (170): attach plugin version stamp for deployment traceability
        // Phase 0 (171): attach sessionFile for session identity traceability
        await writeAuditLog("session_start", {
          pipelineId,
          stage: "clarify",
          pluginVersion: getPluginVersionStamp(),
          ...(sessionFile ? { sessionFile } : {}),
        });

        // NOTE: model management removed (Q4-A) — model is managed by user via /model command.
        // Phase 3 will add model_select event hook for read-only recording.

        ui.stageEntry(ctx, "clarify");
      } else {
        // ── Resumed session: stale startup recovery ───────────────────
        // On process startup (reason="startup"), if flowState is not already "aborted",
        // reset to aborted — covers SIGKILL / crash / terminal force-kill paths where
        // session_shutdown never fires.
        const reason = (ctx.event as Record<string, unknown> | undefined)?.reason;
        if (reason === "startup" && getFlowState(meta) !== "aborted" && !isTerminalCompleted(meta)) {
          // Phase 1 (171) C16: pass trigger + config for enriched audit + notify.
          // Intentional revision of 170 Phase 3 "silent after reset" decision:
          // The stale_startup abort now emits a correct aborted notify (not misleading blocked).
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
          // No additional notify needed here.
        } else if (isFrozen(meta)) {
          // ── Resumed session: notify if frozen ─────────────────────
          // Phase 3 (170) ④: distinct text for aborted (exit: /pipeline-start) vs
          // blocked (exit: decision menu). Resume reason gets one-shot notify.
          const flowState = getFlowState(meta);
          if (flowState === "aborted") {
            const docHint = meta.requirementDoc ?? "<requirement-doc>";
            ui.notify(ctx, `Pipeline aborted. Run /pipeline-start ${docHint} to resume or restart.`);
          } else {
            ui.notify(ctx, `Pipeline blocked: ${formatFrozenReason(meta)}. Open the decision menu to proceed.`);
          }
        }
      }
    },
  };
}
