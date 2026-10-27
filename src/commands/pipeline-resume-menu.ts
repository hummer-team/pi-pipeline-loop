/**
 * @module pipeline-resume-menu
 * 213 Phase 3 (D1–D7, D13/D13-a): the ONE actionable exit for every
 * `/pipeline-resume` lifecycle state — pure menu construction + the destructive
 * executors live here so `pipeline-resume.ts` keeps only dispatch.
 *
 * Contract (213 plan, Phase 3 task 1-3):
 * - `buildResumeMenu(kind, meta, currentDocRel?)` — the 3-row per-state menus
 *   (default FIRST + "(default)" suffix per the flow-state choose_stage
 *   convention); intents resolve by OPTION INDEX (labels are user-visible text,
 *   never a lookup key).
 * - `runResumeSkeleton` — present, resolve, dispatch to one of the executors.
 * - `runRestoreBranch` (D5) — aborted in-place restore; design-review re-entry
 *   runs the SAME authorisation gate as `choose_stage`; a stage outside
 *   `RESUMABLE_STAGES` degrades to the new-pipeline branch (same judgment as
 *   /pipeline-start's resumable matrix).
 * - `runNewPipelineBranch` (D13/D13-a) — the ONLY destructive path: stage/doc
 *   selection → one explicit fact-based confirmation → snapshot anchors BEFORE
 *   any write → compare-before-write (zero side effects) → `startNewPipeline`
 *   (unchanged export) → identity self-check → post-write strict verification
 *   under the NEW identity → old-pipeline timer cleanup → supersede audit only
 *   when `persisted`.
 * - `noUiExit` — the honest single sentence for sessions without an
 *   interactive UI (`resume_skipped_no_menu` + `reason:"no_ui"` + `branch`).
 *
 * Capability note (D18): `menuCapable` is decided ONCE by the command via
 * `hasInteractiveUI`; the executors still fail closed via a TRUTHINESS guard on
 * the select handle (a host may declare `hasUI: true` without handing out a
 * `select` control) — deliberately no `typeof …=== "function"` literals here
 * (the 213 plan locks the capability-predicate counts, M1/M2/M3).
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";
import { RESUMABLE_STAGES } from "../constants";
import { getFlowState } from "../core/flow-state";
import { safeWriteAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "../core/pipeline-ui";
import {
  expectedFromCurrent,
  matchCommitExpectation,
  strictCommitMeta,
} from "../core/session-state";
import type { MetaCommitExpectation } from "../core/session-state";
import type { ReliableMetaCommitResult } from "../types";
import { clearDecisionDeadline, clearDecisionTimer } from "../core/decision-menu-runtime";
import { clearStageWatchdog } from "../core/stage-watchdog";
import { isAuthorizationValid } from "../core/design-review/state";
import { designReviewAuthorisationGate } from "../core/design-review/authorization";
import type { RuntimeCtx } from "../core/runtime-ctx";
import { resolveCurrentDocOption } from "../core/doc-discovery";
// 213 Phase 2 (D14/D5/D13): the shared execution units — one doc menu shell,
// one new-pipeline runner, one resume-branch runner, one stage-eligibility
// source. The resume skeleton must NOT re-implement any of them.
import {
  promptDocSelection,
  resumePipeline,
  startNewPipeline,
  getSpecEligibleStages,
} from "./pipeline-start";

/** The lifecycle states that get a `/pipeline-resume` skeleton menu (D5/D4/D6). */
export type ResumeMenuKind = "aborted" | "running" | "identity-incomplete";

/** What a skeleton selection means (the ONLY four exits). */
export type ResumeMenuIntent =
  | { kind: "continue-current" } // running: zero writes (D4 — the ONE reading)
  | { kind: "restore-current-stage" } // aborted: write meta via resumePipeline (D5)
  | { kind: "recreate-with-selection" } // stage/doc selection then new pipeline (D13)
  | { kind: "cancel" }; // nothing, ever

/** Built menu: option labels and the intent each index resolves to. */
export interface ResumeMenu {
  title: string;
  options: string[];
  intents: ResumeMenuIntent[];
}

/** Result of a menu branch: `changed` is true only when meta actually moved. */
export interface ResumeBranchResult {
  changed: boolean;
  message: string;
  pipelineId?: string;
}

/**
 * Minimal structural view of the `/pipeline-resume` extension context (the pi
 * SDK ctx arrives untyped here; only these members are consumed — the same
 * fail-closed declaration style as `DocMenuCtx` in pipeline-start.ts).
 */
export interface ResumeExecContext {
  session: {
    getMeta(): SessionMeta | undefined;
    updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
    updateMetaVerified?(
      patch: Partial<SessionMeta>,
      expected: MetaCommitExpectation,
    ): ReliableMetaCommitResult;
  };
  ui?: {
    notify?: (message: string) => void;
    setStatus?: (key: string, text: string | undefined) => void;
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    input?: (message: string) => Promise<string | undefined>;
  };
  /** Host-declared capability (213 D18) — read by `hasInteractiveUI` only. */
  hasUI?: boolean | (() => boolean);
  /** Raw SDK context (authorisation gate role detection). */
  _ctx?: unknown;
}

/** Everything the executors need, assembled once by the command dispatch. */
export interface ResumeMenuDeps {
  ctx: ResumeExecContext;
  config: PipelineConfig;
  ui: ReturnType<typeof createPipelineUI>;
  meta: SessionMeta;
  forwardArgs?: string;
}

/** The single confirmation label for the destructive branch (Cancel is fixed). */
export const NEW_PIPELINE_CONFIRM_OPTION = "Discard and start a new pipeline";

// ─── Menu construction (pure) ─────────────────────────────────────────────────

/**
 * Build the per-state skeleton. `currentDocRel` is the CALLER's resolved view
 * of `meta.requirementDoc` (posix project-relative, or `undefined` when the
 * recorded doc is empty/unreadable — rule ①): the default row then degrades to
 * the documented `(no default document)` label and execution enters the doc
 * menu instead (213 Phase 3, plan task 1 last paragraph).
 */
export function buildResumeMenu(
  kind: ResumeMenuKind,
  meta: SessionMeta,
  currentDocRel?: string,
): ResumeMenu {
  const stage = meta.currentStage;
  switch (kind) {
    case "aborted": {
      const first = currentDocRel !== undefined
        ? `Restore stage "${stage}" with "${currentDocRel}" (default)`
        : `Restore stage "${stage}" (no default document)`;
      return {
        title: `Pipeline aborted at "${stage}" — choose how to resume:`,
        options: [first, "Start a new pipeline at a chosen stage…", "Cancel"],
        intents: [{ kind: "restore-current-stage" }, { kind: "recreate-with-selection" }, { kind: "cancel" }],
      };
    }
    case "running": {
      return {
        title: `Pipeline is running at "${stage}" — choose an action:`,
        options: [
          `Continue current stage "${stage}" (default)`,
          "Start a new pipeline at a chosen stage…",
          "Cancel",
        ],
        intents: [{ kind: "continue-current" }, { kind: "recreate-with-selection" }, { kind: "cancel" }],
      };
    }
    case "identity-incomplete": {
      const first = currentDocRel !== undefined
        ? `Rebuild from "${stage}" with "${currentDocRel}" (default)`
        : `Rebuild from "${stage}" (no default document)`;
      return {
        title: `Design-review identity incomplete at "${stage}" — choose how to rebuild:`,
        options: [first, "Choose another stage or document…", "Cancel"],
        // BOTH forward rows recreate; the executor tells the pinned default
        // (index 0) from the browse path (index 1) by position, never by label.
        intents: [{ kind: "recreate-with-selection" }, { kind: "recreate-with-selection" }, { kind: "cancel" }],
      };
    }
  }
}

/**
 * Resolve a host-dialog selection to its intent BY INDEX (the doc-menu lesson,
 * D14: labels with suffixes are display text, not keys). `undefined` (Esc /
 * no control answered) and any unknown label both resolve to `cancel` — the
 * only fail-safe reading.
 */
export function resolveResumeMenuIntent(
  menu: Pick<ResumeMenu, "options" | "intents">,
  selection: string | undefined,
): ResumeMenuIntent {
  const cancel: ResumeMenuIntent = { kind: "cancel" };
  if (selection === undefined) return cancel;
  const idx = menu.options.indexOf(selection);
  if (idx < 0 || idx >= menu.intents.length) return cancel;
  return menu.intents[idx]!;
}

/** The read-only running status sentence — byte-identical to the pre-213 text
 *  (pipeline-resume.ts:240), reused verbatim by `continue-current` (D4). */
export function runningStatusMessage(meta: SessionMeta): string {
  return (
    `Pipeline is running (pipelineId: ${meta.pipelineId}, stage: ${meta.currentStage}, ` +
    `flowState: ${getFlowState(meta)}). No resume needed.`
  );
}

// ─── No-UI honest exit ────────────────────────────────────────────────────────

/**
 * The one honest sentence + audit for a state that NEEDS a menu the session
 * cannot present (D18 gate, new code: the second and last capability call site
 * of 213). The frozen channel keeps its own 208 `no-menu` attribution and is
 * NOT rerouted through here.
 */
export async function noUiExit(
  deps: ResumeMenuDeps,
  branch: ResumeMenuKind,
): Promise<ResumeBranchResult> {
  const { ctx, ui, meta } = deps;
  await safeWriteAuditLog("resume_skipped_no_menu", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    reason: "no_ui",
    branch,
  });
  const message =
    "No interactive UI in this session — /pipeline-resume cannot present a menu here. " +
    "Run it from an interactive session, or use /pipeline-start to begin a new run.";
  ui.notify(ctx, message);
  return { changed: false, message };
}

// ─── Executors (destructive actions live in exactly ONE place) ───────────────

/**
 * Fact-based discard sentence (D13): only what genuinely exists is named —
 * a PENDING decision, a VALID authorization (round), nonzero loop counters.
 * Nothing invented, nothing verbatim-copied from a template that lies.
 */
export function buildDiscardSentence(meta: SessionMeta): string {
  const dr = meta.designReview;
  const facts: string[] = [];
  if (dr?.decision && dr.decision.state === "pending") {
    facts.push(`the pending human decision (${dr.decision.decisionId})`);
  }
  if (dr && isAuthorizationValid(dr)) {
    facts.push(`the design-review authorization (round ${dr.round})`);
  }
  if ((meta.loopCount ?? 0) > 0) {
    facts.push(`loop counters (cycle ${meta.loopCount})`);
  }
  const what = facts.length > 0 ? facts.join(" / ") : "the current pipeline run state";
  return `This will discard ${what}. Continue?`;
}

/** Options for a `runNewPipelineBranch` invocation. */
export interface NewPipelineBranchOptions {
  /** Pinned start stage (identity-incomplete default row) — no stage menu. */
  startStage?: PipelineStage;
  /** Pinned requirement doc (resolved rel path) — no doc menu. */
  requirementDoc?: string;
}

/**
 * D13/D13-a — the new-pipeline branch, fixed order:
 *
 *  1. stage + doc selection when not pinned (shared single sources:
 *     `getSpecEligibleStages` and `promptDocSelection` with the meta doc as
 *     the `(default)` row). Any cancel ⇒ `{ changed: false }`, zero writes.
 *  2. ONE explicit confirmation naming what is genuinely discarded.
 *  3. snapshot anchors (`oldPipelineId` + expectation) BEFORE any write —
 *     `startNewPipeline` rewrites `existingMeta` in place, so reading
 *     `meta.pipelineId` afterwards would name the NEW pipeline.
 *  4. compare-before-write (pure read, zero side effects): drift ⇒ honest
 *     "nothing was started" + `resume_new_pipeline_stale`, NO timers touched.
 *  5. `startNewPipeline` (the existing normal path; it owns its own error
 *     audit). Failure ⇒ return its error WITHOUT clearing or attesting.
 *  6. identity self-check: `getMeta().pipelineId !== started.pipelineId` ⇒
 *     the switch never landed ⇒ `decision_superseded_unverified`
 *     (reason `local_switch_failed`), NO timer cleanup (the OLD pipeline is
 *     still current — clearing its clocks would corrupt a live pipeline),
 *     NO supersede audit.
 *  7. post-write strict verification under the NEW identity (empty patch +
 *     expectation read back from fresh meta).
 *  8. old-chain timer cleanup (always at this point): decision reopen timer +
 *     decision-wait deadline + stage watchdog, keyed by `oldPipelineId`.
 *  9. supersede audit ONLY when step 7 said `persisted`.
 * 10. honest message: plain / "could not be verified: <reason>" /
 *     "could not be applied: local_switch_failed".
 */
export async function runNewPipelineBranch(
  deps: ResumeMenuDeps,
  opts?: NewPipelineBranchOptions,
): Promise<ResumeBranchResult> {
  const { ctx, config, ui, meta, forwardArgs } = deps;
  const select = ctx.ui?.select;
  // Fail closed on a missing control (declared-hasUI hosts without select).
  if (!select) {
    return noUiExit(deps, "running");
  }

  // ── Step 1: stage selection when needed (D13/D14 single source) ──
  let startStage = opts?.startStage;
  if (startStage === undefined) {
    const eligible = getSpecEligibleStages(config);
    if (eligible.length === 0) {
      const message = "No enabled stages available to start a new pipeline. Nothing was changed.";
      ui.notify(ctx, message);
      return { changed: false, message };
    }
    const stageOptions: string[] = [...eligible, "Cancel"];
    const stageChoice = await select("Start the new pipeline at which stage:", stageOptions);
    if (stageChoice === undefined || stageChoice === "Cancel") {
      return { changed: false, message: "Resume cancelled. Nothing was started." };
    }
    // Index mapping (the doc-menu lesson, D14): resolve by POSITION, never by
    // casting a display label back to `PipelineStage`.
    const idx = stageOptions.indexOf(stageChoice);
    if (idx < 0 || idx >= eligible.length) {
      return { changed: false, message: "Resume cancelled. Nothing was started." };
    }
    startStage = eligible[idx]!;
  }

  // ── Step 1 (doc): shared doc menu, meta's doc as the (default) row ──
  let doc = opts?.requirementDoc;
  if (doc === undefined) {
    const chosen = await promptDocSelection(ctx, config, ui, startStage, "resume_new", meta.requirementDoc);
    if (chosen === null) {
      return { changed: false, message: "Resume cancelled. Nothing was started." };
    }
    doc = chosen;
  }

  // ── Step 2: ONE explicit confirmation ──
  const confirmTitle = buildDiscardSentence(meta);
  const confirmation = await select(confirmTitle, [NEW_PIPELINE_CONFIRM_OPTION, "Cancel"]);
  if (confirmation !== NEW_PIPELINE_CONFIRM_OPTION) {
    return { changed: false, message: "New pipeline declined. Nothing was changed." };
  }

  // ── Step 3: snapshot anchors BEFORE any write (in-place meta lesson) ──
  // `startNewPipeline` merges into `existingMeta` IN PLACE, so every fact the
  // supersede attestation must name is captured here — reading them after the
  // write would testify to the NEW pipeline's state.
  const oldPipelineId = meta.pipelineId;
  const expectation = expectedFromCurrent(meta);
  const pendingDecisionId =
    meta.designReview?.decision && meta.designReview.decision.state === "pending"
      ? meta.designReview.decision.decisionId
      : undefined;

  // ── Step 4: compare-before-write — pure read, zero side effects ──
  const current = ctx.session.getMeta() ?? meta;
  const drift = matchCommitExpectation(current, expectation);
  if (drift !== null) {
    await safeWriteAuditLog("resume_new_pipeline_stale", {
      pipelineId: meta.pipelineId,
      reason: drift,
    }, "warn");
    return {
      changed: false,
      message:
        `Pipeline changed since the menu opened (${drift}); nothing was started. ` +
        `Run /pipeline-resume again.`,
    };
  }

  // ── Step 5: the existing normal start path (owns its own error audit) ──
  const started = await startNewPipeline(ctx, config, ui, doc, startStage, meta, forwardArgs || undefined);
  if (!started.success || !started.pipelineId) {
    // No clearing, no supersede audit: the takeover never happened, and an
    // audit would testify to a fact that does not exist.
    return { changed: false, message: started.error ?? "New pipeline failed. Nothing was started." };
  }

  // ── Step 6: identity self-check (did the switch actually land?) ──
  const fresh = ctx.session.getMeta();
  if (fresh?.pipelineId !== started.pipelineId) {
    await safeWriteAuditLog("decision_superseded_unverified", {
      newPipelineId: started.pipelineId,
      reason: "local_switch_failed",
    }, "error");
    // The OLD pipeline is still the current one — its timers must NOT be
    // cleared (D13-a forbids corrupting a live chain).
    return {
      changed: true,
      pipelineId: started.pipelineId,
      message:
        `${started.message ?? ""} (new pipeline identity could not be applied: local_switch_failed)`,
    };
  }

  // ── Step 7: strict verification under the NEW identity ──
  const verified: ReliableMetaCommitResult = strictCommitMeta(
    ctx.session,
    {},
    expectedFromCurrent(fresh),
  );

  // ── Step 8: old-chain timer cleanup (keyed by the OLD id, idempotent) ──
  // D13-a: same-source with restart (`flow-state` clears the three together).
  // Safe against the new pipeline because every timer guards on pipelineId.
  if (oldPipelineId !== undefined) {
    clearDecisionTimer(oldPipelineId);
    clearDecisionDeadline(oldPipelineId);
    clearStageWatchdog(oldPipelineId);
  }

  // ── Step 9: supersede audit ONLY when persisted ──
  if (verified.status === "persisted") {
    await safeWriteAuditLog("decision_superseded_by_new_pipeline", {
      pipelineId: oldPipelineId,
      newPipelineId: started.pipelineId,
      stage: startStage,
      requirementDoc: doc,
      ...(pendingDecisionId !== undefined ? { decisionId: pendingDecisionId } : {}),
    });
    return { changed: true, pipelineId: started.pipelineId, message: started.message ?? "New pipeline started." };
  }

  await safeWriteAuditLog("decision_superseded_unverified", {
    newPipelineId: started.pipelineId,
    reason: verified.reason,
  }, "error");
  return {
    changed: true,
    pipelineId: started.pipelineId,
    message:
      `${started.message ?? ""} (new pipeline identity could not be verified: ${verified.reason})`,
  };
}

/**
 * D5 — aborted in-place restore:
 *  1. outside `RESUMABLE_STAGES` (e.g. `completed`) ⇒ degrade to the
 *     new-pipeline skeleton (same judgment as /pipeline-start's resumable
 *     matrix — no second rule here).
 *  2. design-review without a VALID authorization ⇒ the SAME authorisation
 *     gate as choose_stage; refusal ⇒ ZERO state change; grant ⇒ strict
 *     commit of the new state (same anchored write as the choose_stage path).
 *  3. `resumePipeline` (the shared execution unit: keeps pipelineId/stage/doc,
 *     clears `terminateReason`, arms the watchdog, audits
 *     `pipeline_resumed(reason=resume_menu_restore)`).
 *  4. a VALID authorization is KEPT (this is the same loop continuing, not a
 *     re-entry — buildResumeMeta already preserves `designReview`).
 */
export async function runRestoreBranch(deps: ResumeMenuDeps): Promise<ResumeBranchResult> {
  const { ctx, config, ui, meta, forwardArgs } = deps;

  if (!RESUMABLE_STAGES.includes(meta.currentStage)) {
    return runNewPipelineBranch(deps);
  }

  if (meta.currentStage === "design-review" && (!meta.designReview || !isAuthorizationValid(meta.designReview))) {
    // SAFETY: the authorisation gate consumes ONLY the role-detection surface
    // (`_ctx`/`ui`/`session`), the same subset flow-state.ts's choose_stage
    // path passes through its `buildRoleCtxForGate` cast.
    const gateCtx = {
      _ctx: ctx._ctx,
      ui: ctx.ui,
      session: ctx.session,
    } as unknown as RuntimeCtx;
    const gateResult = await designReviewAuthorisationGate(gateCtx, config, meta);
    if (!gateResult.ok) {
      return {
        changed: false,
        message: `Cannot restore design-review: ${gateResult.reason}. Nothing was changed.`,
      };
    }
    const authCommit = strictCommitMeta(
      ctx.session,
      { designReview: gateResult.state, designReviewRecheck: undefined },
      expectedFromCurrent(meta),
    );
    if (authCommit.status !== "persisted") {
      await safeWriteAuditLog("design_review_authorisation", {
        pipelineId: meta.pipelineId,
        action: "gate_commit_failed",
        status: authCommit.status,
        reason: authCommit.reason,
        authorizationId: gateResult.state.authorizationId,
        source: "resume_menu_restore",
      }, "error");
      return {
        changed: false,
        message:
          `Design-review authorization commit failed: ${authCommit.status} (${authCommit.reason}). ` +
          `Nothing was resumed; no authorization was persisted.`,
      };
    }
  }

  const resumed = await resumePipeline(
    ctx,
    meta,
    config,
    ui,
    meta.requirementDoc ?? "",
    "resume_menu_restore",
    forwardArgs || undefined,
  );
  return {
    changed: true,
    pipelineId: resumed.pipelineId,
    message: resumed.message ?? `Pipeline resumed at stage "${meta.currentStage}".`,
  };
}

/** True when the recorded doc resolves to a readable file (rule ① preview). */
async function resolveCurrentDocRelPath(
  config: PipelineConfig,
  rawDoc: string | undefined,
): Promise<string | undefined> {
  const resolved: { relPath: string; absPath: string } | null = await resolveCurrentDocOption(config, rawDoc);
  return resolved?.relPath;
}

/**
 * Present one skeleton and dispatch its intent. The command has ALREADY
 * decided `menuCapable` once (D18); this function still fails closed through
 * the truthiness guard when the control is absent anyway.
 */
export async function runResumeSkeleton(
  deps: ResumeMenuDeps,
  kind: ResumeMenuKind,
): Promise<ResumeBranchResult> {
  const { ctx, config, ui, meta } = deps;
  const select = ctx.ui?.select;
  if (!select) {
    return noUiExit(deps, kind);
  }

  // The default row only claims a doc when it genuinely resolves (rule ①).
  const currentDocRel = await resolveCurrentDocRelPath(config, meta.requirementDoc);
  const menu = buildResumeMenu(kind, meta, currentDocRel);
  const selection = await select(menu.title, menu.options);
  const idx = selection === undefined ? -1 : menu.options.indexOf(selection);
  const intent = resolveResumeMenuIntent(menu, selection);

  switch (intent.kind) {
    case "continue-current": {
      // D4 zero writes — the ONE reading: status bar + the verbatim running
      // sentence, no updateMeta / no dispatch / no audit.
      const message = runningStatusMessage(meta);
      ui.notify(ctx, message);
      return { changed: false, message };
    }
    case "restore-current-stage": {
      return runRestoreBranch(deps);
    }
    case "recreate-with-selection": {
      if (kind === "identity-incomplete" && idx === 0) {
        // Pinned default row: rebuild from the SAME stage; the doc enters the
        // shared menu only when it does not resolve (degraded label).
        return runNewPipelineBranch(deps, {
          startStage: meta.currentStage,
          ...(currentDocRel !== undefined ? { requirementDoc: currentDocRel } : {}),
        });
      }
      if (kind === "aborted" && idx === 0) {
        // Unreachable today (aborted index 0 is restore) — defensive symmetry.
        return runRestoreBranch(deps);
      }
      return runNewPipelineBranch(deps);
    }
    case "cancel": {
      const message =
        `Resume cancelled. Pipeline "${meta.pipelineId}" remains at "${meta.currentStage}" ` +
        `(flowState: ${getFlowState(meta)}).`;
      return { changed: false, message };
    }
  }
}
