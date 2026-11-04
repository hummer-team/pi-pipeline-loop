/**
 * 223 Phase 0: auto-pipeline owner wake must be recognized as a pipeline turn.
 *
 * Locks the contract that un-stuck the auto pipeline (223_Bug):
 * - auto meta (meta.autoJob set): the wake summary starts with the trusted
 *   `"[plugin auto-settle] "` marker AND the full text matches a registered
 *   `PIPELINE_TURN_SIGNATURES` entry — the "text ↔ signature" binding is
 *   pinned so a future wording drift breaks loudly here instead of silently
 *   re-creating the `agent_settled_non_pipeline_turn` stall;
 * - human meta (meta.autoJob absent): the wake summary is byte-for-byte the
 *   previous literal, and the SAME text under the settle gate still audits
 *   `agent_settled_non_pipeline_turn` (human track untouched);
 * - both `hasPendingSpawns` branches keep the prefix on the FIRST part only.
 *
 * `buildWakeSummary` is module-private, so the text is captured through the
 * production `registerTerminalObserver` + deps harness (`deliver` /
 * `sendFollowUp` stub) — no new export surface is added, and the captured
 * string is the one that actually reaches the owner's last user message.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setOwnerWakeDeps,
  registerOwnerWakeObserver,
  type OwnerWakeDeps,
} from "../../core/owner-wake";
import { registerTerminal, __resetLifecycleRegistry } from "../../utils/subagent-lifecycle-registry";
import { createAgentSettled } from "../../core/agent-settled";
import { PIPELINE_TURN_SIGNATURES } from "../../constants";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";
import type { SessionMeta, PipelineStage } from "../../types";

const AUTO_WAKE_PREFIX = "[plugin auto-settle] ";

function autoJobMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    pipelineId: "pipe-223-auto",
    currentStage: "clarify",
    stageStartTime: Date.now(),
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    activeSpawns: { clarify: { agentId: "agent-223", agentName: "feat-design-plan-agent", startedAt: Date.now() } },
    terminalWake: undefined,
    pendingSpawns: undefined,
    autoJob: {
      jobId: "223bug_loop",
      jobPath: "/tmp/223bug_loop.yaml",
      docIndex: 0,
      totalDocs: 1,
    },
    domain: {} as never,
    ...overrides,
  };
}

function humanMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return autoJobMeta({ ...overrides, autoJob: undefined });
}

/** Terminal-event harness: one registerTerminal → capture the delivered summary. */
function withHarness(
  meta: SessionMeta,
  agentId = "agent-223",
  stage: PipelineStage = "clarify",
) {
  const captured: string[] = [];
  const deps: OwnerWakeDeps = {
    getMeta: () => meta,
    updateMeta: () => {},
    sendFollowUp: (summary) => { captured.push(summary); },
    deliver: (summary) => {
      captured.push(summary);
      return { delivered: true, via: "registry_run_binding" as const };
    },
    audit: () => {},
    syncStatusBar: () => {},
  };
  setOwnerWakeDeps(deps);
  const cleanup = registerOwnerWakeObserver();
  registerTerminal("feat-design-plan-agent", agentId, "terminal", "completed", stage, meta.pipelineId);
  cleanup();
  setOwnerWakeDeps(null);
  return captured;
}

describe("223 Phase 0: owner wake summary gating (auto vs human)", () => {
  beforeEach(() => {
    __resetLifecycleRegistry();
  });

  afterEach(() => {
    __resetLifecycleRegistry();
  });

  it("auto meta: summary starts with the trusted marker and matches a registered PIPELINE_TURN_SIGNATURES entry", () => {
    const captured = withHarness(autoJobMeta());
    expect(captured).toHaveLength(1);
    const text = captured[0]!;

    expect(text.startsWith(AUTO_WAKE_PREFIX)).toBe(true);

    // Bound the "文案 ↔ 签名" contract: the delivered text MUST match the
    // same signature list the settle gate consults.
    const matched = PIPELINE_TURN_SIGNATURES.some((sig) =>
      typeof sig === "string" ? text.startsWith(sig) : sig.test(text),
    );
    expect(matched).toBe(true);
  });

  it("auto meta: prefix is a prefix — the first part body stays the legacy literal", () => {
    const captured = withHarness(autoJobMeta());
    const text = captured[0]!;
    expect(text).toBe(
      `${AUTO_WAKE_PREFIX}Subagent "agent-223" (stage: clarify) has reached terminal state. The current stage has not been closed yet. Pipeline: pipe-223-auto Please review and take appropriate action.`,
    );
  });

  it("human meta: summary is byte-for-byte the pre-223 literal", () => {
    const captured = withHarness(humanMeta());
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(
      `Subagent "agent-223" (stage: clarify) has reached terminal state. The current stage has not been closed yet. Pipeline: pipe-223-auto Please review and take appropriate action.`,
    );
  });

  it("boundary: hasPendingSpawns branches — the marker never lands on the second part", () => {
    // pendingSpawns present → second part is the queued-dispatch sentence.
    const pendingCaptured = withHarness(autoJobMeta({
      pendingSpawns: { plan: { agentName: "develop-agent", requestedAt: Date.now(), attempts: 0 } },
    }));
    expect(pendingCaptured[0]).toContain(
      `The plugin has queued the next stage executor`,
    );
    expect(pendingCaptured[0]!.indexOf(AUTO_WAKE_PREFIX)).toBe(0);

    // No pendingSpawns → second part is the unclosed sentence.
    const emptyCaptured = withHarness(humanMeta());
    expect(emptyCaptured[0]).not.toContain("The plugin has queued");
    expect(emptyCaptured[0]).toContain("The current stage has not been closed yet.");
    expect(emptyCaptured[0]!.startsWith(AUTO_WAKE_PREFIX)).toBe(false);
  });
});

describe("223 Phase 0: human wake text still hits the non-pipeline-turn gate", () => {
  it("the bare human wake summary audited under agent_settled remains agent_settled_non_pipeline_turn", async () => {
    const config = makeTestConfig();
    await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "clarify", verifyAttempts: 0 });
    const ctx = createMockCtx(meta);
    // The EXACT text the human track delivers (captured above), injected as
    // the owner's last user message.
    (ctx._ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [
      {
        type: "message",
        message: {
          role: "user",
          content: `Subagent "agent-223" (stage: clarify) has reached terminal state. The current stage has not been closed yet. Pipeline: pipe-223-auto Please review and take appropriate action.`,
        },
      },
    ];

    const hook = createAgentSettled(config);
    await hook.handler(ctx as never);

    const auditPath = auditLogFileFor(join(config.projectRoot, config.auditDir!));
    const auditContent = await readFile(auditPath, "utf-8");
    expect(auditContent).toContain("agent_settled_non_pipeline_turn");
    expect(meta.verifyAttempts).toBe(0);

    await rm(config.projectRoot, { recursive: true, force: true });
  });
});
