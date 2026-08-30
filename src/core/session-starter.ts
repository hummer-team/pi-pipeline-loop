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
import { writeAuditLog } from "../utils/auditLog";
import { DEFAULT_DECISION_SHORTCUT } from "../constants";
import { createPipelineUI } from "./pipeline-ui";
import { isFrozen, getFlowState, markPipelineAborted } from "./flow-state";
import { loadPromptConfig } from "./prompt-config";

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
          const shortcutKey = config.decisionShortcutKey ?? DEFAULT_DECISION_SHORTCUT;
          ui.notify(ctx, `Pipeline blocked. Press ${shortcutKey} to open the decision menu.`);
        }
      }
    },
  };
}
