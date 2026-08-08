import { describe, it, expect } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initAuditLog,
  writeAuditLog,
  getDateAuditFileName,
} from "../../utils/auditLog";
import type { PipelineConfig } from "../../types";

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
      stage: "design",
    });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    // Timestamp format: YYYY-MM-DD HH:mm:ss
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - /);
    expect(line).toContain(" - agent_settled");
    expect(line).toContain("pipelineId=pipe-001");
    expect(line).toContain("stage=design");

    await rm(root, { recursive: true, force: true });
  });

  it("writes only stage when message is undefined", async () => {
    const root = makeTmpRoot("write-nomsg");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("session_end");

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - session_end$/);
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

    expect(line).toMatch(/- test_action$/);
    expect(line).not.toContain("|");

    await rm(root, { recursive: true, force: true });
  });

  it("preserves key order from the message object", async () => {
    const root = makeTmpRoot("write-order");
    await initAuditLog(makeConfig(root));

    await writeAuditLog("handoff", {
      from: "design",
      to: "plan",
      model: "gpt-4o",
    });

    const logPath = join(root, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim();

    // Verify ordering: from=... appears before to=... which appears before model=...
    const fromIdx = line.indexOf("from=design");
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
    expect(lines[0]).toContain(" - first_action");
    expect(lines[0]).toContain("key=val1");
    expect(lines[1]).toContain(" - second_action");
    expect(lines[1]).toContain("key=val2");
    expect(lines[2]).toContain(" - third_action");
    expect(lines[2]).not.toContain("|");

    await rm(root, { recursive: true, force: true });
  });
});
