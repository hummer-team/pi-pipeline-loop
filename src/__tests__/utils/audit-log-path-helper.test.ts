import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditLogFileFor } from "../helpers";

function makeTmpRoot(label: string): string {
  return join(tmpdir(), `pi-auditlog-helper-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("auditLogFileFor", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpRoot("helper");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("uses explicit pipelineId when provided (non-empty)", async () => {
    await mkdir(root, { recursive: true });
    const result = auditLogFileFor(root, "pipe-explicit-123");
    expect(result).toContain("pipe-explicit-123");
    expect(result).toContain("log");
    expect(result).toMatch(/pipe-explicit-123[/\\]log[/\\].*_audit\.log$/);
  });

  it("uses 'system' when explicit pipelineId is empty string", async () => {
    await mkdir(root, { recursive: true });
    const result = auditLogFileFor(root, "");
    expect(result).toContain("system");
    expect(result).toMatch(/system[/\\]log[/\\].*_audit\.log$/);
  });

  it("infers 'system' when no pipe-* directories exist (0 dirs)", async () => {
    await mkdir(root, { recursive: true });
    // Create some non-pipe directories to ensure they're ignored
    await mkdir(join(root, "other-dir"), { recursive: true });
    await mkdir(join(root, "system"), { recursive: true });

    const result = auditLogFileFor(root);
    expect(result).toContain("system");
    expect(result).toMatch(/system[/\\]log[/\\].*_audit\.log$/);
  });

  it("infers single pipe-* directory when exactly 1 exists", async () => {
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "pipe-single"), { recursive: true });

    const result = auditLogFileFor(root);
    expect(result).toContain("pipe-single");
    expect(result).toMatch(/pipe-single[/\\]log[/\\].*_audit\.log$/);
  });

  it("throws when multiple pipe-* directories exist (>1 dirs)", async () => {
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "pipe-first"), { recursive: true });
    await mkdir(join(root, "pipe-second"), { recursive: true });

    expect(() => auditLogFileFor(root)).toThrow(/multiple pipeline directories found/);
    expect(() => auditLogFileFor(root)).toThrow(/pipe-first/);
    expect(() => auditLogFileFor(root)).toThrow(/pipe-second/);
  });

  it("falls back to 'system' when directory doesn't exist (ENOENT)", async () => {
    // Don't create root - it doesn't exist
    const result = auditLogFileFor(root);
    expect(result).toContain("system");
    expect(result).toMatch(/system[/\\]log[/\\].*_audit\.log$/);
  });

  it("returns path with date-based filename", async () => {
    await mkdir(root, { recursive: true });
    const result = auditLogFileFor(root, "pipe-test");
    // Should end with a date-based filename like YYYYMMDD_audit.log
    expect(result).toMatch(/\d{8}_audit\.log$/);
  });
});
