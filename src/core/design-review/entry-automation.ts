/**
 * @module design-review/entry-automation
 * 227 Phase 2 (D-8): design-review is DOMAIN-owned — entering the stage means
 * building the domain, and no entry path may half-enter it.
 *
 * The entry seam is split into three pure-ish steps so the caller can fold the
 * decision into its SINGLE transition commit:
 *   1. {@link authoriseDesignReviewEntry} — authorise ONLY (no meta write, no
 *      dispatch, no spawn). Auto job ⇒ auto channel; human ⇒ TUI gate; child ⇒
 *      `deferred` (the gate rejects children on BOTH tracks).
 *   2. {@link designReviewEntryPatch} — the state (or the owner hand-off
 *      marker) that rides the caller's transition commit.
 *   3. {@link dispatchDesignReviewEntry} — after the commit: audit + one
 *      coordinator dispatch + stage watchdog.
 *
 * {@link maybeEnterPendingDesignReview} is the owner settle seam that completes
 * a child-deferred entry (the child cannot authorise, but its transition
 * already committed).
 */

import type { PipelineConfig, SessionMeta, DesignReviewState } from "../../types";
import type { RuntimeCtx } from "../runtime-ctx";
import { detectSessionRole } from "../session-role";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { designReviewAuthorisationGate } from "./authorization";
import { createDesignReviewRuntimeContext } from "./runtime-context";
import { coordinateDesignReview } from "./coordinator";
import { armStageWatchdog } from "../stage-watchdog";
import { strictCommitMeta, expectedFromCurrent } from "../session-state";
import { readStateForActiveLock } from "../auto-pipeline/config-overlay";
import { stopAutoDocOnHardFailure } from "../auto-pipeline/stop-policy";

export type DesignReviewEntryAuth =
  | { kind: "authorized"; state: DesignReviewState }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string; message: string };

/** Machine-readable gate reasons rendered as actionable text. */
const FAILURE_MESSAGES: Record<string, string> = {
  child_session_cannot_authorise:
    "design-review cannot be authorised from a child session — the owner completes the entry on its next settle.",
  requirement_doc_missing: "design-review entry blocked: the requirement document is missing.",
  plan_doc_missing: "design-review entry blocked: the plan document is missing.",
  design_review_disabled: "design-review entry blocked: the stage is disabled.",
  design_review_config_invalid:
    "design-review entry blocked: stages[\"design-review\"].agentPath/skillPath is not configured.",
  tui_unavailable:
    "design-review entry blocked: no interactive UI is available to authorise the stage (use an auto job's auto channel).",
  user_cancelled: "design-review entry cancelled — nothing was entered.",
};

function describeEntryFailure(reason: string): string {
  return FAILURE_MESSAGES[reason] ?? `design-review entry blocked: ${reason}`;
}

/**
 * D-8: authorise ONLY — no meta write, no dispatch, no spawn.
 *
 * `auto job => auto channel (jobId from `meta.autoJob`, NEVER the in-process
 * lock); human => TUI gate; child => `deferred`. The gate itself rejects child
 * sessions on BOTH tracks — a human-track child has the same limitation, so the
 * deferral is uniform.
 */
export async function authoriseDesignReviewEntry(args: {
  ctx: RuntimeCtx;
  config: PipelineConfig;
  meta: SessionMeta;
}): Promise<DesignReviewEntryAuth> {
  const { ctx, config, meta } = args;
  if (detectSessionRole(ctx).isChild) return { kind: "deferred" };

  // The job id comes from the INHERITED meta, not `autoPipelineAuthOpts()`:
  // a child process has no in-process lock, so the gate would mis-read
  // `tui_unavailable` on the auto channel.
  const jobId = meta.autoJob?.jobId;
  const result = await designReviewAuthorisationGate(ctx, config, meta, {
    authorizationSource: jobId ? "auto" : "direct-entry",
    ...(jobId ? { autoPipeline: { jobId } } : {}),
  });

  if (result.ok) return { kind: "authorized", state: result.state };
  return { kind: "failed", reason: result.reason, message: describeEntryFailure(result.reason) };
}

/**
 * D-8: the entry rides the caller's SINGLE transition commit — `authorized`
 * adds the state (+ recheck clear), `deferred` adds the owner hand-off marker.
 */
export function designReviewEntryPatch(
  auth: DesignReviewEntryAuth | undefined,
  meta: SessionMeta,
): Partial<SessionMeta> {
  if (!auth) return {};
  if (auth.kind === "authorized") {
    return { designReview: auth.state, designReviewRecheck: undefined };
  }
  if (auth.kind === "deferred") {
    return {
      designReviewEntryPending: {
        at: Date.now(),
        ...(meta.pipelineId !== undefined ? { pipelineId: meta.pipelineId } : {}),
      },
    };
  }
  return {};
}

/**
 * D-8: after the transition COMMITTED — audit + coordinator dispatch +
 * `armStageWatchdog`. Exactly ONE dispatch per entry; callers never fall back
 * to `spawnStageSubagent` once an entry is present.
 *
 * A `pending` coordinator result is NOT an entry failure (the domain exists);
 * the caller only audits it and lets the coordinator's pending semantics
 * continue.
 */
export async function dispatchDesignReviewEntry(args: {
  ctx: RuntimeCtx;
  config: PipelineConfig;
  meta: SessionMeta;
  state: DesignReviewState;
}): Promise<{ ok: boolean; message: string }> {
  const { ctx, config, meta, state } = args;
  // Test/entry spawn hook: `RuntimeCtx` does not declare it, but every caller
  // that provides it (harnesses, `stage_advance`) must reach the coordinator.
  type SpawnOverride = Parameters<typeof createDesignReviewRuntimeContext>[0]["spawnOverride"];
  const spawnOverride = (ctx as unknown as { spawnOverride?: SpawnOverride }).spawnOverride;
  const coordinatorCtx = createDesignReviewRuntimeContext({
    config,
    session: ctx.session,
    interactionSource: "auto",
    roleCtx: ctx,
    rawUi: ctx.ui,
    pi: ctx.pi,
    ...(spawnOverride !== undefined ? { spawnOverride } : {}),
  });

  const result = await coordinateDesignReview(coordinatorCtx, meta, "advance");
  armStageWatchdog(ctx, config, { progressSource: "stage_advance" });

  await safeWriteAuditLog("design_review_auto_entry", {
    pipelineId: meta.pipelineId ?? "",
    authorizationId: state.authorizationId,
    status: result.status,
    action: result.status === "handled" ? result.action : "none",
  });

  if (result.status === "handled" && (result.action === "routed" || result.action === "advanced")) {
    return { ok: true, message: `Design review dispatched (${result.action}).` };
  }
  if (result.status === "handled" && result.action === "pending") {
    return { ok: false, message: result.reason };
  }
  if (result.status === "handled" && result.action === "frozen") {
    return { ok: false, message: result.reason };
  }
  return { ok: false, message: `design-review coordinator: ${result.status}` };
}

/**
 * D-8: owner settle seam completing a child-deferred entry.
 *
 * Returns true when a pending entry was consumed (successfully or as a hard
 * stop), false when there was nothing to do. Every stale form (stage moved,
 * domain already built, sidecar not running, another pipelineId) is cleared and
 * audited — there is no TTL because the owner attempts this on EVERY settle.
 */
export async function maybeEnterPendingDesignReview(
  ctx: RuntimeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<boolean> {
  if (detectSessionRole(ctx).isChild) return false;
  const fresh = ctx.session.getMeta() ?? meta;
  const pending = fresh.designReviewEntryPending;
  if (!pending) return false;

  const clearPending = (): void => {
    ctx.session.updateMeta({ designReviewEntryPending: undefined });
  };
  const auditStale = async (code: string): Promise<void> => {
    await safeWriteAuditLog("design_review_entry_pending_stale", {
      pipelineId: fresh.pipelineId ?? "",
      stage: fresh.currentStage ?? "",
      code,
    }, "warn");
  };

  if (fresh.currentStage !== "design-review") {
    clearPending();
    await auditStale("stage_moved");
    return false;
  }
  if (fresh.designReview) {
    // Another path already built the domain — the marker is obsolete.
    clearPending();
    await auditStale("domain_exists");
    return false;
  }
  if (
    pending.pipelineId !== undefined
    && fresh.pipelineId !== undefined
    && pending.pipelineId !== fresh.pipelineId
  ) {
    clearPending();
    await auditStale("pipeline_mismatch");
    return false;
  }
  const sidecar = readStateForActiveLock(config.projectRoot);
  if (!sidecar || sidecar.status !== "running") {
    clearPending();
    await auditStale("sidecar_not_running");
    return false;
  }

  const auth = await authoriseDesignReviewEntry({ ctx, config, meta: fresh });

  if (auth.kind === "authorized") {
    // The transition itself was already committed by the child, so only the
    // domain state is written here (no `recordStageVisit` — no second visit).
    const commit = strictCommitMeta(
      ctx.session,
      {
        designReview: auth.state,
        designReviewRecheck: undefined,
        designReviewEntryPending: undefined,
      },
      expectedFromCurrent(fresh),
    );
    if (commit.status !== "persisted") {
      await safeWriteAuditLog("design_review_entry_commit_failed", {
        pipelineId: fresh.pipelineId ?? "",
        status: commit.status,
        reason: commit.reason,
      }, "error");
      return true;
    }
    const dispatched = await dispatchDesignReviewEntry({
      ctx,
      config,
      meta: ctx.session.getMeta() ?? fresh,
      state: auth.state,
    });
    if (!dispatched.ok) {
      await safeWriteAuditLog("design_review_dispatch_pending", {
        pipelineId: fresh.pipelineId ?? "",
        stage: "design-review",
        message: dispatched.message,
      }, "warn");
    }
    return true;
  }

  if (auth.kind === "failed") {
    clearPending();
    await safeWriteAuditLog("design_review_auto_entry_failed", {
      pipelineId: fresh.pipelineId ?? "",
      stage: "design-review",
      reason: auth.reason,
    }, "error");
    await stopAutoDocOnHardFailure({
      ctx,
      config,
      meta: fresh,
      reason: "design_review_entry_failed",
      auditEvent: "design_review_auto_entry_failed",
    });
    return true;
  }

  // `deferred` cannot come back for an owner — clear and stay inert.
  clearPending();
  await auditStale("role_flipped");
  return true;
}
