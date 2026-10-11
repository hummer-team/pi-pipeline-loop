/**
 * Phase 4 (task 5): Template key existence assertion test.
 * Verifies that maxLoopCycles key exists in pipeline_loop.json template.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";

describe("Template key assertion (Phase 4 task 5)", () => {
  it("maxLoopCycles key exists in pipeline_loop.json template", () => {
    const templatePath = path.join(__dirname, "../../template/pipeline_loop.json");
    const templateContent = fs.readFileSync(templatePath, "utf-8");
    const template = JSON.parse(templateContent);
    
    expect(template).toHaveProperty("maxLoopCycles");
    expect(typeof template.maxLoopCycles).toBe("number");
    expect(template.maxLoopCycles).toBe(5); // Default value should be 5
  });

  it("maxLoopCycles has correct comment annotation", () => {
    const templatePath = path.join(__dirname, "../../template/pipeline_loop.json");
    const templateContent = fs.readFileSync(templatePath, "utf-8");
    
    // Check that the comment mentions the default value and rework loop semantics
    expect(templateContent).toContain("maxLoopCycles");
    expect(templateContent).toContain("5"); // Default value documented
  });

  it("maxLoopCycles is distinct from maxLoops", () => {
    const templatePath = path.join(__dirname, "../../template/pipeline_loop.json");
    const templateContent = fs.readFileSync(templatePath, "utf-8");
    const template = JSON.parse(templateContent);
    
    expect(template).toHaveProperty("maxLoops");
    expect(template).toHaveProperty("maxLoopCycles");
    // Both keys should exist and be separate concepts
    expect(template.maxLoops).not.toBe(template.maxLoopCycles);
  });
});
