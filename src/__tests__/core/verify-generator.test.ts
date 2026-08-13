import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  generateVerifyFiles,
  resolveExtractPrompt,
  resolveTargetStages,
  readSkillBody,
  extractHardcodedItems,
  extractLLMItems,
  classifyDeliveryItem,
  mergeDeliveryItems,
  generateVerifyMdContent,
} from "../../core/verify-generator";
import { makeTestConfig } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-verify-gen-" + Date.now());
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

describe("verify-generator", () => {
  describe("resolveTargetStages", () => {
    it("returns all active stages when stage is undefined", () => {
      const config = makeTestConfig();
      const stages = resolveTargetStages(undefined, config);
      expect(stages).toEqual(["clarify", "design", "plan", "develop", "review", "fix"]);
    });

    it("returns single stage when valid stage is given", () => {
      const config = makeTestConfig();
      const stages = resolveTargetStages("develop", config);
      expect(stages).toEqual(["develop"]);
    });

    it("returns empty array for unknown stage", () => {
      const config = makeTestConfig();
      const stages = resolveTargetStages("nonexistent", config);
      expect(stages).toEqual([]);
    });
  });

  describe("readSkillBody", () => {
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

      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

      const body = await readSkillBody(".pi/skills/develop/SKILL.md", TMP);
      expect(body).toContain("# Skill Body");
      expect(body).toContain("**Required** output.md file");
      expect(body).not.toContain("name: test-skill");
    });

    it("returns null for non-existent file", async () => {
      const body = await readSkillBody(".pi/skills/missing/SKILL.md", TMP);
      expect(body).toBeNull();
    });
  });

  describe("extractHardcodedItems", () => {
    it("extracts items marked with **Must**", () => {
      const items = extractHardcodedItems("- **Must** create the commit doc at docs/design/commit.md");
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("file");
      expect(items[0].target).toContain("docs/design/commit.md");
    });

    it("extracts items marked with **必须**", () => {
      const items = extractHardcodedItems("- **必须** bun run build");
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("command");
    });

    it("ignores lines without markers", () => {
      const items = extractHardcodedItems("Normal line without marker\n- **Must** output.md");
      expect(items).toHaveLength(1);
    });

    // ── Phase 1: phrase-bold extraction + keyword filtering (Plan D) ──

    it("phrase-bold with keyword-only content → discarded (empty result)", () => {
      // **必须完成** followed by abstract description → classified as keyword → filtered out
      const items = extractHardcodedItems("- **必须完成**：对最后一轮...分析");
      expect(items).toHaveLength(0);
    });

    it("phrase-bold with file path → extracted as file item", () => {
      const items = extractHardcodedItems("- **必须创建** docs/design/commit.md");
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("file");
      expect(items[0].target).toContain("docs/design/commit.md");
    });

    it("phrase-bold with command → extracted as command item", () => {
      const items = extractHardcodedItems("- **必须运行** bun run build");
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("command");
      expect(items[0].target).toContain("bun run build");
    });

    it("independent marker preserves keyword type", () => {
      // **必须** (standalone) followed by abstract text → keyword is KEPT
      const items = extractHardcodedItems("- **必须** 澄清问题");
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("keyword");
      expect(items[0].target).toBe("澄清问题");
    });

    it("independent marker takes priority when both patterns match same line", () => {
      // Line has **必须** (independent) — phrase-bold also matches but independent wins
      const items = extractHardcodedItems("- **必须** 澄清问题");
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("keyword");
    });

    it("mixed lines: independent + phrase-bold on different lines", () => {
      const skillBody = [
        "- **必须** 澄清问题",               // independent → keyword kept
        "- **必须创建** docs/design/spec.md", // phrase-bold → file kept
        "- **必须完成** 分析报告",             // phrase-bold → keyword discarded
        "- **Must** bun run test",            // independent → command kept
      ].join("\n");
      const items = extractHardcodedItems(skillBody);
      expect(items).toHaveLength(3);
      expect(items[0].type).toBe("keyword");   // 澄清问题
      expect(items[1].type).toBe("file");      // docs/design/spec.md
      expect(items[2].type).toBe("command");   // bun run test
    });
  });

  describe("classifyDeliveryItem", () => {
    it("classifies file paths", () => {
      const item = classifyDeliveryItem("create docs/design/commit.md");
      expect(item.type).toBe("file");
    });

    it("classifies commands", () => {
      const item = classifyDeliveryItem("bun run build successfully");
      expect(item.type).toBe("command");
    });

    it("classifies git items", () => {
      const item = classifyDeliveryItem("commit all changes");
      expect(item.type).toBe("git");
    });

    it("defaults to keyword", () => {
      const item = classifyDeliveryItem("pass all tests");
      expect(item.type).toBe("keyword");
    });
  });

  describe("mergeDeliveryItems", () => {
    it("deduplicates items from hardcoded and LLM extraction", () => {
      const hardcoded = [{ type: "file" as const, target: "output.md" }];
      const llm = [{ type: "file" as const, target: "output.md" }];
      const merged = mergeDeliveryItems(hardcoded, llm);
      expect(merged).toHaveLength(1);
    });

    it("merges unique items", () => {
      const hardcoded = [{ type: "file" as const, target: "a.md" }];
      const llm = [{ type: "file" as const, target: "b.md" }];
      const merged = mergeDeliveryItems(hardcoded, llm);
      expect(merged).toHaveLength(2);
    });
  });

  describe("generateVerifyMdContent", () => {
    it("generates YAML frontmatter with rules", () => {
      const items = [
        { type: "file" as const, target: "output.md" },
        { type: "command" as const, target: "bun run build" },
      ];
      const content = generateVerifyMdContent(items, "develop");
      expect(content).toContain("rules:");
      expect(content).toContain("output.md");
      expect(content).toContain("bun run build");
    });
  });

  describe("generateVerifyFiles", () => {
    it("generates verify.md for a stage with **Must** markers", async () => {
      const skillContent = [
        "---",
        "name: develop-skill",
        "---",
        "# Develop Stage",
        "",
        "- **Must** create the commit doc at docs/design/commit.md",
        "- **Must** run bun run build successfully",
        "- Normal line without marker",
      ].join("\n");

      const config = await setupConfigWithSkill("develop", skillContent);
      const results = await generateVerifyFiles(config, { stage: "develop" });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("generated");

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

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("skipped");
      expect(results[0].reason).toBe("skill_not_found");
    });

    it("skips stages with skill file but no Must markers", async () => {
      const config = await setupConfigWithSkill("develop", "# Develop\nNo markers here.");
      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("skipped");
      expect(results[0].reason).toBe("no_items");
    });

    // NOTE: LLM extraction tests restored (117 Phase 1)

    it("extractLLMItems: valid JSON response", async () => {
      const callLLM = async (_prompt: string): Promise<string> => {
        return JSON.stringify([
          { type: "file", target: "output.md" },
          { type: "command", target: "bun run build" },
        ]);
      };
      const items = await extractLLMItems("skill body", callLLM, "extract prompt");
      expect(items).toHaveLength(2);
      expect(items[0].type).toBe("file");
      expect(items[1].type).toBe("command");
    });

    it("extractLLMItems: strips code block wrapper", async () => {
      const callLLM = async (): Promise<string> => {
        return '```json\n[{"type":"file","target":"a.md"}]\n```';
      };
      const items = await extractLLMItems("body", callLLM, "prompt");
      expect(items).toHaveLength(1);
      expect(items[0].target).toBe("a.md");
    });

    it("extractLLMItems: invalid JSON returns empty array", async () => {
      const callLLM = async (): Promise<string> => "not json at all";
      const items = await extractLLMItems("body", callLLM, "prompt");
      expect(items).toEqual([]);
    });

    it("extractLLMItems: filters by valid type/target", async () => {
      const callLLM = async (): Promise<string> => {
        return JSON.stringify([
          { type: "file", target: "a.md" },
          { type: "invalid_type", target: "b.md" },
          { type: "command" }, // missing target
          { type: "keyword", target: "pass" },
        ]);
      };
      const items = await extractLLMItems("body", callLLM, "prompt");
      expect(items).toHaveLength(2);
      expect(items.map(i => i.type)).toEqual(["file", "keyword"]);
    });

    it("generateVerifyFiles: llmExtract=false does not call callLLM", async () => {
      let callCount = 0;
      const callLLM = async (): Promise<string> => {
        callCount++;
        return "[]";
      };
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");
      // llmExtract defaults to false/undefined in makeTestConfig
      const results = await generateVerifyFiles(config, { stage: "develop", callLLM });
      expect(callCount).toBe(0);
      expect(results[0].llmStatus).toBe("off");
    });

    it("generateVerifyFiles: llmExtract=true + callLLM merges hardcoded and LLM items", async () => {
      const callLLM = async (): Promise<string> => {
        return JSON.stringify([{ type: "file", target: "llm-output.md" }]);
      };
      const config = await setupConfigWithSkill("develop", "- **Must** hardcoded-output.md\n");
      (config as any).llmExtract = true;
      const results = await generateVerifyFiles(config, { stage: "develop", callLLM });
      expect(results[0].status).toBe("generated");
      expect(results[0].hardcodedCount).toBe(1);
      expect(results[0].llmCount).toBe(1);
      expect(results[0].llmStatus).toBe("ok");

      const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
      const content = await fs.readFile(verifyPath, "utf-8");
      expect(content).toContain("hardcoded-output.md");
      expect(content).toContain("llm-output.md");
    });

    it("generateVerifyFiles: callLLM throws → fallback to hardcoded + audit error", async () => {
      const callLLM = async (): Promise<string> => {
        throw new Error("LLM timeout");
      };
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      const config = await setupConfigWithSkill("develop", "- **Must** fallback.md\n");
      (config as any).llmExtract = true;
      await initAuditLog(config);

      const results = await generateVerifyFiles(config, { stage: "develop", callLLM });
      expect(results[0].status).toBe("generated");
      expect(results[0].hardcodedCount).toBe(1);
      expect(results[0].llmCount).toBe(0);
      expect(results[0].llmStatus).toBe("fail");

      // Verify audit log contains error
      const logFile = path.join(auditDir, getDateAuditFileName());
      const logContent = await fs.readFile(logFile, "utf-8");
      expect(logContent).toContain("verify_llm_extract_error");
      expect(logContent).toContain("LLM timeout");

      __resetAuditDirPath();
    });

    it("generateVerifyFiles: per-stage verify_md_generate audit fields", async () => {
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");
      await initAuditLog(config);

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results[0].status).toBe("generated");

      const logFile = path.join(auditDir, getDateAuditFileName());
      const logContent = await fs.readFile(logFile, "utf-8");
      expect(logContent).toContain("verify_md_generate");
      expect(logContent).toContain("stage=develop");
      expect(logContent).toContain("status=generated");
      expect(logContent).toContain("hardcodedCount=1");
      expect(logContent).toContain("llmStatus=off");

      __resetAuditDirPath();
    });

    it("processes all stages when no stage argument is given", async () => {
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

      const results = await generateVerifyFiles(config);
      const generated = results.filter(r => r.status === "generated");
      expect(generated.length).toBeGreaterThanOrEqual(2);
    });

    it("writes verify_md_generate_error to audit when file write fails", async () => {
      const skillContent = "- **Must** output.md\n";

      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

      // Block the verify directory creation
      const blockPath = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(path.join(TMP, ".pi", "references"), { recursive: true });
      await fs.writeFile(blockPath, "I am a file, not a directory", "utf-8");

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

      const results = await generateVerifyFiles(config, { stage: "develop" });
      const errored = results.filter(r => r.status === "error");
      expect(errored).toHaveLength(1);

      const logFile = path.join(auditDir, getDateAuditFileName());
      const logContent = await fs.readFile(logFile, "utf-8");
      expect(logContent).toContain("verify_md_generate_error");
      expect(logContent).toContain("[ERROR]");

      __resetAuditDirPath();
    });
  });

  describe("resolveExtractPrompt", () => {
    it("uses custom verify_prompt.md when it exists", async () => {
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, "verify_prompt.md"), "Custom prompt", "utf-8");

      const prompt = await resolveExtractPrompt(TMP);
      expect(prompt).toBe("Custom prompt");
    });

    it("falls back to default when verify_prompt.md does not exist", async () => {
      const prompt = await resolveExtractPrompt(TMP);
      expect(prompt).toContain("delivery item extractor");
    });

    it("falls back to default when verify_prompt.md is empty", async () => {
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, "verify_prompt.md"), "   \n  ", "utf-8");

      const prompt = await resolveExtractPrompt(TMP);
      expect(prompt).toContain("delivery item extractor");
    });
  });
});
