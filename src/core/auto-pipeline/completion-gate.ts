/**
 * @module auto-pipeline/completion-gate
 * 227 Phase 5 (D-11/D-12/D-15): `completed` is written ONLY after FIVE hard
 * evidence items hold. The gate is the same at every `completed` write point
 * (`stage_advance` / verify forward / `pipeline_handoff`).
 *
 * Evidence:
 *  ① the CURRENT review round PASSed (`evaluateReviewExitGate`, never a
 *    historical report — no `reviewRound` means no proof);
 *  ② a visited design-review domain is CLOSED (`phase === "finished"` + approval);
 *  ③ no To-Fix debt (`reviewPendingFail` / `flowState === "blocked"`);
 *  ④ the fix commits reconcile with git (summary commit ids + `checkCommitProof`);
 *  ⑤ every visited delivery stage has a VALID summary (auto jobs let the plugin
 *    validate it; the human track must do it itself).
 *
 * An unsatisfied gate NEVER writes `completed`: an auto job HARD stops
 * (`completion_gate_unsatisfied`, `onFailure` is ignored), the human track gets
 * an actionable message.
 */

import * as fs from "node:fs/promises";
import type { DegradedPassRecord, ExecFn, PipelineConfig, PipelineStage, SessionMeta, SummaryMeta } from "../../types";
import { checkStageSummaryHash } from "../../utils/summary-hash";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { evaluateReviewExitGate } from "../review-exit-gate";
import { checkCommitProof } from "../commit-proof";
import { readSummaryCommitIds } from "../stage-evidence";
import { isDegradedPassBound } from "./degraded-pass";
import { stopAutoDocOnHardFailure } from "./stop-policy";

export type CompletionGateFailure = {
  code:
    | "review_not_passed"
    | "design_review_not_closed"
    | "pending_debt"
    | "fix_commit_unproven"
    | "summary_not_valid"
    | "degraded_pass_invalid";
  detail: string;
};

export interface CompletionGateInput {
  config: PipelineConfig;
  meta: SessionMeta;
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (p: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  execFn?: ExecFn;
  now?: number;
  /** Runtime ctx (role evidence + child stop forwarding); omitted → owner. */
  runtimeCtx?: unknown;
  /**
   * the sixth-evidence candidate built by the caller
   * (the advance branch). When present it may substitute evidence ①; on a
   * rejection the caller must NOT persist it (candidate evaluation only).
   */
  pendingDegradedPass?: DegradedPassRecord;
}

/** Delivery stages whose summary must be VALID before the pipeline closes. */
const DELIVERY_STAGES: readonly PipelineStage[] = ["develop", "review", "fix"];

function fail(code: CompletionGateFailure["code"], detail: string): { ok: false; failure: CompletionGateFailure } {
  return { ok: false, failure: { code, detail } };
}

/**
 * First JSON-frontmatter block of a summary, or null for a legacy summary.
 * A missing frontmatter is NOT a failure (legacy artifacts are judged by hash).
 */
function readFrontmatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith("---")) return null;
  const close = content.indexOf("\n---", 3);
  if (close < 0) return null;
  try {
    const parsed = JSON.parse(content.slice(3, close)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function evaluateCompletionGate(
  input: CompletionGateInput,
): Promise<{ ok: true; autoValidated: PipelineStage[] } | { ok: false; failure: CompletionGateFailure }> {
  const { config, meta, session, execFn } = input;
  const visited = new Set<PipelineStage>(meta.stageVisitOrder ?? []);
  const autoValidated: PipelineStage[] = [];
  /**
   * 227 review fix (issue 1): the auto track validates on the model's behalf.
   * The patches are accumulated and committed ONCE: `meta.summaries` is the
   * CALL-TIME snapshot and `updateMeta` replaces the whole `summaries` map, so
   * per-stage writes would overwrite every earlier auto-validation (two pending
   * stages left only the last one `valid`).
   */
  const autoValidations: Array<{ stage: PipelineStage; previousStatus: SummaryMeta["status"]; entry: SummaryMeta }> = [];

  // ① — this round's review must be a REAL PASS.
  // a BOUND candidate `pendingDegradedPass` (scope
  // "completion", zero blocking) may substitute THIS evidence only; ② ③ ④ ⑤
  // and the four write points stay untouched (degraded release is not a
  // bypass). An unbound/ineligible record ⇒ degraded_pass_invalid.
  if (visited.has("review")) {
    const effective = input.pendingDegradedPass ?? meta.degradedPass;
    const substituteOk =
      effective !== undefined && effective.scope === "completion" && isDegradedPassBound(meta, effective);
    if (!substituteOk) {
      // A completion-scope CANDIDATE the caller supplied is judged RIGHT HERE:
      // an ineligible one (blocking items left / identity mismatch) reports
      // `degraded_pass_invalid`, never a silent retryable PASS.
      const candidateInvalid =
        input.pendingDegradedPass !== undefined && input.pendingDegradedPass.scope === "completion";
      if (!meta.reviewRound) {
        return fail(candidateInvalid ? "degraded_pass_invalid" : "review_not_passed",
          candidateInvalid
            ? "a completion-scope degraded pass exists but is NOT bound for this run (pipelineId/docPath mismatch or blocking items left)."
            : "no review round is recorded for the current review visit — a historical report is not proof.");
      }
      const gate = await evaluateReviewExitGate(config, meta);
      if (gate.state !== "conclusion" || gate.verdict?.verdict !== "pass") {
        return fail(candidateInvalid ? "degraded_pass_invalid" : "review_not_passed",
          candidateInvalid
            ? "a completion-scope degraded pass exists but is NOT bound for this run (blockers must be zero; pipelineId/docPath must match)."
            : `the current review round has no PASS verdict (state=${gate.state}${gate.reason ? `, reason=${gate.reason}` : ""}${effective !== undefined ? "; the carried degraded record is downstream visibility only, never evidence ①" : ""}).`);
      }
    }
  }

  // ② — a visited design-review domain must be CLOSED.
  if (visited.has("design-review")) {
    const dr = meta.designReview;
    if (!dr || dr.phase !== "finished" || !dr.approval) {
      return fail(
        "design_review_not_closed",
        `design-review is not finished (phase=${dr?.phase ?? "missing"}, approval=${dr?.approval ? "present" : "missing"}).`,
      );
    }
  }

  // ③ — no To-Fix debt, no blocked flow.
  if (meta.reviewPendingFail !== undefined) {
    return fail("pending_debt", "a declared review FAIL is still owed to the fix stage.");
  }
  if (meta.flowState === "blocked") {
    return fail("pending_debt", `the pipeline is blocked (${meta.blockedReason ?? "unknown"}).`);
  }

  // ④ — fix commits must reconcile with git.
  if (visited.has("fix")) {
    const ids = await readSummaryCommitIds(meta.summaries?.fix?.path);
    if (!ids || ids.length === 0) {
      return fail("fix_commit_unproven", "the fix summary has no readable commit ids.");
    }
    const fromStats = meta.stageStats?.fix?.startedAt;
    const baseline = fromStats ?? meta.pipelineStartedAt ?? 0;
    if (baseline <= 0) {
      return fail("fix_commit_unproven", "no trustworthy fix entry clock (stageStats.fix.startedAt / pipelineStartedAt absent).");
    }
    if (!execFn) {
      return fail("fix_commit_unproven", "no shell execution available to reconcile the fix commits.");
    }
    const proof = await checkCommitProof({
      projectRoot: config.projectRoot,
      execFn,
      stage: "fix",
      stageStartTime: baseline,
      stageStartLabel: fromStats !== undefined ? "stageStats.fix.startedAt" : "pipelineStartedAt",
      commitIds: ids,
      ...(meta.summaries?.fix?.path ? { commitDocPath: meta.summaries.fix.path } : {}),
    });
    if (proof.error) return fail("fix_commit_unproven", proof.error);
    if (proof.violations.length > 0) {
      return fail(
        "fix_commit_unproven",
        proof.violations.map((v) => v.detail).join("; "),
      );
    }
  }

  // ⑤ — every visited delivery stage carries a VALID summary for THIS visit.
  for (const stage of DELIVERY_STAGES) {
    if (!visited.has(stage)) continue;    const entry = meta.summaries?.[stage];
    if (!entry) {
      return fail("summary_not_valid", `stage "${stage}" has no summary artifact.`);
    }
    const check = checkStageSummaryHash(meta, stage);
    if (check === undefined) {
      // 227 review fix (issue 3): a summary without `path`/`hash` proves
      // NOTHING about the current visit — the gate is a strict evidence set,
      // never an "unverifiable ⇒ allow" path.
      return fail(
        "summary_not_valid",
        `stage "${stage}" summary has no recorded path/hash — it cannot be verified for this visit.`,
      );
    }
    if (!check.match) {
      return fail("summary_not_valid", `stage "${stage}" summary hash mismatch (modified manually).`);
    }
    if (stage === "review") {
      if (!meta.reviewRound || meta.reviewRound.stageStartTime !== meta.stageStartTime) {
        return fail("summary_not_valid", "the review summary is not bound to the current review round/visit.");
      }
    }
    const content = await fs.readFile(entry.path, "utf-8").catch(() => null);
    if (content === null) {
      return fail("summary_not_valid", `stage "${stage}" summary is unreadable (${entry.path}).`);
    }
    const frontmatter = readFrontmatter(content);
    if (frontmatter && frontmatter.stage !== undefined && frontmatter.stage !== stage) {
      return fail(
        "summary_not_valid",
        `stage "${stage}" summary declares stage "${String(frontmatter.stage)}".`,
      );
    }
    if (entry.status === "valid") continue;
    if (!meta.autoJob) {
      return fail("summary_not_valid", `stage "${stage}" summary is '${entry.status}' — validate it first.`);
    }
    // Auto track: the plugin validates on the model's behalf (audited below).
    autoValidations.push({
      stage,
      previousStatus: entry.status,
      entry: { ...entry, status: "valid" },
    });
    autoValidated.push(stage);
  }

  if (autoValidations.length > 0) {
    // Re-read the LIVE summaries so a concurrent writer is not clobbered, then
    // apply the whole batch in a single write.
    const latest = session.getMeta()?.summaries ?? meta.summaries ?? {};
    const summaries: Record<string, SummaryMeta> = { ...latest };
    for (const validation of autoValidations) {
      summaries[validation.stage] = validation.entry;
    }
    session.updateMeta({ summaries });
    for (const validation of autoValidations) {
      await safeWriteAuditLog("summary_auto_validated", {
        pipelineId: meta.pipelineId ?? "",
        stage: validation.stage,
        previousStatus: validation.previousStatus,
      });
    }
  }

  return { ok: true, autoValidated };
}

/**
 * D-12: an unsatisfied gate NEVER writes `completed`. Auto job = hard stop
 * (owner executes, child forwards); human track = actionable refusal.
 */
export async function enforceCompletionGate(
  input: CompletionGateInput,
): Promise<{ allowed: boolean; message: string }> {
  const result = await evaluateCompletionGate(input);
  if (result.ok) return { allowed: true, message: "" };

  const { code, detail } = result.failure;
  if (!input.meta.autoJob) {
    await safeWriteAuditLog("completion_gate_blocked", {
      pipelineId: input.meta.pipelineId ?? "",
      code,
      detail,
    }, "warn");
    return {
      allowed: false,
      message:
        `Pipeline cannot complete: ${code} — ${detail} ` +
        "Resolve the evidence (review PASS, closed design-review, no debt, proven fix commits, validated summaries) and retry.",
    };
  }

  await stopAutoDocOnHardFailure({
    ctx: input.runtimeCtx ?? { session: input.session, config: input.config },
    config: input.config,
    meta: input.meta,
    reason: "completion_gate_unsatisfied",
    auditEvent: "completion_gate_blocked",
    auditExtras: { code, detail },
  });
  return {
    allowed: false,
    message: `Pipeline cannot complete: ${code} — ${detail} The auto job was stopped.`,
  };
}
