/**
 * 218 Phase 4 (T4.3): incident replay — the 20261028 timeline, simulated on ONE
 * shared in-memory audit stream, asserting the four acceptance points (F.4).
 *
 * Beats (chronological; timestamps from the incident log):
 *  1. 19:00:54 owner `Agent(code-review-withfix-agent)` while `pendingSpawns.review`
 *     is queued → `spawn_queued_blocked` (NOT a violation); 19:00:59 stall →
 *     ONE-SHOT manual authorization; the plugin's own consume path must then
 *     drop the entry WITHOUT emitting a second `stage_spawn_rpc` (F.4-1/Q23-A).
 *  2. 19:15:49 terminal wake with the ledger already cleared → attribution via
 *     the dispatch snapshot (R11); `owner_wake_skipped reason=not_stage_executor`
 *     must NEVER appear on the timeline (F.4-4a).
 *  3. 19:18:28–36 THREE independent child whitelist-miss write calls → exactly
 *     3 queue entries, zero violations, zero denial-overflow freeze (F.4-2).
 *  4. 19:18:36 child freeze → `owner_wake_escalation delivered=true` via the
 *     registry (Q11-B); the owner settle takes the APPROVAL FIRST: ONE batched
 *     menu for all 3 targets, `decision_menu_deferred_for_approval`, and
 *     `menuEscalationPending` stays armed (F.4-3/Q17-A).
 *  5. 19:50:52 `executeDecision("resume")` → the dispatch seam runs EXACTLY
 *     once (`stage_spawn_rpc` ×1 + `resume_dispatch_invoked`) — R8/R12.
 *
 * Divergence note (F.4-2 wording): the plan's "批量 pipeline_write_ask" names the
 * OWNER-DIRECT ask event (`protect-ask.ts` is its only emitter). The queued
 * batch menu audits `write_approval_approved` once for the whole batch — this
 * replay asserts the production event, one interaction per batch either way.
 *
 * No real subagents, no fs assertions: ONE shared SessionMeta (the production
 * shared-store shape) + `createMockCtx` + event injection on a mock bus.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PendingSpawnEntry, PipelineConfig, SessionMeta } from "../../types";
import {
  makeTestConfig,
  makeTestMeta,
  makeStageConfig,
  createMockCtx,
  createMockEventBus,
} from "../helpers";
import { createToolGuard } from "../../core/tool-guard";
import { createAgentSettled } from "../../core/agent-settled";
import { freezeAndPrompt, executeDecision } from "../../core/flow-state";
import { consumePendingSpawns } from "../../utils/subagent-rpc";
import {
  registerOwnerDelivery,
  __resetOwnerDeliveryRegistry,
} from "../../core/owner-delivery-registry";
import { setResumeDispatchHandler } from "../../core/resume-dispatch";
import {
  registerOwnerWakeObserver,
  setOwnerWakeDeps,
} from "../../core/owner-wake";
import {
  wireSubagentLifecycleListeners,
  setOwnerMetaAccessor,
  __resetLifecycleRegistry,
} from "../../utils/subagent-lifecycle-registry";
import {
  setSpawnLedgerConfig,
  setSpawnLedgerSession,
  __resetSpawnLedger,
} from "../../utils/spawn-ledger";
import {
  initAuditLog,
  safeWriteAuditLog,
  __setSafeWriteAuditLogOverride,
  __resetAuditDirPath,
} from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";

// ── Shared audit stream (the "同一份审计时间线" of F.4) ────────────────────
interface Row {
  event: string;
  message: Record<string, unknown>;
  level?: string;
}
const TIMELINE: Row[] = [];

/** Rows with `event` appended since mark `from` (per-beat assertions). */
const rowsAt = (from: number, event: string): Row[] =>
  TIMELINE.slice(from).filter((r) => r.event === event);

/** Flush fire-and-forget audit writes (e.g. `write_approval_queued`). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Explicit incident anchors (no reliance on wall-clock semantics). */
const T_1900 = Date.parse("2026-10-28T19:00:54");

const OWNER_SESSION = "/sessions/owner-20261028.jsonl";
const CHILD_SESSION = "/sessions/child-review-20261028.jsonl";
const REVIEW_AGENT = "code-review-withfix-agent";

let TMP: string;
/** In-workdir scratch docs: not whitelisted by the read-only review stage and
 *  not protected → whitelist_miss (the incident's three blocked calls). */
let WRITE_TARGETS: string[];
let config: PipelineConfig;
/** The SHARED pipeline meta — owner and child session handles mutate this one
 *  object (production shared-store discipline). */
let meta: SessionMeta;
/** Owner-side follow-up messages accepted through the delivery registry. */
const SENT: string[] = [];

beforeAll(() => {
  TMP = join(tmpdir(), `pi-218-replay-${Date.now()}`);
  mkdirSync(join(TMP, "agents"), { recursive: true });
  writeFileSync(
    join(TMP, "agents", "review-fix.md"),
    `---\nname: ${REVIEW_AGENT}\ntools: read, grep, ls\n---\n# review-fix agent\n`,
  );
  WRITE_TARGETS = ["218-report.md", "218-ledger.md", "218-timeline.md"].map((f) =>
    join(TMP, "notes", f),
  );
  config = makeTestConfig({
    projectRoot: TMP,
    stages: {
      ...makeTestConfig().stages,
      // Review = read-only stage (incident setting): nothing is whitelisted,
      // so any child write outside protect.paths is a whitelist miss.
      review: makeStageConfig({
        agentPath: "agents/review-fix.md",
        allowedWritePaths: [],
        nextStage: "fix",
      }),
    },
  } as never);
  initAuditLog(config);

  meta = makeTestMeta({
    pipelineId: "pipe-20261028",
    currentStage: "review",
    previousStage: "develop",
  });

  // The audit override IS the shared timeline: every `safeWriteAuditLog` row
  // (and the wake deps.audit bridge below) lands in TIMELINE, never on disk.
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    TIMELINE.push({ event, message: (message ?? {}) as Record<string, unknown>, level });
  });

  // Owner session reachable through the T3.1 delivery registry (direct send).
  registerOwnerDelivery({
    sessionFile: OWNER_SESSION,
    isChild: false,
    getMeta: () => undefined,
    sendFollowUp: (summary: string) => {
      SENT.push(summary);
      return true;
    },
    notify: () => {},
    audit: () => {},
  });
});

afterAll(() => {
  // Full DI hygiene — Bun shares one process across every test file.
  __setSafeWriteAuditLogOverride(null);
  __resetOwnerDeliveryRegistry();
  __resetMemoryThrottle();
  setOwnerWakeDeps(null);
  setOwnerMetaAccessor(null);
  __resetLifecycleRegistry();
  __resetSpawnLedger();
  setResumeDispatchHandler(null);
  __resetAuditDirPath();
});

/** Owner ctx bound to the shared meta (no parentSession header → owner role). */
function ownerCtx() {
  return createMockCtx(meta, { sessionFile: OWNER_SESSION });
}

/** Child executor ctx (parentSession header → child role, shared meta). */
function childCtx() {
  return createMockCtx(meta, {
    sessionHeader: { parentSession: OWNER_SESSION },
    sessionFile: CHILD_SESSION,
  });
}

describe("218 T4.3: incident 20261028 replay on one shared audit timeline", () => {
  // ── Beat 1 — F.4-1: queue ownership, one-shot authorization, no twin ─────
  it("19:00:54 manual Agent(review) is queue-blocked; 19:00:59 stall authorizes exactly once; plugin consume emits no second stage_spawn_rpc", async () => {
    const mark = TIMELINE.length;
    const queued: PendingSpawnEntry = {
      agentName: REVIEW_AGENT,
      requestedAt: T_1900,
      attempts: 0,
      pipelineId: meta.pipelineId,
    };
    meta.pendingSpawns = { review: queued };
    const guard = createToolGuard(config);

    // 19:00:54 — ownership block, NOT a violation.
    const ctx1 = ownerCtx();
    ctx1.toolCall = { name: "Agent", arguments: { subagent_type: REVIEW_AGENT } };
    const blocked = (await guard.handler(ctx1 as never)) as { block?: boolean } | undefined;
    expect(blocked?.block).toBe(true);
    expect(rowsAt(mark, "spawn_queued_blocked")).toHaveLength(1);
    expect(rowsAt(mark, "pipeline_violation")).toHaveLength(0);

    // 19:00:59 — the stall detector stamps stalledAt; the next manual call is
    // authorized ONCE (dispatchConsumedAt written, no block).
    meta.pendingSpawns = { review: { ...queued, stalledAt: T_1900 + 5_000 } };
    const ctx2 = ownerCtx();
    ctx2.toolCall = { name: "Agent", arguments: { subagent_type: REVIEW_AGENT } };
    const authorized = (await guard.handler(ctx2 as never)) as { block?: boolean } | undefined;
    expect(authorized?.block).not.toBe(true);
    expect(rowsAt(mark, "spawn_queue_authorization_consumed")).toHaveLength(1);
    expect(typeof meta.pendingSpawns?.review?.dispatchConsumedAt).toBe("number");

    // Authorization is one-shot: a third call in the same turn blocks again.
    const ctx3 = ownerCtx();
    ctx3.toolCall = { name: "Agent", arguments: { subagent_type: REVIEW_AGENT } };
    const reblocked = (await guard.handler(ctx3 as never)) as { block?: boolean } | undefined;
    expect(reblocked?.block).toBe(true);
    expect(rowsAt(mark, "spawn_queued_blocked")).toHaveLength(2);

    // End of turn: the plugin consumes the AUTHORIZED entry without spawning
    // its twin (Q23-A) — zero `stage_spawn_rpc` on this beat.
    await consumePendingSpawns(null, config, meta, {
      session: ctx1.session as never,
      ui: { notify: () => {} },
    });
    await flush();
    expect(meta.pendingSpawns?.review).toBeUndefined();
    expect(rowsAt(mark, "pending_spawn_authorized_consumed")).toHaveLength(1);
    expect(rowsAt(mark, "stage_spawn_rpc")).toHaveLength(0);
  });

  // ── Beat 2 — F.4-4a: 19:15:49 wake attributed via the dispatch snapshot ──
  it("19:15:49 terminal wake with a cleared ledger still attributes the dispatch stage — no not_stage_executor skip, ever", async () => {
    const mark = TIMELINE.length;
    setOwnerMetaAccessor(() => meta);
    setSpawnLedgerConfig(config);
    setSpawnLedgerSession({
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => {
        Object.assign(meta, patch);
      },
    } as never);
    setOwnerWakeDeps({
      getMeta: () => meta,
      updateMeta: (patch) => {
        Object.assign(meta, patch);
      },
      sendFollowUp: (summary: string) => {
        SENT.push(summary);
      },
      // Wake audits bridge into the SAME timeline as the safeWrite sink.
      audit: (event, payload) => {
        TIMELINE.push({ event, message: payload });
      },
      syncStatusBar: () => {},
    });
    const offWake = registerOwnerWakeObserver();
    const bus = createMockEventBus();
    const offWire = wireSubagentLifecycleListeners({ events: bus });

    // Dispatch happened at ~19:00: the started snapshot carries stage+agent.
    bus.trigger("subagents:started", { id: "w-20261028", type: REVIEW_AGENT });
    expect(meta.activeSpawns?.review?.agentId).toBe("w-20261028");
    // T0.5 terminal sweep already cleared the ledger (the 19:15:49 shape that
    // used to strand the wake in the incident).
    meta.activeSpawns = {};

    bus.trigger("subagents:completed", { id: "w-20261028", reason: "completed" });
    await flush();

    const fired = rowsAt(mark, "owner_wake_on_terminal");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.message.stage).toBe("review"); // dispatch-time attribution (R11)
    // Global invariant across the WHOLE replay: the misattribution skip never
    // appears (the incident logged it ×5).
    expect(
      TIMELINE.filter(
        (r) => r.event === "owner_wake_skipped" && (r.message.reason ?? "") === "not_stage_executor",
      ),
    ).toHaveLength(0);

    offWake();
    offWire();
    setOwnerWakeDeps(null);
    setOwnerMetaAccessor(null);
    __resetLifecycleRegistry();
    __resetSpawnLedger();
  });

  // ── Beat 3 — F.4-2: three independent child whitelist-miss calls ─────────
  it("19:18:28–36 three independent child writes queue three entries with zero violations", async () => {
    const mark = TIMELINE.length;
    const guard = createToolGuard(config);

    // Three SEPARATE tool calls (incident `count=1/2/3`) — each blocked with
    // the "do NOT retry" queue reason, each landing one queue entry.
    for (const path of WRITE_TARGETS) {
      const ctx = childCtx();
      ctx.toolCall = { name: "write", arguments: { file_path: path } };
      const res = (await guard.handler(ctx as never)) as { block?: boolean; reason?: string } | undefined;
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain("do NOT retry");
    }
    await flush();

    expect(rowsAt(mark, "write_approval_queued")).toHaveLength(3);
    const pending = Object.values(meta.pendingOwnerApprovals ?? {});
    expect(pending.filter((e) => e.kind === "write" && e.stage === "review")).toHaveLength(3);
    // No owner-side denial pressure was created by the QUEUE route: the
    // breaker buckets stay empty (F.4-3 precondition — the freeze is NOT a
    // denial overflow).
    expect(rowsAt(mark, "pipeline_violation")).toHaveLength(0);
    expect(rowsAt(mark, "whitelist_miss_denial_overflow")).toHaveLength(0);
    expect(meta.flowState ?? "running").toBe("running");
  });

  // ── Beat 4 — F.4-3: freeze escalates, approvals take the settle slot ─────
  it("19:18:36 child freeze delivers directly; the owner settle consumes the batch with ONE menu and defers the frozen menu", async () => {
    const mark = TIMELINE.length;
    // New owner turn (19:15→19:18): index.ts advances `ownerTurnSeq` per turn,
    // so the escalation wake is not deduped against beat 1's stamp.
    meta.ownerTurnSeq = (meta.ownerTurnSeq ?? 0) + 1;

    await freezeAndPrompt(childCtx() as never, meta, "loop_overflow", config);
    await flush();

    // Q11-B: direct registry delivery — the incident's broadcast-only wake.
    const esc = rowsAt(mark, "owner_wake_escalation");
    expect(esc).toHaveLength(1);
    expect(esc[0]!.message.delivered).toBe("true");
    expect(esc[0]!.message.via).toBe("registry_non_child");
    expect(SENT[SENT.length - 1]).toContain("Pipeline blocked (loop_overflow)");
    expect(meta.flowState).toBe("blocked");
    expect(meta.menuEscalationPending).toBe(true);

    // Owner settle: the queued approvals (upstream cause) take the slot FIRST.
    const menus: Array<{ title: string; options: string[] }> = [];
    const owner = ownerCtx();
    owner.ui!.select = async (title: string, options: string[]) => {
      menus.push({ title, options });
      return "Allow for this session";
    };
    await createAgentSettled(config).handler(owner as never);
    await flush();

    // F.4-2 end state: THREE blocked calls consumed by ONE interaction.
    expect(menus).toHaveLength(1);
    for (const frag of ["218-report", "218-ledger", "218-timeline"]) {
      expect(menus[0]!.title).toContain(frag);
    }
    expect(menus[0]!.options).toEqual(["Deny (block)", "Allow for this session"]);
    expect(rowsAt(mark, "write_approval_approved")).toHaveLength(1); // batch, not ×3
    expect(rowsAt(mark, "decision_menu_deferred_for_approval")).toHaveLength(1);
    const deferred = rowsAt(mark, "decision_menu_deferred_for_approval")[0]!;
    expect(deferred.message.kind).toBe("write");
    expect(deferred.message.outcome).toBe("approved");

    // Queue drained, targets session-allowed (the guard records paths RELATIVE
    // to the project root). An armed menuEscalationPending after the settle (it
    // is cleared only by requestDecision) proves the menu merely slid one turn.
    expect(Object.keys(meta.pendingOwnerApprovals ?? {})).toHaveLength(0);
    const allowed = meta.sessionAllowedWritePaths ?? [];
    for (const rel of ["218-report", "218-ledger", "218-timeline"]) {
      expect(allowed.some((p) => p.endsWith(`notes/${rel}.md`))).toBe(true);
    }
    expect(meta.menuEscalationPending).toBe(true);
    expect(meta.flowState).toBe("blocked"); // approval ≠ unfreeze (T3.5 owns resume)
  });

  // ── Beat 5 — F.4-4b: resume dispatches EXACTLY once through the seam ─────
  it("19:50:52 executeDecision(resume) dispatches the stage executor exactly once", async () => {
    const mark = TIMELINE.length;
    const dispatches: string[] = [];
    // Seam spy stands in for the real RPC dispatch (no subagent runs); it
    // writes the production event name into the shared timeline.
    setResumeDispatchHandler(async (_rctx, _cfg, freshMeta) => {
      dispatches.push(freshMeta.currentStage ?? "none");
      await safeWriteAuditLog("stage_spawn_rpc", {
        pipelineId: freshMeta.pipelineId ?? "unknown",
        stage: freshMeta.currentStage ?? "",
        subagentType: REVIEW_AGENT,
      });
    });

    await executeDecision(ownerCtx() as never, meta, "resume", config, { source: "human" });
    await flush();

    // R8/R12: exactly one dispatch per resume decision — no silent miss, no twin.
    expect(dispatches).toEqual(["review"]);
    expect(rowsAt(mark, "stage_spawn_rpc")).toHaveLength(1);
    expect(rowsAt(mark, "resume_dispatch_invoked")).toHaveLength(1);
    expect(rowsAt(mark, "resume_dispatch_skipped_live")).toHaveLength(0);
    expect(rowsAt(mark, "resume_dispatch_unavailable")).toHaveLength(0);
    expect(meta.flowState).toBe("running"); // resume unfroze

    setResumeDispatchHandler(null);
  });
});
