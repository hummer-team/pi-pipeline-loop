/**
 * @module design-review/prompt
 * Phase 1 / 191 + 192 Phase 2 + 193 Phase 1: Design review update-prompt
 * SELECTION and rendering.
 *
 * Source policy (K04/K05, final decisions):
 * - The project YAML key `design_review_update_prompt`
 *   ({piWorkDir}/references/pipeline-stage-prompt.yml) is the ONLY custom
 *   prompt source.
 * - ONLY a genuinely ABSENT file or key falls back to the built-in
 *   `DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT` from constants.
 * - Explicit empty/non-string values and read/parse/template errors BLOCK
 *   the update dispatch (never a silent default swap).
 * - The independent `.pi/references/design-review-update-prompt.md` is a
 *   historical asset; it is no longer consumed or advertised as a runtime
 *   fallback.
 *
 * Both production dispatch paths (FAIL-consumption and update_ready retry)
 * call the SAME select+render functions — no path-local template logic.
 *
 * 193 Phase 1: the MECHANICAL strict selection/render engine moved to
 * `prompt-template.ts` so the smart decision prompt reuses ONE engine. The
 * update-specific API surface, error class and REQUIRED-issues validation
 * stay here and are unchanged for callers.
 */

import type { PipelineConfig } from "../../types";
import { DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT } from "../../constants";
import {
  renderStrictPromptTemplate,
  selectStrictPromptTemplate,
  type StrictPromptErrorCode,
  type StrictPromptErrorInit,
  type StrictPromptErrorFactory,
  type StrictPromptTemplateSelection,
} from "./prompt-template";

/** YAML key holding the authorized update prompt. */
export const DESIGN_REVIEW_UPDATE_PROMPT_KEY = "design_review_update_prompt";

/**
 * Parameters required for rendering an update prompt.
 * The identity fields bind the rendered prompt to the CURRENT update
 * operation; issues carry the consumed report's valid issue texts.
 */
export interface DesignReviewUpdatePromptParams {
  /** Pipeline ID */
  pipelineId: string;
  /** Path to the plan document */
  planDoc: string;
  /** Path to the review report */
  reviewDoc: string;
  /** Current review round */
  round: number;
  /** Operation ID for THIS update (the new update operationId) */
  operationId: string;
  /** Hash of the plan before update (baseline) */
  baselinePlanHash: string;
  /** List of issues from the review report */
  issues: string[];
  /** 192 Phase 2: optional requirement doc context token */
  requirementDoc?: string;
}

/**
 * 192 Phase 2: error raised when the update prompt CONFIGURATION is invalid
 * (explicit empty/non-string value, YAML read/parse failure, or a template
 * that cannot be rendered strictly). Carries the failing file/key so callers
 * can report the concrete file and key (Phase 4 pre-check reuses the codes).
 */
export class DesignReviewUpdateConfigError extends Error {
  readonly code: StrictPromptErrorCode;
  readonly filePath?: string;
  readonly key?: string;
  readonly detail?: string;

  constructor(
    code: StrictPromptErrorCode,
    message: string,
    init?: StrictPromptErrorInit,
  ) {
    super(message);
    this.name = "DesignReviewUpdateConfigError";
    this.code = code;
    if (init?.filePath !== undefined) this.filePath = init.filePath;
    if (init?.key !== undefined) this.key = init.key;
    if (init?.detail !== undefined) this.detail = init.detail;
    if (init?.cause !== undefined) {
      // Attach the original error (with its stack) for auditability
      (this as Error & { cause?: unknown }).cause = init.cause;
    }
  }
}

const updateErrorFor: StrictPromptErrorFactory = (code, message, init) =>
  new DesignReviewUpdateConfigError(code, message, init);

/**
 * Auditable result of selecting the update template text. 193 Phase 1: the
 * shape is the shared strict selection type (same fields, same semantics);
 * the named alias is kept for existing callers.
 */
export type DesignReviewUpdateTemplateSelection = StrictPromptTemplateSelection;

/**
 * Declared runtime token names. Templates may reference these as `{name}`
 * or `{{name}}` (double-brace wins; both render the SAME value). No other
 * bare-identifier brace token is substituted.
 */
const RUNTIME_TOKENS = [
  "pipelineId",
  "planDoc",
  "reviewDoc",
  "round",
  "operationId",
  "baselinePlanHash",
  "issues",
  "requirementDoc",
] as const;

/**
 * 192 Phase 2 (task 1/2): select the update template from the project YAML,
 * located at the RESOLVED piWorkDir. missing-file / missing-key fall to the
 * constants default (recorded auditable source); every other problem throws
 * DesignReviewUpdateConfigError and the caller must BLOCK dispatch.
 *
 * 193 Phase 1: the status→selection mechanics live in prompt-template.ts.
 */
export async function selectDesignReviewUpdateTemplate(
  config: PipelineConfig,
): Promise<DesignReviewUpdateTemplateSelection> {
  return selectStrictPromptTemplate({
    config,
    key: DESIGN_REVIEW_UPDATE_PROMPT_KEY,
    nameLabel: "update",
    defaultText: DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT,
    errorFor: updateErrorFor,
  });
}

/**
 * 192 Phase 2 (task 4): strict text renderer.
 *
 * Update-specific rules (kept HERE, never shared with the smart prompt):
 * - REQUIRED params: pipelineId/planDoc/reviewDoc/round/operationId/
 *   baselinePlanHash/issues must all be provided (issues is REQUIRED to be
 *   an array — an EMPTY list renders "No issues found.").
 * - The issues list renders as a numbered block token value.
 * Token mechanics ({name}/{{name}}, single pass, no re-scan of values,
 * residual/unknown brace blocking) are the shared engine semantics.
 *
 * @throws DesignReviewUpdateConfigError on any blocking condition.
 */
export function renderDesignReviewUpdatePromptText(
  templateText: string,
  params: DesignReviewUpdatePromptParams,
): string {
  // Core param validation (fail-closed, same spirit as 191 renderer)
  const checks: Record<string, boolean> = {
    pipelineId: !!params.pipelineId,
    planDoc: !!params.planDoc,
    reviewDoc: !!params.reviewDoc,
    round: params.round > 0,
    operationId: !!params.operationId,
    baselinePlanHash: !!params.baselinePlanHash,
    issues: Array.isArray(params.issues),
  };
  const missingCore = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (missingCore.length > 0) {
    throw new DesignReviewUpdateConfigError(
      "missing-param",
      `Missing required parameters for update prompt: ${missingCore.join(", ")}`,
    );
  }

  const issuesText = params.issues.length > 0
    ? params.issues.map((issue, idx) => `${idx + 1}. ${issue}`).join("\n")
    : "No issues found.";

  return renderStrictPromptTemplate({
    templateText,
    tokens: RUNTIME_TOKENS,
    values: {
      pipelineId: params.pipelineId,
      planDoc: params.planDoc,
      reviewDoc: params.reviewDoc,
      round: String(params.round),
      operationId: params.operationId,
      baselinePlanHash: params.baselinePlanHash,
      issues: issuesText,
      requirementDoc: params.requirementDoc ?? "",
    },
    label: "Update template",
    errorFor: updateErrorFor,
  });
}

/**
 * 192 Phase 2 (task 3): the SINGLE selection+render entry used by BOTH
 * production dispatch paths. Records the audited source selection; throws
 * DesignReviewUpdateConfigError for any blocking configuration/template
 * problem (callers must keep the operation undispatched).
 */
export async function buildDesignReviewUpdatePrompt(
  config: PipelineConfig,
  params: DesignReviewUpdatePromptParams,
): Promise<{ prompt: string; selection: DesignReviewUpdateTemplateSelection }> {
  const selection = await selectDesignReviewUpdateTemplate(config);
  const prompt = renderDesignReviewUpdatePromptText(selection.templateText, params);
  return { prompt, selection };
}

/**
 * Load and validate issues from a review report for update prompt generation.
 *
 * @param reviewDoc - Path to the review report
 * @returns List of issues, or empty array if none found or file unreadable
 */
export { extractReportIssues as loadIssuesForUpdate } from "./report";
