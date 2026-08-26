import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";

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
    const result: any = await cmd.execute({}, ctx);

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
    const result: any = await cmd.execute({}, ctx);

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
    const result: any = await cmd.execute({}, ctx);

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
    const result: any = await cmd.execute({}, ctx);

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
    const result: any = await cmd.execute({}, ctx);

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
    const result: any = await cmd.execute({}, ctx);

    // Should fail with agentPath error (not template residue)
    expect(result.success).toBe(false);
    expect(result.error).toContain("agentPath");
    // Template gate should NOT have been reached
    const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
    expect(fsSync.existsSync(statusPath)).toBe(false);
  });
});
