/**
 * @module review-exit-gate
 * 225 Phase 3 (T1/Q3-A→D3): the review congestion exit gate.
 *
 * A settle on `review` may only produce a CONCLUSION from the report of the
 * CURRENT round that is also FRESH (mtime >= this round's entry clock).
 * Order matters and is enforced here: freshness is judged BEFORE liveness, so
 * a legitimately produced current-round report is never suppressed by a
 * same-turn dispatch marker.
 *
 * Liveness evidence, three complementary sources (NO time-window constant is
 * introduced — each covers a distinct dispatch reality, and none can hang):
 * - `probe_live`: an `agentId` whose upstream state still reports live (the
 *   executor's own termination invalidates this naturally);
 * - `reserved` (60s, `spawn-evidence.ts`): dispatch in flight without an id;
 * - `reviewDispatchedAt`: "dispatched in THIS turn" marker (no time guess —
 *   consumed and cleared by the settlement caller after each evaluation).
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  codeReviewDocFileName,
  docsDirsOf,
  reqBaseFromRequirementDoc,
} from "../docs-paths";
import { DEFAULT_REVIEW_DIR } from "../constants";
import type { PipelineStage, ReviewRoundState, SessionMeta } from "../types";
import type { PipelineConfig } from "../types";
import { probeAgentState } from "../utils/subagents-introspect";
import { findLatestReviewReport, parseReviewConclusion, type ReviewVerdict } from "../utils/review-conclusion";
import { loadVerifyContractAnchors, type VerifyContractAnchors } from "../utils/contract-loader";
import { RESERVED_SPAWN_EVIDENCE_MS } from "../utils/spawn-evidence";
import { safeWriteAuditLog } from "../utils/auditLog";

/** Outcome of one settle-time review exit evaluation. */
export type ReviewExitState = "conclusion" | "live-executor" | "no-conclusion";

export interface ReviewExitGate {
  state: ReviewExitState;
  /** Only for `conclusion` (contract-unavailable rides through verbatim). */
  verdict?: ReviewVerdict;
  /** The exact report path this gate evaluated (null when unresolvable). */
  expectedPath: string | null;
  /** Why the gate returned a non-conclusion: live / missing / stale. */
  reason: "live" | "missing" | "stale";
}

/**
 * Liveness judgement shared by the exit gate (fresh report absent) and the
 * stage-advancer explicit-fail declaration path. Config-free: reads the
 * `review` stage slot of the spawn ledger + the same-turn marker.
 */
export function isReviewExecutorLive(meta: SessionMeta, now: number = Date.now()): boolean {
  const entry = meta.activeSpawns?.["review"];
  if (entry) {
    // probe_live: the executor's termination makes the probe fail by itself.
    if (entry.agentId && probeAgentState(entry.agentId) === "live") return true;
    // reserved: dispatch still in flight (no probeable id yet).
    if (entry.reserved && now - entry.startedAt < RESERVED_SPAWN_EVIDENCE_MS) return true;
  }
  // Same-turn dispatch marker covers the fallback channel without an agentId.
  return meta.reviewDispatchedAt?.stageStartTime === meta.stageStartTime;
}

/**
 * Freshness+round resolution of the current review visit.
 * Returns the exact expected path (or the audited legacy fallback) and the
 * freshness baseline clock the report's mtime must reach.
 */
async function resolveExpectedReport(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<{ expectedPath: string | null; enteredAt: number }> {
  const round: ReviewRoundState | undefined = meta.reviewRound;
  const sameVisit =
    !!round && round.pipelineId === meta.pipelineId && round.stageStartTime === meta.stageStartTime;
  if (sameVisit) {
    return {
      expectedPath: `${docsDirsOf(config).reviewDir.replace(/\/+$/, "")}/${codeReviewDocFileName(reqBaseFromRequirementDoc(meta.requirementDoc ?? ""), round!.index)}`,
      enteredAt: round!.enteredAt,
    };
  }

  // Round unknown → the LEGACY behaviour explicitly kept (F3 trade-off, audited):
  // event-ledger dispatches / old runs / resume-flattened meta still resolve
  // "the latest report decides". Never judges-death on a missing round.
  const latest = await findLatestReviewReport(config.projectRoot, docsDirsOf(config).reviewDir);
  if (latest) {
    void safeWriteAuditLog("review_round_missing_fallback", {
      pipelineId: meta.pipelineId,
      stage: "review",
      stageStartTime: String(meta.stageStartTime),
    }, "warn");
    return { expectedPath: path.relative(config.projectRoot, latest), enteredAt: meta.stageStartTime };
  }
  return {
    expectedPath: `${DEFAULT_REVIEW_DIR.replace(/\/+$/, "")}/Code_Review_${reqBaseFromRequirementDoc(meta.requirementDoc ?? "")}_Develop_Commit_*.md`,
    enteredAt: meta.stageStartTime,
  };
}

function statFresh(absPath: string, enteredAt: number): Promise<boolean> {
  return fs
    .stat(absPath)
    .then((stat) => stat.mtimeMs >= enteredAt)
    .catch(() => false);
}

function statExists(absPath: string): Promise<boolean> {
  return fs
    .stat(absPath)
    .then(() => true)
    .catch(() => false);
}

/**
 * Evaluates the exit gate for the CURRENT review settle.
 *
 * Report resolution (liveness-independent):
 * 1. ledger round of the current visit → exact `{reqBase}..._{index}.md`;
 * 2. otherwise the audited legacy fallback (mtime-latest report / expected
 *    glob pattern when nothing exists yet).
 *
 * Freshness (`mtime >= enteredAt`): a fresh file is parsed via the exact-path
 * mode; missing → `no-conclusion / missing`; existing-but-older →
 * `no-conclusion / stale`. ONLY THEN is liveness consulted, and a live
 * executor turns either no-conclusion into `live-executor` (keep waiting).
 */
export async function evaluateReviewExitGate(
  config: PipelineConfig,
  meta: SessionMeta,
  opts?: { now?: number },
): Promise<ReviewExitGate> {
  const now = opts?.now ?? Date.now();
  const { expectedPath, enteredAt } = await resolveExpectedReport(config, meta);

  let hasFreshReport = false;
  if (expectedPath) {
    const abs = path.isAbsolute(expectedPath) ? expectedPath : path.join(config.projectRoot, expectedPath);
    hasFreshReport = await statFresh(abs, enteredAt);
  }

  if (hasFreshReport && expectedPath) {
    const anchors: VerifyContractAnchors = (await loadVerifyContractAnchors(config, "review" as PipelineStage)).anchors;
    const verdict = await parseReviewConclusion(config.projectRoot, anchors, docsDirsOf(config).reviewDir, {
      expectedPath,
    });
    if (verdict && verdict.source !== "missing-expected") {
      return { state: "conclusion", verdict, expectedPath, reason: "stale" };
    }
    // Fresh file on disk but unparseable → fall through to liveness/missing.
  }

  // Liveness gate (evaluated ONLY without a fresh conclusion).
  if (isReviewExecutorLive(meta, now)) {
    return { state: "live-executor", expectedPath, reason: "live" };
  }

  if (!expectedPath) {
    return { state: "no-conclusion", expectedPath: null, reason: "missing" };
  }
  const abs = path.isAbsolute(expectedPath) ? expectedPath : path.join(config.projectRoot, expectedPath);
  const exists = await statExists(abs);
  return {
    state: "no-conclusion",
    expectedPath,
    reason: exists ? "stale" : "missing",
  };
}
