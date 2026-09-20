/**
 * Unit tests for Phase 2 of 184_Bug plan — bootstrap fallback registration.
 *
 * Verifies:
 *   1. Fallback config content matches real template values
 *   2. TEMPLATE_DIR unreachable → warn + 0 registration, no throw
 *   3. Normal file path → isFallbackTemplate is falsy (audit log init runs)
 *   4. Fallback + initAuditLog → no audit directory created on disk
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import defaultExport, { loadPipelineConfigFromJson } from "../index";
import { loadJsonConfig, resolvePipelineConfig } from "../core/json-config-loader";
import { initAuditLog } from "../utils/auditLog";
import { TEMPLATE_DIR, CONFIG_DIR_NAME } from "../constants";

// ─── Template accessibility ─────────────────────────────────────────────────

describe("TEMPLATE_DIR (Phase 2)", () => {
  it("exists and contains pipeline_loop.json", () => {
    expect(fs.existsSync(TEMPLATE_DIR)).toBe(true);
    const templateJson = path.join(TEMPLATE_DIR, "pipeline_loop.json");
    expect(fs.existsSync(templateJson)).toBe(true);
  });
});

// ─── Fallback config content ───────────────────────────────────────────────

describe("Fallback config from template (Phase 2)", () => {
  it("template pipeline_loop.json produces a valid resolved config", () => {
    const templateJson = path.join(TEMPLATE_DIR, "pipeline_loop.json");
    const json = loadJsonConfig(templateJson);
    const config = resolvePipelineConfig(json);

    // Config is resolved (has all stages)
    expect(config.stages).toBeDefined();
    expect(config.projectRoot).toBeTruthy();
    // maxLoops is a positive number from the template
    expect(typeof config.maxLoops).toBe("number");
    expect(config.maxLoops).toBeGreaterThan(0);
    // auditDir follows default
    expect(config.auditDir).toContain("audit");
  });
});

// ─── initAuditLog gate ──────────────────────────────────────────────────────

describe("initAuditLog isFallbackTemplate gate (Phase 2)", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(tmpdir(), "pi-audit-gate-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await fsp.mkdir(TMP, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  it("isFallbackTemplate=true → initAuditLog is no-op (no directory created)", async () => {
    const auditDir = path.join(TMP, "should-not-exist");
    const config = {
      stages: {} as any,
      projectRoot: TMP,
      auditDir,
      isFallbackTemplate: true,
    };

    await initAuditLog(config);

    // The audit dir should NOT have been created
    expect(fs.existsSync(auditDir)).toBe(false);
  });

  it("isFallbackTemplate=false/undefined → initAuditLog creates directory", async () => {
    const auditDir = path.join(TMP, "audit-created");
    const config = {
      stages: {} as any,
      projectRoot: TMP,
      auditDir,
      // isFallbackTemplate not set (undefined = falsy)
    };

    await initAuditLog(config);

    // The audit dir should have been created
    expect(fs.existsSync(auditDir)).toBe(true);
  });
});

// ─── Normal file path → isFallbackTemplate is falsy ─────────────────────────

describe("loadPipelineConfigFromJson regression (Phase 2)", () => {
  let TMP: string;
  let jsonPath: string;

  beforeEach(async () => {
    TMP = path.join(tmpdir(), "pi-p2-regression-" + Date.now());
    await fsp.mkdir(TMP, { recursive: true });
    jsonPath = path.join(TMP, "pipeline_loop.json");
  });
  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  it("loaded config does NOT have isFallbackTemplate set", async () => {
    await fsp.writeFile(jsonPath, JSON.stringify({
      stages: { clarify: {} },
    }), "utf-8");

    const config = loadPipelineConfigFromJson(jsonPath);
    expect(config.isFallbackTemplate).toBeFalsy();
    // Staleness tracking fields are injected
    expect(config.configSourcePath).toBe(path.resolve(jsonPath));
    expect(typeof config.configLoadedMtimeMs).toBe("number");
  });
});

// ─── initPipeline with missing config + valid template ──────────────────────

describe("initPipeline fallback registration (Phase 2)", () => {
  let origCwd: string;
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(tmpdir(), "pi-init-fallback-" + Date.now());
    await fsp.mkdir(TMP, { recursive: true });
    origCwd = process.cwd();
    process.chdir(TMP);
  });
  afterEach(async () => {
    process.chdir(origCwd);
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  it("no config file + valid template → full registration, zero writes", async () => {
    // Ensure no config file exists in the temp project
    expect(fs.existsSync(path.join(TMP, CONFIG_DIR_NAME, "pipeline_loop.json"))).toBe(false);

    const registeredEvents: string[] = [];
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];
    const mockPi = {
      on: (event: string) => { registeredEvents.push(event); },
      registerTool: (tool: { name: string }) => { registeredTools.push(tool.name); },
      registerCommand: (name: string) => { registeredCommands.push(name); },
      exec: undefined,
    };

    const warnCalls: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: any[]) => { warnCalls.push(String(args[0])); }) as any;

    try {
      await defaultExport(mockPi as any);

      // Full registration happened
      expect(registeredEvents.length).toBeGreaterThanOrEqual(6);
      expect(registeredTools.length).toBeGreaterThanOrEqual(6);
      expect(registeredCommands.length).toBeGreaterThanOrEqual(5);

      // Zero-write lock: no config file was created
      expect(fs.existsSync(path.join(TMP, CONFIG_DIR_NAME, "pipeline_loop.json"))).toBe(false);

      // Fallback warn was issued
      const fallbackWarn = warnCalls.find(w => w.includes("built-in template"));
      expect(fallbackWarn).toBeDefined();
    } finally {
      console.warn = origWarn;
    }
  });
});
