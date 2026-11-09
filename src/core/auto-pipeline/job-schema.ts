/**
 * @module auto-pipeline/job-schema
 * 219 Phase 1 + 220 Phase 2 (D6/D7): task-level YAML job definition —
 * parsing / validation / default filling (fail-fast).
 *
 * Facts:
 * - The job file is USER-MAINTAINED. The plugin NEVER writes back to it; all
 *   progress lives in the sidecar (`job-state.ts`).
 * - Only IMPLEMENTED values are accepted. Every removed key is a HARD ERROR
 *   (never a silent degradation), and keys removed by 220 (`clarify.mode`,
 *   `clarify.fallback`, `clarify.answerStrategy`, `designReview.failAction`,
 *   `decisionPolicy`, `audit.recordAutoDecisions`) are rejected through the
 *   per-section allowlists below — a job written for 219 must fail loudly.
 * - `freezePolicy` is JOB-PRIVATE: consumed ONLY by freeze-autopilot and never
 *   written into `json.decisionPolicy` (that block belongs to the 210 provider
 *   chain, whose byReason values are `DecisionPolicyRule` objects).
 * - `verify.maxAttempts` / `writePolicy.gitModify` are "inherit-not-overlay"
 *   keys: they are default-filled for downstream consumers but only overlaid
 *   onto the JSON config when the job file configured them (`configured`).
 * - Defaults are filled at the schema layer so downstream code never sees
 *   `undefined` inside `stopConditions` (an `undefined < 1 === false` would
 *   silently disable a budget).
 */

import { createHash } from "node:crypto";
import { parse as yamlParse } from "yaml";
import type { PipelineStage, ConfirmMode } from "../../types";
import { RESUMABLE_STAGES } from "../../constants";

/**
 * D-13: the ONLY staged keys carrying a confirm gate. The order is the
 * canonical spelling used in guides and audit output.
 */
export const CONFIRM_STAGE_KEYS = ["plan", "review", "design-review"] as const;

export type ConfirmStageKey = (typeof CONFIRM_STAGE_KEYS)[number];

/** Default confirm matrix (D-13): plan/review unattended, design-review smart. */
export const DEFAULT_CONFIRM_MODES: Record<ConfirmStageKey, ConfirmMode> = {
  plan: "auto",
  review: "auto",
  "design-review": "smart",
};

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
export type FreezeAction = "resume" | "abort" | "stop-and-report" | "advance";

/** C-2: autonomy tier. `manual` is not a job value (no job = human track). */
export type AutoJobTier = "rule" | "assisted";

/** What a clarify round budget exhaustion degrades to. */
export type ClarifyOnExhausted = "stop" | "self-confirm";

/** What a design-review FAIL is routed to (renamed from `failAction`). */
export type DesignReviewOnFail = "auto-revise" | "stop";

/** 229 (F5/B16): what loop-budget/NO-PROGRESS exhaustion degrades to.
 * `undefined` KEPT — an absent value means "loop default" (`advance` on the
 * consumption side) so a legacy job's behaviour is never silently changed. */
export type DesignReviewOnExhausted = "advance" | "await-human" | "stop";

/** 229 (B3): the exit target of an `advance` exhaustion release. */
export type ExhaustedAdvanceTarget = "nextStage" | "awaiting_human";

/** Whether an auto job may let the agent run git state-changing commands. */
export type GitModifyPolicy = "allow" | "block";

/** v1 job document shape. Defaults are filled by `parseAutoJob` before return. */
export interface AutoJobConfig {
  version: 1;
  enabled: boolean;
  /** 220 C-2: `assisted` forces design-review + full comparison; `rule` does not. */
  tier: AutoJobTier;
  docs: { list: AutoJobDoc[]; skipCompleted: boolean; onFailure: "stop" | "continue" };
  /** 220 D6: ONE strategy in v1 (self-answer); the removed `mode` is an error. */
  clarify: { strategy: "self-answer"; maxRounds: number; onExhausted: ClarifyOnExhausted };
  /** D-13: the ONLY decision source. Keys = stages carrying a confirm gate. */
  confirm: Record<ConfirmStageKey, ConfirmMode>;
  /**
   * D-9/D-13: `enabled` decides whether the overlay rewrites
   * `stages.plan.nextStage`; `mode` is a deprecated read-only mirror of
   * `confirm["design-review"]`.
   */
  designReview: { enabled?: boolean; mode?: ConfirmMode; maxRounds: number; onFail: DesignReviewOnFail };
  reviewFix: { maxRounds: number; maxLoopsPerStage: number };
  /**
   * 229 (F5/B16): loop-exhaustion exits. KEPT `undefined` when not configured
   * (consumers resolve `?? "advance"`); only these two loop keys exist in v1.
   */
  onExhausted?: {
    designReview?: DesignReviewOnExhausted;
    reviewFix?: DesignReviewOnExhausted;
  };
  /** 229 (B3): per-loop advance target; default `nextStage` (the loop exit). */
  onExhaustedTarget?: {
    designReview?: ExhaustedAdvanceTarget;
    reviewFix?: ExhaustedAdvanceTarget;
  };
  /** Q15: verify attempts allowed before the verify-failure hard stop. */
  verify: { maxAttempts: number };
  writePolicy: {
    whitelistMiss: "ask" | "deny" | "allow";
    protectedPath: "deny" | "ask";
    destructiveCommand: "deny" | "ask";
    allowGlobs: string[];
    /** 220 D7: `block` is the conservative default for an unattended job. */
    gitModify: GitModifyPolicy;
  };
  /** 220 D7: renamed from `decisionPolicy`; the only non-overlaid block. */
  freezePolicy: {
    onFreeze: FreezeAction;
    maxAutoResumes: number;
    byReason: Record<string, FreezeAction>;
  };
  audit: { autoDecisions: boolean };
  /** 220 D5: job-wide start stage; `auto` derives it from the evidence on disk. */
  defaults: { startStage: PipelineStage | "auto" };
  stopConditions: {
    maxTotalFreezes: number;
    maxTotalLoops: number;
    wallClockMs: number;
    stopOnBlockedReasons: string[];
    /** 6.3(3): loops granted to the CURRENT doc after the loop brake trips
     *  (0 = disabled, hard cap 3, DEFAULT 1). */
    finalLoopGrace: number;
  };
  chain: { newSession: boolean; onSessionFail: "same-session" | "stop" };
  /**
   * Provenance of the inherit-not-overlay keys. `false` ⇒ the value below is
   * the schema default and MUST NOT be written into the JSON config.
   */
  configured: { verifyMaxAttempts: boolean; gitModify: boolean };
}

export type AutoJobParseResult =
  | { ok: true; job: AutoJobConfig; hash: string; warnings: string[] }
  | { ok: false; errors: string[] };

const NOT_SUPPORTED_SUFFIX = "— not supported in this version";

/** Human-readable default matrix used in warnings (D-13). */
const CONFIRM_DEFAULTS_LABEL = '{ plan: "auto", review: "auto", "design-review": "smart" }';

/** Error text used for keys removed by 220 (never silently ignored). */
const REMOVED_KEY_SUFFIX = "— removed in this version";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// ─── Field validators (each returns true = keep, false = error) ──────────────

function isConfirmMode(value: unknown): value is ConfirmMode {
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
 * Reject keys this schema does not implement.
 *
 * The allowlist (not a blocklist) is what makes a 219-era key an error instead
 * of a silent no-op: any key outside `allowed` names itself in the message.
 */
function rejectUnknownKeys(
  section: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: string[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(section)) {
    if (allow.has(key)) continue;
    errors.push(`"${prefix}${key}" is not a supported job key ${REMOVED_KEY_SUFFIX}`);
  }
}

/**
 * Validate + default-fill `docs`. Returns null on hard error (list missing/empty
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
): {
  policy: {
    whitelistMiss: "ask" | "deny" | "allow";
    protectedPath: "deny" | "ask";
    destructiveCommand: "deny" | "ask";
    allowGlobs: string[];
    gitModify: GitModifyPolicy;
  };
  gitModifyConfigured: boolean;
} | null {
  const write = asObject(raw) ?? {};
  rejectUnknownKeys(
    write,
    ["whitelistMiss", "protectedPath", "destructiveCommand", "allowGlobs", "gitModify"],
    "writePolicy.",
    errors,
  );
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
  let gitModify: GitModifyPolicy = "block";
  const gitModifyConfigured = write.gitModify !== undefined;
  if (gitModifyConfigured) {
    if (write.gitModify === "allow" || write.gitModify === "block") {
      gitModify = write.gitModify;
    } else {
      applyEnumError(errors, "writePolicy.gitModify", '"allow" | "block"');
      return null;
    }
  }
  return {
    policy: { whitelistMiss, protectedPath, destructiveCommand, allowGlobs, gitModify },
    gitModifyConfigured,
  };
}

function parseFreezePolicy(
  raw: unknown,
  errors: string[],
): AutoJobConfig["freezePolicy"] | null {
  const policy = asObject(raw) ?? {};
  rejectUnknownKeys(policy, ["onFreeze", "maxAutoResumes", "byReason"], "freezePolicy.", errors);
  let onFreeze: FreezeAction = "resume";
  if (policy.onFreeze !== undefined) {
    if (policy.onFreeze === "resume" || policy.onFreeze === "abort" || policy.onFreeze === "stop-and-report") {
      onFreeze = policy.onFreeze;
    } else {
      applyEnumError(errors, "freezePolicy.onFreeze", '"resume" | "abort" | "stop-and-report"');
      return null;
    }
  }
  let maxAutoResumes = 2;
  if (policy.maxAutoResumes !== undefined) {
    const value = asNonNegativeNumber(policy.maxAutoResumes);
    if (value === null) {
      errors.push('"freezePolicy.maxAutoResumes" must be a number >= 0');
      return null;
    }
    maxAutoResumes = value;
  }
  const byReason: Record<string, FreezeAction> = {};
  if (policy.byReason !== undefined) {
    const table = asObject(policy.byReason);
    if (!table) {
      errors.push('"freezePolicy.byReason" must be an object');
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
          `freezePolicy.byReason.${reason}`,
          '"resume" | "abort" | "stop-and-report"',
          `(got ${JSON.stringify(value)})`,
        );
        return null;
      }
    }
  }
  return { onFreeze, maxAutoResumes, byReason };
}

/** Allowed keys of the `stopConditions` block (removed keys are rejected). */
const STOP_CONDITION_KEYS = [
  "maxTotalFreezes",
  "maxTotalLoops",
  "wallClockMs",
  "stopOnBlockedReasons",
  "finalLoopGrace",
] as const;

function parseStopConditions(
  raw: unknown,
  errors: string[],
  warnings: string[],
): AutoJobConfig["stopConditions"] | null {
  const stop = asObject(raw) ?? {};
  rejectUnknownKeys(stop, STOP_CONDITION_KEYS, "stopConditions.", errors);

  function numeric(
    key: (typeof STOP_CONDITION_KEYS)[number],
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

  const maxTotalFreezes = numeric("maxTotalFreezes", 0, 0);
  const maxTotalLoops = numeric("maxTotalLoops", 20, 1);
  const wallClockMs = numeric("wallClockMs", 0, 0);
  if (Number.isNaN(maxTotalFreezes) || Number.isNaN(maxTotalLoops) || Number.isNaN(wallClockMs)) {
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

  return { maxTotalFreezes, maxTotalLoops, wallClockMs, stopOnBlockedReasons, finalLoopGrace };
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

  // tier — C-2: `rule` | `assisted` (manual is not a job value).
  let tier: AutoJobTier = "assisted";
  if (root.tier !== undefined) {
    if (root.tier === "rule" || root.tier === "assisted") {
      tier = root.tier;
    } else {
      applyEnumError(errors, "tier", '"rule" | "assisted"');
    }
  } else {
    warnings.push('"tier" not set — using default "assisted"');
  }

  // clarify — one strategy only; the 219-era keys are hard rejects.
  let clarify: AutoJobConfig["clarify"] | null = { strategy: "self-answer", maxRounds: 5, onExhausted: "stop" };
  const clarifyRaw = root.clarify;
  if (clarifyRaw !== undefined) {
    const c = asObject(clarifyRaw);
    if (!c) {
      errors.push('"clarify" must be an object');
      clarify = null;
    } else {
      rejectUnknownKeys(c, ["strategy", "maxRounds", "onExhausted"], "clarify.", errors);
      if (c.strategy !== undefined && c.strategy !== "self-answer") {
        applyEnumError(errors, "clarify.strategy", '"self-answer"');
        clarify = null;
      }
      let maxRounds = 5;
      if (c.maxRounds !== undefined) {
        const num = asNonNegativeNumber(c.maxRounds);
        if (num === null || num < 1) {
          errors.push(`"clarify.maxRounds" must be a number >= 1: ${String(c.maxRounds)}`);
          clarify = null;
        } else {
          maxRounds = num;
        }
      } else {
        warnings.push('"clarify.maxRounds" not set — using default 5');
      }
      let onExhausted: ClarifyOnExhausted = "stop";
      if (c.onExhausted !== undefined) {
        if (c.onExhausted === "stop" || c.onExhausted === "self-confirm") {
          onExhausted = c.onExhausted;
        } else {
          applyEnumError(errors, "clarify.onExhausted", '"stop" | "self-confirm"');
          clarify = null;
        }
      }
      if (clarify !== null) {
        clarify = { strategy: "self-answer", maxRounds, onExhausted };
      }
    }
  } else {
    warnings.push('"clarify" not set — using default { strategy: "self-answer", maxRounds: 5, onExhausted: "stop" }');
  }

  // confirm — D-13: ONE decision source for every staged confirm gate.
  // Defaults are FILLED for consumers; `explicitConfirm` records only keys the
  // job file actually spelled out — the alias conflict rule below judges
  // presence, never the default fill.
  let confirm: AutoJobConfig["confirm"] | null = { ...DEFAULT_CONFIRM_MODES };
  const explicitConfirm = new Set<ConfirmStageKey>();
  const confirmRaw = asObject(root.confirm);
  if (confirmRaw) {
    // Unknown key = error (not warn) — D-13 hard rule 1.
    rejectUnknownKeys(confirmRaw, [...CONFIRM_STAGE_KEYS], "confirm.", errors);
    for (const key of CONFIRM_STAGE_KEYS) {
      const value = confirmRaw[key];
      if (value === undefined) continue;
      if (!isConfirmMode(value)) {
        applyEnumError(errors, `confirm.${key}`, '"auto" | "manual" | "smart"');
        confirm = null;
        break;
      }
      if (key !== "design-review" && value === "manual") {
        // A TUI gate cannot be answered in an unattended run — the old
        // "non-auto is ignored" warning described a silent deadlock.
        errors.push(`"confirm.${key}" = "manual" is not satisfiable in an auto job — use "auto" | "smart"`);
        confirm = null;
        break;
      }
      if (confirm) confirm[key] = value;
      explicitConfirm.add(key);
    }
  } else if (root.confirm === undefined) {
    warnings.push(`"confirm" not set — using default ${CONFIRM_DEFAULTS_LABEL}`);
  }

  // designReview — D-9/D-13: `enabled` controls the topology rewrite, `mode` is
  // the deprecated alias of `confirm["design-review"]` (resolved below).
  let designReview: AutoJobConfig["designReview"] | null = { maxRounds: 3, onFail: "auto-revise" };
  let designReviewMode: ConfirmMode | undefined;
  let designReviewModeExplicit = false;
  let designReviewEnabled: boolean | undefined;
  const designReviewRaw = root.designReview;
  if (designReviewRaw !== undefined) {
    const d = asObject(designReviewRaw);
    if (!d) {
      errors.push('"designReview" must be an object');
      designReview = null;
    } else {
      rejectUnknownKeys(d, ["enabled", "mode", "maxRounds", "onFail"], "designReview.", errors);
      if (d.enabled !== undefined) {
        if (typeof d.enabled === "boolean") {
          designReviewEnabled = d.enabled;
        } else {
          errors.push('"designReview.enabled" must be a boolean');
          designReview = null;
        }
      }
      if (d.mode !== undefined) {
        if (isConfirmMode(d.mode)) {
          designReviewMode = d.mode;
          designReviewModeExplicit = true;
        } else {
          applyEnumError(errors, "designReview.mode", '"auto" | "manual" | "smart"');
          designReview = null;
        }
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
      } else if (d.mode !== undefined || d.onFail !== undefined) {
        warnings.push('"designReview.maxRounds" not set — using default 3');
      }
      let onFail: DesignReviewOnFail = "auto-revise";
      if (d.onFail !== undefined) {
        if (d.onFail === "auto-revise" || d.onFail === "stop") {
          onFail = d.onFail;
        } else {
          applyEnumError(errors, "designReview.onFail", '"auto-revise" | "stop"');
          designReview = null;
        }
      }
      if (designReview !== null) {
        designReview = {
          ...(designReviewEnabled !== undefined ? { enabled: designReviewEnabled } : {}),
          maxRounds,
          onFail,
        };
      }
    }
  } else {
    warnings.push(
      '"designReview" not set — using default { maxRounds: 3, onFail: "auto-revise" } (topology untouched)',
    );
  }

  // D-13 hard rule 2 — the alias is judged by PRESENCE, never by the default
  // fill: an explicit `mode` only wins when `confirm.design-review` is absent.
  if (designReviewModeExplicit && designReviewMode !== undefined) {
    if (explicitConfirm.has("design-review")) {
      if (confirm !== null && confirm["design-review"] !== designReviewMode) {
        errors.push('"designReview.mode" conflicts with "confirm.design-review"');
      } else {
        warnings.push('"designReview.mode" is deprecated — use "confirm.design-review" only');
      }
    } else if (confirm !== null) {
      confirm["design-review"] = designReviewMode;
      warnings.push(
        `"designReview.mode" is deprecated — use "confirm.design-review" (value "${designReviewMode}" mirrored)`,
      );
    }
  }
  if (designReview !== null) {
    // The mirror always reflects the FINAL decision source.
    designReview = {
      ...designReview,
      mode: confirm !== null ? confirm["design-review"] : designReviewMode ?? DEFAULT_CONFIRM_MODES["design-review"],
    };
  }

  // reviewFix budgets (defaults conservative; always warned when absent).
  let reviewFix: AutoJobConfig["reviewFix"] | null = { maxRounds: 6, maxLoopsPerStage: 6 };
  const reviewFixRaw = asObject(root.reviewFix);
  if (reviewFixRaw) {
    rejectUnknownKeys(reviewFixRaw, ["maxRounds", "maxLoopsPerStage"], "reviewFix.", errors);
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

  // 229 (F5/B16) top-level onExhausted / onExhaustedTarget — loop policies
  // KEPT `undefined` when not configured (a legacy job behaves exactly as
  // before; the consumption resolves the loop default `advance` itself).
  let onExhausted: AutoJobConfig["onExhausted"] | undefined;
  const onExhaustedRaw = asObject(root.onExhausted);
  if (onExhaustedRaw) {
    rejectUnknownKeys(onExhaustedRaw, ["designReview", "reviewFix"], "onExhausted.", errors);
    const parsed: { designReview?: DesignReviewOnExhausted; reviewFix?: DesignReviewOnExhausted } = {};
    for (const key of ["designReview", "reviewFix"] as const) {
      const value = onExhaustedRaw[key];
      if (value === undefined) continue;
      if (value === "advance" || value === "await-human" || value === "stop") {
        parsed[key] = value;
      } else {
        applyEnumError(errors, `onExhausted.${key}`, '"advance" | "await-human" | "stop"');
      }
    }
    if (Object.keys(parsed).length > 0) onExhausted = parsed;
  } else {
    warnings.push('"onExhausted" not set — loop default advance applies (B16; legacy runs untouched)');
  }

    let onExhaustedTarget: AutoJobConfig["onExhaustedTarget"] | undefined;
  const onExhaustedTargetRaw = asObject(root.onExhaustedTarget);
  if (onExhaustedTargetRaw) {
    rejectUnknownKeys(onExhaustedTargetRaw, ["designReview", "reviewFix"], "onExhaustedTarget.", errors);
    const parsed: { designReview?: ExhaustedAdvanceTarget; reviewFix?: ExhaustedAdvanceTarget } = {};
    for (const key of ["designReview", "reviewFix"] as const) {
      const value = onExhaustedTargetRaw[key];
      if (value === undefined) continue;
      if (value === "nextStage" || value === "awaiting_human") {
        if (onExhausted !== undefined && onExhausted[key] === "advance") {
          warnings.push(`"onExhaustedTarget.${key}=awaiting_human" degrades advance to await-human`);
        }
        parsed[key] = value;
      } else {
        applyEnumError(errors, `onExhaustedTarget.${key}`, '"nextStage" | "awaiting_human"');
      }
    }
    if (Object.keys(parsed).length > 0) onExhaustedTarget = parsed;
  }

  // verify — inherit-not-overlay: filled for consumers, overlaid only if set.
  let verify: AutoJobConfig["verify"] = { maxAttempts: 3 };
  let verifyMaxAttemptsConfigured = false;
  const verifyRaw = root.verify;
  if (verifyRaw !== undefined) {
    const v = asObject(verifyRaw);
    if (!v) {
      errors.push('"verify" must be an object');
    } else {
      rejectUnknownKeys(v, ["maxAttempts"], "verify.", errors);
      if (v.maxAttempts !== undefined) {
        const num = asNonNegativeNumber(v.maxAttempts);
        if (num === null || num < 1) {
          errors.push(`"verify.maxAttempts" must be a number >= 1: ${String(v.maxAttempts)}`);
          verify = { maxAttempts: 3 };
        } else {
          verify = { maxAttempts: num };
          verifyMaxAttemptsConfigured = true;
        }
      }
    }
  }

  // defaults — D5: job-wide start stage (`auto` = derive from evidence).
  let defaults: AutoJobConfig["defaults"] = { startStage: "clarify" };
  const defaultsRaw = root.defaults;
  if (defaultsRaw !== undefined) {
    const d = asObject(defaultsRaw);
    if (!d) {
      errors.push('"defaults" must be an object');
    } else {
      rejectUnknownKeys(d, ["startStage"], "defaults.", errors);
      if (d.startStage !== undefined) {
        if (d.startStage === "auto" || RESUMABLE_STAGES.includes(d.startStage as PipelineStage)) {
          defaults = { startStage: d.startStage as PipelineStage | "auto" };
        } else {
          applyEnumError(errors, "defaults.startStage", `${RESUMABLE_STAGES.join(" | ")} | "auto"`);
        }
      }
    }
  }

  const writePolicyResult = parseWritePolicy(root.writePolicy, errors);
  const freezePolicy = parseFreezePolicy(root.freezePolicy, errors);
  const stopConditions = parseStopConditions(root.stopConditions, errors, warnings);
  // `decisionPolicy` was renamed: name the removed key explicitly (it is a
  // removed top-level block, not an unknown key of another section).
  if (root.decisionPolicy !== undefined) {
    errors.push(`"decisionPolicy" is a removed job block ${REMOVED_KEY_SUFFIX} (use "freezePolicy")`);
  }

  // chain
  const chain: AutoJobConfig["chain"] = { newSession: true, onSessionFail: "same-session" };
  const chainRaw = asObject(root.chain);
  if (chainRaw) {
    rejectUnknownKeys(chainRaw, ["newSession", "onSessionFail"], "chain.", errors);
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

  // audit — `autoDecisions` (renamed from `recordAutoDecisions`).
  const audit: AutoJobConfig["audit"] = { autoDecisions: true };
  const auditRaw = asObject(root.audit);
  if (auditRaw) {
    rejectUnknownKeys(auditRaw, ["autoDecisions"], "audit.", errors);
    if (auditRaw.autoDecisions !== undefined) {
      if (typeof auditRaw.autoDecisions !== "boolean") {
        errors.push('"audit.autoDecisions" must be a boolean');
      } else {
        audit.autoDecisions = auditRaw.autoDecisions;
      }
    }
  }

  // Unknown top-level keys → warning (known-but-removed keys error above).
  const KNOWN_KEYS = new Set([
    "version", "enabled", "tier", "docs", "clarify", "confirm", "designReview", "reviewFix",
    "verify", "writePolicy", "freezePolicy", "stopConditions", "defaults", "chain", "audit", "_comment",
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
    writePolicyResult === null ||
    freezePolicy === null ||
    stopConditions === null
  ) {
    return { ok: false, errors: errors.length > 0 ? errors : [`Job file ${sourcePath} failed validation`] };
  }

  const job: AutoJobConfig = {
    version: 1,
    enabled,
    tier,
    docs: docs!,
    clarify: clarify!,
    confirm: confirm!,
    designReview: designReview!,
    reviewFix: reviewFix!,
    onExhausted,
    onExhaustedTarget,
    verify: verify!,
    writePolicy: writePolicyResult!.policy,
    freezePolicy: freezePolicy!,
    audit,
    defaults,
    stopConditions: stopConditions!,
    chain,
    configured: {
      verifyMaxAttempts: verifyMaxAttemptsConfigured,
      gitModify: writePolicyResult!.gitModifyConfigured,
    },
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
