/**
 * @module stage-advancer
 * Factory for the `stage_advance` tool.
 * Transitions the pipeline from the current stage to the next stage
 * defined in the project's PipelineConfig.
 *
 * Phase 0 (121_PipelineFlow): embeds a verification gate — when the current
 * stage has `verify.require=true`, the tool runs `runVerification` before
 * advancing. Also supports an optional `nextStage` parameter for conditional
 * branching (e.g. review → fix vs review → completed).
 *
 * Phase 3 (162): adds the post-verify confirmation gate (confirm gate).
 * The confirm gate presents a TUI dialog after verify passes, allowing the user
 * to approve & advance, reject & rework, or cancel. Supports three modes:
 * - auto: plugin auto-writes bilingual marker, advance proceeds (current behavior)
 * - manual: TUI dialog presented, user chooses action
 * - smart: agent self-assesses complexity via `needConfirm` parameter
 *
 * Small helper functions are decomposed to prevent any single function from
 * growing too large (R3-Q2 implementation constraint).
 */

import * as fs from "node:fs/promises";
import type { PipelineConfig, Tool, SessionMeta, PipelineStage, ExecFn, ConfirmMode, StageConfig } from "../types";
import { createPipelineUI } from "./pipeline-ui";
import { runVerification, precheckRequiredFiles, resolvePlanDocPath, planDocHasConfirmMarker } from "./auto-verifier";
import { autoAdvanceAfterVerify } from "./verify-advance";
import { extractAssistantMessages, extractToolCallRecords } from "./session-state";
import { applyVerifyFail } from "./verify-advance";
import { safeWriteStageAudit, writeAuditLog } from "../utils/auditLog";
import { checkStageSummaryHash } from "../utils/summary-hash";
import { DEFAULT_CONFIRM_MAX_REJECTIONS, DEFAULT_SPAWN_WAIT_TIMEOUT_MS, DECISION_DISMISS_INTERRUPT_MS, AUDIT_THROTTLE_WINDOW_MS } from "../constants";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { findLatestReviewReport } from "../utils/review-conclusion";
import { spawnStageSubagent } from "../utils/subagent-rpc";
import { recordStageVisit } from "../utils/stage-visit";
import { isDormant } from "./dormancy";
import { anyTopLevelRunning } from "../utils/subagents-introspect";
import { anyActiveSpawnEvidence } from "../utils/spawn-evidence";
import { detectSessionRole } from "./session-role";

// ─── Confirm Gate Types (Phase 3 — 162) ──────────────────────────────────────

/**
 * Result of the confirm gate check.
 * - "no-gate": gate not triggered (e.g. marker already present, auto mode, etc.)
 * - "handled": gate was triggered and handled (action disambiguates the outcome)
 */
export type ConfirmGateResult =
  | { result: "no-gate" }
  | { result: "handled"; action: "advanced" | "routed" | "pending" | "aborted"; toStage?: PipelineStage; deferred?: true };

/**
 * The plan-stage content-pattern rule used for the bilingual confirm marker.
 * Exported for use by agent-settled.ts when constructing deferContentPatterns.
 */
export const PLAN_CONFIRM_MARKER_RULE = {
  path: "docs/design/*_plan.md",
  pattern: "^## (用户确认|User Confirmation)",
};

/**
 * Regex matching the plugin-written plan confirm marker (bilingual).
 *
 * Single source of truth shared by the confirm gate's no-gate check and the
 * pending-gate predicate (`detectPendingConfirmGate`) so their judgments cannot
 * drift. Not global — `.test()` stays stateless across calls.
 */
export const CONFIRM_MARKER_RE = /^## (?:用户确认：确认无误|User Confirmation: Confirmed)/m;

// ─── Confirm Gate Helper Functions (Phase 3 — 162) ───────────────────────────

/**
 * Determines whether the plan marker rule should be deferred for this stage.
 * Returns true when currentStage is "plan" AND confirm is configured AND mode is not "auto".
 * Used by callers (agent-settled, stage-advancer) to construct deferContentPatterns.
 *
 * The `currentStage` parameter ensures the deferral only applies during plan
 * stage verification — without it, the function would incorrectly return true
 * for review/manual (relying on path mismatch as a safety net).
 */
export function shouldDeferPlanMarkerRule(currentStage: PipelineStage, stageConfig: StageConfig): boolean {
  return currentStage === "plan"
    && stageConfig.confirm !== undefined
    && stageConfig.confirm.mode !== undefined
    && stageConfig.confirm.mode !== "auto";
}

/**
 * Resolves the effective max rejections cap for a stage's confirm gate.
 * Priority: stage-level maxRejections > global maxConfirmRejections > default (5).
 */
export function resolveConfirmMaxRejections(config: PipelineConfig, stageConfig: StageConfig): number {
  return stageConfig.confirm?.maxRejections ?? config.maxConfirmRejections ?? DEFAULT_CONFIRM_MAX_REJECTIONS;
}

/**
 * Resolves the stage document path for writing confirm markers.
 * - plan: uses resolvePlanDocPath
 * - review: returns the latest code_review_*.md path
 * Returns null if no path can be resolved.
 */
async function resolveStageDocPath(
  config: PipelineConfig,
  meta: SessionMeta,
  stage: PipelineStage,
): Promise<string | null> {
  if (stage === "plan") {
    return resolvePlanDocPath(config, meta);
  }
  if (stage === "review") {
    // Delegate to shared review report finder (DRY with review-conclusion.ts)
    return findLatestReviewReport(config.projectRoot);
  }
  return null;
}

/**
 * Validates that a path is within the stage's allowedWritePaths.
 * Returns true if the path is allowed; false otherwise.
 */
function isWritePathAllowed(stageConfig: StageConfig, relPath: string, projectRoot: string): boolean {
  const allowed = stageConfig.allowedWritePaths ?? [];
  return allowed.some(
    (prefix) => prefix === "**" || relPath.startsWith(prefix),
  );
}

/**
 * Writes a confirmation marker to the stage document.
 * Validates the write path against allowedWritePaths before writing.
 * Returns true on success; false on failure (with audit + notify).
 */
async function writeConfirmMarker(
  config: PipelineConfig,
  ctx: { ui?: { notify: (msg: string) => void } },
  meta: SessionMeta,
  docPath: string,
  lines: string[],
  auditEvent: string,
): Promise<boolean> {
  const stageConfig = config.stages[meta.currentStage];
  const relDoc = docPath.startsWith(config.projectRoot)
    ? docPath.slice(config.projectRoot.length + 1)
    : docPath;

  if (!isWritePathAllowed(stageConfig, relDoc, config.projectRoot)) {
    await writeAuditLog("confirm_marker_write_failed", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      docPath,
      reason: "write path not in allowedWritePaths",
    });
    ctx.ui?.notify(`Cannot write confirm marker: path "${relDoc}" not in allowedWritePaths.`);
    return false;
  }

  try {
    await fs.appendFile(docPath, lines.join("\n") + "\n", "utf-8");
    await writeAuditLog(auditEvent, {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      docPath,
    });
    return true;
  } catch (err) {
    await writeAuditLog("confirm_marker_write_failed", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      docPath,
      error: err instanceof Error ? err.message : String(err),
    });
    ctx.ui?.notify(`Failed to write confirm marker: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Auto-writes the bilingual confirm marker for the plan stage when:
 * - currentStage is "plan"
 * - confirm is not configured OR mode is "auto" (default behavior)
 * - marker is not already present in the plan document
 *
 * Idempotent: skips if marker already exists.
 * Returns true if marker was written or already exists; false on failure.
 */
export async function autoWriteConfirmMarker(
  config: PipelineConfig,
  ctx: { ui?: { notify: (msg: string) => void } },
  meta: SessionMeta,
  ui: { transition?: (ctx: unknown, from: string, to: string) => void },
): Promise<boolean> {
  if (meta.currentStage !== "plan") return true;

  const stageConfig = config.stages["plan"];
  const mode = stageConfig.confirm?.mode;
  // Only auto-write when confirm is not configured or mode is "auto"
  if (mode !== undefined && mode !== "auto") return true;

  const planDocPath = await resolvePlanDocPath(config, meta);
  if (!planDocPath) return true;

  // Check if marker already exists (idempotent)
  const hasMarker = await planDocHasConfirmMarker(planDocPath);
  if (hasMarker) return true;

  // Check if plan doc exists
  try {
    await fs.access(planDocPath);
  } catch {
    // Plan doc not yet written — skip auto-write (verify will catch missing requiredFiles)
    return true;
  }

  const timestamp = new Date().toISOString();
  const lines = [
    "",
    "## 用户确认：确认无误",
    "",
    `> Confirmation timestamp: ${timestamp}`,
    "",
    "## User Confirmation: Confirmed",
    "",
    `> Confirmation timestamp: ${timestamp}`,
    "",
  ];

  const ok = await writeConfirmMarker(config, ctx, meta, planDocPath, lines, "confirm_auto_write");
  return ok;
}

/**
 * Handles the overflow scenario when confirm rejections exceed the cap.
 * Returns "continue" (user chose to continue despite overflow) or "terminate" (abort pipeline).
 *
 * - confirmOverflow === "terminate": immediately returns "terminate"
 * - confirmOverflow === "ask": presents TUI select with Continue/Terminate options
 *   - No UI available: returns "pending" (caller handles)
 */
async function handleConfirmOverflow(
  config: PipelineConfig,
  ctx: { ui?: { notify: (msg: string) => void; select?: (message: string, options: string[]) => Promise<string | undefined> } },
  meta: SessionMeta,
): Promise<"continue" | "terminate" | "pending"> {
  const overflow = config.confirmOverflow ?? "ask";

  if (overflow === "terminate") {
    // Direct termination — no dialog
    await writeAuditLog("confirm_overflow_terminate", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
    });
    return "terminate";
  }

  // overflow === "ask": present dialog
  const rawSelect = ctx.ui?.select;
  if (!rawSelect) {
    // No UI available — pending (caller handles: notify + no advance)
    await writeAuditLog("confirm_overflow_pending", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      reason: "no ui.select available",
    });
    return "pending";
  }

  const choice = await rawSelect(
    `Confirm rejection limit exceeded (${resolveConfirmMaxRejections(config, config.stages[meta.currentStage])}). Choose action:`,
    ["Continue", "Terminate"],
  );

  if (choice === undefined) {
    // Esc pressed — treat as pending (no advance, no count change)
    await writeAuditLog("confirm_overflow_esc", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
    });
    return "pending";
  }

  if (choice === "Continue") {
    await writeAuditLog("confirm_overflow_ask", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      action: "continue",
    });
    return "continue";
  }

  // Terminate
  await writeAuditLog("confirm_overflow_terminate", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    action: "user_terminate",
  });
  return "terminate";
}

/**
 * Routes a confirm rejection to the appropriate target stage.
 * Updates meta, writes audit, performs UI transition, and sends wake message.
 *
 * Routing matrix:
 * - plan → clarify (reject to re-clarify)
 * - review → fix (reject to re-fix)
 *
 * Also clears any existing confirmation markers from the source stage's document
 * to prevent the old marker from bypassing the confirm gate on re-entry (Medium #8 fix).
 *
 * @returns true if routing succeeded, false if aborted (e.g. maxLoopCycles freeze)
 */
async function routeConfirmReject(
  config: PipelineConfig,
  ctx: { session: { updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined }; ui?: { notify: (msg: string) => void; transition?: (ctx: unknown, from: string, to: string) => void }; pi?: { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void } },
  meta: SessionMeta,
  fromStage: PipelineStage,
  toStage: PipelineStage,
  nextCount: number,
  opts?: { reason?: string; auditEvent?: string },
): Promise<boolean> {
  // Clear old confirmation markers from the source stage doc to prevent
  // bypass on re-entry (e.g. plan→clarify→plan round trip).
  const sourceDocPath = await resolveStageDocPath(config, meta, fromStage);
  if (sourceDocPath) {
    try {
      const content = await fs.readFile(sourceDocPath, "utf-8");
      // Remove only the exact markers written by the plugin, not user headings
      // that happen to share a prefix (e.g. "## 用户确认流程" must NOT be deleted).
      //
      // Plugin-written marker forms:
      //   plan  -> "## 用户确认：确认无误"  /  "## User Confirmation: Confirmed"
      //   review -> "## Confirmation: Approved"
      // Each is followed by a blank line, a "> Confirmation timestamp: <ISO>" line,
      // and optional trailing blank lines.
      const cleaned = content.replace(
        /^## (?:用户确认：确认无误|User Confirmation: Confirmed|Confirmation: Approved)\n\n> Confirmation timestamp: [^\n]+\n\n*/gm,
        "",
      );
      if (cleaned !== content) {
        await fs.writeFile(sourceDocPath, cleaned, "utf-8");
        await writeAuditLog("confirm_marker_cleared_on_reject", {
          pipelineId: meta.pipelineId,
          stage: fromStage,
          docPath: sourceDocPath,
        });
      }
    } catch {
      // File doesn't exist or unreadable — skip cleanup (not an error)
    }
  }

  // Record stage visit via shared helper (reject routing is a legitimate cycle,
  // cycle count semantics match handoff)
  const sessionForSpawn = ctx.session as unknown as { getMeta?: () => SessionMeta | undefined; updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined };
  const freshMetaForVisit = sessionForSpawn.getMeta?.() ?? meta;
  const maxCycles = freshMetaForVisit.maxLoopCycles ?? config.maxLoopCycles ?? 3;
  const visitResult = recordStageVisit(freshMetaForVisit, toStage, maxCycles);

  // Nit 4 (reaudit): honor recordStageVisit().ok — when maxLoopCycles reached,
  // freeze the pipeline and abort routing (aligned with stage-advancer tool + verify-advance).
  // Without this, loopCycleCount could grow unbounded via manual Reject routing.
  if (!visitResult.ok) {
    ctx.session.updateMeta(visitResult.patch);
    await import("./flow-state").then(({ freezeAndPrompt }) =>
      freezeAndPrompt(
        ctx as unknown as Parameters<typeof freezeAndPrompt>[0],
        meta,
        "max_loop_cycles",
        config,
      ),
    );
    return false;
  }

  // Update meta with routing + rejection count + visit patch.
  // Minor 2 (reaudit): clear advancedThisTurn (undefined) instead of setting it to true.
  // The route is triggered by an already-consumed settle (hook path), so no residual
  // settle needs guarding. Clearing before spawn prevents the spawned subagent's JOIN
  // from inheriting the flag — without this, the subagent's first settle would be
  // eaten by C2 (agent-settled.ts:90-99), stalling the pipeline.
  ctx.session.updateMeta({
    ...visitResult.patch,
    previousStage: fromStage,
    currentStage: toStage,
    stageStartTime: Date.now(),
    loopCount: 0,
    currentStepIndex: 0,
    verifyFailures: [],
    verifyAttempts: 0, // Reset per-stage attempt counter on stage advance (168 Phase 0)
    violations: [],
    advancedThisTurn: undefined,
    confirmRejections: nextCount,
    // Phase 1 (180): clear any deferral stamp — the source stage visit is over,
    // so a leftover stamp must not leak into the target stage's deferral window.
    confirmGateDeferredAt: undefined,
  });

  // Use custom audit event if provided (e.g. "review_auto_route_fix" to avoid double-writing)
  const auditEvent = opts?.auditEvent ?? "confirm_rejected";
  await writeAuditLog(auditEvent, {
    pipelineId: meta.pipelineId,
    stage: fromStage,
    toStage,
    confirmRejections: String(nextCount),
    ...(opts?.reason ? { reason: opts.reason } : {}),
  });

  // UI transition
  if (ctx.ui?.transition) {
    ctx.ui.transition(ctx, fromStage, toStage);
  }

  // Minor 1 (reaudit): spawn first, then conditionally send wake.
  // Aligns with 169 autoAdvanceAfterVerify pattern: when spawn succeeds (RPC or fallback),
  // skip the generic wake to prevent dual execution (wake in current session + subagent).
  // When spawn fails entirely, fall back to wake + set C2 guard for the wake-triggered settle.
  const freshMetaForSpawn = sessionForSpawn.getMeta?.() ?? meta;
  const spawnResult = await spawnStageSubagent(ctx.pi, config, toStage, freshMetaForSpawn, {
    ui: { notify: (msg: string) => { ctx.ui?.notify?.(msg); } },
    session: sessionForSpawn.getMeta ? sessionForSpawn as { getMeta: () => SessionMeta | undefined; updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined } : undefined,
    runtimeCtx: ctx,
  });

  if (spawnResult.spawned || spawnResult.fallback || spawnResult.deferred) {
    // Subagent spawned or deferred — skip generic wake to prevent dual execution.
    // deferred means the spawn is queued and will execute once the old twin settles;
    // waking the owner now would cause dual execution with the pending dequeue.
    await writeAuditLog("confirm_reject_wake_skipped", {
      pipelineId: meta.pipelineId,
      fromStage,
      toStage,
      reason: spawnResult.deferred ? "subagent_deferred" : "subagent_spawned",
    });
  } else {
    // Spawn did not fire — send wake and set C2 guard for the wake-triggered settle.
    // The guard prevents the settle triggered by sendUserMessage from running redundant verification.
    ctx.session.updateMeta({ advancedThisTurn: true });
    if (ctx.pi?.sendUserMessage) {
      const reason = opts?.reason ?? "rejected by confirm gate";
      ctx.pi.sendUserMessage(
        `Stage "${fromStage}" ${reason}. Routing to "${toStage}" for rework.`,
        { deliverAs: "followUp" },
      );
    }
  }
  return true;
}

/**
 * Routes review→fix automatically (no counting, no overflow, no select).
 * Reuses routeConfirmReject but passes current confirmRejections value (no +1).
 *
 * Used by agent-settled auto mode when review report parsing concludes "fail".
 *
 * @param config - Pipeline configuration
 * @param ctx - Runtime context
 * @param meta - Current session metadata
 * @param ui - Pipeline UI for transition
 * @param opts - Optional reason for audit
 */
export async function routeReviewFailAuto(
  config: PipelineConfig,
  ctx: { session: { updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined }; ui?: { notify: (msg: string) => void; transition?: (ctx: unknown, from: string, to: string) => void }; pi?: { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void } },
  meta: SessionMeta,
  ui: { notify: (ctx: unknown, msg: string) => void; transition?: (ctx: unknown, from: string, to: string) => void },
  opts?: { reason?: string },
): Promise<void> {
  // Pass current confirmRejections value (no +1) → no overflow trigger
  const currentCount = meta.confirmRejections ?? 0;
  const routed = await routeConfirmReject(config, ctx, meta, "review", "fix", currentCount, {
    auditEvent: "review_auto_route_fix",
    reason: opts?.reason ?? "review report parsed as fail (auto)",
  });
  // UI transition only if routing succeeded (not frozen by maxLoopCycles)
  if (routed && ui.transition) {
    ui.transition(ctx, "review", "fix");
  }
}

/**
 * Handles the "approved" outcome of the confirm gate.
 * Writes bilingual confirmation marker, resets rejection counter, advances to next stage.
 * Returns true if advanced successfully; false on failure.
 */
async function advanceConfirmApproved(
  config: PipelineConfig,
  ctx: { session: { getMeta: () => SessionMeta | undefined; updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined }; ui?: { notify: (msg: string) => void; clearStage?: (ctx: unknown) => void; transition?: (ctx: unknown, from: string, to: string) => void }; pi?: { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void } },
  meta: SessionMeta,
  fromStage: PipelineStage,
  toStage: PipelineStage,
  pipelineUI: { notify: (ctx: unknown, msg: string) => void; transition?: (ctx: unknown, from: string, to: string) => void },
): Promise<boolean> {
  // Resolve the stage document for writing marker
  const docPath = await resolveStageDocPath(config, meta, fromStage);
  if (docPath) {
    const timestamp = new Date().toISOString();
    const lines: string[] = fromStage === "plan"
      ? [
          "",
          "## 用户确认：确认无误",
          "",
          `> Confirmation timestamp: ${timestamp}`,
          "",
          "## User Confirmation: Confirmed",
          "",
          `> Confirmation timestamp: ${timestamp}`,
          "",
        ]
      : [
          "",
          "## Confirmation: Approved",
          "",
          `> Confirmation timestamp: ${timestamp}`,
          "",
        ];

    const writeOk = await writeConfirmMarker(config, ctx, meta, docPath, lines, "confirm_approved");
    if (!writeOk) {
      // Marker write failed (e.g. write path not in allowedWritePaths) — do not advance.
      // writeConfirmMarker has already written audit + notified the user.
      // Counter is NOT reset — rejection count stays intact so the next attempt
      // continues from the current value (consistent with "reset only on success").
      return false;
    }
  }

  // Reset rejection counter on approval (after marker write succeeds).
  // Phase 1 (180): also clear the deferral stamp — the stage visit is complete.
  ctx.session.updateMeta({ confirmRejections: undefined, confirmGateDeferredAt: undefined });

  // Audit the approval
  await writeAuditLog("confirm_approved", {
    pipelineId: meta.pipelineId,
    stage: fromStage,
    toStage,
  });

  // Advance using shared logic (same as autoAdvanceAfterVerify)
  const syntheticResult = {
    structuredResult: { failures: [] },
    ruleMissing: [],
    verifyResult: null,
  };

  // Use the imported autoAdvanceAfterVerify for consistent advance behavior
  // Cast ctx to match VerifyAdvanceCtx shape (compatible at runtime)
  await autoAdvanceAfterVerify(
    config,
    ctx as Parameters<typeof autoAdvanceAfterVerify>[1],
    meta,
    fromStage,
    toStage,
    syntheticResult,
    pipelineUI as unknown as Parameters<typeof autoAdvanceAfterVerify>[6],
    { skipPassAudit: true },
  );

  // Phase 3 (162): when advancing to completed, clear the stage display
  // (mirrors stage-advancer.ts terminal branch at line 867).
  if (toStage === "completed" && ctx.ui?.clearStage) {
    ctx.ui.clearStage(ctx);
  }

  // Phase 1 (169): spawn removed from here — autoAdvanceAfterVerify (called above)
  // now handles spawn centrally, preventing double-trigger with confirm approve path.

  return true;
}

/**
 * Phase 3 / 180 (C3 / D5a): actionable copy for a pending confirm gate.
 *
 * The previous text pointed at the decision shortcut (`ctrl+shift+u`) and an
 * "Approve & Advance" menu item that does not exist in the running-state menu
 * (running = [restart, abort]) — an unexecutable instruction. The deterministic
 * re-entry path is `/pipeline-resume`, which re-opens the existing confirm
 * dialog; alternatively the user can write the direct-pass marker in the stage
 * document and retry.
 *
 * @param config - Pipeline configuration (retained for signature compatibility)
 * @param stage - The stage awaiting confirmation
 * @returns Human-readable guidance string
 */
export function formatConfirmGatePendingCopy(config: PipelineConfig, stage: PipelineStage): string {
  return (
    `Stage "${stage}" awaits human confirmation and was not advanced. ` +
    `Run /pipeline-resume to reopen the confirmation dialog, ` +
    `or write "## 用户确认：确认无误" in the stage document and retry.`
  );
}

/** Outcome of the confirm-gate deferral probe (Phase 4 / 179, G5/G7). */
type ConfirmGateDeferralDecision = "present" | "defer" | "timeout";

/**
 * Phase 1 (180): Reads the confirm-gate deferral stamp only when it belongs to
 * the current stage visit.
 *
 * A stamp from a previous visit to the same stage is stale — its `at` predates
 * the current `stageStartTime`. Treating it as absent prevents the leftover
 * stamp from immediately satisfying the deferral timeout (which would pop the
 * dialog while a subagent is still live — the collateral-Esc failure mode).
 *
 * Defensive: a missing `stageStartTime` makes the stamp invalid (fail-closed).
 *
 * @param meta - Current session metadata
 * @returns The effective stamp, or undefined when absent/stale/stage-mismatched
 */
function getEffectiveDeferredStamp(
  meta: SessionMeta,
): { stage: PipelineStage; at: number } | undefined {
  const stamp = meta.confirmGateDeferredAt;
  if (!stamp || stamp.stage !== meta.currentStage) return undefined;
  if (meta.stageStartTime === undefined) return undefined;
  if (stamp.at < meta.stageStartTime) return undefined;
  return stamp;
}

/**
 * Phase 4 / 179 (G5/G7): decides whether the confirm-gate popup must be
 * deferred because a top-level subagent is still live.
 *
 * An Esc pressed in a subagent window can collateral-cancel the owner's
 * `ui.select`, so the dialog is only presented once no subagent is running.
 * A bounded timeout (`config.spawnWaitTimeoutMs`) prevents a permanent
 * "never pop" deadlock when an unrelated subagent hangs.
 *
 * Probe order:
 * 1. `anyTopLevelRunning()` — global coarse probe (primary)
 * 2. `anyActiveSpawnEvidence()` — per-stage scan + probe + reserved window (degrade)
 *
 * @returns "present" (safe to pop), "defer" (keep pending), "timeout" (pop anyway)
 */
function evaluateConfirmGateDeferral(
  config: PipelineConfig,
  meta: SessionMeta,
): ConfirmGateDeferralDecision {
  const probe = anyTopLevelRunning();
  const anyLive = probe === null
    ? anyActiveSpawnEvidence(meta.activeSpawns) !== null
    : probe;
  if (!anyLive) return "present";

  // Phase 1 (180): only a stamp from the current stage visit counts. A stale
  // stamp is treated as absent, so the deferral restarts instead of timing out.
  const deferredAt = getEffectiveDeferredStamp(meta);
  if (deferredAt) {
    const timeoutMs = config.spawnWaitTimeoutMs ?? DEFAULT_SPAWN_WAIT_TIMEOUT_MS;
    if (Date.now() - deferredAt.at >= timeoutMs) return "timeout";
  }
  return "defer";
}

/**
 * Main confirm gate orchestrator.
 * Called after verify passes when the stage has a non-auto confirm mode.
 *
 * Behavior by mode:
 * - "manual": always presents TUI dialog
 * - "smart" + needConfirm=true: writes "## 智能确认：复杂" marker, then presents dialog
 * - "smart" + needConfirm=false: returns "no-gate" (caller handles non-complex skip)
 *
 * Dialog options:
 * - plan: ["Approve & Advance", "Reject & Rework (back to clarify)", "Cancel"]
 * - review: ["Approve & Complete", "Reject & Send to Fix", "Cancel"]
 *
 * Returns ConfirmGateResult indicating whether the gate was triggered and the outcome.
 */
export async function maybeHandleConfirmGate(
  config: PipelineConfig,
  ctx: { session: { getMeta: () => SessionMeta | undefined; updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined }; ui?: { notify: (msg: string) => void; select?: (message: string, options: string[]) => Promise<string | undefined>; transition?: (ctx: unknown, from: string, to: string) => void; clearStage?: (ctx: unknown) => void }; pi?: { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void } },
  meta: SessionMeta,
  ui: { notify: (ctx: unknown, msg: string) => void; transition?: (ctx: unknown, from: string, to: string) => void },
  opts: {
    mode: ConfirmMode;
    needConfirm?: boolean;
    defaultReject?: boolean;
    /**
     * Phase 2 / 180: attribution source for the dismiss/deferral audit events.
     * Defaults to "owner_settled" so existing callers (agent-settled, tool path,
     * pipeline-handoff) keep their current semantics without changes. The
     * vocabulary intentionally excludes "menu" (no menu carrier exists in 180).
     */
    source?: "owner_settled" | "resume";
    /**
     * Phase 1 / 181: true when the caller is a child/subagent session.
     *
     * Child sessions must never present the owner dialog or mutate gate state.
     * They return `no-gate` for the non-gate preconditions (non plan/review
     * stage, smart non-complex, marker already present) WITHOUT clearing any
     * deferral stamp, and for a real gate they return
     * `handled + pending + deferred` after writing a single
     * `confirm_gate_suppressed_child` audit — zero `updateMeta`, zero
     * `ui.select`, zero marker writes.
     *
     * Defaults to false so owner callers keep the 180 behavior unchanged.
     */
    isChild?: boolean;
    /** Phase 1 / 181: child session file, recorded in the suppression audit. */
    sessionFile?: string;
  },
): Promise<ConfirmGateResult> {
  const { mode, needConfirm, defaultReject, isChild = false, sessionFile } = opts;
  const source = opts.source ?? "owner_settled";
  const currentStage = meta.currentStage;
  const stageConfig = config.stages[currentStage];

  // Precondition: only plan and review stages support confirm gate
  if (currentStage !== "plan" && currentStage !== "review") {
    // Phase 1 / 181: child sessions are read-only — never clear the owner's
    // deferral stamp, even on the non-gate path.
    if (isChild) return { result: "no-gate" };
    // Clear stale deferral timestamp so the timeout fallback only applies to
    // the current deferral window, not a leftover from a previous stage visit.
    if (meta.confirmGateDeferredAt) {
      ctx.session.updateMeta({ confirmGateDeferredAt: undefined });
    }
    return { result: "no-gate" };
  }

  // Smart mode: if needConfirm is not true, skip the gate (non-complex)
  if (mode === "smart" && needConfirm !== true) {
    if (isChild) return { result: "no-gate" };
    if (meta.confirmGateDeferredAt) {
      ctx.session.updateMeta({ confirmGateDeferredAt: undefined });
    }
    return { result: "no-gate" };
  }

  // Check if marker already present (manual mode legacy check)
  const docPath = await resolveStageDocPath(config, meta, currentStage);
  if (docPath) {
    try {
      await fs.access(docPath);
      const content = await fs.readFile(docPath, "utf-8");
      // Check for an exact plugin-written confirm marker (bilingual).
      // Uses precise anchor text to avoid false positives on user-authored
      // headings that share a prefix (e.g. "## 用户确认流程", "## User Confirmation Guide").
      if (CONFIRM_MARKER_RE.test(content)) {
        if (isChild) return { result: "no-gate" };
        if (meta.confirmGateDeferredAt) {
          ctx.session.updateMeta({ confirmGateDeferredAt: undefined });
        }
        return { result: "no-gate" };
      }
    } catch {
      // File doesn't exist — proceed with gate
    }
  }

  // Phase 1 / 181: child/subagent bypass. Reaching this point means the real
  // confirm-gate condition holds (plan/review + manual, or smart+needConfirm).
  // A child must never present the owner dialog or mutate gate state: it stays
  // pending with zero side effects, before the smart-complex marker write, the
  // deferral stamp, the present-time stamp refresh, ui.select and ui.notify.
  if (isChild) {
    await writeAuditLog("confirm_gate_suppressed_child", {
      pipelineId: meta.pipelineId,
      stage: currentStage,
      source,
      sessionFile: sessionFile ?? "",
    });
    return { result: "handled", action: "pending", deferred: true };
  }

  // Smart mode + needConfirm=true: write "## 智能确认：复杂" marker first
  if (mode === "smart" && needConfirm === true && docPath) {
    const timestamp = new Date().toISOString();
    const lines = [
      "",
      "## 智能确认：复杂",
      "",
      `> Complexity assessment timestamp: ${timestamp}`,
      "",
    ];
    await writeConfirmMarker(config, ctx, meta, docPath, lines, "confirm_smart_complex");
  }

  // Phase 2 fix / 181 (review #1→#2): clear a stale deferral stamp when the
  // user has already been presented the dialog (reask exists for the current
  // stage). This restores the 180 defer-timeout semantics: the timeout is
  // measured from the current deferral start, not from a stale presentation-
  // time anchor. Without this, a presentation followed by a long idle and a
  // subagent start would immediately trigger "timeout" and pop the dialog
  // while the subagent is live — the 179 G5/G7 collateral-Esc failure mode.
  //
  // Re-read meta after updateMeta: production createSessionState.updateMeta()
  // returns a new object via spread ({ ...current, ...patch }) without mutating
  // the caller's reference (session-state.ts:174), and getMeta() returns a
  // fresh JSON.parse on every call. Without the re-read, the local `meta`
  // snapshot still carries the stale stamp and evaluateConfirmGateDeferral
  // would still compute "timeout" (review round-2 finding).
  {
    const staleStamp = getEffectiveDeferredStamp(meta);
    const deferTimeoutMs = config.spawnWaitTimeoutMs ?? DEFAULT_SPAWN_WAIT_TIMEOUT_MS;
    if (
      staleStamp &&
      meta.confirmGateReask?.stage === currentStage &&
      Date.now() - staleStamp.at >= deferTimeoutMs
    ) {
      ctx.session.updateMeta({ confirmGateDeferredAt: undefined });
      meta = (ctx.session.getMeta() ?? meta) as SessionMeta;
    }
  }

  // Phase 4 / 179 (G5/G7): defer the popup while any top-level subagent is live.
  // A subagent-window Esc collateral-cancels the owner dialog; presenting only
  // when no subagent runs removes that failure mode entirely. The bounded
  // timeout guarantees the gate still pops under a hanging unrelated subagent.
  const deferral = evaluateConfirmGateDeferral(config, meta);
  if (deferral === "defer") {
    // Phase 1 (180): read the effective stamp (current visit only). A stale
    // stamp from a previous visit is treated as absent, so the first deferral
    // of the new visit re-stamps and re-emits the audit/notify (visibility).
    const existing = getEffectiveDeferredStamp(meta);
    // Audit and notify only the FIRST deferral of this deferral window (plan G5/G7);
    // subsequent settles stay silent to avoid audit noise and repeated UI notifications.
    if (!existing) {
      ctx.session.updateMeta({ confirmGateDeferredAt: { stage: currentStage, at: Date.now() } });
      await writeAuditLog("confirm_gate_deferred", {
        pipelineId: meta.pipelineId,
        stage: currentStage,
        reason: "top_level_subagent_live",
      });
      ui.notify(ctx, `${currentStage} confirmation deferred until running subagents settle.`);
    } else if (
      shouldEmitWithinWindow(
        `confirm_gate_defer_repeat:${meta.pipelineId}:${currentStage}`,
        AUDIT_THROTTLE_WINDOW_MS,
      )
    ) {
      // Phase 2 / 180: a repeat deferral within the same window stays silent for
      // notifications (bd0886a noise reduction), but a throttled audit keeps the
      // number of deferral rounds observable (F2 blind-spot).
      await writeAuditLog("confirm_gate_defer_repeat", {
        pipelineId: meta.pipelineId,
        stage: currentStage,
        waitedMs: String(Date.now() - existing.at),
        source,
      });
    }
    return { result: "handled", action: "pending", deferred: true };
  }
  if (deferral === "timeout") {
    const timeoutMs = config.spawnWaitTimeoutMs ?? DEFAULT_SPAWN_WAIT_TIMEOUT_MS;
    await writeAuditLog("confirm_gate_defer_timeout", {
      pipelineId: meta.pipelineId,
      stage: currentStage,
      waitedMs: String(timeoutMs),
    }, "warn");
    ui.notify(
      ctx,
      `${currentStage} confirmation gate timeout: a subagent is still running. ` +
        formatConfirmGatePendingCopy(config, currentStage),
    );
  }
  // Phase 2 / 181: ensure a durable trace exists for `/pipeline-resume` across
  // reloads, but only when no effective stamp is already present. Refreshing
  // the anchor at every presentation would shift the defer-timeout window away
  // from the actual deferral start, re-opening the 179 G5/G7 collateral-Esc
  // failure (review #1 fix). When an effective stamp already exists (set by a
  // prior deferral of this visit) it is preserved as the defer-window anchor;
  // its presence is sufficient for `detectPendingConfirmGate` to identify the
  // pending gate on reload. Approve/Reject still clear it when the gate resolves.
  if (!getEffectiveDeferredStamp(meta)) {
    ctx.session.updateMeta({
      confirmGateDeferredAt: {
        stage: currentStage,
        at: Date.now(),
      },
    });
  }

  // Present TUI dialog
  const rawSelect = ctx.ui?.select;
  if (!rawSelect) {
    // No UI available — pending (notify + no advance, no count change).
    // Phase 2 / 180: this is now the ONLY `confirm_pending` emitter; Esc/dismiss
    // is attributed via confirm_gate_dismissed / _interrupted above.
    await writeAuditLog("confirm_pending", {
      pipelineId: meta.pipelineId,
      stage: currentStage,
      reason: "no ui.select available",
    });
    ui.notify(ctx, `${currentStage} stage requires human confirmation. Awaiting UI interaction.`);
    return { result: "handled", action: "pending" };
  }

  // Build dialog options based on stage
  // When defaultReject is true for review, reorder to put Reject first (simulates default selection)
  const options = currentStage === "plan"
    ? ["Approve & Advance", "Reject & Rework (back to clarify)", "Cancel"]
    : defaultReject
      ? ["Reject & Send to Fix", "Approve & Complete"]
      : ["Approve & Complete", "Reject & Send to Fix"];

  const selectStartedAt = Date.now();
  const choice = await rawSelect(
    `${currentStage} confirmation gate: please select an action`,
    options,
  );

  // Handle Esc / undefined.
  // Phase 2 / 180: split the dismiss into a genuine user Esc vs a fast
  // collateral cancel, using the shared DECISION_DISMISS_INTERRUPT_MS threshold
  // (aligned with flow-state.ts's decision-menu precedent). Return value and
  // notify text are unchanged — only the audit attribution is enriched.
  if (choice === undefined) {
    const elapsedMs = Date.now() - selectStartedAt;
    const reaskCount = meta.confirmGateReask?.stage === currentStage
      ? meta.confirmGateReask.count
      : 0;
    const interrupted = elapsedMs < DECISION_DISMISS_INTERRUPT_MS;
    await writeAuditLog(
      interrupted ? "confirm_gate_dismiss_interrupted" : "confirm_gate_dismissed",
      {
        pipelineId: meta.pipelineId,
        stage: currentStage,
        mode,
        action: interrupted ? "collateral_suspect" : "user_esc",
        elapsedMs: String(elapsedMs),
        reaskCount: String(reaskCount),
        source,
      },
    );
    ui.notify(ctx, `${currentStage} confirmation cancelled. Awaiting marker or re-trigger.`);
    return { result: "handled", action: "pending" };
  }

  // Dispatch based on choice
  if (choice.startsWith("Approve")) {
    // Determine target stage
    const toStage = currentStage === "plan"
      ? (stageConfig.nextStage ?? "develop")
      : "completed";

    const ok = await advanceConfirmApproved(config, ctx, meta, currentStage, toStage, ui);
    if (ok) {
      return { result: "handled", action: "advanced", toStage };
    }
    // Advance failed — fall through to pending
    return { result: "handled", action: "pending" };
  }

  if (choice.startsWith("Reject")) {
    // Determine reject target stage
    const toStage = currentStage === "plan" ? "clarify" : "fix";

    // Increment rejection counter
    const nextCount = (meta.confirmRejections ?? 0) + 1;
    const maxRejections = resolveConfirmMaxRejections(config, stageConfig);

    if (nextCount > maxRejections) {
      // Overflow — handle according to config
      const overflowResult = await handleConfirmOverflow(config, ctx, meta);
      if (overflowResult === "terminate") {
        // Abort pipeline
        ctx.session.updateMeta({
          flowState: "aborted",
          terminateReason: "confirm_overflow",
        });
        ui.notify(ctx, `Pipeline aborted: ${currentStage} confirm rejection limit exceeded.`);
        return { result: "handled", action: "aborted" };
      }
      if (overflowResult === "pending") {
        // No UI — pending (no advance, no count change)
        ui.notify(ctx, `${currentStage} confirm overflow. Awaiting UI interaction.`);
        return { result: "handled", action: "pending" };
      }
      // overflowResult === "continue": reset counter to 0 and route
      const routedContinue = await routeConfirmReject(config, ctx, meta, currentStage, toStage, 0);
      if (!routedContinue) {
        // Routing aborted (maxLoopCycles freeze) — gate handled but frozen
        return { result: "handled", action: "aborted" as const };
      }
      return { result: "handled", action: "routed", toStage };
    }

    // Not exceeded — route with incremented counter
    const routed = await routeConfirmReject(config, ctx, meta, currentStage, toStage, nextCount);
    if (!routed) {
      // Routing aborted (maxLoopCycles freeze) — gate handled but frozen
      return { result: "handled", action: "aborted" as const };
    }
    return { result: "handled", action: "routed", toStage };
  }

  // Cancel
  await writeAuditLog("confirm_cancelled", {
    pipelineId: meta.pipelineId,
    stage: currentStage,
    action: "user_cancelled",
  });
  ui.notify(ctx, `${currentStage} confirmation cancelled.`);
  return { result: "handled", action: "pending" };
}

/**
 * Phase 3 / 180: Detects a pending manual confirm gate that `/pipeline-resume`
 * can re-enter.
 *
 * The predicate mirrors the gate's own preconditions:
 * - current stage is plan or review
 * - the stage's confirm mode is "manual"
 * - a persisted trace of a prior gate interaction exists for this stage —
 *   either `confirmGateReask` scoped to the stage, or an *effective*
 *   `confirmGateDeferredAt` (Phase 1 valid-window stamp)
 * - the stage document does not already carry the confirm marker
 *
 * The re-ask count is intentionally NOT part of the predicate: `/pipeline-resume`
 * stays a deterministic entry point even after the bounded auto re-ask budget is
 * exhausted (V4). The gate itself remains the idempotency authority (stage guard,
 * marker check, deferral check) — the predicate only decides whether to call it.
 *
 * Fail-open: an unresolvable or unreadable stage document is treated as
 * "no marker" (consistent with the gate's own read guard).
 *
 * @param config - Pipeline configuration
 * @param meta - Current session metadata
 * @returns true when a pending manual confirm gate should be re-presented
 */
export async function detectPendingConfirmGate(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<boolean> {
  const stage = meta.currentStage;
  if (stage !== "plan" && stage !== "review") return false;

  const stageConfig = config.stages[stage];
  if (stageConfig?.confirm?.mode !== "manual") return false;

  // A prior gate interaction must have left a durable trace for this stage.
  const reaskHit = meta.confirmGateReask?.stage === stage;
  const deferredHit = getEffectiveDeferredStamp(meta) !== undefined;
  if (!reaskHit && !deferredHit) return false;

  const docPath = await resolveStageDocPath(config, meta, stage);
  if (!docPath) return true;
  try {
    await fs.access(docPath);
    const content = await fs.readFile(docPath, "utf-8");
    if (CONFIRM_MARKER_RE.test(content)) return false;
  } catch {
    // File missing/unreadable → treat as no marker (fail-open, same as the gate)
  }
  return true;
}

/**
 * Phase 3 / 180: Shared confirm-gate accounting.
 *
 * Extracted verbatim from agent-settled's post-gate bookkeeping so the
 * `/pipeline-resume` re-entry path and the owner auto re-ask chain share exactly
 * the same re-ask semantics (DRY).
 *
 * Semantics:
 * - owner + pending + NOT a system deferral → increment the stage-scoped re-ask count
 * - owner + advanced/routed → clear the re-ask bookkeeping
 * - everything else (aborted / no-gate / deferred / child) → no accounting
 *
 * A system deferral (`gate.deferred`) must NOT consume the re-ask budget,
 * otherwise the bounded timeout fallback becomes unreachable (fb9822d).
 *
 * @param session - Session state writer (updateMeta)
 * @param meta - Current session metadata (stage + prior re-ask count)
 * @param gate - Result returned by maybeHandleConfirmGate
 * @param isChild - Whether the calling session is a child/subagent
 */
export function recordConfirmGateOutcome(
  session: { updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined },
  meta: SessionMeta,
  gate: ConfirmGateResult,
  isChild: boolean,
): void {
  if (gate.result !== "handled") return;

  if (!isChild && gate.action === "pending" && !gate.deferred) {
    const reask = meta.confirmGateReask;
    session.updateMeta({
      confirmGateReask: {
        stage: meta.currentStage,
        count: (reask?.stage === meta.currentStage ? reask.count : 0) + 1,
      },
    });
  } else if (!isChild && (gate.action === "advanced" || gate.action === "routed")) {
    session.updateMeta({ confirmGateReask: undefined });
  }
}

/**
 * Type alias for the context shape expected by confirm gate functions.
 * Matches the RuntimeCtx shape used by callers (agent-settled, stage-advancer).
 */
export type ConfirmGateCtx = {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: {
    notify: (msg: string) => void;
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    transition?: (ctx: unknown, from: string, to: string) => void;
    clearStage?: (ctx: unknown) => void;
  };
  pi?: { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void };
};

/**
 * Dependencies injected into the stage advancer for verification execution.
 */
export interface StageAdvancerDeps {
  /** Dependency-injected shell execution function (replaces child_process.execSync) */
  execFn?: ExecFn;
}

/**
 * Creates the `stage_advance` tool.
 *
 * When invoked by the agent:
 * 1. Reads the current stage from SessionMeta.
 * 2. Determines the target stage (optional `nextStage` arg overrides config default).
 * 3. Validates the target stage exists and differs from the current stage.
 * 4. If the current stage requires verification (`verify.require=true`), runs
 *    `runVerification` first — advances only on success.
 * 5. Updates metadata and performs the UI stage transition.
 *
 * @param config - The pipeline configuration
 * @param deps - Optional dependencies (execFn for shell execution in verifiers)
 * @returns A Tool object for the "stage_advance" tool
 */
export function createStageAdvancer(config: PipelineConfig, deps?: StageAdvancerDeps): Tool {
  const ui = createPipelineUI(config);
  return {
    name: "stage_advance",
    description:
      "Advance the pipeline to the next stage. Reads the current stage from session metadata, " +
      "looks up the configured next stage, and updates the session state. " +
      "If the current stage has verification enabled, runs the verification gate first — " +
      "advances only when verification passes. " +
      "Optionally accepts a `nextStage` parameter to override the default transition target " +
      "(e.g. review → fix instead of review → completed). " +
      "Supports `skipVerify: true` as an escape hatch for verification configuration errors " +
      "(EISDIR/empty path/directory/unresolved placeholder) — will be rejected when no " +
      "config-class error is present. " +
      "Call this when the current stage's work is complete and validated.",
    parameters: {
      type: "object",
      properties: {
        nextStage: {
          type: "string",
          description:
            "Override the default next stage target. Must be a valid stage name " +
            "defined in the pipeline config and different from the current stage. " +
            "When omitted, uses the stage's configured nextStage.",
        },
        skipVerify: {
          type: "boolean",
          description:
            "Skip the verification gate and advance directly. " +
            "Only allowed when the current verification failure is a config-class error " +
            "(EISDIR, empty path, directory path, or unresolved requirementDoc placeholder). " +
            "Will be rejected if no config-class error is detected.",
        },
        needConfirm: {
          type: "boolean",
          description:
            "Smart-confirm mode only: set true when the stage work is complex and requires " +
            "human confirmation before advancing. Omit/false advances automatically " +
            "(recorded as confirm_smart_skip in the audit log).",
        },
        reviewConclusion: {
          type: "string",
          enum: ["pass", "fail"],
          description:
            "Review verdict declaration (review stage only). " +
            "\"fail\" auto-routes to fix stage without going through the confirm gate. " +
            "\"pass\" proceeds to the original verify + confirm gate flow. " +
            "Omit to fall back to the default verify + manual confirm gate behavior.",
        },
      },
      required: [],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const rawMeta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 2b (173) C3: dormant guard — guidance message
      if (!rawMeta || isDormant(rawMeta)) {
        return { message: "No active pipeline. Run /pipeline-start <doc>." };
      }
      const meta: SessionMeta = rawMeta;
      const currentStage: PipelineStage = meta.currentStage;

      // Phase 4 (143): Hash integrity check — if current stage has a summary
      // with a hash mismatch, block advance and prompt for re-entry.
      // Only check the current stage's summary (not all stages).
      if (meta.summaries[currentStage]) {
        const currentCheck = checkStageSummaryHash(meta, currentStage);
        if (currentCheck && !currentCheck.match) {
          const mismatchedStage = currentCheck.stage;
          return {
            success: false,
            message:
              `Summary '${mismatchedStage}' has been modified manually (hash mismatch). ` +
              `Cannot advance. Re-enter stage '${mismatchedStage}' to regenerate summary, ` +
              `or call stage_advance({ nextStage: "${mismatchedStage}" }) to confirm re-entry.`,
            mismatchedStage,
            hint: `stage_advance({ nextStage: "${mismatchedStage}" })`,
          };
        }
      }

      // (a) Intercept completed stage
      if (currentStage === "completed") {
        await safeWriteStageAudit(config, "stage_advance_failed", meta, {
          fromStage: "completed",
          reason: "already_completed",
        }, "warn");
        return {
          success: false,
          message: "Pipeline is already completed",
          currentStage: "completed",
        };
      }

      const stageConfig = config.stages[currentStage];

      // (b) Determine target stage: explicit arg overrides static config
      const argNextStage = typeof args.nextStage === "string" ? args.nextStage.trim() : "";
      const resolvedTarget = (argNextStage ? (argNextStage as PipelineStage) : stageConfig.nextStage);

      // (c) Target legality validation
      if (resolvedTarget !== null && !(resolvedTarget in config.stages)) {
        await safeWriteStageAudit(config, "stage_advance_failed", meta, {
          fromStage: currentStage,
          reason: "invalid_next_stage",
          target: String(resolvedTarget),
        }, "warn");
        return {
          success: false,
          message: `Invalid nextStage "${resolvedTarget}": not defined in pipeline config`,
          currentStage,
        };
      }
      if (resolvedTarget !== null && resolvedTarget === currentStage) {
        await safeWriteStageAudit(config, "stage_advance_failed", meta, {
          fromStage: currentStage,
          reason: "same_stage",
          target: String(resolvedTarget),
        }, "warn");
        return {
          success: false,
          message: `Invalid nextStage "${resolvedTarget}": cannot advance to the same stage`,
          currentStage,
        };
      }

      // Phase 0 (182) G5: Fix stage must route through review — block direct
      // advancement to terminal states (completed/awaiting_human) from fix.
      // This enforces the quality loop: fix → review → (confirm) → completed.
      if (currentStage === "fix" && (resolvedTarget === "completed" || resolvedTarget === "awaiting_human")) {
        await safeWriteStageAudit(config, "stage_advance_failed", meta, {
          fromStage: currentStage,
          reason: "fix_terminal_blocked",
          target: String(resolvedTarget),
        }, "warn");
        return {
          success: false,
          message: `Fix stage must route back to "review" for re-review. nextStage "${resolvedTarget}" is not allowed from "fix".`,
          currentStage,
        };
      }

      // (c2) Review conclusion declaration handling (163 Goal 2)
      const argReviewConclusion = typeof args.reviewConclusion === "string" ? args.reviewConclusion.trim() : "";
      // Track declaration so agent-settled can distinguish "declared but not advanced"
      // (verify fail / confirm gate pending / overflow pending) from "not declared".
      if (currentStage === "review" && argReviewConclusion) {
        ctx.session.updateMeta({ reviewConclusionDeclared: true });
      }
      if (argReviewConclusion && currentStage !== "review") {
        // reviewConclusion passed in non-review stage — ignore and audit
        await writeAuditLog("review_conclusion_ignored", {
          pipelineId: meta.pipelineId,
          stage: currentStage,
          reviewConclusion: argReviewConclusion,
          reason: "reviewConclusion only applies to review stage",
        }, "warn");
        // Fall through to original flow (do not return)
      } else if (currentStage === "review" && argReviewConclusion === "fail") {
        // Review declared fail → auto-route to fix (no counting, no overflow)
        // Bug 4 fix: explicit declaration also does not count, matching auto-route behavior
        const routed = await routeConfirmReject(config, ctx, meta, "review", "fix", meta.confirmRejections ?? 0, {
          reason: "reviewConclusion declared fail (explicit, no count)",
          auditEvent: "review_auto_route_fix",
        });
        if (!routed) {
          // Routing aborted (e.g. maxLoopCycles freeze) — return failure
          const frozenMeta = ctx.session.getMeta() as SessionMeta;
          return {
            success: false,
            message: `Max loop cycles reached. Cannot route to "fix". Pipeline frozen. Use the decision menu to continue.`,
            currentStage: frozenMeta.currentStage,
          };
        }
        const updatedMeta = ctx.session.getMeta() as SessionMeta;
        return { success: true, message: "Review declared fail. Routed to fix.", currentStage: updatedMeta.currentStage };
      }
      // reviewConclusion === "pass" or not provided → fall through to original verify + confirm gate flow

      // (d) Verification gate: run when stage requires it (unless skipVerify is valid)
      const argSkipVerify = args.skipVerify === true;
      if (stageConfig.verify?.require && !argSkipVerify) {
        // P1: Pre-check required files before running full verification
        const precheck = await precheckRequiredFiles(config, meta);
        if (!precheck.passed) {
          // Required files not yet produced — return guidance without failure/freeze
          return {
            success: false,
            message: `Required deliverables not yet produced. Please create: ${precheck.missing.join(", ")}`,
            precheck: true,
            missing: precheck.missing,
          };
        }

        // Phase 4 (162): auto-write confirm marker for plan stage (auto mode).
        const ctxForAutoWrite = { ui: { notify: (msg: string) => ui.notify(ctx, msg) } };
        await autoWriteConfirmMarker(config, ctxForAutoWrite, meta, ui);

        const messages = extractAssistantMessages(ctx._ctx);
        // Extract tool call records for selfVerifySkip (same as agent-settled hook path)
        const toolCallRecords = extractToolCallRecords(ctx._ctx);

        // Phase 4 (162): defer plan marker rule when confirm mode is manual/smart (C2 fix).
        const deferPatterns = shouldDeferPlanMarkerRule(currentStage, stageConfig) ? [PLAN_CONFIRM_MARKER_RULE] : [];

        const vr = await runVerification(config, meta, messages, {
          execFn: deps?.execFn,
          toolCallRecords,
          deferContentPatterns: deferPatterns,
        });

        // 148 Phase 3: Config-error skip → treat as pass with notify/audit
        if (vr.skipped) {
          const errorSummary = vr.configErrors?.join("; ") ?? "unknown config error";
          ui.notify(ctx, `Verification config error: ${errorSummary}. Verification skipped. See guide.md for correct rule syntax.`);
          await safeWriteStageAudit(config, "verify_config_skip", meta, {
            fromStage: currentStage,
            errorCount: String(vr.configErrors?.length ?? 0),
            errors: errorSummary,
          }, "warn");
          // Skip verify-fail branch, continue to advance below
        } else {
          // S1: Verification passes only on structured rules (rulePassed)
          const verifyPassed = vr.rulePassed;
          if (!verifyPassed) {
            // Audit verify-gate failure
            await safeWriteStageAudit(config, "stage_advance_failed", meta, {
              fromStage: currentStage,
              reason: "verify_failed",
            }, "warn");
            // Build shared result shape for applyVerifyFail
            const sharedResult = {
              structuredResult: vr.verifyResult?.structured,
              ruleMissing: vr.ruleMissing,
              verifyResult: vr.verifyResult,
            };
            const failResult = await applyVerifyFail(ctx, meta, currentStage, sharedResult, "tool", ui, config);
            return {
              success: false,
              message: failResult.message,
              failures: failResult.failures,
            };
          }
        }

        // Phase 4 (162): confirm gate after verify passes.
        const confirmMode = stageConfig.confirm?.mode ?? "auto";
        if (confirmMode !== "auto") {
          const ctxForGate = {
            session: ctx.session,
            ui: ctx.ui,
            pi: (ctx as { pi?: { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void } }).pi,
          };
          // Phase 1 / 181: pass the real session role so child sessions take the
          // zero-side-effect bypass instead of presenting the owner dialog.
          const role = detectSessionRole(ctx);
          const gate = await maybeHandleConfirmGate(config, ctxForGate, meta, ui, {
            mode: confirmMode,
            needConfirm: args.needConfirm === true,
            isChild: role.isChild,
            sessionFile: role.sessionFile,
          });
          if (gate.result === "handled") {
            if (gate.action === "advanced" || gate.action === "routed") {
              const updatedMeta = ctx.session.getMeta() as SessionMeta;
              return {
                success: true,
                message: gate.action === "advanced"
                  ? `Confirm approved. Stage advanced to ${gate.toStage ?? "next"}.`
                  : `Confirm rejected. Stage routed to ${gate.toStage ?? "rework"}.`,
                currentStage: updatedMeta.currentStage,
              };
            }
            if (gate.action === "aborted") {
              // Distinguish abort source: maybeHandleConfirmGate returns "aborted" for both
              // confirm_overflow (flowState="aborted") and maxLoopCycles freeze (flowState="blocked"
              // via freezeAndPrompt in routeConfirmReject). Use fresh meta to pick the right message.
              const abortedMeta = ctx.session.getMeta() as SessionMeta;
              const isMaxLoopCycles = abortedMeta.flowState === "blocked";
              return {
                success: false,
                message: isMaxLoopCycles
                  ? "Max loop cycles reached — stage visit would exceed loop limit. Pipeline frozen."
                  : "Pipeline aborted: confirm rejection limit reached.",
              };
            }
            // pending
            return {
              success: false,
              pending: true,
              message: formatConfirmGatePendingCopy(config, currentStage),
            };
          }
          // no-gate (smart + non-complex): audit skip + clear counter + proceed to advance
          if (confirmMode === "smart" && args.needConfirm !== true) {
            await safeWriteStageAudit(config, "confirm_smart_skip", meta, {
              fromStage: currentStage,
              reason: "not complex",
            }, "info");
            ctx.session.updateMeta({ confirmRejections: undefined });
          }
        }
        // Verification passed — continue to advance
      } else if (stageConfig.verify?.require && argSkipVerify) {
        // skipVerify=true: abuse guard — only allowed when config-class error present
        // Use persistent verifyConfigError marker (survives resume) instead of
        // checking verifyFailures which are cleared by resume decision.
        if (!meta.verifyConfigError) {
          await safeWriteStageAudit(config, "stage_advance_failed", meta, {
            fromStage: currentStage,
            reason: "skipVerify_rejected",
          }, "warn");
          return {
            success: false,
            message: "skipVerify is only allowed when a verification config-class error is detected (EISDIR/empty path/directory/unresolved requirementDoc placeholder)",
          };
        }
        // Config error confirmed — skip verification and proceed to advance
      }

      // (e) Advance to target stage
      // Record stage visit via shared helper (DRY with handoff, routeConfirmReject, verify-advance)
      const advanceTarget = resolvedTarget ?? "completed";
      const maxCycles = meta.maxLoopCycles ?? config.maxLoopCycles ?? 3;
      const visitResult = recordStageVisit(meta, advanceTarget, maxCycles);

      if (!visitResult.ok) {
        // Max loop cycles reached — freeze and return error (aligned with handoff)
        ctx.session.updateMeta(visitResult.patch);
        await import("./flow-state").then(({ freezeAndPrompt }) =>
          freezeAndPrompt(ctx, meta, "max_loop_cycles", config),
        );
        return {
          success: false,
          message:
            `Max loop cycles (${maxCycles}) reached. ` +
            `Pipeline cannot cycle back to "${advanceTarget}". ` +
            `Pipeline frozen. Use the decision menu to continue.`,
        };
      }

      // C2: Clear advancedThisTurn (set undefined) BEFORE spawn so the subagent's JOIN
      // does not inherit the flag. If the subagent inherited advancedThisTurn=true, its
      // first settle would be eaten by C2 (agent-settled.ts:90-99), stalling the pipeline.
      // Same pattern as routeConfirmReject (line ~378) — see reaudit Minor 2 fix.
      // If spawn fails entirely, the flag is re-set after spawn returns (see below) to
      // preserve the parent-session wake settle guard.
      // Pass only the delta (not a full snapshot) to avoid overwriting concurrent
      // writes from shared source during async operations (e.g., runVerification).
      ctx.session.updateMeta({
        ...visitResult.patch,
        previousStage: currentStage,
        currentStage: advanceTarget,
        stageStartTime: Date.now(),
        loopCount: 0,
        currentStepIndex: 0,
        verifyFailures: [],
        verifyAttempts: 0, // Reset per-stage attempt counter on stage advance (168 Phase 0)
        verifyConfigError: undefined,
        violations: [],
        advancedThisTurn: undefined,
      });

      if (resolvedTarget === null || resolvedTarget === "completed") {
        ui.clearStage(ctx);
        // Phase 4 (169) P2-4 fix: re-read fresh meta for terminal audit event.
        // The local `meta` snapshot predates updateMeta above (which appended "completed"
        // to stageVisitOrder), so using it would produce audit fields that disagree with
        // the meta.json that was just written. Fresh meta keeps audit/data consistent.
        const freshMetaForAudit = ctx.session.getMeta() as SessionMeta;
        await safeWriteStageAudit(config, "pipeline_completed", freshMetaForAudit, {
          finalStage: currentStage,
          loopCycleCount: String(freshMetaForAudit.loopCycleCount ?? 0),
          stageVisitOrder: (freshMetaForAudit.stageVisitOrder ?? []).join(","),
        });
        return {
          success: true,
          message: resolvedTarget === null
            ? "Pipeline completed — no further stages. Next round: run /pipeline-start <doc> in this session, or use /new first for a clean context."
            : `Advanced from "${currentStage}" to "completed". Next round: run /pipeline-start <doc> in this session, or use /new first for a clean context.`,
          currentStage: "completed",
        };
      }

      // Success audit for non-terminal advance
      await safeWriteStageAudit(config, "stage_advance", meta, {
        fromStage: currentStage,
        toStage: resolvedTarget,
        override: argNextStage ? "yes" : "no",
      });

      ui.transition(ctx, currentStage, resolvedTarget);

      // Phase 1 (169): Spawn subagent for the target stage after transition.
      // freshMetaForSpawn reads AFTER the clear above, so the subagent JOIN sees
      // advancedThisTurn=undefined (C2 safe — see reaudit Minor 2 alignment).
      const freshMetaForSpawn = ctx.session.getMeta() as SessionMeta;
      const toolSpawnResult = await spawnStageSubagent(
        (ctx as { pi?: unknown }).pi,
        config,
        resolvedTarget,
        freshMetaForSpawn,
        {
          ui: { notify: (msg: string) => { ui.notify(ctx, msg); } },
          session: ctx.session,
          runtimeCtx: ctx,
        },
      );

      // Tool-path C2 guard (aligned with routeConfirmReject, line ~416-418):
      // If the full spawn chain failed (no RPC, no fallback, no deferred), re-set
      // advancedThisTurn=true so the parent session's wake-triggered settle is still
      // guarded by C2. When spawn succeeded or was deferred, the flag stays cleared —
      // subagent JOIN inherits undefined, its first settle runs verification normally.
      // deferred: spawn is queued; the eventual dequeue will run verification.
      if (!toolSpawnResult.spawned && !toolSpawnResult.fallback && !toolSpawnResult.deferred) {
        ctx.session.updateMeta({ advancedThisTurn: true });
      }

      return {
        success: true,
        message: `Advanced from "${currentStage}" to "${resolvedTarget}"`,
        previousStage: currentStage,
        currentStage: resolvedTarget,
      };
    },
  };
}
