import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPipelineResumeCommand } from "../../commands/pipeline-resume";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { readFile } from "node:fs/promises";
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
    const result = await cmd.execute({}, ctx as any);

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
});
