/**
 * @module auto-pipeline/clarify-queue-fact
 * 226 review round 2 (issue 2): the DELIVERY fact of a deferred clarify round.
 *
 * Facts:
 * - A `deferred` finalisation round is only QUEUED (`pendingSpawns`): the
 *   dispatch was postponed because a same-agent twin is still live. Booking
 *   "dispatched" at that moment lied twice — the round carried no
 *   `full-und?`/finalisation instruction, and a queue entry that is later
 *   dropped left a marker debt nobody could pay.
 * - The single place that knows a queued entry really went out is the owner-side
 *   dequeue (`spawnClarifyStageSubagent`). This module owns that promotion so the
 *   sidecar keeps ONE meaning per field (queued ≠ dispatched).
 * - `clarifyFinalisationRound` (dispatched) is what the decision layer reads; the
 *   queued marker only keeps the settle from dispatching a SECOND
 *   `full-und?` while the queue owns the round.
 * - The success-side stall observation stays owned by the settle path: its
 *   signature is derived from the settle decision (action + assessment + round),
 *   which the dequeue cannot reproduce without fabricating progress evidence.
 *   A deferred round is explicitly NOT a stall (`deferred` never charges one).
 * - Writes are best effort: a persistence failure is audited at `error` level and
 *   NEVER blocks the spawn that already happened.
 */

import type { PipelineConfig } from "../../types";
import { docsDirsOf } from "../../docs-paths";
import { auditAutoDecision } from "./auto-audit";
import { readActiveJobContext } from "./config-overlay";
import { auditAutoDiagnostic } from "./diagnostics";
import { writeJobState } from "./job-state";

/**
 * Promote the queued finalisation round to "really dispatched".
 *
 * Called by the dequeue ONLY after a real clarify spawn/fallback succeeded. A
 * missing active job, a foreign document or no queued fact are all no-ops (the
 * human track and ordinary stage spawns never touch this fact).
 *
 * @param config - Resolved pipeline configuration (project root + audit switch)
 * @param doc - Requirement document of the dequeued round (`meta.requirementDoc`)
 * @returns TRUE when a queued fact was promoted
 */
export async function promoteClarifyQueuedFinalisation(
  config: PipelineConfig,
  doc: string | null,
): Promise<boolean> {
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active || active.state.status !== "running") return false;
  const { state } = active;
  const index = doc ? state.docs.findIndex((entry) => entry.doc === doc) : state.docIndex;
  const progress = state.docs[index >= 0 ? index : state.docIndex];
  const round = progress?.clarifyFinalisationQueuedRound;
  if (!progress || round === undefined) return false;

  progress.clarifyFinalisationRound = round;
  progress.clarifyFinalisationQueuedRound = undefined;
  progress.updatedAt = Date.now();
  state.updatedAt = progress.updatedAt;
  try {
    await writeJobState(config.projectRoot, state);
  } catch (err) {
    auditAutoDiagnostic(
      "clarify_queue_fact_persist_failed",
      "Auto-job clarify queue delivery could not be persisted — the marker gate may re-dispatch once.",
      { jobId: state.jobId, doc: progress.doc, error: String(err) },
      "error",
    );
  }
  await auditAutoDecision(config, {
    gate: "clarify_dispatch_deferred",
    decision: "delivered",
    reason: "queued_finalisation_dispatched",
    round: String(round),
  });
  return true;
}
