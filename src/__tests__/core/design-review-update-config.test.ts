/**
 * 192 Phase 2 (F06/K04/K05): YAML update-prompt configuration tests against
 * the REAL strict loader and constants default.
 *
 * Covers:
 * - YAML content changes observably change the rendered dispatch text
 * - missing file / missing key → constants default (auditable source)
 * - explicit empty / non-string / broken YAML / unreadable → BLOCK (spawn=0
 *   semantics tested here at the render layer; dispatch blocking in cycle)
 * - both `{field}` and `{{field}}` render the same value; double-brace first
 * - paths with spaces and `$&`-style literals are never corrupted
 * - required token without provided value blocks; unknown brace token blocks;
 *   JSON/code literals with non-identifier braces are untouched
 * - strict cache is keyed by the ACTUAL file path (no cross-workDir leak)
 * - deleting the independent Markdown file cannot affect selection
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../../types";
import {
  selectDesignReviewUpdateTemplate,
  renderDesignReviewUpdatePromptText,
  buildDesignReviewUpdatePrompt,
  DesignReviewUpdateConfigError,
  DESIGN_REVIEW_UPDATE_PROMPT_KEY,
  type DesignReviewUpdatePromptParams,
} from "../../core/design-review/prompt";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT } from "../../constants";
import { makeTestConfig } from "../helpers";

function baseParams(overrides?: Partial<DesignReviewUpdatePromptParams>): DesignReviewUpdatePromptParams {
  return {
    pipelineId: "pipe-1",
    planDoc: "/tmp/proj/docs/plan.md",
    reviewDoc: "/tmp/proj/docs/review-design-1-plan.md",
    round: 1,
    operationId: "op-update-1",
    baselinePlanHash: "a".repeat(64),
    issues: ["Issue A", "Issue B"],
    ...overrides,
  };
}

describe("192 Phase 2: strict YAML selection", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-update-cfg-"));
    fs.mkdirSync(path.join(projectRoot, ".pi", "references"), { recursive: true });
    resetPromptConfigCache();
  });

  afterEach(() => {
    resetPromptConfigCache();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeYml(text: string, dir = ".pi"): void {
    const refDir = path.join(projectRoot, dir, "references");
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, "pipeline-stage-prompt.yml"), text, "utf-8");
  }

  it("no file at all → constants default, auditable source", async () => {
    const config = makeTestConfig({ projectRoot });
    const sel = await selectDesignReviewUpdateTemplate(config);
    expect(sel.source).toBe("default");
    expect(sel.templateText).toBe(DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT);
    expect(sel.contentHash.length).toBe(64);
    expect(sel.path).toBeUndefined();
  });

  it("file present but key absent → constants default", async () => {
    writeYml("stage_executor_plan: |\n  some text\n");
    const sel = await selectDesignReviewUpdateTemplate(makeTestConfig({ projectRoot }));
    expect(sel.source).toBe("default");
  });

  it("key present → YAML text used; content change observably changes render", async () => {
    writeYml(`${DESIGN_REVIEW_UPDATE_PROMPT_KEY}: |\n  FIRST CUSTOM TEXT {planDoc}\n`);
    const sel1 = await selectDesignReviewUpdateTemplate(makeTestConfig({ projectRoot }));
    expect(sel1.source).toBe("yaml");
    expect(sel1.templateText).toContain("FIRST CUSTOM TEXT");
    const r1 = renderDesignReviewUpdatePromptText(sel1.templateText, baseParams());
    expect(r1).toContain("FIRST CUSTOM TEXT");

    // Simulate a cache-busting fresh read after content change
    resetPromptConfigCache();
    writeYml(`${DESIGN_REVIEW_UPDATE_PROMPT_KEY}: |\n  SECOND CUSTOM TEXT {planDoc}\n`);
    const sel2 = await selectDesignReviewUpdateTemplate(makeTestConfig({ projectRoot }));
    const r2 = renderDesignReviewUpdatePromptText(sel2.templateText, baseParams());
    expect(r2).toContain("SECOND CUSTOM TEXT");
    expect(r2).not.toContain("FIRST CUSTOM TEXT");
  });

  it("explicitly empty value BLOCKS (never silent default)", async () => {
    writeYml(`${DESIGN_REVIEW_UPDATE_PROMPT_KEY}: ""\n`);
    let threw: unknown;
    try {
      await selectDesignReviewUpdateTemplate(makeTestConfig({ projectRoot }));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(DesignReviewUpdateConfigError);
    expect((threw as DesignReviewUpdateConfigError).code).toBe("empty-value");
    expect((threw as Error).message).toContain(DESIGN_REVIEW_UPDATE_PROMPT_KEY);
  });

  it("non-string value BLOCKS", async () => {
    writeYml(`${DESIGN_REVIEW_UPDATE_PROMPT_KEY}: 42\n`);
    await expect(selectDesignReviewUpdateTemplate(makeTestConfig({ projectRoot }))).rejects.toThrow(
      DesignReviewUpdateConfigError,
    );
  });

  it("broken YAML BLOCKS with parse-error code and cause", async () => {
    writeYml(`key: [unclosed\n  bad: {also broken\n`);
    let threw: DesignReviewUpdateConfigError | undefined;
    try {
      await selectDesignReviewUpdateTemplate(makeTestConfig({ projectRoot }));
    } catch (err) {
      threw = err as DesignReviewUpdateConfigError;
    }
    expect(threw).toBeInstanceOf(DesignReviewUpdateConfigError);
    expect(threw!.code).toBe("parse-error");
    expect(threw!.cause).toBeInstanceOf(Error);
  });

  it("unreadable path (base is a plain file) BLOCKS with read-error", async () => {
    fs.rmSync(path.join(projectRoot, ".pi"), { recursive: true, force: true });
    fs.writeFileSync(path.join(projectRoot, ".pi"), "occupied");
    let threw: DesignReviewUpdateConfigError | undefined;
    try {
      await selectDesignReviewUpdateTemplate(makeTestConfig({ projectRoot }));
    } catch (err) {
      threw = err as DesignReviewUpdateConfigError;
    }
    expect(threw).toBeInstanceOf(DesignReviewUpdateConfigError);
    expect(threw!.code).toBe("read-error");
  });

  it("custom piWorkDir is honored; strict cache never reuses across dirs", async () => {
    writeYml(`${DESIGN_REVIEW_UPDATE_PROMPT_KEY}: |\n  WORKDIR-SPECIFIC TEXT\n`, "custom-assets");
    const sel = await selectDesignReviewUpdateTemplate(
      makeTestConfig({ projectRoot, piWorkDir: "custom-assets" }),
    );
    expect(sel.source).toBe("yaml");
    expect(sel.templateText).toContain("WORKDIR-SPECIFIC TEXT");
    expect(sel.path).toBe(path.resolve(projectRoot, "custom-assets", "references", "pipeline-stage-prompt.yml"));

    // The DEFAULT .pi dir has NO file → must NOT pick up the custom-assets
    // cached content (cache key = actual file path)
    const selDefault = await selectDesignReviewUpdateTemplate(makeTestConfig({ projectRoot }));
    expect(selDefault.source).toBe("default");
    expect(selDefault.templateText).not.toContain("WORKDIR-SPECIFIC TEXT");
  });

  it("deleting the independent Markdown file cannot affect selection", async () => {
    const mdPath = path.join(projectRoot, ".pi", "references", "design-review-update-prompt.md");
    fs.writeFileSync(mdPath, "LEGACY MARKDOWN FALLBACK CONTENT", "utf-8");
    const before = await buildDesignReviewUpdatePrompt(makeTestConfig({ projectRoot }), baseParams());
    expect(before.prompt).not.toContain("LEGACY MARKDOWN FALLBACK CONTENT");
    fs.rmSync(mdPath);
    const after = await buildDesignReviewUpdatePrompt(makeTestConfig({ projectRoot }), baseParams());
    expect(after.prompt).toBe(before.prompt);
  });
});

describe("192 Phase 2: strict text rendering", () => {
  it("renders {field} and {{field}} to the SAME value", () => {
    const template = "A={planDoc} B={{planDoc}} R={round} S={{round}}";
    const out = renderDesignReviewUpdatePromptText(template, baseParams({ round: 7 }));
    expect(out).toBe("A=/tmp/proj/docs/plan.md B=/tmp/proj/docs/plan.md R=7 S=7");
  });

  it("path with spaces and $&-style literals survive substitution exactly", () => {
    const template = "plan: {planDoc}\nissues:\n{issues}";
    const out = renderDesignReviewUpdatePromptText(
      template,
      baseParams({
        planDoc: "/tmp/my docs/$&plan [x].md",
        issues: ["costs $&100", "literal $$ not special"],
      }),
    );
    expect(out).toContain("/tmp/my docs/$&plan [x].md");
    expect(out).toContain("1. costs $&100");
    expect(out).toContain("2. literal $$ not special");
  });

  it("substituted values are NOT recursively re-substituted; a brace token inside a value trips the residual gate (fail-closed)", () => {
    const template = "doc={planDoc}";
    // A value carrying "{reviewDoc}" is NOT silently re-replaced with the
    // real reviewDoc (no recursive substitution). The surviving token hits
    // the residual scan → the renderer BLOCKS instead of dispatching an
    // ambiguous prompt (never a partial/mixed template).
    expect(() =>
      renderDesignReviewUpdatePromptText(
        template,
        baseParams({ planDoc: "/x/{reviewDoc}" }),
      ),
    ).toThrow(/unconsumed runtime tokens/);
  });

  it("empty REQUIRED param blocks", () => {
    expect(() =>
      renderDesignReviewUpdatePromptText("x {pipelineId}", baseParams({ pipelineId: "" })),
    ).toThrow(/Missing required parameters/);
  });

  it("template referencing {requirementDoc} without the param blocks", () => {
    expect(() =>
      renderDesignReviewUpdatePromptText("req {requirementDoc}", baseParams()),
    ).toThrow(/without provided values/);
  });

  it("unknown runtime token blocks; JSON/code literal braces are fine", () => {
    expect(() =>
      renderDesignReviewUpdatePromptText("example {mysteryToken} here", baseParams()),
    ).toThrow(/unknown runtime tokens/);

    const jsonTemplate = 'data: {"key": "value", "n": 1} plan={planDoc}';
    const out = renderDesignReviewUpdatePromptText(jsonTemplate, baseParams());
    expect(out).toContain('{"key": "value", "n": 1}');
    expect(out).toContain("/tmp/proj/docs/plan.md");
  });

  it("empty template text blocks", () => {
    expect(() => renderDesignReviewUpdatePromptText("   ", baseParams())).toThrow(/empty/i);
  });

  it("the constants default template itself renders cleanly", () => {
    const out = renderDesignReviewUpdatePromptText(DEFAULT_DESIGN_REVIEW_UPDATE_PROMPT, baseParams());
    expect(out).toContain("Design Review Update");
    expect(out).toContain("/tmp/proj/docs/plan.md");
    expect(out).toContain("op-update-1");
    expect(out).not.toMatch(/\{\{?\s*(pipelineId|planDoc|reviewDoc|round|operationId|baselinePlanHash)\s*\}?\}/);
  });

  it("the shipped YAML template itself renders cleanly (single-brace tokens)", async () => {
    // The plugin's own template asset must satisfy its strict renderer.
    const templateDir = path.join(__dirname, "..", "..", "..", "src", "template", "references");
    const yml = fs.readFileSync(path.join(templateDir, "pipeline-stage-prompt.yml"), "utf-8");
    // Extract the block scalar: from the header line until the next
    // top-level key line (line starting at column 0 without a space).
    const lines = yml.split("\n");
    const startIdx = lines.findIndex((l) => l === "design_review_update_prompt: |");
    expect(startIdx).toBeGreaterThan(-1);
    const block: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() !== "" && !/^[ \t]/.test(line)) break; // next key
      block.push(line);
    }
    // The block is indented by exactly 3 spaces per the template style
    const body = block.map((l) => (l.startsWith("   ") ? l.slice(3) : l)).join("\n").trimEnd();
    const out = renderDesignReviewUpdatePromptText(body, baseParams({ round: 2 }));
    expect(out).toContain("**Round**: 2");
    expect(out).toContain("**Operation**: op-update-1");
    expect(out).not.toContain("{issue_1}");
    expect(out).not.toContain("{justification}");
  });
});
