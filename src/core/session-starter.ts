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
import { isFrozen, getFlowState, markPipelineAborted, formatFrozenReason } from "./flow-state";
import { loadPromptConfig } from "./prompt-config";
import { registerSession, lookupParentPipeline } from "../utils/session-registry";

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
 * Signal detection:
 * - Primary: getHeader()?.parentSession exists (SDK-provided parent reference)
 * - Secondary: getSessionName() matches subagent pattern `^[a-z0-9-]+#[0-9a-f]{8}$`
 * - Fork: event.reason === "fork"
 *
 * @param ctx - Runtime context with session manager access
 * @returns Object with parentSession file and detection flags
 */
function detectSubagentSession(ctx: RuntimeCtx): {
  parentSession: string | undefined;
  isSubagent: boolean;
  isFork: boolean;
} {
  const sm = ((ctx._ctx as unknown) as Record<string, unknown>)?.sessionManager as
    | { getHeader?: () => Record<string, unknown> | undefined; getSessionName?: () => string; getSessionFile?: () => string }
    | undefined;

  const parentSession = (sm?.getHeader?.() as Record<string, unknown> | undefined)?.parentSession as string | undefined;
  const sessionName = sm?.getSessionName?.() ?? "";
  const isFork = (ctx.event as Record<string, unknown> | undefined)?.reason === "fork";

  // Subagent pattern: lowercase name + # + 8 hex chars (e.g., "code-review-agent#a1b2c3d4")
  const SUBAGENT_NAME_PATTERN = /^[a-z0-9-]+#[0-9a-f]{8}$/;
  const isSubagent = !!parentSession || SUBAGENT_NAME_PATTERN.test(sessionName) || isFork;

  return { parentSession, isSubagent, isFork };
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

  // Audit JOIN event
  await safeWriteAuditLog("session_join_parent", {
    sessionFile,
    pipelineId: parentPipelineId,
    stage: parentMeta.currentStage,
  });

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
        await writeAuditLog("session_start", {
          pipelineId,
          stage: "clarify",
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
        if (reason === "startup" && getFlowState(meta) !== "aborted") {
          await markPipelineAborted(ctx, "stale_startup");

          await writeAuditLog("pipeline_stale_reset", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
          });

          // After reset, flowState is "aborted" — isFrozen("aborted") === true but
          // the correct user action is /pipeline-start, NOT the decision shortcut.
          // Skip isFrozen/notify to avoid misleading "Pipeline blocked" message.
        } else if (isFrozen(meta)) {
          // ── Resumed session: notify if frozen ─────────────────────
          ui.notify(ctx, `Pipeline blocked: ${formatFrozenReason(meta)}. Open the decision menu to proceed.`);
        }
      }
    },
  };
}
