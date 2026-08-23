import { describe, it, expect } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initAuditLog,
  writeAuditLog,
  safeWriteAuditLog,
  writeStageAudit,
  safeWriteStageAudit,
  getDateAuditFileName,
  writePromptSnapshot,
  safeWritePromptSnapshot,
  __resetAuditDirPath,
} from "../../utils/auditLog";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";

function makeTmpRoot(label: string): string {
  return join(tmpdir(), `pi-auditlog-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeConfig(projectRoot: string, auditDir?: string): PipelineConfig {
  return {
    projectRoot,
    auditDir,
    stages: {} as PipelineConfig["stages"],
  } as PipelineConfig;
}

describe("initAuditLog", () => {
  it("creates the audit directory recursively", async () => {
    const root = makeTmpRoot("init");
    const config = makeConfig(root, ".pi/audit");

    await initAuditLog(config);

    // Directory should now exist
    const { stat } = await import("node:fs/promises");
    const dirStat = await stat(join(root, ".pi", "audit"));
    expect(dirStat.isDirectory()).toBe(true);

    // Cleanup
    await rm(root, { recursive: true, force: true });
  });

  it("uses default auditDir '.pi/audit' when not specified", async () => {
    const root = makeTmpRoot("default-dir");
    const config = makeConfig(root);
    // No auditDir → defaults to .pi/audit

    await initAuditLog(config);

    const { stat } = await import("node:fs/promises");
    const dirStat = await stat(join(root, ".pi", "audit"));
    expect(dirStat.isDirectory()).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});

describe("getDateAuditFileName", () => {
  it("returns a filename matching YYYYMMDD_audit.log pattern", () => {
    const filename = getDateAuditFileName();
    expect(filename).toMatch(/^\d{8}_audit\.log$/);
  });

  it("starts with the current date digits", () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const expectedPrefix = `${y}${m}${day}`;

    const filename = getDateAuditFileName();
    expect(filename.startsWith(expectedPrefix)).toBe(true);
  });
});

describe("writeAuditLog", () => {
  it("writes a formatted line with stage and key=value pairs", async () => {
    const root = makeTmpRoot("write-basic");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("agent_settled", {
      pipelineId: "pipe-001",
      stage: "plan",
    });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    // Timestamp format: YYYY-MM-DD HH:mm:ss
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - /);
    expect(line).toContain(" - [INFO] agent_settled");
    expect(line).toContain("pipelineId=pipe-001");
    expect(line).toContain("stage=plan");

    await rm(root, { recursive: true, force: true });
  });

  it("writes only stage when message is undefined", async () => {
    const root = makeTmpRoot("write-nomsg");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("session_end");

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[INFO\] session_end$/);
    // Should NOT contain any pipe separators (no key=value pairs)
    expect(line).not.toContain("|");

    await rm(root, { recursive: true, force: true });
  });

  it("writes only stage when message is an empty object", async () => {
    const root = makeTmpRoot("write-emptymsg");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("test_action", {});

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    expect(line).toMatch(/- \[INFO\] test_action$/);
    expect(line).not.toContain("|");

    await rm(root, { recursive: true, force: true });
  });

  it("preserves key order from the message object", async () => {
    const root = makeTmpRoot("write-order");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("handoff", {
      from: "clarify",
      to: "plan",
      model: "gpt-4o",
    });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    // Verify ordering: from=... appears before to=... which appears before model=...
    const fromIdx = line.indexOf("from=clarify");
    const toIdx = line.indexOf("to=plan");
    const modelIdx = line.indexOf("model=gpt-4o");
    expect(fromIdx).toBeGreaterThan(-1);
    expect(toIdx).toBeGreaterThan(fromIdx);
    expect(modelIdx).toBeGreaterThan(toIdx);

    await rm(root, { recursive: true, force: true });
  });

  it("appends multiple writes without overwriting", async () => {
    const root = makeTmpRoot("write-append");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("first_action", { key: "val1" });
    await writeAuditLog("second_action", { key: "val2" });
    await writeAuditLog("third_action");

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(3);
    expect(lines[0]).toContain(" - [INFO] first_action");
    expect(lines[0]).toContain("key=val1");
    expect(lines[1]).toContain(" - [INFO] second_action");
    expect(lines[1]).toContain("key=val2");
    expect(lines[2]).toContain(" - [INFO] third_action");
    expect(lines[2]).not.toContain("|");

    await rm(root, { recursive: true, force: true });
  });
});

describe("writeAuditLog level parameter", () => {
  it('level "warn" produces [WARN] prefix', async () => {
    const root = makeTmpRoot("level-warn");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("auto_verify_fail", { stage: "plan" }, "warn");

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[WARN\] auto_verify_fail/);
    expect(line).toContain("[WARN] auto_verify_fail");

    await rm(root, { recursive: true, force: true });
  });

  it('level "error" produces [ERROR] prefix', async () => {
    const root = makeTmpRoot("level-error");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("pipeline_start_error", { file: "missing.md", error: "not found" }, "error");

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[ERROR\] pipeline_start_error/);
    expect(line).toContain("[ERROR] pipeline_start_error");
    expect(line).toContain("file=missing.md");

    await rm(root, { recursive: true, force: true });
  });

  it('default level "info" produces [INFO] prefix', async () => {
    const root = makeTmpRoot("level-info");
    await initAuditLog(makeConfig(root));

    // Explicit "info"
    await writeAuditLog("agent_settled", { pipelineId: "p1" }, "info");
    // Default (no level arg)
    await writeAuditLog("session_end", { pipelineId: "p2" });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");

    // Neither line should contain [WARN] or [ERROR], but should contain [INFO]
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[INFO\] agent_settled/);
    expect(lines[0]).not.toContain("[WARN]");
    expect(lines[0]).not.toContain("[ERROR]");
    expect(lines[0]).toContain("[INFO]");
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[INFO\] session_end/);
    expect(lines[1]).not.toContain("[WARN]");
    expect(lines[1]).not.toContain("[ERROR]");
    expect(lines[1]).toContain("[INFO]");

    await rm(root, { recursive: true, force: true });
  });
});

describe("writeAuditLog guard: uninitialized auditDirPath", () => {
  it("does not throw or produce files when auditDirPath is empty", async () => {
    // Reset the module-level state to simulate uninitialized condition
    __resetAuditDirPath();

    // Should silently return without throwing
    await expect(writeAuditLog("should_not_write", { test: "true" })).resolves.toBeUndefined();

    // Restore state for other tests by re-initializing to a temp directory
    const root = makeTmpRoot("guard-restore");
    await initAuditLog(makeConfig(root));
    await rm(root, { recursive: true, force: true });
  });
});

describe("safeWriteAuditLog", () => {
  it("writes to audit log like writeAuditLog but never throws", async () => {
    const root = makeTmpRoot("safe-write");
    await initAuditLog(makeConfig(root));

    // Should succeed normally
    await safeWriteAuditLog("test_action", { key: "val" }, "error");

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content.trim()).toContain("[ERROR] test_action");

    await rm(root, { recursive: true, force: true });
  });

  it("silently handles errors without throwing", async () => {
    // Even with arbitrary state, safeWriteAuditLog should never throw
    await expect(safeWriteAuditLog("test", {}, "error")).resolves.toBeUndefined();
  });
});

describe("writePromptSnapshot", () => {
  it("writes metadata line, START/END markers, and multiline prompt content", async () => {
    const root = makeTmpRoot("snapshot-basic");
    await initAuditLog(makeConfig(root));

    const multilinePrompt = "Line 1: Pipeline Status\nLine 2: Stage=clarify\nLine 3: Domain=test";
    await writePromptSnapshot(
      "prompt_snapshot",
      { stage: "clarify", pipelineId: "pipe-001", source: "yml" },
      multilinePrompt,
    );

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");

    // Metadata line should contain the event type and key=value pairs
    expect(content).toContain("[INFO] prompt_snapshot");
    expect(content).toContain("stage=clarify");
    expect(content).toContain("pipelineId=pipe-001");
    expect(content).toContain("source=yml");

    // START and END markers must be present
    expect(content).toContain("=== PROMPT START ===");
    expect(content).toContain("=== PROMPT END ===");

    // Multiline prompt content must be preserved as-is
    expect(content).toContain("Line 1: Pipeline Status");
    expect(content).toContain("Line 2: Stage=clarify");
    expect(content).toContain("Line 3: Domain=test");

    // Markers should be in correct order
    const metaIdx = content.indexOf("[INFO] prompt_snapshot");
    const startIdx = content.indexOf("=== PROMPT START ===");
    const promptIdx = content.indexOf("Line 1: Pipeline Status");
    const endIdx = content.indexOf("=== PROMPT END ===");
    expect(metaIdx).toBeLessThan(startIdx);
    expect(startIdx).toBeLessThan(promptIdx);
    expect(promptIdx).toBeLessThan(endIdx);

    await rm(root, { recursive: true, force: true });
  });

  it("preserves prompt content with special characters and blank lines", async () => {
    const root = makeTmpRoot("snapshot-special");
    await initAuditLog(makeConfig(root));

    const promptWithSpecialChars = "# Header\n\nSome content\n---\nMore content\n\n# Footer";
    await writePromptSnapshot(
      "prompt_snapshot",
      { stage: "develop", pipelineId: "pipe-002", source: "fallback" },
      promptWithSpecialChars,
    );

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");

    // Special characters and blank lines should be preserved
    expect(content).toContain("# Header");
    expect(content).toContain("---");
    expect(content).toContain("More content");
    expect(content).toContain("# Footer");
    expect(content).toContain("source=fallback");

    await rm(root, { recursive: true, force: true });
  });

  it("does not throw or write when auditDirPath is uninitialized", async () => {
    __resetAuditDirPath();

    // Should silently return without throwing
    await expect(
      writePromptSnapshot("prompt_snapshot", { stage: "clarify" }, "some prompt"),
    ).resolves.toBeUndefined();
  });

  it("appends correctly alongside regular writeAuditLog entries", async () => {
    const root = makeTmpRoot("snapshot-mixed");
    await initAuditLog(makeConfig(root));

    // Write a regular audit line first
    await writeAuditLog("agent_settled", { pipelineId: "pipe-003" });
    // Then write a prompt snapshot
    await writePromptSnapshot(
      "prompt_snapshot",
      { stage: "plan", pipelineId: "pipe-003", source: "yml" },
      "Plan prompt content",
    );
    // Then another regular audit line
    await writeAuditLog("session_end", { pipelineId: "pipe-003" });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");

    // Regular audit line should be present
    expect(content).toContain("[INFO] agent_settled");
    // Snapshot block should be present
    expect(content).toContain("[INFO] prompt_snapshot");
    expect(content).toContain("=== PROMPT START ===");
    expect(content).toContain("Plan prompt content");
    expect(content).toContain("=== PROMPT END ===");
    // Second regular line should be present
    expect(content).toContain("[INFO] session_end");

    await rm(root, { recursive: true, force: true });
  });

  it("inserts a blank line between snapshot block and next audit event (E7 protocol)", async () => {
    const root = makeTmpRoot("snapshot-blank-sep");
    await initAuditLog(makeConfig(root));

    // Write a snapshot followed immediately by a regular audit event
    await writePromptSnapshot(
      "prompt_snapshot",
      { stage: "clarify", pipelineId: "pipe-sep", source: "yml" },
      "Prompt text",
    );
    await writeAuditLog("next_event", { pipelineId: "pipe-sep" });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");

    // After "=== PROMPT END ===" there must be a blank line before the next event
    const endMarkerIdx = content.indexOf("=== PROMPT END ===");
    const nextEventIdx = content.indexOf("next_event");
    expect(endMarkerIdx).toBeGreaterThan(-1);
    expect(nextEventIdx).toBeGreaterThan(-1);

    // Extract the text between END marker and next event
    const between = content.slice(endMarkerIdx + "=== PROMPT END ===".length, nextEventIdx);
    // Should contain at least two newlines: one ending the END line, one blank line
    // i.e. "\n\n" (END\n + blank\n before next event line)
    expect(between).toMatch(/\n\n/);

    await rm(root, { recursive: true, force: true });
  });
});

describe("safeWritePromptSnapshot", () => {
  it("writes snapshot like writePromptSnapshot but never throws", async () => {
    const root = makeTmpRoot("safe-snapshot");
    await initAuditLog(makeConfig(root));

    await safeWritePromptSnapshot(
      "prompt_snapshot",
      { stage: "review", pipelineId: "pipe-004", source: "yml" },
      "Review prompt content",
    );

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("=== PROMPT START ===");
    expect(content).toContain("Review prompt content");
    expect(content).toContain("=== PROMPT END ===");

    await rm(root, { recursive: true, force: true });
  });

  it("silently handles errors without throwing", async () => {
    // Even with uninitialized state, safeWritePromptSnapshot should never throw
    __resetAuditDirPath();
    await expect(
      safeWritePromptSnapshot("prompt_snapshot", { stage: "test" }, "prompt"),
    ).resolves.toBeUndefined();
  });
});

describe("writeStageAudit", () => {
  it("writes audit line with auto-enriched pipelineId/stage/sequence/loop fields", async () => {
    const root = makeTmpRoot("stage-audit-basic");
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    await writeStageAudit(config, "stage_advance", meta, {
      fromStage: "plan",
      toStage: "develop",
    });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    // Standard fields
    expect(line).toContain("[INFO] stage_advance");
    expect(line).toContain("pipelineId=pipe-test-001");
    expect(line).toContain("stage=develop");
    expect(line).toContain("loopCount=0");
    expect(line).toContain("maxLoops=3");

    // Sequence field: forward chain from develop
    expect(line).toContain("sequence=");
    const seqMatch = line.match(/sequence=([^\s|]+)/);
    expect(seqMatch).not.toBeNull();
    const seqParts = seqMatch![1].split(",");
    expect(seqParts[0]).toBe("develop");
    expect(seqParts).toContain("completed");

    // Extra fields
    expect(line).toContain("fromStage=plan");
    expect(line).toContain("toStage=develop");

    await rm(root, { recursive: true, force: true });
  });

  it("sequence includes completed for terminal chain", async () => {
    const root = makeTmpRoot("stage-audit-seq");
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "clarify" });
    await writeStageAudit(config, "pipeline_start", meta);

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    const seqMatch = line.match(/sequence=([^\s|]+)/);
    expect(seqMatch).not.toBeNull();
    expect(seqMatch![1]).toContain("completed");
  });

  it("handles circular chain without infinite loop in sequence", async () => {
    const root = makeTmpRoot("stage-audit-cycle");
    const config = makeTestConfig({ projectRoot: root });
    // Create a cycle: develop → review → develop
    (config.stages.develop as any).nextStage = "review";
    (config.stages.review as any).nextStage = "develop";
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    // Should NOT hang — visited-set guard terminates the loop
    await writeStageAudit(config, "stage_advance", meta);

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    expect(line).toContain("[INFO] stage_advance");
    // Sequence should contain develop and review (cycle terminated)
    expect(line).toContain("sequence=develop,review");

    await rm(root, { recursive: true, force: true });
  });

  it("silently skips when auditDirPath is uninitialized", async () => {
    __resetAuditDirPath();
    const config = makeTestConfig();
    const meta = makeTestMeta();

    // Should not throw
    await expect(
      writeStageAudit(config, "stage_advance", meta),
    ).resolves.toBeUndefined();
  });

  it("respects custom log level (warn)", async () => {
    const root = makeTmpRoot("stage-audit-warn");
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta();
    await writeStageAudit(config, "stage_advance_failed", meta, { reason: "invalid_next" }, "warn");

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("[WARN] stage_advance_failed");
    expect(content).toContain("reason=invalid_next");

    await rm(root, { recursive: true, force: true });
  });
});

describe("safeWriteStageAudit", () => {
  it("writes audit line like writeStageAudit but never throws", async () => {
    const root = makeTmpRoot("safe-stage-audit");
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta();
    await safeWriteStageAudit(config, "pipeline_state", meta, { snapshot: "{}" });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("[INFO] pipeline_state");
    expect(content).toContain("snapshot={}");

    await rm(root, { recursive: true, force: true });
  });

  it("silently handles errors without throwing", async () => {
    __resetAuditDirPath();
    const config = makeTestConfig();
    const meta = makeTestMeta();
    await expect(
      safeWriteStageAudit(config, "test_event", meta),
    ).resolves.toBeUndefined();
  });
});
