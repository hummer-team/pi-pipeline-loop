/**
 * @module design-review/smart-prompt
 * 193 Phase 1: SMART plan-revision decision prompt — selection, rendering
 * and the shared guidance builder used by BOTH the review-dispatch exact
 * prompt and the stage system-prompt injection.
 *
 * Source policy (identical strictness to the 192 update prompt):
 * - the project YAML key `design_review_smart_decision_prompt` in
 *   `{piWorkDir}/references/pipeline-stage-prompt.yml` is the ONLY custom
 *   source;
 * - ONLY a genuinely absent file or key falls back to the built-in
 *   `DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT` from constants;
 * - explicit empty/non-string values and read/parse/shape/token errors BLOCK
 *   the review dispatch (never a silent degradation to auto behaviour);
 * - the selection source (yaml/default + content hash) is auditable — the
 *   builder returns it and the coordinator records an audit event.
 *
 * The smart prompt NEVER reuses the update prompt's REQUIRED-issues
 * validation: its token set is the review identity only
 * ({pipelineId} {planDoc} {round} {operationId} {inputHash} {reportDoc}).
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT } from "../../constants";
// 193 round-2 fix (review issue 1): the decision-pending window is read-only;
// the injected smart review protocol must not advertise writing the report.
import { isDesignReviewDecisionPending } from "./decision-guard";
import {
  renderStrictPromptTemplate,
  selectStrictPromptTemplate,
  type StrictPromptErrorCode,
  type StrictPromptErrorInit,
  type StrictPromptTemplateSelection,
  type StrictPromptErrorFactory,
} from "./prompt-template";
import { deriveReportPath } from "./state";

/** YAML key holding the smart plan-revision decision guidance. */
export const DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY = "design_review_smart_decision_prompt";

/**
 * Rendering parameters — the CURRENT review operation candidate identity.
 * All fields are REQUIRED (there is no issues-style optional token): the
 * guidance binds the decision protocol to exactly one review operation.
 */
export interface DesignReviewSmartPromptParams {
  /** Pipeline ID */
  pipelineId: string;
  /** Path to the plan document under review */
  planDoc: string;
  /** Review round this guidance is rendered for */
  round: number;
  /** Review operation ID the guidance is bound to */
  operationId: string;
  /** Review inputHash (authorized plan content hash) */
  inputHash: string;
  /** Path to the report document this review must write */
  reportDoc: string;
}

/**
 * Error raised when the smart decision prompt CONFIGURATION is invalid
 * (explicit empty/non-string value, YAML read/parse failure, or a template
 * that cannot be rendered strictly). Same taxonomy as the update prompt;
 * callers must BLOCK the dispatch.
 */
export class DesignReviewSmartPromptError extends Error {
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
    this.name = "DesignReviewSmartPromptError";
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

const smartErrorFor: StrictPromptErrorFactory = (code, message, init) =>
  new DesignReviewSmartPromptError(code, message, init);

/** Declared runtime token names for the smart decision prompt. */
export const SMART_PROMPT_RUNTIME_TOKENS = [
  "pipelineId",
  "planDoc",
  "round",
  "operationId",
  "inputHash",
  "reportDoc",
] as const;

/**
 * Select the smart decision template from the RESOLVED piWorkDir YAML, or
 * fall back to the constants default ONLY for a genuinely missing file/key.
 *
 * @param reloadFile - explicit-recovery reload (used by dispatch preparation
 *   so a fixed config is re-read without a global cache clear).
 */
export async function selectDesignReviewSmartTemplate(
  config: PipelineConfig,
  opts?: { reloadFile?: boolean },
): Promise<StrictPromptTemplateSelection> {
  return selectStrictPromptTemplate({
    config,
    key: DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY,
    nameLabel: "smart decision",
    defaultText: DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT,
    errorFor: smartErrorFor,
    reloadFile: opts?.reloadFile,
  });
}

/**
 * Strict render of the smart guidance text for one review candidate identity.
 * Unlike the update renderer there is NO issues parameter — smart mode must
 * not inherit the update's required-issues validation.
 *
 * @throws DesignReviewSmartPromptError on empty text, missing params or
 * residual/unknown tokens.
 */
export function renderDesignReviewSmartTemplateText(
  templateText: string,
  params: DesignReviewSmartPromptParams,
): string {
  const checks: Record<string, boolean> = {
    pipelineId: params.pipelineId !== "",
    planDoc: params.planDoc !== "",
    round: params.round > 0,
    operationId: params.operationId !== "",
    inputHash: params.inputHash !== "",
    reportDoc: params.reportDoc !== "",
  };
  const missingCore = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (missingCore.length > 0) {
    throw new DesignReviewSmartPromptError(
      "missing-param",
      `Missing required parameters for smart decision prompt: ${missingCore.join(", ")}`,
    );
  }

  return renderStrictPromptTemplate({
    templateText,
    tokens: SMART_PROMPT_RUNTIME_TOKENS,
    values: {
      pipelineId: params.pipelineId,
      planDoc: params.planDoc,
      round: String(params.round),
      operationId: params.operationId,
      inputHash: params.inputHash,
      reportDoc: params.reportDoc,
    },
    label: "Smart decision template",
    errorFor: smartErrorFor,
  });
}

/**
 * The SINGLE select+render entry shared by the coordinator review-dispatch
 * preparation and the system-prompt injection builder. Returns the rendered
 * guidance AND the auditable source selection. Any explicit configuration
 * problem throws — the caller must block the real dispatch (never fall back
 * to auto behaviour).
 */
export async function buildDesignReviewSmartPrompt(
  config: PipelineConfig,
  params: DesignReviewSmartPromptParams,
  opts?: { reloadFile?: boolean },
): Promise<{ guidance: string; selection: StrictPromptTemplateSelection }> {
  const selection = await selectDesignReviewSmartTemplate(config, opts);
  const guidance = renderDesignReviewSmartTemplateText(selection.templateText, params);
  return { guidance, selection };
}

/**
 * 193 Phase 1 (task 4): the SHARED guidance section builder used by prompt
 * injection (delegated from prompt-injector.ts so dispatch and the stage
 * system prompt always render the SAME protocol text).
 *
 * Returns null when smart review guidance does not apply: not a design-review
 * stage, no current review operation, a phase without a bound operation
 * identity, a non-smart mode, or the decision-pending READ-ONLY window (193
 * round-2 fix, review issue 1: while a human plan-revision decision awaits a
 * choice, the injected protocol must NOT tell the model to append sections to
 * the report — that contradicts the read-only dynamic context and would
 * encourage self-execution). A blocked template read also returns null
 * HERE (injection is not the enforcement point) — the dispatch preparation
 * path is what BLOCKS the real RPC on invalid config.
 */
export async function buildDesignReviewSmartGuidanceSection(
  config: PipelineConfig,
  meta: SessionMeta | undefined,
): Promise<string | null> {
  const state = meta?.designReview;
  const operation = state?.operation;
  if (meta?.currentStage !== "design-review" || !state || !operation || operation.kind !== "review") {
    return null;
  }
  // 193 round-2 fix (review issue 1): suppress the whole smart protocol during
  // the decision-pending read-only window (the report is frozen at the FAIL
  // snapshot the human decision binds to; only /pipeline-resume moves forward).
  if (isDesignReviewDecisionPending(meta)) {
    return null;
  }
  // Mode: prefer the mode PINNED on the running operation; legacy unpinned
  // operations resolve from the stage config (never fabricating authority).
  const mode = operation.reviewConfirmMode
    ?? config.stages?.["design-review"]?.confirm?.mode
    ?? "auto";
  if (mode !== "smart") return null;

  try {
    const built = await buildDesignReviewSmartPrompt(config, {
      pipelineId: meta.pipelineId ?? "unknown",
      planDoc: state.planDoc,
      round: state.round,
      operationId: operation.operationId,
      inputHash: operation.inputHash ?? state.planHash ?? "",
      reportDoc: state.reportDoc ?? deriveReportPath(state.planDoc, state.round),
    });
    return built.guidance;
  } catch {
    // Invalid smart prompt config: the dispatch path blocks loudly; the
    // injected stage prompt simply omits the paragraph (null → removal).
    return null;
  }
}
