import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/**
 * Template contract tests for Phase 2 (169).
 *
 * These tests ensure that the template agent files and pipeline_loop.json
 * maintain the expected structure after the skills: field removal from
 * feat-design-plan-agent.md.
 *
 * Drift in any of these assertions indicates an unintended template change
 * that would break the on-demand skill injection mechanism.
 */

const TEMPLATE_DIR = path.resolve(__dirname, "../../template");
const AGENTS_DIR = path.join(TEMPLATE_DIR, "agents");

/**
 * Extracts YAML frontmatter from a markdown file.
 * Returns an object with the parsed key-value pairs (simple flat parsing).
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

describe("template agent contract (Phase 2 / 169)", () => {
  it("feat-design-plan-agent.md has no skills or inherit_skills in frontmatter", () => {
    const agentPath = path.join(AGENTS_DIR, "feat-design-plan-agent.md");
    const content = fs.readFileSync(agentPath, "utf-8");
    const fm = parseFrontmatter(content);

    // skills: field must be absent (removed in Phase 2)
    expect(fm).not.toHaveProperty("skills");
    // inherit_skills must also be absent
    expect(fm).not.toHaveProperty("inherit_skills");

    // Other expected fields should still be present
    expect(fm).toHaveProperty("name");
    expect(fm).toHaveProperty("model");
    expect(fm).toHaveProperty("permission");
    expect(fm).toHaveProperty("tools");
  });

  it("pipeline_loop.json clarify/plan share agentPath but have distinct skillPaths", () => {
    const jsonPath = path.join(TEMPLATE_DIR, "pipeline_loop.json");
    const content = fs.readFileSync(jsonPath, "utf-8");
    const json = JSON.parse(content) as {
      stages: Record<string, { agentPath?: string; skillPath?: string }>;
    };

    const clarify = json.stages["clarify"];
    const plan = json.stages["plan"];

    expect(clarify).toBeDefined();
    expect(plan).toBeDefined();

    // Both clarify and plan use the same agent
    expect(clarify.agentPath).toBe(plan.agentPath);
    expect(clarify.agentPath).toContain("feat-design-plan-agent");

    // But different skills (one SKILL per stage)
    expect(clarify.skillPath).toBeDefined();
    expect(plan.skillPath).toBeDefined();
    expect(clarify.skillPath).not.toBe(plan.skillPath);
    expect(clarify.skillPath).toContain("design");
    expect(plan.skillPath).toContain("plan");
  });

  it("develop/review/fix template agents each have a single agent declaration", () => {
    const expectedAgents = ["develop-agent.md", "code-review-agent.md", "code-review-withfix-agent.md"];

    for (const agentFile of expectedAgents) {
      const agentPath = path.join(AGENTS_DIR, agentFile);
      expect(fs.existsSync(agentPath)).toBe(true);

      const content = fs.readFileSync(agentPath, "utf-8");
      const fm = parseFrontmatter(content);

      // Each agent file should have a name field
      expect(fm).toHaveProperty("name");
      // Name should match the file basename
      const expectedName = path.basename(agentFile, ".md");
      expect(fm["name"]).toBe(expectedName);
    }
  });

  it("pipeline_loop.json has no compact block (defaults apply)", () => {
    const jsonPath = path.join(TEMPLATE_DIR, "pipeline_loop.json");
    const content = fs.readFileSync(jsonPath, "utf-8");
    const json = JSON.parse(content) as Record<string, unknown>;

    // Template must not write compact config (defaults apply via code)
    expect(json).not.toHaveProperty("compact");
  });
});
