/**
 * @module pipeline-start
 * /pipeline-start <doc_file.md> — initializes a pipeline run from a requirement document.
 * Supports three startup modes (config.startStageMode):
 * - "auto": Zero-interaction default (fresh → clarify; aborted → resume/new matrix).
 * - "confirm": Lightweight confirmation on resume-eligible aborted pipelines.
 * - "ask": Interactive TUI menu (new/resume/spec/cancel) with spec-stage jump.
 */

import fs from "node:fs";
import path from "node:path";
import type { PipelineConfig, PipelineStage, Command, SessionMeta, StartStageMode } from "../types";
import {
  DEFAULT_VERIFY_FILE,
  resolveStagePath,
  RESUMABLE_STAGES,
} from "../constants";
import { safeWriteAuditLog, safeWriteStageAudit } from "../utils/auditLog";
import { getFlowState, formatFrozenReason } from "../core/flow-state";
import { createPipelineUI } from "../core/pipeline-ui";
import { buildStageSequence } from "../utils/stage-sequence";
import {
  checkTemplateResidues,
  computeResidueFingerprint,
  readResidueGateStatus,
  writeResidueGateStatus,
} from "../core/template-residue-check";
import { registerSession } from "../utils/session-registry";
import { pingSubagents, spawnClarifySubagent, watchSubagentLifecycle } from "../utils/subagent-rpc";

/**
 * Writes the persistent TUI status bar showing current pipeline stage.
 * Safely no-ops when ctx/ui is unavailable or output.pipelineStage is off.
 *
 * @param ui - PipelineUI instance
 * @param ctx - Extension context (uses session.getMeta for dynamic stage)
 */
function syncStageStatusBar(ui: ReturnType<typeof createPipelineUI>, ctx?: any): void {
  const stage = ctx?.session?.getMeta?.()?.currentStage ?? "clarify";
  ui.setStage(ctx, stage);
}

/**
 * Checks that all 5 active stages have agentPath configured.
 * Skips disabled stages (require: false in JSON config).
 * Returns array of stage names missing agentPath.
 */
function checkAgentPaths(config: PipelineConfig): PipelineStage[] {
  const activeStages: PipelineStage[] = [
    "clarify", "plan", "develop", "review", "fix",
  ];
  const missing: PipelineStage[] = [];
  for (const stage of activeStages) {
    const stageConfig = config.stages[stage];
    // Skip disabled stages (aligned with checkVerifyFiles filter style)
    if (stageConfig?.disabled) continue;
    if (!stageConfig?.agentPath) {
      missing.push(stage);
    }
  }
  return missing;
}

/**
 * 147 Phase 6: Template-residue gate check.
 *
 * Blocks pipeline-start when `.pi/skills/` or `.pi/agents/` files still carry
 * unresolved `Template-TODO` placeholders. The check is pure-rule (no LLM).
 *
 * Short-circuit: if the persistent gate status file reports `passed=true` AND
 * the current fingerprint matches, the check is skipped entirely (cross-restart
 * idempotent).
 *
 * Failure modes:
 * - Clean residues → write gate status + proceed (return null).
 * - Residues + TUI available → block with a 2-choice select (re-check / cancel).
 * - Residues + no TUI → degrade to non-blocking notify + audit; proceed.
 *
 * @returns null when the check passes / degrades, or `{ success: false, error }`
 *   when the user cancels startup.
 */
async function templateResidueGate(
  config: PipelineConfig,
  ctx?: any,
): Promise<null | { success: false; error: string }> {
  // Short-circuit: persisted pass + matching fingerprint → skip re-scan
  try {
    const status = readResidueGateStatus(config.projectRoot, config.auditDir);
    if (status?.passed === true) {
      const currentFp = computeResidueFingerprint(config.projectRoot);
      if (status.fingerprint === currentFp) {
        // Fingerprints match — cached pass is still valid
        return null;
      }
      // Fingerprint drift — file content changed, re-check
    }
  } catch {
    // Any read failure → fail-open, proceed to full scan
  }

  const result = checkTemplateResidues(config.projectRoot);

  if (result.clean) {
    // Clean → persist gate status for future short-circuit
    try {
      const fingerprint = computeResidueFingerprint(config.projectRoot);
      writeResidueGateStatus(config.projectRoot, {
        passed: true,
        checkedAt: new Date().toISOString(),
        fingerprint,
      }, config.auditDir);
    } catch {
      // Write failure → fail-open (already clean, no blocking needed)
    }
    await safeWriteAuditLog("pipeline_start_template_residue_passed", {
      scanned: String(result.scanned),
    });
    return null;
  }

  // Residues found — hitList is recomputed inside the loop after each recheck
  // so that subsequent iterations display fresh file:line entries (Medium #2 fix).
  let hitList = result.hits
    .map(h => `  - ${h.file}:${h.line}: ${h.marker}`)
    .join("\n");

  const hasTui = typeof ctx?.ui?.select === "function";
  if (!hasTui) {
    // No TUI — degrade to non-blocking notify + audit
    const msg = `Template residue check: ${result.hits.length} unresolved placeholder(s). Fix Template-TODO markers before /pipeline-start.`;
    ctx?.ui?.notify?.(msg);
    if (ctx?.ui?.content) {
      try {
        ctx.ui.content(`# Template residue check (degraded — no TUI)\n\n${hitList}`);
      } catch {
        // content write failure is non-blocking
      }
    }
    await safeWriteAuditLog("pipeline_start_template_residue_degraded", {
      hits: String(result.hits.length),
      scanned: String(result.scanned),
    }, "warn");
    // Fail-open — don't write gate status, proceed
    return null;
  }

  // TUI available → blocking 2-choice loop
  while (true) {
    const choice: string | undefined = await ctx.ui.select(
      `Template residue check: ${result.hits.length} unresolved placeholder(s) found.\n${hitList}\n\nPlease fix Template-TODO markers before starting the pipeline.`,
      [
        "1. I've fixed them — re-check",
        "2. Cancel startup",
      ],
    );

    if (!choice || choice === "2" || choice === "2. Cancel startup") {
      await safeWriteAuditLog("pipeline_start_template_residue_blocked", {
        hits: String(result.hits.length),
        scanned: String(result.scanned),
        action: "cancelled",
      }, "warn");
      return {
        success: false,
        error: "Template residue check blocked pipeline start. Fix Template-TODO placeholders first.",
      };
    }

    // Re-check
    const recheck = checkTemplateResidues(config.projectRoot);
    if (recheck.clean) {
      try {
        const fingerprint = computeResidueFingerprint(config.projectRoot);
        writeResidueGateStatus(config.projectRoot, {
          passed: true,
          checkedAt: new Date().toISOString(),
          fingerprint,
        }, config.auditDir);
      } catch {
        // Write failure → fail-open
      }
      await safeWriteAuditLog("pipeline_start_template_residue_passed", {
        scanned: String(recheck.scanned),
        retries: "1",
      });
      return null;
    }
    // Still residues → loop with updated hit list
    result.hits.length = 0;
    result.hits.push(...recheck.hits);
    result.scanned = recheck.scanned;
    // Recompute hitList so the next iteration shows fresh file:line entries
    hitList = result.hits
      .map(h => `  - ${h.file}:${h.line}: ${h.marker}`)
      .join("\n");
  }
}

/**
 * Collects all stages reachable from `startStage` by following nextStage links.
 * Delegates to the authoritative `buildStageSequence` walker; wraps the result
 * in a Set for O(1) membership checks.
 *
 * @param config - Pipeline configuration
 * @param startStage - The starting stage
 * @returns Set of reachable stage names
 */
export function collectStagesFrom(
  config: PipelineConfig,
  startStage: PipelineStage,
): Set<PipelineStage> {
  return new Set<PipelineStage>(buildStageSequence(config, startStage));
}

/**
 * Checks for missing verify.md files across stages reachable from `startStage`.
 * When startStage is "clarify" (default), this is equivalent to checking all
 * active stages (backward compatible). When startStage is a later stage (e.g.
 * "develop"), only develop and its successors are checked.
 *
 * @param config - Pipeline configuration
 * @param startStage - The starting stage to check from (default "clarify")
 * @returns Array of stage names whose verify.md is missing
 */
function checkVerifyFiles(config: PipelineConfig, startStage: PipelineStage = "clarify"): PipelineStage[] {
  const missingStages: PipelineStage[] = [];
  const reachable = collectStagesFrom(config, startStage);
  const activeStages: PipelineStage[] = [
    "clarify", "plan", "develop", "review", "fix",
  ];

  for (const stage of activeStages) {
    if (!reachable.has(stage)) continue;
    const stageConfig = config.stages[stage];
    if (!stageConfig.verify?.require) continue;

    const verifyFile = stageConfig.verify.verifyFile
      ? path.isAbsolute(stageConfig.verify.verifyFile)
        ? stageConfig.verify.verifyFile
        : path.join(config.projectRoot, stageConfig.verify.verifyFile)
      : path.join(config.projectRoot, resolveStagePath(DEFAULT_VERIFY_FILE, stage));

    if (!fs.existsSync(verifyFile)) {
      missingStages.push(stage);
    }
  }

  return missingStages;
}

/**
 * Builds the reset SessionMeta for an aborted pipeline restart.
 *
 * Shared by the no-file and with-file aborted-restart branches to eliminate
 * duplication and ensure consistent field initialization.
 *
 * @param meta - Current (aborted) session metadata
 * @param config - Pipeline configuration (for maxLoops / maxLoopCycles)
 * @param requirementDoc - The requirement doc path to set (may come from meta or new file)
 */
function buildRestartMeta(
  meta: SessionMeta,
  config: PipelineConfig,
  requirementDoc: string | undefined,
): { pipelineId: string; newMeta: SessionMeta } {
  const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const newMeta: SessionMeta = {
    currentStage: "clarify",
    stageStartTime: Date.now(),
    pipelineId,
    domain: meta.domain ?? { id: "general", version: "latest", skillPath: "" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: config.maxLoops || 3,
    maxLoopCycles: config.maxLoopCycles ?? 3,
    flowState: "running",
    verifyAttempts: 0,
    verifyFailures: [],
    requirementDoc,

    // RC3: explicitly clear stage-chain residue so the new clarify pipeline does not
    // inherit old plan/develop chain state via updateMeta's spread merge semantics.
    // Without these explicit clears, stale fields from the previous pipeline would
    // persist and risk pipeline-handoff cycle-detection misfires / stale contextFiles.
    previousStage: undefined,
    stageVisitOrder: undefined,
    contextFiles: undefined,
    violations: [],
    advancedThisTurn: undefined,
    reviewConclusionDeclared: undefined,
    loopCycleCount: undefined,
    verifyConfigError: undefined,
    blockedReason: undefined,
    terminated: undefined,
    terminateReason: undefined,
    // Phase 4 (162): reset confirm rejection counter on restart
    confirmRejections: undefined,
  };
  return { pipelineId, newMeta };
}

/**
 * Builds SessionMeta for a new pipeline start (fresh / spec-stage jump).
 * Generalizes buildRestartMeta to support custom startStage.
 *
 * When startStage is "clarify" (default), behavior is identical to buildRestartMeta.
 * When startStage is a later stage (spec jump), previousStage and stageVisitOrder
 * are rebuilt to form a valid stage chain from "clarify" to startStage.
 *
 * @param meta - Current session metadata (may be empty for fresh start)
 * @param config - Pipeline configuration
 * @param requirementDoc - The requirement doc path
 * @param startStage - Starting stage (default "clarify")
 */
function buildStartMeta(
  meta: SessionMeta | undefined,
  config: PipelineConfig,
  requirementDoc: string,
  startStage: PipelineStage = "clarify",
): { pipelineId: string; newMeta: SessionMeta } {
  const pipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // For spec-stage jump, rebuild stage chain from clarify to startStage
  const previousStage = startStage === "clarify"
    ? undefined
    : resolvePreviousStage(config, startStage);
  const stageVisitOrder = startStage === "clarify"
    ? undefined
    : buildResumeVisitOrder(config, startStage);

  const newMeta: SessionMeta = {
    currentStage: startStage,
    stageStartTime: Date.now(),
    pipelineId,
    domain: meta?.domain ?? { id: "general", version: "latest", skillPath: "" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: config.maxLoops || 3,
    maxLoopCycles: config.maxLoopCycles ?? 3,
    flowState: "running",
    verifyAttempts: 0,
    verifyFailures: [],
    requirementDoc,

    // Spec jump: rebuilt stage chain
    previousStage,
    stageVisitOrder,

    // Clear stage-chain residue (same as buildRestartMeta)
    contextFiles: undefined,
    violations: [],
    advancedThisTurn: undefined,
    reviewConclusionDeclared: undefined,
    loopCycleCount: undefined,
    verifyConfigError: undefined,
    blockedReason: undefined,
    terminated: undefined,
    terminateReason: undefined,
    // Phase 4 (162): reset confirm rejection counter on start
    confirmRejections: undefined,
  };
  return { pipelineId, newMeta };
}

/**
 * Resolves the previous stage for a given stage by scanning config.stages
 * for the entry whose nextStage matches. Returns undefined when no such
 * entry exists (defensive: guards against misconfigured chains).
 *
 * Note: this function intentionally does NOT fall back to meta.previousStage;
 * when the config chain is incomplete the caller (buildResumeMeta) writes
 * previousStage=undefined so that stale values from prior runs are cleared
 * by updateMeta's spread merge.
 *
 * @param config - Pipeline configuration
 * @param stage - The target stage
 * @returns The preceding stage name, or undefined if unresolvable
 */
function resolvePreviousStage(
  config: PipelineConfig,
  stage: PipelineStage,
): PipelineStage | undefined {
  for (const s of Object.keys(config.stages) as PipelineStage[]) {
    if (config.stages[s]?.nextStage === stage) {
      return s;
    }
  }
  return undefined;
}

/**
 * Builds the stage visit order from "clarify" up to and including `stage`,
 * by walking the config.stages[s].nextStage chain. If the chain does not
 * reach the target stage (misconfiguration), falls back to [stage].
 *
 * @param config - Pipeline configuration
 * @param stage - The target stage (inclusive endpoint)
 * @returns Ordered stage sequence ending at `stage`
 */
export function buildResumeVisitOrder(
  config: PipelineConfig,
  stage: PipelineStage,
): PipelineStage[] {
  // Build full chain from clarify; slice up to and including target stage
  const sequence = buildStageSequence(config, "clarify");
  const targetIdx = sequence.indexOf(stage);
  // Defensive fallback: chain did not reach target stage (misconfiguration)
  return targetIdx === -1 ? [stage] : sequence.slice(0, targetIdx + 1);
}

/**
 * Builds SessionMeta for a pipeline resume (aborted restart preserving stage position).
 *
 * Field rebuild contract:
 * - Preserve: pipelineId, currentStage, requirementDoc, domain, summaries, contextFiles, maxLoops/maxLoopCycles
 * - Rebuild: previousStage (from config chain), stageVisitOrder (from clarify to currentStage)
 * - Clear: loopCount, currentStepIndex, verifyAttempts, verifyFailures, violations,
 *          advancedThisTurn, loopCycleCount, verifyConfigError, blockedReason,
 *          terminated, terminateReason
 * - Set: flowState="running", stageStartTime=Date.now()
 *
 * @param meta - Current (aborted) session metadata
 * @param config - Pipeline configuration
 * @returns New SessionMeta with preserved pipelineId and rebuilt stage chain fields
 */
function buildResumeMeta(
  meta: SessionMeta,
  config: PipelineConfig,
): SessionMeta {
  return {
    // Preserved fields
    pipelineId: meta.pipelineId,
    currentStage: meta.currentStage,
    requirementDoc: meta.requirementDoc,
    domain: meta.domain ?? { id: "general", version: "latest", skillPath: "" },
    summaries: meta.summaries ?? {},
    contextFiles: meta.contextFiles,
    maxLoops: config.maxLoops ?? meta.maxLoops ?? 3,
    maxLoopCycles: config.maxLoopCycles ?? meta.maxLoopCycles ?? 3,

    // Rebuilt fields
    previousStage: resolvePreviousStage(config, meta.currentStage),
    stageVisitOrder: buildResumeVisitOrder(config, meta.currentStage),

    // Cleared counters / transient state
    loopCount: 0,
    currentStepIndex: 0,
    verifyAttempts: 0,
    verifyFailures: [],
    violations: [],
    advancedThisTurn: undefined,
    reviewConclusionDeclared: undefined,
    loopCycleCount: undefined,
    verifyConfigError: undefined,
    // Phase 4 (162): reset confirm rejection counter on resume
    confirmRejections: undefined,

    // Cleared terminal / blocked state
    blockedReason: undefined,
    terminated: undefined,
    terminateReason: undefined,

    // Lifecycle
    flowState: "running",
    stageStartTime: Date.now(),
  };
}

/**
 * Unified resume execution path shared by auto / confirm / ask branches.
 *
 * Centralizes buildResumeMeta → updateMeta → syncStageStatusBar → dual audit
 * (pipeline_start + pipeline_resumed) so that future field / audit changes
 * need only be made in one place (DRY).
 *
 * @param ctx - pi extension context
 * @param meta - Current (aborted) session metadata
 * @param config - Pipeline configuration
 * @param ui - PipelineUI instance
 * @param file - User-supplied file argument (may be empty)
 * @param reason - Audit reason tag (pipeline_start_resume / _confirm_resume / _ask_resume)
 */
async function resumePipeline(
  ctx: any,
  meta: SessionMeta,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  file: string,
  reason: string,
): Promise<{ success: boolean; message?: string; pipelineId?: string; currentStage?: PipelineStage }> {
  const newMeta = buildResumeMeta(meta, config);
  ctx?.session?.updateMeta?.(newMeta);
  syncStageStatusBar(ui, ctx);

  await safeWriteStageAudit(config, "pipeline_start", newMeta, {
    command: file ? `/pipeline-start ${file}` : "/pipeline-start",
    file: file || "(none)",
    mode: "resume",
    previousStage: meta.currentStage,
  });
  await safeWriteStageAudit(config, "pipeline_resumed", newMeta, {
    fromStage: meta.currentStage,
    toStage: newMeta.currentStage,
    reason,
    requirementDoc: newMeta.requirementDoc ?? "",
  });

  return {
    success: true,
    message: `Pipeline resumed at stage "${newMeta.currentStage}".`,
    pipelineId: newMeta.pipelineId,
    currentStage: newMeta.currentStage,
  };
}

/**
 * Unified new-pipeline execution path for fresh / spec-stage / ask-new flows.
 *
 * Steps:
 * 1. Read requirement file (error → audit + reject)
 * 2. checkVerifyFiles(config, startStage) — only checks reachable stages
 * 3. buildStartMeta → updateMeta → syncStageStatusBar → audit
 * 4. Return success with pipelineId, currentStage, requirementContent
 *
 * @param ctx - pi extension context
 * @param config - Pipeline configuration
 * @param ui - PipelineUI instance
 * @param file - Requirement doc file path (relative to projectRoot)
 * @param startStage - Starting stage (default "clarify")
 * @param existingMeta - Existing meta (may be undefined for fresh start)
 */
async function startNewPipeline(
  ctx: any,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  file: string,
  startStage: PipelineStage = "clarify",
  existingMeta?: SessionMeta,
): Promise<{
  success: boolean;
  message?: string;
  error?: string;
  pipelineId?: string;
  currentStage?: PipelineStage;
  requirementContent?: string;
  missingStages?: PipelineStage[];
  suggestion?: string;
}> {
  // Step 1: Read requirement file
  const docPath = path.join(config.projectRoot, file);
  let content: string;
  try {
    content = fs.readFileSync(docPath, "utf-8");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("pipeline_start_error", { file, error: errMsg }, "error");
    return {
      success: false,
      error: `File not found: ${file} (${errMsg})`,
    };
  }

  // Step 2: Check verify.md files (only for reachable stages from startStage)
  const missingStages = checkVerifyFiles(config, startStage);
  if (missingStages.length > 0) {
    return {
      success: false,
      error: `verify.md missing for stages: [${missingStages.join(", ")}]`,
      missingStages,
      suggestion: "Run /pipeline-init 1 to generate verify.md files",
    };
  }

  // Detect if this is a restart (existing meta was aborted) for message wording
  // Must check BEFORE updateMeta which mutates the existingMeta object in-place
  const isRestart = existingMeta && getFlowState(existingMeta) === "aborted";

  // Step 3: Build meta and initialize
  const { pipelineId, newMeta } = buildStartMeta(existingMeta, config, file, startStage);
  ctx?.session?.updateMeta?.(newMeta);
  syncStageStatusBar(ui, ctx);

  // Register session → pipeline mapping (fail-open, covers restart with new pipelineId)
  const sessionFile = ctx?._ctx?.sessionManager?.getSessionFile?.() as string | undefined;
  if (sessionFile) {
    await registerSession(config, sessionFile, pipelineId);
  }

  // Step 4: Audit (with mode and startStage fields for traceability)
  const auditMode = startStage === "clarify" ? "fresh" : "spec";
  await safeWriteStageAudit(config, "pipeline_start", newMeta, {
    command: `/pipeline-start ${file}`,
    file,
    mode: auditMode,
    startStage,
    previousStage: auditMode === "fresh" ? "none" : (existingMeta?.currentStage ?? "none"),
  });
  const messagePrefix = isRestart
    ? `Pipeline restarted as "${pipelineId}" at stage "${startStage}".`
    : `Pipeline "${pipelineId}" started with document: ${file}.`;
  const messageSuffix = startStage === "clarify"
    ? ` Next: run @feat-design-plan-agent ${file} 1 to start requirement clarification`
    : "";

  // Phase 2 (144): Auto-launch clarify subagent for fresh/spec→clarify
  // Only for clarify start (not resume — round state is in document)
  if (startStage === "clarify") {
    await maybeAutoLaunchClarify(ctx, config, ui, newMeta, file);
  }

  // spec→plan: no subagent injection (plan agent is task-invoked by main agent),
  // but still emit a notify hint so the user knows the next step (Medium #3).
  if (startStage === "plan") {
    ui.notify(ctx, `Pipeline started at stage "plan". Run the plan agent to continue.`);
  }

  return {
    success: true,
    message: messagePrefix + messageSuffix,
    pipelineId,
    currentStage: startStage,
    requirementContent: content.slice(0, 500) + (content.length > 500 ? "..." : ""),
  };
}

/**
 * Resolves the agent mention name for @mention injection.
 *
 * Resolution order:
 * 1. Read config.stages[stage].agentPath → parse frontmatter `name:` field
 * 2. If no frontmatter name → fallback to path.basename(agentPath, ".md")
 * 3. If agentPath is undefined or file unreadable → return null
 *
 * @param config - Pipeline configuration
 * @param stage - The stage to resolve agent mention for
 * @returns Agent name string, or null if unresolvable
 */
function resolveAgentMention(
  config: PipelineConfig,
  stage: PipelineStage,
): string | null {
  const stageConfig = config.stages[stage];
  if (!stageConfig?.agentPath) return null;

  const agentFilePath = path.join(config.projectRoot, stageConfig.agentPath);

  // Read agent file — distinguish file-missing/unreadable (return null so
  // the caller falls back to notify) from file-exists-but-no-frontmatter
  // (basename fallback is still safe to inject). Medium #4.
  let content: string;
  try {
    content = fs.readFileSync(agentFilePath, "utf-8");
  } catch {
    // File unreadable / missing → null (caller does notify fallback, no inject)
    return null;
  }

  // Parse YAML frontmatter: ^---\n...\n---
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fmBody = fmMatch[1];
    const nameMatch = fmBody.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      return nameMatch[1].trim();
    }
  }

  // File exists but no frontmatter name → basename fallback (safe to inject)
  return path.basename(stageConfig.agentPath, ".md");
}

/**
 * Auto-launches the clarify subagent via pi-subagents RPC spawn.
 *
 * Flow: resolve agentName → ping → spawn → success audit; any failure → fallback to
 * pi.sendUserMessage + TUI notify + fallback audit.
 *
 * Only called for fresh/spec→clarify (NOT resume, to avoid resetting round state).
 *
 * @param ctx - pi extension context (uses ctx.pi.events + ctx.pi.sendUserMessage)
 * @param config - Pipeline configuration
 * @param ui - PipelineUI instance for notify
 * @param meta - Newly initialized session metadata
 * @param file - The requirement doc file path
 */
async function maybeAutoLaunchClarify(
  ctx: any,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  meta: SessionMeta,
  file: string,
): Promise<void> {
  const agentName = resolveAgentMention(config, "clarify");

  if (!agentName) {
    // No agentPath configured → notify fallback
    ui.notify(ctx, `Next: run @feat-design-plan-agent ${file} 1`);
    return;
  }

  const message = `@${agentName} ${file} 1`;
  const prompt = `${file} 1`;

  // Try RPC path if pi.events is available
  if (ctx?.pi?.events) {
    const pinged = await pingSubagents(ctx.pi, 500);
    if (pinged) {
      const spawnResult = await spawnClarifySubagent(ctx.pi, {
        agentName,
        prompt,
        description: `Clarify: ${file}`,
      });

      if (spawnResult.ok) {
        // RPC success: audit + watch lifecycle, no manual @ hint needed
        await safeWriteAuditLog("pipeline_start_launch_rpc", {
          agentName,
          requirementDoc: file,
          pipelineId: meta.pipelineId,
          subagentId: spawnResult.id,
          stage: "clarify",
        });
        // Hold the cleanup function and self-unregister after lifecycle event
        // (or on failure) to avoid listener leak on shared channels.
        const cleanup = watchSubagentLifecycle(ctx.pi, spawnResult.id, () => {
          cleanup();
        });
        return;
      }
      // Spawn failed → fall through to sendUserMessage fallback
    }
    // Ping timeout or spawn failure → fall through
  }

  // Fallback: sendUserMessage + TUI notification + audit
  if (typeof ctx?.pi?.sendUserMessage === "function") {
    try {
      ctx.pi.sendUserMessage(message, { expandPromptTemplates: true });
    } catch {
      // sendUserMessage failure is non-fatal; fall through to notify
    }
  }

  ui.notify(ctx, `Next: run ${message} manually if not auto-started.`);
  await safeWriteAuditLog("pipeline_start_launch", {
    agentName,
    requirementDoc: file,
    pipelineId: meta.pipelineId,
    stage: "clarify",
    fallback: "true",
  });
}

/**
 * Unified handler for the aborted pipeline branch in /pipeline-start.
 *
 * Decision matrix:
 * - resumable && (sameDoc || (!file && requirementDoc exists)) → resume (preserve stage position)
 * - completed → error: prompt user to start a new pipeline
 * - awaiting_human → error: prompt user to open decision menu
 * - no requirementDoc && no file → error: prompt user to provide doc_file
 * - else (different file provided) → start new pipeline (existing buildRestartMeta path)
 *
 * @param ctx - pi extension context
 * @param meta - Current session metadata (already validated as aborted)
 * @param file - User-supplied file argument (may be empty)
 * @param ui - PipelineUI instance for TUI status bar sync
 * @param config - Pipeline configuration
 */
async function handleAbortedPipeline(
  ctx: any,
  meta: SessionMeta,
  file: string,
  ui: ReturnType<typeof createPipelineUI>,
  config: PipelineConfig,
): Promise<{ success: boolean; message?: string; error?: string; pipelineId?: string; currentStage?: PipelineStage }> {
  const resumable = RESUMABLE_STAGES.includes(meta.currentStage);
  const sameDoc = !!file && !!meta.requirementDoc && file === meta.requirementDoc;
  const resumeEligible = resumable && (sameDoc || (!file && !!meta.requirementDoc));

  // --- Resume branch ---
  if (resumeEligible) {
    return resumePipeline(ctx, meta, config, ui, file, "pipeline_start_resume");
  }

  // --- Terminal stage: completed → require fresh start ---
  if (meta.currentStage === "completed") {
    return {
      success: false,
      error: "Pipeline already completed. Use /pipeline-start <file> to start a new pipeline.",
    };
  }

  // --- Frozen stage: awaiting_human → require decision menu ---
  if (meta.currentStage === "awaiting_human") {
    return {
      success: false,
      error: `Pipeline is at awaiting_human stage. Open the decision menu to proceed.`,
    };
  }

  // --- No requirementDoc && no file → prompt user ---
  if (!meta.requirementDoc && !file) {
    return {
      success: false,
      error: "run /pipeline-start <doc_file> start pipeline loop",
    };
  }

  // --- Start new pipeline (different file, or no requirementDoc with file provided) ---
  // Unified path: both the "different doc" and "no requirementDoc + new file"
  // cases go through startNewPipeline so that the new file is re-read, verify.md
  // files are re-checked, and maybeAutoLaunchClarify is invoked (fixes Medium #1).
  if (meta.requirementDoc) {
    // Different doc: prefer user's new file; defensive fallback to existing doc
    return startNewPipeline(ctx, config, ui, file || meta.requirementDoc, "clarify", meta);
  }

  // No existing requirementDoc — use new file via unified path
  if (!file) {
    return {
      success: false,
      error: "run /pipeline-start <doc_file> start pipeline loop",
    };
  }
  return startNewPipeline(ctx, config, ui, file, "clarify", meta);
}

export function createPipelineStartCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-start",
    description:
      "Start a new pipeline run. Optionally reads the specified requirement document and " +
      "injects it into the clarify stage. Without a file, initializes the state machine only.",
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      const file = (args.file as string) || "";
      const ui = createPipelineUI(config);
      const mode: StartStageMode = config.startStageMode ?? "auto";

      const meta = ctx?.session?.getMeta?.();

      // Phase 1 (140): validate agentPath for all 5 active stages before any startup
      const missingAgentPaths = checkAgentPaths(config);
      if (missingAgentPaths.length > 0) {
        await safeWriteAuditLog("pipeline_start_config_error", {
          missingStages: missingAgentPaths.join(","),
          error: "agentPath not configured for active stage(s)",
        }, "warn");
        return {
          success: false,
          error:
            `pipeline_loop.json missing agentPath for stage(s): [${missingAgentPaths.join(", ")}]. ` +
            `Add agentPath to each active stage config, e.g. ".pi/agents/develop-agent.md".`,
        };
      }

      // 147 Phase 6: Template-residue gate (after checkAgentPaths, before branch判定)
      // Blocks when Template-TODO placeholders remain in .pi/skills/ or .pi/agents/.
      // Persists pass-status to disk so subsequent restarts short-circuit via fingerprint.
      const gateResult = await templateResidueGate(config, ctx);
      if (gateResult !== null) {
        return gateResult;
      }

      // ── Branch: existing pipeline state ──────────────────────────────────
      if (meta?.currentStage && meta.pipelineId) {
        const flowState = getFlowState(meta);

        // Running or blocked → reject with decision menu hint (unchanged across all modes)
        if (flowState === "running" || flowState === "blocked") {
          return {
            success: false,
            error:
              `Pipeline "${meta.pipelineId}" already running at stage "${meta.currentStage}" (${flowState}). ` +
              `Open the decision menu to proceed.`,
          };
        }

        // Aborted → mode-specific handling
        if (flowState === "aborted") {
          return handleAbortedWithMode(ctx, meta, file, ui, config, mode);
        }

        // Completed → error (unchanged)
        if (meta.currentStage === "completed") {
          return {
            success: false,
            error: "Pipeline already completed. Use /pipeline-start <file> to start a new pipeline.",
          };
        }

        // awaiting_human → error with decision menu hint (unchanged)
        if (meta.currentStage === "awaiting_human") {
          return {
            success: false,
            error: `Pipeline is at awaiting_human stage. Open the decision menu to proceed.`,
          };
        }
      }

      // ── Branch: fresh start (no existing pipeline) ──────────────────────
      // No file → reject
      if (!file) {
        return {
          success: false,
          error: "run /pipeline-start <doc_file> start pipeline loop",
        };
      }

      // Fresh start with file → mode-specific handling
      if (mode === "ask") {
        return handleAskMenu(ctx, config, ui, file, undefined);
      }

      // auto/confirm fresh start: both go to clarify directly
      return startNewPipeline(ctx, config, ui, file, "clarify", meta);
    },
  };
}

/**
 * Handles aborted pipeline with mode-specific behavior.
 * - auto: existing 142 matrix (resume/new unchanged)
 * - confirm: resume-eligible → confirm dialog → resume or cancel
 * - ask: TUI menu (resume/new/spec/cancel)
 */
async function handleAbortedWithMode(
  ctx: any,
  meta: SessionMeta,
  file: string,
  ui: ReturnType<typeof createPipelineUI>,
  config: PipelineConfig,
  mode: StartStageMode,
): Promise<unknown> {
  const resumable = RESUMABLE_STAGES.includes(meta.currentStage);
  const sameDoc = !!file && !!meta.requirementDoc && file === meta.requirementDoc;
  const resumeEligible = resumable && (sameDoc || (!file && !!meta.requirementDoc));

  // ── auto mode: existing 142 matrix unchanged ──
  if (mode === "auto") {
    return handleAbortedPipeline(ctx, meta, file, ui, config);
  }

  // ── confirm mode ──
  if (mode === "confirm") {
    if (resumeEligible) {
      // A3: if ui.confirm is unavailable → fall back to auto behavior + notify
      if (typeof ctx?.ui?.confirm !== "function") {
        ctx?.ui?.notify?.("TUI confirm unavailable — falling back to auto mode");
        return handleAbortedPipeline(ctx, meta, file, ui, config);
      }
      const confirmed = await ctx.ui.confirm(
        `Resume at "${meta.currentStage}"? [Confirm / Cancel]`,
      );
      if (confirmed) {
        return resumePipeline(ctx, meta, config, ui, file, "pipeline_start_confirm_resume");
      }
      // Cancelled → no meta change
      return { success: false, error: "Pipeline start cancelled." };
    }
    // Not resume-eligible → same as auto (new pipeline or error)
    return handleAbortedPipeline(ctx, meta, file, ui, config);
  }

  // ── ask mode ──
  if (mode === "ask") {
    return handleAskMenu(ctx, config, ui, file || meta.requirementDoc || "", meta);
  }

  // Fallback (should never reach)
  return handleAbortedPipeline(ctx, meta, file, ui, config);
}

/**
 * Builds the list of spec-eligible stages for the ask menu.
 * Excludes awaiting_human and completed (not startable).
 * Only includes enabled stages (not disabled).
 */
function getSpecEligibleStages(config: PipelineConfig): PipelineStage[] {
  const eligible: PipelineStage[] = [];
  const order: PipelineStage[] = ["clarify", "plan", "develop", "review", "fix"];
  for (const stage of order) {
    const stageConf = config.stages[stage];
    if (stageConf?.disabled) continue;
    eligible.push(stage);
  }
  return eligible;
}

/**
 * TUI ask menu handler: presents new/resume/spec/cancel options.
 * SDK select has no default-index → priority item placed first.
 * A3 degradation: if ui.select unavailable → fall back to auto + notify.
 */
async function handleAskMenu(
  ctx: any,
  config: PipelineConfig,
  ui: ReturnType<typeof createPipelineUI>,
  file: string,
  existingMeta: SessionMeta | undefined,
): Promise<unknown> {
  // A3: no TUI → degrade to auto + notify
  if (typeof ctx?.ui?.select !== "function") {
    ctx?.ui?.notify?.("TUI select unavailable — falling back to auto mode");
    if (existingMeta && getFlowState(existingMeta) === "aborted") {
      return handleAbortedPipeline(ctx, existingMeta, file, ui, config);
    }
    return startNewPipeline(ctx, config, ui, file, "clarify", existingMeta);
  }

  // Resume eligibility must mirror auto mode's resumeEligible logic
  // (sameDoc || (!file && requirementDoc)), otherwise a user-supplied different
  // doc would still show the resume option and default-highlight it (Medium #2).
  const sameDoc = existingMeta
    ? !!file && !!existingMeta.requirementDoc && file === existingMeta.requirementDoc
    : false;
  const resumeEligible = existingMeta
    ? RESUMABLE_STAGES.includes(existingMeta.currentStage) &&
      (sameDoc || (!file && !!existingMeta.requirementDoc))
    : false;

  // Build options: priority item first (simulate default highlight)
  const options: string[] = [];
  if (resumeEligible) {
    options.push(`Resume stage (${existingMeta!.currentStage})`);
  }
  options.push("New pipeline");
  options.push("Spec stage");
  options.push("Cancel");

  const selection = await ctx.ui.select("Pipeline start mode:", options);

  // Cancel / select returns undefined
  if (!selection) {
    return { success: false, error: "Pipeline start cancelled." };
  }

  // ── Resume ──
  if (selection.startsWith("Resume stage")) {
    if (!existingMeta) {
      return { success: false, error: "No pipeline to resume." };
    }
    return resumePipeline(ctx, existingMeta, config, ui, file, "pipeline_start_ask_resume");
  }

  // ── New pipeline ──
  if (selection === "New pipeline") {
    // A1: if there's an unfinished pipeline → discard confirmation
    if (existingMeta && getFlowState(existingMeta) === "aborted") {
      if (typeof ctx?.ui?.confirm === "function") {
        const confirmed = await ctx.ui.confirm(
          "Discard unfinished pipeline and start new?",
        );
        if (!confirmed) {
          return { success: false, error: "Pipeline start cancelled." };
        }
      }
    }
    // Need a file for new pipeline
    if (!file) {
      return { success: false, error: "run /pipeline-start <doc_file> start pipeline loop" };
    }
    return startNewPipeline(ctx, config, ui, file, "clarify", existingMeta);
  }

  // ── Spec stage ──
  if (selection === "Spec stage") {
    const eligibleStages = getSpecEligibleStages(config);
    const stageLabels = eligibleStages.map((s) => `Start at: ${s}`);

    const stageSelection = await ctx.ui.select("Select starting stage:", stageLabels);
    if (!stageSelection) {
      return { success: false, error: "Pipeline start cancelled." };
    }

    // Parse selected stage from label "Start at: {stage}"
    const selectedStage = stageSelection.replace("Start at: ", "") as PipelineStage;

    // A1: discard confirmation for unfinished pipeline
    if (existingMeta && getFlowState(existingMeta) === "aborted") {
      if (typeof ctx?.ui?.confirm === "function") {
        const confirmed = await ctx.ui.confirm(
          "Discard unfinished pipeline and start new?",
        );
        if (!confirmed) {
          return { success: false, error: "Pipeline start cancelled." };
        }
      }
    }

    if (!file) {
      return { success: false, error: "run /pipeline-start <doc_file> start pipeline loop" };
    }
    return startNewPipeline(ctx, config, ui, file, selectedStage, existingMeta);
  }

  // ── Cancel ──
  return { success: false, error: "Pipeline start cancelled." };
}
