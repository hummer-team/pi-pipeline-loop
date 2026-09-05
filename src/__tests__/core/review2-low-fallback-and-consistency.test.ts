/**
 * @module review2-low-fallback-and-consistency
 * Tests for review#2 Low items:
 * - Fallback spawn does not write activeSpawns entry (no agentId → no false positive)
 * - prompt-injector probe=unknown falls back to time-window (aligned with tool-guard)
 * - formatAbortedNotifyText real content snapshot (replaces fake self-comparison)
 *
 * Each test asserts real behavior; removing the implementation must turn the test red.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnStageSubagent } from "../../utils/subagent-rpc";
import { probeAgentState } from "../../utils/subagents-introspect";
import { createPromptInjector } from "../../core/prompt-injector";
import { formatAbortedNotifyText } from "../../core/flow-state";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { resetPromptConfigCache } from "../../core/prompt-config";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

async function writeAgentFile(
  projectRoot: string,
  agentPath: string,
  name: string,
): Promise<void> {
  const fullPath = path.join(projectRoot, agentPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(fullPath, `---\nname: ${name}\n---\n# Agent\n`);
}

describe("Low: fallback spawn skips activeSpawns write", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-r2-low-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
  });

  it("fallback spawn writes spawnedStages but NOT activeSpawns (no agentId)", async () => {
    await writeAgentFile(TMP, ".pi/agents/fix-agent.md", "fix-agent");
    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        ...makeTestConfig().stages,
        fix: {
          agentPath: ".pi/agents/fix-agent.md",
          skillPath: "fix/SKILL.md",
          nextStage: "develop",
          requireDomain: false,
        },
      },
    } as any);
    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-fallback",
      stageStartTime: Date.now(),
    });

    // pi with only sendUserMessage (no event bus) → fallback path
    const sentMessages: string[] = [];
    const mockPi = {
      sendUserMessage: (msg: string) => {
        sentMessages.push(msg);
      },
    };

    const sessionMeta = { ...meta };
    const session = {
      getMeta: () => sessionMeta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(sessionMeta, patch);
        return sessionMeta;
      },
    };

    const result = await spawnStageSubagent(mockPi as any, config, "fix", meta, {
      ui: { notify: () => {} },
      session,
    });

    expect(result.spawned).toBe(true);
    expect(result.fallback).toBe(true);
    expect(sentMessages.length).toBe(1);
    // spawnedStages guard written (idempotency preserved)
    expect(sessionMeta.spawnedStages?.fix).toBe(meta.stageStartTime);
    // activeSpawns NOT written (no agentId → no false-positive block window)
    expect(sessionMeta.activeSpawns).toBeUndefined();
  });
});

describe("Low: prompt-injector probe=unknown consistency", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-r2-low-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
    resetPromptConfigCache();
  });

  afterEach(async () => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
    resetPromptConfigCache();
  });

  // review#3 M4 fix: this test now exercises the prompt-injector's buildStageExecutor
  // probe=unknown degradation branch (822a503). The previous version tested tool-guard
  // instead, which was a misnamed duplicate of E4. This test calls createPromptInjector
  // handler and asserts the system prompt contains the "Active spawn" note when
  // probe=unknown + <30min (time-window degradation). Removing the probe=unknown branch
  // from prompt-injector → isLive stays false → no active spawn note → test turns red.
  it("probe=unknown + <30min → prompt-injector injects Active spawn note (time-window degradation)", async () => {
    // Manager singleton absent → probeAgentState returns "unknown"
    expect(probeAgentState("subagent-unknown-low")).toBe("unknown");

    const config = makeTestConfig({ projectRoot: TMP });
    const agentPath = config.stages["plan"].agentPath!;
    await writeAgentFile(TMP, agentPath, "feat-design-plan-agent");

    // Meta with activeSpawns for plan stage (recent spawn, < 30min)
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: {
        plan: {
          agentName: "feat-design-plan-agent",
          agentId: "subagent-unknown-low",
          startedAt: Date.now() - 1000, // 1s ago, < 30min
        },
      },
    });
    const ctx = { session: { getMeta: () => meta } };

    // Exercise the prompt-injector hook (not tool-guard)
    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    // The system prompt must contain the Active spawn note.
    // This proves that prompt-injector's buildStageExecutor correctly degrades
    // probe=unknown to the 30-min time-window check (aligned with tool-guard).
    // Removing the `else if (probe === "unknown")` branch from prompt-injector →
    // isLive stays false → no "Active spawn" note → test turns red.
    expect(result.systemPrompt).toBeDefined();
    expect(result.systemPrompt).toContain("Active spawn");
    expect(result.systemPrompt).toContain("feat-design-plan-agent");
  });
});

describe("Low: formatAbortedNotifyText real content snapshot", () => {
  // review#2 Low: replace self-comparison with real content assertion.
  it("contains stage, reason, doc hint, and /pipeline-start path", () => {
    const text = formatAbortedNotifyText("plan", "session_quit", "docs/test.md");
    expect(text).toContain("plan");
    expect(text).toContain("session_quit");
    expect(text).toContain("docs/test.md");
    expect(text).toContain("/pipeline-start docs/test.md");
    // Pin the output shape
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
