/**
 * @module auto-pipeline/diagnostics
 * 219 Phase 5 / review round 2 (issue 6): the auto pipeline is a user-facing
 * subsystem, so it must NOT print to the process console. Diagnostics follow the
 * project rules:
 *
 * 1. the project audit log is the FIRST channel (`safeWriteAuditLog` — the
 *    general-purpose writer, never `console.*`);
 * 2. only an anomaly a human can actually act on is ALSO surfaced in the TUI,
 *    and always in English (`Auto job "…": …`).
 *
 * The low-level readers (sidecar / lock / job-file) have no ctx and no config —
 * they audit only; the caller that CAN talk to the user (command result, notify,
 * job summary) owns the surfacing decision.
 */

import type { AuditLogLevel } from "../../types";
import { encodeAuditValue, safeWriteAuditLog } from "../../utils/auditLog";

/** TUI sink shape shared by the hook ctx and the command ctx. */
export interface AutoTuiSink {
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

/** Audit action for every auto-pipeline diagnostic row. */
const DIAGNOSTIC_ACTION = "pipeline_auto_diagnostic";

/**
 * Audit-only diagnostic (low-level failure, no user-facing sink available).
 *
 * Fire-and-forget: a diagnostic must never change control flow.
 */
export function auditAutoDiagnostic(
  action: string,
  detail: string,
  details: Record<string, string | boolean> = {},
  level: AuditLogLevel = "warn",
): void {
  // Values are encoded like every other audit payload: a `|` or `=` inside a
  // message would otherwise break the `k=v | k=v` line format.
  const payload: Record<string, string | boolean> = { action, detail: encodeAuditValue(detail) };
  for (const [key, value] of Object.entries(details)) {
    payload[key] = typeof value === "string" ? encodeAuditValue(value) : value;
  }
  // Fire-and-forget, but never an unhandled rejection: a diagnostic must not
  // change control flow NOR crash the process.
  void safeWriteAuditLog(DIAGNOSTIC_ACTION, payload, level).catch(() => undefined);
}

/** Surface an actionable auto-pipeline message in the TUI (English copy). */
export function notifyAuto(
  ctxLike: unknown,
  message: string,
  level: "info" | "warning" | "error" = "error",
): void {
  const ui = (ctxLike as AutoTuiSink | null | undefined)?.ui;
  try {
    ui?.notify?.(message, level);
  } catch {
    // A broken TUI must never break a pipeline transaction.
  }
}

/**
 * Audit + TUI for a failure the user must see.
 *
 * @param ctxLike - Hook/command ctx carrying `ui.notify` (may be `undefined`).
 * @param action  - Stable machine action name (audit column).
 * @param message - English, human-actionable sentence.
 */
export function reportAutoFailure(
  ctxLike: unknown,
  action: string,
  message: string,
  details: Record<string, string | boolean> = {},
): void {
  auditAutoDiagnostic(action, message, details, "error");
  notifyAuto(ctxLike, message);
}
