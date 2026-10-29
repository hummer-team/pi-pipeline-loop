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
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { makeTestConfig, makeTestMeta } from "../helpers";
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

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetOwnerDeliveryRegistry();
  __resetMemoryThrottle();
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
