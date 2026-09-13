/**
 * Phase 3 / 175: Tests for config-staleness detection.
 *
 * Validates:
 * - isConfigStale: mtime-based staleness check
 * - staleConfigNotice: throttled English notification
 * - Fail-open on IO errors
 * - Production chain: loadPipelineConfigFromJson → isConfigStale integration
 *   (directly asserts that the production loader injects staleness fields)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isConfigStale, staleConfigNotice } from "../../utils/config-staleness";
import { loadPipelineConfigFromJson, createPipelineFromJson } from "../../index";
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

// ─── Production chain integration: loadPipelineConfigFromJson → isConfigStale ──
// Verifies that the fields configSourcePath / configLoadedMtimeMs are actually
// injected by the production loader (prevents regression to the Blocker where
// these fields were declared in types but never populated in production).
// Uses loadPipelineConfigFromJson directly — the same function createPipelineFromJson
// delegates to — so we can assert the injected config without closure obscurity.

describe("production chain: loadPipelineConfigFromJson injects staleness fields", () => {
  let chainTmp: string;

  beforeEach(async () => {
    chainTmp = join(tmpdir(), "pi-stale-chain-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await mkdir(chainTmp, { recursive: true });
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    await rm(chainTmp, { recursive: true, force: true });
  });

  it("loadPipelineConfigFromJson injects configSourcePath and configLoadedMtimeMs", async () => {
    const cfgPath = join(chainTmp, "pipeline_loop.json");
    await writeFile(cfgPath, JSON.stringify({
      stages: {
        clarify: { require: true },
        plan: { require: true },
        develop: { require: true },
        review: { require: true },
        fix: { require: true },
        awaiting_human: { require: false },
        completed: { require: false },
      },
      maxLoops: 3,
    }));

    // Load via the production entry point
    const config = loadPipelineConfigFromJson(cfgPath);

    // Assert the fields WERE actually injected (not undefined)
    expect(config.configSourcePath).toBe(cfgPath);
    expect(config.configLoadedMtimeMs).toBeDefined();
    expect(typeof config.configLoadedMtimeMs).toBe("number");
    expect(config.configLoadedMtimeMs).toBeGreaterThan(0);
  });

  it("after load, file NOT stale → staleConfigNotice returns null", async () => {
    const cfgPath = join(chainTmp, "pipeline_loop.json");
    await writeFile(cfgPath, JSON.stringify({
      stages: {
        clarify: { require: true },
        plan: { require: true },
        develop: { require: true },
        review: { require: true },
        fix: { require: true },
        awaiting_human: { require: false },
        completed: { require: false },
      },
      maxLoops: 3,
    }));

    const config = loadPipelineConfigFromJson(cfgPath);

    // File not modified after load → not stale
    expect(isConfigStale(config)).toBe(false);
    expect(staleConfigNotice(config)).toBeNull();
  });

  it("after load then mtime change → isConfigStale true + staleConfigNotice non-null", async () => {
    const cfgPath = join(chainTmp, "pipeline_loop.json");
    await writeFile(cfgPath, JSON.stringify({
      stages: {
        clarify: { require: true },
        plan: { require: true },
        develop: { require: true },
        review: { require: true },
        fix: { require: true },
        awaiting_human: { require: false },
        completed: { require: false },
      },
      maxLoops: 3,
    }));

    // Load via production entry — this captures the CURRENT mtime
    const config = loadPipelineConfigFromJson(cfgPath);
    const originalMtime = config.configLoadedMtimeMs!;
    expect(originalMtime).toBeGreaterThan(0);

    // Simulate file modification (set mtime to the future)
    const futureTime = new Date(Date.now() + 10_000);
    await utimes(cfgPath, futureTime, futureTime);

    // NOW the config is stale relative to the captured load-time mtime
    expect(isConfigStale(config)).toBe(true);
    const notice = staleConfigNotice(config);
    expect(notice).not.toBeNull();
    expect(notice).toContain("/reload");
    expect(notice).toContain("pipeline_loop.json");
  });

  it("removing the production injection would cause isConfigStale to fail-open (false-green guard)", async () => {
    const cfgPath = join(chainTmp, "pipeline_loop.json");
    await writeFile(cfgPath, JSON.stringify({
      stages: {
        clarify: { require: true },
        plan: { require: true },
        develop: { require: true },
        review: { require: true },
        fix: { require: true },
        awaiting_human: { require: false },
        completed: { require: false },
      },
      maxLoops: 3,
    }));

    // Simulate the OLD broken behavior: load WITHOUT injection
    const { loadJsonConfig, resolvePipelineConfig } = await import("../../core/json-config-loader");
    const json = loadJsonConfig(cfgPath);
    const configWithoutInjection = resolvePipelineConfig(json);

    // Without injection → configSourcePath is undefined → isConfigStale returns false
    // This test PASSES if the production injection is working (because we use
    // loadPipelineConfigFromJson which DOES inject). If someone removes the
    // injection and switches the test to use the raw loader, this would fail.
    expect(configWithoutInjection.configSourcePath).toBeUndefined();
    expect(isConfigStale(configWithoutInjection)).toBe(false);

    // Meanwhile, the production loader DOES inject
    const configWithInjection = loadPipelineConfigFromJson(cfgPath);
    expect(configWithInjection.configSourcePath).toBe(cfgPath);
  });

  it("createPipelineFromJson still returns a valid factory (integration smoke)", async () => {
    const cfgPath = join(chainTmp, "pipeline_loop.json");
    await writeFile(cfgPath, JSON.stringify({
      stages: {
        clarify: { require: true },
        plan: { require: true },
        develop: { require: true },
        review: { require: true },
        fix: { require: true },
        awaiting_human: { require: false },
        completed: { require: false },
      },
      maxLoops: 3,
    }));

    const factory = createPipelineFromJson(cfgPath);
    expect(typeof factory).toBe("function");
  });
});
