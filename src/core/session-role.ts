/**
 * @module session-role
 * Shared helper for detecting session role (owner vs child/subagent).
 *
 * Phase 1 (171): Extracted from session-starter.ts detectSubagentSession to
 * provide a single source of truth for role detection across session-shutdown,
 * session-starter, and tool-guard (Phase 4 spawn suppression).
 *
 * Detection signals (OR):
 * - Primary: getHeader()?.parentSession exists (SDK-provided parent reference)
 * - Secondary: getSessionName() matches `^[a-z0-9-]+#[0-9a-f]{8}$`
 * - Fork: event.reason === "fork"
 *
 * Degradation: when sessionManager is unavailable or header is missing,
 * returns isChild=false (conservative — falls back to owner behavior).
 */

import type { RuntimeCtx } from "./runtime-ctx";

/** Subagent session name pattern: lowercase + # + 8 hex chars */
const SUBAGENT_NAME_PATTERN = /^[a-z0-9-]+#[0-9a-f]{8}$/;

/**
 * Detects the session role from the runtime context.
 *
 * @param ctx - Runtime context with session manager access
 * @returns Object with isChild flag, sessionFile, and parentSession reference
 */
export function detectSessionRole(ctx: RuntimeCtx): {
  isChild: boolean;
  sessionFile: string;
  parentSession: string | undefined;
} {
  const sm = ((ctx._ctx as unknown) as Record<string, unknown>)?.sessionManager as
    | { getHeader?: () => Record<string, unknown> | undefined; getSessionName?: () => string; getSessionFile?: () => string }
    | undefined;

  const sessionFile = sm?.getSessionFile?.() ?? "";
  const parentSession = (sm?.getHeader?.() as Record<string, unknown> | undefined)?.parentSession as string | undefined;
  const sessionName = sm?.getSessionName?.() ?? "";
  const eventReason = (ctx.event as Record<string, unknown> | undefined)?.reason;
  const isFork = eventReason === "fork";

  const isChild = !!parentSession || SUBAGENT_NAME_PATTERN.test(sessionName) || isFork;

  return { isChild, sessionFile, parentSession };
}
