/**
 * 206 Phase 5: template sync assertions for the `docs` / `archive` top-level
 * config blocks introduced in Phase 0.
 *
 * 222 Phase 0 changed the contract: the template no longer pins any value that
 * equals a built-in default (`docs.stageDirs`, `archive.dirs`,
 * `stages.*.allowedWritePaths` / `allowedReadOnlyPaths`), because such a static
 * value would silently swallow the new `docs.<x>Dir` keys. The tests below
 * assert BOTH sides: the keys are gone from the template AND the production
 * loader still resolves the legacy behaviour from its own defaults.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";

const TEMPLATE_PATH = path.join(__dirname, "../../template/pipeline_loop.json");

describe("Template docs/archive key assertion (206 Phase 5 / 222 Phase 0)", () => {
  it("template declares no value that pins a derived default", () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));

    // 222 Phase 0: the four static values that used to equal the built-in
    // defaults are removed so the new docs.*Dir keys can take effect.
    expect(template.docs).not.toHaveProperty("stageDirs");
    expect(template.archive).not.toHaveProperty("dirs");
    expect(template.stages["design-review"]).not.toHaveProperty("allowedWritePaths");
    expect(template.stages.develop).not.toHaveProperty("allowedReadOnlyPaths");
    expect(template.stages.fix).not.toHaveProperty("allowedReadOnlyPaths");

    // archive keeps its non-derived key only.
    expect(template.archive.dest).toBe("pi-pipeline-archive");
    expect(Object.keys(template.archive).sort()).toEqual(["dest"]);
  });

  it("comment annotation keys exist for discoverability", () => {
    // `_comment_*` keys are annotations consumed (stripped) by the loader, so
    // they are asserted on the raw file text.
    const templateContent = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(templateContent).toContain("\"_comment_docs\"");
    expect(templateContent).toContain("do NOT interact with protect");
    expect(templateContent).toContain("\"_comment_archive\"");
    // 207: millisecond naming format + namesuffix discoverability
    expect(templateContent).toContain("yyyy_MM_dd_HHmmssSSS_pipeline");
    expect(templateContent).toContain("namesuffix");
    // 222 Phase 0: the three directory keys and their re-init requirement.
    expect(templateContent).toContain("designDir");
    expect(templateContent).toContain("reviewDir");
    expect(templateContent).toContain("jobsDir");
    expect(templateContent).toContain("/pipeline-init");
  });

  it("guide key wording is kept in sync between src/template and .pi overlays", () => {
    const srcGuide = fs.readFileSync(path.join(__dirname, "../../template/guide.md"), "utf-8");
    // Format string, fail-closed wording and the optional key must match.
    const markers = [
      "yyyy_MM_dd_HHmmssSSS_pipeline[_namesuffix].zip",
      "namesuffix",
      "fail-closed",
      "不 zip、不删除源文件",
    ];
    for (const marker of markers) {
      expect(srcGuide).toContain(marker);
    }

    // `.pi/` is git-ignored and only exists after `/pipeline-init` has deployed
    // the template. Treat the overlay as an optional deployment artifact so the
    // test stays hermetic in a clean checkout (no ENOENT regression).
    const piGuidePath = path.join(__dirname, "../../../.pi/guide.md");
    if (!fs.existsSync(piGuidePath)) return;
    const piGuide = fs.readFileSync(piGuidePath, "utf-8");
    for (const marker of markers) {
      expect(piGuide).toContain(marker);
    }
  });

  it("template parses through the production loadJsonConfig loader", () => {
    // This mirrors the /pipeline-init copy path: the file lands on disk as-is
    // and must be loadable by the real config parser without errors.
    const json = loadJsonConfig(TEMPLATE_PATH);
    expect(json.docs).toBeUndefined();
    expect(json.archive).toEqual({ dest: "pi-pipeline-archive" });

    // 222 Phase 0: a fresh install resolves the SAME directories from defaults.
    const config = resolvePipelineConfig(json);
    expect(config.docsStageDirs).toBeUndefined();
    expect(config.docsDirs).toBeUndefined(); // no explicit docs.<x>Dir key
    expect(config.archiveDirs).toEqual(["docs"]);
    expect(config.archiveDest).toBe("pi-pipeline-archive");

    // R3Q9-A is an INTENTIONAL widening of the design-review write whitelist
    // (1 → 5 entries). Frozen here so it is an accepted change, not a silent one.
    expect(config.stages["design-review"].allowedWritePaths).toEqual([
      "docs/",
      "doc/",
      "documentation/",
      "docs/design/",
      "docs/review/",
    ]);
    expect(config.stages.develop.allowedReadOnlyPaths).toEqual(["docs/design/*_Plan.md"]);
    expect(config.stages.fix.allowedReadOnlyPaths).toEqual(["docs/design/*_Plan.md"]);
  });
});