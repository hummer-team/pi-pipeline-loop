/**
 * @module runtime-ctx
 * RuntimeCtx bridge — translates real pi SDK event/ctx shapes into the
 * internal RuntimeCtx shape consumed by all pipeline hooks and tools.
 *
 * This is the adapter layer that allows internal business logic to keep
 * using a consistent context interface while the registration bridge
 * (Phase 2) translates between SDK signatures and internal signatures.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "./session-state";
import { createSessionState } from "./session-state";

/**
 * Internal runtime context consumed by all pipeline hooks and tools.
 * Provides a unified interface regardless of the specific pi SDK event type.
 */
export interface RuntimeCtx {
  /** Session state adapter for reading/writing pipeline metadata */
  session: SessionState;

  /** UI context for notifications and status updates */
  ui: ExtensionUIContext;

  /** Tool call information (populated for tool_call and tool_result events) */
  toolCall?: { name: string; arguments: Record<string, unknown> };

  /** Tool result information (populated for tool_result events) */
  result?: { success: boolean; exitCode?: number };

  /**
   * Raw event object passed by the pi SDK registration bridge.
   * Contains event-specific fields such as `reason` (for session_start / session_shutdown).
   * Stored as-is for downstream hooks that need access to event metadata.
   */
  event?: Record<string, unknown>;

  /**
   * 138: Reference to the pi SDK ExtensionAPI, forwarded from the bridge layer.
   * Optional to keep test mocks lightweight — only consumed by agent_settled
   * for the post-advance wake-up call (pi.sendUserMessage).
   */
  pi?: ExtensionAPI;

  /** @internal Original ExtensionContext for standalone functions (e.g., extractAssistantMessages) */
  _ctx: ExtensionContext;
}

/**
 * Build a RuntimeCtx from the real pi SDK ExtensionAPI, ExtensionContext, and optional event.
 *
 * Event mapping:
 * - tool_call: extracts toolName → toolCall.name, input → toolCall.arguments
 * - tool_result: extracts toolName → toolCall.name, input → toolCall.arguments,
 *   isError → result.success (inverted), exitCode 1 if error
 * - other events: toolCall and result are undefined
 *
 * Phase 1 (143): Accepts optional PipelineConfig to pass projectRoot/auditDir
 * to createSessionState, enabling the shared state source (meta.json).
 */
export function buildRuntimeCtx(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event?: Record<string, unknown>,
  config?: { projectRoot?: string; auditDir?: string },
): RuntimeCtx {
  const session = createSessionState(pi, ctx, config ? {
    projectRoot: config.projectRoot,
    auditDir: config.auditDir,
  } : undefined);
  const ui = ctx.ui;

  // 138: Forward pi so that hooks (e.g., agent_settled) can call pi.sendUserMessage
  const rctx: RuntimeCtx = { session, ui, _ctx: ctx, pi };

  if (event && typeof event === "object") {
    // Store raw event for downstream hooks (e.g., session_shutdown reads reason)
    rctx.event = event;
    const eventType = event.type;

    if (eventType === "tool_call" || eventType === "tool_result") {
      const toolName = event.toolName as string | undefined;
      const input = event.input as Record<string, unknown> | undefined;

      if (toolName) {
        rctx.toolCall = {
          name: toolName,
          arguments: input ?? {},
        };
      }

      if (eventType === "tool_result") {
        const isError = event.isError as boolean | undefined;
        rctx.result = {
          success: !isError,
          exitCode: isError ? 1 : 0,
        };
      }
    }
  }

  return rctx;
}
