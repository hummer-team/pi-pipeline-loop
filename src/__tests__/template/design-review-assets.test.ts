/**
 * 192 Phase 5 (K01/K11): template asset consistency.
 *
 * The SHIPPED assets must satisfy the runtime contracts they will face:
 * - pipeline-stage-prompt.yml `design_review_update_prompt` renders cleanly
 *   through the strict renderer (only declared tokens, exact association
 *   fields, non-brace example fields);
 * - design-review verify.md anchors load and expose verdict + issueHeading
 *   runtime patterns;
 * - the report template carries ALL identity header rows the verifier
 *   enforces;
 * - the update Markdown is NO LONGER part of the runtime selection: deleting
 *   it cannot change what gets dispatched;
 * - a business-level custom YAML value is what wins (single source).
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadVerifyContractAnchors } from "../../utils/contract-loader";
import { renderDesignReviewUpdatePromptText, DESIGN_REVIEW_UPDATE_PROMPT_KEY } from "../../core/design-review/prompt";
import type { DesignReviewUpdatePromptParams } from "../../core/design-review/prompt";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { makeTestConfig } from "../helpers";
import { computeHash } from "../../core/design-review/state";

const TEMPLATE_ROOT = path.join(__dirname, "..", "..", "template");

function readTemplate(rel: string): string {
  return fs.readFileSync(path.join(TEMPLATE_ROOT, rel), "utf-8");
}

function params(): DesignReviewUpdatePromptParams {
  return {
    pipelineId: "pipe-tpl",
    planDoc: "/abs/docs/X_plan.md",
    reviewDoc: "/abs/docs/review-design-1-X_plan.md",
    round: 1,
    operationId: "op-tpl-update",
    baselinePlanHash: "a".repeat(64),
    issues: ["issue one"],
  };
}

describe("192 Phase 5: shipped design-review assets", () => {
  it("report template carries every identity header row the verifier enforces", () => {
    const tpl = readTemplate(path.join("references", "design_review_report_template.md"));
    for (const row of ["**pipeline**", "**plan**", "**round**", "**operationId**", "**baselinePlanHash**"]) {
      expect(tpl).toContain(row);
    }
    // issues sentinel guidance
    expect(tpl.toLowerCase()).toContain("none");
  });

  it("update prompt YAML key renders through the STRICT renderer (no unknown/brace-example tokens)", () => {
    const yml = readTemplate(path.join("references", "pipeline-stage-prompt.yml"));
    const lines = yml.split("\n");
    const startIdx = lines.findIndex((l) => l === `${DESIGN_REVIEW_UPDATE_PROMPT_KEY}: |`);
    expect(startIdx).toBeGreaterThan(-1);
    const block: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() !== "" && !/^[ \t]/.test(line)) break;
      block.push(line);
    }
    const body = block.map((l) => (l.startsWith("   ") ? l.slice(3) : l)).join("\n").trimEnd();
    const rendered = renderDesignReviewUpdatePromptText(body, params());
    expect(rendered).toContain("**Round**: 1");
    expect(rendered).toContain("op-tpl-update");
    expect(rendered).toContain("/abs/docs/review-design-1-X_plan.md");
    // no leftover runtime braces
    expect(rendered).not.toMatch(/\{\{?\s*(operationId|round|reviewDoc|planDoc|pipelineId|baselinePlanHash)\s*\}?\}/);
  });

  it("verify.md anchors load with verdict + issueHeading pattern sets", async () => {
    // Point the contract loader at the shipped template dir
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dr-assets-"));
    try {
      const dest = path.join(projectRoot, ".pi", "references", "design-review_spec");
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(
        path.join(TEMPLATE_ROOT, "references", "design-review_spec", "verify.md"),
        path.join(dest, "verify.md"),
      );
      const config = makeTestConfig({ projectRoot });
      const { anchors, issues } = await loadVerifyContractAnchors(config, "design-review");
      expect(issues).toEqual([]);
      expect(anchors.verdict?.patterns.length).toBeGreaterThan(0);
      // every verdict pattern exposes capture group 1
      for (const p of anchors.verdict!.patterns) {
        const re = new RegExp(`${p}|`);
        expect(re.exec("")!.length - 1).toBeGreaterThanOrEqual(1);
      }
      expect(anchors.issueHeading?.patterns[0]).toContain("Issues");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("the historical update Markdown is not part of the runtime selection", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dr-assets-md-"));
    try {
      // .pi exists but NO YAML file → selection falls to constants default;
      // presence/absence of the Markdown must not change the content hash.
      fs.mkdirSync(path.join(projectRoot, ".pi", "references"), { recursive: true });
      const config = makeTestConfig({ projectRoot });
      const { selectDesignReviewUpdateTemplate } = await import("../../core/design-review/prompt");
      resetPromptConfigCache();
      const sel1 = await selectDesignReviewUpdateTemplate(config);
      fs.writeFileSync(
        path.join(projectRoot, ".pi", "references", "design-review-update-prompt.md"),
        "LEGACY MARKDOWN MUST NOT BE READ",
        "utf-8",
      );
      resetPromptConfigCache();
      const sel2 = await selectDesignReviewUpdateTemplate(config);
      expect(sel2.source).toBe("default");
      expect(sel2.contentHash).toBe(sel1.contentHash);
      expect(computeHash("LEGACY MARKDOWN MUST NOT BE READ")).not.toBe(sel2.contentHash);
    } finally {
      resetPromptConfigCache();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("business-custom YAML value beats the default (single custom source, K04)", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dr-assets-yml-"));
    try {
      const dir = path.join(projectRoot, ".pi", "references");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "pipeline-stage-prompt.yml"),
        `${DESIGN_REVIEW_UPDATE_PROMPT_KEY}: |\n   CUSTOM BUSINESS TEXT {operationId}\n`,
        "utf-8",
      );
      const config = makeTestConfig({ projectRoot });
      const { selectDesignReviewUpdateTemplate } = await import("../../core/design-review/prompt");
      resetPromptConfigCache();
      const sel = await selectDesignReviewUpdateTemplate(config);
      expect(sel.source).toBe("yaml");
      expect(sel.templateText).toContain("CUSTOM BUSINESS TEXT");
    } finally {
      resetPromptConfigCache();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
