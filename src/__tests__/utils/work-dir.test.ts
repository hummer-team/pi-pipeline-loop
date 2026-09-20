/**
 * Unit tests for src/utils/work-dir.ts — centralized piWorkDir resolvers.
 *
 * Phase 0 of 184_Bug plan: piWorkDir parsing, resolve-time prefix rewrite,
 * and work-dir helper functions.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir, homedir } from "node:os";
import { resolvePiWorkDir, resolveAuditDir, resolveDomainSkillCandidates } from "../../utils/work-dir";
import { loadJsonConfig, resolvePipelineConfig, parsePiWorkDir, rewritePiPrefix } from "../../core/json-config-loader";
import { CONFIG_DIR_NAME } from "../../constants";
import type { PipelineConfig } from "../../types";

// ─── parsePiWorkDir ─────────────────────────────────────────────────────────

describe("parsePiWorkDir", () => {
  let warns: string[];
  const origWarn = console.warn;

  beforeEach(() => {
    warns = [];
    console.warn = (msg: string) => { warns.push(msg); };
  });
  afterEach(() => {
    console.warn = origWarn;
  });

  it("missing (undefined) → falls back to CONFIG_DIR_NAME silently", () => {
    expect(parsePiWorkDir(undefined)).toBe(CONFIG_DIR_NAME);
    expect(warns).toHaveLength(0);
  });

  it("valid single-segment name → returned as-is", () => {
    expect(parsePiWorkDir("piwork")).toBe("piwork");
    expect(warns).toHaveLength(0);
  });

  it("valid multi-segment path → returned as-is", () => {
    expect(parsePiWorkDir("tools/pi/v1")).toBe("tools/pi/v1");
    expect(warns).toHaveLength(0);
  });

  it("empty string → falls back with warn", () => {
    expect(parsePiWorkDir("")).toBe(CONFIG_DIR_NAME);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('""');
  });

  it("absolute POSIX path → falls back with warn", () => {
    expect(parsePiWorkDir("/etc/pi")).toBe(CONFIG_DIR_NAME);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("absolute");
  });

  it("absolute Windows path → falls back with warn", () => {
    expect(parsePiWorkDir("C:\\pi")).toBe(CONFIG_DIR_NAME);
    expect(warns).toHaveLength(1);
  });

  it(".. segment → falls back with warn", () => {
    expect(parsePiWorkDir("pi/../escape")).toBe(CONFIG_DIR_NAME);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('".."');
  });

  it("non-string (number) → falls back with warn", () => {
    expect(parsePiWorkDir(42)).toBe(CONFIG_DIR_NAME);
    expect(warns).toHaveLength(1);
  });
});

// ─── rewritePiPrefix ────────────────────────────────────────────────────────

describe("rewritePiPrefix", () => {
  it("returns input unchanged when piWorkDir is the default", () => {
    expect(rewritePiPrefix(".pi/agents/x.md", ".pi")).toBe(".pi/agents/x.md");
  });

  it("rewrites .pi/ prefix when piWorkDir differs", () => {
    expect(rewritePiPrefix(".pi/agents/x.md", "piwork")).toBe("piwork/agents/x.md");
  });

  it("rewrites only the first .pi/ prefix", () => {
    expect(rewritePiPrefix(".pi/nested/.pi/file.md", "piwork")).toBe("piwork/nested/.pi/file.md");
  });

  it("returns non-.pi paths unchanged", () => {
    expect(rewritePiPrefix("other/agents/x.md", "piwork")).toBe("other/agents/x.md");
  });

  it("absolute path → no match → unchanged", () => {
    expect(rewritePiPrefix("/abs/path.md", "piwork")).toBe("/abs/path.md");
  });

  it("~ prefixed path → no match → unchanged", () => {
    expect(rewritePiPrefix("~/.pi/domains/x.md", "piwork")).toBe("~/.pi/domains/x.md");
  });

  it("empty path → no match → unchanged", () => {
    expect(rewritePiPrefix("", "piwork")).toBe("");
  });
});

// ─── resolvePiWorkDir / resolveAuditDir ─────────────────────────────────────

describe("resolvePiWorkDir", () => {
  const baseConfig = {
    stages: {} as PipelineConfig["stages"],
    projectRoot: "/tmp/test",
  } as PipelineConfig;

  it("configured piWorkDir → returned as-is", () => {
    expect(resolvePiWorkDir({ ...baseConfig, piWorkDir: "custom" })).toBe("custom");
  });

  it("undefined piWorkDir → falls back to CONFIG_DIR_NAME", () => {
    expect(resolvePiWorkDir({ ...baseConfig })).toBe(CONFIG_DIR_NAME);
  });
});

describe("resolveAuditDir", () => {
  const baseConfig = {
    stages: {} as PipelineConfig["stages"],
    projectRoot: "/tmp/test",
  } as PipelineConfig;

  it("configured auditDir takes priority", () => {
    const cfg = { ...baseConfig, auditDir: "custom/audit" };
    expect(resolveAuditDir(cfg)).toBe("custom/audit");
  });

  it("undefined auditDir → derived from piWorkDir", () => {
    const cfg = { ...baseConfig, piWorkDir: "piwork" };
    expect(resolveAuditDir(cfg)).toBe("piwork/audit");
  });

  it("undefined auditDir + undefined piWorkDir → default derived", () => {
    expect(resolveAuditDir(baseConfig)).toBe(`${CONFIG_DIR_NAME}/audit`);
  });
});

// ─── resolveDomainSkillCandidates ───────────────────────────────────────────

describe("resolveDomainSkillCandidates", () => {
  const baseConfig = {
    stages: {} as PipelineConfig["stages"],
    projectRoot: "/tmp/test",
  } as PipelineConfig;

  it("returns two candidates: project-level then home-level (absolute paths)", () => {
    const result = resolveDomainSkillCandidates(baseConfig, "myDomain");
    expect(result).toEqual([
      path.join("/tmp/test", `${CONFIG_DIR_NAME}/domains`, "myDomain.md"),
      path.join(homedir(), CONFIG_DIR_NAME, "domains", "myDomain.md"),
    ]);
  });

  it("custom domainDir → used for project-level candidate (absolute path)", () => {
    const cfg = { ...baseConfig, domainDir: "custom/domains" };
    const result = resolveDomainSkillCandidates(cfg, "d1");
    expect(result[0]).toBe(path.join("/tmp/test", "custom/domains", "d1.md"));
    expect(result[1]).toBe(path.join(homedir(), CONFIG_DIR_NAME, "domains", "d1.md"));
  });
});

// ─── End-to-end: resolvePipelineConfig with piWorkDir ───────────────────────

describe("resolvePipelineConfig piWorkDir integration", () => {
  let TMP: string;
  let jsonPath: string;

  beforeEach(async () => {
    TMP = path.join(tmpdir(), "pi-pwdir-e2e-" + Date.now());
    await fs.mkdir(TMP, { recursive: true });
    jsonPath = path.join(TMP, "pipeline_loop.json");
  });
  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  async function writeAndResolve(obj: unknown) {
    await fs.writeFile(jsonPath, JSON.stringify(obj), "utf-8");
    return resolvePipelineConfig(loadJsonConfig(jsonPath));
  }

  it("default (no piWorkDir key) → all fields remain on .pi/ (identity)", async () => {
    const cfg = await writeAndResolve({
      stages: { clarify: { agentPath: ".pi/agents/c.md", verify: {} } },
    });
    expect(cfg.piWorkDir).toBe(CONFIG_DIR_NAME);
    expect(cfg.auditDir).toBe(".pi/audit");
    expect(cfg.domainDir).toBe(".pi/domains");
    expect(cfg.stages.clarify.agentPath).toBe(".pi/agents/c.md");
    expect(cfg.stages.clarify.verify?.verifyFile).toBe(".pi/references/clarify_spec/verify.md");
  });

  it("piWorkDir:'piwork' → .pi/-prefixed paths rewritten", async () => {
    const cfg = await writeAndResolve({
      piWorkDir: "piwork",
      stages: { clarify: { agentPath: ".pi/agents/c.md", verify: {} } },
    });
    expect(cfg.piWorkDir).toBe("piwork");
    expect(cfg.auditDir).toBe("piwork/audit");
    expect(cfg.domainDir).toBe("piwork/domains");
    expect(cfg.stages.clarify.agentPath).toBe("piwork/agents/c.md");
    expect(cfg.stages.clarify.verify?.verifyFile).toBe("piwork/references/clarify_spec/verify.md");
  });

  it("explicit .pi/-prefixed auditDir/domainDir → rewritten", async () => {
    const cfg = await writeAndResolve({
      piWorkDir: "custom",
      auditDir: ".pi/my-audit",
      domainDir: ".pi/my-domains",
      stages: { clarify: {} },
    });
    expect(cfg.auditDir).toBe("custom/my-audit");
    expect(cfg.domainDir).toBe("custom/my-domains");
  });

  it("absolute domainDir → NOT rewritten (no .pi/ prefix match)", async () => {
    const cfg = await writeAndResolve({
      piWorkDir: "custom",
      domainDir: "/abs/domains",
      stages: { clarify: {} },
    });
    expect(cfg.domainDir).toBe("/abs/domains");
  });

  it("home-prefixed domainDir (~/.pi/domains) → NOT rewritten", async () => {
    const cfg = await writeAndResolve({
      piWorkDir: "custom",
      domainDir: "~/.pi/domains",
      stages: { clarify: {} },
    });
    expect(cfg.domainDir).toBe("~/.pi/domains");
  });

  it("piWorkDir same as default → no rewriting (identity)", async () => {
    const cfg = await writeAndResolve({
      piWorkDir: ".pi",
      stages: { clarify: { agentPath: ".pi/agents/c.md", verify: {} } },
    });
    expect(cfg.piWorkDir).toBe(".pi");
    expect(cfg.stages.clarify.agentPath).toBe(".pi/agents/c.md");
    expect(cfg.auditDir).toBe(".pi/audit");
  });
});
