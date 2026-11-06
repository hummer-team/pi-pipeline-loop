/**
 * @module git-invariants
 * 225 Phase 5 (T2/D8/Q9-A): branch + stash invariants for commit-contract
 * stages — closing the two "fake pass" channels Phase 0's capability elevation
 * opened:
 * - R1 (branch drift): a mid-stage `git checkout <other-branch>` makes the
 *   working tree state of the ORIGINAL branch invisible; verified via
 *   `git status` on ANOTHER branch still reads clean ⇒ verify passes while the
 *   real work sits on the wrong branch. The recorded baseline branch catches it.
 * - R2 (stash hiding): `git stash @` can make the tree clean while the work
 *   is parked in the stash; the stash-count fingerprint catches it.
 *
 * Posture: sampling is fail-open (any exec failure ⇒ NO baseline ⇒ no verdict,
 * plus a debug audit) and the unobserved-HEAD-change case only WARNS — the
 * baseline here is content verification, never an interception.
 *
 * The contract-active check is the Phase 0 COMMIT CONTRACT (never the
 * `gitModify === "allow"` approximation): manual develop/fix stages hold
 * their allow from the built-in matrix without a stage-level key, and F6
 * scopes R1/R2 to contract stages in BOTH modes with the SAME spec.
 */

import type { ExecFn, PipelineConfig, PipelineStage, SessionMeta, VerifyConfig } from "../types";
import type { VerifyFailure } from "./auto-verifier";
import { safeWriteAuditLog } from "../utils/auditLog";
import { resolveStageCommitContract } from "./commit-contract";
import { getAllowedGitWriteCount } from "./git-write-observability";

/** VerifyFailure group for invariant verdicts (git-delivery-feedback hook). */
export const GIT_INVARIANT_GROUP = "git_invariant";

/** Resolves the requireGitInvariants switch: stage-level > global > contractActive. */
function resolveInvariantsEnabled(
  verifyConfig: VerifyConfig | undefined,
  config: PipelineConfig,
  contractActive: boolean,
): boolean {
  return verifyConfig?.requireGitInvariants ?? config.verify?.requireGitInvariants ?? contractActive;
}

/** Single-line stdout of a git command; failed/empty exec → null. */
async function gitLine(
  execFn: ExecFn,
  args: string[],
  projectRoot: string,
): Promise<string | null> {
  try {
    const res = await execFn("git", args, projectRoot);
    if (res.code !== 0) return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}

/** Stash-list fingerprint (line count — the stash stack depth). */
async function stashCountOf(execFn: ExecFn, projectRoot: string): Promise<number | null> {
  const out = await gitLine(execFn, ["stash", "list"], projectRoot);
  if (out === null) return null;
  return out.length === 0 ? 0 : out.split("\n").length;
}

/**
 * Records the branch/HEAD/stash baseline for a commit-contract stage visit —
 * ONE sample per visit (`stageStartTime` identity, idempotent: later calls
 * return without I/O). Called by tool-guard on every `isGitCmd && isWrite`
 * segment BEFORE the policy decision; sampling must never affect the guard.
 * Any command failure / no execFn ⇒ NO baseline (fail-open, debug audit).
 */
export async function ensureGitInvariantBaseline(
  config: PipelineConfig,
  meta: SessionMeta,
  session:
    | { getMeta(): SessionMeta | undefined; updateMeta(patch: Partial<SessionMeta>): unknown }
    | undefined,
  stage: PipelineStage,
  execFn: ExecFn | undefined,
): Promise<void> {
  try {
    // Contract check FIRST (Phase 0 cache — no extra I/O) ...
    const contract = await resolveStageCommitContract(config, stage);
    const contractActive = contract.requiresCommit && contract.enabled;
    // ... then the explicit off-switch (stage-level > global > contractActive).
    const stageVerify = config.stages[stage]?.verify;
    if (!resolveInvariantsEnabled(stageVerify, config, contractActive)) return;

    const live = session?.getMeta() ?? meta;
    if (live.gitInvariantBaseline?.stageStartTime === live.stageStartTime) return;

    if (!execFn) {
      void safeWriteAuditLog("git_invariant_sample_skipped", {
        pipelineId: meta.pipelineId,
        stage,
        reason: "exec_unavailable",
      }, "info");
      return;
    }

    const branch = await gitLine(execFn, ["branch", "--show-current"], config.projectRoot);
    const head = await gitLine(execFn, ["rev-parse", "HEAD"], config.projectRoot);
    const stashes = await stashCountOf(execFn, config.projectRoot);
    if (branch === null || head === null || stashes === null) {
      void safeWriteAuditLog("git_invariant_sample_skipped", {
        pipelineId: meta.pipelineId,
        stage,
        reason: "git_command_failed",
      }, "info");
      return;
    }
    session?.updateMeta({
      gitInvariantBaseline: {
        branch,
        headSha: head,
        stashCount: stashes,
        stage,
        stageStartTime: live.stageStartTime,
        recordedAt: Date.now(),
      },
    });
    void safeWriteAuditLog("git_invariant_baseline", {
      pipelineId: meta.pipelineId,
      stage,
      branch,
      stashCount: String(stashes),
    });
  } catch (err) {
    // Invariants are content verification — never alter the guard outcome.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[pi-pipeline] git-invariant sampling failed for stage="${stage}": ${errMsg}`);
    void safeWriteAuditLog("git_invariant_sample_error", { stage, error: errMsg }, "error");
  }
}

/**
 * Verifies the recorded baseline at verify time. Failures carry
 * `group: "git_invariant"` so verify-advance's git-delivery feedback picks
 * them up. Without a baseline (no writes happened this visit) there is nothing
 * to assert — zero overhead by design.
 */
export async function reconcileGitInvariants(
  config: PipelineConfig,
  meta: SessionMeta,
  verifyConfig: VerifyConfig | undefined,
  execFn: ExecFn | undefined,
): Promise<VerifyFailure[]> {
  try {
    const baseline = meta.gitInvariantBaseline;
    if (!baseline || baseline.stageStartTime !== meta.stageStartTime) return [];

    const contract = await resolveStageCommitContract(config, meta.currentStage);
    const contractActive = contract.requiresCommit && contract.enabled;
    if (!resolveInvariantsEnabled(verifyConfig, config, contractActive)) {
      void safeWriteAuditLog("git_invariants_disabled", { pipelineId: meta.pipelineId, stage: meta.currentStage });
      return [];
    }
    if (!execFn) {
      void safeWriteAuditLog("git_invariant_check_skipped", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        reason: "exec_unavailable",
      }, "info");
      return [];
    }

    const currentBranch = await gitLine(execFn, ["branch", "--show-current"], config.projectRoot);
    const currentHead = await gitLine(execFn, ["rev-parse", "HEAD"], config.projectRoot);
    const currentStash = await stashCountOf(execFn, config.projectRoot);
    if (currentBranch === null || currentHead === null || currentStash === null) return [];

    const failures: VerifyFailure[] = [];

    // R1 — branch drift (detached HEAD records "": drift only when it LEFT
    // the recorded non-empty branch).
    if (baseline.branch !== "" && currentBranch !== baseline.branch) {
      failures.push({
        ruleType: "branch_drift",
        detail: `expected branch '${baseline.branch}', found '${currentBranch}'`,
        group: GIT_INVARIANT_GROUP,
      });
    }

    // R2 — stash added commits to the stash stack while the stage ran
    // (work hidden from the verify's clean-tree / content checks).
    if (currentStash > baseline.stashCount) {
      failures.push({
        ruleType: "stash_hidden",
        detail: `work was stashed during this stage: stash entries ${baseline.stashCount} → ${currentStash}`,
        group: GIT_INVARIANT_GROUP,
      });
    }

    // 225 Phase 5 (T2/RC-1): HEAD moved but NO allowed git write was recorded
    // — WARN ONLY (unobserved write audit), never a verify failure.
    if (currentHead !== baseline.headSha && getAllowedGitWriteCount(meta) === 0) {
      void safeWriteAuditLog("git_write_unobserved", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        baselineHead: baseline.headSha.slice(0, 12),
        currentHead: currentHead.slice(0, 12),
      }, "warn");
    }

    return failures;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[pi-pipeline] git-invariant reconcile failed for stage="${meta.currentStage}": ${errMsg}`);
    void safeWriteAuditLog("git_invariant_error", { stage: meta.currentStage, error: errMsg }, "error");
    return [];
  }
}
