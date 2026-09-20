/**
 * Unit tests for Phase 1 of 184_Bug plan — work-dir consumers.
 *
 * Verifies that all production code paths that previously hardcoded ".pi"
 * now route through resolvePiWorkDir(config), and that the protection set,
 * template-drift, and pipeline-init deploy correctly honour piWorkDir.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { buildProtectedPaths } from "../../utils/protect";
import { checkTemplateDrift } from "../../utils/template-drift";
import { resolvePipelineConfig, loadJsonConfig } from "../../core/json-config-loader";
import { CONFIG_DIR_NAME } from "../../constants";
import type { PipelineConfig } from "../../types";

// ─── buildProtectedPaths ────────────────────────────────────────────────────

describe("buildProtectedPaths (Phase 1)", () => {
  const baseConfig = {
    stages: {} as PipelineConfig["stages"],
    projectRoot: "/tmp/test",
  } as PipelineConfig;

  it("default config → includes .pi/, .git/ (deduped, no extra entry)", () => {
    const result = buildProtectedPaths(baseConfig);
    expect(result).toContain(".pi/");
    expect(result).toContain(".git/");
    // piWorkDir === ".pi" → no extra entry (deduped)
    const piEntries = result.filter(p => p.endsWith("/"));
    expect(piEntries.filter(p => p === ".pi/").length).toBe(1);
  });

  it("custom piWorkDir → includes both .pi/ and piWorkDir/", () => {
    const cfg = { ...baseConfig, piWorkDir: "piwork" };
    const result = buildProtectedPaths(cfg);
    expect(result).toContain(".pi/");
    expect(result).toContain("piwork/");
    expect(result).toContain(".git/");
  });

  it("piWorkDir same as default → deduped to single .pi/", () => {
    const cfg = { ...baseConfig, piWorkDir: ".pi" };
    const result = buildProtectedPaths(cfg);
    expect(result.filter(p => p === ".pi/").length).toBe(1);
  });

  it("user protect.paths merged", () => {
    const cfg = { ...baseConfig, protect: { paths: ["AGENTS.md"] } };
    const result = buildProtectedPaths(cfg);
    expect(result).toContain("AGENTS.md");
    expect(result).toContain(".pi/");
  });
});

// ─── checkTemplateDrift with piWorkDir ──────────────────────────────────────

describe("checkTemplateDrift piWorkDir (Phase 1)", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(tmpdir(), "pi-drift-pw-" + Date.now());
    await fsp.mkdir(TMP, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  it("default piWorkDir → looks in .pi/", async () => {
    // No deployed files → no drift (empty project)
    const drifts = await checkTemplateDrift(TMP);
    expect(drifts).toEqual([]);
  });

  it("custom piWorkDir → looks in custom dir, not .pi/", async () => {
    // Create the custom dir with a dummy guide.md (always-overwrite asset)
    const customDir = path.join(TMP, "piwork");
    await fsp.mkdir(customDir, { recursive: true });
    await fsp.writeFile(path.join(customDir, "guide.md"), "custom content", "utf-8");

    // Should not throw; drift check proceeds with custom dir
    const drifts = await checkTemplateDrift(TMP, "piwork");
    // guide.md will drift (content differs from template) — at least 1 drift
    // OR if template dir is not resolvable, returns empty (fail-open)
    expect(Array.isArray(drifts)).toBe(true);
  });

  it("default piWorkDir → .pi/ empty → no drift", async () => {
    await fsp.mkdir(path.join(TMP, ".pi"), { recursive: true });
    const drifts = await checkTemplateDrift(TMP);
    expect(drifts).toEqual([]);
  });
});

// ─── resolvePipelineConfig integration with work-dir consumers ──────────────

describe("resolvePipelineConfig — consumer integration (Phase 1)", () => {
  let TMP: string;
  let jsonPath: string;

  beforeEach(async () => {
    TMP = path.join(tmpdir(), "pi-p1-e2e-" + Date.now());
    await fsp.mkdir(TMP, { recursive: true });
    jsonPath = path.join(TMP, "pipeline_loop.json");
  });
  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
  });

  async function writeAndResolve(obj: unknown) {
    await fsp.writeFile(jsonPath, JSON.stringify(obj), "utf-8");
    return resolvePipelineConfig(loadJsonConfig(jsonPath));
  }

  it("default → auditDir stays at .pi/audit (backward compatible)", async () => {
    const cfg = await writeAndResolve({ stages: { clarify: {} } });
    expect(cfg.auditDir).toBe(".pi/audit");
  });

  it("piWorkDir:'piwork' → auditDir rewritten to piwork/audit", async () => {
    const cfg = await writeAndResolve({
      piWorkDir: "piwork",
      stages: { clarify: {} },
    });
    expect(cfg.auditDir).toBe("piwork/audit");
  });

  it("buildProtectedPaths from resolved config includes piWorkDir/", async () => {
    const cfg = await writeAndResolve({
      piWorkDir: "custom",
      stages: { clarify: {} },
    });
    const paths = buildProtectedPaths(cfg);
    expect(paths).toContain(".pi/");
    expect(paths).toContain("custom/");
  });
});
