/**
 * 192 Phase 5 (K01/K11) + 193 Phase 4 (task 2): template asset consistency.
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
 * - a business-level custom YAML value is what wins (single source);
 * - 193: the shipped SKILL/agent/template/YML assets teach EXACTLY the
 *   confirmed decision semantics (issues precedence, four sections, mode
 *   routing owned by the plugin, report-only write scope) and the shipped
 *   smart YAML key stays in sync with the built-in default.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadVerifyContractAnchors } from "../../utils/contract-loader";
import { renderDesignReviewUpdatePromptText, DESIGN_REVIEW_UPDATE_PROMPT_KEY } from "../../core/design-review/prompt";
import type { DesignReviewUpdatePromptParams } from "../../core/design-review/prompt";
import {
  DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY,
  renderDesignReviewSmartTemplateText,
} from "../../core/design-review/smart-prompt";
import type { DesignReviewSmartPromptParams } from "../../core/design-review/smart-prompt";
import { DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT } from "../../constants";
import { buildDesignReviewAuthorisationPrompt } from "../../core/design-review/authorization";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { makeTestConfig } from "../helpers";
import { computeHash } from "../../core/design-review/state";
import type { ConfirmMode } from "../../types";

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

// ─── 193 Phase 4 (task 2): decision-contract asset consistency ───────────────

/** Extract a YAML block-scalar body by key, auto-dedenting its base indent. */
function extractYamlBlock(yml: string, key: string): string {
  const lines = yml.split("\n");
  const startIdx = lines.findIndex((l) => l === `${key}: |`);
  expect(startIdx).toBeGreaterThan(-1);
  const block: string[] = [];
  let indent = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      block.push("");
      continue;
    }
    const m = /^[ \t]+/.exec(line);
    if (!m) break; // next top-level key ends the block
    if (indent === -1) indent = m[0].length;
    block.push(line.slice(indent));
  }
  return block.join("\n").trimEnd();
}

function smartParams(): DesignReviewSmartPromptParams {
  return {
    pipelineId: "pipe-tpl",
    planDoc: "/abs/docs/193_Feat_plan.md",
    round: 1,
    operationId: "op-tpl-smart",
    inputHash: "f".repeat(64),
    reportDoc: "/abs/docs/review-design-1-193_Feat_plan.md",
  };
}

describe("193 Phase 4: decision-contract asset consistency", () => {
  it("report template: four mandatory sections, five identities, INERT smart example", () => {
    const tpl = readTemplate(path.join("references", "design_review_report_template.md"));
    for (const heading of ["## Summary", "## Recommendations", "## Verdict", "## Issues"]) {
      expect(tpl).toContain(heading);
    }
    // canonical identity labels shipped; legacy aliases documented as accepted
    for (const row of ["**pipeline**", "**plan**", "**round**", "**operation**", "**input hash**"]) {
      expect(tpl).toContain(row);
    }
    expect(tpl).toContain("**operationId**"); // legacy alias guidance present
    expect(tpl).toContain("None"); // empty-issues sentinel
    expect(tpl).toContain("ISSUES TAKE PRECEDENCE");
    // The Plan Revision Decision example EXISTS but only inside HTML
    // comments: a real report body must never start with a canned decision.
    expect(tpl).toContain("## Plan Revision Decision");
    const stripped = tpl.replace(/<!--[\s\S]*?-->/g, "");
    expect(stripped).not.toContain("## Plan Revision Decision");
    expect(stripped).not.toMatch(/^\s*\*\*action\*\*:/m);
    expect(stripped).not.toMatch(/revise-plan|request-human|proceed-develop/i);
  });

  it("SKILL.md and agent md teach issues precedence + report-only writes", () => {
    const skill = readTemplate(path.join("skills", "design-review", "SKILL.md"));
    const agent = readTemplate(path.join("agents", "design-review-agent.md"));
    for (const doc of [skill, agent]) {
      // the forbidden severity-threshold verdict rule is GONE
      expect(doc).not.toContain("No Blocker or High severity");
      expect(doc).toMatch(/ISSUES TAKE PRECEDENCE/i);
      expect(doc).toMatch(/revise-plan/);
      expect(doc).toMatch(/request-human/);
      expect(doc).toContain("Do NOT approve stages");
      for (const heading of ["## Summary", "## Recommendations", "## Verdict", "## Issues"]) {
        expect(doc).toContain(heading);
      }
    }
    // the blanket read-only contradiction is replaced by a report-only scope
    expect(agent).not.toContain("read-only tools only");
    expect(skill).toMatch(/ONLY the current review report/i);
    expect(agent).toMatch(/Writable scope/i);
    // smart mode never self-releases a FAIL
    expect(skill).toMatch(/NEVER releases a FAIL automatically/i);
    expect(skill).toMatch(/does NOT pre-approve any future FAIL/);
  });

  it("YAML ships the strict smart key; renders through the STRICT renderer in sync with the default", () => {
    const yml = readTemplate(path.join("references", "pipeline-stage-prompt.yml"));
    const body = extractYamlBlock(yml, DESIGN_REVIEW_SMART_DECISION_PROMPT_KEY);
    // declared tokens only — the strict renderer accepts it without throwing
    const rendered = renderDesignReviewSmartTemplateText(body, smartParams());
    expect(rendered).toContain("op-tpl-smart");
    expect(rendered).toContain("revise-plan");
    expect(rendered).toContain("request-human");
    expect(rendered).not.toMatch(/\{[a-zA-Z]/); // every token substituted
    // shipped YAML and the built-in default render IDENTICALLY (sync guard)
    const defaultRendered = renderDesignReviewSmartTemplateText(
      DEFAULT_DESIGN_REVIEW_SMART_DECISION_PROMPT,
      smartParams(),
    );
    expect(rendered).toBe(defaultRendered);
  });

  it("YAML design-review executor/deliverables match the plugin-enforced semantics", () => {
    const yml = readTemplate(path.join("references", "pipeline-stage-prompt.yml"));
    const executor = extractYamlBlock(yml, "stage_executor_design-review");
    expect(executor).toContain("never routes its own verdict");
    expect(executor).not.toContain("main thread calls stage_advance");
    expect(executor).not.toContain("On FAIL, advance to plan for revision");
    expect(executor).toContain("NEVER releases a FAIL automatically");
    const deliverable = extractYamlBlock(yml, "stage_deliverable_design-review");
    for (const heading of ["## Summary", "## Recommendations", "## Verdict", "## Issues"]) {
      expect(deliverable).toContain(heading);
    }
    expect(deliverable).toContain("`None`");
    expect(deliverable).toMatch(/issues take precedence/i);
    expect(deliverable).toContain("request-human");
    // the placeholder inventory comment counts the two design-review keys
    expect(yml).toContain("Available placeholders (13 total)");
    expect(yml).toContain("{{design_review_smart_guidance}}");
  });

  it("shipped pipeline_loop.json pins the design-review example to auto confirm", () => {
    const cfg = JSON.parse(readTemplate("pipeline_loop.json")) as {
      stages: Record<string, { confirm?: { mode?: string }; nextStage?: string }>;
    };
    expect(cfg.stages["design-review"].confirm?.mode).toBe("auto");
    expect(cfg.stages["design-review"].nextStage).toBe("develop");
  });

  it("authorisation prompt is mode-aware and never pre-approves a FAIL", () => {
    const modes: ConfirmMode[] = ["auto", "manual", "smart"];
    const byMode = new Map(modes.map((m) => [m, buildDesignReviewAuthorisationPrompt(m)]));
    for (const text of byMode.values()) {
      // PASS → develop in EVERY mode
      expect(text).toContain("automatically proceed to develop");
      expect(text).toContain("does NOT pre-approve any future FAIL");
    }
    expect(byMode.get("auto")).toContain("authorized automatic update");
    expect(byMode.get("auto")).not.toContain("Proceed to Develop"); // menu is manual-only
    expect(byMode.get("manual")).toContain("Revise Plan / Proceed to Develop / Cancel");
    expect(byMode.get("smart")).toContain("revise-plan");
    expect(byMode.get("smart")).toContain("request-human");
    expect(byMode.get("smart")).toContain("NEVER releases a FAIL automatically");
  });

  it("verify.md declares the same four contract sections as the template", () => {
    const verifyText = readTemplate(path.join("references", "design-review_spec", "verify.md"));
    for (const label of ["Summary", "Recommendations", "Verdict", "Issues"]) {
      expect(verifyText).toContain(label);
    }
  });
});
