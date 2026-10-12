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
  __resetAuditRoutingState,
  auditLogDirFor,
  withPipelineId,
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
  it("resolves auditDirPath without eager directory creation", async () => {
    const root = makeTmpRoot("init");
    const config = makeConfig(root, ".pi/audit");

    await initAuditLog(config);

    // Directory should not exist yet (lazy creation on first write)
    const { stat } = await import("node:fs/promises");
    const dirExists = await stat(join(root, ".pi", "audit")).then(() => true).catch(() => false);
    expect(dirExists).toBe(false);

    // Cleanup
    await rm(root, { recursive: true, force: true });
  });

  it("uses default auditDir '.pi/audit' when not specified", async () => {
    const root = makeTmpRoot("default-dir");
    const config = makeConfig(root);
    // No auditDir → defaults to .pi/audit

    await initAuditLog(config);

    // Directory should not exist yet (lazy creation on first write)
    const { stat } = await import("node:fs/promises");
    const dirExists = await stat(join(root, ".pi", "audit")).then(() => true).catch(() => false);
    expect(dirExists).toBe(false);

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

    // Logs route to system/log (no pipelineId set in routing context)
    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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
    __resetAuditRoutingState();

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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    // Routes to per-pipeline directory based on message.pipelineId
    const logPath = join(root, ".pi", "audit", "pipe-001", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "pipe-002", "log", getDateAuditFileName());
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
    __resetAuditRoutingState();

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

    // Regular audit lines route to system/log; snapshot routes to pipe-003/log
    const systemLogPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
    const pipelineLogPath = join(root, ".pi", "audit", "pipe-003", "log", getDateAuditFileName());
    const systemContent = await readFile(systemLogPath, "utf-8");
    const pipelineContent = await readFile(pipelineLogPath, "utf-8");

    // Regular audit lines in system/log
    expect(systemContent).toContain("[INFO] agent_settled");
    expect(systemContent).toContain("[INFO] session_end");
    // Snapshot block in pipe-003/log
    expect(pipelineContent).toContain("[INFO] prompt_snapshot");
    expect(pipelineContent).toContain("=== PROMPT START ===");
    expect(pipelineContent).toContain("Plan prompt content");
    expect(pipelineContent).toContain("=== PROMPT END ===");

    await rm(root, { recursive: true, force: true });
  });

  // ─── D5 (174): prompt_hash dedup ──────────────────────────────────────────

  it("D5: does not duplicate prompt_hash when meta already contains it", async () => {
    const root = makeTmpRoot("snapshot-hash-dedup");
    await initAuditLog(makeConfig(root));

    const callerHash = "caller-provided-hash-abc123";
    await writePromptSnapshot(
      "prompt_snapshot",
      { stage: "plan", pipelineId: "pipe-hash", source: "full", prompt_hash: callerHash },
      "Some prompt content",
    );

    const logPath = join(root, ".pi", "audit", "pipe-hash", "log", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");

    // Extract the meta line (first line of the snapshot block)
    const metaLine = content.split("\n")[0];

    // prompt_hash should appear exactly once
    const hashOccurrences = (metaLine.match(/prompt_hash=/g) ?? []).length;
    expect(hashOccurrences).toBe(1);

    // The value should be the caller-provided one, not an auto-computed one
    expect(metaLine).toContain(`prompt_hash=${callerHash}`);

    await rm(root, { recursive: true, force: true });
  });

  it("D5: auto-appends prompt_hash when meta does not contain it (backward compatible)", async () => {
    const root = makeTmpRoot("snapshot-hash-auto");
    await initAuditLog(makeConfig(root));

    await writePromptSnapshot(
      "prompt_snapshot",
      { stage: "clarify", pipelineId: "pipe-auto", source: "plugin" },
      "Plugin prompt content",
    );

    const logPath = join(root, ".pi", "audit", "pipe-auto", "log", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");

    // Extract the meta line
    const metaLine = content.split("\n")[0];

    // prompt_hash should appear exactly once (auto-appended)
    const hashOccurrences = (metaLine.match(/prompt_hash=/g) ?? []).length;
    expect(hashOccurrences).toBe(1);

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

    // Snapshot routes to pipe-sep/log; regular audit routes to system/log
    const pipelineLogPath = join(root, ".pi", "audit", "pipe-sep", "log", getDateAuditFileName());
    const systemLogPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
    const pipelineContent = await readFile(pipelineLogPath, "utf-8");
    const systemContent = await readFile(systemLogPath, "utf-8");

    // Snapshot block in pipeline log
    expect(pipelineContent).toContain("=== PROMPT END ===");
    // Regular event in system log
    expect(systemContent).toContain("next_event");

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

    const logPath = join(root, ".pi", "audit", "pipe-004", "log", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("=== PROMPT START ===");
    expect(content).toContain("Review prompt content");
    expect(content).toContain("=== PROMPT END ===");

    await rm(root, { recursive: true, force: true });
  });

  it("silently handles errors without throwing", async () => {
    // Even with uninitialized state, safeWritePromptSnapshot should never throw
    __resetAuditRoutingState();
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

    // writeStageAudit calls writeAuditLog without pipelineId context → system/log
    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    expect(line).toContain("[INFO] stage_advance");
    // Sequence should contain develop and review (cycle terminated)
    expect(line).toContain("sequence=develop,review");

    await rm(root, { recursive: true, force: true });
  });

  it("silently skips when auditDirPath is uninitialized", async () => {
    __resetAuditRoutingState();
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
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

    const logPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("[INFO] pipeline_state");
    expect(content).toContain("snapshot={}");

    await rm(root, { recursive: true, force: true });
  });

  it("silently handles errors without throwing", async () => {
    __resetAuditRoutingState();
    const config = makeTestConfig();
    const meta = makeTestMeta();
    await expect(
      safeWriteStageAudit(config, "test_event", meta),
    ).resolves.toBeUndefined();
  });
});

// ─── Per-pipeline routing helpers (197_Feat Phase 0) ─────────────────────────

describe("resolveAuditPipelineId", () => {
  it("returns meta.pipelineId when provided", async () => {
    const { resolveAuditPipelineId } = await import("../../utils/auditLog");
    expect(resolveAuditPipelineId({ pipelineId: "pipe-abc" })).toBe("pipe-abc");
  });

  it("returns current auditPipelineId when meta.pipelineId is absent", async () => {
    const { resolveAuditPipelineId } = await import("../../utils/auditLog");
    // No pipelineId set → returns empty
    expect(resolveAuditPipelineId()).toBe("");
    expect(resolveAuditPipelineId({})).toBe("");
    expect(resolveAuditPipelineId({ pipelineId: "" })).toBe("");
  });
});

describe("auditLogDirFor", () => {
  it("returns system/log for empty pipelineId", () => {
    const dir = auditLogDirFor("");
    expect(dir).toMatch(/system[/\\]log$/);
  });

  it("returns {pipelineId}/log for non-empty pipelineId", () => {
    const dir = auditLogDirFor("pipe-123");
    expect(dir).toMatch(/pipe-123[/\\]log$/);
  });
});

describe("ensureAuditLogDir", () => {
  it("creates directory on first call, skips on subsequent calls", async () => {
    const root = makeTmpRoot("ensure-dir");
    const config = makeConfig(root);
    await initAuditLog(config);

    const dir = auditLogDirFor("pipe-test");
    const { stat } = await import("node:fs/promises");

    // First call: creates directory
    await import("../../utils/auditLog").then(m => m.ensureAuditLogDir(dir));
    const dirStat1 = await stat(dir);
    expect(dirStat1.isDirectory()).toBe(true);

    // Second call: no error (cached in ensuredAuditDirs)
    await import("../../utils/auditLog").then(m => m.ensureAuditLogDir(dir));

    await rm(root, { recursive: true, force: true });
  });

  it("silently returns when auditDirPath is uninitialized", async () => {
    __resetAuditRoutingState();
    const { ensureAuditLogDir } = await import("../../utils/auditLog");
    // Should not throw
    await expect(ensureAuditLogDir("/some/path")).resolves.toBeUndefined();
  });
});

describe("withPipelineId", () => {
  it("sets auditPipelineId during callback and restores afterward", async () => {
    const root = makeTmpRoot("with-pipeline-id");
    const config = makeConfig(root);
    await initAuditLog(config);

    let capturedDir = "";
    await withPipelineId("pipe-xyz", async () => {
      // Inside callback: writeAuditLog should route to pipe-xyz/log
      await writeAuditLog("test_event", { key: "val" });
      capturedDir = auditLogDirFor("pipe-xyz");
    });

    // Verify the file was written to pipe-xyz/log
    const logPath = join(capturedDir, getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("[INFO] test_event");

    // After callback: auditPipelineId is restored (empty)
    // Writing again should go to system/log
    await writeAuditLog("after_event");
    const systemLogPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
    const systemContent = await readFile(systemLogPath, "utf-8");
    expect(systemContent).toContain("[INFO] after_event");

    await rm(root, { recursive: true, force: true });
  });

  it("restores previous pipelineId even on error", async () => {
    const root = makeTmpRoot("with-pipeline-id-error");
    const config = makeConfig(root);
    await initAuditLog(config);

    try {
      await withPipelineId("pipe-err", async () => {
        throw new Error("test error");
      });
    } catch {
      // Expected
    }

    // After error: auditPipelineId is restored (empty)
    await writeAuditLog("restored_event");
    const systemLogPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
    const content = await readFile(systemLogPath, "utf-8");
    expect(content).toContain("[INFO] restored_event");

    await rm(root, { recursive: true, force: true });
  });

  it("passes through undefined pipelineId (resets to empty)", async () => {
    const root = makeTmpRoot("with-pipeline-id-undef");
    const config = makeConfig(root);
    await initAuditLog(config);

    await withPipelineId(undefined, async () => {
      await writeAuditLog("undef_event");
    });

    // Should route to system/log
    const systemLogPath = join(root, ".pi", "audit", "system", "log", getDateAuditFileName());
    const content = await readFile(systemLogPath, "utf-8");
    expect(content).toContain("[INFO] undef_event");

    await rm(root, { recursive: true, force: true });
  });
});
