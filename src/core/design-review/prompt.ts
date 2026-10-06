/**
 * @module design-review/prompt
 * Phase 1 / 191 + 192 Phase 2: Design review update-prompt SELECTION and
 * rendering.
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
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
import { computeHash } from "./state";
import { readStrictPromptKey } from "../prompt-config";
import { DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT } from "../../constants";

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
  readonly code:
    | "empty-value" | "non-string" | "read-error" | "parse-error" | "shape-error"
    | "missing-param" | "unknown-token" | "residual-token";
  readonly filePath?: string;
  readonly key?: string;
  readonly detail?: string;

  constructor(
    code: DesignReviewUpdateConfigError["code"],
    message: string,
    init?: { filePath?: string; key?: string; detail?: string; cause?: unknown },
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

/** Auditable result of selecting the update template text. */
export interface DesignReviewUpdateTemplateSelection {
  /** "yaml" = project custom config; "default" = constants built-in */
  source: "yaml" | "default";
  /** Resolved YAML file path (absent for the constants default) */
  path?: string;
  /** Config key consulted */
  key: string;
  /** SHA-256 of the template TEXT actually used for this dispatch */
  contentHash: string;
  /** The template text */
  templateText: string;
}

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

type RuntimeToken = (typeof RUNTIME_TOKENS)[number];

/**
 * 192 Phase 2 (task 1/2): select the update template from the project YAML,
 * located at the RESOLVED piWorkDir. missing-file / missing-key fall to the
 * constants default (recorded auditable source); every other problem throws
 * DesignReviewUpdateConfigError and the caller must BLOCK dispatch.
 */
export async function selectDesignReviewUpdateTemplate(
  config: PipelineConfig,
): Promise<DesignReviewUpdateTemplateSelection> {
  // Resolve the plugin asset dir the same way dispatch does today
  const { resolvePiWorkDir } = await import("../../utils/work-dir");
  const workDir = resolvePiWorkDir(config);
  const res = await readStrictPromptKey(config.projectRoot, DESIGN_REVIEW_UPDATE_PROMPT_KEY, workDir);

  switch (res.status) {
    case "found":
      return {
        source: "yaml",
        path: res.filePath,
        key: DESIGN_REVIEW_UPDATE_PROMPT_KEY,
        contentHash: computeHash(res.value),
        templateText: res.value,
      };
    case "missing-file":
    case "missing-key":
      // Genuinely not configured → constants default (K04).
      return {
        source: "default",
        key: DESIGN_REVIEW_UPDATE_PROMPT_KEY,
        contentHash: computeHash(DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT),
        templateText: DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT,
      };
    case "invalid-value":
      throw new DesignReviewUpdateConfigError(
        res.reason === "empty" ? "empty-value" : "non-string",
        `Design review update prompt key "${DESIGN_REVIEW_UPDATE_PROMPT_KEY}" is ${res.reason} in ${res.filePath}. ` +
          `Fix the YAML value or remove the key to use the built-in default.`,
        { filePath: res.filePath, key: DESIGN_REVIEW_UPDATE_PROMPT_KEY },
      );
    case "read-error":
      throw new DesignReviewUpdateConfigError(
        "read-error",
        `Failed to read design review update prompt config ${res.filePath}: ${res.error.message}`,
        { filePath: res.filePath, key: DESIGN_REVIEW_UPDATE_PROMPT_KEY, cause: res.error },
      );
    case "parse-error":
      throw new DesignReviewUpdateConfigError(
        "parse-error",
        `Failed to parse design review update prompt config ${res.filePath}: ${res.error.message}`,
        { filePath: res.filePath, key: DESIGN_REVIEW_UPDATE_PROMPT_KEY, cause: res.error },
      );
    case "shape-error":
    default:
      throw new DesignReviewUpdateConfigError(
        "shape-error",
        `Design review update prompt config ${res.filePath} is not a YAML mapping at the top level`,
        { filePath: res.filePath, key: DESIGN_REVIEW_UPDATE_PROMPT_KEY },
      );
  }
}

/**
 * 192 Phase 2 (task 4): strict text renderer.
 *
 * Rules:
 * - Supports EXACTLY the declared runtime tokens in `{field}` and
 *   `{{field}}` form. Where both occur, double-brace is replaced first;
 *   both render the same value.
 * - A SINGLE scanning pass replaces tokens; substituted VALUES are never
 *   re-scanned (no recursive substitution), and string-replace `$`
 *   interpolation semantics are avoided by using a function replacer.
 * - Required params must be non-empty; a declared token PRESENT in the
 *   template whose param is empty blocks ("missing-param").
 * - After rendering, any leftover bare-identifier brace token is reported:
 *   known name → residual-token; unknown name → unknown-token. JSON/code
 *   literals with non-identifier brace contents are NOT touched.
 *
 * @throws DesignReviewUpdateConfigError on any blocking condition.
 */
export function renderDesignReviewUpdatePromptText(
  templateText: string,
  params: DesignReviewUpdatePromptParams,
): string {
  if (typeof templateText !== "string" || templateText.trim() === "") {
    throw new DesignReviewUpdateConfigError(
      "empty-value",
      "Design review update template text is empty; refusing to dispatch an empty prompt",
    );
  }

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

  const tokenValues: Record<RuntimeToken, string> = {
    pipelineId: params.pipelineId,
    planDoc: params.planDoc,
    reviewDoc: params.reviewDoc,
    round: String(params.round),
    operationId: params.operationId,
    baselinePlanHash: params.baselinePlanHash,
    issues: issuesText,
    requirementDoc: params.requirementDoc ?? "",
  };

  // Optional-but-referenced tokens: block when template asks for a token the
  // caller cannot provide (requirementDoc absence is otherwise tolerated).
  const referenced = new Set<string>();
  const scanRe = /\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?\}/g;
  let scanMatch: RegExpExecArray | null;
  while ((scanMatch = scanRe.exec(templateText)) !== null) {
    referenced.add(scanMatch[1]!);
  }
  const blocked = [...referenced].filter(
    (name) => RUNTIME_TOKENS.includes(name as RuntimeToken) && tokenValues[name as RuntimeToken] === "",
  );
  if (blocked.length > 0) {
    throw new DesignReviewUpdateConfigError(
      "missing-param",
      `Update template references runtime tokens without provided values: ${blocked.join(", ")}`,
    );
  }

  // Single-pass replacement — double-brace alternative first so {{x}} is not
  // partially eaten by {x}; function replacer avoids `$&`/`$$` semantics and
  // never re-scans substituted values.
  const replaceRe = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
  const rendered = templateText.replace(replaceRe, (whole, doubleName?: string, singleName?: string) => {
    const name = doubleName ?? singleName ?? "";
    if (RUNTIME_TOKENS.includes(name as RuntimeToken)) {
      return tokenValues[name as RuntimeToken];
    }
    // Unknown brace token: leave it in place; residual scan below blocks.
    return whole;
  });

  // Post-render residual scan: any surviving declared token means something
  // went wrong; any surviving UNKNOWN bare-identifier token is a template
  // error (example fields must not use braces).
  const residualRe = /\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?\}/g;
  const residualKnown: string[] = [];
  const residualUnknown: string[] = [];
  let rm: RegExpExecArray | null;
  while ((rm = residualRe.exec(rendered)) !== null) {
    const name = rm[1]!;
    if (RUNTIME_TOKENS.includes(name as RuntimeToken)) residualKnown.push(name);
    else residualUnknown.push(name);
  }
  if (residualKnown.length > 0) {
    throw new DesignReviewUpdateConfigError(
      "residual-token",
      `Update template produced unconsumed runtime tokens: ${[...new Set(residualKnown)].join(", ")}`,
    );
  }
  if (residualUnknown.length > 0) {
    throw new DesignReviewUpdateConfigError(
      "unknown-token",
      `Update template contains unknown runtime tokens: ${[...new Set(residualUnknown)].join(", ")}. ` +
        `Only declared tokens (${RUNTIME_TOKENS.join(", ")}) may use brace syntax; write example fields without braces.`,
    );
  }

  return rendered;
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
