/**
 * @module stage-evidence
 * 210 Phase 4 (requirement 5.5, R1-4): single-point computation of STAGE-EXIT
 * and RUN-AGGREGATE evidence for the audit trail.
 *
 * Why a dedicated module: the same exit facts (duration, verify/confirm
 * counters, summary path, commit ids) are needed by THREE exit channels
 * (tool advance, hook auto-advance, confirm reject) and TWO terminal channels
 * (`pipeline_completed`, `pipeline_session_aborted`). Computing them once here
 * prevents the "three copies drift apart" failure mode (requirement 5.1-I5).
 *
 * Constraints honored:
 * - audit `extra` values are strictly `Record<string, string>` (single-line
 *   `k=v` format): `stageStats` serializes as `stage:durationMs:verifyAttempts:
 *   confirmRejections` comma-joined, `commitIds` comma-joined, empty → ""
 *   (plan Phase 4 ⚠️ — no objects/JSON in the extras);
 * - frontmatter read is best-effort: ANY read/parse failure sets
 *   `evidenceUnavailable = true` and never throws (acceptance: "summary
 *   missing / no commit_ids: evidenceUnavailable=true, advance unaffected");
 * - no new dependencies: the frontmatter is the JSON blob `generate-summary`
 *   writes between the leading `---` fences (plus a tolerant YAML-list
 *   fallback); the plan-doc key is derived with the canonical doc-naming
 *   helpers, never re-implemented here.
 */

import * as fs from "node:fs/promises";
import type { PipelineConfig, PipelineStage, SessionMeta, StageStatSnapshot, StageUsageSnapshot } from "../types";
import * as path from "node:path";
import { auditLogDirForPipeline, safeWriteAuditLog } from "../utils/auditLog";
import { planDocRelPathFromRequirementDoc } from "./naming/doc-naming";
import { resolvePlanDocPath } from "./verify-path-resolver";

// ─── Stage-exit evidence ──────────────────────────────────────────────────────

/**
 * Per-stage exit facts captured from the PRE-advance meta snapshot.
 * `stageEnteredAt` / `durationMs` must be explicit (not inferred from audit
 * line timestamps — requirement 4.2 calibration 1).
 */
export interface StageExitEvidence {
  /** Unix ms when the exiting stage was entered (`meta.stageStartTime`, 0 = missing). */
  stageEnteredAt: number;
  /** Wall-clock ms spent in the exiting stage (0 when `stageStartTime` missing). */
  durationMs: number;
  /** Verification attempts consumed during the visit. */
  verifyAttempts: number;
  /** Confirm-gate rejections recorded during the visit. */
  confirmRejections: number;
  /** Rework-loop cycles consumed during the visit. */
  loopCycleCount: number;
  /** Path of the stage summary artifact ("" when none was recorded). */
  summaryPath: string;
  /** Commit ids read back from the summary frontmatter (empty when unreadable). */
  commitIds: string[];
  /** True when the summary/commit evidence could not be read (or the clock was missing). */
  evidenceUnavailable: boolean;
}

/**
 * Extracts the `commit_ids` array from a summary document.
 *
 * Primary shape (what `generate-summary` actually writes — JSON frontmatter):
 *   "commit_ids": [
 *     "61eadf8",
 *     "13803b4"
 *   ]
 * Tolerated fallback shapes (manual edits / legacy writers):
 *   commit_ids: [a, b]           (flow list, unquoted)
 *   commit_ids:
 *     - a
 *     - b                         (block list)
 *
 * Returns [] on ANY structural failure — the caller flags the evidence as
 * unavailable (fail-visible, never throws, no YAML dependency).
 */
function parseCommitIds(content: string): string[] {
  // The frontmatter is the block between the leading `---` line and the next
  // `---` line. Anything else is body and must NOT be scanned (a "commit_ids"
  // mention in prose would otherwise leak into the evidence).
  const open = content.startsWith("---");
  if (!open) return [];
  const close = content.indexOf("\n---", 3);
  if (close < 0) return [];
  const front = content.slice(3, close);

  const keyMatch = /(?:^|[\s,{])"?commit_ids"?\s*:/.exec(front);
  if (!keyMatch) return [];
  const after = front.slice(keyMatch.index + keyMatch[0].length);

  // Trim FIRST — JSON frontmatter tokens carry leading whitespace/newlines, so
  // an untrimmed token would never match the leading-quote anchor.
  const clean = (raw: string): string => raw.trim().replace(/^["']|["']$/g, "").trim();

  // Flow sequence: [ ... ] on the remainder (multi-line safe — no nested ]).
  const flowMatch = /^\s*\[([^\]]*)\]/.exec(after);
  if (flowMatch) {
    return flowMatch[1]
      .split(",")
      .map((token) => clean(token))
      .filter((token) => token.length > 0);
  }

  // Block sequence: following lines each starting with "- ".
  const ids: string[] = [];
  for (const line of after.split("\n").slice(0, 64)) {
    const item = /^\s*-\s*(.+?)\s*,?\s*$/.exec(line);
    if (!item) {
      if (line.trim().length > 0) break; // left the sequence (a sibling key)
      continue;
    }
    const id = clean(item[1]);
    if (id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * Collects the EXIT evidence of the stage the meta snapshot is leaving.
 *
 * MUST be called with the PRE-advance snapshot (tool path `meta`, hook path
 * `clearedMeta`): its `stageStartTime` is the exit stage's entry clock. Never
 * throws — unreadable summaries degrade to `evidenceUnavailable = true`.
 */
export async function collectStageExitEvidence(meta: SessionMeta): Promise<StageExitEvidence> {
  const stageEnteredAt = meta.stageStartTime ?? 0;
  const missingClock = stageEnteredAt <= 0;
  const durationMs = missingClock ? 0 : Math.max(0, Date.now() - stageEnteredAt);
  const summaryPath = meta.summaries?.[meta.currentStage]?.path ?? "";

  let commitIds: string[] = [];
  let readFailed = false;
  if (summaryPath) {
    try {
      const content = await fs.readFile(summaryPath, "utf-8");
      commitIds = parseCommitIds(content);
    } catch {
      // Fail-visible degrade: the evidence (not the advance) is affected.
      readFailed = true;
    }
  } else {
    readFailed = true;
  }

  return {
    stageEnteredAt,
    durationMs,
    verifyAttempts: meta.verifyAttempts ?? 0,
    confirmRejections: meta.confirmRejections ?? 0,
    loopCycleCount: meta.loopCycleCount ?? 0,
    summaryPath,
    commitIds,
    // Acceptance: missing stageStartTime → durationMs=0 AND flagged; missing
    // or commit_ids-less summary → flagged too (evidence genuinely unavailable).
    evidenceUnavailable: missingClock || readFailed || commitIds.length === 0,
  };
}

/**
 * 210 Phase 6: read the `commit_ids` frontmatter of ONE summary artifact.
 *
 * Distinguishes the two degrade modes (unreadable vs. no ids) that the
 * review-change-evidence builder needs:
 * `null` = the file is unreadable (or no path), `[]` = readable but the
 * frontmatter carries no commit ids. Never throws.
 */
export async function readSummaryCommitIds(summaryPath: string | undefined): Promise<string[] | null> {
  if (!summaryPath) return null;
  try {
    const content = await fs.readFile(summaryPath, "utf-8");
    return parseCommitIds(content);
  } catch {
    return null;
  }
}

/**
 * Persists the three exit counters as ONE snapshot under
 * `meta.stageStats[stage]` (single write point — duration and counters can
 * never drift apart across two maps).
 */
export function recordStageStats(
  session: { updateMeta: (p: Partial<SessionMeta>) => unknown },
  meta: SessionMeta,
  stage: PipelineStage,
  evidence: Pick<StageExitEvidence, "durationMs" | "verifyAttempts" | "confirmRejections">,
): void {
  const snapshot: StageStatSnapshot = {
    durationMs: evidence.durationMs,
    verifyAttempts: evidence.verifyAttempts,
    confirmRejections: evidence.confirmRejections,
  };
  session.updateMeta({
    stageStats: { ...(meta.stageStats ?? {}), [stage]: snapshot },
  });
}

/**
 * Serializes `stageStats` into the single-line audit vocabulary:
 * `clarify:120000:0:0,plan:90000:2:1` (`stage:durationMs:verifyAttempts:
 * confirmRejections`, comma-joined; empty map → "").
 */
export function serializeStageStats(
  stats: SessionMeta["stageStats"],
): string {
  if (!stats) return "";
  const parts: string[] = [];
  for (const [stage, snapshot] of Object.entries(stats)) {
    if (!snapshot) continue; // never-written Partial key
    parts.push(`${stage}:${snapshot.durationMs}:${snapshot.verifyAttempts}:${snapshot.confirmRejections}`);
  }
  return parts.join(",");
}

// ─── Run aggregate (terminal events) ─────────────────────────────────────────

/**
 * Builds the full run-aggregate field set for terminal audit events
 * (`pipeline_completed` / `pipeline_session_aborted`, requirement 5.5 table).
 *
 * Key names match the requirement table VERBATIM. All values are strings
 * (audit `extra` contract). `finalStageStartedAt` MUST be the pre-advance
 * snapshot's `stageStartTime` so the LAST stage's duration is computed
 * correctly (plan Phase 4, task 2). `auditPath` falls back to "unavailable"
 * when the audit subsystem never initialized (unit-test contexts).
 *
 * `planDoc` (210 review issue 9, requirement 5.5): resolved through the
 * CANONICAL `resolvePlanDocPath` (derivation + glob fallback) whenever the
 * caller can supply `config`; the pure doc-naming derivation remains the
 * fallback for call sites without config (tests / harnesses), so the aggregate
 * never loses the field because of a naming convention it cannot see.
 *
 * @param config - Optional pipeline config — enables the canonical plan-doc
 *   resolution (including the `docs/*_Plan.md` glob fallback) per requirement 5.5
 */
export async function collectRunAggregate(
  meta: SessionMeta,
  finalStage: PipelineStage,
  finalStageStartedAt: number,
  config?: PipelineConfig,
): Promise<Record<string, string>> {
  const startedAt = meta.pipelineStartedAt ?? meta.stageStartTime ?? 0;
  const durationMs = finalStageStartedAt > 0 ? Math.max(0, Date.now() - finalStageStartedAt) : 0;

  const summaryPaths: string[] = [];
  const commitIds: string[] = [];
  for (const summary of Object.values(meta.summaries ?? {})) {
    if (!summary?.path) continue;
    summaryPaths.push(summary.path);
    try {
      const content = await fs.readFile(summary.path, "utf-8");
      for (const id of parseCommitIds(content)) {
        if (!commitIds.includes(id)) commitIds.push(id);
      }
    } catch (err) {
      // Expected absence (the summary was never written / removed) stays quiet —
      // the aggregate already exposes the missing path in `summaryPaths` and
      // sets `evidenceUnavailable` at the stage level. ANY other failure is
      // recorded (210 review issue 7, code_spec §3: a catch must log its inputs
      // and the error) but still never blocks the terminal exit.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        await safeWriteAuditLog("stage_evidence_summary_read_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          summaryPath: summary.path,
          error: err instanceof Error ? err.message : String(err),
        }, "error");
      }
    }
  }

  // 210 Phase 7: usage roll-up (requirement 5.9). Sum with 6-decimal rounding —
  // inside the plan's 1e-6 float tolerance; `modelsByStage` serializes as
  // `stage:model` comma-joined (flat-string audit format, no JSON).
  const usageEntries = Object.entries(meta.usageByStage ?? {}) as Array<[string, StageUsageSnapshot | undefined]>;
  const costUsdTotal = usageEntries.reduce((sum, [, snap]) => sum + (snap?.costUsd ?? 0), 0);

  // 210 review issue 9 (requirement 5.5): `planDoc` prefers the CANONICAL
  // resolver (derivation + `docs/*_Plan.md` glob fallback) when the caller has
  // a config to hand; the pure naming derivation keeps the field populated for
  // config-less call sites. Absolute results are relativized to projectRoot so
  // the audit value stays a single stable `k=v` string shape.
  const planDoc = await resolvePlanDocField(meta, config);

  // Key names are the requirement 5.5 table VERBATIM (the terminal rows add
  // `finalStage`, which belongs to the aggregate because both terminal events
  // report it: completed writes it directly, aborted keeps `stage`).
  return {
    startedAt: String(startedAt),
    durationMs: String(durationMs),
    stageStats: serializeStageStats(meta.stageStats),
    verifyAttempts: String(meta.verifyAttempts ?? 0),
    confirmRejections: String(meta.confirmRejections ?? 0),
    requirementDoc: meta.requirementDoc ?? "",
    planDoc,
    summaryPaths: summaryPaths.join(","),
    commitIds: commitIds.join(","),
    auditPath: auditLogDirForPipeline(meta.pipelineId) ?? "unavailable",
    loopCycleCount: String(meta.loopCycleCount ?? 0),
    stageVisitOrder: (meta.stageVisitOrder ?? []).join(","),
    costUsdTotal: String(Number(costUsdTotal.toFixed(6))),
    modelsByStage: usageEntries.map(([stageName, snap]) => `${stageName}:${snap?.model ?? "unknown"}`).join(","),
    finalStage,
  };
}

/**
 * 210 review issue 9: resolves the aggregate `planDoc` field.
 *
 * With a config available the value comes from the SINGLE canonical resolver
 * (`resolvePlanDocPath`: requirementDoc derivation + `docs/design/*_Plan.md`
 * glob fallback), so BOTH failure modes named in the review are covered — a
 * missing `requirementDoc` and one whose name does not follow the derivation
 * rule still yield the real plan document instead of an empty field. Absolute
 * results are relativized to `projectRoot` so the audit keeps its flat single
 * `k=v` shape. Without config (harnesses / older call sites) the pure naming
 * derivation is used, and an unresolvable path degrades to `""` as before.
 */
async function resolvePlanDocField(
  meta: SessionMeta,
  config?: PipelineConfig,
): Promise<string> {
  // NO early return on a missing `requirementDoc`: the canonical resolver
  // covers that case with the `docs/design/*_Plan.md` glob fallback, which is
  // exactly what requirement 5.5 asks for (210 review issue 9).
  if (config) {
    try {
      const resolved = await resolvePlanDocPath(config, meta);
      if (resolved) {
        return path.isAbsolute(resolved)
          ? path.relative(config.projectRoot, resolved).replace(/\\/g, "/")
          : resolved.replace(/\\/g, "/");
      }
    } catch (err) {
      // The resolver is fs-backed (glob fallback): an unexpected fs error is
      // recorded, and the naming derivation below still provides the field.
      await safeWriteAuditLog("stage_evidence_plan_doc_error", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        requirementDoc: meta.requirementDoc ?? "",
        error: err instanceof Error ? err.message : String(err),
      }, "error");
    }
  }

  return meta.requirementDoc ? planDocRelPathFromRequirementDoc(meta.requirementDoc) : "";
}
