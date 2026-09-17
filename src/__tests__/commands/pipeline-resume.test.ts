import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { makeTestConfig, makeTestMeta, createMockCtx, finalStatusText } from "../helpers";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import type { PipelineStage } from "../../types";

describe("createPipelineResumeCommand", () => {
  it("creates a command with name 'pipeline-resume'", () => {
    const cmd = createPipelineResumeCommand(makeTestConfig());
    expect(cmd.name).toBe("pipeline-resume");
    expect(cmd.description).toContain("Resume");
  });

  it("returns error when no session context", async () => {
    const cmd = createPipelineResumeCommand(makeTestConfig());
    const result = await cmd.execute({});
    expect((result as any).error).toContain("No session context");
  });

  it("returns error when no active pipeline", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta();
    // Remove pipelineId to simulate no active pipeline
    delete (meta as any).pipelineId;
    const ctx = createMockCtx(meta);
    const cmd = createPipelineResumeCommand(config);
    const result = await cmd.execute({}, ctx as any);
    expect((result as any).error).toContain("No active pipeline");
  });

  it("running pipeline → read-only hint, no state change", async () => {
    const TMP = join(tmpdir(), "pi-resume-running-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: undefined, // running
    });
    const ctx = createMockCtx(meta);
    const cmd = createPipelineResumeCommand(config);
    const result = await cmd.execute({}, ctx as any);

    expect((result as any).message).toContain("running");
    expect(meta.flowState).toBeUndefined(); // No state change

    await rm(TMP, { recursive: true, force: true });
  });

  it("aborted pipeline → points to /pipeline-start", async () => {
    const TMP = join(tmpdir(), "pi-resume-aborted-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "aborted",
      terminateReason: "session_quit",
    });
    const ctx = createMockCtx(meta);
    const cmd = createPipelineResumeCommand(config);
    const result = await cmd.execute({}, ctx as any);

    expect((result as any).message).toContain("/pipeline-start");

    await rm(TMP, { recursive: true, force: true });
  });

  it("blocked pipeline → resume succeeds and audits source=command", async () => {
    const TMP = join(tmpdir(), "pi-resume-blocked-" + Date.now());
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      loopCount: 3,
      verifyAttempts: 3,
    });
    const ctx = createMockCtx(meta);
    const cmd = createPipelineResumeCommand(config);
    // Phase 0 (182): pass forceResume to bypass the new decision menu and test legacy path
    const result = await cmd.execute({ forceResume: true }, ctx as any);

    // Resume should succeed
    expect((result as any).error).toBeUndefined();
    // flowState should be cleared
    expect(ctx.metadataUpdates.some(u => u.flowState === "running")).toBe(true);
    // loopCount should be reset
    expect(ctx.metadataUpdates.some(u => u.loopCount === 0)).toBe(true);

    // Audit should contain pipeline_decision with source=command
    const auditPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const auditContent = await readFile(auditPath, "utf-8");
    expect(auditContent).toContain("pipeline_decision");
    expect(auditContent).toContain("source");
    expect(auditContent).toContain("command");

    await rm(TMP, { recursive: true, force: true });
  });

  it("blocked + no active spawns → dispatch is attempted (notify confirms resume + stage dispatch)", async () => {
    const TMP = join(tmpdir(), "pi-resume-dispatch-" + Date.now());
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      // No activeSpawns → should attempt dispatch
      activeSpawns: {},
    });
    const ctx = createMockCtx(meta);
    const notifications: string[] = [];
    (ctx as any).ui = { notify: (msg: string) => notifications.push(msg), setStatus: () => {} };
    const cmd = createPipelineResumeCommand(config);
    const result = await cmd.execute({}, ctx as any);

    expect((result as any).error).toBeUndefined();
    // Resume notify should include stage info
    expect(notifications.some(n => n.includes("resumed"))).toBe(true);

    await rm(TMP, { recursive: true, force: true });
  });

  it("blocked + live agent probe → dispatch skipped (no duplicate spawn)", async () => {
    const TMP = join(tmpdir(), "pi-resume-live-" + Date.now());
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      activeSpawns: {
        develop: { agentName: "develop-agent", agentId: "agent-live-001", startedAt: Date.now() },
      },
    });
    const ctx = createMockCtx(meta);
    const notifications: string[] = [];
    (ctx as any).ui = { notify: (msg: string) => notifications.push(msg), setStatus: () => {} };

    // Mock the pi-subagents manager singleton to return "live" for our agent
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    const origManager = (globalThis as any)[MANAGER_SYMBOL];
    (globalThis as any)[MANAGER_SYMBOL] = {
      getRecord: (id: string) => id === "agent-live-001" ? { status: "running" } : undefined,
    };

    try {
      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx as any);

      expect((result as any).error).toBeUndefined();
      // Should notify that agent is already running and skip duplicate spawn
      expect(notifications.some(n => n.includes("already running"))).toBe(true);
    } finally {
      // Restore original manager
      if (origManager !== undefined) {
        (globalThis as any)[MANAGER_SYMBOL] = origManager;
      } else {
        delete (globalThis as any)[MANAGER_SYMBOL];
      }
    }

    await rm(TMP, { recursive: true, force: true });
  });

  // ── Phase 1 / 175: forwardArgs passthrough ──────────────────────────────
  it("Phase 1 / 175: blocked pipeline with forwardArgs passes them to dispatchAfterResume", async () => {
    const TMP = join(tmpdir(), "pi-resume-fwdargs-" + Date.now());
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "clarify",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      requirementDoc: "docs/req.md",
    });
    const ctx = createMockCtx(meta);
    const cmd = createPipelineResumeCommand(config);

    // Pass forwardArgs as the command args would provide
    const result = await cmd.execute({ forwardArgs: "2 答" }, ctx as any);

    // Resume should succeed without error
    expect((result as any).error).toBeUndefined();

    await rm(TMP, { recursive: true, force: true });
  });

  // ── Phase 0 / 180: persistent stage status bar restoration ──────────────

  describe("Phase 0 / 180: stage status bar parity with /pipeline-start", () => {
    it("running branch writes the persistent stage status bar", async () => {
      const TMP = join(tmpdir(), "pi-resume-180-running-" + Date.now());
      await mkdir(TMP, { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "develop", flowState: undefined });
      const ctx = createMockCtx(meta);
      const cmd = createPipelineResumeCommand(config);
      await cmd.execute({}, ctx as any);

      // One setStage write → move-to-end delete + set pair
      const stageCalls = ctx.statusCalls.filter((c) => c.key === "pipeline-stage");
      expect(stageCalls.length).toBe(2);
      expect(finalStatusText(ctx.statusCalls, "pipeline-stage")).toContain("develop");

      await rm(TMP, { recursive: true, force: true });
    });

    it("aborted branch writes the persistent stage status bar", async () => {
      const TMP = join(tmpdir(), "pi-resume-180-aborted-" + Date.now());
      await mkdir(TMP, { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "aborted",
        terminateReason: "session_quit",
      });
      const ctx = createMockCtx(meta);
      const cmd = createPipelineResumeCommand(config);
      await cmd.execute({}, ctx as any);

      const stageCalls = ctx.statusCalls.filter((c) => c.key === "pipeline-stage");
      expect(stageCalls.length).toBe(2);
      expect(finalStatusText(ctx.statusCalls, "pipeline-stage")).toContain("develop");

      await rm(TMP, { recursive: true, force: true });
    });

    it("blocked→resume success writes status bar reflecting the rolled-back stage", async () => {
      const TMP = join(tmpdir(), "pi-resume-180-resumed-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      // awaiting_human is frozen; resume resolves back to previousStage.
      const meta = makeTestMeta({
        currentStage: "awaiting_human",
        previousStage: "develop",
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const ctx = createMockCtx(meta);
      const cmd = createPipelineResumeCommand(config);
      // Phase 0 (182): pass forceResume to bypass the new decision menu
      const result = await cmd.execute({ forceResume: true }, ctx as any);

      expect((result as any).error).toBeUndefined();
      const stageCalls = ctx.statusCalls.filter((c) => c.key === "pipeline-stage");
      expect(stageCalls.length).toBe(2);
      expect(finalStatusText(ctx.statusCalls, "pipeline-stage")).toContain("develop");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  // ── Phase 3 / 180: running branch re-enters the pending confirm gate ──────

  describe("Phase 3 / 180: running branch re-enters the pending confirm gate", () => {
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

    function makeManualPlanConfig(root: string) {
      const base = makeTestConfig({ projectRoot: root });
      const planStage = {
        ...base.stages.plan,
        nextStage: "develop" as PipelineStage,
        allowedWritePaths: ["docs/"],
        confirm: { mode: "manual" as const },
      };
      return {
        ...base,
        stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
      };
    }

    async function setupPlanDoc(root: string) {
      const docsDir = join(root, "docs", "design");
      await mkdir(docsDir, { recursive: true });
      const planPath = join(docsDir, "77_Config_plan.md");
      await writeFile(planPath, "# Plan\n", "utf-8");
      return planPath;
    }

    function setManagerRunning(running: boolean): void {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => undefined,
        hasRunning: () => running,
      };
    }

    afterEach(() => {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    });

    it("plan + manual + re-ask trace + Approve → dialog shown, marker written, re-ask cleared", async () => {
      const TMP = join(tmpdir(), "pi-resume-180-approve-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeManualPlanConfig(TMP);
      await initAuditLog(config);
      const planPath = await setupPlanDoc(TMP);

      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "running",
        requirementDoc: "docs/design/77_Config.md",
        confirmGateReask: { stage: "plan", count: 1 },
      });
      const ctx = createMockCtx(meta);
      let capturedOptions: string[] = [];
      ctx.ui.select = async (_msg: string, options: string[]) => {
        capturedOptions = [...options];
        return "Approve & Advance";
      };

      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx as any);

      // Dialog was presented with the plan gate options.
      expect(capturedOptions).toContain("Reject & Rework (back to clarify)");
      // Marker written to the plan document.
      const doc = await readFile(planPath, "utf-8");
      expect(doc).toContain("## 用户确认：确认无误");
      // Result message + stage advance.
      expect((result as any).message).toContain("Confirm gate approved");
      expect(meta.currentStage).toBe("develop");
      // Re-ask bookkeeping cleared (shared helper semantics).
      expect(meta.confirmGateReask).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
    });

    it("live subagent → deferred: no dialog, audit emitted, re-ask budget not consumed", async () => {
      const TMP = join(tmpdir(), "pi-resume-180-deferred-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeManualPlanConfig(TMP);
      await initAuditLog(config);
      await setupPlanDoc(TMP);

      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "running",
        requirementDoc: "docs/design/77_Config.md",
        confirmGateReask: { stage: "plan", count: 1 },
      });
      const ctx = createMockCtx(meta);
      let selectCalls = 0;
      ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
      setManagerRunning(true);

      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx as any);

      expect(selectCalls).toBe(0);
      expect((result as any).message).toContain("No resume needed");
      // Re-ask budget untouched by the system deferral.
      expect(meta.confirmGateReask).toEqual({ stage: "plan", count: 1 });
      const audit = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(audit).toContain("confirm_gate_deferred");

      await rm(TMP, { recursive: true, force: true });
    });

    it("immediate undefined (collateral cancel) → 1 re-ask + dismiss_interrupted with source=resume", async () => {
      const TMP = join(tmpdir(), "pi-resume-180-cancel-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeManualPlanConfig(TMP);
      await initAuditLog(config);
      await setupPlanDoc(TMP);

      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "running",
        requirementDoc: "docs/design/77_Config.md",
        confirmGateReask: { stage: "plan", count: 1 },
      });
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => undefined;

      const cmd = createPipelineResumeCommand(config);
      await cmd.execute({}, ctx as any);

      // Shared accounting helper increments the stage-scoped re-ask count.
      expect(meta.confirmGateReask).toEqual({ stage: "plan", count: 2 });
      const audit = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(audit).toContain("confirm_gate_dismiss_interrupted");
      expect(audit).toContain("source=resume");

      await rm(TMP, { recursive: true, force: true });
    });

    it("child session → no dialog, read-only status text (owner-only)", async () => {
      const TMP = join(tmpdir(), "pi-resume-180-child-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeManualPlanConfig(TMP);
      await initAuditLog(config);
      await setupPlanDoc(TMP);

      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "running",
        requirementDoc: "docs/design/77_Config.md",
        confirmGateReask: { stage: "plan", count: 1 },
      });
      const ctx = createMockCtx(meta, { sessionName: "plan-agent#aabb1122" });
      let selectCalls = 0;
      ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx as any);

      expect(selectCalls).toBe(0);
      expect((result as any).message).toContain("No resume needed");
      // No gate resolution → re-ask trace unchanged.
      expect(meta.confirmGateReask).toEqual({ stage: "plan", count: 1 });

      await rm(TMP, { recursive: true, force: true });
    });
  });

  // ── Phase 0 (182): frozen decision menu integration ──────────────────────

  describe("Phase 0 (182): frozen decision menu", () => {
    it("frozen + ui.select → promptDecisionMenu called, executeDecision('resume') not directly called", async () => {
      const TMP = join(tmpdir(), "pi-resume-menu-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const ctx = createMockCtx(meta);
      // User selects "Resume" from the decision menu
      ctx.ui.select = async (_msg: string, options: string[]) => {
        return options.find(o => o === "Resume") ?? options[0];
      };

      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx as any);

      // Menu path returns "Decision executed." on success
      expect((result as any).message).toContain("Decision executed");
      // Pipeline should be unfrozen (resume via menu → flowState=running)
      expect(meta.flowState).toBe("running");

      await rm(TMP, { recursive: true, force: true });
    });

    it("--force-resume → bypasses menu, takes legacy resume path", async () => {
      const TMP = join(tmpdir(), "pi-resume-force-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const ctx = createMockCtx(meta);
      // Even with select available, --force-resume should skip it
      let selectCalled = false;
      ctx.ui.select = async () => { selectCalled = true; return undefined; };

      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({ forceResume: true }, ctx as any);

      expect(selectCalled).toBe(false);
      expect((result as any).error).toBeUndefined();
      expect(meta.flowState).toBe("running");

      await rm(TMP, { recursive: true, force: true });
    });

    it("no ui.select → fail-soft to legacy resume path", async () => {
      const TMP = join(tmpdir(), "pi-resume-noselect-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const ctx = createMockCtx(meta);
      // Remove select to simulate no UI
      delete (ctx.ui as any).select;

      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx as any);

      // Should still resume via legacy path
      expect((result as any).error).toBeUndefined();
      expect(meta.flowState).toBe("running");

      await rm(TMP, { recursive: true, force: true });
    });

    it("menu cancelled → returns frozen hint, flowState unchanged", async () => {
      const TMP = join(tmpdir(), "pi-resume-cancelled-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const ctx = createMockCtx(meta);
      // User presses Esc (select returns undefined)
      ctx.ui.select = async () => undefined;

      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx as any);

      // Should remain frozen
      expect(meta.flowState).toBe("blocked");
      expect((result as any).message).toContain("frozen");

      await rm(TMP, { recursive: true, force: true });
    });
  });
});
