/**
 * Phase 3 / 175: Tests for config-staleness detection.
 *
 * Validates:
 * - isConfigStale: mtime-based staleness check
 * - staleConfigNotice: throttled English notification
 * - Fail-open on IO errors
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isConfigStale, staleConfigNotice } from "../../utils/config-staleness";
import { makeTestConfig } from "../helpers";
import { mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";

let TMP: string;

beforeEach(async () => {
  TMP = join(tmpdir(), "pi-stale-cfg-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  await mkdir(TMP, { recursive: true });
  __resetMemoryThrottle();
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("isConfigStale", () => {
  it("returns false when no configSourcePath is set", () => {
    const config = makeTestConfig({ projectRoot: TMP });
    expect(isConfigStale(config)).toBe(false);
  });

  it("returns false when mtime has not changed", async () => {
    const cfgPath = join(TMP, "pipeline_loop.json");
    await writeFile(cfgPath, "{}", "utf-8");
    const config = makeTestConfig({
      projectRoot: TMP,
      configSourcePath: cfgPath,
      configLoadedMtimeMs: Date.now() + 60_000, // Future mtime → not stale
    });
    expect(isConfigStale(config)).toBe(false);
  });

  it("returns true when file mtime > loaded mtime", async () => {
    const cfgPath = join(TMP, "pipeline_loop.json");
    await writeFile(cfgPath, "{}", "utf-8");
    // Set file mtime to the past
    const pastMtime = new Date(Date.now() - 10_000);
    await utimes(cfgPath, pastMtime, pastMtime);

    const config = makeTestConfig({
      projectRoot: TMP,
      configSourcePath: cfgPath,
      configLoadedMtimeMs: Date.now() - 60_000, // Loaded 60s ago
    });
    expect(isConfigStale(config)).toBe(true);
  });

  it("fail-open: returns false when file does not exist", () => {
    const config = makeTestConfig({
      projectRoot: TMP,
      configSourcePath: join(TMP, "nonexistent.json"),
      configLoadedMtimeMs: Date.now(),
    });
    expect(isConfigStale(config)).toBe(false);
  });
});

describe("staleConfigNotice", () => {
  it("returns null when config is not stale", async () => {
    const cfgPath = join(TMP, "pipeline_loop.json");
    await writeFile(cfgPath, "{}", "utf-8");
    const config = makeTestConfig({
      projectRoot: TMP,
      configSourcePath: cfgPath,
      configLoadedMtimeMs: Date.now() + 60_000,
    });
    expect(staleConfigNotice(config)).toBeNull();
  });

  it("returns English notice with /reload guidance when stale", async () => {
    const cfgPath = join(TMP, "pipeline_loop.json");
    await writeFile(cfgPath, "{}", "utf-8");
    const pastMtime = new Date(Date.now() - 10_000);
    await utimes(cfgPath, pastMtime, pastMtime);

    const config = makeTestConfig({
      projectRoot: TMP,
      configSourcePath: cfgPath,
      configLoadedMtimeMs: Date.now() - 60_000,
    });

    const notice = staleConfigNotice(config);
    expect(notice).not.toBeNull();
    expect(notice).toContain("/reload");
    expect(notice).toContain("pipeline_loop.json");
    // Must be English
    expect(notice).toContain("modified");
    expect(notice).toContain("reload");
  });

  it("throttled: second call within 60s returns null", async () => {
    const cfgPath = join(TMP, "pipeline_loop.json");
    await writeFile(cfgPath, "{}", "utf-8");
    const pastMtime = new Date(Date.now() - 10_000);
    await utimes(cfgPath, pastMtime, pastMtime);

    const config = makeTestConfig({
      projectRoot: TMP,
      configSourcePath: cfgPath,
      configLoadedMtimeMs: Date.now() - 60_000,
    });

    // First call → notice
    const first = staleConfigNotice(config);
    expect(first).not.toBeNull();

    // Second call within throttle window → null
    const second = staleConfigNotice(config);
    expect(second).toBeNull();
  });
});
