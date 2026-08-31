import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineStartCommand, collectStagesFrom, buildResumeVisitOrder } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { buildStageSequence } from "../../utils/stage-sequence";
import type { PipelineStage } from "../../types";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-start-gate-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Helper: scaffold a minimal .pi/ tree that lets pipeline-start pass config checks. */
async function scaffoldMinimalPi(opts: { withResidues?: boolean } = {}): Promise<void> {
  // agents (needed for checkAgentPaths)
  const agentsDir = path.join(TMP, ".pi", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  for (const stage of ["clarify", "plan", "develop", "review", "fix"]) {
    await fs.writeFile(path.join(agentsDir, `${stage}-agent.md`), `# ${stage} agent\n`, "utf-8");
  }

  // skills
  const skillsDir = path.join(TMP, ".pi", "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  for (const stage of ["design", "plan", "develop", "review", "fix"]) {
    const stageDir = path.join(skillsDir, stage);
    await fs.mkdir(stageDir, { recursive: true });
    const body = opts.withResidues
      ? `## ${stage} SKILL\n<!-- Template-TODO: placeholder -->\n- **Template-TODO**: fill me\n`
      : `## ${stage} SKILL\n- **Must** ${stage}-output.md\n`;
    await fs.writeFile(path.join(stageDir, "SKILL.md"), body, "utf-8");
  }
}

describe("pipeline-start template-residue gate (147 Phase 6)", () => {
  it("residues + TUI cancel → returns success:false, no stage entered", async () => {
    await scaffoldMinimalPi({ withResidues: true });
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "clarify" as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta, { selectReturn: "2. Cancel startup" });
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Template residue check blocked");
    // Stage should NOT have been entered (no updateMeta with currentStage)
    const stageWrites = ctx.metadataUpdates.filter(m => m.currentStage);
    expect(stageWrites.length).toBe(0);
    // Gate status file should NOT be written
    const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
    expect(fsSync.existsSync(statusPath)).toBe(false);
  });

  it("no residues → writes gate status with passed=true and fingerprint, starts normally", async () => {
    await scaffoldMinimalPi({ withResidues: false });
    const config = makeTestConfig({ projectRoot: TMP });
    // Set up meta for a fresh start (no currentStage → triggers new pipeline branch)
    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta);
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    // pipeline-start should proceed (not blocked by gate)
    expect(result).toBeDefined();
    // Gate status file should exist with passed=true
    const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
    expect(fsSync.existsSync(statusPath)).toBe(true);
    const statusContent = JSON.parse(await fs.readFile(statusPath, "utf-8"));
    expect(statusContent.passed).toBe(true);
    expect(typeof statusContent.fingerprint).toBe("string");
  });

  it("restart short-circuit: cached pass + matching fingerprint skips check", async () => {
    await scaffoldMinimalPi({ withResidues: false });

    // Pre-write a gate status with a fingerprint matching current content
    const { computeResidueFingerprint } = await import("../../core/template-residue-check");
    const currentFp = computeResidueFingerprint(TMP);
    const auditDir = path.join(TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(
      path.join(auditDir, "template-residue-check.json"),
      JSON.stringify({ passed: true, checkedAt: "2020-01-01", fingerprint: currentFp }),
      "utf-8",
    );

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta);
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    // Should succeed (not blocked by gate) — the check was short-circuited
    expect(result).toBeDefined();
    // The pre-written status file should still have the same old checkedAt (not overwritten)
    const statusContent = JSON.parse(
      await fs.readFile(path.join(auditDir, "template-residue-check.json"), "utf-8"),
    );
    expect(statusContent.checkedAt).toBe("2020-01-01");
  });

  it("fingerprint drift: cached pass with stale fingerprint triggers re-check", async () => {
    await scaffoldMinimalPi({ withResidues: false });

    // Pre-write a gate status with a MISMATCHED fingerprint (stale)
    const auditDir = path.join(TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(
      path.join(auditDir, "template-residue-check.json"),
      JSON.stringify({ passed: true, checkedAt: "2020-01-01", fingerprint: "stale-fingerprint" }),
      "utf-8",
    );

    // Now introduce residues
    const developSkill = path.join(TMP, ".pi", "skills", "develop", "SKILL.md");
    await fs.writeFile(
      developSkill,
      "## develop SKILL\n<!-- Template-TODO: new residue -->\n",
      "utf-8",
    );

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    // User cancels when faced with residues
    const ctx = createMockCtx(meta, { selectReturn: "2. Cancel startup" });
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    // Should be blocked because fingerprint drifted → re-check → residues found → cancel
    expect(result.success).toBe(false);
    expect(result.error).toContain("Template residue check blocked");
  });

  it("no TUI (select undefined) → degraded non-blocking: start proceeds", async () => {
    await scaffoldMinimalPi({ withResidues: true });
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    // ctx without select → no TUI
    const ctx = createMockCtx(meta, { hasConfirm: false });
    // Remove select to simulate no TUI
    (ctx.ui as any).select = undefined;
    const notifications: string[] = [];
    ctx.ui.notify = (m: string) => { notifications.push(m); };
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    // Should proceed (not blocked) — degraded mode
    expect(result).toBeDefined();
    // Should have emitted a notify about residues
    const residueNotify = notifications.find(n => n.includes("Template residue"));
    expect(residueNotify).toBeDefined();
    // Gate status file should NOT be written (degraded → don't persist)
    const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
    expect(fsSync.existsSync(statusPath)).toBe(false);
  });

  it("checkAgentPaths error fires BEFORE template gate (ordering)", async () => {
    // Override stages to strip agentPath so checkAgentPaths fails
    const stages: Record<string, unknown> = {};
    for (const s of ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"]) {
      stages[s] = { skillPath: `${s}/SKILL.md`, nextStage: null, requireDomain: false };
    }
    const config = makeTestConfig({ projectRoot: TMP, stages: stages as any });
    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta);
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({}, ctx as any);

    // Should fail with agentPath error (not template residue)
    expect(result.success).toBe(false);
    expect(result.error).toContain("agentPath");
    // Template gate should NOT have been reached
    const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
    expect(fsSync.existsSync(statusPath)).toBe(false);
  });
});

// ─── Phase 2: collectStagesFrom / buildResumeVisitOrder equivalence ─────────
describe("collectStagesFrom equivalence with buildStageSequence", () => {
  it("normal chain: collectStagesFrom(config,'develop') == buildStageSequence result as Set", () => {
    const config = makeTestConfig();
    const reachable = collectStagesFrom(config, "develop");
    const expected = new Set<PipelineStage>(buildStageSequence(config, "develop"));
    expect(reachable).toEqual(expected);
  });

  it("circular chain: develop→review→develop stays within 16 iterations", () => {
    const config = makeTestConfig();
    (config.stages.develop as any).nextStage = "review";
    (config.stages.review as any).nextStage = "develop";

    const reachable = collectStagesFrom(config, "develop");
    const expected = new Set<PipelineStage>(buildStageSequence(config, "develop"));
    expect(reachable).toEqual(expected);
    expect(reachable.size).toBeLessThanOrEqual(16);
  });
});

describe("buildResumeVisitOrder equivalence", () => {
  it("clarify→fix returns ordered chain ending at fix", () => {
    const config = makeTestConfig();
    const result = buildResumeVisitOrder(config, "fix");
    // Default chain: clarify→plan→develop→review→fix (5 elements)
    expect(result[result.length - 1]).toBe("fix");
    expect(result[0]).toBe("clarify");
    expect(result).toContain("develop");
    expect(result).toContain("review");
  });

  it("target not in chain (misconfigured) → fallback [stage]", () => {
    // Create a chain that does NOT include the target stage
    const config = makeTestConfig();
    // Break the chain after plan so clarify→plan but not beyond
    (config.stages.plan as any).nextStage = null;
    const result = buildResumeVisitOrder(config, "develop");
    // develop is not reachable from clarify→plan(null) → fallback
    expect(result).toEqual(["develop"]);
  });

  it("circular chain: stays within 16 iterations", () => {
    const config = makeTestConfig();
    (config.stages.develop as any).nextStage = "review";
    (config.stages.review as any).nextStage = "develop";

    const result = buildResumeVisitOrder(config, "fix");
    // fix is not reachable in the cycle, so fallback
    expect(result.length).toBeLessThanOrEqual(16);
  });
});

describe("Phase 4 (162): pipeline-start confirmRejections reset", () => {
  it("start command initializes meta with confirmRejections: undefined", async () => {
    await scaffoldMinimalPi();
    const config = makeTestConfig({ projectRoot: TMP });
    // Create the doc file so startNewPipeline can read it
    const docsDir = path.join(TMP, "docs", "design");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "77_Config.md"), "# Requirement\n", "utf-8");

    const meta = makeTestMeta({
      currentStage: undefined as any,
      pipelineId: undefined as any,
      confirmRejections: 5, // Simulate prior rejections
    });
    const ctx = createMockCtx(meta);
    const cmd = createPipelineStartCommand(config);
    const result: any = await cmd.execute({ file: "docs/design/77_Config.md" }, ctx as any);

    // After start, confirmRejections should be reset to undefined
    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.confirmRejections).toBeUndefined();
  });
});

// ─── Phase 2: maybeAutoLaunchClarify RPC success/fallback chain ─────────────

/** Helper: create a mock pi.events bus with programmable responses */
function makeMockEventBus(opts: {
  pingReply?: Record<string, unknown> | null;
  spawnReply?: Record<string, unknown> | null;
  /** If true, emit ping reply synchronously when ping is emitted */
  emitPingReply?: boolean;
  /** If true, emit spawn reply synchronously when spawn is emitted */
  emitSpawnReply?: boolean;
} = {}) {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

  const bus = {
    emit(event: string, payload: Record<string, unknown>) {
      emitted.push({ event, payload });
      // Simulate reply channel responses
      if (opts.emitPingReply && event === "subagents:rpc:ping" && opts.pingReply !== null) {
        const replyChannel = `subagents:rpc:ping:reply:${payload.requestId}`;
        const handlers = listeners.get(replyChannel);
        if (handlers) {
          for (const h of handlers) h(opts.pingReply ?? { success: true });
        }
      }
      if (opts.emitSpawnReply && event === "subagents:rpc:spawn" && opts.spawnReply !== null) {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        const handlers = listeners.get(replyChannel);
        if (handlers) {
          for (const h of handlers) h(opts.spawnReply ?? { success: true, data: { id: "subagent-001" } });
        }
      }
    },
    on(event: string, handler: (payload: unknown) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    },
    off(event: string, handler: (payload: unknown) => void) {
      const existing = listeners.get(event);
      if (existing) {
        const idx = existing.indexOf(handler);
        if (idx >= 0) existing.splice(idx, 1);
      }
    },
    _listeners: listeners,
    _emitted: emitted,
  };
  return bus;
}

describe("pipeline-start maybeAutoLaunchClarify RPC chain", () => {
  /** Helper: scaffold agent file with frontmatter name at the path the config expects */
  async function scaffoldAgentWithName(): Promise<void> {
    // Default config has agentPath: "./agents/test-agent.md"
    const agentsDir = path.join(TMP, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, "test-agent.md"),
      "---\nname: clarify-agent\n---\n# Clarify agent\n",
      "utf-8",
    );
  }

  it("RPC success: ping ok + spawn ok → audit pipeline_start_launch_rpc, no fallback audit", async () => {
    await scaffoldMinimalPi();
    await scaffoldAgentWithName();
    const config = makeTestConfig({ projectRoot: TMP });
    const docsDir = path.join(TMP, "docs", "design");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "78_RPC.md"), "# Requirement\n", "utf-8");

    const bus = makeMockEventBus({
      pingReply: { success: true },
      spawnReply: { success: true, data: { id: "subagent-001" } },
      emitPingReply: true,
      emitSpawnReply: true,
    });

    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta);
    const sendSpy: string[] = [];
    (ctx as any).pi = { events: bus, sendUserMessage: (msg: string) => { sendSpy.push(msg); } };

    const cmd = createPipelineStartCommand(config);
    await cmd.execute({ file: "docs/design/78_RPC.md" }, ctx as any);

    // sendUserMessage should NOT be called on RPC success
    expect(sendSpy.length).toBe(0);

    // Audit log should contain pipeline_start_launch_rpc
    const auditPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const auditContent = await fs.readFile(auditPath, "utf-8");
    expect(auditContent).toContain("pipeline_start_launch_rpc");
    // No fallback launch event
    const lines = auditContent.trim().split("\n");
    const launchFallbackLines = lines.filter(l => l.includes("pipeline_start_launch") && l.includes("fallback=true"));
    expect(launchFallbackLines.length).toBe(0);
  });

  it("fallback: ping timeout (no reply) → sendUserMessage + audit pipeline_start_launch", async () => {
    await scaffoldMinimalPi();
    await scaffoldAgentWithName();
    const config = makeTestConfig({ projectRoot: TMP });
    const docsDir = path.join(TMP, "docs", "design");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "78_RPC.md"), "# Requirement\n", "utf-8");

    // Bus that never replies to ping → ping times out
    const bus = makeMockEventBus({ emitPingReply: false, emitSpawnReply: false });

    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta);
    const sendSpy: string[] = [];
    (ctx as any).pi = { events: bus, sendUserMessage: (msg: string) => { sendSpy.push(msg); } };

    const cmd = createPipelineStartCommand(config);
    await cmd.execute({ file: "docs/design/78_RPC.md" }, ctx as any);

    // sendUserMessage SHOULD be called on fallback
    expect(sendSpy.length).toBe(1);
    expect(sendSpy[0]).toContain("@");

    // Audit log should contain pipeline_start_launch with fallback=true
    const auditPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const auditContent = await fs.readFile(auditPath, "utf-8");
    expect(auditContent).toContain("pipeline_start_launch");
    expect(auditContent).toContain("fallback=true");
  });

  it("fallback: spawn returns {success:false} → sendUserMessage + audit pipeline_start_launch", async () => {
    await scaffoldMinimalPi();
    await scaffoldAgentWithName();
    const config = makeTestConfig({ projectRoot: TMP });
    const docsDir = path.join(TMP, "docs", "design");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "78_RPC.md"), "# Requirement\n", "utf-8");

    const bus = makeMockEventBus({
      pingReply: { success: true },
      spawnReply: { success: false, error: "spawn_rejected" },
      emitPingReply: true,
      emitSpawnReply: true,
    });

    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta);
    const sendSpy: string[] = [];
    (ctx as any).pi = { events: bus, sendUserMessage: (msg: string) => { sendSpy.push(msg); } };

    const cmd = createPipelineStartCommand(config);
    await cmd.execute({ file: "docs/design/78_RPC.md" }, ctx as any);

    // sendUserMessage SHOULD be called on spawn failure
    expect(sendSpy.length).toBe(1);

    // Audit log should contain pipeline_start_launch with fallback=true
    const auditPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const auditContent = await fs.readFile(auditPath, "utf-8");
    expect(auditContent).toContain("pipeline_start_launch");
    expect(auditContent).toContain("fallback=true");
  });

  it("fallback: no pi.events → sendUserMessage + audit pipeline_start_launch", async () => {
    await scaffoldMinimalPi();
    await scaffoldAgentWithName();
    const config = makeTestConfig({ projectRoot: TMP });
    const docsDir = path.join(TMP, "docs", "design");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "78_RPC.md"), "# Requirement\n", "utf-8");

    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta);
    const sendSpy: string[] = [];
    // No pi.events at all
    (ctx as any).pi = { sendUserMessage: (msg: string) => { sendSpy.push(msg); } };

    const cmd = createPipelineStartCommand(config);
    await cmd.execute({ file: "docs/design/78_RPC.md" }, ctx as any);

    expect(sendSpy.length).toBe(1);

    const auditPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
    const auditContent = await fs.readFile(auditPath, "utf-8");
    expect(auditContent).toContain("pipeline_start_launch");
    expect(auditContent).toContain("fallback=true");
  });

  it("no agentPath → notify fallback (no RPC, no sendUserMessage)", async () => {
    await scaffoldMinimalPi();
    // Make the agent file unreadable by deleting it → resolveAgentMention → null
    const agentsDir = path.join(TMP, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    // Don't create the test-agent.md file so resolveAgentMention returns null

    const config = makeTestConfig({ projectRoot: TMP });
    const docsDir = path.join(TMP, "docs", "design");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "78_RPC.md"), "# Requirement\n", "utf-8");

    const meta = makeTestMeta({ currentStage: undefined as any, pipelineId: undefined as any });
    const ctx = createMockCtx(meta);
    const notifications: string[] = [];
    ctx.ui.notify = (msg: string) => { notifications.push(msg); };
    const sendSpy: string[] = [];
    (ctx as any).pi = { events: makeMockEventBus(), sendUserMessage: (msg: string) => { sendSpy.push(msg); } };

    const cmd = createPipelineStartCommand(config);
    await cmd.execute({ file: "docs/design/78_RPC.md" }, ctx as any);

    // No sendUserMessage (no agentName resolved → notify path)
    expect(sendSpy.length).toBe(0);
    // Should have a notify message
    expect(notifications.some(n => n.includes("@feat-design-plan-agent") || n.includes("Next"))).toBe(true);
  });
});
