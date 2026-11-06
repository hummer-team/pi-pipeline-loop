/**
 * @module commit-contract
 * 225 Phase 0: commit-contract derivation + git-modify capability elevation.
 *
 * A stage has a "commit contract" when its deployed verify spec carries a
 * `requiredGit` rule (Q8-A: presence is the signal — the stage REQUIRES a
 * commit produced by git, even when only `branch` is pinned). Such stages
 * must actually be able to run `git add/commit`, so the plugin elevates the
 * effective stage-level `protect.gitModify` to `allow` in memory (never
 * touches project files), audited once per config+stage.
 *
 * Every elevation/conflict is an auditable fact:
 * - `git_policy_contract_elevated` — stage-level allow written (audit fields:
 *   stage | verifySpec | from | to | globalValue | matrixDefault)
 * - `commit_contract_capability_disabled` — contract stage explicitly opted
 *   out via `requireCommitContract: false`; caller must freeze (entry gate).
 *
 * Both results are cached per (PipelineConfig object, stage) — tool-guard and
 * the prompt layer call this per git write / per prompt, so the verify file is
 * read ONCE per config object, never on every command.
 */

import path from "node:path";
import type { PipelineConfig, PipelineStage } from "../types";
import { resolveVerifyFilePath } from "../utils/contract-loader";
import { GIT_MODIFY_DEFAULT_MATRIX, resolveGitModifyPolicy } from "../utils/protect";
import { safeWriteAuditLog } from "../utils/auditLog";
import type { VerifyRules } from "./verify-frontmatter";
import { parseVerifyFile } from "./auto-verifier";

/** A stage's resolved commit contract. */
export interface CommitContract {
  stage: PipelineStage;
  /** True when the deployed verify spec requires a git commit (`requiredGit` present). */
  requiresCommit: boolean;
  /** Deployed verify spec path (relative to projectRoot). */
  verifySpecPath: string;
  /** Resolution of the explicit opt-out switch (stage-level > global-level, default true). */
  enabled: boolean;
}

/** Required-git presence = commit requirement (Q8-A: not limited to cleanWorkingTree). */
export function hasCommitRequirement(rules: VerifyRules | null): boolean {
  // Legacy flat schema: requiredGit at the rule level.
  if (rules?.requiredGit !== undefined) return true;
  // Groups schema (deployed templates): requiredGit lives in groups[].rules[].
  return !!rules?.groups?.some((g) =>
    g.rules?.some((node) => node.type === "requiredGit"),
  );
}

/**
 * Per-config-object contract cache. Key identity is the config OBJECT:
 * the plugin creates one PipelineConfig per session, so the WeakMap releases
 * everything with it. Values are promises so concurrent callers share one read.
 */
const contracts = new WeakMap<PipelineConfig, Map<PipelineStage, Promise<CommitContract>>>();

/**
 * Audit dedupe key set: the FIRST elevation / disabled-vs-audit per
 * (config, stage) is written; later calls stay silent even if the in-memory
 * stage key is wiped by another writer.
 */
const auditEmitted = new WeakMap<PipelineConfig, Set<string>>();

function auditSlotFor(config: PipelineConfig, key: string): boolean {
  let slot = auditEmitted.get(config);
  if (!slot) {
    slot = new Set();
    auditEmitted.set(config, slot);
  }
  if (slot.has(key)) return false;
  slot.add(key);
  return true;
}

/** Resolves the requireCommitContract switch: stage-level ?? global-level ?? true. */
function resolveContractEnabled(config: PipelineConfig, stage: PipelineStage): boolean {
  return (
    config.stages[stage]?.verify?.requireCommitContract ??
    config.verify?.requireCommitContract ??
    true
  );
}

/**
 * Resolves (and caches) the commit contract for one stage.
 * Verify file missing / unparsable ⇒ `requiresCommit: false` (no throw, no judgement).
 */
export async function resolveStageCommitContract(
  config: PipelineConfig,
  stage: PipelineStage,
): Promise<CommitContract> {
  let byStage = contracts.get(config);
  if (!byStage) {
    byStage = new Map<PipelineStage, Promise<CommitContract>>();
    contracts.set(config, byStage);
  }
  const cached = byStage.get(stage);
  if (cached) return cached;

  const promise = (async (): Promise<CommitContract> => {
    const absoluteVerifyPath = resolveVerifyFilePath(config, stage);
    const verifySpecPath = path.relative(config.projectRoot, absoluteVerifyPath);
    const enabled = resolveContractEnabled(config, stage);
    try {
      const parsed = await parseVerifyFile(absoluteVerifyPath);
      return {
        stage,
        requiresCommit: hasCommitRequirement(parsed.rules),
        verifySpecPath,
        enabled,
      };
    } catch (err) {
      // Fail-open: an unreadable spec must never throw into the prompt path.
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[pi-pipeline] commit-contract spec unreadable at stage="${stage}", path="${verifySpecPath}": ${errMsg}`,
      );
      void safeWriteAuditLog("commit_contract_spec_error", { stage, verifySpec: verifySpecPath, error: errMsg }, "error");
      return { stage, requiresCommit: false, verifySpecPath, enabled };
    }
  })();
  byStage.set(stage, promise);
  return promise;
}

export interface CommitContractElevation {
  contract: CommitContract;
  /** True when this call (or a previous one) wrote the stage-level allow key. */
  elevated: boolean;
  /** True when the contract stage explicitly opted out — caller must freeze. */
  disabled: boolean;
}

/**
 * Idempotent elevation: contract stages get an in-memory stage-level
 * `protect.gitModify: "allow"`. Three explicit branches (review/plan etc. are
 * NEVER elevated; an opt-out returns `disabled` instead of exiting; only an
 * effective non-allow value is overwritten), audit-once semantics per branch.
 */
export async function ensureCommitContractElevation(
  config: PipelineConfig,
  stage: PipelineStage,
): Promise<CommitContractElevation> {
  // NOTE: no pipelineId routing here — hook callers (prompt-injector /
  // tool-guard) already set the audit pipeline context on entry.

  const contract = await resolveStageCommitContract(config, stage);
  // Branch 1: non-contract stage (review / plan / clarify ...) → untouched.
  if (!contract.requiresCommit) {
    return { contract, elevated: false, disabled: false };
  }
  // Branch 2: contract stage explicitly opted out → no elevation; caller freezes.
  if (!contract.enabled) {
    if (auditSlotFor(config, `disabled:${stage}`)) {
      await safeWriteAuditLog(
        "commit_contract_capability_disabled",
        { stage, verifySpec: contract.verifySpecPath },
        "error",
      );
    }
    return { contract, elevated: false, disabled: true };
  }
  // Branch 3: contract stage, not opted out → write the stage key only when
  // the effective value is not already allow (idempotent).
  const before = resolveGitModifyPolicy(config, null, stage);
  if (before === "allow") {
    return { contract, elevated: false, disabled: false };
  }
  config.stages[stage].protect = {
    ...(config.stages[stage].protect ?? {}),
    gitModify: "allow",
  };
  if (auditSlotFor(config, `elevated:${stage}`)) {
    await safeWriteAuditLog("git_policy_contract_elevated", {
      stage,
      verifySpec: contract.verifySpecPath,
      from: before,
      to: "allow",
      globalValue: config.protect?.gitModify ?? "unset",
      matrixDefault: GIT_MODIFY_DEFAULT_MATRIX[stage] ?? "unset",
    });
  }
  return {
    contract,
    elevated: true,
    disabled: false,
  };
}
