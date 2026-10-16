/**
 * 200 Bug Phase 5 — end-to-end regression chains for G1 / G2 / G3 + the
 * Phase 4 lazy decision-report re-anchor.
 *
 * Chain A (G1 + G2 + G1-3, REAL executor chain):
 *   Replays the incident shape: the develop executor's run is consumed, the
 *   review executor routes the pipeline to "fix" with reviewConclusion=fail
 *   (child runtime ctx → spawn is ENQUEUED to the idle owner via
 *   pendingSpawns — the bug premise), then the review subagent reaches a
 *   terminal event. With the PRODUCTION composition wired exactly as
 *   index.ts does it (owner-meta accessor → lifecycle bus listeners →
 *   owner-wake deps → wake observer), the terminal must wake the owner
 *   EXACTLY once (dedup on re-emit), the lifecycle registry must record the
 *   terminal (G2), the status bar must refresh at the routing point (G1-3),
 *   and the next owner settle must consume the enqueued fix spawn through
 *   the existing pull-based path.
 *
 * Chain B (G3 + Phase 4, REAL guard + REAL revalidation + REAL presentation):
 *   A live review cycle parks a pending human decision (H1 anchored). The
 *   real tool-guard keeps the bound report READ-ONLY inside the decision
 *   window; a generic paused commit (drift reason) opens Phase 3's scoped
 *   window where the guard permits ONLY the bound reportDoc; the child's
 *   legal edit changes the hash H1→H2; the production revalidation engine
 *   lazily re-anchors the decision to H2 (Phase 4); then the window is
 *   re-armed and the resume-source presentation acts the human choice —
 *   which under the pre-Phase-4 contract would have parked the decision on
 *   report_hash_drift instead of ever releasing to develop.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStageAdvancer } from "../../core/stage-advancer";
import { createPipelineVerify } from "../../tools/pipeline-verify";
import { spawnStageSubagent } from "../../utils/subagent-rpc";
import { createToolGuard } from "../../core/tool-guard";
import {
  registerOwnerWakeObserver,
  setOwnerWakeDeps,
} from "../../core/owner-wake";
import {
  __resetLifecycleRegistry,
  findTerminal,
  setOwnerMetaAccessor,
  wireSubagentLifecycleListeners,
} from "../../utils/subagent-lifecycle-registry";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog, setAuditPipelineContext } from "../../utils/auditLog";
import {
  coordinateDesignReview,
  revalidateHumanDecisionSnapshot,
  type CoordinatorContext,
} from "../../core/design-review/coordinator";
import {
  clearAllHumanDecisionMenus,
  type HumanDecisionSelectFn,
} from "../../core/design-review/human-decision";
import { clearAllDecisionTimers } from "../../core/flow-state";
import {
  computeHash,
  createInitialState,
  deriveReportPath,
} from "../../core/design-review/state";
import {
  isPausedReportEditable,
  isPathWithinWriteScope,
  resolveDesignReviewWritePolicy,
} from "../../core/design-review/write-policy";
import {
  makeStrictSession,
  makeTestConfig,
  makeTestMeta,
} from "../helpers";
import { makeChainHarness } from "./executor-chain-harness";
import type { HumanDecision } from "../../core/design-review/decision-types";
import type { PipelineConfig, SessionMeta } from "../../types";

/** Tool execution helper mirroring the sibling integration suites. */
async function exec(
  tool: { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> },
  args: Record<string, unknown>,
  ctx: unknown,
): Promise<Record<string, any>> {
  return (await tool.execute(args, ctx)) as Record<string, any>;
}

/** Concatenated audit-log text for a project root (200 Bug chain probes). */
function readAudit(projectRoot: string): string {
  const dir = path.join(projectRoot, ".pi", "audit");
  if (!fs.existsSync(dir)) return "";
  const parts: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, entry.name);
      if (entry.isDirectory()) walk(fp);
      else if (entry.name.endsWith("_audit.log")) parts.push(fs.readFileSync(fp, "utf-8"));
    }
  };
  walk(dir);
  return parts.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Chain A — G1 event-driven owner wake + G2 lifecycle registry + G1-3 status
// bar refresh, on the REAL executor chain (only the RPC bus is faked).
// ────────────────────────────────────────────────────────────────────────────

describe("200 Bug Phase 5 chain A: routed fix spawn wakes the idle owner once, registry records terminal, status bar refreshes at routing", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // cleanup best-effort, same idiom as the sibling chain suites
      }
    }
    __resetLifecycleRegistry();
  });

  it("develop consumed → review routes fix → child terminal wakes owner EXACTLY ONCE → owner settle consumes queue and dispatches fix", async () => {
    const h = makeChainHarness();
    cleanups.push(() => h.cleanup());

    // ── Premise: get the pipeline to a FRESH review visit (the state the
    // incident had when the review executor declared fail). driveToDevelop-
    // Handoff runs the full clarify→plan→design-review→develop chain; then
    // the develop executor declares through the real tools, its trusted
    // terminal arrives, and the owner consumes → develop exits to review.
    await h.driveToDevelopHandoff();
    const bound = h.bindChildToCurrentRun();
    expect(bound.recorded).toBe(true);
    h.writeDevelopArtifact();

    const verifyTool = createPipelineVerify(h.config);
    const declared = await exec(verifyTool, {}, h.childToolCtx());
    expect(declared.action).toBe("declared-for-owner");

    h.emitTerminal("completed");
    await h.flush();
    const consumed = await exec(verifyTool, {}, h.ownerToolCtx());
    expect(consumed.passed).toBe(true);
    expect(h.meta().currentStage).toBe("review");

    // ── Production composition (index.ts order): owner-meta accessor → bus
    // listeners → wake deps → wake observer. Only fakes: the meta source
    // (harness session) and the capture sinks (wake messages / audits).
    const wakeSends: string[] = [];
    const wakeAudits: Array<{ event: string; payload: Record<string, unknown> }> = [];
    setOwnerMetaAccessor(() => h.meta() as unknown as Record<string, unknown>);
    cleanups.push(() => setOwnerMetaAccessor(null));
    const offWire = wireSubagentLifecycleListeners(h.ownerPi);
    cleanups.push(offWire);
    setOwnerWakeDeps({
      getMeta: () => h.meta(),
      updateMeta: (patch) => {
        h.session.updateMeta(patch);
      },
      sendFollowUp: (summary) => {
        wakeSends.push(summary);
      },
      audit: (event, payload) => {
        wakeAudits.push({ event, payload });
      },
      syncStatusBar: () => {},
    });
    cleanups.push(() => setOwnerWakeDeps(null));
    const offObserver = registerOwnerWakeObserver();
    cleanups.push(offObserver);

    // ── Dispatch the review executor through the production primitive (the
    // same call consumePendingSpawns makes). The incident state is: an
    // ACTIVE review executor on a freshly-visited review stage — exactly
    // what a normal (unrouted) develop exit leaves the pipeline in.
    await spawnStageSubagent(h.ownerPi as never, h.config, "review", h.meta(), {
      ui: { notify: () => {} },
      session: h.session,
      runtimeCtx: h.ownerToolCtx(),
    });
    const reviewAgentId = h.meta().activeSpawns?.review?.agentId;
    expect(reviewAgentId).toBeDefined();

    // ── The review executor declares FAIL through the REAL stage_advance
    // tool with a CHILD runtime ctx — routing enqueues the fix spawn to the
    // idle owner (pendingSpawns) instead of dispatching it.
    const statusTexts: string[] = [];
    const childCtx = {
      ...(h.childToolCtx() as Record<string, unknown>),
      ui: {
        notify: () => {},
        // Real Pi setStatus is (key, detail): capture both so the routed
        // stage label in the detail can be asserted.
        setStatus: (key?: unknown, detail?: unknown) => {
          statusTexts.push(`${String(key)}|${String(detail)}`);
        },
      },
    };
    const routed = await exec(createStageAdvancer(h.config), { reviewConclusion: "fail" }, childCtx);
    expect(routed.success).toBe(true);

    const afterRoute = h.meta();
    expect(afterRoute.currentStage).toBe("fix");
    // Bug premise holds: the fix spawn was ENQUEUED for the idle owner.
    expect(Object.keys(afterRoute.pendingSpawns ?? {})).toContain("fix");
    // G1-3: the status bar refreshed at the ROUTING point (before any settle).
    expect(statusTexts.some((t) => t.includes("fix"))).toBe(true);
    // Routing audit trail through the real advancer + real RPC enqueue.
    const auditAfterRoute = readAudit(h.projectRoot);
    expect(auditAfterRoute).toContain("review_auto_route_fix");
    expect(auditAfterRoute).toContain("stage_spawn_routed_to_owner");

    // ── G1: the review subagent's terminal event wakes the idle owner
    // exactly once via the event-driven path (the incident deadlock fix).
    const wakesBefore = wakeSends.length;
    h.emitTerminal("completed", reviewAgentId!);
    expect(wakeSends.length - wakesBefore).toBe(1);
    expect(wakeSends[wakesBefore]).toContain(reviewAgentId!);
    expect(h.meta().terminalWake?.agentId).toBe(reviewAgentId!);
    expect(
      wakeAudits.some(
        (a) => a.event === "owner_wake_on_terminal" && a.payload.agentId === reviewAgentId,
      ),
    ).toBe(true);

    // ── G1-2 dedup phase 1: a raw repeated terminal must NOT send a second
    // follow-up. (The spawn's own lifecycle watcher has already cleared
    // activeSpawns in the same dispatch, so the replay is refused here —
    // the incident invariant is "no second wake", by any predicate.)
    h.emitTerminal("completed", reviewAgentId!);
    expect(wakeSends.length - wakesBefore).toBe(1);

    // ── G1-2 dedup phase 2: the dedup guard itself — a replayed terminal
    // while the spawn ledger is STILL live (exactly the session-restore
    // shape: restore re-seeds activeSpawns from entries, then a duplicate
    // lifecycle event arrives). Re-arm the ledger, re-emit, and the wake
    // must be refused by the (agentId, stage, visitOrder) dedup triple.
    h.session.updateMeta({
      activeSpawns: {
        ...(h.meta().activeSpawns ?? {}),
        review: { agentName: "test-agent", agentId: reviewAgentId!, startedAt: 1 },
      },
    });
    h.emitTerminal("completed", reviewAgentId!);
    expect(wakeSends.length - wakesBefore).toBe(1);
    expect(
      wakeAudits.some(
        (a) => a.event === "owner_wake_skipped" && a.payload.reason === "dedup",
      ),
    ).toBe(true);

    // ── G2: the lifecycle registry recorded the terminal observation.
    const terminalEntry = findTerminal(reviewAgentId!);
    expect(terminalEntry?.status).toBe("terminal");
    expect(terminalEntry?.reason).toBe("completed");

    // ── The wake lands on the idle owner; its next settle consumes the
    // queued fix spawn through the EXISTING pull-based path (G1-1 minimal
    // intervention: only the trigger point is new).
    const rpcBefore = h.rpcCount();
    await h.settle();
    expect(h.rpcCount()).toBe(rpcBefore + 1);
    const fixed = h.meta();
    expect(fixed.currentStage).toBe("fix");
    expect(fixed.activeSpawns?.fix?.agentId).toBeDefined();
    expect(Object.keys(fixed.pendingSpawns ?? {})).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Chain B — G3 paused-window write policy + Phase 4 lazy re-anchor, driven
// through the REAL tool-guard, the REAL revalidation engine and the REAL
// resume-source human-decision presentation.
// ────────────────────────────────────────────────────────────────────────────

const PIPE_B = "pipe-200-regression-b";
const OWNER_FILE_B = "/x/owner-session.json";

interface SpawnRecord {
  stage: string;
  prompt?: string;
}

describe("200 Bug Phase 5 chain B: decision window READ-ONLY, drift window scoped to the bound report, lazy re-anchor converges, resume acts the decision", () => {
  let projectRoot = "";
  let planDoc = "";
  let config: PipelineConfig;

  beforeEach(async () => {
    resetGitignoreCache();
    projectRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-200-reg-b-"));
    planDoc = path.join(projectRoot, "docs/design/200_Bug_plan.md");
    fs.mkdirSync(path.dirname(planDoc), { recursive: true });
    fs.writeFileSync(planDoc, "# Plan 200_Bug\n\nPhase 0-5 tasks with acceptance criteria.\n", "utf-8");
    config = makeTestConfig({ projectRoot });
    config.stages = {
      ...config.stages,
      develop: { ...config.stages.develop, agentPath: "agents/dev.md", skillPath: "dev/SKILL.md" },
      // Manual confirm: the corrective release is a real human decision.
      "design-review": {
        ...config.stages["design-review"],
        confirm: { ...(config.stages["design-review"].confirm ?? {}), mode: "manual" },
      },
    };
    await initAuditLog(config);
    setAuditPipelineContext(PIPE_B);
  });

  afterEach(() => {
    clearAllHumanDecisionMenus();
    clearAllDecisionTimers();
    setAuditPipelineContext(null);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Contract-valid review report body (same format as the core suites). */
  function report(args: {
    planDoc: string;
    operationId: string;
    inputHash: string;
    verdict: "PASS" | "FAIL";
    issues: string[];
  }): string {
    return [
      "# Design Review Report",
      "",
      `**pipeline**: ${PIPE_B}`,
      `**plan**: ${args.planDoc}`,
      "**round**: 1",
      `**operation**: ${args.operationId}`,
      `**input hash**: ${args.inputHash}`,
      "",
      "## Summary",
      "",
      "Reviewed the plan against the requirement document; gaps are listed below.",
      "",
      "## Recommendations",
      "",
      "Close every listed gap before entering development.",
      "",
      "## Verdict",
      "",
      `**Design Review: ${args.verdict}**`,
      "",
      "## Issues",
      "",
      ...args.issues.map((issue, i) => `${i + 1}. ${issue}`),
      "",
    ].join("\n");
  }

  /** Coordinator ctx over an EXISTING session (act step reuses the session). */
  function makeCtx(
    session: ReturnType<typeof makeStrictSession>,
    spawnLog: SpawnRecord[],
    opts: { interactionSource?: "auto" | "resume"; select?: string } = {},
  ): CoordinatorContext {
    const select: HumanDecisionSelectFn | undefined =
      opts.select !== undefined
        ? async () => opts.select as string
        : undefined;
    return {
      config,
      session: session as never,
      ui: { notify: () => {}, ...(select ? { select } : {}) },
      pi: { sendUserMessage: () => {} },
      actor: { isChild: false, sessionFile: OWNER_FILE_B },
      interactionSource: opts.interactionSource ?? "auto",
      spawnOverride: async (_cfg, stage, _m, extraArgs) => {
        spawnLog.push({ stage, ...(extraArgs !== undefined ? { prompt: extraArgs } : {}) });
        return {
          spawned: true,
          fallback: false,
          deferred: false,
          agentId: `agent-${stage}-${spawnLog.length}`,
          dispatchOutcome: "spawned_id" as const,
        };
      },
    } as unknown as CoordinatorContext;
  }

  function flipPauseReason(
    session: ReturnType<typeof makeStrictSession>,
    pauseReason: NonNullable<SessionMeta["designReview"]>["pauseReason"],
  ): void {
    const st = session.getMeta()!.designReview!;
    session.updateMeta({ designReview: { ...st, pauseReason } });
  }

  /** Advance → FAIL report → settle with NO menu answer → decision-pending. */
  async function setupPendingDecision(): Promise<{
    ctx: CoordinatorContext;
    session: ReturnType<typeof makeStrictSession>;
    spawnLog: SpawnRecord[];
    decision: HumanDecision;
    reportDoc: string;
  }> {
    const spawnLog: SpawnRecord[] = [];
    const meta = makeTestMeta({
      currentStage: "design-review",
      pipelineId: PIPE_B,
      designReview: createInitialState(
        planDoc,
        "menu",
        computeHash(fs.readFileSync(planDoc, "utf-8")),
        OWNER_FILE_B,
        { pipelineId: PIPE_B },
      ),
    });
    const session = makeStrictSession(meta);
    const ctx = makeCtx(session, spawnLog);
    const r = await coordinateDesignReview(ctx, session.getMeta()!, "advance");
    expect(r.status === "handled" && r.action === "routed").toBe(true);
    const st = session.getMeta()!.designReview!;
    expect(st.phase).toBe("review_running");

    const reportDoc = deriveReportPath(planDoc, 1);
    fs.writeFileSync(
      reportDoc,
      report({
        planDoc,
        operationId: st.operation!.operationId,
        inputHash: computeHash(fs.readFileSync(planDoc, "utf-8")),
        verdict: "FAIL",
        issues: ["fix the drift guard before Phase 5"],
      }),
    );

    // Settle WITHOUT a menu answer → the decision parks pending (H1 anchored).
    await coordinateDesignReview(ctx, session.getMeta()!, "settle");
    const after = session.getMeta()!.designReview!;
    expect(after.phase).toBe("paused");
    expect(after.pauseReason).toBe("decision-pending");
    return { ctx, session, spawnLog, decision: after.decision!, reportDoc };
  }

  it("full paused-window chain: guard blocks in the decision window, drift window releases ONLY the bound report, revalidation re-anchors H1→H2, and the re-armed resume acts to develop", async () => {
    const { ctx, session, spawnLog, decision, reportDoc } = await setupPendingDecision();

    // H1: the anchored report hash at decision creation.
    const H1 = computeHash(fs.readFileSync(reportDoc, "utf-8"));
    expect(decision.reportHash).toBe(H1);

    // ── (1) REAL tool-guard: inside the decision window the bound report is
    // READ-ONLY (G3-2 exclusion holds through the production gate).
    const guard = createToolGuard(config);
    const writeEvent = (filePath: string): unknown => ({
      toolCall: { name: "write", arguments: { file_path: filePath } },
      session: {
        getMeta: () => session.getMeta(),
        // The production guard records violations through the session on
        // every block; mirror that sink so trackViolation runs for real.
        updateMeta: (patch: Record<string, unknown>) => {
          session.updateMeta(patch as never);
        },
      },
      ui: { notify: () => {} },
      _ctx: {},
    });
    const blockedInWindow = (await guard.handler(
      writeEvent(reportDoc) as never,
    )) as { block?: boolean; reason?: string } | undefined;
    expect(blockedInWindow?.block).toBe(true);
    expect(blockedInWindow?.reason).toContain("human plan-revision decision");

    // ── (2) A generic paused commit (drift reason, NOT a decision reason)
    // opens Phase 3's scoped window for the CURRENT review operation.
    flipPauseReason(session, "drift");
    expect(isPausedReportEditable(session.getMeta()!.designReview!)).toBe(true);
    const policy = resolveDesignReviewWritePolicy(session.getMeta());
    expect(policy.mode).toBe("scoped");
    // In scope: exactly the operation-bound reportDoc. Out: the plan document.
    expect(isPathWithinWriteScope(policy, config.projectRoot, reportDoc)).toBe(true);
    expect(isPathWithinWriteScope(policy, config.projectRoot, planDoc)).toBe(false);

    // ── (3) REAL tool-guard in the drift window: out-of-scope path refused,
    // bound reportDoc permitted (guard returns no block → tool executes).
    const blockedOutside = (await guard.handler(
      writeEvent(planDoc) as never,
    )) as { block?: boolean } | undefined;
    expect(blockedOutside?.block).toBe(true);

    const allowed = await guard.handler(writeEvent(reportDoc) as never);
    expect(allowed).toBeUndefined();

    // The permitted write lands — the report hash drifts H1 → H2 while a
    // pending decision still anchors H1.
    const h2Content = report({
      planDoc,
      operationId: decision.reviewIdentity.operationId,
      inputHash: computeHash(fs.readFileSync(planDoc, "utf-8")),
      verdict: "FAIL",
      issues: ["legal paused-window edit: reworded finding with evidence"],
    });
    fs.writeFileSync(reportDoc, h2Content);
    const H2 = computeHash(h2Content);
    expect(H2).not.toBe(H1);

    // ── (4) Phase 4 lazy re-anchor: the PRODUCTION revalidation engine
    // converges the decision anchor onto H2 instead of rejecting on drift,
    // because the mismatch happened inside the permitted window.
    const liveDecision = session.getMeta()!.designReview!.decision!;
    const revalidated = await revalidateHumanDecisionSnapshot(ctx, session.getMeta()!, liveDecision);
    expect(revalidated.ok).toBe(true);
    expect(session.getMeta()!.designReview!.decision!.reportHash).toBe(H2);
    const audit = readAudit(projectRoot);
    expect(audit).toContain("decision_report_reanchored");

    // ── (5) Re-arm the decision window and act through the REAL resume
    // presentation: pre-menu revalidation passes (anchor == H2), the human
    // picks "Proceed to Develop", and the decision executes to develop.
    // Under the pre-Phase-4 contract this step would have parked the
    // decision on report_hash_drift and never released the pipeline.
    flipPauseReason(session, "decision-pending");
    const resumeCtx = makeCtx(session, spawnLog, {
      interactionSource: "resume",
      select: "Proceed to Develop",
    });
    const acted = await coordinateDesignReview(resumeCtx, session.getMeta()!, "settle");
    expect(acted.status).toBe("handled");

    const finalMeta = session.getMeta()!;
    expect(finalMeta.currentStage).toBe("develop");
    expect(finalMeta.stageVisitOrder?.[finalMeta.stageVisitOrder.length - 1]).toBe("develop");
    expect(spawnLog.some((s) => s.stage === "develop")).toBe(true);
  });

  it("decision-window edits stay fail-closed: a drift commit that is NOT re-anchored parks the revalidated decision instead of acting", async () => {
    const { session, spawnLog, decision, reportDoc } = await setupPendingDecision();

    // Legal-window edit that we deliberately NEVER re-anchor (the window is
    // re-armed directly): the pending anchor H1 no longer matches the bytes.
    flipPauseReason(session, "drift");
    const drifted = report({
      planDoc,
      operationId: decision.reviewIdentity.operationId,
      inputHash: computeHash(fs.readFileSync(planDoc, "utf-8")),
      verdict: "FAIL",
      issues: ["edited in the window but never revalidated"],
    });
    fs.writeFileSync(reportDoc, drifted);

    // Re-arm WITHOUT revalidation (simulates the crash window between a
    // legal edit and the next revalidation pass).
    flipPauseReason(session, "decision-pending");
    const resumeCtx = makeCtx(session, spawnLog, {
      interactionSource: "resume",
      select: "Proceed to Develop",
    });
    const r = await coordinateDesignReview(resumeCtx, session.getMeta()!, "settle");

    // The decision must NOT act: revalidation fails, the decision is parked
    // for drift, and the pipeline never reaches develop.
    const after = session.getMeta()!;
    expect(after.currentStage).not.toBe("develop");
    expect(spawnLog.some((s) => s.stage === "develop")).toBe(false);
    // Parked for drift: the decision is no longer present as an actable
    // pending anchor.
    expect(after.designReview?.decision ?? undefined).toBeUndefined();
    expect(readAudit(projectRoot)).toContain("report_hash_drift");
    // And r either reports handled-park or skipped — never a release.
    expect(["handled", "skipped", "parked"]).toContain(r.status);
  });
});
