/**
 * 207 Phase 0: tests for the optional `archive.namesuffix` config field.
 *
 * Coverage per plan:
 * - Valid namesuffix → parsed onto `json.archive.namesuffix` and resolved onto
 *   `resolved.archiveNameSuffix`.
 * - ONLY namesuffix configured (no dirs/dest) → suffix resolves; archiveDirs
 *   keeps the existing fallback chain; archiveDest takes the default.
 * - Surrounding whitespace → trimmed at parse time.
 * - Empty / whitespace-only / number / array / object values → warn + ignored.
 * - namesuffix combined with dirs/dest → all three preserved.
 * - Unconfigured template → resolved.archiveNameSuffix stays undefined.
 * - Regression: existing docs/archive 206 cases remain unaffected (shape).
 *
 * Uses an isolated temp directory + pipeline_loop.json (same pattern as
 * json-config.test.ts, which is intentionally not extended — file over 1000 lines).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import type { PipelineJsonConfig } from "../../types";

let TMP: string;
let jsonPath: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-archive-suffix-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
  jsonPath = path.join(TMP, "pipeline_loop.json");
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

async function writeJson(obj: unknown) {
  await fs.writeFile(jsonPath, JSON.stringify(obj, null, 2), "utf-8");
}

describe("207 Phase 0: archive.namesuffix config", () => {
  it("valid namesuffix is parsed and resolved", async () => {
    await writeJson({ stages: { clarify: {} }, archive: { namesuffix: "pi-pipeline-loop" } });
    const json = loadJsonConfig(jsonPath);
    expect(json.archive?.namesuffix).toBe("pi-pipeline-loop");
    const resolved = resolvePipelineConfig(json);
    expect(resolved.archiveNameSuffix).toBe("pi-pipeline-loop");
  });

  it("namesuffix-only config resolves suffix with existing dirs/dest fallback chain", async () => {
    await writeJson({ stages: { clarify: {} }, archive: { namesuffix: "my-project" } });
    const json = loadJsonConfig(jsonPath);
    const resolved = resolvePipelineConfig(json);
    expect(resolved.archiveNameSuffix).toBe("my-project");
    // dirs falls back to the 206 chain (no docs.stageDirs → ["docs"])
    expect(resolved.archiveDirs).toEqual(["docs"]);
    // dest takes the default
    expect(resolved.archiveDest).toBe("pi-pipeline-archive");
  });

  it("surrounding whitespace is trimmed at parse time", async () => {
    await writeJson({ stages: { clarify: {} }, archive: { namesuffix: "  my-project  " } });
    const json = loadJsonConfig(jsonPath);
    expect(json.archive?.namesuffix).toBe("my-project");
    const resolved = resolvePipelineConfig(json);
    expect(resolved.archiveNameSuffix).toBe("my-project");
  });

  it("empty / whitespace-only / non-string values warn and are ignored", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    // Empty string
    await writeJson({ stages: { clarify: {} }, archive: { namesuffix: "" } });
    let json = loadJsonConfig(jsonPath);
    expect(json.archive).toBeUndefined();
    expect(resolvePipelineConfig(json).archiveNameSuffix).toBeUndefined();

    // Whitespace only
    await writeJson({ stages: { clarify: {} }, archive: { namesuffix: "   " } });
    json = loadJsonConfig(jsonPath);
    expect(json.archive).toBeUndefined();

    // Number / array / object
    for (const bad of [42, ["x"], { name: "x" }]) {
      await writeJson({ stages: { clarify: {} }, archive: { namesuffix: bad } });
      json = loadJsonConfig(jsonPath);
      expect(json.archive).toBeUndefined();
      expect(resolvePipelineConfig(json).archiveNameSuffix).toBeUndefined();
    }

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("namesuffix coexists with dirs and dest (all three preserved)", async () => {
    await writeJson({
      stages: { clarify: {} },
      archive: { namesuffix: "my-project", dirs: ["docs/design"], dest: "deep-archive" },
    });
    const json = loadJsonConfig(jsonPath);
    expect(json.archive?.namesuffix).toBe("my-project");
    expect(json.archive?.dirs).toEqual(["docs/design"]);
    expect(json.archive?.dest).toBe("deep-archive");
    const resolved = resolvePipelineConfig(json);
    expect(resolved.archiveNameSuffix).toBe("my-project");
    expect(resolved.archiveDirs).toEqual(["docs/design"]);
    expect(resolved.archiveDest).toBe("deep-archive");
  });

  it("template-like config without namesuffix leaves archiveNameSuffix undefined", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} }, archive: { dirs: ["docs"], dest: "pi-pipeline-archive" } };
    const resolved = resolvePipelineConfig(json);
    expect(resolved.archiveNameSuffix).toBeUndefined();
    // Shape must not gain a new undefined key
    expect(Object.keys(resolved).includes("archiveNameSuffix")).toBe(false);
  });

  it("regression: docs-only config keeps 206 shape (no archiveNameSuffix)", async () => {
    await writeJson({ stages: { clarify: {} }, docs: { stageDirs: { plan: "docs/design" } } });
    const json = loadJsonConfig(jsonPath);
    expect(json.archive).toBeUndefined();
    const resolved = resolvePipelineConfig(json);
    expect(resolved.archiveDirs).toEqual(["docs/design"]);
    expect(resolved.archiveNameSuffix).toBeUndefined();
    expect(Object.keys(resolved).includes("archiveNameSuffix")).toBe(false);
  });
});
