/**
 * @module write-scope/decision
 * 218 Phase 2 (T2.3, F.3-1/2): apply ONE merged decision to ALL write
 * candidates collected for a single tool call.
 *
 * Constraint priority (F.3-1, strongest first):
 *   readonly (never reaches here) > protected > whitelist_miss.
 * - `allow` mode only passes `whitelist_miss`; a batch containing `protected`
 *   is still decided through the human channel (F.3-2: protected wins).
 * - `deny` mode NEVER enters this function — the guard's HEAD branch returns
 *   early inside `checkBashFileTargets` / the write-edit chain (global
 *   constraint 8: byte-for-byte pre-218 behaviour).
 * - child sessions never pop a menu: `whitelist_miss` batches queue an owner
 *   write approval (owner-approval) instead; child + `protected` is hard-blocked
 *   in-loop by the guard (190 Fix-A, R9b untouched).
 *
 * Dependency direction (plan T2.3 note): flow-state / pipeline-start /
 * constants static edges are the exact shape protect-ask.ts already declares
 * (precedent; no cycle — pipeline-start never imports tool-guard, and
 * flow-state never imports write-scope).
 */

import type { PipelineConfig, PipelineStage, SessionMeta, ViolationItem, WhitelistMissMode } from "../../types";
import type { RuntimeCtx } from "../runtime-ctx";
import type { GuardSource } from "../violation-tracker";
import { DEFAULT_MAX_VIOLATIONS, AUDIT_THROTTLE_WINDOW_MS } from "../../constants";
import { safeWriteAuditLog, encodeAuditValue } from "../../utils/auditLog";
import { shouldEmitWithinWindow } from "../../utils/audit-throttle";
import { askProtectDecision, askWriteDecision } from "../../utils/protect-ask";
import { hasInteractiveUI } from "../ui-capability";
import { freezeAndPrompt } from "../flow-state";
import { buildOnStageChangedCallback } from "../../commands/pipeline-start";
import { detectSessionRole } from "../session-role";
import { enqueueWriteApproval, writeApprovalBlockReason } from "../owner-approval";
import { recordDenial, clearDenials } from "./denials";
import { formatCandidateList, uniqueClasses } from "./types";
import type { WriteCandidate, WriteDecisionOutcome } from "./types";

/** Everything the decision needs from its caller (tool-guard wires these). */
export interface ApplyWriteDecisionDeps {
  /** Runtime context: owner ask needs ui.select; meta writes need session. */
  ctx: RuntimeCtx;
  config: PipelineConfig;
  meta: SessionMeta;
  stage: PipelineStage;
  /** Resolved whitelistMiss mode for this stage (D4 four-tier). */
  mode: WhitelistMissMode;
  /** Violation recorder — deny-mode counting stays in the guard; this is used
   *  only by the documented no-UI degradation (read_only_path bucket). */
  trackViolation: (item: Omit<ViolationItem, "timestamp">, source: GuardSource) => Promise<void>;
  /** UI notification sink (tool-guard's ui.notify with ctx bound). */
  notify: (msg: string) => void;
  /** DI: tool-guard's existing message builder (avoids a write-scope → tool-guard cycle). */
  formatProtectedReason: (candidate: WriteCandidate) => string;
}

/** Reconstruct the block reason for a merged batch (max 5 targets + "…+N"). */
function buildBatchReason(candidates: WriteCandidate[], stage: PipelineStage): string {
  const list = formatCandidateList(candidates);
  return (
    `FORBIDDEN: write target(s) [${list}] not allowed by the '${stage}' stage whitelist. ` +
    `Next step: choose an allowed path, or grant the write when prompted.`
  );
}

/**
 * Apply the collected batch. Returns pass (write may proceed) or block with
 * the reason the guard must surface.
 *
 * Flow (plan T2.3, ≤100-line function split into helpers):
 * 1. empty → pass.
 * 2. protected + child → hard block (defensive; the guard already blocks in-loop).
 * 3. protected + owner + ask!==true → hard block with HEAD wording (defensive).
 * 4. protected-only + owner + ask===true → per-target askProtectDecision (HEAD semantics verbatim).
 * 5. mixed (protected + whitelist_miss) → ONE askWriteDecision for the whole batch.
 * 6. whitelist_miss only → allow / no-UI fallback / owner ask / child queue.
 */
export async function applyCollectedWrites(
  candidates: WriteCandidate[],
  deps: ApplyWriteDecisionDeps,
): Promise<WriteDecisionOutcome> {
  if (candidates.length === 0) return { action: "pass" };

  const protectedItems = candidates.filter((c) => c.category === "protected");
  const missItems = candidates.filter((c) => c.category === "whitelist_miss");
  const { isChild } = detectSessionRole(deps.ctx);

  // ── 2/3. protected with no human channel → hard block (HEAD wording/bucket) ──
  // Defensive: the guard already blocks child / non-ask protected targets in-loop.
  if (protectedItems.length > 0 && (isChild || !protectAskEnabled(deps))) {
    const first = protectedItems[0]!;
    const reason = first.reason ?? deps.formatProtectedReason(first);
    await deps.trackViolation(
      { type: "write_protected", tool: first.source, detail: reason, suggestion: `Protected paths: ${deps.config.protect?.paths?.join(", ") ?? "hardcoded + gitignore"}.` },
      "git_policy",
    );
    return { action: "block", reason, candidates };
  }

  // ── 4. protected-only batch (owner + ask enabled) → per-target HEAD flow ──
  if (missItems.length === 0) {
    return await decideProtectedOnly(protectedItems, deps);
  }

  // ── 5/6. anything containing whitelist_miss merges into ONE decision ──
  return await decideWhitelistMiss(candidates, missItems, protectedItems.length > 0, deps);
}

/** `protect.ask === true` guard for the protected human channel (unchanged semantics). */
function protectAskEnabled(deps: ApplyWriteDecisionDeps): boolean {
  return deps.config.protect?.ask === true;
}

/**
 * HEAD's per-target protected ask (audit `pipeline_protect_ask`, read_only_path
 * bucket on deny, dismissed never counts). Batch stays merged for INTERACTION
 * only when mixed; a protected-only batch replays the original flow verbatim.
 */
async function decideProtectedOnly(
  protectedItems: WriteCandidate[],
  deps: ApplyWriteDecisionDeps,
): Promise<WriteDecisionOutcome> {
  const suggestion = `Stage whitelist: [${(deps.config.stages[deps.stage]?.allowedWritePaths ?? []).join(", ")}].`;
  for (const c of protectedItems) {
    const reason = c.reason ?? deps.formatProtectedReason(c);
    const outcome = await askProtectDecision(deps.ctx, deps.meta, c.path, deps.config);
    if (outcome.decision === "block") {
      // Phase 4 (173) C11 parity: dismissed is an environment fact, not a violation.
      if (outcome.action !== "dismissed") {
        await deps.trackViolation(
          { type: "write_protected", tool: c.source, detail: reason, suggestion },
          "read_only_path",
        );
      }
      deps.notify(reason);
      return { action: "block", reason, candidates: protectedItems };
    }
    // "allow" → next target (HEAD continued the loop per target as well).
  }
  return { action: "pass" };
}

/**
 * The whitelist-miss decision (flow 6 + mixed flow 5). A mixed batch is
 * decided as ONE ask covering protected + whitelist_miss targets (F.3-2);
 * `allow` mode never silently passes a batch containing protected items.
 */
async function decideWhitelistMiss(
  all: WriteCandidate[],
  missOnly: WriteCandidate[],
  hasProtected: boolean,
  deps: ApplyWriteDecisionDeps,
): Promise<WriteDecisionOutcome> {
  const { ctx, config, meta, stage } = deps;

  // allow mode, PURE whitelist_miss batch → silent pass with throttled audit.
  if (deps.mode === "allow" && !hasProtected) {
    for (const pathClass of uniqueClasses(missOnly)) {
      if (shouldEmitWithinWindow(`whitelist_miss_allowed:${stage}:${pathClass}`, AUDIT_THROTTLE_WINDOW_MS)) {
        await safeWriteAuditLog("whitelist_miss_allowed", {
          pipelineId: meta.pipelineId, stage, pathClass,
          targets: missOnly.filter((c) => c.pathClass === pathClass).map((c) => encodeAuditValue(c.path)).join(","),
        });
      }
    }
    return { action: "pass" };
  }

  // Child with a whitelist-miss batch: the child host never pops menus —
  // queue for the owner and block the call (218 F.3-1; owner consumes at settle).
  const { isChild } = detectSessionRole(ctx);
  if (isChild) {
    const routed = enqueueWriteApproval(ctx.session, stage, missOnly);
    const reason = writeApprovalBlockReason(missOnly, routed.fingerprint, stage);
    deps.notify(reason);
    return { action: "block", reason, candidates: all };
  }

  // Owner, ask mode (mixed batches under allow arrive here too — protected wins).
  if (deps.mode === "ask" && !hasInteractiveUI(ctx)) {
    // No-UI degradation: fail closed EXACTLY like deny mode (same bucket) plus
    // a visible fallback audit + exit hints (docs/, $TMPDIR are hints only).
    const first = all[0]!;
    const reason =
      `FORBIDDEN: write target(s) [${formatCandidateList(all)}] need approval but this host has no interactive UI. ` +
      `Exits: write under an allowed stage path (e.g. docs/), configure protect.whitelistMiss="allow"/"deny", or use $TMPDIR for scratch files (hint only — not whitelisted).`;
    await deps.trackViolation(
      { type: "write_protected", tool: first.source, detail: reason, suggestion: `Stage whitelist: [${(config.stages[stage]?.allowedWritePaths ?? []).join(", ")}].` },
      "read_only_path",
    );
    await safeWriteAuditLog("whitelist_miss_no_ui_fallback", {
      pipelineId: meta.pipelineId, stage, targets: String(all.length),
      classes: uniqueClasses(all).join(","),
    }, "warn");
    deps.notify(reason);
    return { action: "block", reason, candidates: all };
  }

  // ONE merged ask for the whole batch (owner, interactive or mixed-protected).
  const outcome = await askWriteDecision(ctx, meta, all, config);
  return await dispatchWriteOutcome(outcome.action, all, deps);
}

/**
 * Q15-B / F.3-3 dispatch. An explicit human Deny is a USER decision and feeds
 * its OWN per-stage breaker (`whitelistMissDenials`) — never `dismissCount`,
 * never the violation buckets. dismissed/canceled are environment facts:
 * block without any counting.
 */
async function dispatchWriteOutcome(
  action: "allow_once" | "allow_session" | "dismissed" | "canceled" | "denied",
  candidates: WriteCandidate[],
  deps: ApplyWriteDecisionDeps,
): Promise<WriteDecisionOutcome> {
  const { ctx, config, meta, stage } = deps;

  switch (action) {
    case "allow_once":
      // Q22-A: this call only — no persistent token, next call asks again.
      return { action: "pass" };

    case "allow_session": {
      // askWriteDecision already recorded the paths; re-ensure idempotently
      // and drop the deny pressure for the stage.
      const fresh = ctx.session.getMeta() ?? meta;
      const existing = fresh.sessionAllowedWritePaths ?? [];
      const toAdd = candidates.map((c) => c.path).filter((p) => !existing.includes(p));
      if (toAdd.length > 0) {
        ctx.session.updateMeta({ sessionAllowedWritePaths: [...existing, ...toAdd] });
      }
      clearDenials(ctx.session);
      return { action: "pass" };
    }

    case "dismissed":
    case "canceled":
      // No count, no freeze (environment / cancel fact — 173 C11 family).
      return { action: "block", reason: buildBatchReason(candidates, stage), candidates };

    case "denied": {
      let overflow = false;
      const freshMeta = ctx.session.getMeta() ?? meta;
      const classes = uniqueClasses(candidates);
      for (const pathClass of classes) {
        const count = recordDenial(ctx.session, freshMeta, stage, pathClass);
        if (count >= DEFAULT_MAX_VIOLATIONS) overflow = true;
      }
      if (overflow) {
        await freezeAndPrompt(ctx, ctx.session.getMeta() ?? meta, "violation_overflow", config, {
          onStageChanged: buildOnStageChangedCallback(ctx, config),
        });
        await safeWriteAuditLog("whitelist_miss_denial_overflow", {
          pipelineId: meta.pipelineId, stage, classes: classes.join(","),
        });
      }
      await safeWriteAuditLog("pipeline_write_ask_denied", {
        pipelineId: meta.pipelineId, stage,
        count: String(candidates.length),
        paths: candidates.map((c) => encodeAuditValue(c.path)).join(","),
      });
      return { action: "block", reason: buildBatchReason(candidates, stage), candidates };
    }
  }
}
