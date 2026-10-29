/**
 * @module freeze-escalation-delivery
 * 218 Phase 3 (T3.1/T3.2/T3.3, Q11-B / Q17-A / F.3-4): the freeze escalation
 * must reach the owner through the DEDUPED DIRECT channel, the owner hook
 * bridge must self-heal a pending escalation, and the settle menu must give
 * pending approvals the slot before the frozen decision menu.
 *
 * Plan case table coverage:
 *  1. child freeze → `deliverOwnerWakeOnce` lands on the resolved owner
 *     (`owner_wake_escalation delivered=true`); an unavailable event bus does
 *     NOT affect delivery (broadcast is observer-only).
 *  2. failed delivery → `owner_wake_escalation_skipped reason=delivery_failed`
 *     and `menuEscalationPending` stays armed (retryable by self-heal).
 *  3. owner per-hook self-heal: pending + blocked → redelivered on the NEXT
 *     owner turn; the SAME turn → `owner_wake_deduped`.
 *  4. approval priority: approval + freeze in one settle → only the approval
 *     is consumed, `menuEscalationPending` stays armed.
 *  5. `no_ui` does NOT count as consumed: the approval STAYS QUEUED and the
 *     headless convergence (policy → decision_provider_absent) still runs.
 *  6. the 211/216 channels are never swallowed by the frozen/enqueue wake
 *     stamp of the same owner turn (both deliver).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPipeline } from "../../index";
import { PIPELINE_META_CUSTOM_TYPE } from "../../core/session-state";
import { freezeAndPrompt } from "../../core/flow-state";
import {
  registerOwnerDelivery,
  __resetOwnerDeliveryRegistry,
} from "../../core/owner-delivery-registry";
import { deliverOwnerWakeOnce } from "../../core/owner-wake-dedupe";
import { evaluateEscalationWake, type OwnerEscalationDeps } from "../../core/owner-escalation";
import {
  CONFIRM_GATE_ESCALATION_REASON,
  currentStageVisitOrder,
} from "../../core/confirm-gate-escalation";
import type { EscalationPayload } from "../../utils/escalation-bus";
import { __setSafeWriteAuditLogOverride, initAuditLog } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { setFixExecutorCompletedHandler } from "../../utils/subagent-rpc";
import { setStageProgressReporter } from "../../utils/stage-progress-sink";
// 218 Phase 3 (T3.5): factory-installed DI seam that must be cleared per test.
import { setResumeDispatchHandler } from "../../core/resume-dispatch";
import { createAgentSettled } from "../../core/agent-settled";
import { commandFingerprint, enqueueOwnerApproval } from "../../core/owner-approval";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import type { SessionMeta } from "../../types";

type AuditRow = { event: string; message: Record<string, unknown>; level?: string };

let audits: AuditRow[];

function captureAudits(): void {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event: string, message: unknown, level?: string) => {
    audits.push({ event, message: (message ?? {}) as Record<string, unknown>, level });
  });
}

/** Child-role runtime ctx (parentSession header) with an optional pi bus. */
function childCtx(meta: SessionMeta, pi: unknown) {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: { notify: () => {}, select: async () => undefined },
    _ctx: {
      sessionManager: {
        getHeader: () => ({ parentSession: "/tmp/parent-session.jsonl" }),
        getSessionName: () => "child-session-218",
        getSessionFile: () => "/tmp/child-session-218.jsonl",
      },
    },
    pi,
  };
}

/** Owner delivery handle recording every accepted wake. */
function registerOwnerHandle(sent: string[]): void {
  registerOwnerDelivery({
    sessionFile: "/sessions/owner-218.jsonl",
    isChild: false,
    getMeta: () => undefined,
    sendFollowUp: (summary: string) => {
      sent.push(summary);
      return true;
    },
    notify: () => {},
    audit: () => {},
  });
}

beforeEach(() => {
  captureAudits();
  __resetOwnerDeliveryRegistry();
  __resetMemoryThrottle();
});

/** Tmp roots created by the createPipeline bridge harness (cleaned per test). */
const tmpDirs: string[] = [];

afterEach(async () => {
  __setSafeWriteAuditLogOverride(null);
  __resetOwnerDeliveryRegistry();
  __resetMemoryThrottle();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("218 T3.1: child freeze escalates via the deduped DIRECT wake", () => {
  // ── Case 1: direct delivery lands on the owner without any bus ───────────
  it("child freeze → wake delivered to the resolved owner; bus unavailable still delivers", async () => {
    const ownerSent: string[] = [];
    registerOwnerHandle(ownerSent);

    const meta = makeTestMeta({ pipelineId: "pipe-218-esc1", currentStage: "review", flowState: "running" });
    const config = makeTestConfig();
    // pi WITHOUT an events bus — the 4.6-1 child-isolated-bus shape.
    await freezeAndPrompt(childCtx(meta, {}) as never, meta, "loop_overflow", config);

    expect(meta.menuEscalationPending).toBe(true);
    // Direct delivery is the ONLY trusted channel — it ran despite the dead bus.
    expect(ownerSent).toHaveLength(1);
    expect(ownerSent[0]).toContain("Pipeline blocked (loop_overflow)");
    expect(ownerSent[0]).toContain('at stage "review"');

    const wake = audits.find((a) => a.event === "owner_wake_escalation");
    expect(wake).toBeDefined();
    expect(wake?.message.delivered).toBe("true");
    expect(wake?.message.via).toBe("registry_non_child");
    // Broadcast stays for in-process observers (fail-safe) with its audit.
    expect(audits.some((a) => a.event === "menu_escalation_armed")).toBe(true);
    expect(audits.some((a) => a.event === "menu_escalation_broadcast")).toBe(true);
    // Stamp written AFTER delivery (217 F2 contract).
    expect(meta.ownerWakeStamp).toBeDefined();
  });

  // ── Case 2: failed delivery stays observable + retryable ─────────────────
  it("delivery failure → owner_wake_escalation_skipped reason=delivery_failed; flag stays armed", async () => {
    // NO owner handle registered → the registry resolves nothing, and the
    // CHILD call site passes no fallback (a child fallback would wake itself).
    const meta = makeTestMeta({ pipelineId: "pipe-218-esc2", currentStage: "develop", flowState: "running" });
    const config = makeTestConfig();
    await freezeAndPrompt(childCtx(meta, {}) as never, meta, "loop_overflow", config);

    expect(meta.menuEscalationPending).toBe(true); // stays armed for the self-heal
    expect(meta.ownerWakeStamp).toBeUndefined(); // failed delivery NEVER stamps
    const skipped = audits.filter((a) => a.event === "owner_wake_escalation_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.message.reason).toBe("delivery_failed");
    expect(skipped[0]?.message.detail).toBe("no_owner_target");
    expect(audits.some((a) => a.event === "owner_wake_escalation")).toBe(false);
  });
});

describe("218 T3.1: the dedup closure keeps 211/216 verbatim", () => {
  // ── Case 6: a stamped turn must not swallow the confirm-gate wake ────────
  it("same owner turn: queued wake then confirm-gate wake → BOTH deliver; frozen channel dedupes", async () => {
    const ownerSent: string[] = [];
    registerOwnerHandle(ownerSent);

    const meta = makeTestMeta({
      pipelineId: "pipe-218-esc6",
      currentStage: "develop",
      flowState: "running",
      confirmGateEscalation: { stage: "develop", visitOrder: currentStageVisitOrder(makeTestMeta({ pipelineId: "pipe-218-esc6", currentStage: "develop" })), at: Date.now() },
    });
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    };

    // (a) Enqueue wake (F.3-4 channel) → delivered + stamps this owner turn.
    const wake = deliverOwnerWakeOnce(session, meta, "queued wake", "enqueue");
    expect(wake.deduped).toBe(false);
    expect(wake.outcome.delivered).toBe(true);

    // (b) Confirm-gate wake through the OBSERVER channel: 211 stays on the
    // verbatim sendFollowUp path — the frozen/enqueue stamp must not eat it.
    const depsSend: string[] = [];
    const depAudits: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const deps: OwnerEscalationDeps = {
      getMeta: () => meta,
      sendFollowUp: (summary: string) => {
        depsSend.push(summary);
        return true;
      },
      syncStatusBar: () => {},
      audit: (event, payload) => depAudits.push({ event, payload }),
      updateMeta: session.updateMeta,
      isOwner: true,
    };
    const confirmPayload: EscalationPayload = {
      pipelineId: meta.pipelineId ?? "",
      stage: "develop",
      reason: CONFIRM_GATE_ESCALATION_REASON,
      at: Date.now(),
    };
    evaluateEscalationWake(confirmPayload, deps);

    expect(depsSend).toHaveLength(1); // delivered despite the stamp
    expect(depAudits.some((a) => a.event === "owner_wake_escalation")).toBe(true);
    expect(audits.some((a) => a.event === "owner_wake_deduped")).toBe(false);

    // (c) Contrast: the FROZEN channel (updateMeta present) shares the wake
    // entry → SAME turn → deduped, no second delivery.
    meta.flowState = "blocked";
    meta.menuEscalationPending = true;
    evaluateEscalationWake(
      { pipelineId: meta.pipelineId ?? "", stage: "develop", reason: "loop_overflow", at: Date.now() },
      deps,
    );
    expect(depsSend).toHaveLength(1); // frozen wake DEDUPED (not sent again)
    expect(audits.some((a) => a.event === "owner_wake_deduped")).toBe(true);
  });
});

describe("218 T3.2: owner hook-bridge self-heal", () => {
  /**
   * Drive the REAL hook bridge (createPipeline + fake pi): mutable entries
   * array + pi.appendEntry so `session.getMeta()` re-reads the wake stamp;
   * shared meta.json (TMP/.pi/audit/{pipelineId}/meta.json) is the
   * authoritative source once the first updateMeta dual-write lands.
   */
  async function makeSelfHealHarness(meta: SessionMeta) {
    const TMP = join(tmpdir(), "pi-218-selfheal-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    tmpDirs.push(TMP);
    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });

    const entries: Array<{ type: string; customType: string; data: unknown }> = [
      { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: meta },
    ];
    const sent: string[] = [];
    const registered: Array<{ event: string; handler: Function }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pi: any = {
      on: (event: string, handler: Function) => registered.push({ event, handler }),
      registerTool: () => {},
      registerCommand: () => {},
      registerShortcut: () => {},
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
      },
      sendUserMessage: (msg: string) => {
        sent.push(msg);
      },
      events: { emit: () => {}, on: () => {} },
      exec: undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extCtx: any = {
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => [],
        getSessionFile: () => "/sessions/owner-selfheal-218.jsonl",
        getHeader: () => undefined,
        getSessionName: () => "owner-selfheal-218",
      },
    };

    const factory = createPipeline(config);
    await factory(pi);

    // Process-global DI cleanup discipline (index-registration precedent):
    // the factory installs the fix-executor handler, the stage-progress
    // sink and the resume-dispatch seam; leaving them set leaks into other
    // files' "un-wired" assertions.
    setFixExecutorCompletedHandler(null);
    setStageProgressReporter(null);
    setResumeDispatchHandler(null);

    const metaPath = join(TMP, ".pi", "audit", meta.pipelineId ?? "", "meta.json");

    /** Read the authoritative shared snapshot (seed meta until first write). */
    const currentMeta = async (): Promise<SessionMeta> => {
      try {
        return JSON.parse(await readFile(metaPath, "utf-8")) as SessionMeta;
      } catch {
        return meta;
      }
    };

    return {
      sent,
      /** Fire one registered hook handler through the bridge. */
      fire: async (event: string): Promise<void> => {
        const h = registered.find((r) => r.event === event);
        if (!h) throw new Error(`handler for ${event} not registered`);
        await h.handler({}, extCtx);
      },
      /** Drain the fire-and-forget audit queue. */
      flush: (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10)),
      /** Simulate the settle-`finally` turn advance on the shared snapshot. */
      bumpOwnerTurn: async (): Promise<void> => {
        const cur = await currentMeta();
        await writeFile(metaPath, JSON.stringify({ ...cur, ownerTurnSeq: (cur.ownerTurnSeq ?? 0) + 1 }));
      },
      /** Patch the shared snapshot (e.g. the settle path consumed the flag). */
      patchSharedMeta: async (patch: Partial<SessionMeta>): Promise<void> => {
        const cur = await currentMeta();
        await writeFile(metaPath, JSON.stringify({ ...cur, ...patch }));
      },
    };
  }

  // ── Case 3: retry token = persistent `menuEscalationPending` ─────────────
  it("pending + blocked: delivered once per owner turn, deduped within a turn, stops when the flag clears", async () => {
    const meta = makeTestMeta({
      pipelineId: "pipe-218-sh",
      currentStage: "review",
      flowState: "blocked",
      menuEscalationPending: true,
      ownerTurnSeq: 0,
    });
    const h = await makeSelfHealHarness(meta);

    // Turn 1, hook A: self-heal delivers through the bridge and audits.
    await h.fire("message_end");
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('Pipeline is still blocked at stage "review"');
    expect(h.sent[0]).toContain("The decision menu will appear when this turn ends.");
    const selfHeals = () => audits.filter((a) => a.event === "menu_escalation_selfheal");
    expect(selfHeals()).toHaveLength(1);
    expect(selfHeals()[0]?.message.delivered).toBe("true");
    expect(selfHeals()[0]?.message.stage).toBe("review");

    // Turn 1, hook B: SAME dedupe key → no second send, only deduped audit.
    await h.fire("message_end");
    await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(selfHeals()).toHaveLength(1);
    expect(audits.some((a) => a.event === "owner_wake_deduped")).toBe(true);

    // Turn 2 (ownerTurnSeq advanced): the armed flag re-wakes once.
    await h.bumpOwnerTurn();
    await h.fire("message_end");
    await h.flush();
    expect(h.sent).toHaveLength(2);
    expect(selfHeals()).toHaveLength(2);

    // Menu consumed (flag cleared): the self-heal stops.
    await h.patchSharedMeta({ menuEscalationPending: false });
    await h.bumpOwnerTurn();
    await h.fire("message_end");
    await h.flush();
    expect(h.sent).toHaveLength(2);
    expect(selfHeals()).toHaveLength(2);
  });
});

describe("218 T3.3: pending approvals take the frozen settle slot", () => {
  // ── Case 4: ONE interaction per settle — approval first ──────────────────
  it("approval + freeze in one settle → only the approval is consumed; menuEscalationPending stays armed", async () => {
    const TMP = join(tmpdir(), "pi-218-settle4-" + Date.now());
    await mkdir(TMP, { recursive: true });
    tmpDirs.push(TMP);
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      pipelineId: "pipe-218-ap4",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      menuEscalationPending: true,
    });
    const ctx = createMockCtx(meta, { selectReturn: "Allow for this session" });
    const fingerprint = enqueueOwnerApproval(ctx.session, "develop", "rm -rf node_modules").fingerprint;

    const hook = createAgentSettled(config);
    await hook.handler(ctx as never);

    // The approval consumed the settle slot...
    expect(meta.pendingOwnerApprovals?.[fingerprint]).toBeUndefined();
    expect(meta.sessionAllowedCommands ?? []).toContain("rm -rf node_modules");
    // ...recorded with the dedicated audit (in-memory capture path).
    const deferred = audits.find((a) => a.event === "decision_menu_deferred_for_approval");
    expect(deferred).toBeDefined();
    expect(deferred?.message.kind).toBe("command");
    expect(deferred?.message.outcome).toBe("approved");
    expect(audits.some((a) => a.event === "destructive_command_approved")).toBe(true);
    // The frozen menu did NOT run: menuEscalationPending is consumed only by
    // requestDecision, so an armed flag after the settle proves no menu ran.
    expect(meta.menuEscalationPending).toBe(true);
  });

  // ── Case 5: "no_ui" is NOT a consumption — the queue keeps the entry ─────
  it("declared no-UI → approval STAYS QUEUED and the headless convergence still aborts", async () => {
    const TMP = join(tmpdir(), "pi-218-settle5-" + Date.now());
    await mkdir(TMP, { recursive: true });
    tmpDirs.push(TMP);
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    // Policy ON: the headless exit for a frozen pipeline is the provider-chain
    // convergence (no rule → `decision_provider_absent` abort).
    config.decisionPolicy = { ...(config.decisionPolicy ?? {}), enabled: true };
    const meta = makeTestMeta({
      pipelineId: "pipe-218-ap5",
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      menuEscalationPending: true,
    });
    const ctx = createMockCtx(meta);
    (ctx as Record<string, unknown>).hasUI = false; // declared capability wins over select
    const fingerprint = enqueueOwnerApproval(ctx.session, "develop", "git push --force").fingerprint;

    const hook = createAgentSettled(config);
    await hook.handler(ctx as never);

    // "no_ui" did NOT take the slot: the request stays queued...
    expect(meta.pendingOwnerApprovals?.[fingerprint]).toBeDefined();
    expect(audits.some((a) => a.event === "owner_approval_no_ui")).toBe(true);
    expect(audits.some((a) => a.event === "decision_menu_deferred_for_approval")).toBe(false);
    // ...and the frozen-menu convergence ran: blocked → aborted, so the T3.2
    // self-heal predicate (flowState === "blocked") stops re-waking.
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("decision_provider_absent");
    expect(audits.some((a) => a.event === "pipeline_session_aborted")).toBe(true);
  });
});
