/**
 * @module commit-proof
 * 210 Phase 6 (requirements 5.2 / 5.3): reconcile the commit evidence the model
 * DECLARED (the `{reqBase}_Develop_Commit.md` document) against the git FACTS,
 * and cross-check the document's `**plan doc**` binding against the canonical
 * plan-doc derivation.
 *
 * Design constraints honored (plan "Phase 6"):
 * - DEFAULT OFF: `requireCommitProof` resolves
 *   `stage.verify?.requireCommitProof ?? config.verify?.requireCommitProof ?? false`
 *   (stage wins, matching the existing verify-config precedence). OFF → the
 *   checks still run but violations are WARN-AUDITED only, so the verify
 *   verdict stays byte-for-byte on the baseline; ON → violations fold into the
 *   structured failure set and ride the existing retry / circuit-breaker flow.
 * - FAIL-OPEN on evidence gaps: absent requirement doc, unreadable/missing
 *   commit document, or no parsable commit ids → `commit_proof_skipped` audit,
 *   NEVER a violation (a project that never opted in must not be blocked).
 * - C2 compares against the clock of the period/stage that PRODUCED the commits
 *   ({@link resolveCommitProofClockBaseline}), never blindly against the
 *   verifying stage's own entry clock (210 review issue 1).
 * - No new dependencies: git facts come through the DI `ExecFn` (wrapped
 *   `pi.exec`); absent execFn → `error` field + `commit_proof_error` audit and
 *   an empty violation list.
 * - Audit extras stay flat `Record<string, string>` single-line `k=v`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  ExecFn,
  PipelineConfig,
  PipelineStage,
  SessionMeta,
  VerifyConfig,
} from "../types";
import type { VerifyFailure } from "./auto-verifier";
import { safeWriteAuditLog } from "../utils/auditLog";
import { resolveCommitDocPath, resolvePlanDocPath } from "./verify-path-resolver";
import { reqBaseFromRequirementDoc } from "./naming/doc-naming";

/** Owning verification group name for every commit-proof failure. */
export const COMMIT_PROOF_GROUP = "commit_proof";

/**
 * C2 clock tolerance: a commit may legitimately predate the stage entry by up
 * to five minutes (agent settle latency between `git commit` and advance).
 * The violation fires ONLY when `ct * 1000 + tolerance < stageStartTime`.
 */
export const COMMIT_TIME_TOLERANCE_MS = 300_000;

/**
 * Characters a git rev spec may legitimately consist of (defense against arg
 * injection). The FIRST character is additionally barred from being `-`, so an
 * option-looking token (`--output`, `--extcmd=…`) can never reach git argv even
 * when the remainder is made of otherwise-legal revision characters.
 */
const REV_SPEC_RE = /^[0-9a-zA-Z_.@{}/~][0-9a-zA-Z_.@{}/^-]{1,63}$/;

/**
 * Public form of the rev-spec guard (210 review issue 8).
 *
 * Model-writable documents (`**dev commit id**` lines, summary frontmatter)
 * feed git argv builders elsewhere in the plugin; every such value must pass
 * this check BEFORE it is concatenated into a rev range such as `<base>^..HEAD`.
 * Without it a value like `--output=/path` would be parsed by git as an OPTION
 * (no shell is involved, but option injection can still write files).
 */
export function isValidGitRevSpec(value: string): boolean {
  return typeof value === "string" && REV_SPEC_RE.test(value);
}

/** Stages whose OWN commit doc entries can be attributed to their own clock. */
const COMMIT_PRODUCING_STAGE: PipelineStage = "develop";

/**
 * C2 clock baseline for the CURRENT verify (210 review issue 1).
 *
 * `meta.stageStartTime` is the entry clock of the stage that is VERIFYING NOW,
 * while the commit document is written by the DEVELOP stage (and amended by
 * fix). Comparing a develop commit against a LATER stage's clock labels every
 * legitimate commit as `commit_after_stage_start` — once `verify.requireCommitProof`
 * is on, review/fix verify would then fail and ride the retry / circuit-breaker
 * flow, which directly contradicts the Phase 6 acceptance「正确 commit 通过」.
 *
 * Honest baseline per stage:
 * - `develop` on its FIRST visit → its own `stageStartTime` (strictest form of
 *   requirement 5.7 C2: the stage that produces the commits is verifying).
 * - every later stage (review / fix / awaiting_human / completed) and every
 *   re-entered develop → the current period's `pipelineStartedAt`, which is
 *   guaranteed to precede every commit produced during THIS run while still
 *   rejecting commits from a previous run / another branch's history.
 * - no trustworthy clock at all (legacy meta without `pipelineStartedAt`, or a
 *   develop visit whose start was never recorded) → `0`, which skips C2 entirely
 *   (fail-open: never invent a violation that cannot be observed).
 */
export function resolveCommitProofClockBaseline(meta: SessionMeta): {
  baselineMs: number;
  label: string;
} {
  const stageStart = meta.stageStartTime ?? 0;
  const developVisits = (meta.stageVisitOrder ?? []).filter((s) => s === "develop").length;

  if (meta.currentStage === COMMIT_PRODUCING_STAGE && developVisits <= 1 && stageStart > 0) {
    return { baselineMs: stageStart, label: "develop stage entry (first visit)" };
  }

  const runStart = meta.pipelineStartedAt ?? 0;
  if (runStart > 0) {
    // `pipelineStartedAt` is rebased by restart / re-init but PRESERVED across
    // a resume (210 review issue 2: `buildResumeMeta` keeps the original
    // period clock), so it is always the run clock of the period that
    // legitimately produced these commits.
    return { baselineMs: runStart, label: "pipeline run start" };
  }

  return { baselineMs: 0, label: "unavailable (C2 skipped)" };
}

// ─── Commit-document parsing ──────────────────────────────────────────────────

/**
 * Extracts the declared commit ids from a `{reqBase}_Develop_Commit.md`
 * document: the `**dev commit id**: a,b,c` line (comma / whitespace separated,
 * optional backticks). Case-insensitive on the key; later lines of the same
 * key accumulate. Malformed tokens are dropped, never guessed at.
 */
export function parseDevCommitIds(content: string): string[] {
  const ids: string[] = [];
  for (const m of content.matchAll(/^\s*\*\*\s*dev commit id\s*\*\*\s*:\s*(.*)$/gim)) {
    for (const token of m[1].split(/[,\s]+/)) {
      const id = token.trim().replace(/^["'`]|["'`]$/g, "").trim();
      if (id.length >= 4 && REV_SPEC_RE.test(id)) ids.push(id);
    }
  }
  // De-duplicate while preserving declaration order.
  return [...new Set(ids)];
}

/**
 * Extracts the `**plan doc**: <path>` claim from a commit document.
 * Returns null when the key is absent (C3 then skips — absence is not a lie).
 */
export function parsePlanDocClaim(content: string): string | null {
  const m = /^\s*\*\*\s*plan doc\s*\*\*\s*:\s*(.*)$/im.exec(content);
  if (!m) return null;
  const raw = m[1].trim().replace(/^["'`]|["'`]$/g, "").trim();
  return raw.length > 0 ? raw : null;
}

/** Normalizes a document path to projectRoot-relative POSIX for comparison. */
function normalizeRelPath(p: string, projectRoot: string): string {
  let s = p.replace(/\\/g, "/");
  if (path.isAbsolute(s)) {
    s = path.relative(projectRoot, s).replace(/\\/g, "/");
  }
  return s.replace(/^\.\//, "");
}

// ─── Pure git reconciliation ──────────────────────────────────────────────────

/** Outcome of the commit-proof reconciliation against git facts. */
export interface CommitProofResult {
  /** Number of commit ids that passed existence (C1) and were considered. */
  checked: number;
  /** Rule-shaped failures (group `commit_proof`); empty when nothing conflicts. */
  violations: VerifyFailure[];
  /** Reconciliation could not complete (no execFn / not a repo / exec threw). */
  error?: string;
}

/** Input for {@link checkCommitProof}. */
export interface CommitProofInput {
  /** Project root — the cwd for every git invocation and the C3 relativizer. */
  projectRoot: string;
  /** DI shell execution (wrapped pi.exec); absent → fail-open with `error`. */
  execFn?: ExecFn;
  /** Stage the check is attributed to (audit + detail text). */
  stage: PipelineStage;
  /**
   * C2 clock baseline: commits must not predate it (minus tolerance).
   * MUST be the clock of the stage/period that PRODUCED the commits, not
   * blindly the verifying stage's entry clock — callers use
   * {@link resolveCommitProofClockBaseline} (210 review issue 1).
   * 0 = unknown → C2 skips.
   */
  stageStartTime: number;
  /** Human-readable origin of the baseline, used in the C2 failure detail. */
  stageStartLabel?: string;
  /** Commit ids declared by the commit document. */
  commitIds: string[];
  /** Commit document path (relative to projectRoot or absolute) for C3. */
  commitDocPath?: string;
  /** Canonical plan-doc path (absolute or projectRoot-relative) for C3. */
  expectedPlanDoc?: string;
}

/**
 * Checks the declared commit ids against git facts.
 *
 * - C1 (existence): `git cat-file -e <id>^{commit}` — non-zero → `commit_exists`.
 * - C2 (freshness): `git show -s --format=%ct <id>` compared against the
 *   caller-provided `stageStartTime` BASELINE with a 300s tolerance — only
 *   strictly-older commits fail. The baseline must describe the commits' own
 *   origin (develop entry clock, or the run start for later stages).
 * - C3 (plan-doc binding): the commit document's `**plan doc**` claim must
 *   normalize to `expectedPlanDoc` — mismatch → `plan_doc_mismatch`.
 *
 * Never throws: exec absence / throw / non-repo probe failure set `error` and
 * leave `violations` empty (fail-open — reconciliation must not fabricate
 * failures it could not observe).
 */
export async function checkCommitProof(input: CommitProofInput): Promise<CommitProofResult> {
  const { projectRoot, execFn, stage, stageStartTime, commitIds } = input;

  if (!execFn) {
    return { checked: 0, violations: [], error: "execFn unavailable (host provides no shell execution)" };
  }

  const violations: VerifyFailure[] = [];
  let checked = 0;

  const push = (ruleType: string, detail: string): void => {
    violations.push({
      group: COMMIT_PROOF_GROUP,
      ruleType,
      detail,
    });
  };

  try {
    // Repository probe: a non-repo project is an ENVIRONMENTAL gap, not a
    // model lie — fail-open through `error` instead of flagging every id.
    const probe = await execFn("git", ["rev-parse", "--git-dir"], projectRoot);
    if (probe.code !== 0) {
      return { checked: 0, violations: [], error: `not a git repository (git rev-parse exit ${probe.code})` };
    }

    for (const id of commitIds) {
      // C1 — the declared revision must name an actual commit.
      if (!REV_SPEC_RE.test(id)) {
        push("commit_exists", `declared commit id "${id}" is not a well-formed git revision`);
        continue;
      }
      const exists = await execFn("git", ["cat-file", "-e", `${id}^{commit}`], projectRoot);
      if (exists.code !== 0) {
        push("commit_exists", `git cat-file -e ${id}^{commit} failed (exit ${exists.code}): ${firstLine(exists.stderr) || "unknown revision"}`);
        continue;
      }
      checked++;

      // C2 — the commit must not predate the producing stage (with tolerance).
      if (stageStartTime > 0) {
        const shown = await execFn("git", ["show", "-s", "--format=%ct", id], projectRoot);
        const ct = shown.code === 0 ? Number.parseInt(shown.stdout.trim(), 10) : Number.NaN;
        if (Number.isFinite(ct)) {
          if (ct * 1000 + COMMIT_TIME_TOLERANCE_MS < stageStartTime) {
            // The label names the baseline the commit is compared against, so a
            // review-stage failure reads as "predates the RUN", not "predates
            // the review stage" (210 review issue 1).
            const label = input.stageStartLabel ?? `${stage} stage start`;
            push(
              "commit_after_stage_start",
              `commit ${id} was created ${new Date(ct * 1000).toISOString()} — more than 300s BEFORE the ${label} at ${new Date(stageStartTime).toISOString()}`,
            );
          }
        }
        // Unparsable timestamp: inconclusive → skip C2 for this id (fail-open).
      }
    }

    // C3 — the commit document's plan-doc binding must match the canonical
    // derivation. Unreadable document or absent key → skip (never false-flag).
    if (input.commitDocPath && input.expectedPlanDoc) {
      const docAbs = path.isAbsolute(input.commitDocPath)
        ? input.commitDocPath
        : path.join(projectRoot, input.commitDocPath);
      try {
        const content = await fs.readFile(docAbs, "utf-8");
        const claim = parsePlanDocClaim(content);
        if (claim !== null) {
          const actual = normalizeRelPath(claim, projectRoot);
          const expected = normalizeRelPath(input.expectedPlanDoc, projectRoot);
          if (actual !== expected) {
            push("plan_doc_mismatch", `commit doc "**plan doc**" declares "${actual}", expected "${expected}"`);
          }
        }
      } catch {
        // Commit doc unreadable at check time — C3 skips per plan task 3.
      }
    }

    return { checked, violations };
  } catch (err) {
    return { checked, violations: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** First non-empty line of multi-line command output (for compact details). */
function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

// ─── Orchestration (config resolution + audits) ───────────────────────────────

/**
 * Resolves the commit-proof switch with the plan's precedence chain:
 * stage-level wins over global; both absent → false (baseline behavior).
 */
export function resolveRequireCommitProof(
  verifyConfig: VerifyConfig | undefined,
  config: PipelineConfig,
): boolean {
  return verifyConfig?.requireCommitProof ?? config.verify?.requireCommitProof ?? false;
}

/**
 * Reconciles the CURRENT run's commit document against git facts and decides
 * what auto-verifier does with the outcome:
 *
 * - returns the violations to fold into the structured failure set when
 *   `requireCommitProof` is ON, and an empty array otherwise (warn-audit only);
 * - writes the `commit_proof_skipped` / `commit_proof_checked` /
 *   `commit_proof_error` / `commit_proof_violation` audit trail (single-line
 *   `k=v`, append-only);
 * - never throws and never blocks when evidence simply is not there.
 */
export async function reconcileCommitProof(
  config: PipelineConfig,
  meta: SessionMeta,
  verifyConfig: VerifyConfig | undefined,
  execFn?: ExecFn,
): Promise<VerifyFailure[]> {
  const requireProof = resolveRequireCommitProof(verifyConfig, config);

  // Without a requirement doc there is no canonical commit document to
  // reconcile — stay completely silent (keeps baseline audits unchanged for
  // harness contexts, which overwhelmingly end up here).
  if (!meta.requirementDoc) return [];

  // Default-off and no shell capability: nothing can be reconciled and nobody
  // consumes a result — skip silently instead of emitting error audits from
  // every unit-test / no-pi.exec context.
  if (!execFn && !requireProof) return [];

  try {
    const reqBase = reqBaseFromRequirementDoc(meta.requirementDoc);
    if (!reqBase) return [];
    const commitDocRel = resolveCommitDocPath(reqBase);

    const docAbs = path.isAbsolute(commitDocRel)
      ? commitDocRel
      : path.join(config.projectRoot, commitDocRel);

    let content: string;
    try {
      content = await fs.readFile(docAbs, "utf-8");
    } catch {
      // Missing / unreadable commit doc is NOT a violation: a project without
      // the develop-commit deliverable must never be false-blocked.
      await safeWriteAuditLog("commit_proof_skipped", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        reason: "commit_doc_unreadable",
        commitDoc: commitDocRel,
      }, "warn");
      return [];
    }

    const commitIds = parseDevCommitIds(content);
    if (commitIds.length === 0) {
      await safeWriteAuditLog("commit_proof_skipped", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        reason: "no_commit_ids",
        commitDoc: commitDocRel,
      }, "warn");
      return [];
    }

    // Canonical expectations come from the SINGLE path-derivation sources
    // (verify-path-resolver / doc-naming) — never re-implemented here.
    const expectedPlanDoc = (await resolvePlanDocPath(config, meta)) ?? undefined;

    // C2 baseline: NEVER the raw "current stage entry clock" — the commit doc is
    // produced by develop, so a review/fix stage (whose `stageStartTime` is
    // strictly later) would label every legitimate commit as too old
    // (210 review issue 1). See `resolveCommitProofClockBaseline`.
    const baseline = resolveCommitProofClockBaseline(meta);

    const result = await checkCommitProof({
      projectRoot: config.projectRoot,
      execFn,
      stage: meta.currentStage,
      stageStartTime: baseline.baselineMs,
      stageStartLabel: baseline.label,
      commitIds,
      commitDocPath: commitDocRel,
      expectedPlanDoc,
    });

    if (result.error) {
      await safeWriteAuditLog("commit_proof_error", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        error: result.error,
        commitIds: commitIds.join(","),
      }, "error");
      // Exec absence / repository gaps stay fail-open even with the switch on.
      return [];
    }

    for (const v of result.violations) {
      await safeWriteAuditLog("commit_proof_violation", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        ruleType: v.ruleType,
        detail: v.detail,
        enforced: String(requireProof),
      }, "warn");
    }

    // Requirement 5.7 names `commit_proof_checked` explicitly: without it an
    // audit reader cannot tell "reconciled, everything matches" from "never
    // reconciled at all" (210 review issue 10). Emitted only when at least one
    // id actually reached git, so a fully skipped run stays silent.
    if (result.checked > 0) {
      await safeWriteAuditLog("commit_proof_checked", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        checked: String(result.checked),
        declared: String(commitIds.length),
        violations: String(result.violations.length),
        enforced: String(requireProof),
        commitIds: commitIds.join(","),
        c2Baseline: baseline.label,
        c2BaselineMs: String(baseline.baselineMs),
      }, "info");
    }

    return requireProof ? result.violations : [];
  } catch (err) {
    // Last-resort fail-open: reconciliation bugs must never break verification —
    // but they must not be invisible either (210 review issue 7, code_spec §3).
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("commit_proof_error", {
      pipelineId: meta?.pipelineId ?? "unknown",
      stage: meta?.currentStage ?? "unknown",
      error: `reconciliation threw: ${errMsg}`,
    }, "error");
    return [];
  }
}
