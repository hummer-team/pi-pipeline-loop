/**
 * 213 Phase 3: `runNewPipelineBranch` — the ONE destructive path (D13/D13-a)
 * and `buildDiscardSentence` (fact-based confirmation copy).
 *
 * Locked semantics (plan P3 unit targets):
 * - confirmation text names ONLY facts that genuinely exist (pending decision,
 *   valid authorization, nonzero loop counters);
 * - every cancel point (stage menu / doc menu / confirmation) is ZERO-write;
 * - compare-before-write drift ⇒ `resume_new_pipeline_stale` + "nothing was
 *   started" with ZERO side effects — timers of the old chain untouched, no
 *   supersede attestation;
 * - `startNewPipeline` failure ⇒ no timer cleanup and NO supersede audit (an
 *   audit would testify to a fact that does not exist);
 * - step 6 `local_switch_failed` ⇒ `decision_superseded_unverified` (error),
 *   NO timer cleanup (the OLD pipeline is still live), NO supersede audit;
 * - step 7 strict verify not `persisted` ⇒ `decision_superseded_unverified`
 *   with the store reason, timers ARE cleared (the switch landed), NO supersede
 *   audit and the message says "could not be verified";
 * - the happy path ⇒ new pipelineId, the OLD chain's THREE timers cleared
 *   (reopen retry + decision deadline + stage watchdog), exactly ONE
 *   `decision_superseded_by_new_pipeline` whose payload names the OLD id and
 *   the decision id captured BEFORE the in-place write (the meta-alteration
 *   lesson), and D11: the automatic-presentation budget never appears.
 *
 * The session harness mutates the SAME meta object in place (like the real
 * adapter), so the step-3 snapshot protection is a REAL test: reading
 * `meta.pipelineId` after `startNewPipeline` would name the NEW pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type {
  DesignReviewState,
  PipelineConfig,
  ReliableMetaCommitResult,
  SessionMeta,
} from "../../types";
import type { HumanDecision } from "../../core/design-review/decision-types";
import type { MetaCommitExpectation } from "../../core/session-state";
import { matchCommitExpectation } from "../../core/session-state";
import {
  armDecisionDeadline,
  armWatchdogTimers,
  clearAllDecisionTimers,
  __hasDecisionDeadline,
  __hasDecisionTimer,
  __hasStageWatchdog,
} from "../../core/decision-menu-runtime";
import type { DecisionMenuRuntimeDeps } from "../../core/decision-menu-runtime";
import { scheduleDecisionRetry } from "../../core/flow-state";
import type { FlowStateCtx } from "../../core/flow-state";
import { createPipelineUI } from "../../core/pipeline-ui";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import {
  buildDiscardSentence,
  NEW_PIPELINE_CONFIRM_OPTION,
  runNewPipelineBranch,
  type ResumeExecContext,
  type ResumeMenuDeps,
} from "../../commands/pipeline-resume-menu";
import { makeTestConfig, makeTestMeta } from "../helpers";

// ─── audit capture ───────────────────────────────────────────────────────────

interface AuditRec {
  event: string;
  message: Record<string, string | boolean>;
  level: string | undefined;
}

let audits: AuditRec[] = [];

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message: (message ?? {}) as Record<string, string | boolean>, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  // Every armed clock (retry / deadline / watchdog pair, old or new id) dies here.
  clearAllDecisionTimers();
});

// ─── harness ─────────────────────────────────────────────────────────────────

interface MenuCall {
  title: string;
  options: string[];
}

interface BranchHarness {
  deps: ResumeMenuDeps;
  calls: MenuCall[];
  /** Applied patches in order (length is the write counter). */
  updates: Array<Partial<SessionMeta>>;
  notifications: string[];
  /** The session's LIVE meta — the SAME object identity as `deps.meta`. */
  readonly current: () => SessionMeta;
}

interface HarnessOptions {
  /** If set, every `getMeta()` returns THIS object instead of the live meta
   *  (the compare-before-write drift injection). */
  readonly readAs?: SessionMeta;
  /** If true, `pipelineId` patches are dropped (simulated local switch failure). */
  readonly dropPipelineId?: boolean;
  /** If set, `updateMetaVerified` reports this conflict reason instead of persisting. */
  readonly verifyConflict?: string;
}

/**
 * A minimal strict-capable execution context. Answers the dialogs from a
 * queue (`undefined` once exhausted ⇒ Esc). `updateMeta`/`updateMetaVerified`
 * mutate the SAME meta object IN PLACE — the real adapter merges, so a
 * regression that reads anchors after the write must actually see the NEW
 * values here (unlike a copy-on-write fixture, which would hide the bug).
 */
function makeBranchHarness(
  meta: SessionMeta,
  config: PipelineConfig,
  answers: Array<string | undefined> = [],
  opts: HarnessOptions = {},
): BranchHarness {
  const calls: MenuCall[] = [];
  const updates: Array<Partial<SessionMeta>> = [];
  const notifications: string[] = [];
  let idx = 0;

  const session = {
    getMeta: (): SessionMeta => opts.readAs ?? meta,
    updateMeta: (patch: Partial<SessionMeta>): SessionMeta => {
      const applied: Partial<SessionMeta> = opts.dropPipelineId
        ? (({ pipelineId: _dropped, ...rest }) => ({ ...rest }))(patch)
        : patch;
      Object.assign(meta, applied);
      updates.push({ ...applied });
      return meta;
    },
    updateMetaVerified: (
      patch: Partial<SessionMeta>,
      expected: MetaCommitExpectation,
    ): ReliableMetaCommitResult => {
      if (opts.verifyConflict !== undefined) {
        return { status: "conflict", reason: opts.verifyConflict };
      }
      // Same production comparison as `makeStrictSession` (healthy store).
      const conflict = matchCommitExpectation(meta, expected);
      if (conflict) return { status: "conflict", reason: conflict };
      Object.assign(meta, patch);
      updates.push({ ...patch });
      return { status: "persisted", meta };
    },
  };

  const ctx: ResumeExecContext = {
    session,
    ui: {
      notify: (msg: string) => { notifications.push(msg); },
      setStatus: () => {},
      select: async (title: string, options: string[]) => {
        calls.push({ title, options: [...options] });
        const answer = idx < answers.length ? answers[idx] : undefined;
        idx++;
        return answer;
      },
    },
    _ctx: { sessionManager: { getSessionFile: () => undefined } },
  };

  return {
    deps: { ctx, config, ui: createPipelineUI(config), meta },
    calls,
    updates,
    notifications,
    current: () => meta,
  };
}

/** Temp project root; `withWatchdog` mirrors hosts that run the stage clocks. */
function makeTmpConfig(opts?: { watchdog?: boolean }): { config: PipelineConfig; root: string } {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-213-newbranch-"));
  const config = makeTestConfig({ projectRoot: root });
  // `makeTestConfig` stage entries carry no `verify.require`, so
  // `checkVerifyFiles` passes with an empty missing list — no scaffold needed.
  if (opts?.watchdog) {
    return {
      config: { ...config, watchdog: { enabled: true, stageTimeoutMs: 600_000, stageIdleTimeoutMs: 300_000 } },
      root,
    };
  }
  return { config, root };
}

function writeDoc(root: string, rel: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "# 213 new-branch requirement\n", "utf-8");
}

/**
 * Arm the OLD chain's three timers directly on the runtime registry
 * (`armWatchdogTimers` bypasses the frozen/dormant guards that legitimately
 * suppress the watchdog on a live freeze — the branch cleanup must clear all
 * three regardless of who armed them). Long delays ⇒ nothing fires mid-test;
 * `afterEach` clears every clock.
 */
function armOldChain(h: BranchHarness, config: PipelineConfig): string {
  const pipelineId = h.deps.meta.pipelineId!;
  // Decision reopen backoff (attempt 1 = 5s — never fires within the test).
  scheduleDecisionRetry(h.deps.ctx as unknown as FlowStateCtx, h.deps.meta, config, 1);
  // Human decision-wait deadline (1h).
  const deadlineDeps: DecisionMenuRuntimeDeps = {
    readMeta: () => h.deps.meta,
    isFrozen: () => false,
    present: async () => ({ outcome: "cancelled", applied: false }),
  };
  armDecisionDeadline(deadlineDeps, pipelineId, 3_600_000);
  // Stage watchdog pair under a distinct visit key.
  armWatchdogTimers(pipelineId, {
    stageKey: `${pipelineId}:manual-visit`,
    wallDelayMs: 600_000,
    idleDelayMs: 300_000,
    onTimeout: () => {},
  });
  return pipelineId;
}

function expectAllArmed(pipelineId: string): void {
  expect(__hasDecisionTimer(pipelineId)).toBe(true);
  expect(__hasDecisionDeadline(pipelineId)).toBe(true);
  expect(__hasStageWatchdog(pipelineId)).toBe(true);
}

function expectAllCleared(pipelineId: string): void {
  expect(__hasDecisionTimer(pipelineId)).toBe(false);
  expect(__hasDecisionDeadline(pipelineId)).toBe(false);
  expect(__hasStageWatchdog(pipelineId)).toBe(false);
}

/** Valid-auth loop with a PENDING human decision + a nonzero cycle counter. */
function factsMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  const designReview: DesignReviewState = {
    schemaVersion: 1,
    planDoc: "/tmp/213-branch-plan.md",
    planHash: "ph",
    round: 3,
    authorizationId: "auth-213-branch",
    authorizationSource: "menu",
    phase: "review_running",
    authorizedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    decision: {
      state: "pending",
      decisionId: "dec-213-branch",
    } as unknown as HumanDecision,
  };
  return makeTestMeta({
    currentStage: "design-review",
    pipelineId: "pipe-213-branch",
    loopCount: 2,
    designReview,
    ...overrides,
  });
}

// ─── buildDiscardSentence ────────────────────────────────────────────────────

describe("213 P3: buildDiscardSentence names only real facts", () => {
  it("no pending decision, no authorization, no counters ⇒ one generic honest phrase", () => {
    const meta = makeTestMeta({ pipelineId: "pipe-213-bare" });
    expect(buildDiscardSentence(meta)).toBe(
      "This will discard the current pipeline run state. Continue?",
    );
  });

  it("pending decision + valid authorization + loop counters are ALL named with their identifiers", () => {
    const sentence = buildDiscardSentence(factsMeta());
    expect(sentence).toContain("the pending human decision (dec-213-branch)");
    expect(sentence).toContain("the design-review authorization (round 3)");
    expect(sentence).toContain("loop counters (cycle 2)");
    expect(sentence.startsWith("This will discard ")).toBe(true);
    expect(sentence.endsWith(". Continue?")).toBe(true);
  });

  it("a TERMINAL decision is not claimed as pending and an absent loop count is not invented", () => {
    const meta = makeTestMeta({
      pipelineId: "pipe-213-terminal",
      designReview: {
        schemaVersion: 1,
        planDoc: "/tmp/p.md",
        planHash: "ph",
        round: 1,
        authorizationId: "auth-x",
        authorizationSource: "menu",
        phase: "finished", // terminal ⇒ authorization invalid too
        authorizedAt: 1,
        updatedAt: 2,
        decision: { state: "chosen", decisionId: "dec-old" } as unknown as HumanDecision,
      },
    });
    const sentence = buildDiscardSentence(meta);
    expect(sentence).not.toContain("dec-old");
    expect(sentence).not.toContain("authorization");
    expect(sentence).toBe("This will discard the current pipeline run state. Continue?");
  });
});

// ─── runNewPipelineBranch ────────────────────────────────────────────────────

describe("213 P3: runNewPipelineBranch (D13/D13-a)", () => {
  it("stage-menu cancel ⇒ zero writes, honest cancellation sentence", async () => {
    const { config } = makeTmpConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-213-stage-cancel" });
    const h = makeBranchHarness(meta, config, [undefined]);

    const r = await runNewPipelineBranch(h.deps);
    expect(r.changed).toBe(false);
    expect(r.message).toBe("Resume cancelled. Nothing was started.");
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.title).toBe("Start the new pipeline at which stage:");
    // The stage menu keeps Cancel last and offers ONLY enabled stages.
    expect(h.calls[0]!.options[h.calls[0]!.options.length - 1]).toBe("Cancel");
    expect(h.updates.length).toBe(0);
    expect(audits.filter((a) => a.event === "decision_superseded_by_new_pipeline").length).toBe(0);
  });

  it("doc-menu cancel after a stage pick ⇒ zero writes; the recorded doc shows as the (default) row", async () => {
    const { config, root } = makeTmpConfig();
    await initAuditLog(config);
    writeDoc(root, "docs/design/213_Req.md");
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-213-doc-cancel",
      requirementDoc: "docs/design/213_Req.md",
    });
    const h = makeBranchHarness(meta, config, ["plan", undefined]);

    const r = await runNewPipelineBranch(h.deps);
    expect(r.changed).toBe(false);
    expect(r.message).toBe("Resume cancelled. Nothing was started.");
    expect(h.calls[1]!.title).toContain('Select document for the "plan" stage');
    // P2 D14 contract: meta's doc pinned FIRST with the ` (default)` suffix.
    expect(h.calls[1]!.options[0]).toBe("docs/design/213_Req.md (default)");
    expect(h.updates.length).toBe(0);
  });

  it("confirmation carries EXACTLY the fact sentence; declining it writes nothing", async () => {
    const { config, root } = makeTmpConfig();
    await initAuditLog(config);
    writeDoc(root, "docs/design/213_Req.md");
    const meta = factsMeta({ pipelineId: "pipe-213-confirm-decline" });
    // Pinned stage + doc ⇒ the ONLY dialog is the one explicit confirmation.
    const h = makeBranchHarness(meta, config, ["Cancel"]);

    const r = await runNewPipelineBranch(h.deps, {
      startStage: "plan",
      requirementDoc: "docs/design/213_Req.md",
    });
    expect(r.changed).toBe(false);
    expect(r.message).toBe("New pipeline declined. Nothing was changed.");
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.title).toBe(buildDiscardSentence(meta));
    expect(h.calls[0]!.options).toEqual([NEW_PIPELINE_CONFIRM_OPTION, "Cancel"]);
    expect(h.updates.length).toBe(0);
    expect(audits.some((a) => a.event.startsWith("decision_superseded"))).toBe(false);
  });

  it("compare-before-write drift ⇒ stale audit + \"nothing was started\", old chain untouched", async () => {
    const { config, root } = makeTmpConfig();
    await initAuditLog(config);
    writeDoc(root, "docs/design/213_Req.md");
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-213-drift" });
    // The host sees a DIFFERENT meta than the menu opened with (external change).
    const drifted = { ...meta, pipelineId: "pipe-213-drifted-by-another-entry" };
    const h = makeBranchHarness(meta, config, [NEW_PIPELINE_CONFIRM_OPTION], { readAs: drifted });
    const oldId = armOldChain(h, config);
    expectAllArmed(oldId);

    const r = await runNewPipelineBranch(h.deps, {
      startStage: "plan",
      requirementDoc: "docs/design/213_Req.md",
    });
    expect(r.changed).toBe(false);
    expect(r.message).toContain("nothing was started");
    expect(r.message).toContain("Run /pipeline-resume again");

    const stale = audits.find((a) => a.event === "resume_new_pipeline_stale");
    expect(stale).toBeDefined();
    expect(String(stale?.message?.["reason"])).toContain("pipeline_mismatch");

    // ZERO side effects: no writes, no clearing, no supersede attestation.
    expect(h.updates.length).toBe(0);
    expectAllArmed(oldId);
    expect(audits.some((a) => a.event.startsWith("decision_superseded"))).toBe(false);
  });

  it("startNewPipeline failure ⇒ its own error surfaces, NO clearing, NO supersede audit", async () => {
    const { config } = makeTmpConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-213-startfail" });
    const h = makeBranchHarness(meta, config, [NEW_PIPELINE_CONFIRM_OPTION]);
    const oldId = armOldChain(h, config);

    // Pinned but UNREADABLE doc — startNewPipeline's own Step 1 fails before
    // ANY meta write.
    const r = await runNewPipelineBranch(h.deps, {
      startStage: "plan",
      requirementDoc: "docs/design/213_Does_Not_Exist.md",
    });
    expect(r.changed).toBe(false);
    expect(r.message).toContain("File not found");

    // The takeover never happened — the old chain's clocks must keep running.
    expectAllArmed(oldId);
    expect(audits.some((a) => a.event.startsWith("decision_superseded"))).toBe(false);
    expect(h.updates.length).toBe(0);
  });

  it("step 6 local_switch_failed ⇒ unverified(error) audit, NO timer cleanup, NO supersede", async () => {
    // Watchdog ENABLED: startNewPipeline's own clock visit then re-arms (never
    // clears-by-default) under the still-current OLD identity, so this test
    // measures ONLY what the branch itself did.
    const { config, root } = makeTmpConfig({ watchdog: true });
    await initAuditLog(config);
    writeDoc(root, "docs/design/213_Req.md");
    const meta = factsMeta({ pipelineId: "pipe-213-switchfail" });
    const h = makeBranchHarness(meta, config, [NEW_PIPELINE_CONFIRM_OPTION], { dropPipelineId: true });
    const oldId = armOldChain(h, config);

    const r = await runNewPipelineBranch(h.deps, {
      startStage: "plan",
      requirementDoc: "docs/design/213_Req.md",
    });
    // Per the plan's step-6 contract: the start DID happen (changed:true) but
    // the identity never landed ⇒ honest "could not be applied".
    expect(r.changed).toBe(true);
    expect(r.message).toContain("could not be applied: local_switch_failed");

    const unverified = audits.find((a) => a.event === "decision_superseded_unverified");
    expect(unverified).toBeDefined();
    expect(unverified?.message?.["reason"]).toBe("local_switch_failed");
    expect(unverified?.level).toBe("error");
    expect(audits.some((a) => a.event === "decision_superseded_by_new_pipeline")).toBe(false);

    // The OLD pipeline is still the current one → the branch cleared NOTHING.
    expectAllArmed(oldId);
    expect(h.current().pipelineId).toBe(oldId);
  });

  it("step 7 strict verify conflict ⇒ unverified(reason), timers ARE cleared, NO supersede, honest suffix", async () => {
    const { config, root } = makeTmpConfig();
    await initAuditLog(config);
    writeDoc(root, "docs/design/213_Req.md");
    const meta = factsMeta({ pipelineId: "pipe-213-verifyconflict" });
    const h = makeBranchHarness(meta, config, [NEW_PIPELINE_CONFIRM_OPTION], {
      verifyConflict: "simulated_store_conflict",
    });
    const oldId = armOldChain(h, config);

    const r = await runNewPipelineBranch(h.deps, {
      startStage: "plan",
      requirementDoc: "docs/design/213_Req.md",
    });
    expect(r.changed).toBe(true);
    expect(r.message).toContain("could not be verified: simulated_store_conflict");

    const unverified = audits.find((a) => a.event === "decision_superseded_unverified");
    expect(unverified?.message?.["reason"]).toBe("simulated_store_conflict");
    expect(unverified?.level).toBe("error");
    expect(audits.some((a) => a.event === "decision_superseded_by_new_pipeline")).toBe(false);

    // The switch DID land (step 6 passed), so the dead chain's clocks go.
    expectAllCleared(oldId);
    expect(h.current().pipelineId).not.toBe(oldId);
  });

  it("happy path ⇒ new identity, THREE old-chain timers cleared, ONE supersede audit with pre-write decisionId, D11 budget untouched", async () => {
    const { config, root } = makeTmpConfig();
    await initAuditLog(config);
    writeDoc(root, "docs/design/213_Req.md");
    const meta = factsMeta({ pipelineId: "pipe-213-happy" });
    const h = makeBranchHarness(meta, config, [NEW_PIPELINE_CONFIRM_OPTION]);
    const oldId = armOldChain(h, config);

    const r = await runNewPipelineBranch(h.deps, {
      startStage: "plan",
      requirementDoc: "docs/design/213_Req.md",
    });
    expect(r.changed).toBe(true);
    const newId = r.pipelineId!;
    expect(newId).not.toBe(oldId);
    // The IN-PLACE write happened — reading the anchors now would testify to
    // the NEW pipeline. The supersede payload below proves the branch used the
    // step-3 snapshot instead.
    expect(h.current().pipelineId).toBe(newId);

    expectAllCleared(oldId);

    const supersede = audits.filter((a) => a.event === "decision_superseded_by_new_pipeline");
    expect(supersede.length).toBe(1);
    expect(supersede[0]!.message["pipelineId"]).toBe(oldId); // the OLD id, not the in-place-mutated meta
    expect(supersede[0]!.message["newPipelineId"]).toBe(newId);
    expect(supersede[0]!.message["stage"]).toBe("plan");
    expect(supersede[0]!.message["requirementDoc"]).toBe("docs/design/213_Req.md");
    // meta.designReview was erased by the new-period builder — the decisionId
    // could ONLY come from the pre-write snapshot.
    expect(supersede[0]!.message["decisionId"]).toBe("dec-213-branch");
    expect(audits.some((a) => a.event === "decision_superseded_unverified")).toBe(false);

    // D11: the automatic-presentation budget never appears on the new chain
    // (and the corrupted old identity was never strict-committed).
    const reprompt = (h.current() as { designReviewDecisionReprompt?: unknown }).designReviewDecisionReprompt;
    expect(reprompt).toBeUndefined();
    expect(h.current().designReview).toBeUndefined();
  });

  it("no select control ⇒ the executor fails closed to the no-UI exit (declared capability cannot lie)", async () => {
    const { config } = makeTmpConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-213-noselect-exec" });
    const h = makeBranchHarness(meta, config, []);
    // Truthiness guard: a host that declares capability without handing out a
    // select control must fail closed, not crash.
    h.deps.ctx.ui = { notify: (msg: string) => { h.notifications.push(msg); }, setStatus: () => {} };

    const r = await runNewPipelineBranch(h.deps, {
      startStage: "plan",
      requirementDoc: "docs/design/213_Req.md",
    });
    expect(r.changed).toBe(false);
    expect(r.message).toContain("No interactive UI");
    expect(r.message).toContain("/pipeline-start");
    const skip = audits.find((a) => a.event === "resume_skipped_no_menu");
    expect(skip?.message["reason"]).toBe("no_ui");
    expect(skip?.message["branch"]).toBe("running");
    expect(h.calls.length).toBe(0);
    expect(h.updates.length).toBe(0);
  });

  it("empty eligible stage list ⇒ honest refusal, no dialog, no writes", async () => {
    const { config } = makeTmpConfig();
    await initAuditLog(config);
    const disabledConfig = {
      ...config,
      stages: Object.fromEntries(
        Object.entries(config.stages).map(([k, v]) => [k, { ...v, disabled: true }]),
      ),
    } as PipelineConfig;
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-213-nostages" });
    const h = makeBranchHarness(meta, disabledConfig, []);

    const r = await runNewPipelineBranch(h.deps);
    expect(r.changed).toBe(false);
    expect(r.message).toContain("No enabled stages available");
    expect(r.message).toContain("Nothing was changed");
    expect(h.calls.length).toBe(0);
    expect(h.updates.length).toBe(0);
  });
});
