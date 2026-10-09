/**
 * @module stage-executor/tool-consumption
 * 194 Phase 3 (C5): the shared CALLER GATE for the stage-side tools
 * (`stage_advance`, `pipeline_verify`, `pipeline_handoff`).
 *
 * Every gate decision comes from runtime evidence against the owner's CURRENT
 * run (never from `args.stage`, prompt text or a model parameter):
 * - a CURRENT closed-loop child strictly REGISTERS its latest completion
 *   declaration and performs nothing else: no verification, no advance, no
 *   budget, no UI, no dispatch;
 * - stale/unknown callers are refused with ZERO side effects;
 * - the OWNER continues into the existing verification/confirm flow only
 *   after a trusted terminal, and its side effects go through the bound strict
 *   commits in `transition-commit.ts`; before the terminal the owner stays in
 *   `awaiting-terminal`, and a failed/aborted terminal parks on
 *   `awaiting-owner-recovery` (D4);
 * - while the design-review domain loop is still active the owner's trusted
 *   outcome keeps being consumed by the coordinator (193 unchanged), so the
 *   gate stays ordinary there.
 */

import { randomUUID } from "node:crypto";
import type {
  PipelineConfig,
  PipelineStage,
  SessionMeta,
  StageCompletionDeclaration,
  StageExecutorRun,
} from "../../types";
import { strictCommitMeta } from "../session-state";
import { executorExpectationFromCurrent } from "./commit-guard";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { detectSessionRole } from "../session-role";
import {
  readOwnExecutorBinding,
  resolveExecutorCallerRole,
  type BindingEntryLike,
} from "./runtime-binding";
import { isRunUnfinished } from "./contracts";
import { mergeDeclaration, type DeclarationRequest } from "./run-state";

/** The gated tool entries (C5 rule 1). */
export type StageToolName = "stage_advance" | "pipeline_verify" | "pipeline_handoff";

/** Minimal session surface the gate needs (structural for tests). */
export interface GateSession {
  getMeta(): SessionMeta | undefined;
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
  updateMetaVerified?(
    patch: Partial<SessionMeta>,
    expected: Parameters<typeof strictCommitMeta>[2],
  ): ReturnType<typeof strictCommitMeta>;
}

/** Gate outcome: continue the flow, or return this tool result verbatim. */
export type StageToolGateOutcome =
  /** No participating close loop — the original flow runs unchanged. */
  | { kind: "ordinary" }
  /** Owner after a trusted terminal — continue, with bound strict commits. */
  | { kind: "owner-bound"; run: StageExecutorRun }
  /** Final tool result for the caller (child/stale/unknown/pre-terminal). */
  | { kind: "return"; result: Record<string, unknown> };

export interface StageToolGateDeps {
  tool: StageToolName;
  config: PipelineConfig;
  session: GateSession;
  /** FRESH meta already read by the tool entry (the gate never re-reads). */
  meta: SessionMeta;
  args: Record<string, unknown>;
  /** Raw entry ctx — the ONLY source of role/session evidence. */
  runtimeCtx: unknown;
  /** DI id issuer (tests); defaults to crypto.randomUUID. */
  issueDeclarationId?: () => string;
}

/** The copy returned to a bound child after its declaration is stored. */
export const CHILD_DECLARED_COPY =
  "Completion declaration recorded for the OWNER session. Stop here and wait: " +
  "the owner verifies/confirms and advances — the executor must not re-submit.";

/** True while the design-review domain loop still owns the outcome (193). */
function isDesignReviewDomainActive(meta: SessionMeta): boolean {
  const dr = meta.designReview;
  return !!dr && dr.phase !== "finished";
}

/** Read the caller session's own local entries (child identity records). */
function callerLocalEntries(runtimeCtx: unknown): BindingEntryLike[] {
  const manager = (
    runtimeCtx as {
      _ctx?: {
        sessionManager?: {
          getBranch?: () => unknown[];
          getEntries?: () => unknown[];
        };
      };
    }
  )?._ctx?.sessionManager;
  const list =
    typeof manager?.getBranch === "function"
      ? manager.getBranch()
      : typeof manager?.getEntries === "function"
        ? manager.getEntries()
        : [];
  return Array.isArray(list) ? (list as BindingEntryLike[]) : [];
}

/** Child-side argument over-reach: rejected WITHOUT touching the declaration. */
function detectChildOverreach(
  tool: StageToolName,
  args: Record<string, unknown>,
  run: StageExecutorRun,
  meta: SessionMeta,
  config: PipelineConfig,
): string | null {
  if (tool === "pipeline_verify") {
    if (typeof args.stage === "string" && args.stage.trim().length > 0
      && args.stage !== run.binding.stage) {
      return "verify_stage_override";
    }
    if (typeof args.verifyFile === "string" && args.verifyFile.trim().length > 0) {
      return "verify_file_override";
    }
    return null;
  }
  if (tool === "stage_advance") {
    if (args.skipVerify === true) return "advance_skip_verify";
    if (typeof args.reviewConclusion === "string" && args.reviewConclusion.trim().length > 0) {
      return "advance_review_conclusion";
    }
    if (typeof args.nextStage === "string" && args.nextStage.trim().length > 0) {
      const target = args.nextStage.trim();
      if (!(target in config.stages)) return "advance_unknown_target";
      if (target === meta.currentStage) return "advance_same_stage";
    }
    return null;
  }
  return null;
}

/**
 * Normalize a real `stage_advance` call into a declaration request.
 * Omitted `nextStage` means "configured default" (null), omitted
 * `needConfirm` is false per the existing API — normalization happens HERE,
 * never later from a terminal or a wake.
 */
function advanceDeclarationRequest(args: Record<string, unknown>): DeclarationRequest {
  const nextStage = typeof args.nextStage === "string" && args.nextStage.trim().length > 0
    ? (args.nextStage.trim() as PipelineStage)
    : null;
  return {
    requestedBy: "stage_advance",
    isRealStageAdvanceCall: true,
    nextStage,
    needConfirmProvided: typeof args.needConfirm === "boolean",
    needConfirm: args.needConfirm === true,
  };
}

/**
 * Register (or merge) a current child's declaration through ONE strict commit.
 * Identical requests echo without any write (no revision bump, no wake).
 */
async function registerChildDeclaration(
  deps: StageToolGateDeps,
  run: StageExecutorRun,
): Promise<StageToolGateOutcome> {
  const request: DeclarationRequest = deps.tool === "pipeline_verify"
    ? { requestedBy: "pipeline_verify", isRealStageAdvanceCall: false, verificationRequested: true }
    : advanceDeclarationRequest(deps.args);

  const merged = mergeDeclaration(
    run.declaration,
    request,
    deps.issueDeclarationId ?? (() => randomUUID()),
  );

  if (merged.declaration === run.declaration) {
    // Identical request: zero writes, zero wake, same honest answer.
    void safeWriteAuditLog("owner_consumption", {
      action: "child_declaration_echo",
      runId: run.binding.runId,
      revision: String(run.declaration?.revision ?? 0),
    });
    return { kind: "return", result: { success: false, pending: true, action: "declared-for-owner", message: CHILD_DECLARED_COPY } };
  }

  const res = strictCommitMeta(
    deps.session,
    { stageExecutorRun: { ...run, declaration: merged.declaration } },
    {
      pipelineId: deps.meta.pipelineId ?? "unknown",
      ...executorExpectationFromCurrent(deps.meta),
    },
  );
  if (res.status !== "persisted") {
    void safeWriteAuditLog("owner_consumption", {
      action: "child_declaration_failed",
      runId: run.binding.runId,
      commit: res.status,
      reason: "reason" in res ? res.reason : "unknown",
    }, "error");
    return {
      kind: "return",
      result: {
        success: false,
        error: `declaration_commit_failed:${res.status}`,
        message: "The completion declaration could not be persisted. No verification or advancement was performed.",
      },
    };
  }

  void safeWriteAuditLog("owner_consumption", {
    action: "child_declaration_registered",
    runId: run.binding.runId,
    stage: run.binding.stage,
    revision: String(merged.declaration.revision),
    requestedBy: merged.declaration.requestedBy,
    revisionChanged: String(merged.revisionChanged),
  });
  return {
    kind: "return",
    result: {
      success: false,
      pending: true,
      action: "declared-for-owner",
      declarationRevision: merged.declaration.revision,
      message: CHILD_DECLARED_COPY,
    },
  };
}

/**
 * The owner relay (C5 rule 3): a stored `needConfirm: true` is NEVER
 * downgraded by omitted arguments, and a stored target fills an omitted one.
 */
export function applyDeclarationRelay(
  args: Record<string, unknown>,
  declaration: StageCompletionDeclaration | undefined,
): Record<string, unknown> {
  if (!declaration) return args;
  const out = { ...args };
  if (out.nextStage === undefined && declaration.nextStage !== undefined && declaration.nextStage !== null) {
    out.nextStage = declaration.nextStage;
  }
  if (declaration.needConfirm === true && out.needConfirm !== true) {
    out.needConfirm = true;
  }
  return out;
}

/**
 * The C5 caller gate. Call sites must run this AFTER the fresh-meta/dormant
 * checks and BEFORE the coordinator and any verification, confirmation,
 * counting or dispatch. `ordinary` leaves the existing flow untouched.
 */
export async function gateStageToolCall(
  deps: StageToolGateDeps,
): Promise<StageToolGateOutcome> {
  const run = deps.meta.stageExecutorRun;
  // No current run, or already consumed → this call is ordinary pipeline work.
  if (!run || run.terminalConsumed) return { kind: "ordinary" };

  // ── role evidence (fail-closed: absence of evidence is NOT a fallback) ──
  let roleEvidence: ReturnType<typeof detectSessionRole> | null = null;
  try {
    roleEvidence = detectSessionRole(deps.runtimeCtx as Parameters<typeof detectSessionRole>[0]);
  } catch {
    roleEvidence = null;
  }
  const callerIsChild = roleEvidence?.isChild === true;
  const ownBinding = callerIsChild ? readOwnExecutorBinding(callerLocalEntries(deps.runtimeCtx)) : null;
  const role = resolveExecutorCallerRole({
    currentRun: run,
    callerSessionFile: roleEvidence?.sessionFile || null,
    callerIsChild,
    ownBinding,
  });

  switch (role) {
    case "child-current": {
      if (deps.tool === "pipeline_handoff") {
        // Handoff is the owner/dispatcher entry: a child NEVER declares or
        // transitions through it (C5 rule 5, zero side effects).
        void safeWriteAuditLog("owner_consumption", {
          action: "child_handoff_refused",
          runId: run.binding.runId,
          reason: "handoff_is_plugin_owned",
        }, "warn");
        return {
          kind: "return",
          result: {
            success: false,
            action: "caller_refused",
            reason: "handoff_is_plugin_owned",
            error: "pipeline_handoff is owner-side: the executor may only declare completion via stage_advance/pipeline_verify.",
          },
        };
      }
      const overreach = detectChildOverreach(deps.tool, deps.args, run, deps.meta, deps.config);
      if (overreach !== null) {
        void safeWriteAuditLog("owner_consumption", {
          action: "child_overreach_rejected",
          runId: run.binding.runId,
          reason: overreach,
        }, "warn");
        return {
          kind: "return",
          result: {
            success: false,
            action: "declaration_rejected",
            reason: overreach,
            error: `The bound executor may not perform this call (${overreach}). Declare completion normally; the owner verifies and advances.`,
          },
        };
      }
      return await registerChildDeclaration(deps, run);
    }

    case "child-stale":
    case "unknown": {
      // Zero verification, budget, declaration, UI and dispatch — the run
      // stays exactly as persisted.
      void safeWriteAuditLog("owner_consumption", {
        action: "caller_refused",
        role,
        runId: run.binding.runId,
        tool: deps.tool,
      }, "warn");
      return {
        kind: "return",
        result: {
          success: false,
          action: "caller_refused",
          reason: role === "child-stale" ? "stale_executor_binding" : "caller_identity_unproven",
          error: role === "child-stale"
            ? "This session's recorded executor identity belongs to an earlier run — mutations are refused with zero side effects."
            : "The caller identity cannot be proven against the current run — mutations are refused with zero side effects.",
        },
      };
    }

    case "owner-current": {
      // While the design-review domain loop is active the coordinator keeps
      // consuming the trusted outcome (193 semantics unchanged).
      if (isDesignReviewDomainActive(deps.meta)) return { kind: "ordinary" };
      if (isRunUnfinished(run)) {
        // Before a trusted terminal the owner stays awaiting-terminal: no
        // verification/confirm/count/dispatch happens here.
        void safeWriteAuditLog("owner_consumption", {
          action: "owner_awaiting_terminal",
          runId: run.binding.runId,
          stage: run.binding.stage,
          status: run.status,
          tool: deps.tool,
        });
        return {
          kind: "return",
          result: {
            success: false,
            pending: true,
            action: "awaiting-terminal",
            message: "The bound executor's end is not yet proven. Nothing was verified or advanced; wait for the trusted terminal outcome.",
          },
        };
      }
      if (run.status === "failed" || run.status === "aborted") {
        void safeWriteAuditLog("owner_consumption", {
          action: "owner_awaiting_recovery",
          runId: run.binding.runId,
          stage: run.binding.stage,
          status: run.status,
          tool: deps.tool,
        });
        return {
          kind: "return",
          result: {
            success: false,
            pending: true,
            action: "awaiting-owner-recovery",
            message: "The executor ended FAILED/ABORTED. Recovery is an explicit owner decision (verify artifacts, retry, or take over) — automatic advancement is withheld.",
          },
        };
      }
      // Trusted completed terminal, not yet consumed: the owner's real tool
      // action drives the bound consumption commits.
      return { kind: "owner-bound", run };
    }
  }
}
