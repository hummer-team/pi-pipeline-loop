/**
 * @module stage-target-doc
 * 225 Phase 2 (T4/Q4-A→D4): the SINGLE `stage → target document` resolver.
 *
 * One function produces the exact document path a stage's TUI description and
 * dispatch prompt must reference, from one source of truth per branch:
 * - plan / develop → the plan doc next to the requirement doc (D4 row);
 * - review         → the commit doc in the design dir (the reviewer's INPUT);
 * - fix            → THIS round's review report (the fixer's INPUT). The round
 *   comes from `meta.reviewRound` (NOT a caller argument — the fix executor
 *   must never be handed a caller-selected round), and when the ledger entry
 *   is absent (legacy runs / event-ledger dispatches) the requirement doc is
 *   the honest fallback with a `stage_target_doc_fallback` audit.
 *
 * Layer-neutral (utils): naming from `docs-paths`, directories from
 * `docsDirsOf` — no `core/` runtime dependency.
 */

import type { PipelineConfig, ReviewRoundState, SessionMeta } from "../types";
import {
  codeReviewDocFileName,
  commitDocFileName,
  docsDirsOf,
  planDocRelPathFromRequirementDoc,
  reqBaseFromRequirementDoc,
} from "../docs-paths";
import { safeWriteAuditLog } from "./auditLog";

export interface StageTargetDoc {
  /** Exact target document path (project-relative), or null when unresolvable. */
  path: string | null;
  /** Which branch produced the path (audit / prompt wording context). */
  source: "plan-doc" | "commit-doc" | "review-report" | "requirement";
  /** Present only for `review-report`: the 1-based round whose report is targeted. */
  round?: number;
}

/**
 * Resolves the target document for the CURRENT stage. The round source is
 * FIXED to meta (`opts?.reviewRound ?? meta.reviewRound`) — a caller MAY
 * forward a just-allocated review round, but the fix path always reads
 * `meta.reviewRound` when the caller passes nothing (225 acceptance T5).
 */
export async function resolveStageTargetDoc(
  config: PipelineConfig,
  meta: SessionMeta,
  opts?: { reviewRound?: ReviewRoundState },
): Promise<StageTargetDoc> {
  const round = opts?.reviewRound ?? meta.reviewRound;
  if (!meta.requirementDoc) {
    // D4 table row "无 requirementDoc": honest absence — never fabricate a
    // derived name from an empty reqBase, and never audit (nothing "fell
    // back"; there is simply nothing to resolve from).
    return { path: null, source: "requirement" };
  }
  const dirs = docsDirsOf(config);
  const reqBase = reqBaseFromRequirementDoc(meta.requirementDoc);

  switch (meta.currentStage) {
    case "plan":
    case "develop": {
      // Same directory as the requirement doc, single derived name (no glob).
      return {
        path: meta.requirementDoc ? planDocRelPathFromRequirementDoc(meta.requirementDoc) : null,
        source: "plan-doc",
      };
    }
    case "review": {
      return {
        path: `${dirs.designDir.replace(/\/+$/, "")}/${commitDocFileName(reqBase)}`,
        source: "commit-doc",
      };
    }
    case "fix": {
      if (round) {
        // THE fix point of the incident: with a ledger entry the target is the
        // report OF THIS ROUND — never the mtime-latest `_1.md` of round 1.
        return {
          path: `${dirs.reviewDir.replace(/\/+$/, "")}/${codeReviewDocFileName(reqBase, round.index)}`,
          source: "review-report",
          round: round.index,
        };
      }
      // Single honest fallback: no ledger entry at all (legacy run /
      // event-ledger dispatch). Egress audited once per call.
      void safeWriteAuditLog("stage_target_doc_fallback", {
        pipelineId: meta.pipelineId,
        stage: "fix",
        reason: "no-review-round",
      }, "warn");
      return { path: meta.requirementDoc ?? null, source: "requirement" };
    }
    default: {
      return { path: meta.requirementDoc ?? null, source: "requirement" };
    }  }
}
