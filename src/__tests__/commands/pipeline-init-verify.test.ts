import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineInitVerifyCommand } from "../../commands/pipeline-init-verify";
import { makeTestConfig } from "../helpers";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-init-verify-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Helper to create a config with skill files in place */
async function setupConfigWithSkill(
  stage: string,
  skillContent: string,
) {
  const skillDir = path.join(TMP, ".pi", "skills", stage);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

  return makeTestConfig({
    projectRoot: TMP,
    stages: Object.fromEntries(
      ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
        (s, i, a) => [
          s,
          {
            agentFile: "a.md",
            skillPath: `${s}/SKILL.md`,
            allowedTools: ["read"],
            allowedBashPrefixes: ["ls"],
            nextStage: a[i + 1] ?? null,
            requireDomain: false,
          },
        ],
      ),
    ) as any,
  });
}

describe("createPipelineInitVerifyCommand", () => {
  it("creates a command with correct name", () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const cmd = createPipelineInitVerifyCommand(config);
    expect(cmd.name).toBe("pipeline_init_verify");
  });

  it("returns error for unknown stage", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const cmd = createPipelineInitVerifyCommand(config);
    const result: any = await cmd.execute({ stage: "nonexistent" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown stage");
  });

  it("generates verify.md for a stage with **Must** markers", async () => {
    const skillContent = [
      "---",
      "name: develop-skill",
      "---",
      "# Develop Stage",
      "",
      "You must complete the following:",
      "",
      "- **Must** create the commit doc at docs/design/commit.md",
      "- **Must** run bun run build successfully",
      "- Normal line without marker",
    ].join("\n");

    const config = await setupConfigWithSkill("develop", skillContent);
    const cmd = createPipelineInitVerifyCommand(config);
    const result: any = await cmd.execute({ stage: "develop" });

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Generated 1");

    // Verify the file was created
    const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
    const content = await fs.readFile(verifyPath, "utf-8");
    expect(content).toContain("rules:");
    expect(content).toContain("docs/design/commit.md");
    expect(content).toContain("bun run build");
  });

  it("skips stages with no skill file", async () => {
    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentFile: "a.md",
              skillPath: `${s}/SKILL.md`,
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
            },
          ],
        ),
      ) as any,
    });

    const cmd = createPipelineInitVerifyCommand(config);
    const result: any = await cmd.execute({ stage: "develop" });

    expect(result.success).toBe(true);
    expect(result.summary).toContain("skipped 1");
  });

  it("strips YAML frontmatter from skill files", async () => {
    const skillContent = [
      "---",
      "name: test-skill",
      "version: 1.0",
      "---",
      "# Skill Body",
      "",
      "- **Required** output.md file",
    ].join("\n");

    const config = await setupConfigWithSkill("develop", skillContent);
    const cmd = createPipelineInitVerifyCommand(config);
    const result: any = await cmd.execute({ stage: "develop" });

    expect(result.success).toBe(true);

    const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
    const content = await fs.readFile(verifyPath, "utf-8");
    expect(content).toContain("output.md");
  });

  it("uses LLM extraction when callLLM is provided", async () => {
    const skillContent = "# Test Skill\n\nSome content without markers.\n";

    const config = await setupConfigWithSkill("develop", skillContent);
    const mockLLM = async (_prompt: string): Promise<string> => {
      return JSON.stringify([
        { type: "file", target: "llm-generated.md" },
        { type: "command", target: "bun test" },
      ]);
    };

    const cmd = createPipelineInitVerifyCommand(config, mockLLM);
    const result: any = await cmd.execute({ stage: "develop" });

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Generated 1");

    const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
    const content = await fs.readFile(verifyPath, "utf-8");
    expect(content).toContain("llm-generated.md");
    expect(content).toContain("bun test");
  });

  it("processes all stages when no stage argument is given", async () => {
    // Set up skill files for multiple stages with markers
    for (const stage of ["clarify", "develop"]) {
      const skillDir = path.join(TMP, ".pi", "skills", stage);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `- **Must** ${stage}-output.md\n`,
        "utf-8",
      );
    }

    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentFile: "a.md",
              skillPath: `${s}/SKILL.md`,
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
            },
          ],
        ),
      ) as any,
    });

    const cmd = createPipelineInitVerifyCommand(config);
    const result: any = await cmd.execute({});

    expect(result.success).toBe(true);
    // At least clarify and develop should be generated
    const generated = result.results.filter((r: any) => r.status === "generated");
    expect(generated.length).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates items from hardcoded and LLM extraction", async () => {
    const skillContent = "- **Must** shared-output.md\n";

    const config = await setupConfigWithSkill("develop", skillContent);
    const mockLLM = async (): Promise<string> => {
      return JSON.stringify([{ type: "file", target: "shared-output.md" }]);
    };

    const cmd = createPipelineInitVerifyCommand(config, mockLLM);
    const result: any = await cmd.execute({ stage: "develop" });

    expect(result.success).toBe(true);

    const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
    const content = await fs.readFile(verifyPath, "utf-8");
    // "shared-output.md" should appear exactly once in the requiredFiles list
    const matches = content.match(/shared-output\.md/g);
    expect(matches).toHaveLength(1);
  });
});
