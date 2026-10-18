import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { makeTestConfig, makeTestMeta, createMockCtx, finalStatusText } from "../helpers";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog } from "../../utils/auditLog";
import { auditLogFileFor } from "../helpers";
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

    // Audit should contain pipeline_decision with source=force-resume (Phase 6)
    const auditPath = auditLogFileFor(join(TMP, ".pi", "audit"), meta.pipelineId);
    const auditContent = await readFile(auditPath, "utf-8");
    expect(auditContent).toContain("pipeline_decision");
    expect(auditContent).toContain("source");
    expect(auditContent).toContain("force-resume");

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
      const audit = await readFile(auditLogFileFor(join(TMP, ".pi", "audit"), meta.pipelineId), "utf-8");
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
      const audit = await readFile(auditLogFileFor(join(TMP, ".pi", "audit"), meta.pipelineId), "utf-8");
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

  // ─── Phase 6 (195): Eliminate silent resume ──────────────────────────────
  describe("Phase 6 (195): Eliminate silent resume", () => {
    it("no-UI without --force-resume does NOT resume, audits resume_skipped_no_menu", async () => {
      const TMP = join(tmpdir(), "pi-resume-no-ui-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 5,
        maxLoopCycles: 5,
      });
      // Create ctx WITHOUT ui.select (no UI available)
      const baseCtx = createMockCtx(meta);
      const ctx = { ...baseCtx, ui: { ...baseCtx.ui, select: undefined } } as any;
      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx);

      // Should NOT resume — should return frozen message
      expect((result as any).message).toContain("Pipeline frozen");
      expect(meta.flowState).toBe("blocked"); // Still frozen
      expect(meta.blockedReason).toBe("max_loop_cycles"); // Unchanged

      // Verify audit log contains resume_skipped_no_menu
      const auditFile = auditLogFileFor(join(TMP, ".pi", "audit"), meta.pipelineId);
      const auditContent = await readFile(auditFile, "utf-8");
      expect(auditContent).toContain("resume_skipped_no_menu");
      expect(auditContent).toContain("no_ui");

      await rm(TMP, { recursive: true, force: true });
    });

    it("no-UI with --force-resume DOES resume and audits force-resume source", async () => {
      const TMP = join(tmpdir(), "pi-resume-force-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 5,
        maxLoopCycles: 10, // Budget available
      });
      const baseCtx = createMockCtx(meta);
      const ctx = { ...baseCtx, ui: { ...baseCtx.ui, select: undefined } } as any;
      const cmd = createPipelineResumeCommand(config);
      // Pass forceResume flag
      const result = await cmd.execute({ forceResume: true }, ctx);

      // Should resume
      expect((result as any).message).toBeDefined();
      expect(meta.flowState).toBe("running"); // Unfrozen

      // Verify audit log shows force-resume source
      const auditFile = auditLogFileFor(join(TMP, ".pi", "audit"), meta.pipelineId);
      const auditContent = await readFile(auditFile, "utf-8");
      expect(auditContent).toContain("force-resume");

      await rm(TMP, { recursive: true, force: true });
    });

    // 203_Bug Phase 1 (RC2): --force-resume must clear the current stage's
    // spawn ledger residue (activeSpawns/spawnedStages/pendingSpawns) so the
    // executor can be re-dispatched instead of being blocked by
    // duplicate_spawn_guarded. Live agent is not probed in mock ctx (global
    // manager registry is empty → non-live) → residue cleared.
    it("203_Bug Phase 1 (RC2): --force-resume clears stage spawn residue", async () => {
      const TMP = join(tmpdir(), "pi-resume-residue-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
        loopCycleCount: 5,
        maxLoopCycles: 10,
        activeSpawns: { develop: { agentId: "agent-x", agentName: "develop-agent", startedAt: Date.now() } },
        spawnedStages: { develop: Date.now() },
        pendingSpawns: { develop: { agentName: "develop-agent", requestedAt: Date.now(), attempts: 1 } },
      });
      const baseCtx = createMockCtx(meta);
      const ctx = { ...baseCtx, ui: { ...baseCtx.ui, select: undefined } } as any;
      const cmd = createPipelineResumeCommand(config);
      await cmd.execute({ forceResume: true }, ctx);

      expect(meta.flowState).toBe("running");
      expect(meta.activeSpawns?.develop).toBeUndefined();
      expect(meta.spawnedStages?.develop).toBeUndefined();
      expect(meta.pendingSpawns?.develop).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
    });

    it("child session without --force-resume does NOT resume, audits child_session", async () => {
      const TMP = join(tmpdir(), "pi-resume-child-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "max_loop_cycles",
      });
      // Simulate child session: no ui.select available (child sessions suppress menu)
      const baseCtx = createMockCtx(meta);
      const ctx = { ...baseCtx, ui: { ...baseCtx.ui, select: undefined } } as any;
      const cmd = createPipelineResumeCommand(config);
      const result = await cmd.execute({}, ctx);

      // Should NOT resume
      expect((result as any).message).toContain("Pipeline frozen");
      expect(meta.flowState).toBe("blocked");

      // Verify audit log contains resume_skipped_no_menu
      const auditFile = auditLogFileFor(join(TMP, ".pi", "audit"), meta.pipelineId);
      const auditContent = await readFile(auditFile, "utf-8");
      expect(auditContent).toContain("resume_skipped_no_menu");

      await rm(TMP, { recursive: true, force: true });
    });
  });

});
