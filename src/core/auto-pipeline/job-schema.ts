/**
 * @module auto-pipeline/job-schema
 * 219 Phase 1: task-level YAML job definition — parsing / validation / default
 * filling (fail-fast).
 *
 * Facts:
 * - The job file is USER-MAINTAINED. The plugin NEVER writes back to it; all
 *   progress lives in the sidecar (`job-state.ts`).
 * - Only IMPLEMENTED values are accepted. Anything "known but not supported in
 *   v1" is a hard ERROR (not silently degraded): `clarify.mode:"prefilled"`,
 *   `clarify.fallback`, `clarify.answerStrategy`, `designReview.mode:"manual"`.
 *   Unknown-by-shape keys stay a WARNING.
 * - `decisionPolicy` is JOB-PRIVATE. It is consumed ONLY by freeze-autopilot
 *   and is NEVER written into `json.decisionPolicy` (that block belongs to the
 *   210 provider chain, and its byReason values are `DecisionPolicyRule`
 *   objects — structurally incompatible with `FreezeAction` strings).
 * - Defaults are filled at the schema layer so downstream code never sees
 *   `undefined` inside `stopConditions` (an `undefined < 1 === false` would
 *   silently disable a budget). Every filled default is listed in `warnings`.
 */

import { createHash } from "node:crypto";
import { parse as yamlParse } from "yaml";
import type { PipelineStage } from "../../types";
import { RESUMABLE_STAGES } from "../../constants";

/** One queued document of the job. */
export interface AutoJobDoc {
  /** Project-relative, project-internal `.md` path. */
  doc: string;
  /** Optional entry stage; must be in RESUMABLE_STAGES. Default "clarify". */
  startStage?: PipelineStage;
}

/**
 * Decision a frozen pipeline is auto-routed to. JOB-PRIVATE semantics —
 * deliberately NOT a member of the 210 `PipelineDecision` union, because the
 * freeze-autopilot never dispatches provider-chain decisions.
 */
export type FreezeAction = "resume" | "abort" | "stop-and-report";

/** v1 job document shape. Defaults are filled by `parseAutoJob` before return. */
export interface AutoJobConfig {
  version: 1;
  enabled: boolean;
  docs: { list: AutoJobDoc[]; skipCompleted: boolean; onFailure: "stop" | "continue" };
  /** v1 accepts only "self-answer" | "orchestrated" (prefilled → parse error). */
  clarify: { mode: "self-answer" | "orchestrated"; maxRounds: number };
  confirm: { plan: "auto" | "manual" | "smart"; review: "auto" | "manual" | "smart" };
  /** v1 accepts only "auto" (template `design-review.confirm.mode` default is already auto). */
  designReview: { mode: "auto"; maxRounds: number; failAction: "auto-revise" | "stop" };
  reviewFix: { maxRounds: number; maxLoopsPerStage: number };
  writePolicy: {
    whitelistMiss: "ask" | "deny" | "allow";
    protectedPath: "deny" | "ask";
    destructiveCommand: "deny" | "ask";
    allowGlobs: string[];
  };
  decisionPolicy: { onFreeze: FreezeAction; maxAutoResumes: number; byReason: Record<string, FreezeAction> };
  stopConditions: {
    maxConsecutiveVerifyFailures: number;
    maxTotalFreezes: number;
    maxTotalLoops: number;
    wallClockMs: number;
    stopOnBlockedReasons: string[];
    /** 6.3(3): loops granted to the CURRENT doc after the loop brake trips
     *  (0 = disabled, hard cap 3, DEFAULT 1). */
    finalLoopGrace: number;
  };
  chain: { newSession: boolean; onSessionFail: "same-session" | "stop" };
  audit: { recordAutoDecisions: boolean };
}

export type AutoJobParseResult =
  | { ok: true; job: AutoJobConfig; hash: string; warnings: string[] }
  | { ok: false; errors: string[] };

const NOT_SUPPORTED_SUFFIX = "— not supported in this version";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// ─── Field validators (each returns true = keep, false = error) ──────────────

function isConfirmMode(value: unknown): value is "auto" | "manual" | "smart" {
  return value === "auto" || value === "manual" || value === "smart";
}

function applyEnumError(
  errors: string[],
  key: string,
  validLabel: string,
  fallback?: string,
): void {
  errors.push(
    `"${key}" is not a supported value (${validLabel})${fallback ? ` ${fallback}` : ""} ${NOT_SUPPORTED_SUFFIX}`,
  );
}

/**
 * Validate + default-fill `docs`. Returns false on hard error (list missing/empty
 * or an entry violating path rules).
 */
function parseDocsSection(
  raw: unknown,
  errors: string[],
  warnings: string[],
): { list: AutoJobDoc[]; skipCompleted: boolean; onFailure: "stop" | "continue" } | null {
  const docs = asObject(raw);
  if (!docs || !Array.isArray(docs.list) || docs.list.length === 0) {
    errors.push('"docs.list" must be a non-empty array of document entries');
    return null;
  }

  const entries: AutoJobDoc[] = [];
  const seen = new Set<string>();
  for (const item of docs.list) {
    const itemObj = asObject(item);
    if (!itemObj) {
      errors.push('"docs.list[]" entries must carry a "doc" path string');
      return null;
    }
    // Doc path: project-relative .md, no absolute paths, no ".." traversal.
    const doc = itemObj.doc;
    if (typeof doc !== "string" || doc.length === 0) {
      errors.push('"docs.list[]" entries must carry a "doc" path string');
      return null;
    }
    if (doc.startsWith("/") || doc.startsWith("~") || /^[A-Za-z]:[\\/]/.test(doc)) {
      errors.push(`"docs.list[].doc" must be a project-relative path: ${doc}`);
      return null;
    }
    if (doc.split("/").some((seg) => seg === "..")) {
      errors.push(`"docs.list[].doc" must not contain ".." segments: ${doc}`);
      return null;
    }
    if (!doc.endsWith(".md")) {
      errors.push(`"docs.list[].doc" must end with ".md": ${doc}`);
      return null;
    }
    if (seen.has(doc)) {
      warnings.push(`"docs.list" duplicate entry dropped: ${doc}`);
      continue;
    }
    seen.add(doc);

    const startStage = itemObj.startStage;
    let startStageValue: PipelineStage | undefined;
    if (startStage !== undefined) {
      if (!RESUMABLE_STAGES.includes(startStage as PipelineStage)) {
        errors.push(`"docs.list[].startStage" must be one of ${RESUMABLE_STAGES.join(", ")}: ${String(startStage)}`);
        return null;
      }
      startStageValue = startStage as PipelineStage;
    }
    entries.push(startStageValue ? { doc, startStage: startStageValue } : { doc });
  }

  const skipCompleted = docs.skipCompleted === undefined ? true : docs.skipCompleted;
  if (typeof skipCompleted !== "boolean") {
    warnings.push('"docs.skipCompleted" is not a boolean — using default true');
  }
  let onFailure: "stop" | "continue" = "stop";
  if (docs.onFailure !== undefined) {
    if (docs.onFailure === "stop" || docs.onFailure === "continue") {
      onFailure = docs.onFailure;
    } else {
      errors.push(`"docs.onFailure" must be "stop" | "continue": ${String(docs.onFailure)} ${NOT_SUPPORTED_SUFFIX}`);
      return null;
    }
  }
  return {
    list: entries,
    skipCompleted: typeof skipCompleted === "boolean" ? skipCompleted : true,
    onFailure,
  };
}

function isWhitelistMissValue(value: unknown): value is "ask" | "deny" | "allow" {
  return value === "ask" || value === "deny" || value === "allow";
}

function isDenyAskValue(value: unknown): value is "deny" | "ask" {
  return value === "deny" || value === "ask";
}

function parseWritePolicy(
  raw: unknown,
  errors: string[],
): { whitelistMiss: "ask" | "deny" | "allow"; protectedPath: "deny" | "ask"; destructiveCommand: "deny" | "ask"; allowGlobs: string[] } | null {
  const write = asObject(raw) ?? {};
  let whitelistMiss: "ask" | "deny" | "allow" = "deny";
  if (write.whitelistMiss !== undefined) {
    if (isWhitelistMissValue(write.whitelistMiss)) {
      whitelistMiss = write.whitelistMiss;
    } else {
      applyEnumError(errors, "writePolicy.whitelistMiss", '"ask" | "deny" | "allow"');
      return null;
    }
  }
  let protectedPath: "deny" | "ask" = "deny";
  if (write.protectedPath !== undefined) {
    if (isDenyAskValue(write.protectedPath)) {
      protectedPath = write.protectedPath;
    } else {
      applyEnumError(errors, "writePolicy.protectedPath", '"deny" | "ask"');
      return null;
    }
  }
  let destructiveCommand: "deny" | "ask" = "deny";
  if (write.destructiveCommand !== undefined) {
    if (isDenyAskValue(write.destructiveCommand)) {
      destructiveCommand = write.destructiveCommand;
    } else {
      applyEnumError(errors, "writePolicy.destructiveCommand", '"deny" | "ask"');
      return null;
    }
  }
  let allowGlobs: string[] = [];
  if (write.allowGlobs !== undefined) {
    if (Array.isArray(write.allowGlobs) && write.allowGlobs.every((g) => typeof g === "string")) {
      allowGlobs = (write.allowGlobs as string[]).filter((g) => g.trim().length > 0);
    } else {
      errors.push('"writePolicy.allowGlobs" must be a string[]');
      return null;
    }
  }
  return { whitelistMiss, protectedPath, destructiveCommand, allowGlobs };
}

function parseDecisionPolicy(
  raw: unknown,
  errors: string[],
): { onFreeze: FreezeAction; maxAutoResumes: number; byReason: Record<string, FreezeAction> } | null {
  const policy = asObject(raw) ?? {};
  let onFreeze: FreezeAction = "resume";
  if (policy.onFreeze !== undefined) {
    if (policy.onFreeze === "resume" || policy.onFreeze === "abort" || policy.onFreeze === "stop-and-report") {
      onFreeze = policy.onFreeze;
    } else {
      applyEnumError(errors, "decisionPolicy.onFreeze", '"resume" | "abort" | "stop-and-report"');
      return null;
    }
  }
  let maxAutoResumes = 2;
  if (policy.maxAutoResumes !== undefined) {
    const value = asNonNegativeNumber(policy.maxAutoResumes);
    if (value === null) {
      errors.push('"decisionPolicy.maxAutoResumes" must be a number >= 0');
      return null;
    }
    maxAutoResumes = value;
  }
  const byReason: Record<string, FreezeAction> = {};
  if (policy.byReason !== undefined) {
    const table = asObject(policy.byReason);
    if (!table) {
      errors.push('"decisionPolicy.byReason" must be an object');
      return null;
    }
    for (const [reason, value] of Object.entries(table)) {
      // B2 (round 2): values are FreezeAction ONLY. A 210 PipelineDecision
      // member (e.g. "choose_stage" / "set_budget") is a hard error.
      if (value === "resume" || value === "abort" || value === "stop-and-report") {
        byReason[reason] = value;
      } else {
        applyEnumError(
          errors,
          `decisionPolicy.byReason.${reason}`,
          '"resume" | "abort" | "stop-and-report"',
          `(got ${JSON.stringify(value)})`,
        );
        return null;
      }
    }
  }
  return { onFreeze, maxAutoResumes, byReason };
}

function parseStopConditions(
  raw: unknown,
  errors: string[],
  warnings: string[],
): AutoJobConfig["stopConditions"] | null {
  const stop = asObject(raw) ?? {};

  function numeric(
    key: keyof typeof stop,
    fallback: number,
    minInclusive: number,
  ): number {
    const value = stop[key];
    if (value === undefined) {
      warnings.push(`"stopConditions.${key}" not set — using default ${fallback}`);
      return fallback;
    }
    const num = asNonNegativeNumber(value);
    if (num === null || num < minInclusive) {
      errors.push(`"stopConditions.${key}" must be a number >= ${minInclusive}: ${String(value)}`);
      return Number.NaN;
    }
    return num;
  }

  const maxConsecutiveVerifyFailures = numeric("maxConsecutiveVerifyFailures", 3, 1);
  const maxTotalFreezes = numeric("maxTotalFreezes", 0, 0);
  const maxTotalLoops = numeric("maxTotalLoops", 20, 1);
  const wallClockMs = numeric("wallClockMs", 0, 0);
  if (Number.isNaN(maxConsecutiveVerifyFailures) || Number.isNaN(maxTotalFreezes) || Number.isNaN(maxTotalLoops) || Number.isNaN(wallClockMs)) {
    return null;
  }

  let stopOnBlockedReasons: string[] = [];
  if (stop.stopOnBlockedReasons !== undefined) {
    if (Array.isArray(stop.stopOnBlockedReasons) && stop.stopOnBlockedReasons.every((r) => typeof r === "string")) {
      stopOnBlockedReasons = stop.stopOnBlockedReasons as string[];
    } else {
      errors.push('"stopConditions.stopOnBlockedReasons" must be a string[]');
      return null;
    }
  }

  // 6.3(3): finalLoopGrace — default 1, explicit 0 disables, hard cap 3.
  let finalLoopGrace = 1;
  if (stop.finalLoopGrace !== undefined) {
    const num = asNonNegativeNumber(stop.finalLoopGrace);
    if (num === null || num > 3) {
      errors.push(`"stopConditions.finalLoopGrace" must be a number in [0, 3]: ${String(stop.finalLoopGrace)}`);
      return null;
    }
    finalLoopGrace = num;
  } else {
    warnings.push('"stopConditions.finalLoopGrace" not set — using default 1 (one extra loop after the brake trips)');
  }

  return { maxConsecutiveVerifyFailures, maxTotalFreezes, maxTotalLoops, wallClockMs, stopOnBlockedReasons, finalLoopGrace };
}

/**
 * Pure: raw YAML text + source path → validated job or errors. Never throws.
 * Fills ALL defaults before returning so downstream code never sees `undefined`.
 */
export function parseAutoJob(yamlText: string, sourcePath: string): AutoJobParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = yamlParse(yamlText);
  } catch (err) {
    // yaml@2 throws YAMLParseError-family instances with a linePos in the
    // message; we surface the first line + source path (never throw).
    const message = err instanceof Error ? err.name + ": " + (err.message.split("\n")[0] ?? "") : String(err);
    return { ok: false, errors: [`YAML parse failed for ${sourcePath}: ${message}`] };
  }

  const root = asObject(parsed);
  if (!root) {
    return { ok: false, errors: [`Job file ${sourcePath} must contain a YAML mapping`] };
  }

  // version — must be exactly 1.
  if (root.version !== 1) {
    return { ok: false, errors: [`"version" must be 1${NOT_SUPPORTED_SUFFIX}`] };
  }

  // enabled — non-boolean → false (fail-closed; the parser refuses to start).
  let enabled = true;
  if (root.enabled !== undefined) {
    if (typeof root.enabled === "boolean") {
      enabled = root.enabled;
    } else {
      warnings.push('"enabled" is not a boolean — falling back to false');
      enabled = false;
    }
  }

  const docs = parseDocsSection(root.docs, errors, warnings);

  // clarify — v1: two modes ONLY; the removed v0 keys are hard rejects.
  let clarify: AutoJobConfig["clarify"] | null = { mode: "self-answer", maxRounds: 2 };
  const clarifyRaw = root.clarify;
  if (clarifyRaw !== undefined) {
    const c = asObject(clarifyRaw);
    if (!c) {
      errors.push('"clarify" must be an object');
      clarify = null;
    } else {
      if (c.mode === undefined) {
        warnings.push('"clarify.mode" not set — using default "self-answer"');
      } else if (c.mode !== "self-answer" && c.mode !== "orchestrated") {
        applyEnumError(errors, "clarify.mode", '"self-answer" | "orchestrated"');
        clarify = null;
      }
      if (c.fallback !== undefined) {
        applyEnumError(errors, "clarify.fallback", "removed in the v1 schema (degradation to orchestrated is plugin-managed)");
        clarify = null;
      }
      if (c.answerStrategy !== undefined) {
        applyEnumError(errors, "clarify.answerStrategy", "removed in the v1 schema (self-answer always follows the recommended plan)");
        clarify = null;
      }
      if (clarify !== null) {
        const mode = (c.mode ?? "self-answer") as "self-answer" | "orchestrated";
        let maxRounds = 2;
        if (c.maxRounds !== undefined) {
          const num = asNonNegativeNumber(c.maxRounds);
          if (num === null || num < 1) {
            errors.push(`"clarify.maxRounds" must be a number >= 1: ${String(c.maxRounds)}`);
            clarify = null;
          } else {
            maxRounds = num;
          }
        } else {
          warnings.push('"clarify.maxRounds" not set — using default 2');
        }
        if (clarify !== null) {
          clarify = { mode, maxRounds };
        }
      }
    }
  } else {
    warnings.push('"clarify" not set — using default { mode: "self-answer", maxRounds: 2 }');
  }

  // confirm — per-stage mode override (defaults auto).
  let confirm: AutoJobConfig["confirm"] | null = { plan: "auto", review: "auto" };
  const confirmRaw = asObject(root.confirm);
  if (confirmRaw) {
    for (const key of ["plan", "review"] as const) {
      const value = confirmRaw[key];
      if (value === undefined) continue;
      if (isConfirmMode(value)) {
        if (confirm) confirm[key] = value;
      } else {
        applyEnumError(errors, `confirm.${key}`, '"auto" | "manual" | "smart"');
        confirm = null;
        break;
      }
      if (value !== "auto") {
        warnings.push(`"confirm.${key}" = ${String(value)} (non-auto values are only effective in human-machine mode)`);
      }
    }
  }

  // designReview — v1 mode accepts ONLY "auto".
  let designReview: AutoJobConfig["designReview"] | null = { mode: "auto", maxRounds: 3, failAction: "auto-revise" };
  const designReviewRaw = root.designReview;
  if (designReviewRaw !== undefined) {
    const d = asObject(designReviewRaw);
    if (!d) {
      errors.push('"designReview" must be an object');
      designReview = null;
    } else {
      if (d.mode !== undefined && d.mode !== "auto") {
        applyEnumError(errors, "designReview.mode", '"auto"');
        designReview = null;
      }
      let maxRounds = 3;
      if (d.maxRounds !== undefined) {
        const num = asNonNegativeNumber(d.maxRounds);
        if (num === null || num < 1) {
          errors.push(`"designReview.maxRounds" must be a number >= 1: ${String(d.maxRounds)}`);
          designReview = null;
        } else {
          maxRounds = num;
        }
      } else if (d.mode !== undefined || d.failAction !== undefined) {
        warnings.push('"designReview.maxRounds" not set — using default 3');
      }
      let failAction: "auto-revise" | "stop" = "auto-revise";
      if (d.failAction !== undefined) {
        if (d.failAction === "auto-revise" || d.failAction === "stop") {
          failAction = d.failAction;
        } else {
          applyEnumError(errors, "designReview.failAction", '"auto-revise" | "stop"');
          designReview = null;
        }
      }
      if (errors.length === 0 && designReview !== null) {
        designReview = { mode: "auto", maxRounds, failAction };
      }
    }
  } else {
    warnings.push('"designReview" not set — using default { mode: "auto", maxRounds: 3, failAction: "auto-revise" }');
  }

  // reviewFix budgets (defaults conservative; always warned when absent).
  let reviewFix: AutoJobConfig["reviewFix"] | null = { maxRounds: 6, maxLoopsPerStage: 6 };
  const reviewFixRaw = asObject(root.reviewFix);
  if (reviewFixRaw) {
    for (const key of ["maxRounds", "maxLoopsPerStage"] as const) {
      const value = reviewFixRaw[key];
      if (value === undefined) continue;
      const num = asNonNegativeNumber(value);
      if (num === null || num < 1) {
        errors.push(`"reviewFix.${key}" must be a number >= 1: ${String(value)}`);
        reviewFix = null;
        break;
      }
      if (reviewFix) reviewFix[key] = num;
    }
  } else {
    warnings.push('"reviewFix" not set — using default { maxRounds: 6, maxLoopsPerStage: 6 }');
  }

  const writePolicy = parseWritePolicy(root.writePolicy, errors);
  const decisionPolicy = parseDecisionPolicy(root.decisionPolicy, errors);
  const stopConditions = parseStopConditions(root.stopConditions, errors, warnings);

  // chain
  const chain: AutoJobConfig["chain"] = { newSession: true, onSessionFail: "same-session" };
  const chainRaw = asObject(root.chain);
  if (chainRaw) {
    if (chainRaw.newSession !== undefined) {
      if (typeof chainRaw.newSession !== "boolean") {
        errors.push('"chain.newSession" must be a boolean');
      } else {
        chain.newSession = chainRaw.newSession;
      }
    }
    if (chainRaw.onSessionFail !== undefined) {
      if (chainRaw.onSessionFail === "same-session" || chainRaw.onSessionFail === "stop") {
        chain.onSessionFail = chainRaw.onSessionFail;
      } else {
        applyEnumError(errors, "chain.onSessionFail", '"same-session" | "stop"');
      }
    }
  }

  // audit
  const audit: AutoJobConfig["audit"] = { recordAutoDecisions: true };
  const auditRaw = asObject(root.audit);
  if (auditRaw && auditRaw.recordAutoDecisions !== undefined) {
    if (typeof auditRaw.recordAutoDecisions !== "boolean") {
      errors.push('"audit.recordAutoDecisions" must be a boolean');
    } else {
      audit.recordAutoDecisions = auditRaw.recordAutoDecisions;
    }
  }

  // Unknown top-level keys → warning (known-but-unsupported keys error above).
  const KNOWN_KEYS = new Set([
    "version", "enabled", "docs", "clarify", "confirm", "designReview", "reviewFix",
    "writePolicy", "decisionPolicy", "stopConditions", "chain", "audit", "_comment",
  ]);
  for (const key of Object.keys(root)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`Unknown job key "${key}" ignored`);
  }

  if (
    errors.length > 0 ||
    docs === null ||
    clarify === null ||
    confirm === null ||
    designReview === null ||
    reviewFix === null ||
    writePolicy === null ||
    decisionPolicy === null ||
    stopConditions === null ||
    chain === null ||
    audit === null
  ) {
    return { ok: false, errors: errors.length > 0 ? errors : [`Job file ${sourcePath} failed validation`] };
  }

  const job: AutoJobConfig = {
    version: 1,
    enabled,
    docs: docs!,
    clarify: clarify!,
    confirm: confirm!,
    designReview: designReview!,
    reviewFix: reviewFix!,
    writePolicy: writePolicy!,
    decisionPolicy: decisionPolicy!,
    stopConditions: stopConditions!,
    chain: chain!,
    audit: audit!,
  };
  return { ok: true, job, hash: hashJobBytes(yamlText), warnings };
}

/**
 * sha256 over the raw bytes — drift detection against the sidecar.
 * Accepts a Buffer (raw file bytes) or raw YAML text.
 */
export function hashJobBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
