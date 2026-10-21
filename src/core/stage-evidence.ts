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
import type { PipelineStage, SessionMeta, StageStatSnapshot } from "../types";
import { auditLogDirForPipeline } from "../utils/auditLog";
import { planDocRelPathFromRequirementDoc } from "./naming/doc-naming";

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
 * `planDoc` uses the canonical doc-naming derivation from the requirement
 * doc (glob fallback intentionally omitted: the aggregate is an audit hint,
 * and pulling `resolvePlanDocPath` here would add a config dependency).
 */
export async function collectRunAggregate(
  meta: SessionMeta,
  finalStage: PipelineStage,
  finalStageStartedAt: number,
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
    } catch {
      // Fail-visible at the aggregate level: skip this summary's ids, keep
      // the remaining evidence (terminal audit must never block the exit).
    }
  }

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
    planDoc: meta.requirementDoc ? planDocRelPathFromRequirementDoc(meta.requirementDoc) : "",
    summaryPaths: summaryPaths.join(","),
    commitIds: commitIds.join(","),
    auditPath: auditLogDirForPipeline(meta.pipelineId) ?? "unavailable",
    loopCycleCount: String(meta.loopCycleCount ?? 0),
    stageVisitOrder: (meta.stageVisitOrder ?? []).join(","),
    finalStage,
  };
}
