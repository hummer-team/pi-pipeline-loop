/**
 * @module session-shutdown
 * Factory for the `session_shutdown` hook.
 * Logs an audit entry and cleans up temporary resources on session teardown.
 *
 * Phase 1 (171): Role-aware shutdown.
 * - Child/subagent sessions: audit session_shutdown_skipped{isSubagent:true}, return.
 *   Subagent panel close/view detach must NOT abort the parent pipeline.
 * - Owner session: maintains 170 semantics (quit/new → markPipelineAborted).
 * - Detection degradation (no sessionManager/header): conservative owner path (no worse).
 *
 * Terminal guard: when the pipeline is already completed, markPipelineAborted
 * (called internally) skips the flowState/terminateReason overwrite — completed
 * is a terminal state that must not be degraded to aborted on shutdown.
 *
 * On reason "resume", "fork", or "reload": does NOT reset (in-process session switch
 * or extension reload — user may continue).
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { clearAllDecisionTimers } from "./flow-state";
import type { RuntimeCtx } from "./runtime-ctx";
import { writeAuditLog, safeWriteAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "./pipeline-ui";
import { markPipelineAborted } from "./flow-state";
import { detectSessionRole } from "./session-role";
import { isDormant } from "./dormancy";
import { probeAgentState } from "../utils/subagents-introspect";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { AUDIT_THROTTLE_WINDOW_MS } from "../constants";
import { clearActiveSpawnRecord, clearStageSpawnRecords } from "../utils/spawn-cleanup";
import { markSubagentsUnavailable } from "../utils/subagent-availability";

/**
 * Creates the `session_shutdown` hook that handles session teardown.
 *
 * Writes a JSON-lines audit entry with:
 * - timestamp, pipelineId, action: "session_shutdown", finalStage
 * - sessionFile, isSubagent (Phase 0 / 171: session identity for traceability)
 *
 * Phase 1 (171): Child/subagent quit → skip abort, audit skipped.
 * Owner quit/new → markPipelineAborted with trigger fields (C14-C15).
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "session_shutdown" event
 */
export function createSessionShutdown(config: PipelineConfig): Hook<"session_shutdown"> {
  const ui = createPipelineUI(config);
  return {
    event: "session_shutdown",
    handler: async (ctx: RuntimeCtx): Promise<void> => {
      const rawMeta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 6 (172) G5: clear all decision retry timers on shutdown (prevent leaks)
      clearAllDecisionTimers();

      // Phase 2 / 177 (D4): owner shutdown tears down the availability latch.
      // A child shutdown must NOT clear it (the owner is still active); the next
      // `subagents:ready` event re-arms it regardless.
      if (!detectSessionRole(ctx).isChild) {
        markSubagentsUnavailable();
      }

      // Phase 2b (173) C3: dormant guard — identity audit + return
      // Covers: no meta, aborted, completed
      // No pipeline_session_aborted, no blocked quit→abort channel
      if (!rawMeta || isDormant(rawMeta)) {
        const { isChild, sessionFile } = detectSessionRole(ctx);
        await writeAuditLog("session_shutdown", {
          pipelineId: rawMeta?.pipelineId ?? "unknown",
          finalStage: rawMeta?.currentStage ?? "unknown",
          ...(sessionFile ? { sessionFile } : {}),
          ...(isChild ? { isSubagent: "true" } : {}),
        });
        return;
      }
      const meta: SessionMeta = rawMeta;

      // Phase 0 (171): session identity fields for traceability
      const { isChild, sessionFile, parentSession } = detectSessionRole(ctx);

      // Phase 3 (170) ①: attach shutdown reason (quit/new/resume/fork/reload)
      // Phase 4 / 175 (R1Q1A): reason missing → "none" for consistency
      const reason = (ctx.event as Record<string, unknown> | undefined)?.reason;
      const reasonStr = reason ? String(reason) : "none";

      // Phase 4 / 175 (R1Q1A): child quit (quit/new) → single merged audit entry
      // "session_shutdown_skipped" with field union (no double-write).
      // For all other cases: write "session_shutdown" with 10min throttle for
      // no-reason events per sessionFile (noise reduction per plan).
      const isChildQuit = (reason === "quit" || reason === "new") && isChild;

      if (isChildQuit) {
        // Merged single entry: union of session_shutdown + session_shutdown_skipped fields
        await writeAuditLog("session_shutdown_skipped", {
          pipelineId: meta.pipelineId,
          finalStage: meta.currentStage,
          stage: meta.currentStage,
          reason: reasonStr,
          isSubagent: "true",
          ...(sessionFile ? { sessionFile } : {}),
          ...(parentSession ? { parentSession } : {}),
        });
      } else {
        // Phase 4 / 175 (R1Q1A): throttle no-reason events per sessionFile (10min).
        // Throttle only applies when sessionFile is present (per spec: "同 sessionFile").
        // When sessionFile is absent, always write (no throttle key available).
        const noReason = reasonStr === "none";
        const throttleKey = sessionFile ? `session_shutdown_no_reason:${sessionFile}` : null;
        const throttled = noReason && throttleKey && !shouldEmitWithinWindow(throttleKey, 10 * 60 * 1000);
        if (!throttled) {
          await writeAuditLog("session_shutdown", {
            pipelineId: meta.pipelineId,
            finalStage: meta.currentStage,
            reason: reasonStr,
            ...(sessionFile ? { sessionFile } : {}),
            ...(isChild ? { isSubagent: "true" } : {}),
          });
        }
      }

      // Phase 1 (171): Child/subagent quit must NOT abort the parent pipeline.
      // Subagent panel close / view detach / completed-recycle trigger session_shutdown(quit)
      // but should not freeze the shared pipeline meta.json.
      if (isChildQuit) {

        // Phase 4 / 175 (R3Q2A): state-aware cleanup channel for child shutdown.
        // Read-only judgment + clear spawn records ONLY. NEVER changes currentStage/flowState/summaries.
        const stage = meta.currentStage;
        const activeSpawn = meta.activeSpawns?.[stage];
        const stageCompleted = !!meta.summaries?.[stage]?.path;

        if (activeSpawn) {
          if (stageCompleted) {
            // Stage completed → idempotent cleanup of spawn records (shared helper, DRY)
            clearStageSpawnRecords(ctx.session, stage);
          } else if (activeSpawn.agentId || activeSpawn.agentName) {
            // Stage not completed + spawn record exists → check probe
            const agentKey = activeSpawn.agentId ?? activeSpawn.agentName!;
            const probe = probeAgentState(agentKey);

            if (probe === "settled") {
              // Agent settled before stage completion → clear record + notify (throttled)
              clearActiveSpawnRecord(ctx.session, stage);

              const throttleKey = `child_shutdown_notify:${sessionFile ?? meta.pipelineId}:${stage}`;
              if (shouldEmitWithinWindow(throttleKey, AUDIT_THROTTLE_WINDOW_MS)) {
                ui.notify(ctx, `Stage executor for "${stage}" exited before stage completion. Run /pipeline-resume or open the decision menu.`);
              }
              await safeWriteAuditLog("child_shutdown_settled", {
                pipelineId: meta.pipelineId,
                stage,
                agentKey,
                ...(sessionFile ? { sessionFile } : {}),
              });
            } else if (probe === "unknown") {
              // Probe unavailable → audit only, fail-open (no record clear, no state change)
              await safeWriteAuditLog("child_shutdown_probe_unavailable", {
                pipelineId: meta.pipelineId,
                stage,
                agentKey,
                ...(sessionFile ? { sessionFile } : {}),
              });
            }
            // probe === "live" → agent still running, do nothing (let lifecycle handle it)
          }
        }

        // Do NOT call markPipelineAborted or clearStage for child sessions
        return;
      }

      // Owner session: reset flowState on quit/new — resume/fork/reload preserve user intent
      if (reason === "quit" || reason === "new") {
        // Phase 1 (171): pass trigger identity + config for enriched audit (C14-C15)
        await markPipelineAborted(ctx, "session_quit", {
          trigger: {
            sessionFile: sessionFile || undefined,
            isSubagent: false,
            eventReason: String(reason),
          },
          config,
        });
      }

      // Clear status bar on session shutdown (owner only — child returned above)
      ui.clearStage(ctx);
    },
  };
}
