/**
 * 230 Phase 5: template-internal review-loop contract consistency.
 *
 * The shipped template must teach ONE set of review-loop criteria across its
 * skills, references, agents and stage prompts. This suite anchors the
 * semantics that drift most easily:
 *   - the deprecated Chinese SOP is gone (B9) and never resurrects;
 *   - the contract file exists, keeps its nine sections and carries no
 *     unresolvable placeholder tokens;
 *   - all six template skills reference that contract instead of restating it;
 *   - the design-review / review / fix criteria appear in every artifact that
 *     the plugin or the model reads (skill, agent, report template, stage
 *     prompt);
 *   - the SOP keeps the two orchestration sections while `sop.md`'s
 *     PIPELINE AUTOMATION RULES assertions stay in template-defaults.test.ts.
 *
 * Scope: structure and semantic markers only — prose wording stays free so the
 * assets can be re-written without breaking this suite. Pure `fs` + `yaml`,
 * no runtime imports.
 */

import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse } from "yaml";

const TEMPLATE_DIR = path.resolve(__dirname, "../../template");
const REFERENCES_DIR = path.join(TEMPLATE_DIR, "references");
const SKILLS_DIR = path.join(TEMPLATE_DIR, "skills");

const CONTRACT_FILE = "review-loop-contract.md";
const SKILL_NAMES = ["design", "plan", "design-review", "develop", "review", "fix"] as const;
const FORBIDDEN_CONTRACT_TOKENS = ["{designDir}", "{reviewDir}", "{jobsDir}", "Template-TODO"] as const;

/** Reads a file relative to the template root (UTF-8). */
function readTemplate(relativePath: string): string {
  return fs.readFileSync(path.join(TEMPLATE_DIR, relativePath), "utf-8");
}

/** Reads a skill document by its directory name. */
function readSkill(name: string): string {
  return fs.readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf-8");
}

/** Returns the value of a top-level `key: |` YAML block from the stage prompt file. */
function readYamlBlock(yml: string, key: string): string {
  const parsed = yamlParse(yml) as Record<string, unknown>;
  const value = parsed[key];
  if (typeof value !== "string") {
    throw new Error(`Missing YAML block: ${key}`);
  }
  return value;
}

describe("230 Phase 5: review-loop contract consistency (template)", () => {
  it("does not ship the deprecated Chinese SOP", () => {
    expect(fs.existsSync(path.join(REFERENCES_DIR, "sop_CN.md"))).toBe(false);
  });

  it("ships the shared contract with its nine sections and no unresolved tokens", () => {
    const contract = fs.readFileSync(path.join(REFERENCES_DIR, CONTRACT_FILE), "utf-8");
    expect(contract.match(/^## /gm)?.length ?? 0).toBe(9);
    for (const token of FORBIDDEN_CONTRACT_TOKENS) {
      expect(contract).not.toContain(token);
    }
    // host-neutral: the contract must not name either development host
    expect(contract).not.toContain(".opencode");
    expect(contract).not.toContain(".pi/");
  });

  it("has every template skill reference the shared contract", () => {
    for (const name of SKILL_NAMES) {
      expect(readSkill(name)).toContain(CONTRACT_FILE);
    }
  });

  it("teaches the blocking set and the ledger in every design-review artifact", () => {
    const artifacts = [
      readSkill("design-review"),
      readTemplate(path.join("agents", "design-review-agent.md")),
      readTemplate(path.join("references", "design_review_report_template.md")),
      readYamlBlock(readTemplate(path.join("references", "pipeline-stage-prompt.yml")), "stage_deliverable_design-review"),
    ];
    for (const artifact of artifacts) {
      expect(artifact).toContain("BLOCKING");
      expect(artifact).toContain("Issue Ledger");
    }
  });

  it("gives code review stable CR ids and a ledger", () => {
    const reviewSkill = readSkill("review");
    const reportTemplate = readTemplate(path.join("references", "review_report_template.md"));
    for (const artifact of [reviewSkill, reportTemplate]) {
      expect(artifact).toContain("CR-<round>-");
      expect(artifact).toContain("Issue Ledger");
    }
  });

  it("records the three-value fix disposition and the write protection", () => {
    const fixSkill = readSkill("fix");
    expect(fixSkill).toContain("Accepted risk");
    expect(fixSkill).toContain("write-protected");
  });

  it("parses the stage prompt YAML and keeps the DR id/ledger contract in the design-review deliverable", () => {
    const yml = readTemplate(path.join("references", "pipeline-stage-prompt.yml"));
    const deliverable = readYamlBlock(yml, "stage_deliverable_design-review");
    expect(deliverable).toContain("DR-<round>-n");
    expect(deliverable).toContain("## Issue Ledger");
    // stage_deliverable_review teaches the CR ids of the code-review loop
    expect(readYamlBlock(yml, "stage_deliverable_review")).toContain("CR-<round>-n");
  });

  it("keeps both orchestration sections in the SOP", () => {
    const sop = readTemplate(path.join("references", "sop.md"));
    expect(sop).toContain("## Review Loop Contract");
    expect(sop).toContain("## Master Agent Orchestration Contract");
    // the chain must list design-review between plan and develop
    expect(sop).toMatch(/design-plan\s*→\s*design-review\s*→\s*develop/);
  });
});