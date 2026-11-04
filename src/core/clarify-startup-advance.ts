/**
 * @module clarify-startup-advance
 * 223 Phase 2: advance a documented-confirmed clarify stage INSIDE the start
 * round (no subagent, no extra tokens) instead of spawning a clarify executor
 * for a document that already carries `## 模型确认`.
 *
 * Facts this module honours:
 * - `meta.autoJob` is written AFTER `startNewPipeline` returns
 *   (`buildNewPeriodResetFields` explicitly resets it; the auto runner stamps
 *   it in `startPendingDoc`). Two call shapes therefore exist:
 *     - Branch A — meta.autoJob already set (resume/re-dispatch): the caller
 *       advances in place;
 *     - Branch B — meta.autoJob absent (auto runner first start): the caller
 *       defers the advance to `startPendingDoc`, which calls THIS module again
 *       after the autoJob contract holds. This module is agnostic — it just
 *       verifies + advances.
 * - The module lives in `src/core/` (NOT `auto-pipeline/`): the INV-2 source
 *   guard scans `src/core/auto-pipeline/*.ts` and asserts that directory
 *   never contains `startNewPipeline(`/`advanceStage(` calls — placing this
 *   module there would silently disable the guard.
 * - Human track: the module is reached ONLY from the auto-plan `confirmed`
 *   branch of `maybeAutoLaunchClarify`; a session without an active auto job
 *   never gets a confirmed plan (the derivation returns null → human path).
 * - Gate order is total and cheap-first: `stage_mismatch` → `marker_missing` →
 *   `no_next_stage` → the shared `autoAdvanceAfterVerify` pass. Every refusal
 *   returns `{ advanced: false, reason }` AND writes exactly one
 *   `clarify_startup_advance_blocked` row, so a stalled startup is observable.
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";
import { normalizeMarkers } from "./auto-pipeline/clarify-anchors";
import { precheckCompletionMarker } from "./auto-verifier";
import { autoAdvanceAfterVerify } from "./verify-advance";
import { docsDirsOf } from "../docs-paths";
import { readActiveJobContext } from "./auto-pipeline/config-overlay";
import {
  buildClarifyDocState,
  persistClarifyState,
  resetClarifyCounters,
  type ClarifyEntryCtx,
} from "./auto-pipeline/clarify-state";
import { noteDocStage, writeJobState } from "./auto-pipeline/job-state";
import { auditAutoDecision } from "./auto-pipeline/auto-audit";
import { safeWriteAuditLog } from "../utils/auditLog";

/** Minimal runtime context the startup advance needs (verify-advance shape). */
export interface ClarifyStartupAdvanceCtx {
  session: ClarifyEntryCtx["session"];
  pi?: unknown;
  _ctx?: unknown;
  hasUI?: boolean | (() => boolean);
  ui?: ClarifyEntryCtx["ui"];
}

export interface ClarifyStartupAdvanceOutcome {
  advanced: boolean;
  toStage?: PipelineStage;
  reason?: string;
}

/**
 * Verify the completion marker on disk, then advance `clarify → nextStage`
 * and settle the auto job sidecar.
 *
 * Marker missing / no next stage → `{ advanced: false }` with the gate
 * reason; no spawn, no freeze (the document is handed back to the existing
 * settle semantics). An advance REFUSED by `autoAdvanceAfterVerify` is never
 * retried with a spawn — the caller's freeze/decision chain owns the refusal.
 */
export async function advanceConfirmedClarifyOnStartup(
  ctx: ClarifyStartupAdvanceCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  pipelineUI: Parameters<typeof autoAdvanceAfterVerify>[6],
): Promise<ClarifyStartupAdvanceOutcome> {
  // ── ⓪ only a clarify stage may be advanced by this seam ──
  if (meta.currentStage !== "clarify") {
    // 223 review issue 4 (L1): this is a CALLER defect, not a document state —
    // but the gate order is total ("every refusal is audited"), so a stray call
    // must not disappear silently.
    await safeWriteAuditLog("clarify_startup_advance_blocked", {
      pipelineId: meta.pipelineId,
      requirementDoc: meta.requirementDoc ?? "",
      reason: "stage_mismatch",
      advanced: "false",
    }, "warn");
    return { advanced: false, reason: "stage_mismatch" };
  }

  // ── ① marker double gate: configured aliases + on-disk precheck ──
  // The settle side treats an ABSENT/EMPTY `completionMarker` as "no marker
  // gate" (the verify contract owns the decision). Mirroring that here keeps
  // one semantics: falling back to `DEFAULT_COMPLETION_MARKERS` would invent a
  // gate the project never configured and re-create the "confirmed but stuck"
  // stall this phase fixes.
  const markers = normalizeMarkers(config.stages.clarify?.verify?.completionMarker);
  const markerGate = markers.length === 0
    || await precheckCompletionMarker(meta, markers, config.projectRoot);
  if (!markerGate) {
    await safeWriteAuditLog("clarify_startup_advance_blocked", {
      pipelineId: meta.pipelineId,
      requirementDoc: meta.requirementDoc ?? "",
      reason: "marker_missing",
      advanced: "false",
    }, "warn");
    return { advanced: false, reason: "marker_missing" };
  }

  // ── ② next stage must exist ──
  const toStage = config.stages.clarify?.nextStage ?? null;
  if (!toStage) {
    await safeWriteAuditLog("clarify_startup_advance_blocked", {
      pipelineId: meta.pipelineId,
      requirementDoc: meta.requirementDoc ?? "",
      reason: "no_next_stage",
      advanced: "false",
    }, "warn");
    return { advanced: false, reason: "no_next_stage" };
  }

  // ── ③ synthesize the pass and advance (confirm-gate approval-shaped) ──
  const passingMeta = await ctx.session.getMeta() ?? meta;
  const outcome = await autoAdvanceAfterVerify(
    config,
    { ...ctx, config } as Parameters<typeof autoAdvanceAfterVerify>[1],
    passingMeta,
    "clarify",
    toStage,
    { structuredResult: { failures: [] }, ruleMissing: [], verifyResult: null },
    pipelineUI,
    { skipPassAudit: true, caller: "auto_advance" },
  );
  if (!outcome.advanced) {
    // No retry-spawn: the existing freeze/decision chain owns a refused exit.
    // The refusal is still REPORTED (issue: a silent refusal made the stalled
    // startup indistinguishable from a successful one).
    const reason = outcome.blockReason ?? "not_advanced";
    await safeWriteAuditLog("clarify_startup_advance_blocked", {
      pipelineId: meta.pipelineId,
      requirementDoc: meta.requirementDoc ?? "",
      reason,
      advanced: "false",
    }, "warn");
    return { advanced: false, toStage, reason };
  }

  const now = Date.now();

  // ── ④ settle-side closing: refund the per-doc clarify counters ──
  // Without the reset the sidecar still reports `clarifyRounds === maxRounds`;
  // a later re-run of the same document would trip Phase 1's budget gate and
  // freeze right at startup (a NEW freeze surface would be created).
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (active && active.state.status === "running") {
    const index = active.state.docs.findIndex((d) => d.doc === meta.requirementDoc);
    if (index >= 0) {
      const state = active.state;
      const progress = state.docs[index]!;
      const docState = await buildClarifyDocState({
        config, state, job: active.job, doc: progress.doc, docIndex: index, now,
      });
      // `clarify-entry`'s confirmed branch refunds with the derived round —
      // the same items, the same audit gate, one accounting semantics.
      const round = docState?.decision.round ?? (progress.clarifyRounds ?? 1);
      resetClarifyCounters(progress, now);
      state.updatedAt = now;
      await persistClarifyState(config, state);
      await auditAutoDecision(config, {
        gate: "clarify_confirmed",
        decision: "confirmed",
        round: String(round),
      });

      // ── ⑥ sidecar truth (single write point) ──
      // Only THIS job's / THIS pipeline's doc: the next settle rewrites the same
      // value via `meta.currentStage` (settle-seam), so the write is idempotent.
      // 223 review issue 6 (L2): the resume host clears `meta.autoJob`
      // (`buildResumeMeta`), so the jobId comparison alone left the sidecar on
      // the OLD stage until the next settle. The doc's recorded `pipelineId` is
      // the second ownership proof — a resume keeps the pipelineId.
      const ownsDoc = active.jobId === passingMeta.autoJob?.jobId
        || state.docs[index]?.pipelineId === meta.pipelineId;
      if (ownsDoc) {
        noteDocStage(state, index, toStage, now);
        await writeJobState(config.projectRoot, state);
      }
    }
  }

  // ── ⑤ stage-audit the advance (skipPassAudit already suppresses the
  // "rule verification passed" claim; caller reuses `auto_advance`). ──
  await safeWriteAuditLog("clarify_startup_advanced", {
    pipelineId: meta.pipelineId,
    requirementDoc: meta.requirementDoc ?? "",
    fromStage: "clarify",
    toStage,
    trigger: "confirmed_marker",
    advanced: "true",
  });

  return { advanced: true, toStage };
}
