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
  parseVerifyRulesFromContent,
  repairVerifyFrontmatter,
  loadPluginDeliverables,
  diffAndMergeRules,
  TEMPLATE_BUILTIN_CONTENT_PATTERNS,
} from "../../core/verify-generator";
import { parseFrontmatter } from "../../core/auto-verifier";
import { makeTestConfig } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { resetPromptConfigCache } from "../../core/prompt-config";

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
      ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
        (s, i, a) => [
          s,
          {
            agentPath: "a.md",
            skillPath: `${s}/SKILL.md`,
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
      expect(stages).toEqual(["clarify", "plan", "develop", "review", "fix"]);
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

    it("classifies JVM Maven commands as command (not file)", () => {
      expect(classifyDeliveryItem("./mvnw clean test").type).toBe("command");
      expect(classifyDeliveryItem("mvn compile").type).toBe("command");
      expect(classifyDeliveryItem("mvn test -pl module").type).toBe("command");
    });

    it("classifies JVM Gradle commands as command", () => {
      expect(classifyDeliveryItem("./gradlew build").type).toBe("command");
      expect(classifyDeliveryItem("gradle test").type).toBe("command");
      expect(classifyDeliveryItem("gradlew clean").type).toBe("command");
    });

    it("classifies wrapper script itself as command", () => {
      expect(classifyDeliveryItem("./mvnw").type).toBe("command");
      expect(classifyDeliveryItem("./gradlew").type).toBe("command");
    });

    it("command priority beats file pattern for path-like commands", () => {
      // `./mvnw clean test` contains `/` but should NOT be classified as file
      const item = classifyDeliveryItem("./mvnw clean test");
      expect(item.type).toBe("command");
    });

    it("still classifies pure file paths as file", () => {
      expect(classifyDeliveryItem("docs/design/commit.md").type).toBe("file");
      expect(classifyDeliveryItem("src/main/App.java").type).toBe("file");
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

  describe("repairVerifyFrontmatter", () => {
    it("repairs `mode: and---` glued closing delimiter to standalone line", () => {
      const malformed = "---\nrules:\n  requiredFiles:\n    - \"foo.md\"\n  mode: and---\nbody text\n";
      const { repaired, content } = repairVerifyFrontmatter(malformed);
      expect(repaired).toBe(true);
      expect(content).toContain("mode: and\n---\n");
      expect(content).not.toMatch(/mode: and---/);
      // Rule text preserved
      expect(content).toContain("requiredFiles:");
      expect(content).toContain("- \"foo.md\"");
      // Body preserved after closing delimiter
      expect(content).toContain("body text");
    });

    it("returns repaired=false for well-formed content (already has standalone ---)", () => {
      const wellFormed = "---\nrules:\n  requiredFiles:\n    - \"foo.md\"\n  mode: and\n---\nbody text\n";
      const { repaired, content } = repairVerifyFrontmatter(wellFormed);
      expect(repaired).toBe(false);
      expect(content).toBe(wellFormed);
    });

    it("returns repaired=false when content has no `rules:` key (not frontmatter)", () => {
      const nonYaml = "# Just a markdown file\nNo YAML here\n";
      const { repaired, content } = repairVerifyFrontmatter(nonYaml);
      expect(repaired).toBe(false);
      expect(content).toBe(nonYaml);
    });

    it("recovers body text swallowed into frontmatter (no standalone ---)", async () => {
      // Simulates the Phase 0 bug where body was absorbed into the frontmatter block
      const malformed = "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n  mode: and---\nVerify the delivery items.\n";
      const { repaired, content } = repairVerifyFrontmatter(malformed);
      expect(repaired).toBe(true);

      // Round-trip: parseVerifyRulesFromContent now recovers rules correctly
      const rules = await parseVerifyRulesFromContent(content);
      expect(rules).not.toBeNull();
      expect(rules!.mode).toBe("and");
      expect(rules!.requiredFiles).toEqual(["output.md"]);
    });

    it("integration: generateVerifyFiles auto-repairs malformed file in exists branch and audits verify_md_repair", async () => {
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");
      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      // Pre-create a malformed verify.md (missing closing ---)
      const malformed = "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n  mode: and---\nExisting body\n";
      await fs.writeFile(path.join(verifyDir, "verify.md"), malformed, "utf-8");

      // Reset audit log capture so audit is written under TMP
      __resetAuditDirPath();
      await initAuditLog(config);

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      // After repair, the rules already contain the expected items, so it's skipped as "exists"
      expect(["skipped", "merged"]).toContain(results[0].status);

      // The file on disk is now repaired
      const repairedContent = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");
      expect(repairedContent).not.toMatch(/mode: and---/);
      expect(repairedContent).toMatch(/mode: and\n---/);

      // Audit log contains verify_md_repair entry
      const auditPath = path.join(TMP, ".pi", "audit", getDateAuditFileName());
      const auditContent = await fs.readFile(auditPath, "utf-8");
      expect(auditContent).toContain("verify_md_repair");
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
          ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
            (s, i, a) => [
              s,
              {
                agentPath: "a.md",
                skillPath: `${s}/SKILL.md`,
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

    it("generateVerifyFiles: LLM extract prompt includes tech stack context when pom.xml present", async () => {
      let capturedPrompt = "";
      const callLLM = async (prompt: string): Promise<string> => {
        capturedPrompt = prompt;
        return JSON.stringify([{ type: "command", target: "./mvnw clean test" }]);
      };
      // Write pom.xml to project root so detectTechStack returns maven
      await fs.writeFile(path.join(TMP, "pom.xml"), "<project/>", "utf-8");
      const config = await setupConfigWithSkill("develop", "- **Must** ./mvnw clean test\n");
      (config as any).llmExtract = true;
      await generateVerifyFiles(config, { stage: "develop", callLLM });

      expect(capturedPrompt).toContain("Project tech stack: maven");
      expect(capturedPrompt).toContain("./mvnw");
      expect(capturedPrompt).toContain("Extract commands based on this project");
    });

    it("generateVerifyFiles: LLM extract prompt has no tech stack section when no stack detected", async () => {
      let capturedPrompt = "";
      const callLLM = async (prompt: string): Promise<string> => {
        capturedPrompt = prompt;
        return "[]";
      };
      // No tech stack files in TMP
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");
      (config as any).llmExtract = true;
      await generateVerifyFiles(config, { stage: "develop", callLLM });

      expect(capturedPrompt).not.toContain("Project tech stack:");
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

    it("Phase 1 — callLLM returns invalid JSON → verify_llm_extract_error audit (warn) + llmStatus='ok'", async () => {
      // callLLM returns invalid JSON (not a throw) — extractLLMItems catches parse error
      // and calls onParseError → verify_llm_extract_error audit (warn level)
      // llmStatus should still be "ok" because callLLM didn't throw
      const callLLM = async (): Promise<string> => "this is not valid JSON {{{";
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      const config = await setupConfigWithSkill("develop", "- **Must** fallback.md\n");
      (config as any).llmExtract = true;
      await initAuditLog(config);

      const results = await generateVerifyFiles(config, { stage: "develop", callLLM });
      // LLM didn't throw, so llmStatus is "ok" (even though JSON was invalid)
      expect(results[0].llmStatus).toBe("ok");
      expect(results[0].llmCount).toBe(0);
      // Hardcoded items still generate verify
      expect(results[0].status).toBe("generated");
      expect(results[0].hardcodedCount).toBe(1);

      // Verify audit log contains verify_llm_extract_error (warn level)
      const logFile = path.join(auditDir, getDateAuditFileName());
      const logContent = await fs.readFile(logFile, "utf-8");
      expect(logContent).toContain("verify_llm_extract_error");
      expect(logContent).toContain("invalid JSON from LLM");
      expect(logContent).toContain("[WARN]");

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
          ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
            (s, i, a) => [
              s,
              {
                agentPath: "a.md",
                skillPath: `${s}/SKILL.md`,
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

    it("merges missing rules into existing verify.md when rules are empty", async () => {
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");

      // Pre-create the verify.md file with empty rules
      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      await fs.writeFile(path.join(verifyDir, "verify.md"), "---\nrules:\n---\nExisting template content\n", "utf-8");

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("merged");

      // Existing body should be preserved, but output.md rule is added
      const content = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");
      expect(content).toContain("Existing template content");
      expect(content).toContain("output.md");
    });

    it("merge output closes frontmatter delimiter on its own line (round-trip: mode=and preserved)", async () => {
      // Triggers buildMergedVerifyContent path: existing verify.md + additional hardcoded items
      // Include a plain keyword ("security") so that generateVerifyMdContent emits `mode: and`.
      const config = await setupConfigWithSkill(
        "develop",
        "- **Must** output.md\n- **Must** security\n",
      );

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      // Pre-existing file with empty rules → forces merge path
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n---\nExisting body text\n",
        "utf-8",
      );

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("merged");

      const content = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");

      // Phase 0 (Bug 3-A): closing `---` must be on its own line, never `mode: and---`
      expect(content).not.toMatch(/mode: and---/);
      expect(content).toMatch(/mode: and\n---/);

      // Round-trip: parseFrontmatter must recover mode="and"
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
      expect(frontmatterMatch).not.toBeNull();
      const rules = await parseFrontmatter(frontmatterMatch![1]);
      expect(rules).not.toBeNull();
      expect(rules!.mode).toBe("and");

      // Round-trip: parseVerifyRulesFromContent must recover requiredFiles + body not swallowed
      const parsedRules = await parseVerifyRulesFromContent(content);
      expect(parsedRules).not.toBeNull();
      expect(parsedRules!.requiredFiles).toEqual(["output.md"]);
      expect(parsedRules!.mode).toBe("and");

      // Body must remain as markdown, not be absorbed into frontmatter
      expect(content).toContain("Existing body text");
    });

    it("merge branch reports correct hardcodedCount, llmCount, and llmStatus", async () => {
      // Two hardcoded items: one file, one command
      const skillContent = [
        "- **Must** create docs/design/commit.md",
        "- **Must** bun run build",
      ].join("\n");
      const config = await setupConfigWithSkill("develop", skillContent);

      // Pre-create the verify.md file with empty rules to trigger merge branch
      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      await fs.writeFile(path.join(verifyDir, "verify.md"), "---\nrules:\n---\nExisting content\n", "utf-8");

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("merged");
      // hardcodedCount should reflect actual hardcoded extraction count (2 items)
      expect(results[0].hardcodedCount).toBe(2);
      // LLM not enabled → llmCount=0, llmStatus="off"
      expect(results[0].llmCount).toBe(0);
      expect(results[0].llmStatus).toBe("off");
    });

    it("skips existing verify.md when all expected rules are already present", async () => {
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");

      // Pre-create verify.md that already contains the expected rule
      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n---\nExisting content\n",
        "utf-8",
      );

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("skipped");
      expect(results[0].reason).toBe("exists");
    });

    it("protects existing verify.md with user-authored custom rules (fileContentPattern)", async () => {
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");

      // Pre-create verify.md with custom fileContentPattern rule (user-authored)
      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n  fileContentPattern:\n    - path: \"output.md\"\n      pattern: \"^phase:\"\n---\nContent\n",
        "utf-8",
      );

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("skipped");
      expect(results[0].reason).toBe("exists_custom");

      // Custom rules preserved — file content unchanged
      const content = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");
      expect(content).toContain("fileContentPattern");
    });

    it("drops command items for develop stage", async () => {
      const skillContent = [
        "- **Must** create docs/design/commit.md",
        "- **Must** bun run build",
      ].join("\n");
      const config = await setupConfigWithSkill("develop", skillContent);
      const results = await generateVerifyFiles(config, { stage: "develop" });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("generated");

      const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
      const content = await fs.readFile(verifyPath, "utf-8");
      expect(content).toContain("docs/design/commit.md");
      // develop stage now preserves command items (tech stack detection ensures correctness)
      expect(content).toContain("bun run build");
    });

    it("drops command items for fix stage", async () => {
      const skillContent = [
        "- **Must** create docs/design/commit.md",
        "- **Must** npm test",
      ].join("\n");
      const config = await setupConfigWithSkill("fix", skillContent);
      const results = await generateVerifyFiles(config, { stage: "fix" });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("generated");

      const verifyPath = path.join(TMP, ".pi", "references", "fix_spec", "verify.md");
      const content = await fs.readFile(verifyPath, "utf-8");
      expect(content).toContain("docs/design/commit.md");
      // fix stage now preserves command items (tech stack detection ensures correctness)
      expect(content).toContain("npm test");
    });

    it("keeps command items for non-develop/fix stages", async () => {
      const skillContent = [
        "- **Must** create output.md",
        "- **Must** bun run build",
      ].join("\n");
      const config = await setupConfigWithSkill("plan", skillContent);
      const results = await generateVerifyFiles(config, { stage: "plan" });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("generated");

      const verifyPath = path.join(TMP, ".pi", "references", "plan_spec", "verify.md");
      const content = await fs.readFile(verifyPath, "utf-8");
      expect(content).toContain("output.md");
      expect(content).toContain("bun run build");
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
          ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
            (s, i, a) => [
              s,
              {
                agentPath: "a.md",
                skillPath: `${s}/SKILL.md`,
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

    it("merge branch reports hasRequirementDocPlaceholder=true when toAdd introduces {requirementDoc}", async () => {
      // Skill contains {requirementDoc} placeholder as a Must file item
      const config = await setupConfigWithSkill("develop", "- **Must** {requirementDoc}\n");

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      // Pre-create verify.md with empty rules (no placeholder) — forces merge path
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n---\nExisting body\n",
        "utf-8",
      );

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("merged");
      // The merged content now contains {requirementDoc} from toAdd, must be flagged
      expect(results[0].hasRequirementDocPlaceholder).toBe(true);

      // Also verify the on-disk merged file actually contains the placeholder
      const content = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");
      expect(content).toContain("{requirementDoc}");
    });

    it("onMergeAsk callback is invoked before merge write and 'allow' proceeds with merge", async () => {
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      // Pre-existing file with empty rules → forces merge path
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n---\nExisting body\n",
        "utf-8",
      );

      let callbackInvoked = false;
      let callbackStage = "";
      let callbackPath = "";
      const results = await generateVerifyFiles(config, {
        stage: "develop",
        onMergeAsk: async (stage, filePath) => {
          callbackInvoked = true;
          callbackStage = stage;
          callbackPath = filePath;
          return "allow";
        },
      });

      expect(callbackInvoked).toBe(true);
      expect(callbackStage).toBe("develop");
      expect(callbackPath).toContain("verify.md");
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("merged");
    });

    it("onMergeAsk callback returning 'block' skips merge with reason=user_declined", async () => {
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      const originalContent = "---\nrules:\n---\nExisting body\n";
      await fs.writeFile(path.join(verifyDir, "verify.md"), originalContent, "utf-8");

      const results = await generateVerifyFiles(config, {
        stage: "develop",
        onMergeAsk: async () => "block",
      });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("skipped");
      expect(results[0].reason).toBe("user_declined");
      // File must remain unchanged
      const afterContent = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");
      expect(afterContent).toBe(originalContent);
    });

    it("onMergeAsk not provided → merge proceeds without asking (backward compatible)", async () => {
      const config = await setupConfigWithSkill("develop", "- **Must** output.md\n");

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n---\nExisting body\n",
        "utf-8",
      );

      // No onMergeAsk → merge proceeds directly
      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("merged");
    });

    it("onMergeAsk 'block' on one stage does not affect other stages (continue)", async () => {
      // Create skills for two stages
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-out.md\n`,
          "utf-8",
        );
      }

      const config = await setupConfigWithSkill("develop", "- **Must** develop-out.md\n");
      // Override config to include plan stage too
      const multiConfig = makeTestConfig({
        projectRoot: TMP,
        stages: Object.fromEntries(
          ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
            (s, i, a) => [
              s,
              {
                agentPath: "a.md",
                skillPath: `${s}/SKILL.md`,
                nextStage: a[i + 1] ?? null,
                requireDomain: false,
              },
            ],
          ),
        ) as any,
      });

      // Pre-create verify.md for both stages (forces merge path for both)
      for (const stage of ["plan", "develop"]) {
        const verifyDir = path.join(TMP, ".pi", "references", `${stage}_spec`);
        await fs.mkdir(verifyDir, { recursive: true });
        await fs.writeFile(
          path.join(verifyDir, "verify.md"),
          "---\nrules:\n---\nBody\n",
          "utf-8",
        );
      }

      // Block develop, allow plan
      const results = await generateVerifyFiles(multiConfig, {
        stage: undefined,
        onMergeAsk: async (stage) => (stage === "develop" ? "block" : "allow"),
      });

      const planResult = results.find(r => r.stage === "plan");
      const developResult = results.find(r => r.stage === "develop");
      expect(planResult?.status).toBe("merged");
      expect(developResult?.status).toBe("skipped");
      expect(developResult?.reason).toBe("user_declined");
    });
  });

  describe("resolveExtractPrompt", () => {
    beforeEach(() => {
      resetPromptConfigCache();
    });

    it("uses custom verify_extract from yml when it exists", async () => {
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        'verify_extract: "Custom prompt"\n',
        "utf-8",
      );

      const prompt = await resolveExtractPrompt(TMP);
      expect(prompt).toBe("Custom prompt");
    });

    it("falls back to default when yml does not exist", async () => {
      const prompt = await resolveExtractPrompt(TMP);
      expect(prompt).toContain("delivery item extractor");
    });

    it("falls back to default when yml verify_extract is empty", async () => {
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        'verify_extract: ""\n',
        "utf-8",
      );

      const prompt = await resolveExtractPrompt(TMP);
      expect(prompt).toContain("delivery item extractor");
    });

    it("uses per-stage verify_extract_{stage} when it exists", async () => {
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        'verify_extract_clarify: "Per-stage clarify prompt"\nverify_extract: "Global prompt"\n',
        "utf-8",
      );

      const prompt = await resolveExtractPrompt(TMP, "clarify");
      expect(prompt).toBe("Per-stage clarify prompt");
    });

    it("falls back to global verify_extract when per-stage is missing", async () => {
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        'verify_extract: "Global prompt"\n',
        "utf-8",
      );

      const prompt = await resolveExtractPrompt(TMP, "develop");
      expect(prompt).toBe("Global prompt");
    });

    it("falls back to DEFAULT when both per-stage and global are missing", async () => {
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        'clarify: "some template"\n',
        "utf-8",
      );

      const prompt = await resolveExtractPrompt(TMP, "fix");
      expect(prompt).toContain("delivery item extractor");
    });
  });

  // Phase 5 (139) regression + Phase 0 (146): template SKILL strip validation
  // After Phase 3 (146): plugin control keywords stripped from templates;
  // business **必须** markers preserved for verify extraction.
  describe("Phase 0 (146): template SKILL plugin-keyword strip + business marker regression", () => {
    const templateSkillsDir = path.join(__dirname, "..", "..", "template", "skills");

    /** Helper: read template SKILL.md, returns null if not found */
    async function readTemplate(relPath: string): Promise<string | null> {
      const filePath = path.join(templateSkillsDir, relPath);
      try {
        return await fs.readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    }

    // develop/review/fix must NOT contain plugin control keywords
    // Exception: review/SKILL.md is allowed to reference stage_advance for the
    // reviewConclusion declaration protocol (163 Goal 2).
    const pluginKeywords = ["stage_advance", "loop_check"];
    for (const stage of ["develop", "review", "fix"]) {
      it(`${stage}/SKILL.md does NOT contain plugin control keywords`, async () => {
        const content = await readTemplate(`${stage}/SKILL.md`);
        if (!content) return; // skip if template not found
        for (const kw of pluginKeywords) {
          // 163: review SKILL intentionally references stage_advance for reviewConclusion declaration
          if (stage === "review" && kw === "stage_advance") continue;
          expect(content).not.toContain(kw);
        }
        // pipeline marker and nextStage return protocol are also plugin-owned
        expect(content).not.toMatch(/pipeline:\s*\{pipelineId\}/);
        expect(content).not.toContain("nextStage:");
      });
    }

    // review/fix/plan/design must still contain business **必须** markers
    for (const stage of ["review", "fix", "plan", "design"]) {
      it(`${stage}/SKILL.md still contains business **必须** delivery markers`, async () => {
        const content = await readTemplate(`${stage}/SKILL.md`);
        if (!content) return;
        expect(content).toContain("**必须**");
      });
    }

    // develop switched from **必须** TODO to Template-TODO placeholder (147 Phase 1).
    // The deliverables section now uses the reserved marker; no business **必须** remains.
    it("develop/SKILL.md deliverables section uses Template-TODO placeholder (no **必须**)", async () => {
      const content = await readTemplate("develop/SKILL.md");
      if (!content) return;
      expect(content).toContain("Template-TODO");
      expect(content).not.toContain("**必须**");
    });

    it("extractHardcodedItems finds **必须** items from template SKILL content", () => {
      const sampleContent = [
        "## Deliverables",
        "- **必须** create a plan document",
        "- **必须** run build successfully",
        "- Optional: add examples",
      ].join("\n");
      const items = extractHardcodedItems(sampleContent);
      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    // ── Phase 2 (147): Template-TODO placeholder lines are skipped ──────────

    it("skips lines carrying the Template-TODO reserved placeholder (no keyword rule emitted)", () => {
      // Even if prefixed with **必须**, Template-TODO lines are user-fillable stubs
      // and must NOT be extracted as delivery rules (147 Bug fix).
      const sampleContent = [
        "## Deliverables",
        "- **必须** Template-TODO: 补充业务交付项",
        "- **必须** run build successfully",
      ].join("\n");
      const items = extractHardcodedItems(sampleContent);
      // Only the second line should be extracted; the Template-TODO line is skipped.
      expect(items.length).toBe(1);
      expect(items[0].target).toBe("run build successfully");
    });

    it("skips HTML-comment lines carrying Template-TODO", () => {
      const sampleContent = [
        "## Deliverables",
        "<!-- Template-TODO: 补充项目业务交付项 -->",
        "- **必须** generate API documentation",
      ].join("\n");
      const items = extractHardcodedItems(sampleContent);
      expect(items.length).toBe(1);
      expect(items[0].target).toBe("generate API documentation");
    });

    it("mixed: real business items extracted while adjacent Template-TODO lines skipped", () => {
      const sampleContent = [
        "## Deliverables",
        "<!-- Template-TODO: 补充项目业务交付项 -->",
        "- **Template-TODO**: 补充项目特有的业务交付项",
        "- **必须** 生成 API 文档",
        "- **必须** 更新 CHANGELOG",
        "- **必须** Template-TODO: 伪规则（跳过）",
      ].join("\n");
      const items = extractHardcodedItems(sampleContent);
      // Only the two real business items should be extracted
      expect(items.length).toBe(2);
      const targets = items.map(i => i.target);
      expect(targets).toContain("生成 API 文档");
      expect(targets).toContain("更新 CHANGELOG");
    });
  });

  // ─── Phase 0 (146): loadPluginDeliverables + double-source merge ─────────────

  describe("Phase 0 (146): loadPluginDeliverables + double-source merge", () => {
    /** Helper: write yml + optional package.json (triggers bun tech stack) */
    async function writePluginYmlAndStack(
      ymlContent: string,
      techStack: "bun" | "maven" | "none" = "bun",
    ): Promise<void> {
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, "pipeline-stage-prompt.yml"), ymlContent, "utf-8");
      if (techStack === "bun") {
        await fs.writeFile(path.join(TMP, "package.json"), "{}", "utf-8");
        await fs.writeFile(path.join(TMP, "bun.lock"), "", "utf-8");
      } else if (techStack === "maven") {
        await fs.writeFile(path.join(TMP, "pom.xml"), "<project/>", "utf-8");
      }
    }

    it("loadPluginDeliverables returns command+git+keyword items for develop with bun stack", async () => {
      resetPromptConfigCache();
      const ymlContent = [
        "stage_deliverable_develop: |",
        "  ## Plugin Default Deliverables (develop)",
        "  - **MUST** run the project build command and confirm it passes (command determined by project tech stack)",
        "  - **MUST** run the project unit test command and confirm it passes (command determined by project tech stack)",
        "  - **MUST** commit changes",
        "  - **MUST** include `pipeline: {pipelineId}` in the artifact file header",
      ].join("\n");
      await writePluginYmlAndStack(ymlContent, "bun");

      const items = await loadPluginDeliverables(TMP, "develop");

      // Should have: 2 command items (bun run build, bun test) + 1 git + 1 keyword
      const commandItems = items.filter(i => i.type === "command");
      const gitItems = items.filter(i => i.type === "git");
      const keywordItems = items.filter(i => i.type === "keyword");

      expect(commandItems.length).toBe(2);
      expect(commandItems.map(i => i.target)).toContain("bun run build");
      expect(commandItems.map(i => i.target)).toContain("bun test");
      expect(gitItems.length).toBe(1);
      expect(gitItems[0].target).toContain("commit");
      expect(keywordItems.length).toBe(1);
      expect(keywordItems[0].target).toContain("pipeline");
    });

    it("loadPluginDeliverables returns empty for stages without plugin key (clarify)", async () => {
      resetPromptConfigCache();
      const ymlContent = [
        "stage_deliverable_develop: |",
        "  - **MUST** run build",
      ].join("\n");
      await writePluginYmlAndStack(ymlContent);

      const items = await loadPluginDeliverables(TMP, "clarify");
      expect(items).toEqual([]);
    });

    it("loadPluginDeliverables falls back to keyword when tech stack detection fails", async () => {
      resetPromptConfigCache();
      const ymlContent = [
        "stage_deliverable_develop: |",
        "  - **MUST** run the project build command and confirm it passes (command determined by project tech stack)",
      ].join("\n");
      // No package.json/pom.xml → tech stack detection returns null
      await writePluginYmlAndStack(ymlContent, "none");

      const items = await loadPluginDeliverables(TMP, "develop");
      // With no tech stack, the keyword item is preserved (graceful degradation)
      expect(items.length).toBe(1);
      expect(items[0].type).toBe("keyword");
      expect(items[0].target).toContain("build command");
    });

    it("double-source merge: verify.md contains both business and plugin items with dedup", async () => {
      resetPromptConfigCache();
      // Write yml with plugin deliverables for develop
      const ymlContent = [
        "stage_deliverable_develop: |",
        "  - **MUST** include `pipeline: {pipelineId}` in the artifact file header",
      ].join("\n");
      await writePluginYmlAndStack(ymlContent);

      // Write skill with business deliverables
      const skillContent = [
        "---",
        "title: develop",
        "---",
        "## 交付项",
        "- **必须** 创建开发总结文档 docs/design/develop_summary.md",
        "- **必须** 包含 `pipeline: {pipelineId}` 在产物头部",
      ].join("\n");
      const config = await setupConfigWithSkill("develop", skillContent);

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results.length).toBe(1);
      expect(results[0].status).toBe("generated");
      expect(results[0].pluginCount).toBeGreaterThan(0);

      // Read the generated verify.md and confirm it contains both business file + plugin keyword
      const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
      const verifyContent = await fs.readFile(verifyPath, "utf-8");
      // Business file item
      expect(verifyContent).toContain("docs/design/develop_summary.md");
      // Plugin keyword item (pipeline) - present due to merge
      expect(verifyContent).toContain("keywords:");
      expect(verifyContent).toContain("pipeline");
    });

    it("existing verify.md migration: diff-merge adds plugin rules to old verify", async () => {
      resetPromptConfigCache();
      // Write yml with plugin deliverable for develop
      const ymlContent = [
        "stage_deliverable_develop: |",
        "  - **MUST** include `pipeline: {pipelineId}` in the artifact file header",
      ].join("\n");
      await writePluginYmlAndStack(ymlContent);

      // Write skill with business items
      const skillContent = [
        "---",
        "title: develop",
        "---",
        "## 交付项",
        "- **必须** 创建开发总结 docs/design/dev.md",
      ].join("\n");
      const config = await setupConfigWithSkill("develop", skillContent);

      // Pre-create an old verify.md (without plugin keyword rules)
      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      const oldVerify = [
        "---",
        "rules:",
        "  requiredFiles:",
        '    - "docs/design/dev.md"',
        "  mode: or",
        "---",
        "Old verify body",
      ].join("\n");
      await fs.writeFile(path.join(verifyDir, "verify.md"), oldVerify, "utf-8");

      // Re-generate: should diff-merge plugin keyword rule into existing verify.md
      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results.length).toBe(1);
      expect(results[0].status).toBe("merged");
      expect(results[0].pluginCount).toBeGreaterThan(0);

      // Read merged content and confirm it has both old file rule + new plugin keyword
      const mergedContent = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");
      expect(mergedContent).toContain("docs/design/dev.md");
      expect(mergedContent).toContain("pipeline");
      expect(mergedContent).toContain("keywords:");
    });

    it("hasCustom protection: plugin rules do NOT override user-authored custom rules", async () => {
      resetPromptConfigCache();
      // Write yml with plugin deliverable for develop
      const ymlContent = [
        "stage_deliverable_develop: |",
        "  - **MUST** include `pipeline: {pipelineId}` in the artifact file header",
      ].join("\n");
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, "pipeline-stage-prompt.yml"), ymlContent, "utf-8");
      await fs.writeFile(path.join(TMP, "package.json"), "{}", "utf-8");
      await fs.writeFile(path.join(TMP, "bun.lock"), "", "utf-8");

      // Write skill with business items
      const skillContent = [
        "---",
        "title: develop",
        "---",
        "## 交付项",
        "- **必须** 创建开发总结 docs/design/dev.md",
      ].join("\n");
      const config = await setupConfigWithSkill("develop", skillContent);

      // Pre-create an old verify.md WITH user custom fileContentPattern
      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      const customVerify = [
        "---",
        "rules:",
        "  requiredFiles:",
        '    - "docs/design/dev.md"',
        "  fileContentPattern:",
        '    - path: "docs/design/dev.md"',
        '      pattern: "^# Summary"',
        "  mode: or",
        "---",
        "User-customized verify body",
      ].join("\n");
      await fs.writeFile(path.join(verifyDir, "verify.md"), customVerify, "utf-8");

      // Re-generate: hasCustom protection should skip merging plugin rules
      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results.length).toBe(1);
      expect(results[0].status).toBe("skipped");
      expect(results[0].reason).toBe("exists_custom");

      // Plugin rules should NOT be merged into user-customized verify.md
      const content = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");
      expect(content).toContain("fileContentPattern");
      expect(content).not.toContain("keywords:");
      expect(content).toContain("User-customized verify body");
    });
  });

  // ── Phase 1 (148): TEMPLATE_BUILTIN_CONTENT_PATTERNS white-list ──────────

  describe("Phase 1 (148): TEMPLATE_BUILTIN_CONTENT_PATTERNS white-list", () => {
    it("white-list contains all 7 expected template entries (6 + bilingual plan marker + relaxed review pattern)", () => {
      expect(TEMPLATE_BUILTIN_CONTENT_PATTERNS).toHaveLength(7);
      const paths = TEMPLATE_BUILTIN_CONTENT_PATTERNS.map(e => e.path);
      expect(paths).toContain("{requirementDoc}");
      expect(paths).toContain("docs/design/*_plan.md");
      expect(paths).toContain("docs/review/code_review_*.md");
      expect(paths).toContain("docs/design/*_commit.md");
    });

    it("hasCustom=false when existing rules contain only template plan doc pattern (develop)", () => {
      const existing = {
        keywords: [],
        mode: "or" as const,
        requiredFiles: ["docs/design/*_commit.md"],
        fileContentPattern: [
          { path: "docs/design/*_commit.md", pattern: "^\\*\\*plan doc\\*\\*:" },
        ],
      };
      const pluginItems = [
        { type: "command" as const, target: "bun run build" },
        { type: "command" as const, target: "bun test" },
        { type: "git" as const, target: "git commit" },
      ];
      const result = diffAndMergeRules(existing, pluginItems);
      expect(result.hasCustom).toBe(false);
      // Plugin items should still be merged
      expect(result.merged.length).toBeGreaterThan(0);
    });

    it("hasCustom=false when existing rules contain only template clarify lookahead pattern", () => {
      const existing = {
        keywords: [],
        mode: "or" as const,
        fileContentPattern: [
          { path: "{requirementDoc}", pattern: "full-und\\? 理解确认：是" },
          {
            path: "{requirementDoc}",
            pattern:
              "(?<![\\s\\S])(?![\\s\\S]*?^# 第 \\d+ 轮澄清(?![^]*?^- \\*{0,2}方案[ \\t]*[A-Z]))(?![\\s\\S]*?^# 第 \\d+ 轮澄清(?![^]*?^[ \\t]*答[:：]))",
          },
        ],
      };
      const result = diffAndMergeRules(existing, []);
      expect(result.hasCustom).toBe(false);
    });

    it("hasCustom=true when existing rules contain non-builtin fileContentPattern", () => {
      const existing = {
        keywords: [],
        mode: "or" as const,
        requiredFiles: ["docs/design/*_commit.md"],
        fileContentPattern: [
          { path: "docs/design/*_commit.md", pattern: "^\\*\\*plan doc\\*\\*:" },
          { path: "docs/design/*_commit.md", pattern: "^# Custom User Rule" },
        ],
      };
      const result = diffAndMergeRules(existing, []);
      expect(result.hasCustom).toBe(true);
    });

    it("hasCustom=true when existing fileContentPattern has same path but different pattern", () => {
      const existing = {
        keywords: [],
        mode: "or" as const,
        fileContentPattern: [
          { path: "docs/design/*_commit.md", pattern: "^\\*\\*custom doc\\*\\*:" },
        ],
      };
      const result = diffAndMergeRules(existing, []);
      expect(result.hasCustom).toBe(true);
    });

    // Phase 2 (162): bilingual plan marker pattern in whitelist
    it("hasCustom=false when existing rules contain only bilingual plan marker pattern", () => {
      const existing = {
        keywords: [],
        mode: "or" as const,
        requiredFiles: ["docs/design/*_plan.md"],
        fileContentPattern: [
          { path: "docs/design/*_plan.md", pattern: "^## (用户确认|User Confirmation)" },
        ],
      };
      const result = diffAndMergeRules(existing, []);
      expect(result.hasCustom).toBe(false);
    });

    it("hasCustom=false when existing rules contain legacy plan marker pattern (init 1 backward compat)", () => {
      const existing = {
        keywords: [],
        mode: "or" as const,
        requiredFiles: ["docs/design/*_plan.md"],
        fileContentPattern: [
          { path: "docs/design/*_plan.md", pattern: "^## 用户确认" },
        ],
      };
      const result = diffAndMergeRules(existing, []);
      expect(result.hasCustom).toBe(false);
    });

    // Phase 1 (163): relaxed review conclusion pattern in whitelist
    it("hasCustom=false when existing rules contain old review conclusion pattern (结论：通过)", () => {
      const existing = {
        keywords: [],
        mode: "or" as const,
        requiredFiles: ["docs/review/code_review_*.md"],
        fileContentPattern: [
          { path: "docs/review/code_review_*.md", pattern: "结论：通过" },
        ],
      };
      const result = diffAndMergeRules(existing, []);
      expect(result.hasCustom).toBe(false);
    });

    it("hasCustom=false when existing rules contain new review conclusion pattern (结论：(通过|不通过))", () => {
      const existing = {
        keywords: [],
        mode: "or" as const,
        requiredFiles: ["docs/review/code_review_*.md"],
        fileContentPattern: [
          { path: "docs/review/code_review_*.md", pattern: "结论：(通过|不通过)" },
        ],
      };
      const result = diffAndMergeRules(existing, []);
      expect(result.hasCustom).toBe(false);
    });

    it("init 1 merge regression: develop template with plan doc pattern still merges plugin defaults", async () => {
      resetPromptConfigCache();
      const ymlContent = [
        "stage_deliverable_develop: |",
        "  - **MUST** run the project build command and confirm it passes (command determined by project tech stack)",
        "  - **MUST** run the project unit test command and confirm it passes (command determined by project tech stack)",
      ].join("\n");
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, "pipeline-stage-prompt.yml"), ymlContent);
      await fs.writeFile(path.join(TMP, "package.json"), "{}", "utf-8");
      await fs.writeFile(path.join(TMP, "bun.lock"), "", "utf-8");

      // Skill with no business deliverables (develop has Template-TODO placeholder)
      const skillContent = [
        "---",
        "title: develop",
        "---",
        "## 交付项",
        "- Template-TODO: add business deliverables here",
      ].join("\n");

      // Pre-create verify.md with template plan doc pattern (simulating first init)
      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      const templateVerify = [
        "---",
        "rules:",
        "  requiredFiles:",
        '    - "docs/design/*_commit.md"',
        "  fileContentPattern:",
        '    - path: "docs/design/*_commit.md"',
        '      pattern: "^\\\\*\\\\*plan doc\\\\*\\\\*:"',
        "---",
        "Verify develop commit doc references plan doc.",
      ].join("\n");
      await fs.writeFile(path.join(verifyDir, "verify.md"), templateVerify, "utf-8");

      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

      const config = makeTestConfig({
        projectRoot: TMP,
        stages: Object.fromEntries(
          ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
            (s, i, a) => [
              s,
              {
                agentPath: "a.md",
                skillPath: `${s}/SKILL.md`,
                nextStage: a[i + 1] ?? null,
                requireDomain: false,
              },
            ],
          ),
        ) as any,
      });

      const results = await generateVerifyFiles(config, { stage: "develop" });
      expect(results.length).toBe(1);
      // Should NOT be "skipped" with "exists_custom" — white-list allows merge
      expect(results[0].status).not.toBe("skipped");
      // Should be "merged" with plugin items
      expect(results[0].status).toBe("merged");
      expect(results[0].pluginCount).toBeGreaterThan(0);
    });
  });
});
