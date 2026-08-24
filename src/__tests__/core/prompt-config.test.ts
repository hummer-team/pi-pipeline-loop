import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import {
  loadPromptConfig,
  getStagePrompt,
  getVerifyPrompt,
  getVerifyExtractPrompt,
  resetPromptConfigCache,
  CRITICAL_PLACEHOLDERS,
  renderStageTemplate,
} from "../../core/prompt-config";
import { DEFAULT_VERIFY_EXTRACT_PROMPT } from "../../constants";

let TMP: string;

beforeEach(async () => {
  resetPromptConfigCache();
  TMP = path.join(tmpdir(), "pi-prompt-cfg-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  resetPromptConfigCache();
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Helper: write a pipeline-stage-prompt.yml file in the expected location */
async function writeYml(content: string): Promise<void> {
  const refsDir = path.join(TMP, ".pi", "references");
  await fs.mkdir(refsDir, { recursive: true });
  await fs.writeFile(path.join(refsDir, "pipeline-stage-prompt.yml"), content, "utf-8");
}

describe("prompt-config", () => {
  // ─── loadPromptConfig ────────────────────────────────────────────────────────

  describe("loadPromptConfig", () => {
    it("loads and parses a valid yml file", async () => {
      await writeYml("clarify: hello\nplan: world\n");
      const config = await loadPromptConfig(TMP);
      expect(config.clarify).toBe("hello");
      expect(config.plan).toBe("world");
    });

    it("returns empty object when file does not exist", async () => {
      const config = await loadPromptConfig(TMP);
      expect(config).toEqual({});
    });

    it("returns empty object on YAML parse failure", async () => {
      // Write malformed YAML with conflicting types for same key
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      // Use invalid YAML that causes a parse error (duplicate keys with different types)
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        "key: &anchor\n  nested: true\nkey: *anchor\nbroken: [unterminated",
        "utf-8",
      );
      const config = await loadPromptConfig(TMP);
      expect(config).toEqual({});
    });

    it("discards non-string values", async () => {
      await writeYml("clarify: hello\nnumber_key: 42\nbool_key: true\nlist_key:\n  - item\n");
      const config = await loadPromptConfig(TMP);
      expect(config.clarify).toBe("hello");
      expect(config["number_key"]).toBeUndefined();
      expect(config["bool_key"]).toBeUndefined();
      expect(config["list_key"]).toBeUndefined();
    });

    it("caches result for same projectRoot", async () => {
      await writeYml("clarify: first\n");
      const config1 = await loadPromptConfig(TMP);
      expect(config1.clarify).toBe("first");

      // Overwrite file — cache should still return first value
      await writeYml("clarify: second\n");
      const config2 = await loadPromptConfig(TMP);
      expect(config2.clarify).toBe("first");
    });

    it("reloads after resetPromptConfigCache", async () => {
      await writeYml("clarify: first\n");
      await loadPromptConfig(TMP);

      await writeYml("clarify: second\n");
      resetPromptConfigCache();
      const config = await loadPromptConfig(TMP);
      expect(config.clarify).toBe("second");
    });

    it("reloads when projectRoot changes", async () => {
      await writeYml("clarify: root1\n");
      const config1 = await loadPromptConfig(TMP);
      expect(config1.clarify).toBe("root1");

      // Create a second project root with different yml
      const TMP2 = path.join(tmpdir(), "pi-prompt-cfg2-" + Date.now());
      await fs.mkdir(path.join(TMP2, ".pi", "references"), { recursive: true });
      await fs.writeFile(
        path.join(TMP2, ".pi", "references", "pipeline-stage-prompt.yml"),
        "clarify: root2\n",
        "utf-8",
      );

      const config2 = await loadPromptConfig(TMP2);
      expect(config2.clarify).toBe("root2");

      await fs.rm(TMP2, { recursive: true, force: true });
    });
  });

  // ─── getStagePrompt ──────────────────────────────────────────────────────────

  describe("getStagePrompt", () => {
    it("returns the stage template when key exists with non-empty value", async () => {
      await writeYml("clarify: This is the clarify template\n");
      const result = await getStagePrompt(TMP, "clarify");
      expect(result).toBe("This is the clarify template");
    });

    it("returns null when stage key is missing", async () => {
      await writeYml("clarify: hello\n");
      const result = await getStagePrompt(TMP, "develop");
      expect(result).toBeNull();
    });

    it("returns null when stage value is empty string", async () => {
      await writeYml('clarify: ""\n');
      const result = await getStagePrompt(TMP, "clarify");
      expect(result).toBeNull();
    });

    it("returns null when stage value is whitespace only", async () => {
      await writeYml('clarify: "   "\n');
      const result = await getStagePrompt(TMP, "clarify");
      expect(result).toBeNull();
    });

    it("returns null when yml file does not exist", async () => {
      const result = await getStagePrompt(TMP, "clarify");
      expect(result).toBeNull();
    });
  });

  // ─── getVerifyExtractPrompt ──────────────────────────────────────────────────

  describe("getVerifyExtractPrompt", () => {
    it("returns custom value when verify_extract has content", async () => {
      await writeYml("verify_extract: Custom extraction prompt\n");
      const result = await getVerifyExtractPrompt(TMP);
      expect(result).toBe("Custom extraction prompt");
    });

    it("returns DEFAULT when verify_extract key is missing", async () => {
      await writeYml("clarify: hello\n");
      const result = await getVerifyExtractPrompt(TMP);
      expect(result).toBe(DEFAULT_VERIFY_EXTRACT_PROMPT);
    });

    it("returns DEFAULT when verify_extract is empty", async () => {
      await writeYml('verify_extract: ""\n');
      const result = await getVerifyExtractPrompt(TMP);
      expect(result).toBe(DEFAULT_VERIFY_EXTRACT_PROMPT);
    });

    it("returns DEFAULT when yml file does not exist", async () => {
      const result = await getVerifyExtractPrompt(TMP);
      expect(result).toBe(DEFAULT_VERIFY_EXTRACT_PROMPT);
    });

    // ── Per-stage fallback chain tests ──

    it("returns per-stage value when verify_extract_{stage} has content", async () => {
      await writeYml("verify_extract_clarify: Per-stage clarify extract\nverify_extract: Global extract\n");
      const result = await getVerifyExtractPrompt(TMP, "clarify");
      expect(result).toBe("Per-stage clarify extract");
    });

    it("falls back to global verify_extract when per-stage is missing", async () => {
      await writeYml("verify_extract: Global extract\n");
      const result = await getVerifyExtractPrompt(TMP, "develop");
      expect(result).toBe("Global extract");
    });

    it("falls back to global verify_extract when per-stage is empty", async () => {
      await writeYml('verify_extract_develop: ""\nverify_extract: Global extract\n');
      const result = await getVerifyExtractPrompt(TMP, "develop");
      expect(result).toBe("Global extract");
    });

    it("falls back to DEFAULT when both per-stage and global are missing", async () => {
      await writeYml("clarify: hello\n");
      const result = await getVerifyExtractPrompt(TMP, "fix");
      expect(result).toBe(DEFAULT_VERIFY_EXTRACT_PROMPT);
    });

    it("falls back to DEFAULT when both per-stage and global are empty", async () => {
      await writeYml('verify_extract_clarify: "   "\nverify_extract: ""\n');
      const result = await getVerifyExtractPrompt(TMP, "clarify");
      expect(result).toBe(DEFAULT_VERIFY_EXTRACT_PROMPT);
    });

    it("without stage parameter uses global verify_extract directly", async () => {
      await writeYml("verify_extract: Global only\nverify_extract_clarify: Per-stage should be ignored\n");
      const result = await getVerifyExtractPrompt(TMP);
      expect(result).toBe("Global only");
    });
  });

  // ─── getVerifyPrompt ──────────────────────────────────────────────────────────

  describe("getVerifyPrompt", () => {
    it("returns per-stage verify prompt when key exists with content", async () => {
      await writeYml("verify_clarify: Custom verify prompt for clarify\n");
      const result = await getVerifyPrompt(TMP, "clarify");
      expect(result).toBe("Custom verify prompt for clarify");
    });

    it("returns null when verify_{stage} key is missing", async () => {
      await writeYml("clarify: hello\n");
      const result = await getVerifyPrompt(TMP, "develop");
      expect(result).toBeNull();
    });

    it("returns null when verify_{stage} value is empty string", async () => {
      await writeYml('verify_develop: ""\n');
      const result = await getVerifyPrompt(TMP, "develop");
      expect(result).toBeNull();
    });

    it("returns null when verify_{stage} value is whitespace only", async () => {
      await writeYml('verify_review: "   "\n');
      const result = await getVerifyPrompt(TMP, "review");
      expect(result).toBeNull();
    });

    it("returns null when yml file does not exist", async () => {
      const result = await getVerifyPrompt(TMP, "clarify");
      expect(result).toBeNull();
    });

    it("returns correct value for each stage key", async () => {
      await writeYml(
        "verify_clarify: Clarify verify\n" +
        "verify_plan: Plan verify\n" +
        "verify_develop: Develop verify\n" +
        "verify_review: Review verify\n" +
        "verify_fix: Fix verify\n"
      );
      expect(await getVerifyPrompt(TMP, "clarify")).toBe("Clarify verify");
      expect(await getVerifyPrompt(TMP, "plan")).toBe("Plan verify");
      expect(await getVerifyPrompt(TMP, "develop")).toBe("Develop verify");
      expect(await getVerifyPrompt(TMP, "review")).toBe("Review verify");
      expect(await getVerifyPrompt(TMP, "fix")).toBe("Fix verify");
    });
  });

  // ─── CRITICAL_PLACEHOLDERS ───────────────────────────────────────────────────

  describe("CRITICAL_PLACEHOLDERS", () => {
    it("always includes {{pipeline_status}}", () => {
      expect(CRITICAL_PLACEHOLDERS("clarify")).toContain("{{pipeline_status}}");
      expect(CRITICAL_PLACEHOLDERS("develop")).toContain("{{pipeline_status}}");
    });

    it("includes {{loop_status}} for develop stage", () => {
      const critical = CRITICAL_PLACEHOLDERS("develop");
      expect(critical).toContain("{{loop_status}}");
      expect(critical).not.toContain("{{stage_write_scope}}");
    });

    it("includes {{loop_status}} for fix stage", () => {
      const critical = CRITICAL_PLACEHOLDERS("fix");
      expect(critical).toContain("{{loop_status}}");
      expect(critical).not.toContain("{{stage_write_scope}}");
    });

    it("includes {{stage_write_scope}} for clarify stage", () => {
      const critical = CRITICAL_PLACEHOLDERS("clarify");
      expect(critical).toContain("{{stage_write_scope}}");
      expect(critical).not.toContain("{{loop_status}}");
    });

    it("includes {{stage_write_scope}} for plan stage", () => {
      const critical = CRITICAL_PLACEHOLDERS("plan");
      expect(critical).toContain("{{stage_write_scope}}");
    });

    it("includes {{stage_write_scope}} for review stage", () => {
      const critical = CRITICAL_PLACEHOLDERS("review");
      expect(critical).toContain("{{stage_write_scope}}");
    });

    it("returns correct number of critical placeholders per stage (Phase 4: +stage_executor for execution stages)", () => {
      expect(CRITICAL_PLACEHOLDERS("clarify")).toHaveLength(2); // pipeline_status + stage_write_scope
      expect(CRITICAL_PLACEHOLDERS("plan")).toHaveLength(3);    // pipeline_status + stage_write_scope + stage_executor
      expect(CRITICAL_PLACEHOLDERS("develop")).toHaveLength(3); // pipeline_status + loop_status + stage_executor
      expect(CRITICAL_PLACEHOLDERS("review")).toHaveLength(3);  // pipeline_status + stage_write_scope + stage_executor
      expect(CRITICAL_PLACEHOLDERS("fix")).toHaveLength(3);     // pipeline_status + loop_status + stage_executor
    });
  });

  // ─── renderStageTemplate ─────────────────────────────────────────────────────

  describe("renderStageTemplate", () => {
    it("replaces placeholders with values", () => {
      const template = "{{pipeline_status}}\n---\n{{context_reference}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline Status\n- ID: 123",
        context_reference: "# Context\n- file.md",
        stage_write_scope: "# Write Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("# Pipeline Status");
        expect(result.prompt).toContain("- ID: 123");
        expect(result.prompt).toContain("# Context");
        expect(result.prompt).toContain("# Write Scope");
        expect(result.prompt).toContain("---");
      }
    });

    it("removes paragraphs with null placeholder values", () => {
      const template = "{{pipeline_status}}\n---\n{{context_reference}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        context_reference: null,
        stage_write_scope: "# Write Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("# Pipeline");
        expect(result.prompt).toContain("# Write Scope");
        // context_reference paragraph should be removed entirely
        expect(result.prompt).not.toContain("{{context_reference}}");
      }
    });

    it("removes paragraphs with empty string placeholder values", () => {
      const template = "{{pipeline_status}}\n---\n{{context_reference}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        context_reference: "",
        stage_write_scope: "# Write Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // context_reference paragraph removed, only pipeline_status and stage_write_scope remain
        expect(result.prompt).toContain("# Pipeline");
        expect(result.prompt).toContain("# Write Scope");
        expect(result.prompt).not.toContain("{{context_reference}}");
      }
    });

    it("preserves unknown placeholders as-is", () => {
      const template = "{{pipeline_status}}\n---\n{{unknown_placeholder}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        stage_write_scope: "# Write Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("{{unknown_placeholder}}");
      }
    });

    it("returns missing_critical when {{pipeline_status}} is absent", () => {
      const template = "{{context_reference}}\n---\n{{domain_skill}}";
      const values: Record<string, string | null> = {
        context_reference: "# Context",
        domain_skill: "# Domain",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("missing_critical");
      if (result.status === "missing_critical") {
        expect(result.missing).toContain("{{pipeline_status}}");
      }
    });

    it("detects missing {{stage_write_scope}} for non-loop stages", () => {
      const template = "{{pipeline_status}}\n---\n{{context_reference}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        context_reference: "# Context",
      };
      const result = renderStageTemplate(template, "plan", values);
      expect(result.status).toBe("missing_critical");
      if (result.status === "missing_critical") {
        expect(result.missing).toContain("{{stage_write_scope}}");
      }
    });

    it("detects missing {{loop_status}} for loop stages", () => {
      const template = "{{pipeline_status}}\n---\n{{context_reference}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        context_reference: "# Context",
      };
      const result = renderStageTemplate(template, "develop", values);
      expect(result.status).toBe("missing_critical");
      if (result.status === "missing_critical") {
        expect(result.missing).toContain("{{loop_status}}");
      }
    });

    it("does not require {{stage_write_scope}} for develop stage (Phase 4: but requires {{stage_executor}})", () => {
      const template = "{{pipeline_status}}\n---\n{{loop_status}}\n---\n{{stage_executor}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        loop_status: "# Loop",
        stage_executor: "# Executor",
      };
      const result = renderStageTemplate(template, "develop", values);
      expect(result.status).toBe("ok");
    });

    it("does not require {{loop_status}} for clarify stage", () => {
      const template = "{{pipeline_status}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        stage_write_scope: "# Write Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
    });

    it("filters empty segments and trims output", () => {
      const template = "{{pipeline_status}}\n---\n{{context_reference}}\n---\n{{stage_write_scope}}\n---\n  \n";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        context_reference: null,
        stage_write_scope: "# Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("# Pipeline");
        expect(result.prompt).toContain("# Scope");
        // context_reference paragraph removed, empty trailing segment filtered
        expect(result.prompt).not.toContain("{{context_reference}}");
      }
    });

    it("handles multi-placeholder paragraph — null removes entire paragraph", () => {
      const template = "{{pipeline_status}}\n---\n{{context_reference}} and {{domain_skill}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        context_reference: null,
        domain_skill: "# Domain",
        stage_write_scope: "# Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("# Pipeline");
        expect(result.prompt).toContain("# Scope");
        // Entire second paragraph removed because context_reference is null
        expect(result.prompt).not.toContain("# Domain");
      }
    });

    it("undefined values leave placeholder in place (not null, not empty)", () => {
      const template = "{{pipeline_status}}\n---\n{{context_reference}}\n---\n{{stage_write_scope}}";
      // context_reference is not in values → undefined → not null, not empty
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        stage_write_scope: "# Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("{{context_reference}}");
      }
    });

    it("splits on separator lines with trailing whitespace (robustness)", () => {
      // Fix #1: /^---\s*$/m must tolerate trailing spaces/tabs on --- lines
      const template = "{{pipeline_status}}\n---  \n{{context_reference}}\n---\t\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        context_reference: "# Context",
        stage_write_scope: "# Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("# Pipeline");
        expect(result.prompt).toContain("# Context");
        expect(result.prompt).toContain("# Scope");
      }
    });

    it("returns missing_critical when critical placeholder is in a removed paragraph", () => {
      // Fix #3: {{pipeline_status}} co-locates with {{domain_skill}} (null),
      // paragraph gets removed, critical placeholder silently lost
      const template = "{{pipeline_status}} and {{domain_skill}}\n---\n{{context_reference}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        domain_skill: null, // triggers paragraph removal
        context_reference: "# Context",
        stage_write_scope: "# Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("missing_critical");
      if (result.status === "missing_critical") {
        expect(result.missing).toContain("{{pipeline_status}}");
      }
    });

    it("returns missing_critical when loop_status paragraph is removed", () => {
      // Fix #3 for loop stages: {{loop_status}} removed with null co-tenant
      // Phase 4: {{stage_executor}} also required for develop stage
      const template = "{{loop_status}} and {{domain_skill}}\n---\n{{pipeline_status}}\n---\n{{stage_executor}}";
      const values: Record<string, string | null> = {
        loop_status: "# Loop",
        domain_skill: null, // triggers paragraph removal
        pipeline_status: "# Pipeline",
        stage_executor: "# Executor",
      };
      const result = renderStageTemplate(template, "develop", values);
      expect(result.status).toBe("missing_critical");
      if (result.status === "missing_critical") {
        expect(result.missing).toContain("{{loop_status}}");
      }
    });

    it("replaces {{stage_skill}} placeholder with its value", () => {
      const template = "{{pipeline_status}}\n---\n{{stage_skill}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        stage_skill: "# STAGE-SPECIFIC RULES\nSkill content here",
        stage_write_scope: "# Write Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("# STAGE-SPECIFIC RULES");
        expect(result.prompt).toContain("Skill content here");
        expect(result.prompt).not.toContain("{{stage_skill}}");
      }
    });

    it("removes paragraph when {{stage_skill}} value is null", () => {
      const template = "{{pipeline_status}}\n---\n{{stage_skill}}\n---\n{{stage_write_scope}}";
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        stage_skill: null, // triggers paragraph removal
        stage_write_scope: "# Write Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("# Pipeline");
        expect(result.prompt).toContain("# Write Scope");
        // stage_skill paragraph should be removed entirely
        expect(result.prompt).not.toContain("{{stage_skill}}");
        expect(result.prompt).not.toContain("STAGE-SPECIFIC RULES");
      }
    });

    it("preserves unknown placeholders as-is (stage_skill not in values → undefined)", () => {
      const template = "{{pipeline_status}}\n---\n{{stage_skill}}\n---\n{{stage_write_scope}}";
      // stage_skill is not provided in values → undefined → not null, not empty → placeholder preserved
      const values: Record<string, string | null> = {
        pipeline_status: "# Pipeline",
        stage_write_scope: "# Scope",
      };
      const result = renderStageTemplate(template, "clarify", values);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.prompt).toContain("{{stage_skill}}");
      }
    });
  });

  // ─── Template file structure validation ──────────────────────────────────────

  describe("pipeline-stage-prompt.yml template file", () => {
    const TEMPLATE_PATH = path.join(
      __dirname, "..", "..", "template", "references", "pipeline-stage-prompt.yml",
    );

    it("can be parsed as valid YAML with expected structure", () => {
      if (!fsSync.existsSync(TEMPLATE_PATH)) {
        // Template file not yet created (pre-Phase 1) — skip
        return;
      }
      const content = fsSync.readFileSync(TEMPLATE_PATH, "utf-8");
      const parsed = yamlParse(content) as Record<string, unknown>;

      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();

      // All 20 keys: 5 stage + 5 verify_{stage} + 5 verify_extract_{stage} + 4 stage_executor_{stage} + 1 global verify_extract
      const expectedKeys = [
        "clarify", "plan", "develop", "review", "fix",
        "verify_clarify", "verify_plan", "verify_develop", "verify_review", "verify_fix",
        "verify_extract_clarify", "verify_extract_plan", "verify_extract_develop",
        "verify_extract_review", "verify_extract_fix",
        "stage_executor_plan", "stage_executor_develop", "stage_executor_review", "stage_executor_fix",
        "verify_extract",
      ];
      for (const key of expectedKeys) {
        expect(parsed[key]).toBeDefined();
        expect(typeof parsed[key]).toBe("string");
        expect((parsed[key] as string).trim().length).toBeGreaterThan(0);
      }
      // Ensure total key count matches plan (20 keys: Phase 4/139 added 4 stage_executor_{stage} keys)
      expect(Object.keys(parsed).length).toBe(20);
    });

    it("clarify template contains all 7 non-loop placeholders (no requirement_doc)", () => {
      if (!fsSync.existsSync(TEMPLATE_PATH)) return;
      const content = fsSync.readFileSync(TEMPLATE_PATH, "utf-8");
      const parsed = yamlParse(content) as Record<string, string>;

      const clarify = parsed["clarify"];
      expect(clarify).not.toContain("{{requirement_doc}}");
      expect(clarify).toContain("{{context_reference}}");
      expect(clarify).toContain("{{domain_skill}}");
      expect(clarify).toContain("{{stage_skill}}");
      expect(clarify).toContain("{{pipeline_status}}");
      expect(clarify).toContain("{{verify_failures}}");
      expect(clarify).toContain("{{verify_tool_guidance}}");
      expect(clarify).toContain("{{stage_write_scope}}");
      // clarify should NOT contain loop_status
      expect(clarify).not.toContain("{{loop_status}}");
    });

    it("develop template contains loop_status and stage_skill but not stage_write_scope", () => {
      if (!fsSync.existsSync(TEMPLATE_PATH)) return;
      const content = fsSync.readFileSync(TEMPLATE_PATH, "utf-8");
      const parsed = yamlParse(content) as Record<string, string>;

      const develop = parsed["develop"];
      expect(develop).toContain("{{loop_status}}");
      expect(develop).toContain("{{pipeline_status}}");
      expect(develop).toContain("{{stage_skill}}");
      expect(develop).not.toContain("{{stage_write_scope}}");
      expect(develop).not.toContain("{{requirement_doc}}");
    });

    it("all 5 stage keys contain {{stage_skill}} placeholder", () => {
      if (!fsSync.existsSync(TEMPLATE_PATH)) return;
      const content = fsSync.readFileSync(TEMPLATE_PATH, "utf-8");
      const parsed = yamlParse(content) as Record<string, string>;

      for (const stage of ["clarify", "plan", "develop", "review", "fix"]) {
        expect(parsed[stage]).toContain("{{stage_skill}}");
      }
    });

    it("{{stage_skill}} appears after {{domain_skill}} in all stage templates", () => {
      if (!fsSync.existsSync(TEMPLATE_PATH)) return;
      const content = fsSync.readFileSync(TEMPLATE_PATH, "utf-8");
      const parsed = yamlParse(content) as Record<string, string>;

      for (const stage of ["clarify", "plan", "develop", "review", "fix"]) {
        const template = parsed[stage];
        const domainIdx = template.indexOf("{{domain_skill}}");
        const stageSkillIdx = template.indexOf("{{stage_skill}}");
        expect(domainIdx).toBeGreaterThan(-1);
        expect(stageSkillIdx).toBeGreaterThan(-1);
        expect(stageSkillIdx).toBeGreaterThan(domainIdx);
      }
    });

    it("verify_extract template matches DEFAULT_VERIFY_EXTRACT_PROMPT content", () => {
      if (!fsSync.existsSync(TEMPLATE_PATH)) return;
      const content = fsSync.readFileSync(TEMPLATE_PATH, "utf-8");
      const parsed = yamlParse(content) as Record<string, string>;

      const verifyExtract = parsed["verify_extract"].trim();
      // The template content should contain the same key phrases as the default
      expect(verifyExtract).toContain("delivery item extractor");
      expect(verifyExtract).toContain("JSON array");
    });
  });
});
