/**
 * 211_Bug Phase 1: one-shot arm credential + `confirm_gate_pending` wake
 * channel (`src/core/confirm-gate-escalation.ts`).
 *
 * Coverage:
 * - arm: first arm / same-visit idempotence / `pi` missing no-op / re-arm on
 *   visitOrder growth (rework re-entry)
 * - clear: only when a credential is present (idempotent)
 * - wake summary: never resembles a pipeline turn (signature + bare-form)
 * - child suppression via the real gate: broadcast once, audit ORDER
 *   `confirm_gate_suppressed_child` → `confirm_gate_escalation_armed`
 * - consumption: presentation clears the credential; gate resolution clears it
 *   together with the re-ask bookkeeping (230 single accounting point)
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  armConfirmGateEscalation,
  clearConfirmGateEscalation,
  buildConfirmGatePendingWakeSummary,
  CONFIRM_GATE_ESCALATION_REASON,
} from "../../core/confirm-gate-escalation";
import {
  maybeHandleConfirmGate,
  recordConfirmGateOutcome,
  type ConfirmGateResult,
} from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import {
  makePlanConfigWithConfirm,
  setupConfirmGateTmpDir,
  getTmpDir,
} from "./confirm-gate-test-helpers";
import { PIPELINE_ESCALATION_EVENT, type EscalationPayload } from "../../utils/escalation-bus";
import { PIPELINE_TURN_SIGNATURES } from "../../constants";
import type { SessionMeta } from "../../types";

setupConfirmGateTmpDir();

// ── Mock bus capture ─────────────────────────────────────────────────────────

function makeBusCapture() {
  const emitted: Array<{ event: string; payload: EscalationPayload }> = [];
  return {
    emitted,
    pi: {
      events: {
        emit: (event: string, payload: Record<string, unknown>) => {
          emitted.push({ event, payload: payload as unknown as EscalationPayload });
        },
        on: (_event: string, _handler: (payload: unknown) => void) => {
          return () => {};
        },
      },
    },
  };
}

/** Counting session double so updateMeta writes are observable. */
function makeCountingSession(meta: SessionMeta) {
  const updates: Partial<SessionMeta>[] = [];
  return {
    session: {
      getMeta: (): SessionMeta | undefined => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        updates.push(patch);
        Object.assign(meta, patch);
        return meta;
      },
    },
    updates,
  };
}

// ── armConfirmGateEscalation ─────────────────────────────────────────────────

describe("211 Phase 1: armConfirmGateEscalation", () => {
  it("first arm ⇒ credential written, broadcast once, audit once, returns true", async () => {
    const { pi, emitted } = makeBusCapture();
    const meta = makeTestMeta({ currentStage: "plan" });
    const { session, updates } = makeCountingSession(meta);

    const armed = await armConfirmGateEscalation({ pi, session, meta, stage: "plan" });

    expect(armed).toBe(true);
    expect(updates).toHaveLength(1);
    expect(meta.confirmGateEscalation).toMatchObject({ stage: "plan", visitOrder: 0 });
    const escalations = emitted.filter((e) => e.event === PIPELINE_ESCALATION_EVENT);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].payload).toMatchObject({
      pipelineId: meta.pipelineId,
      stage: "plan",
      reason: CONFIRM_GATE_ESCALATION_REASON,
    });
    const logContent = await fs.readFile(
      auditLogFileFor(join(getTmpDir(), ".pi", "audit")),
      "utf-8",
    );
    expect(logContent).toContain("confirm_gate_escalation_armed");
  });

  it("same visit (same stage + visitOrder) ⇒ idempotent: no write, no broadcast, returns false", async () => {
    const { pi, emitted } = makeBusCapture();
    const meta = makeTestMeta({
      currentStage: "plan",
      confirmGateEscalation: { stage: "plan", visitOrder: 0, at: Date.now() },
    });
    const { session, updates } = makeCountingSession(meta);

    const armed = await armConfirmGateEscalation({ pi, session, meta, stage: "plan" });

    expect(armed).toBe(false);
    expect(updates).toHaveLength(0);
    expect(emitted.filter((e) => e.event === PIPELINE_ESCALATION_EVENT)).toHaveLength(0);
  });

  it("pi missing ⇒ pure no-op: zero updateMeta, zero broadcast, returns false", async () => {
    const meta = makeTestMeta({ currentStage: "plan" });
    const { session, updates } = makeCountingSession(meta);

    const armed = await armConfirmGateEscalation({ pi: undefined, session, meta, stage: "plan" });

    expect(armed).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("visitOrder grew (rework re-entry) ⇒ re-arm allowed once per visit", async () => {
    const { pi, emitted } = makeBusCapture();
    const meta = makeTestMeta({
      currentStage: "plan",
      confirmGateEscalation: { stage: "plan", visitOrder: 0, at: Date.now() },
      stageVisitOrder: ["clarify", "plan", "design-review", "plan"] as SessionMeta["stageVisitOrder"],
    });
    const { session, updates } = makeCountingSession(meta);

    const armed = await armConfirmGateEscalation({ pi, session, meta, stage: "plan" });

    expect(armed).toBe(true);
    expect(updates).toHaveLength(1);
    expect(meta.confirmGateEscalation?.visitOrder).toBe(4);
    expect(emitted.filter((e) => e.event === PIPELINE_ESCALATION_EVENT)).toHaveLength(1);
  });
});

// ── clearConfirmGateEscalation ───────────────────────────────────────────────

describe("211 Phase 1: clearConfirmGateEscalation", () => {
  it("credential present ⇒ exactly one clear write; absent ⇒ zero writes", () => {
    const armed = makeTestMeta({
      confirmGateEscalation: { stage: "plan", visitOrder: 0, at: Date.now() },
    });
    const armedOnce = makeCountingSession(armed);
    clearConfirmGateEscalation(armedOnce.session, armed);
    expect(armedOnce.updates).toHaveLength(1);
    expect(armed.confirmGateEscalation).toBeUndefined();
    // Idempotent: a second clear on credential-free meta writes nothing.
    clearConfirmGateEscalation(armedOnce.session, armed);
    expect(armedOnce.updates).toHaveLength(1);

    const clean = makeTestMeta();
    const cleanOnce = makeCountingSession(clean);
    clearConfirmGateEscalation(cleanOnce.session, clean);
    expect(cleanOnce.updates).toHaveLength(0);
  });
});

// ── buildConfirmGatePendingWakeSummary ───────────────────────────────────────

describe("211 Phase 1: buildConfirmGatePendingWakeSummary", () => {
  /**
   * Local mirror of the private `isBarePipelineTurn` check (agent-settled.ts)
   * — the wake text must fall into the NON-pipeline branch on the owner so
   * the Phase 0 entry presents the gate.
   */
  function looksLikeBarePipelineTurn(message: string, requirementDoc: string): boolean {
    return new RegExp(`^${requirementDoc}\\s*(\\d+\\s*答|full-und\\?|\\d+$)`).test(message);
  }

  it("wake text hits NO pipeline turn signature and no bare-doc form", () => {
    const summary = buildConfirmGatePendingWakeSummary("plan");

    // Not a @mention wake.
    expect(summary.startsWith("@")).toBe(false);
    expect(summary.startsWith("docs/")).toBe(false);
    // Every static signature misses.
    for (const sig of PIPELINE_TURN_SIGNATURES) {
      if (typeof sig === "string") {
        expect(summary.startsWith(sig)).toBe(false);
      } else {
        expect(sig.test(summary)).toBe(false);
      }
    }
    // Bare-form (doc + round arg) impossible: the text carries no doc prefix.
    expect(looksLikeBarePipelineTurn(summary, "docs/design/x.md")).toBe(false);
    // Owner-facing actionability: names the deterministic exit.
    expect(summary).toContain("/pipeline-resume");
  });
});

// ── Child suppression arm via the real gate ──────────────────────────────────

describe("211 Phase 1: child gate suppression arms the wake", () => {
  it("maybeHandleConfirmGate(isChild) ⇒ broadcast confirm_gate_pending, deferred:true, audit order suppressed_child → escalation_armed", async () => {
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const { pi, emitted } = makeBusCapture();
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/tmp/parent.jsonl" },
      sessionFile: "/tmp/child.jsonl",
      // The arm feeds off ctx.pi — supply the bus through the mock.
      pi: pi as unknown as { sendUserMessage: (msg: string, opts?: Record<string, unknown>) => void },
    });
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    const result = await maybeHandleConfirmGate(config, ctx as never, meta, ctx.ui as never, {
      mode: "manual",
      isChild: true,
      sessionFile: "/tmp/child.jsonl",
    } as never);

    // 181 outcome unchanged: suppressed, deferred, zero popup.
    expect(result.result).toBe("handled");
    expect(result).toMatchObject({ action: "pending", deferred: true });
    expect(selectCalls).toBe(0);
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    // One-shot arm performed with the child's own pi bus context.
    expect(meta.confirmGateEscalation).toMatchObject({ stage: "plan", visitOrder: 0 });
    const escalations = emitted.filter((e) => e.event === PIPELINE_ESCALATION_EVENT);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].payload.reason).toBe(CONFIRM_GATE_ESCALATION_REASON);

    // Review #3: audit ORDER — suppression is the chain's first event.
    const logContent = await fs.readFile(
      auditLogFileFor(join(tmpDir, ".pi", "audit")),
      "utf-8",
    );
    const suppressed = logContent.indexOf("confirm_gate_suppressed_child");
    const armedLine = logContent.indexOf("confirm_gate_escalation_armed");
    expect(suppressed).toBeGreaterThanOrEqual(0);
    expect(armedLine).toBeGreaterThan(suppressed);

    // Same visit again ⇒ another suppression audit but NO second arm.
    await maybeHandleConfirmGate(config, ctx as never, meta, ctx.ui as never, {
      mode: "manual",
      isChild: true,
      sessionFile: "/tmp/child.jsonl",
    } as never);
    const log2 = await fs.readFile(
      auditLogFileFor(join(tmpDir, ".pi", "audit")),
      "utf-8",
    );
    const armedCount = log2.match(/confirm_gate_escalation_armed/g)?.length ?? 0;
    expect(armedCount).toBe(1);
  });
});

// ── Consumption points ───────────────────────────────────────────────────────

describe("211 Phase 1: credential consumption points", () => {
  it("presentation (owner dialog) clears the credential — same visit never re-wakes", async () => {
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateEscalation: { stage: "plan", visitOrder: 0, at: Date.now() },
    });
    const ctx = createMockCtx(meta, { selectReturn: undefined }); // Esc → pending

    const result = await maybeHandleConfirmGate(config, ctx as never, meta, ctx.ui as never, {
      mode: "manual",
    } as never);

    expect(result.result).toBe("handled");
    expect(result).toMatchObject({ action: "pending" });
    expect(meta.confirmGateEscalation).toBeUndefined();
  });

  it("gate resolution (advanced) clears credential AND reask together (single accounting point)", () => {
    const meta = makeTestMeta({
      currentStage: "plan",
      confirmGateEscalation: { stage: "plan", visitOrder: 0, at: Date.now() },
      confirmGateReask: { stage: "plan", count: 2 },
    });
    const gate: ConfirmGateResult = { result: "handled", action: "advanced", toStage: "develop" };
    const { session, updates } = makeCountingSession(meta);

    recordConfirmGateOutcome(session, meta, gate, false);

    expect(updates).toHaveLength(1);
    expect(meta.confirmGateEscalation).toBeUndefined();
    expect(meta.confirmGateReask).toBeUndefined();
  });
});
