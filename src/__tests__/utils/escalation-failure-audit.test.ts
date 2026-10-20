/**
 * 208 Phase 0 — J5 failure-path audits:
 * - escalation-bus: a throwing `bus.emit` must not propagate and must leave
 *   an `escalation_broadcast_failed` (error) audit.
 * - index wakeFollowUp: a throwing `pi.sendUserMessage` must not propagate
 *   (plugin stays alive) and must leave an `owner_wake_escalation_failed`
 *   audit — verified through the real plugin hook bridge (createPipeline),
 *   mirroring the owner-wake test trigger.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  broadcastEscalation,
  PIPELINE_ESCALATION_EVENT,
} from "../../utils/escalation-bus";
import type { EscalationPayload } from "../../utils/escalation-bus";
import { createPipeline } from "../../index";
import { setOwnerWakeDeps } from "../../core/owner-wake";
import { registerTerminal, __resetLifecycleRegistry } from "../../utils/subagent-lifecycle-registry";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { PIPELINE_META_CUSTOM_TYPE } from "../../core/session-state";
import type { SessionMeta } from "../../types";

type CapturedAudit = {
  event: string;
  message: Record<string, string | boolean> | undefined;
  level: string | undefined;
};

const audits: CapturedAudit[] = [];

beforeEach(() => {
  audits.length = 0;
  __setSafeWriteAuditLogOverride(async (event, message, level) => {
    audits.push({ event, message, level });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  setOwnerWakeDeps({
    getMeta: () => undefined as SessionMeta | undefined,
    updateMeta: () => undefined as SessionMeta | undefined,
    sendFollowUp: () => {},
    audit: () => {},
    syncStatusBar: () => {},
  });
});

// ─── test 10: escalation broadcast failure ──────────────────────────────────

describe("208 Phase 0 (J5): escalation_broadcast_failed", () => {
  it("test 10: bus.emit throwing → not thrown + error-level audit with reason", () => {
    const pi = {
      events: {
        emit: () => {
          throw new Error("listener blew");
        },
        on: () => {},
        off: () => {},
      },
    };
    const payload: EscalationPayload = {
      pipelineId: "pipe-esc-1",
      stage: "develop",
      reason: "loop_overflow",
      at: Date.now(),
    };

    expect(() => broadcastEscalation(pi, payload)).not.toThrow();

    const audit = audits.find((a) => a.event === "escalation_broadcast_failed");
    expect(audit).toBeDefined();
    expect(audit?.level).toBe("error");
    expect(audit?.message?.["pipelineId"]).toBe("pipe-esc-1");
    expect(audit?.message?.["stage"]).toBe("develop");
    expect(audit?.message?.["reason"]).toBe("loop_overflow");
    expect(String(audit?.message?.["error"])).toContain("listener blew");
  });

  it("test 10: missing bus → silent no-op, no failure audit", () => {
    expect(() => broadcastEscalation({}, {
      pipelineId: "pipe-esc-2",
      stage: "develop",
      reason: "loop_overflow",
      at: Date.now(),
    } as EscalationPayload)).not.toThrow();
    const payloadEvent = audits.find((a) => a.event === PIPELINE_ESCALATION_EVENT);
    expect(payloadEvent).toBeUndefined();
    expect(audits.find((a) => a.event === "escalation_broadcast_failed")).toBeUndefined();
  });
});

// ─── test 11: owner wake followUp failure (via the plugin hook bridge) ──────

describe("208 Phase 0 (J5): owner_wake_escalation_failed", () => {
  it("test 11: throwing sendUserMessage → not thrown + owner_wake_escalation_failed audit", async () => {
    const hookedHandlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
    const mockPi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        hookedHandlers[event] = handler;
      },
      registerTool: () => {},
      registerCommand: () => {},
      registerShortcut: () => {},
      appendEntry: () => {},
      events: { on: () => {}, off: () => {}, emit: () => {} },
      // J5 trigger: the wake followUp dialog explodes in production mock.
      sendUserMessage: () => {
        throw new Error("sendUserMessage bus down");
      },
      exec: undefined,
    };

    const meta = makeTestMeta({
      pipelineId: "pipe-wake-fail",
      currentStage: "develop",
      activeSpawns: {
        develop: { agentId: "agent-123", agentName: "develop-agent", startedAt: Date.now() },
      },
      pendingSpawns: undefined,
    } as Partial<SessionMeta>) as SessionMeta;

    const config = makeTestConfig();
    // NOTE: __resetLifecycleRegistry clears registered terminal observers, so
    // it must run BEFORE createPipeline registers the owner-wake observer.
    __resetLifecycleRegistry();
    const factory = createPipeline(config);
    await factory(mockPi as never);

    // Any hook invocation refreshes the owner-wake deps with the production
    // wakeFollowUp closure. session_shutdown is the lowest-side-effect hook.
    const shutdownHandler = hookedHandlers["session_shutdown"];
    expect(typeof shutdownHandler).toBe("function");
    await shutdownHandler(
      { type: "session_shutdown", reason: "test" },
      {
        ui: { notify: () => {}, setStatus: () => {} },
        sessionManager: {
          getEntries: () => [{ type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: meta }],
          getBranch: () => [],
        },
      },
    );

    // Trigger the terminal wake exactly like owner-wake.test.ts.
    registerTerminal("develop-agent", "agent-123", "terminal", "terminal", "develop", "pipe-wake-fail");

    const failed = audits.find((a) => a.event === "owner_wake_escalation_failed");
    expect(failed).toBeDefined();
    expect(String(failed?.message?.["error"])).toContain("sendUserMessage bus down");
    expect(failed?.message?.["pipelineId"]).toBe("pipe-wake-fail");
    expect(failed?.message?.["stage"]).toBe("develop");
  });
});
