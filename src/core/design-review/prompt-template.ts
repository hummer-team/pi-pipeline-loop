/**
 * @module design-review/prompt-template
 * 193 Phase 1: the MECHANICAL strict prompt selection/render engine extracted
 * from `prompt.ts` so the update prompt (192) and the smart decision prompt
 * (193) share ONE implementation.
 *
 * Policy split (intentional):
 * - This module knows ONLY the mechanics: the strict YAML key read status
 *   mapping, token substitution and residual scanning. It carries NO domain
 *   parameter rules — e.g. the update prompt's REQUIRED issues array stays in
 *   `prompt.ts`, and the smart prompt must NEVER inherit that validation.
 * - Every problem the engine cannot silently absorb becomes a thrown error
 *   built by the caller's `errorFor` factory, so each domain keeps its own
 *   error class/codes while the blocking semantics stay identical: ONLY a
 *   missing file/key may fall back to a default; everything else BLOCKS.
 */

import type { PipelineConfig } from "../../types";
import { computeHash } from "./state";
import {
  invalidateStrictPromptCache,
  readStrictPromptKey,
  strictPromptFilePath,
} from "../prompt-config";

/** Shared taxonomy of blocking strict-prompt configuration problems. */
export type StrictPromptErrorCode =
  | "empty-value"
  | "non-string"
  | "read-error"
  | "parse-error"
  | "shape-error"
  | "missing-param"
  | "unknown-token"
  | "residual-token"
  /**
   * 194 Phase 1 (C1/C2): a CUSTOM template omits a token the domain contract
   * makes mandatory (e.g. an update prompt without `{updateReceiptDoc}` still
   * describes the legacy embedded-receipt shape). Blocking message carries the
   * exact key and file path; never a silent fallback to the built-in default.
   */
  | "missing-token";

/** Extra context attached to a strict prompt error (audit + user text). */
export interface StrictPromptErrorInit {
  filePath?: string;
  key?: string;
  detail?: string;
  cause?: unknown;
}

/** Caller-provided error factory: keeps domain error classes compatible. */
export type StrictPromptErrorFactory = (
  code: StrictPromptErrorCode,
  message: string,
  init?: StrictPromptErrorInit,
) => Error;

/** Auditable result of selecting strict template text. */
export interface StrictPromptTemplateSelection {
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
 * Select strict template text for one YAML key at the RESOLVED piWorkDir.
 *
 * missing-file / missing-key fall to the caller-supplied constants default
 * (recorded with an auditable source); empty/non-string values and
 * read/parse/shape problems throw via `errorFor` and the caller MUST BLOCK
 * dispatch (never a silent default swap).
 *
 * @param reloadFile - Explicit-recovery reload: invalidate the strict-parse
 *   cache for THIS actual file path before reading, so a fixed config is
 *   picked up without globally clearing other projects' caches. Dispatch
 *   preparation uses it (one read per operation is cheap); hot paths such as
 *   prompt injection keep the cache.
 */
export async function selectStrictPromptTemplate(params: {
  config: PipelineConfig;
  key: string;
  /** Human name used in messages, e.g. "update" / "smart decision" */
  nameLabel: string;
  defaultText: string;
  errorFor: StrictPromptErrorFactory;
  reloadFile?: boolean;
}): Promise<StrictPromptTemplateSelection> {
  const { config, key, nameLabel, defaultText, errorFor } = params;
  // Resolve the plugin asset dir the same way dispatch does today
  const { resolvePiWorkDir } = await import("../../utils/work-dir");
  const workDir = resolvePiWorkDir(config);
  if (params.reloadFile === true) {
    invalidateStrictPromptCache(strictPromptFilePath(config.projectRoot, workDir));
  }
  const res = await readStrictPromptKey(config.projectRoot, key, workDir);

  switch (res.status) {
    case "found":
      return {
        source: "yaml",
        path: res.filePath,
        key,
        contentHash: computeHash(res.value),
        templateText: res.value,
      };
    case "missing-file":
    case "missing-key":
      // Genuinely not configured → constants default (K04).
      return {
        source: "default",
        key,
        contentHash: computeHash(defaultText),
        templateText: defaultText,
      };
    case "invalid-value":
      throw errorFor(
        res.reason === "empty" ? "empty-value" : "non-string",
        `Design review ${nameLabel} prompt key "${key}" is ${res.reason} in ${res.filePath}. ` +
          `Fix the YAML value or remove the key to use the built-in default.`,
        { filePath: res.filePath, key },
      );
    case "read-error":
      throw errorFor(
        "read-error",
        `Failed to read design review ${nameLabel} prompt config ${res.filePath}: ${res.error.message}`,
        { filePath: res.filePath, key, cause: res.error },
      );
    case "parse-error":
      throw errorFor(
        "parse-error",
        `Failed to parse design review ${nameLabel} prompt config ${res.filePath}: ${res.error.message}`,
        { filePath: res.filePath, key, cause: res.error },
      );
    case "shape-error":
    default:
      throw errorFor(
        "shape-error",
        `Design review ${nameLabel} prompt config ${res.filePath} is not a YAML mapping at the top level`,
        { filePath: res.filePath, key },
      );
  }
}

/**
 * Strict single-pass template renderer shared by all design-review prompts.
 *
 * Rules (identical semantics to the historical update renderer):
 * - Supports EXACTLY the declared tokens in `{name}` and `{{name}}` form;
 *   both render the SAME value, double-brace is consumed first.
 * - A single scanning pass substitutes; substituted VALUES are never
 *   re-scanned, and `$`-interpolation semantics are avoided via a function
 *   replacer.
 * - A declared token referenced by the template whose value is empty blocks
 *   ("missing-param"); caller-side REQUIRED params are validated by the
 *   caller BEFORE this engine runs.
 * - After rendering, surviving braces with identifier contents are reported:
 *   a declared token → residual-token; any other → unknown-token. JSON/code
 *   literals with non-identifier brace contents are NOT touched.
 *
 * @throws whatever `errorFor` returns for a blocking condition.
 */
export function renderStrictPromptTemplate(params: {
  templateText: string;
  /** Allowed bare-identifier token names */
  tokens: readonly string[];
  /** Token → value map; "" means "not provided" (blocks only if referenced) */
  values: Record<string, string>;
  /** Message subject, e.g. "Update template" / "Smart decision template" */
  label: string;
  errorFor: StrictPromptErrorFactory;
}): string {
  const { templateText, tokens, values, label, errorFor } = params;

  if (typeof templateText !== "string" || templateText.trim() === "") {
    throw errorFor(
      "empty-value",
      `${label} text is empty; refusing to dispatch an empty prompt`,
    );
  }

  // Optional-but-referenced tokens: block when the template asks for a token
  // the caller cannot provide.
  const referenced = new Set<string>();
  const scanRe = /\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?\}/g;
  let scanMatch: RegExpExecArray | null;
  while ((scanMatch = scanRe.exec(templateText)) !== null) {
    referenced.add(scanMatch[1]!);
  }
  const blocked = [...referenced].filter(
    (name) => tokens.includes(name) && values[name] === "",
  );
  if (blocked.length > 0) {
    throw errorFor(
      "missing-param",
      `${label} references runtime tokens without provided values: ${blocked.join(", ")}`,
    );
  }

  // Single-pass replacement — double-brace alternative first so {{x}} is not
  // partially eaten by {x}; function replacer avoids `$&`/`$$` semantics and
  // never re-scans substituted values.
  const replaceRe = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
  const rendered = templateText.replace(replaceRe, (whole, doubleName?: string, singleName?: string) => {
    const name = doubleName ?? singleName ?? "";
    if (tokens.includes(name)) {
      return values[name] ?? "";
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
    if (tokens.includes(name)) residualKnown.push(name);
    else residualUnknown.push(name);
  }
  if (residualKnown.length > 0) {
    throw errorFor(
      "residual-token",
      `${label} produced unconsumed runtime tokens: ${[...new Set(residualKnown)].join(", ")}`,
    );
  }
  if (residualUnknown.length > 0) {
    throw errorFor(
      "unknown-token",
      `${label} contains unknown runtime tokens: ${[...new Set(residualUnknown)].join(", ")}. ` +
        `Only declared tokens (${tokens.join(", ")}) may use brace syntax; write example fields without braces.`,
    );
  }

  return rendered;
}
