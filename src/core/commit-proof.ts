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

/** Characters a git rev spec may legitimately consist of (defense against arg injection). */
const REV_SPEC_RE = /^[0-9a-zA-Z_.@{}/^-]{2,64}$/;

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
  /** Entry clock of the stage that produced the commits (0 = unknown → C2 skips). */
  stageStartTime: number;
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
 * - C2 (freshness): `git show -s --format=%ct <id>` compared against
 *   `stageStartTime` with a 300s tolerance — only strictly-older commits fail.
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
            push(
              "commit_after_stage_start",
              `commit ${id} was created ${new Date(ct * 1000).toISOString()} — more than 300s BEFORE the "${stage}" stage start ${new Date(stageStartTime).toISOString()}`,
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
 * - writes the `commit_proof_skipped` / `commit_proof_error` /
 *   `commit_proof_violation` audit trail (single-line `k=v`, append-only);
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

    const result = await checkCommitProof({
      projectRoot: config.projectRoot,
      execFn,
      stage: meta.currentStage,
      stageStartTime: meta.stageStartTime ?? 0,
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

    return requireProof ? result.violations : [];
  } catch {
    // Last-resort fail-open: reconciliation bugs must never break verification.
    return [];
  }
}
