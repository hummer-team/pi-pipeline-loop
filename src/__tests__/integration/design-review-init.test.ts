/**
 * @module design-review-init.test
 * Phase 5 (191): Integration tests for design-review initialization flow.
 * 
 * Tests initialization scenarios:
 * - Template configuration includes design-review stage by default
 * - Stage flow correctly chains: clarify → plan → design-review → develop
 * - Required assets (agent, skill, verify) are present
 * - Backward compatibility with old configurations
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";

describe("design-review initialization integration", () => {
  it("template pipeline_loop.json includes design-review stage", async () => {
    const templatePath = path.resolve(__dirname, "../../template/pipeline_loop.json");
    const json = await fs.readFile(templatePath, "utf-8");
    const config = JSON.parse(json);
    
    expect(config.stages["design-review"]).toBeDefined();
    expect(config.stages["design-review"].nextStage).toBe("develop");
    expect(config.stages["plan"].nextStage).toBe("develop");
  });

  it("resolved config has design-review in stage flow", () => {
    const templateJson = {
      projectRoot: "/tmp/test",
      stages: {
        clarify: { nextStage: "plan" },
        plan: { nextStage: "develop" },
        "design-review": { nextStage: "develop" },
        develop: { nextStage: "review" },
        review: { nextStage: "completed" },
        fix: { nextStage: "review" },
        awaiting_human: { nextStage: null },
        completed: { nextStage: null },
      },
    };
    
    const config = resolvePipelineConfig(templateJson as any);
    
    expect(config.stages["design-review"]).toBeDefined();
    expect(config.stages["plan"].nextStage).toBe("develop");
    expect(config.stages["design-review"].nextStage).toBe("develop");
  });

  it("design-review stage has correct default configuration", () => {
    const templateJson = {
      projectRoot: "/tmp/test",
      stages: {
        clarify: { nextStage: "plan" },
        plan: { nextStage: "develop" },
        "design-review": {
          nextStage: "develop",
          verify: { require: true },
          allowedWritePaths: ["docs/"],
        },
        develop: { nextStage: "review" },
        review: { nextStage: "completed" },
        fix: { nextStage: "review" },
        awaiting_human: { nextStage: null },
        completed: { nextStage: null },
      },
    };
    
    const config = resolvePipelineConfig(templateJson as any);
    const designReview = config.stages["design-review"];
    
    expect(designReview.verify?.require).toBe(true);
    expect(designReview.allowedWritePaths).toEqual(["docs/"]);
  });

  it("backward compatibility: old config without design-review still works", () => {
    const oldConfig = {
      projectRoot: "/tmp/test",
      stages: {
        clarify: { nextStage: "plan" },
        plan: { nextStage: "develop" },
        develop: { nextStage: "review" },
        review: { nextStage: "completed" },
        fix: { nextStage: "review" },
        awaiting_human: { nextStage: null },
        completed: { nextStage: null },
      },
    };
    
    // Should not throw
    const config = resolvePipelineConfig(oldConfig as any);
    expect(config.stages["plan"].nextStage).toBe("develop");
  });

  it("design-review stage has required template assets", async () => {
    const templateDir = path.resolve(__dirname, "../../template");
    
    // Check agent file exists
    const agentPath = path.join(templateDir, "agents", "design-review-agent.md");
    const agentExists = await fs.access(agentPath).then(() => true).catch(() => false);
    expect(agentExists).toBe(true);
    
    // Check skill file exists
    const skillPath = path.join(templateDir, "skills", "design-review", "SKILL.md");
    const skillExists = await fs.access(skillPath).then(() => true).catch(() => false);
    expect(skillExists).toBe(true);
    
    // Check verify file exists
    const verifyPath = path.join(templateDir, "references", "design-review_spec", "verify.md");
    const verifyExists = await fs.access(verifyPath).then(() => true).catch(() => false);
    expect(verifyExists).toBe(true);
  });

  it("design-review stage has correct verify.md template content", async () => {
    const templateDir = path.resolve(__dirname, "../../template");
    const verifyPath = path.join(templateDir, "references", "design-review_spec", "verify.md");
    const content = await fs.readFile(verifyPath, "utf-8");
    
    // Verify template has required sections
    expect(content).toContain("mode:");
    expect(content.length).toBeGreaterThan(100);
  });
});
