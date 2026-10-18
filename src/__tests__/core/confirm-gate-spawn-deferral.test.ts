import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  maybeHandleConfirmGate,
} from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import type { SessionMeta, PipelineConfig } from "../../types";
import {
  makePlanConfigWithConfirm,
  createPlanDoc,
  setupConfirmGateTmpDir,
  getTmpDir,
} from "./confirm-gate-test-helpers";

setupConfirmGateTmpDir();

// ── 168 Phase 4: confirm gate + auto-spawn integration ─────────────────────

describe("168 Phase 4: confirm gate spawn behavior", () => {
  it("plan approve → design-review: confirm gate triggers spawnStageSubagent with design-review stage (real agent file)", async () => {
    const stageTmp = path.join(tmpdir(), "pi-cg-spawn-" + Date.now());
    await fs.mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create plan doc for marker write
    const planDir = path.join(stageTmp, "docs", "design");
    await fs.mkdir(planDir, { recursive: true });
    const planDoc = path.join(planDir, "Test_Plan.md");
    await fs.writeFile(planDoc, "# Test Plan\n");

    // Create real agent file for design-review stage so resolveAgentMention succeeds
    const agentDir = path.join(stageTmp, "agents");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "design-review-agent.md"),
      "---\nname: design-review-agent\n---\n# Design Review Agent\n",
    );

    const baseConfig = makeTestConfig({ projectRoot: stageTmp });
    const config = {
      ...baseConfig,
      stages: {
        ...baseConfig.stages,
        plan: {
          ...baseConfig.stages.plan,
          allowedWritePaths: ["docs/", "doc/", "documentation/"],
          confirm: { mode: "manual" },
        },
        "design-review": {
          ...baseConfig.stages["design-review"],
          agentPath: "agents/design-review-agent.md",
        },
      },
    } as PipelineConfig;

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/Test.md",
      pipelineId: "pipe-spawn-integ-001",
    });

    // Track events emitted through pi mock (fallback path uses sendUserMessage)
    const sentMessages: Array<{ msg: string; opts?: Record<string, unknown> }> = [];
    const selectCalls: string[] = [];
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: {
        notify: () => {},
        transition: () => {},
        clearStage: () => {},
        select: async (_msg: string, _opts: string[]) => {
          selectCalls.push(_msg);
          return "Approve & Advance";
        },
      },
      pi: {
        sendUserMessage: (msg: string, opts?: Record<string, unknown>) => {
          sentMessages.push({ msg, opts });
        },
      },
    };

    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual",
    });

    // Gate should handle + advance to design-review
    expect(result.result).toBe("handled");
    if ("toStage" in result) {
      expect(result.toStage).toBe("design-review");
    }
    // Stage should actually advance in meta
    expect(meta.currentStage).toBe("design-review");

    // Verify select was called (manual mode)
    expect(selectCalls.length).toBe(1);

    // Since no event bus is on the pi mock, spawnStageSubagent should fall back to
    // sendUserMessage with deliverAs:"followUp". Verify the spawn invocation.
    const spawnCalls = sentMessages.filter(m => m.msg.includes("@design-review-agent"));
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].opts).toEqual({ deliverAs: "followUp" });
    expect(spawnCalls[0].msg).toContain("design-review");
    expect(spawnCalls[0].msg).toContain("pipe-spawn-integ-001");

    await fs.rm(stageTmp, { recursive: true, force: true });
  });

  it("review Reject & Send to Fix → route to fix stage and trigger fix spawn (real agent file)", async () => {
    const stageTmp = path.join(tmpdir(), "pi-cg-rej-fix-" + Date.now());
    await fs.mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create review doc so marker pre-check doesn't block
    const reviewDir = path.join(stageTmp, "docs", "review");
    await fs.mkdir(reviewDir, { recursive: true });
    const reviewDoc = path.join(reviewDir, "code_review_Test.md");
    await fs.writeFile(reviewDoc, "# Review\n结论：需要修改\n");

    // Create real agent file for fix stage
    const agentDir = path.join(stageTmp, "agents");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "fix-agent.md"),
      "---\nname: fix-agent\n---\n# Fix Agent\n",
    );

    const baseConfig = makeTestConfig({ projectRoot: stageTmp });
    const config = {
      ...baseConfig,
      stages: {
        ...baseConfig.stages,
        review: {
          ...baseConfig.stages.review,
          allowedWritePaths: ["docs/", "doc/", "documentation/"],
          confirm: { mode: "manual" },
        },
        fix: {
          ...baseConfig.stages.fix,
          agentPath: "agents/fix-agent.md",
        },
      },
    } as PipelineConfig;

    const meta = makeTestMeta({
      currentStage: "review",
      requirementDoc: "docs/design/Test.md",
      pipelineId: "pipe-rej-fix-001",
    });

    const sentMessages: Array<{ msg: string; opts?: Record<string, unknown> }> = [];
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: {
        notify: () => {},
        transition: () => {},
        clearStage: () => {},
        select: async (_msg: string, _opts: string[]) => {
          return "Reject & Send to Fix";
        },
      },
      pi: {
        sendUserMessage: (msg: string, opts?: Record<string, unknown>) => {
          sentMessages.push({ msg, opts });
        },
      },
    };

    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual",
      defaultReject: true, // review stage default to reject ordering
    });

    // Gate should handle + route to fix
    expect(result.result).toBe("handled");
    if ("toStage" in result) {
      expect(result.toStage).toBe("fix");
    }
    // Stage should advance to fix in meta
    expect(meta.currentStage).toBe("fix");

    // Verify fix spawn triggered via fallback (no event bus)
    const spawnCalls = sentMessages.filter(m => m.msg.includes("@fix-agent"));
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].opts).toEqual({ deliverAs: "followUp" });

    await fs.rm(stageTmp, { recursive: true, force: true });
  });

  it("review approve → completed: confirm gate handles without spawn (completed is non-spawnable)", async () => {
    const stageTmp = path.join(tmpdir(), "pi-cg-compl-" + Date.now());
    await fs.mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create review doc for marker write
    const reviewDir = path.join(stageTmp, "docs", "review");
    await fs.mkdir(reviewDir, { recursive: true });
    const reviewDoc = path.join(reviewDir, "code_review_Test.md");
    await fs.writeFile(reviewDoc, "# Review\n结论：通过\n");

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "review",
      requirementDoc: "docs/design/Test.md",
    });

    let selectOption = "";
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: {
        notify: () => {},
        transition: () => {},
        clearStage: () => {},
        select: async (_msg: string, opts: string[]) => {
          // Find the "Approve & Complete" option
          selectOption = opts.find(o => o.includes("Complete")) ?? opts[0];
          return selectOption;
        },
      },
      pi: {
        sendUserMessage: (_msg: string, _opts?: Record<string, unknown>) => {},
      },
    };

    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual",
    });

    expect(result.result).toBe("handled");
    // Should advance to completed
    if ("toStage" in result) {
      expect(result.toStage).toBe("completed");
    }

    await fs.rm(stageTmp, { recursive: true, force: true });
  });
});

// ─── Phase 4 / 179 (G5/G7): confirm gate deferral past subagent settle ────────

describe("Phase 4 / 179 (G5/G7): confirm gate deferral past subagent settle", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  /** Manager with a working hasRunning() probe. */
  function setManagerRunning(running: boolean): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      hasRunning: () => running,
    };
  }

  /** Manager with getRecord only (anyTopLevelRunning → null, degraded path). */
  function setManagerRecordOnly(records: Record<string, string>): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: (id: string) => (records[id] !== undefined ? { status: records[id] } : undefined),
    };
  }

  function clearManager(): void {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  }

  afterEach(() => clearManager());

  it("anyTopLevelRunning()=true → no popup, pending, deferred stamp", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    const logContent = await fs.readFile(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_deferred");
  });

  it("anyTopLevelRunning()=false → popup presented", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(false);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });

    expect(selectCalls).toBe(1);
    expect(result.result).toBe("handled");
  });

  it("probe null + live activeSpawn evidence → deferred (degraded scan)", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      activeSpawns: { develop: { agentName: "develop-agent", agentId: "live-1", startedAt: Date.now() } },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRecordOnly({ "live-1": "running" });

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
  });

  it("deferral exceeds spawnWaitTimeoutMs → popup + timeout hint, stamp cleared", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = { ...makePlanConfigWithConfirm(tmpDir, "manual"), spawnWaitTimeoutMs: 1000 };
    // Phase 1 (180): the stamp must belong to the current visit (at >= stageStartTime)
    // to count as a "fresh" deferral window. Otherwise the stale-stamp guard treats
    // it as absent and restarts the deferral instead of timing out.
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 300_000,
      confirmGateDeferredAt: { stage: "plan", at: Date.now() - 200_000 },
    });
    let selectCalls = 0;
    const notifications: string[] = [];
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: (_ctx: unknown, m: string) => notifications.push(m), transition: () => {} } as any, { mode: "manual" });

    expect(selectCalls).toBe(1);
    expect(result.result).toBe("handled");
    expect(notifications.some((n) => n.includes("timeout"))).toBe(true);
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    const logContent = await fs.readFile(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_defer_timeout");
  });
});

// ─── Phase 1 / 180: stale confirmGateDeferredAt invalidation ──────────────────

describe("Phase 1 / 180: stale confirmGateDeferredAt invalidation", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  function setManagerRunning(running: boolean): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      hasRunning: () => running,
    };
  }

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  });

  it("stale stamp (at < stageStartTime) + live subagent → defer (not timeout), re-stamps + audits", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = { ...makePlanConfigWithConfirm(tmpDir, "manual"), spawnWaitTimeoutMs: 1000 };
    const now = Date.now();
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: now,
      // Stamp from a PREVIOUS visit to the same stage — older than stageStartTime.
      confirmGateDeferredAt: { stage: "plan", at: now - 200_000 },
    });
    let selectCalls = 0;
    const notifications: string[] = [];
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(
      config,
      ctx,
      meta,
      { notify: (_ctx: unknown, m: string) => notifications.push(m), transition: () => {} } as any,
      { mode: "manual" },
    );

    // Stale stamp treated as absent → restart deferral instead of popping on timeout.
    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    // Re-stamped with the current visit's timestamp.
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    expect(meta.confirmGateDeferredAt!.at).toBeGreaterThanOrEqual(now);
    // First-deferral audit + notify reappear for the new window.
    const logContent = await fs.readFile(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_deferred");
    expect(notifications.some((n) => n.includes("deferred"))).toBe(true);
  });

  it("stamp stage matches but stageStartTime missing → invalid, no throw, defer", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    // Defensive: simulate a legacy/partial meta without stageStartTime.
    delete (meta as { stageStartTime?: number }).stageStartTime;
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(
      config,
      ctx,
      meta,
      { notify: () => {}, transition: () => {} } as any,
      { mode: "manual" },
    );

    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
  });
});

// ─── Phase 2 / 180: dismiss attribution + repeat-defer observability ─────────

describe("Phase 2 / 180: confirm gate dismiss attribution", () => {
  it("fast dismiss (<1500ms) → confirm_gate_dismiss_interrupted + collateral_suspect payload", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 2 },
    });
    const ctx = createMockCtx(meta);
    // Immediate undefined → elapsed ≈ 0 < DECISION_DISMISS_INTERRUPT_MS.
    ctx.ui.select = async () => undefined;

    const result = await maybeHandleConfirmGate(
      config,
      ctx,
      meta,
      { notify: () => {} } as any,
      { mode: "manual", source: "resume" },
    );

    expect(result).toEqual({ result: "handled", action: "pending" });
    const logContent = await fs.readFile(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("] confirm_gate_dismiss_interrupted |");
    expect(logContent).toContain("action=collateral_suspect");
    expect(logContent).toContain("mode=manual");
    expect(logContent).toContain("elapsedMs=");
    expect(logContent).toContain("reaskCount=2");
    expect(logContent).toContain("source=resume");
    // Legacy generic event must no longer be emitted for dismisses.
    expect(logContent).not.toContain("action=esc_dismissed");
  });

  it("slow dismiss (≥1500ms) → confirm_gate_dismissed + user_esc, default source owner_settled", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => {
      await new Promise((r) => setTimeout(r, 1600));
      return undefined;
    };

    const result = await maybeHandleConfirmGate(
      config,
      ctx,
      meta,
      { notify: () => {} } as any,
      { mode: "manual" },
    );

    expect(result).toEqual({ result: "handled", action: "pending" });
    const logContent = await fs.readFile(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("] confirm_gate_dismissed |");
    expect(logContent).toContain("action=user_esc");
    // Default source when not provided.
    expect(logContent).toContain("source=owner_settled");
  });
});

describe("Phase 2 / 180: repeat-defer throttled audit", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  function setManagerRunning(running: boolean): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      hasRunning: () => running,
    };
  }

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    __resetMemoryThrottle();
  });

  it("same-window repeats → 1 first-defer + throttled repeat audit, no duplicate notify", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const notifications: string[] = [];
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;
    setManagerRunning(true);
    __resetMemoryThrottle();
    const ui = {
      notify: (_c: unknown, m: string) => notifications.push(m),
      transition: () => {},
    } as any;

    // Call 1: first deferral → audit + notify.
    await maybeHandleConfirmGate(config, ctx, meta, ui, { mode: "manual" });
    // Allow the throttled repeat audit to pass its window for call 2.
    __resetMemoryThrottle();
    // Call 2: repeat deferral → throttled audit, no notify.
    await maybeHandleConfirmGate(config, ctx, meta, ui, { mode: "manual" });
    // Call 3: still within the throttle window → no new repeat audit.
    await maybeHandleConfirmGate(config, ctx, meta, ui, { mode: "manual" });

    const logContent = await fs.readFile(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    const firstDeferCount = (logContent.match(/\] confirm_gate_deferred \|/g) ?? []).length;
    const repeatCount = (logContent.match(/\] confirm_gate_defer_repeat \|/g) ?? []).length;
    expect(firstDeferCount).toBe(1);
    expect(repeatCount).toBe(1);
    // Only the first deferral notifies.
    expect(notifications.filter((n) => n.includes("deferred")).length).toBe(1);
    expect(logContent).toContain("waitedMs=");
    expect(logContent).toContain("source=owner_settled");
  });
});
