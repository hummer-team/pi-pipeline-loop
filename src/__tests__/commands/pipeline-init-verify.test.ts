import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineInitVerifyCommand } from "../../commands/pipeline-init-verify";
import { makeTestConfig } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";

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

  it("uses custom verify_prompt.md when it exists", async () => {
    const skillContent = "# Test Skill\n\nSome content without markers.\n";

    const config = await setupConfigWithSkill("develop", skillContent);

    // Create custom verify_prompt.md
    const refsDir = path.join(TMP, ".pi", "references");
    await fs.mkdir(refsDir, { recursive: true });
    const customPrompt = "Custom extraction prompt: focus on API endpoints";
    await fs.writeFile(path.join(refsDir, "verify_prompt.md"), customPrompt, "utf-8");

    let receivedPrompt = "";
    const mockLLM = async (prompt: string): Promise<string> => {
      receivedPrompt = prompt;
      return JSON.stringify([{ type: "file", target: "custom.md" }]);
    };

    const cmd = createPipelineInitVerifyCommand(config, mockLLM);
    await cmd.execute({ stage: "develop" });

    expect(receivedPrompt).toContain("Custom extraction prompt");
    expect(receivedPrompt).toContain("API endpoints");
  });

  it("falls back to DEFAULT prompt when verify_prompt.md does not exist", async () => {
    const skillContent = "# Test Skill\n\nSome content without markers.\n";

    const config = await setupConfigWithSkill("develop", skillContent);
    // No verify_prompt.md created

    let receivedPrompt = "";
    const mockLLM = async (prompt: string): Promise<string> => {
      receivedPrompt = prompt;
      return JSON.stringify([{ type: "file", target: "default.md" }]);
    };

    const cmd = createPipelineInitVerifyCommand(config, mockLLM);
    await cmd.execute({ stage: "develop" });

    // Should contain the DEFAULT prompt text
    expect(receivedPrompt).toContain("delivery item extractor");
  });

  it("falls back to DEFAULT prompt when verify_prompt.md is empty", async () => {
    const skillContent = "# Test Skill\n\nSome content without markers.\n";

    const config = await setupConfigWithSkill("develop", skillContent);

    // Create empty verify_prompt.md
    const refsDir = path.join(TMP, ".pi", "references");
    await fs.mkdir(refsDir, { recursive: true });
    await fs.writeFile(path.join(refsDir, "verify_prompt.md"), "   \n  ", "utf-8");

    let receivedPrompt = "";
    const mockLLM = async (prompt: string): Promise<string> => {
      receivedPrompt = prompt;
      return JSON.stringify([{ type: "file", target: "fallback.md" }]);
    };

    const cmd = createPipelineInitVerifyCommand(config, mockLLM);
    await cmd.execute({ stage: "develop" });

    // Empty file → fallback to DEFAULT
    expect(receivedPrompt).toContain("delivery item extractor");
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

  it("writes verify_md_generate_error to audit when file write fails", async () => {
    const skillContent = "- **Must** output.md\n";

    // Set up skill file
    const skillDir = path.join(TMP, ".pi", "skills", "develop");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

    // Create a file where the verify directory should be created, causing mkdir to fail
    const blockPath = path.join(TMP, ".pi", "references", "develop_spec");
    await fs.mkdir(path.join(TMP, ".pi", "references"), { recursive: true });
    await fs.writeFile(blockPath, "I am a file, not a directory", "utf-8");

    // Set up audit log
    const auditDir = path.join(TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    const config = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
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
    await initAuditLog(config);

    const cmd = createPipelineInitVerifyCommand(config);
    const result: any = await cmd.execute({ stage: "develop" });

    expect(result.success).toBe(true); // command itself succeeds, but the stage has an error result
    const errored = result.results.filter((r: any) => r.status === "error");
    expect(errored).toHaveLength(1);

    // Read the audit log and verify
    const logFile = path.join(auditDir, getDateAuditFileName());
    const logContent = await fs.readFile(logFile, "utf-8");

    expect(logContent).toContain("verify_md_generate_error");
    expect(logContent).toContain("[ERROR]");

    // Clean up audit state
    __resetAuditDirPath();
  });
});
