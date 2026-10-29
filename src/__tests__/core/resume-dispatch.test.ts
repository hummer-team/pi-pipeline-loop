/**
 * @module resume-dispatch
 * 218 Phase 3 (T3.5, Q13-A / R8 / R12): the flow-state resume branch dispatches
 * the stage executor EXACTLY ONCE from every resume entry — decision menu,
 * policy unfreeze and `--force-resume` — and the command layer never
 * re-dispatches after `executeDecision`.
 *
 * Plan case table coverage:
 *  1. resume + no live executor → handler invoked once + `resume_dispatch_invoked`;
 *     `clearStageSpawnResidue` runs BEFORE the dispatch (proven by the meta
 *     snapshot the handler receives — a dispatch before the clear would still
 *     see the residue entry);
 *  2. resume + `probeAgentState === "live"` → handler never invoked,
 *     `resume_dispatch_skipped_live`, residue kept, existing notify retained;
 *  3. handler unset → `resume_dispatch_unavailable` (warn) + one visible hint,
 *     the resume itself still succeeds (no throw);
 *  4. `choose_stage` → dispatch stays on the `onStageChanged` side; the resume
 *     handler is never triggered;
 *  5. `/pipeline-resume --force-resume` → exactly ONE dispatch through the
 *     seam and ZERO command-level direct spawn attempts (`stage_spawn*` rows);
 *  6. policy unfreeze (headless `tryApplyPolicy` → resume) → exactly ONE
 *     dispatch (the removed `:438` re-dispatch is pinned by the same
 *     `stage_spawn*` = 0 check).
 *
 * Liveness is driven through the documented manager-registry symbol
 * (`Symbol.for("pi-subagents:manager")`) that `probeAgentState` reads.
 * The handler is a process-global DI seam — every test clears it in
 * `afterEach` (index-registration cleanup discipline).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { executeDecision } from "../../core/flow-state";
import {
  invokeResumeDispatch,
  setResumeDispatchHandler,
  __peekResumeDispatchHandler,
} from "../../core/resume-dispatch";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import type { SessionMeta } from "../../types";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

type AuditRow = {
  event: string;
  message: Record<string, unknown>;
  level?: string;
};

let audits: AuditRow[] = [];
let notifications: string[] = [];

/** Install a fake manager registry driving `probeAgentState`. */
function installRegistry(records: Record<string, { status: string }>): void {
  (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
    getRecord: (id: string) => records[id],
    hasRunning: () => false,
  };
}

afterEach(() => {
  // DI cleanup discipline: the seam is process-global.
  setResumeDispatchHandler(null);
  __setSafeWriteAuditLogOverride(null);
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  audits = [];
  notifications = [];
});

function captureAudits(): void {
  audits = [];
  notifications = [];
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message: (message ?? {}) as Record<string, unknown>, level });
  });
}

/** Ctx whose ui.notify is recorded (asserting hints without disk races). */
function makeCtx(meta: SessionMeta) {
  const ctx = createMockCtx(meta);
  ctx.ui.notify = (msg: string) => {
    notifications.push(msg);
  };
  return ctx;
}

/** Count audit rows for an event. */
function rows(event: string): AuditRow[] {
  return audits.filter((a) => a.event === event);
}

/** Any dispatch-attempt row the command layer would produce directly. */
function spawnRows(): AuditRow[] {
  return audits.filter((a) => a.event.startsWith("stage_spawn"));
}

/** Residue entry for `stage` pointing at registry record `recordId`. */
function residueMeta(stage: SessionMeta["currentStage"], recordId: string): SessionMeta {
  return makeTestMeta({
    currentStage: stage,
    pipelineId: "pipe-218-rd",
    flowState: "blocked",
    blockedReason: "loop_overflow",
    loopCount: 3,
    activeSpawns: {
      [stage]: { agentName: `dev-agent-${recordId}`, agentId: recordId, startedAt: Date.now(), source: "rpc" },
    },
  });
}

describe("218 T3.5: resume dispatch seam unit", () => {
  // ── Case 3 (unit level): unset handler → audited no-op ────────────────────
  it("invokeResumeDispatch without a wired handler returns unavailable and never throws", async () => {
    captureAudits();
    // Deterministic pre-condition: the seam is process-global and other
    // files' composition-root wiring can leave it installed (bun shares one
    // process across files) — explicitly unset, then verify the peek agrees.
    setResumeDispatchHandler(null);
    expect(__peekResumeDispatchHandler()).toBeNull();
    const ctx = makeCtx(makeTestMeta());
    const outcome = await invokeResumeDispatch(
      { session: ctx.session },
      makeTestConfig(),
      makeTestMeta(),
    );
    expect(outcome).toBe("unavailable");
  });

  it("a wired handler is invoked exactly once and reports dispatched", async () => {
    captureAudits();
    const calls: SessionMeta[] = [];
    setResumeDispatchHandler(async (_c, _cfg, fresh) => {
      calls.push(fresh);
    });
    const meta = makeTestMeta({ pipelineId: "pipe-218-rd-h" });
    const outcome = await invokeResumeDispatch({ session: { getMeta: () => meta, updateMeta: () => meta } }, makeTestConfig(), meta);
    expect(outcome).toBe("dispatched");
    expect(calls).toHaveLength(1);
  });
});

describe("218 T3.5: flow-state resume branch dispatches exactly once", () => {
  // ── Case 1: dead residue → clear BEFORE dispatch, handler once ────────────
  it("resume + settled residue → clearStageSpawnResidue runs before the dispatch; resume_dispatch_invoked once", async () => {
    captureAudits();
    installRegistry({ "rec-off": { status: "completed" } }); // NOT live
    const meta = residueMeta("develop", "rec-off");
    const ctx = makeCtx(meta);

    const seen: Array<{ activeSpawns: SessionMeta["activeSpawns"]; flowState?: string }> = [];
    setResumeDispatchHandler(async (_c, _cfg, fresh) => {
      // Deep-snapshot at CALL time: a dispatch that ran before the residue
      // clear would still see the `develop` entry here.
      seen.push({
        activeSpawns: JSON.parse(JSON.stringify(fresh.activeSpawns ?? {})),
        flowState: fresh.flowState as string | undefined,
      });
    });

    const res = await executeDecision(ctx as never, meta, "resume", makeTestConfig(), { source: "unit-resume" });
    expect(res.success).toBe(true);

    // Handler invoked EXACTLY once.
    expect(seen).toHaveLength(1);
    // Residue was cleared BEFORE the dispatch reached the handler...
    expect(seen[0]!.activeSpawns?.develop).toBeUndefined();
    // ...and the handler received the RE-READ post-reset snapshot (running).
    expect(seen[0]!.flowState).toBe("running");

    const invoked = rows("resume_dispatch_invoked");
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.message.pipelineId).toBe("pipe-218-rd");
    expect(invoked[0]?.message.stage).toBe("develop");
    expect(invoked[0]?.message.source).toBe("unit-resume");
    expect(rows("resume_dispatch_unavailable")).toHaveLength(0);
    expect(rows("resume_dispatch_skipped_live")).toHaveLength(0);
  });

  // ── Case 2: live executor → skipped dispatch, residue kept ────────────────
  it("resume + live executor → no dispatch, resume_dispatch_skipped_live, residue kept, notify retained", async () => {
    captureAudits();
    installRegistry({ "rec-on": { status: "running" } }); // LIVE
    const meta = residueMeta("develop", "rec-on");
    const ctx = makeCtx(meta);

    let handlerCalls = 0;
    setResumeDispatchHandler(async () => {
      handlerCalls++;
    });

    const res = await executeDecision(ctx as never, meta, "resume", makeTestConfig(), { source: "live-check" });
    expect(res.success).toBe(true);

    expect(handlerCalls).toBe(0);
    // Live-protect: the ledger record stays exactly as 203 RC2 established.
    expect(meta.activeSpawns?.develop).toBeDefined();
    // 218: the skip is now auditable (distinguishes "live twin" from a
    // silent miss in the incident replay).
    const skipped = rows("resume_dispatch_skipped_live");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.message.stage).toBe("develop");
    // The pre-existing notify is RETAINED (plan: keep the visible behavior).
    expect(notifications.some((n) => n.includes("executor still live"))).toBe(true);
  });

  // ── Case 3 (branch level): handler unset → warn + hint, resume succeeds ───
  it("resume with an un-wired composition root → resume_dispatch_unavailable (warn) + one visible hint, no throw", async () => {
    captureAudits();
    setResumeDispatchHandler(null); // un-wired
    const meta = makeTestMeta({
      pipelineId: "pipe-218-rd-3",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeCtx(meta);

    const res = await executeDecision(ctx as never, meta, "resume", makeTestConfig(), { source: "unwired" });

    // The resume itself SUCCEEDS — the dispatch miss never unwinds it.
    expect(res.success).toBe(true);
    expect(meta.flowState).toBe("running");

    const unavailable = rows("resume_dispatch_unavailable");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.level).toBe("warn");
    expect(unavailable[0]?.message.stage).toBe("develop");
    // Exactly one visible hint.
    expect(notifications.filter((n) => n.includes("no stage executor could be dispatched"))).toHaveLength(1);
  });

  // ── Case 4: choose_stage never triggers the resume dispatch ───────────────
  it("choose_stage → dispatched only via onStageChanged; invokeResumeDispatch is never triggered", async () => {
    captureAudits();
    const meta = makeTestMeta({
      pipelineId: "pipe-218-rd-4",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeCtx(meta);

    let dispatchCalls = 0;
    setResumeDispatchHandler(async () => {
      dispatchCalls++;
    });
    const stageChanged: SessionMeta[] = [];

    const res = await executeDecision(ctx as never, meta, "choose_stage", makeTestConfig(), {
      targetStage: "review",
      onStageChanged: async (fresh) => {
        stageChanged.push(fresh);
      },
    });
    expect(res.success).toBe(true);

    // The chosen stage re-enters via the injected callback (182 DI contract)...
    expect(stageChanged).toHaveLength(1);
    // ...and NEVER through the resume seam (R12: one dispatch channel per
    // decision kind).
    expect(dispatchCalls).toBe(0);
    expect(rows("resume_dispatch_invoked")).toHaveLength(0);
    expect(rows("resume_dispatch_unavailable")).toHaveLength(0);
  });
});

describe("218 T3.5: /pipeline-resume command entries dispatch once", () => {
  // ── Case 5: --force-resume end-to-end, single dispatch, no direct spawn ───
  it("--force-resume → exactly ONE seam dispatch and ZERO command-level stage_spawn rows", async () => {
    captureAudits();
    const meta = makeTestMeta({
      pipelineId: "pipe-218-rd-5",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      loopCount: 3,
    });
    const ctx = makeCtx(meta);

    let dispatchCalls = 0;
    setResumeDispatchHandler(async () => {
      dispatchCalls++;
    });

    const cmd = createPipelineResumeCommand(makeTestConfig());
    const result = (await cmd.execute({ forceResume: true }, ctx as never)) as {
      message?: string;
      error?: string;
    };

    expect(result.error).toBeUndefined();
    expect(result.message).toContain("resumed");
    // The flow-state resume branch dispatched exactly once...
    expect(dispatchCalls).toBe(1);
    expect(rows("resume_dispatch_invoked")).toHaveLength(1);
    expect(rows("resume_dispatch_invoked")[0]?.message.source).toBe("force-resume");
    // ...and the command performed NO direct dispatch of its own (the old
    // `:519` call would leave a stage_spawn* row behind — R8/R12 double spawn).
    expect(spawnRows()).toHaveLength(0);
  });

  // ── Case 6: policy unfreeze (tryApplyPolicy → resume) → single dispatch ───
  it("headless policy unfreeze → exactly ONE seam dispatch; the removed policy branch adds no second", async () => {
    captureAudits();
    const config = makeTestConfig();
    // Decision policy: loop_overflow freezes auto-resolve to `resume`.
    config.decisionPolicy = {
      ...(config.decisionPolicy ?? {}),
      enabled: true,
      byReason: { loop_overflow: { decision: "resume" } },
    };

    const meta = makeTestMeta({
      pipelineId: "pipe-218-rd-6",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      loopCount: 3,
    });
    const ctx = makeCtx(meta);
    delete ctx.ui.select; // headless: the policy applies WITHOUT a menu

    let dispatchCalls = 0;
    setResumeDispatchHandler(async () => {
      dispatchCalls++;
    });

    const cmd = createPipelineResumeCommand(config);
    const result = (await cmd.execute({}, ctx as never)) as {
      message?: string;
      error?: string;
    };

    expect(result.error).toBeUndefined();
    expect(result.message).toContain("Decision policy resolved the freeze");
    // `tryApplyPolicy` funnels through `executeDecision("resume")` — the single
    // flow-state dispatch fired once...
    expect(dispatchCalls).toBe(1);
    expect(rows("resume_dispatch_invoked")).toHaveLength(1);
    // ...and the deleted `:438` command-level re-dispatch stays gone.
    expect(spawnRows()).toHaveLength(0);
    expect(meta.flowState).toBe("running");
  });
});
