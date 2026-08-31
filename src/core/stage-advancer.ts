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
import { DEFAULT_CONFIRM_MAX_REJECTIONS } from "../constants";
import { findLatestReviewReport } from "../utils/review-conclusion";
import { spawnStageSubagent } from "../utils/subagent-rpc";
import { recordStageVisit } from "../utils/stage-visit";

// ─── Confirm Gate Types (Phase 3 — 162) ──────────────────────────────────────

/**
 * Result of the confirm gate check.
 * - "no-gate": gate not triggered (e.g. marker already present, auto mode, etc.)
 * - "handled": gate was triggered and handled (action disambiguates the outcome)
 */
export type ConfirmGateResult =
  | { result: "no-gate" }
  | { result: "handled"; action: "advanced" | "routed" | "pending" | "aborted"; toStage?: PipelineStage };

/**
 * The plan-stage content-pattern rule used for the bilingual confirm marker.
 * Exported for use by agent-settled.ts when constructing deferContentPatterns.
 */
export const PLAN_CONFIRM_MARKER_RULE = {
  path: "docs/design/*_plan.md",
  pattern: "^## (用户确认|User Confirmation)",
};

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
  });

  if (spawnResult.spawned || spawnResult.fallback) {
    // Subagent spawned — skip generic wake to prevent dual execution
    await writeAuditLog("confirm_reject_wake_skipped", {
      pipelineId: meta.pipelineId,
      fromStage,
      toStage,
      reason: "subagent_spawned",
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

  // Reset rejection counter on approval (after marker write succeeds)
  ctx.session.updateMeta({ confirmRejections: undefined });

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
  opts: { mode: ConfirmMode; needConfirm?: boolean; defaultReject?: boolean },
): Promise<ConfirmGateResult> {
  const { mode, needConfirm, defaultReject } = opts;
  const currentStage = meta.currentStage;
  const stageConfig = config.stages[currentStage];

  // Precondition: only plan and review stages support confirm gate
  if (currentStage !== "plan" && currentStage !== "review") {
    return { result: "no-gate" };
  }

  // Smart mode: if needConfirm is not true, skip the gate (non-complex)
  if (mode === "smart" && needConfirm !== true) {
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
      if (/^## (?:用户确认：确认无误|User Confirmation: Confirmed)/m.test(content)) {
        return { result: "no-gate" };
      }
    } catch {
      // File doesn't exist — proceed with gate
    }
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

  // Present TUI dialog
  const rawSelect = ctx.ui?.select;
  if (!rawSelect) {
    // No UI available — pending (notify + no advance, no count change)
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

  const choice = await rawSelect(
    `${currentStage} confirmation gate: please select an action`,
    options,
  );

  // Handle Esc / undefined
  if (choice === undefined) {
    await writeAuditLog("confirm_pending", {
      pipelineId: meta.pipelineId,
      stage: currentStage,
      action: "esc_dismissed",
    });
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

      const meta = ctx.session.getMeta() as SessionMeta;
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
          const gate = await maybeHandleConfirmGate(config, ctxForGate, meta, ui, {
            mode: confirmMode,
            needConfirm: args.needConfirm === true,
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
              return {
                success: false,
                message: "Pipeline aborted: confirm rejection limit reached.",
              };
            }
            // pending
            return {
              success: false,
              pending: true,
              message: "Stage awaiting human confirmation. Stage not advanced.",
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

      // C2: Set advancedThisTurn flag to prevent agent_settled from triggering redundant verification
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
        advancedThisTurn: true,
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
            ? "Pipeline completed — no further stages"
            : `Advanced from "${currentStage}" to "completed"`,
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

      // Phase 1 (169): Spawn subagent for the target stage after transition
      const freshMetaForSpawn = ctx.session.getMeta() as SessionMeta;
      await spawnStageSubagent(
        (ctx as { pi?: unknown }).pi,
        config,
        resolvedTarget,
        freshMetaForSpawn,
        {
          ui: { notify: (msg: string) => { ui.notify(ctx, msg); } },
          session: ctx.session,
        },
      );

      return {
        success: true,
        message: `Advanced from "${currentStage}" to "${resolvedTarget}"`,
        previousStage: currentStage,
        currentStage: resolvedTarget,
      };
    },
  };
}
