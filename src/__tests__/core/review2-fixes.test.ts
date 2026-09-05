/**
 * @module review2-fixes
 * Tests for code_review_171_E2E_Flow_Bug_plan_2.md (review#2) fixes.
 *
 * Coverage matrix:
 * - High / Matrix D: adopt 三态 (running/blocked reject, aborted adopt, no-candidate fresh)
 * - High / Matrix E: activeSpawns lifecycle (spawn write + lifecycle clear + probe→3c)
 * - M4: settle-retry binding on unbound+resolvable; silent on unbound+unresolvable
 *
 * review#3 M4 dedup: M2/M3/Low-fallback duplicates removed (now in dedicated files:
 * review2-m2-forward-args.test.ts, review2-m3-resume-session.test.ts,
 * review2-low-fallback-and-consistency.test.ts).
 *
 * Each test asserts a real behavior; removing the corresponding implementation must turn
 * the test red (no empty/typeof assertions).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  createPipelineStartCommand,
} from "../../commands/pipeline-start";
import { createAgentSettled } from "../../core/agent-settled";
import { createToolGuard } from "../../core/tool-guard";
import { probeAgentState } from "../../utils/subagents-introspect";
import { spawnStageSubagent } from "../../utils/subagent-rpc";
import {
  makeTestConfig,
  makeTestMeta,
  createMockCtx,
} from "../helpers";
import type { SessionMeta, PipelineStage } from "../../types";
import {
  initAuditLog,
  getDateAuditFileName,
  __resetAuditDirPath,
} from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";

// ─── Helper: write an agent file for resolveAgentMention ─────────────────────

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

// ─── High / Matrix D: adopt 三态 ─────────────────────────────────────────────
//
// Phase 3 (171) Q4-A: on fresh-start with mode=auto, scan auditDir for adoptable
// non-terminal flows. Three observable states:
//   1) running/blocked candidate elsewhere → reject (no double-start)
//   2) aborted candidate → adopt (pipelineId preserved, registerSession called)
//   3) no candidate → fresh start (new pipelineId)

describe("Matrix D: adopt 三态", () => {
  let TMP: string;
  let AUDIT_DIR: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-r2-adopt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    AUDIT_DIR = path.join(TMP, ".pi", "audit");
    await fsp.mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
  });

  async function writeCandidatePipelineDir(meta: SessionMeta): Promise<void> {
    // scanAuditFlows reads auditDir/pipe-*/meta.json
    const pipelineDir = path.join(AUDIT_DIR, meta.pipelineId ?? "pipe-unknown");
    await fsp.mkdir(pipelineDir, { recursive: true });
    await fsp.writeFile(
      path.join(pipelineDir, "meta.json"),
      JSON.stringify(meta),
      "utf-8",
    );
  }

  it("D1: running candidate elsewhere → reject with decision-menu hint (no double-start)", async () => {
    const docRelPath = "docs/design/feature.md";
    await fsp.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fsp.writeFile(path.join(TMP, docRelPath), "# Feature\nContent", "utf-8");

    // Write a running-candidate pipeline for the same doc
    await writeCandidatePipelineDir(
      makeTestMeta({
        pipelineId: "pipe-running-elsewhere",
        currentStage: "plan",
        flowState: "running",
        requirementDoc: docRelPath,
        stageStartTime: Date.now(),
      }),
    );

    const config = makeTestConfig({ projectRoot: TMP, startStageMode: "auto" });
    const cmd = createPipelineStartCommand(config);
    const freshMeta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = createMockCtx(freshMeta, { sessionFile: "main-session" });

    const result: any = await cmd.execute({ file: docRelPath }, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("pipe-running-elsewhere");
    expect(result.error).toContain("running");
  });

  it("D2: blocked candidate elsewhere → also reject (blocked counts as live)", async () => {
    const docRelPath = "docs/design/feature.md";
    await fsp.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fsp.writeFile(path.join(TMP, docRelPath), "# Feature\nContent", "utf-8");

    await writeCandidatePipelineDir(
      makeTestMeta({
        pipelineId: "pipe-blocked-elsewhere",
        currentStage: "plan",
        flowState: "blocked",
        blockedReason: "loop_overflow",
        requirementDoc: docRelPath,
        stageStartTime: Date.now(),
      }),
    );

    const config = makeTestConfig({ projectRoot: TMP, startStageMode: "auto" });
    const cmd = createPipelineStartCommand(config);
    const freshMeta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = createMockCtx(freshMeta, { sessionFile: "main-session" });

    const result: any = await cmd.execute({ file: docRelPath }, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("pipe-blocked-elsewhere");
    expect(result.error).toContain("blocked");
  });

  it("D3: aborted candidate → adopt (pipelineId preserved + registerSession)", async () => {
    const docRelPath = "docs/design/feature.md";
    await fsp.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fsp.writeFile(path.join(TMP, docRelPath), "# Feature\nContent", "utf-8");

    const adoptedPipelineId = "pipe-aborted-adopted";
    await writeCandidatePipelineDir(
      makeTestMeta({
        pipelineId: adoptedPipelineId,
        currentStage: "plan",
        flowState: "aborted",
        terminateReason: "session_quit",
        requirementDoc: docRelPath,
        stageStartTime: Date.now(),
      }),
    );

    const config = makeTestConfig({ projectRoot: TMP, startStageMode: "auto" });
    const cmd = createPipelineStartCommand(config);
    const freshMeta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = createMockCtx(freshMeta, {
      sessionFile: "/sessions/main.md",
    });

    const result: any = await cmd.execute({ file: docRelPath }, ctx as any);

    // Adopt path goes through resumePipeline → success=true, message includes "resumed"
    expect(result.success).toBe(true);
    expect(result.pipelineId).toBe(adoptedPipelineId);
    // PipelineId must be preserved (not regenerated)
    expect(ctx.session.getMeta().pipelineId).toBe(adoptedPipelineId);
    // Resume resets flowState to running
    expect(ctx.session.getMeta().flowState).toBe("running");
  });

  it("D4: no candidate → fresh start (new pipelineId, clarify stage)", async () => {
    const docRelPath = "docs/design/feature.md";
    await fsp.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fsp.writeFile(path.join(TMP, docRelPath), "# Feature\nContent", "utf-8");

    // No candidate pipeline dir in auditDir

    const config = makeTestConfig({ projectRoot: TMP, startStageMode: "auto" });
    const cmd = createPipelineStartCommand(config);
    const freshMeta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = createMockCtx(freshMeta, { sessionFile: "main-session" });

    const result: any = await cmd.execute({ file: docRelPath }, ctx as any);

    expect(result.success).toBe(true);
    expect(result.currentStage).toBe("clarify");
    // Fresh start generates a new pipelineId
    expect(result.pipelineId).toMatch(/^pipe-/);
    expect(result.pipelineId).not.toBe("");
  });
});

// ─── High / Matrix E: activeSpawns lifecycle ─────────────────────────────────

describe("Matrix E: activeSpawns lifecycle", () => {
  let TMP: string;
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-r2-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
  });

  it("E1: spawnStageSubagent with session writes activeSpawns[stage] on RPC success", async () => {
    await writeAgentFile(TMP, ".pi/agents/dev-agent.md", "develop-agent");
    const config = makeTestConfig({
      projectRoot: TMP,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: ".pi/agents/dev-agent.md",
          skillPath: "develop/SKILL.md",
          nextStage: "review",
          requireDomain: false,
        },
      },
    } as any);
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-e1",
      stageStartTime: Date.now(),
    });

    // Build mock pi with event bus that responds to ping+spawn successfully
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const bus = {
      emit(event: string, payload: Record<string, unknown>) {
        if (event === "subagents:rpc:ping") {
          setTimeout(
            () =>
              (handlers
                .get(`subagents:rpc:ping:reply:${payload.requestId}`) ?? [])
                .forEach((h) => h({ success: true })),
            5,
          );
        } else if (event === "subagents:rpc:spawn") {
          setTimeout(
            () =>
              (handlers
                .get(`subagents:rpc:spawn:reply:${payload.requestId}`) ?? [])
                .forEach((h) =>
                  h({ success: true, data: { id: "subagent-e1-xyz" } }),
                ),
            5,
          );
        }
      },
      on(event: string, handler: (payload: unknown) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      off(event: string, handler: (payload: unknown) => void) {
        const list = handlers.get(event);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        }
      },
    };
    const mockPi = { events: bus };

    const sessionMeta = { ...meta };
    const session = {
      getMeta: () => sessionMeta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(sessionMeta, patch);
        return sessionMeta;
      },
    };

    const result = await spawnStageSubagent(mockPi as any, config, "develop", meta, {
      ui: { notify: () => {} },
      session,
    });

    expect(result.spawned).toBe(true);
    // activeSpawns.develop must be written with agentId from RPC result
    expect(sessionMeta.activeSpawns?.develop).toBeDefined();
    const spawnRecord = sessionMeta.activeSpawns?.develop;
    expect(spawnRecord?.agentId).toBe("subagent-e1-xyz");
    expect(spawnRecord?.agentName).toBe("develop-agent");
    // spawnedStages guard also written
    expect(sessionMeta.spawnedStages?.develop).toBe(meta.stageStartTime);
  });

  it("E2: probe=live → checkLiveSpawn returns entry (3c hard-block trigger)", async () => {
    // Inject a live manager singleton
    const manager = { getRecord: (_id: string) => ({ status: "running" }) };
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = manager;

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = {
      ...config.stages["plan"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: {
        plan: {
          agentName: "feat-design-plan-agent",
          agentId: "subagent-live-1",
          startedAt: Date.now(),
        },
      },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result: any = await hook.handler(ctx as any);

    // With manager singleton reporting live → probe=live → 3c hard-block
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("already running");
  });

  it("E3: probe=settled → checkLiveSpawn returns null (no block)", async () => {
    const manager = { getRecord: (_id: string) => ({ status: "completed" }) };
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = manager;

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = {
      ...config.stages["plan"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: {
        plan: {
          agentName: "feat-design-plan-agent",
          agentId: "subagent-settled-1",
          startedAt: Date.now() - 1000,
        },
      },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result: any = await hook.handler(ctx as any);

    // Settled → do not block
    expect(result).toBeUndefined();
  });

  it("E4: probe=unknown + <30min → fall through to time-window block", async () => {
    // Manager singleton absent → probeAgentState returns "unknown"
    // review#2 Low consistency fix: tool-guard's checkLiveSpawn falls through to
    // the 30min time-window check, so unknown + fresh entry still blocks.
    expect(probeAgentState("subagent-unknown-1")).toBe("unknown");

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = {
      ...config.stages["plan"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: {
        plan: {
          agentName: "feat-design-plan-agent",
          agentId: "subagent-unknown-1",
          startedAt: Date.now() - 1000, // 1s ago, < 30min
        },
      },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result: any = await hook.handler(ctx as any);

    // Unknown + fresh → time-window says live → block
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
  });

  it("E5: probe=unknown + >30min → time-window says stale → no block", async () => {
    expect(probeAgentState("subagent-unknown-2")).toBe("unknown");

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = {
      ...config.stages["plan"],
      guard: { suppressDuplicateSpawn: true },
    };
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "running",
      activeSpawns: {
        plan: {
          agentName: "feat-design-plan-agent",
          agentId: "subagent-unknown-2",
          startedAt: Date.now() - 31 * 60 * 1000, // 31min ago, > 30min
        },
      },
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "feat-design-plan-agent" } };

    const hook = createToolGuard(config);
    const result: any = await hook.handler(ctx as any);

    expect(result).toBeUndefined();
  });
});

// ─── M4: settle-retry binding ────────────────────────────────────────────────
//
// agent-settled.ts:243-292 settle-retry: on completionMarker unbound +
// requirementDoc missing, extract first user message, parse doc path,
// bind, and audit with source=settle_retry. Two cases:
//   1) unbound + resolvable → binds + audit source=settle_retry
//   2) unbound + unresolvable → no bind + audit verify_completion_marker_unbound

describe("M4: settle-retry binding", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-r2-settle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
  });

  function buildSettleCtx(opts: { firstUserMessage?: string }): {
    ctx: ReturnType<typeof createMockCtx>;
    meta: SessionMeta;
  } {
    // Requirement doc on disk WITHOUT the marker (so precheckCompletionMarker fails)
    const meta = makeTestMeta({
      currentStage: "clarify",
      // requirementDoc intentionally undefined → triggers settle-retry branch
      verifyAttempts: 0,
    });

    // Build a session branch with a first user message (so extractFirstUserMessageText finds it)
    const branchEntries: unknown[] = [];
    if (opts.firstUserMessage !== undefined) {
      branchEntries.push({
        type: "message",
        message: { role: "user", content: opts.firstUserMessage },
      });
    }

    const ctx = createMockCtx(meta);
    // Override getBranch to return our entries
    (ctx._ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () =>
      branchEntries;

    return { ctx, meta };
  }

  function buildSettleConfig(projectRoot: string): ReturnType<typeof makeTestConfig> {
    return makeTestConfig({
      projectRoot,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify:
                s === "clarify"
                  ? { require: true, verifyFile: "verify.md", completionMarker: "## 模型确认" }
                  : undefined,
            },
          ],
        ),
      ) as any,
    });
  }

  it("M4a: unbound + resolvable first user message → bind + audit source=settle_retry", async () => {
    // Write the requirement doc (so parseRequirementDocPath has something to find
    // in the first user message), but no marker on disk
    const docPath = "docs/design/feature.md";
    await fsp.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    // The doc on disk has no marker — precheckCompletionMarker returns false
    await fsp.writeFile(path.join(TMP, docPath), "# Feature\nNo marker\n", "utf-8");

    const config = buildSettleConfig(TMP);
    const { ctx, meta } = buildSettleCtx({
      // First user message contains a parseable doc path
      firstUserMessage: `Please implement ${docPath}`,
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // requirementDoc must be bound to the parsed path
    expect(meta.requirementDoc).toBe(docPath);
    // Audit must contain source=settle_retry
    const auditPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const auditContent = await fsp.readFile(auditPath, "utf-8");
    expect(auditContent).toContain("requirement_doc_bound");
    expect(auditContent).toContain("settle_retry");
  });

  it("M4b: unbound + unresolvable first user message → no bind + audit verify_completion_marker_unbound", async () => {
    // No requirement doc on disk (so marker check fails and settle-retry path is entered)
    const config = buildSettleConfig(TMP);
    const { ctx, meta } = buildSettleCtx({
      firstUserMessage: "Please implement the feature", // No parseable doc path
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // requirementDoc must NOT be bound (no parseable path)
    expect(meta.requirementDoc).toBeUndefined();
    // Audit must contain verify_completion_marker_unbound
    const auditPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const auditContent = await fsp.readFile(auditPath, "utf-8");
    expect(auditContent).toContain("verify_completion_marker_unbound");
    expect(auditContent).not.toContain("settle_retry");
  });
});
