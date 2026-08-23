/**
 * Phase 1 audit event integration tests.
 *
 * Verifies that the 5 audit event types are correctly emitted:
 * - stage_advance / stage_advance_failed / pipeline_completed (stage-advancer)
 * - pipeline_start (pipeline-start command)
 * - pipeline_state (pipeline-state tool)
 * - loop_check (loop-checker tool)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { createStageAdvancer } from "../../core/stage-advancer";
import { createPipelineState } from "../../core/pipeline-state";
import { createLoopChecker } from "../../core/loop-checker";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta } from "../helpers";

function makeTmpRoot(label: string): string {
  return join(tmpdir(), `pi-p1audit-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function readAuditLog(root: string): Promise<string> {
  const logPath = join(root, ".pi", "audit", getDateAuditFileName());
  try {
    return await readFile(logPath, "utf-8");
  } catch {
    return "";
  }
}

function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (m: any) => {
        updates.push(m);
        Object.assign(meta, m);
      },
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    updates,
  };
}

describe("Phase 1 audit: stage_advance events", () => {
  let root: string;

  beforeEach(async () => {
    root = makeTmpRoot("stage-adv");
    await mkdir(join(root, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);
  });

  it("writes stage_advance on successful advance", async () => {
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({ currentStage: "plan" });
    const ctx = createCtx(meta);

    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any) as any;

    expect(result.success).toBe(true);
    const log = await readAuditLog(root);
    expect(log).toContain("stage_advance");
    expect(log).toContain("fromStage=plan");
    expect(log).toContain("toStage=develop");
  });

  it("writes stage_advance_failed for invalid nextStage", async () => {
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({ currentStage: "plan" });
    const ctx = createCtx(meta);

    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "nonexistent" }, ctx as any) as any;

    expect(result.success).toBe(false);
    const log = await readAuditLog(root);
    expect(log).toContain("stage_advance_failed");
    expect(log).toContain("reason=invalid_next_stage");
  });

  it("writes stage_advance_failed for same-stage advance", async () => {
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({ currentStage: "plan" });
    const ctx = createCtx(meta);

    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "plan" }, ctx as any) as any;

    expect(result.success).toBe(false);
    const log = await readAuditLog(root);
    expect(log).toContain("stage_advance_failed");
    expect(log).toContain("reason=same_stage");
  });

  it("writes stage_advance_failed when already completed", async () => {
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({ currentStage: "completed" });
    const ctx = createCtx(meta);

    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any) as any;

    expect(result.success).toBe(false);
    const log = await readAuditLog(root);
    expect(log).toContain("stage_advance_failed");
    expect(log).toContain("reason=already_completed");
  });

  it("writes pipeline_completed when advancing to completed", async () => {
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({ currentStage: "fix" });
    // fix.nextStage in test config is awaiting_human; override to null (terminal)
    (config.stages.fix as any).nextStage = null;
    const ctx = createCtx(meta);

    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any) as any;

    expect(result.success).toBe(true);
    const log = await readAuditLog(root);
    expect(log).toContain("pipeline_completed");
    expect(log).toContain("finalStage=fix");
  });
});

describe("Phase 1 audit: pipeline_start event", () => {
  it("writes pipeline_start on fresh start with file", async () => {
    const root = makeTmpRoot("pstart");
    await mkdir(join(root, ".pi", "audit"), { recursive: true });

    // Create a fake doc file
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "req.md"), "# Requirement\ndo something");

    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const ctx = createCtx({});
    const cmd = createPipelineStartCommand(config);
    const result = await cmd.execute({ file: "req.md" }, ctx as any) as any;

    expect(result.success).toBe(true);
    const log = await readAuditLog(root);
    expect(log).toContain("pipeline_start");
    expect(log).toContain("file=req.md");
    expect(log).toContain("previousStage=none");

    await rm(root, { recursive: true, force: true });
  });
});

describe("Phase 1 audit: pipeline_state event", () => {
  it("writes pipeline_state with snapshot on each call", async () => {
    const root = makeTmpRoot("pstate");
    await mkdir(join(root, ".pi", "audit"), { recursive: true });

    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const tool = createPipelineState(config);
    await tool.execute({}, ctx as any);

    const log = await readAuditLog(root);
    expect(log).toContain("pipeline_state");
    expect(log).toContain("snapshot=");

    await rm(root, { recursive: true, force: true });
  });
});

describe("Phase 1 audit: loop_check event", () => {
  it("writes loop_check with action=advance on pass", async () => {
    const root = makeTmpRoot("lcheck-pass");
    await mkdir(join(root, ".pi", "audit"), { recursive: true });

    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const tool = createLoopChecker(config);
    await tool.execute({ result: "pass", summary: "all tests green" }, ctx as any);

    const log = await readAuditLog(root);
    expect(log).toContain("loop_check");
    expect(log).toContain("action=advance");
    expect(log).toContain("summary=all tests green");

    await rm(root, { recursive: true, force: true });
  });

  it("writes loop_check with action=retry on fail within limit", async () => {
    const root = makeTmpRoot("lcheck-retry");
    await mkdir(join(root, ".pi", "audit"), { recursive: true });

    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop", loopCount: 0, maxLoops: 3 });
    const ctx = createCtx(meta);

    const tool = createLoopChecker(config);
    await tool.execute({ result: "fail", summary: "test X failed" }, ctx as any);

    const log = await readAuditLog(root);
    expect(log).toContain("loop_check");
    expect(log).toContain("action=retry");

    await rm(root, { recursive: true, force: true });
  });
});
