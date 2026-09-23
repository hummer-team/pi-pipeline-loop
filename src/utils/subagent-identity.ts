/**
 * @module subagent-identity
 * G4 (188): Validates spawned subagent identity against the pipeline stage config.
 *
 * When the agent uses the `Agent` tool to spawn a subagent (e.g. develop-agent
 * spawning code-review-agent), the `subagents:created` event fires. This module
 * checks whether the spawned agent type matches the expected agent for the
 * current pipeline stage. If not, it emits a stop RPC to kill the mismatched
 * agent and notifies the user.
 *
 * Fail-safe: all errors are silently caught — validation failure must never
 * crash the pipeline or block legitimate subagent spawns.
 */

import type { PipelineConfig } from "../types";
import { resolveAgentMention } from "./subagent-rpc";
import { safeWriteAuditLog } from "./auditLog";

/**
 * Minimal pi interface for the validateSubagentCreated function.
 * Only the fields actually used are declared.
 */
interface PiHandle {
  session?: { getMeta?: () => { currentStage?: string } | undefined };
  events?: { emit?: (event: string, payload: Record<string, unknown>) => void };
  ui?: { notify?: (msg: string) => void };
}

/**
 * Event payload shape for the `subagents:created` event.
 */
interface SubagentCreatedEvent {
  id: string;
  type: string;
  description?: string;
  isBackground?: boolean;
}

/**
 * Validates a subagent created via the Agent tool against the expected agent
 * for the current pipeline stage. If the type doesn't match, emits a stop RPC
 * to kill the mismatched agent.
 *
 * Fail-safe: any error (missing session, unreadable meta, etc.) is caught
 * silently — the pipeline must never be blocked by identity validation.
 *
 * @param event - The subagents:created event payload
 * @param config - Pipeline configuration
 * @param pi - The pi SDK handle (for session/events/ui access)
 */
export async function validateSubagentCreated(
  event: SubagentCreatedEvent,
  config: PipelineConfig,
  pi: unknown,
): Promise<void> {
  try {
    const piHandle = pi as PiHandle | undefined;
    if (!piHandle) return;

    // 1. Read currentStage from the owner session meta
    const meta = piHandle.session?.getMeta?.();
    if (!meta?.currentStage) return; // Fail-safe: can't determine stage → skip

    const currentStage = meta.currentStage as string;

    // 2. Resolve the expected agent name for this stage
    const expectedAgentName = resolveAgentMention(config, currentStage as any);
    if (!expectedAgentName) return; // No agent configured for this stage → skip

    // 3. Compare spawned type against expected
    if (event.type !== expectedAgentName) {
      // Mismatch: stop the spawned agent
      const events = piHandle.events;
      if (events?.emit) {
        events.emit("subagents:rpc:stop", {
          requestId: event.id,
          agentId: event.id,
        });
      }

      // Notify user about the mismatch
      piHandle.ui?.notify?.(
        `Blocked unexpected subagent "${event.type}" (expected "${expectedAgentName}" for ${currentStage} stage).`,
      );

      // Audit the block
      await safeWriteAuditLog("subagent_identity_mismatch_blocked", {
        stage: currentStage,
        expectedAgent: expectedAgentName,
        actualAgent: event.type,
        agentId: event.id,
      });
    }
  } catch {
    // Fail-safe: never throw from validation
  }
}
