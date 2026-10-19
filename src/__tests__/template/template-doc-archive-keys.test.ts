/**
 * 206 Phase 5: template sync assertions for the new `docs` / `archive`
 * top-level config blocks introduced in Phase 0.
 *
 * Plan boundary: the template JSON must be syntactically valid AND parseable
 * by the production loader (`loadJsonConfig`), so the keys survive the
 * `/pipeline-init` template copy onto a real project disk unchanged.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { loadJsonConfig } from "../../core/json-config-loader";

const TEMPLATE_PATH = path.join(__dirname, "../../template/pipeline_loop.json");

describe("Template docs/archive key assertion (206 Phase 5)", () => {
  it("docs and archive blocks exist with correct shapes", () => {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));

    // docs.stageDirs: stage → project-relative directory
    expect(template).toHaveProperty("docs.stageDirs");
    expect(template.docs.stageDirs).toEqual({
      clarify: "docs/design",
      plan: "docs/design",
      "design-review": "docs/design",
      develop: "docs/design",
      review: "docs/design",
      fix: "docs/review",
    });

    // archive.dirs / archive.dest (207: the template has NO default namesuffix
    // — legacy `{timestamp}_pipeline.zip` naming stays the default behavior)
    expect(template).toHaveProperty("archive.dirs");
    expect(template.archive.dirs).toEqual(["docs/design", "docs/review"]);
    expect(template.archive.dest).toBe("pi-pipeline-archive");
    expect(Object.keys(template.archive).sort()).toEqual(["dest", "dirs"]);
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
    expect(json.docs?.stageDirs).toEqual({
      clarify: "docs/design",
      plan: "docs/design",
      "design-review": "docs/design",
      develop: "docs/design",
      review: "docs/design",
      fix: "docs/review",
    });
    expect(json.archive).toEqual({ dirs: ["docs/design", "docs/review"], dest: "pi-pipeline-archive" });
  });
});
