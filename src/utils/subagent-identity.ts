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
 *
 * ## Owner meta access (SDK limitation workaround)
 *
 * The pi SDK `ExtensionAPI` does NOT expose a `session` property. The
 * `subagents:created` event is a global event — it has no per-session `ctx`
 * parameter, so there is no direct path to the owner session meta from the
 * event listener alone.
 *
 * To work around this, the `createPipeline` factory updates a module-level
 * accessor (`_ownerSessionAccessor`) from within each hook callback, where
 * the real `ExtensionContext.sessionManager` is available via
 * `buildRuntimeCtx`. `validateSubagentCreated` reads `currentStage` through
 * this accessor. This is safe because:
 *   - Hooks run on every owner interaction, keeping the accessor fresh.
 *   - Only one pipeline session is active per process at any given time.
 *   - If no hook has run yet (accessor is null), validation silently no-ops
 *     (fail-safe: no false blocks on a cold start).
 */

import type { PipelineConfig, SessionMeta } from "../types";
import { resolveAgentMention } from "./subagent-rpc";
import { safeWriteAuditLog } from "./auditLog";

/**
 * Minimal pi interface for event emission and user notification.
 * Only the fields actually used by validateSubagentCreated are declared.
 */
interface PiHandle {
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
 * Shape of the module-level owner session accessor.
 * Returns the latest SessionMeta snapshot from the owner session, or undefined
 * if no meta is available yet.
 */
export type OwnerMetaAccessor = () => SessionMeta | undefined;

/**
 * Module-level reference to the most recent owner session meta accessor.
 *
 * LIMITATION: The pi SDK's `ExtensionAPI` has no `session` property, and
 * `subagents:created` is a global event (no per-session ctx). We cannot read
 * owner meta from the pi handle alone. Instead, the `createPipeline` factory
 * updates this accessor from hook callbacks where the real
 * `ExtensionContext.sessionManager` is available via `buildRuntimeCtx`.
 *
 * Updated on every hook invocation — always reflects the latest owner state.
 * Null until the first hook fires (cold-start fail-safe: no-op validation).
 */
let _ownerMetaAccessor: OwnerMetaAccessor | null = null;

/**
 * Module-level reference to the pi handle for event emission and UI notification.
 * Updated alongside the meta accessor from the `createPipeline` factory.
 */
let _piHandle: PiHandle | null = null;

/**
 * Updates the module-level owner session meta accessor.
 * Called by the `createPipeline` factory from within hook callbacks where
 * the real `ExtensionContext` (and thus `sessionManager`) is available.
 *
 * @param accessor - Function returning the latest SessionMeta snapshot
 * @param piHandle - The pi SDK handle for event emission / UI notification
 */
export function setOwnerSessionAccessor(
  accessor: OwnerMetaAccessor | null,
  piHandle?: PiHandle,
): void {
  _ownerMetaAccessor = accessor;
  if (piHandle) {
    _piHandle = piHandle;
  }
}

/**
 * Test-only reset for the module-level accessor. Restores the null state
 * so tests start from a clean slate.
 */
export function __resetOwnerSessionAccessor(): void {
  _ownerMetaAccessor = null;
  _piHandle = null;
}

/**
 * Validates a subagent created via the Agent tool against the expected agent
 * for the current pipeline stage. If the type doesn't match, emits a stop RPC
 * to kill the mismatched agent.
 *
 * Fail-safe: any error (missing accessor, unreadable meta, etc.) is caught
 * silently — the pipeline must never be blocked by identity validation.
 *
 * @param event - The subagents:created event payload
 * @param config - Pipeline configuration
 * @param pi - The pi SDK handle (for events/ui access). If the module-level
 *             accessor was set by the factory, the pi handle from the accessor
 *             takes precedence (it is more up-to-date).
 */
export async function validateSubagentCreated(
  event: SubagentCreatedEvent,
  config: PipelineConfig,
  pi: unknown,
): Promise<void> {
  try {
    // Use the module-level pi handle (set by the factory from hook ctx) if
    // available; otherwise fall back to the pi argument passed by the caller.
    const piHandle = (_piHandle ?? pi) as PiHandle | undefined;
    if (!piHandle) return;

    // 1. Read currentStage from the owner session meta via the module-level
    //    accessor. The accessor is updated on every hook invocation, so it
    //    always reflects the latest owner session state.
    //    Fail-safe: if the accessor is null (cold start) or returns undefined,
    //    skip validation silently.
    const meta = _ownerMetaAccessor?.();
    if (!meta?.currentStage) return;

    const currentStage = meta.currentStage;

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
