/**
 * @module design-review/entry
 * 192 Phase 0: shared context extraction for the two design-review entry
 * paths (TUI menu "Auto Review Plan" and direct/choose_stage entry).
 *
 * This file owns the I/O side of entry preparation (document existence,
 * path resolution, history scans). The pure state module never performs I/O;
 * round allocation here feeds `allocateNextRoundSafe` with scanned data.
 *
 * Phase 4 expands this into the unified pre-check (config/asset/write-scope
 * diagnosis); Phase 0 keeps only the extraction that both entry paths
 * genuinely share today.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { reqBaseFromPlanStem, reqBaseFromRequirementDoc, planDocRelPathFromRequirementDoc, LEGACY_DESIGN_REVIEW_RE } from "../naming/doc-naming";
import type { PipelineConfig, SessionMeta, StageConfig } from "../../types";
import { allocateNextRoundSafe } from "./state";

/**
 * Validate the design-review stage assets required for entry.
 * Shared between the menu handler and the direct-entry gate so the two
 * paths cannot diverge on what "enabled and dispatchable" means.
 *
 * @returns null when the stage is usable; otherwise a machine-readable code
 *   describing the first failing check.
 */
export function validateDesignReviewStageAssets(
  config: PipelineConfig,
): { ok: true; stage: StageConfig } | { ok: false; error: "design_review_disabled" | "design_review_config_invalid" } {
  const drStage = config.stages["design-review"];
  // 192 Phase 4: disabled flag OR original require:false mapping → disabled
  // (JSON loader maps require:false → disabled:true; code configs keep the
  // explicit-false meaning). Absence of `require` does NOT disable.
  if (!drStage || drStage.disabled || drStage.verify?.require === false) {
    return { ok: false, error: "design_review_disabled" };
  }
  if (!drStage.agentPath || !drStage.skillPath) {
    return { ok: false, error: "design_review_config_invalid" } as const;
  }
  return { ok: true, stage: drStage };
}

/**
 * Resolve the requirement/plan document context for a design-review entry.
 * Convention (same as the plan stage, 201 Phase 1: `_Plan.md`): the plan doc
 * is derived from the requirement doc through the SINGLE-SOURCE naming helper
 * `planDocRelPathFromRequirementDoc` (213 Phase 2 / D16 — the old inline
 * `replace(/\.md$/, "_Plan.md")` diverged from the naming module: it was not
 * idempotent for `*_Plan.md` inputs (`_Plan_Plan.md` phantom) and ignored the
 * `.MD` casing the naming module tolerates). Paths become absolute against
 * projectRoot and are checked for existence.
 *
 * Fail-closed boundary: when the requirement doc has no derivable base
 * (extension-less or blank — `reqBaseFromRequirementDoc` returns `""`),
 * `planDoc` stays `undefined` so callers report `plan_doc_missing` instead of
 * probing a `"_Plan.md"` phantom path.
 *
 * @returns resolved absolute paths plus existence flags; callers decide how
 *   to report each missing document.
 */
export function resolveDesignReviewEntryDocs(
  config: PipelineConfig,
  meta: SessionMeta,
): {
  requirementDoc?: string;
  planDoc?: string;
  requirementExists: boolean;
  planExists: boolean;
} {
  const toAbsolute = (p: string): string =>
    path.isAbsolute(p) ? path.resolve(p) : path.resolve(config.projectRoot, p);

  const requirementDoc = meta.requirementDoc ? toAbsolute(meta.requirementDoc) : undefined;
  let planDoc: string | undefined;
  if (meta.requirementDoc) {
    const reqBase = reqBaseFromRequirementDoc(meta.requirementDoc);
    if (reqBase.length > 0) {
      planDoc = toAbsolute(planDocRelPathFromRequirementDoc(meta.requirementDoc));
    }
  }

  const exists = (p: string | undefined): boolean => {
    if (!p) return false;
    try {
      fs.accessSync(p);
      return true;
    } catch {
      return false;
    }
  };

  return {
    ...(requirementDoc !== undefined ? { requirementDoc } : {}),
    ...(planDoc !== undefined ? { planDoc } : {}),
    requirementExists: exists(requirementDoc),
    planExists: exists(planDoc),
  };
}

/**
 * Strict report file name patterns for a given plan document basename
 * (dual read, 201 Phase 4):
 * - new: `Design_Review_{round}_{reqBase}_Design.md`, where `{reqBase}` is the
 *   plan stem with the trailing `_Plan` marker stripped;
 * - legacy: `review-design-{round}-{...}.md` — the round matches BOTH historical
 *   base-name shapes on disk (`{planBasename}` from the pre-201 plan-name era
 *   AND the bare `{reqBase}` form), via the doc-naming single-source matcher
 *   `LEGACY_DESIGN_REVIEW_RE` (201 review issue 2: the old code anchored the
 *   legacy branch to the CURRENT `_Plan.md` basename and therefore missed the
 *   historical `review-design-{n}-{reqBase}.md` and
 *   `review-design-{n}-{planBasename}.md` shapes).
 * Round must be a positive integer in both shapes.
 */
function reviewFileNamePattern(planBasename: string): RegExp {
  const reqBase = reqBaseFromPlanStem(planBasename.replace(/\.[^.]+$/, ""));
  // Legacy: generic family matcher from doc-naming (round is its capture group 1).
  const legacy = LEGACY_DESIGN_REVIEW_RE.source;
  // Modern: anchored to THIS plan's reqBase so round allocation only counts
  // this plan's reports (Plan 201 Phase 4 task 2: strict per-plan modern branch).
  const modern = `^Design_Review_(\\d+)_${escapeRegex(reqBase)}_Design\\.md$`;
  return new RegExp(`(?:${legacy})|(?:${modern})`);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan the plan document's directory for existing review reports that match
 * the STRICT naming pattern of THIS plan and return their round numbers.
 * This is the I/O half of safe round allocation: persisted reports from
 * previous authorizations must never be overwritten (F02 / K07).
 *
 * Unreadable directories yield an empty history (caller treats it as
 * "no known rounds"); the scan only counts files, it never reads contents.
 */
export function collectExistingReviewRounds(planDoc: string): number[] {
  const dir = path.dirname(planDoc);
  const base = path.basename(planDoc);
  const re = reviewFileNamePattern(base);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rounds: number[] = [];
  for (const entry of entries) {
    const m = re.exec(entry);
    if (m) {
      const roundSource = m[1] ?? m[2] ?? "";
      const round = Number.parseInt(roundSource, 10);
      if (Number.isInteger(round) && round >= 1) {
        rounds.push(round);
      }
    }
  }
  return rounds;
}

/**
 * Pick a safe next round for a NEW authorization on this plan document:
 * one past the highest strictly-named existing report, never reusing an
 * occupied round path.
 */
export function pickSafeNextRound(planDoc: string): number {
  return allocateNextRoundSafe(collectExistingReviewRounds(planDoc));
}
