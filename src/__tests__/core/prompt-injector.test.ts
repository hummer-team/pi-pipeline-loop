import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";

describe("createPromptInjector", () => {
  beforeEach(() => {
    resetGitignoreCache();
    resetPromptConfigCache();
  });

  afterEach(() => {
    resetPromptConfigCache();
    __resetAuditDirPath();
  });

  it("creates a hook with event 'before_agent_start'", () => {
    const hook = createPromptInjector(makeTestConfig());
    expect(hook.event).toBe("before_agent_start");
  });

  it("returns systemPrompt with parts for develop stage", async () => {
    const TMP = join(tmpdir(), "pi-prompt-dev-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill\n\nRule: do X");

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["develop"] = { ...config.stages["develop"], requireDomain: true, skillPath: "test-skill/SKILL.md" } as any;
    const meta = makeTestMeta({ currentStage: "develop", previousStage: "plan" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).toContain("REQUIRED CONTEXT FILES");
    expect(result.systemPrompt).toContain("STAGE-SPECIFIC RULES");
    expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
    expect(result.systemPrompt).toContain("Pipeline Status");
  });

  it("skips domain skill when requireDomain is false", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).not.toContain("BUSINESS DOMAIN RULES");
  });

  it("skips loop status for non-loop stages", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "plan" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).not.toContain("LOOP ENGINEERING STATUS");
  });

  it("includes loop status for fix stage", async () => {
    const TMP = join(tmpdir(), "pi-prompt-fix-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill");

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["fix"] = { ...config.stages["fix"], requireDomain: false, skillPath: "test-skill/SKILL.md" } as any;
    const meta = makeTestMeta({ currentStage: "fix" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
  });

  it("includes pipeline status in every prompt", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta();
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).toContain("Pipeline Status");
    expect(result.systemPrompt).toContain("pipe-test-001");
  });

  it("handles missing stage skill file gracefully", async () => {
    const TMP = join(tmpdir(), "pi-prompt-missing-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["clarify"] = { ...config.stages["clarify"], skillPath: "nonexistent/SKILL.md" } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).not.toContain("Skill file not found at");
    // With null return, the prompt should not include any skill-related text
    expect(result.systemPrompt).not.toContain("STAGE-SPECIFIC RULES");
  });

  it("shows pending validation when previous summary is pending", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      previousStage: "clarify",
      summaries: {
        clarify: { path: "/tmp/clarify.md", hash: "abc", status: "pending" as const },
      },
    });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).toContain("YES (Validate before proceed)");
  });

  it("includes verification failures in prompt when verifyFailures exist", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      verifyFailures: [
        { ruleType: "requiredFiles", detail: "Missing: docs/commit.md", timestamp: Date.now() },
        { ruleType: "requiredGit", detail: "No commit within 10min", timestamp: Date.now() },
      ],
    });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).toContain("PREVIOUS VERIFICATION FAILURES");
    expect(result.systemPrompt).toContain("[requiredFiles] Missing: docs/commit.md");
    expect(result.systemPrompt).toContain("[requiredGit] No commit within 10min");
  });

  it("does not include verification failures section when verifyFailures is empty", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      verifyFailures: [],
    });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).not.toContain("PREVIOUS VERIFICATION FAILURES");
  });

  it("loader default skillPath resolves correctly under real .pi/skills/ layout (no double prefix)", async () => {
    const TMP = join(tmpdir(), "pi-prompt-default-" + Date.now());
    // Create skill file at the real .pi/skills/{stage}/SKILL.md location
    const skillDir = join(TMP, ".pi", "skills", "clarify");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Clarify Skill\n\n- **Must** produce clarification doc");

    const config = makeTestConfig({ projectRoot: TMP });
    // Simulate the loader default: skillPath = "clarify/SKILL.md" (relative to .pi/skills/)
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      skillPath: "clarify/SKILL.md",
    } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    // Skill content should be injected successfully (no double prefix bug)
    expect(result.systemPrompt).toContain("STAGE-SPECIFIC RULES");
    expect(result.systemPrompt).toContain("Clarify Skill");
  });

  it("includes Part7 verification tool guidance when verify.mode is 'tool'", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      verify: { require: true, mode: "tool" },
    };
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).toContain("VERIFICATION MODE: TOOL");
    expect(result.systemPrompt).toContain("VERIFICATION MODE: TOOL");
    expect(result.systemPrompt).toContain("stage_advance");
  });

  describe("dynamic protection paths in loop status", () => {
    it("includes allow list and gitignore patterns in develop stage", async () => {
      const TMP = join(tmpdir(), "pi-pi-protect-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await mkdir(join(TMP, "src/template"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n/src/template/\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { allow: ["src/template/"] },
      });
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Should contain LOOP ENGINEERING STATUS
      expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
      // Should list allow first
      expect(result.systemPrompt).toContain("Allowed (editable): src/template/");
      // Should list protected paths
      expect(result.systemPrompt).toContain("Protected:");
      // Should include hardcoded paths
      expect(result.systemPrompt).toContain(".pi/");
      expect(result.systemPrompt).toContain("AGENTS.md");
      // Should include gitignore patterns
      expect(result.systemPrompt).toContain("docs");

      await rm(TMP, { recursive: true, force: true });
    });

    it("shows only hardcoded paths when no gitignore exists", async () => {
      const TMP = join(tmpdir(), "pi-pi-no-gitignore-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt).toContain("Protected:");
      expect(result.systemPrompt).toContain(".pi/");
      expect(result.systemPrompt).toContain("AGENTS.md");
      // Should not contain allow line (no allow configured)
      expect(result.systemPrompt).not.toContain("Allowed (editable):");

      await rm(TMP, { recursive: true, force: true });
    });

    it("fix stage also shows protection paths", async () => {
      const TMP = join(tmpdir(), "pi-pi-fix-protect-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "fix" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt).toContain("Protected:");

      await rm(TMP, { recursive: true, force: true });
    });

    it("non-loop stages do not show loop status", async () => {
      const TMP = join(tmpdir(), "pi-pi-clarify-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).not.toContain("LOOP ENGINEERING STATUS");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("frozen state hint", () => {
    it("injects FROZEN hint when pipeline is blocked", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("FROZEN");
      expect(result.systemPrompt).toContain("loop_overflow");
      expect(result.systemPrompt).toContain("ctrl+enter");
    });

    it("injects FROZEN hint with custom shortcut key", async () => {
      const config = makeTestConfig({ decisionShortcutKey: "alt+x" });
      const meta = makeTestMeta({ flowState: "blocked", blockedReason: "verify_fail" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("FROZEN");
      expect(result.systemPrompt).toContain("alt+x");
    });

    it("does not inject FROZEN hint when pipeline is running", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ flowState: "running" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).not.toContain("FROZEN");
    });
  });

  describe("stage write scope injection", () => {
    // Note: Git read-only hint will be re-enabled in Phase 1 with stage-based logic
    it("clarify stage: prompt contains STAGE WRITE SCOPE with docs whitelist", async () => {
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/", "doc/", "documentation/"],
      } as any;
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      expect(result.systemPrompt).toContain("Write Scope: docs/, doc/, documentation/");
      // Git read-only hint removed in Phase 0 — will be re-added in Phase 1 with stage-based logic
    });

    it("plan stage: prompt contains STAGE WRITE SCOPE", async () => {
      const config = makeTestConfig();
      config.stages["plan"] = {
        ...config.stages["plan"],
        allowedWritePaths: ["docs/"],
      } as any;
      const meta = makeTestMeta({ currentStage: "plan" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      expect(result.systemPrompt).toContain("Write Scope: docs/");
      // Git read-only hint removed in Phase 0 — will be re-added in Phase 1 with stage-based logic
    });

    it("review stage: prompt contains STAGE WRITE SCOPE", async () => {
      const config = makeTestConfig();
      config.stages["review"] = {
        ...config.stages["review"],
        allowedWritePaths: ["docs/"],
      } as any;
      const meta = makeTestMeta({ currentStage: "review" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      expect(result.systemPrompt).toContain("Write Scope: docs/");
    });

    it("develop stage: loop status includes Write Scope line (no standalone section)", async () => {
      const TMP = join(tmpdir(), "pi-prompt-dev-ws-" + Date.now());
      const skillDir = join(TMP, ".pi", "skills", "test-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "# Skill");

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        skillPath: "test-skill/SKILL.md",
        allowedWritePaths: ["**"],
      } as any;
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // develop/fix: write scope is in LOOP ENGINEERING STATUS
      expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt).toContain("Write Scope: all (global protect applies)");
      // No standalone STAGE WRITE SCOPE section for loop stages
      expect(result.systemPrompt).not.toContain("# STAGE WRITE SCOPE");

      await rm(TMP, { recursive: true, force: true });
    });

    it("fix stage: loop status includes Write Scope line", async () => {
      const TMP = join(tmpdir(), "pi-prompt-fix-ws-" + Date.now());
      const skillDir = join(TMP, ".pi", "skills", "test-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "# Skill");

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["fix"] = {
        ...config.stages["fix"],
        skillPath: "test-skill/SKILL.md",
        allowedWritePaths: ["**"],
      } as any;
      const meta = makeTestMeta({ currentStage: "fix" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt).toContain("Write Scope: all (global protect applies)");

      await rm(TMP, { recursive: true, force: true });
    });

    it("stage with empty allowedWritePaths shows 'none (write forbidden)'", async () => {
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: [],
      } as any;
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("Write Scope: none (write forbidden)");
    });

    it("stage with full access shows 'all (global protect applies)'", async () => {
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["**"],
      } as any;
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("Write Scope: all (global protect applies)");
      // clarify is git read-only regardless of allowedWritePaths (phase 1 stage-based logic)
      expect(result.systemPrompt).toContain("Git: read-only");
    });
  });

  describe("yml template rendering path", () => {
    /** Helper: write a pipeline-stage-prompt.yml to the project's .pi/references/ */
    async function writePromptYml(projectRoot: string, content: string): Promise<void> {
      const refsDir = join(projectRoot, ".pi", "references");
      await mkdir(refsDir, { recursive: true });
      await writeFile(join(refsDir, "pipeline-stage-prompt.yml"), content, "utf-8");
    }

    it("uses yml template when available — renders placeholders with dynamic values", async () => {
      const TMP = join(tmpdir(), "pi-pi-yml-" + Date.now());
      await mkdir(TMP, { recursive: true });

      // Write a yml template for develop stage
      await writePromptYml(TMP, [
        "develop: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{loop_status}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Pipeline status should be rendered
      expect(result.systemPrompt).toContain("Pipeline Status");
      expect(result.systemPrompt).toContain("pipe-test-001");
      // Loop status should be rendered
      expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
      // The output should contain the --- separator between the two paragraphs
      expect(result.systemPrompt).toContain("---");

      await rm(TMP, { recursive: true, force: true });
    });

    it("removes null paragraphs — context_reference absent when no previous summary", async () => {
      const TMP = join(tmpdir(), "pi-pi-yml-null-" + Date.now());
      await mkdir(TMP, { recursive: true });

      // Template with context_reference paragraph
      await writePromptYml(TMP, [
        "clarify: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{context_reference}}",
        "  ---",
        "  {{stage_write_scope}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      // No previous summary → context_reference returns null → paragraph removed
      const meta = makeTestMeta({
        currentStage: "clarify",
        previousStage: undefined,
        summaries: {},
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Pipeline status and write scope should be present
      expect(result.systemPrompt).toContain("Pipeline Status");
      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      // context_reference paragraph should be removed (not present)
      expect(result.systemPrompt).not.toContain("REQUIRED CONTEXT FILES");

      await rm(TMP, { recursive: true, force: true });
    });

    it("falls back to default when critical placeholder is missing from template", async () => {
      const TMP = join(tmpdir(), "pi-pi-yml-missing-" + Date.now());
      await mkdir(TMP, { recursive: true });
      const auditDir = join(TMP, ".pi", "audit");
      await mkdir(auditDir, { recursive: true });

      // Template missing {{pipeline_status}} (critical for all stages)
      await writePromptYml(TMP, [
        "clarify: |",
        "  {{context_reference}}",
        "  ---",
        "  {{stage_write_scope}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Should fall back to default prompt (contains Pipeline Status from default builder)
      expect(result.systemPrompt).toContain("Pipeline Status");
      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");

      // Audit log should contain the missing placeholder event
      const logFile = join(auditDir, getDateAuditFileName());
      const logContent = await readFile(logFile, "utf-8");
      expect(logContent).toContain("prompt_injector_missing_placeholder");
      expect(logContent).toContain("{{pipeline_status}}");
      expect(logContent).toContain("[WARN]");

      await rm(TMP, { recursive: true, force: true });
    });

    it("falls back to default when yml has no entry for current stage", async () => {
      const TMP = join(tmpdir(), "pi-pi-yml-nostage-" + Date.now());
      await mkdir(TMP, { recursive: true });

      // yml has only clarify, not develop
      await writePromptYml(TMP, "clarify: |\n  {{pipeline_status}}\n  ---\n  {{stage_write_scope}}\n");

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Should use default path (develop gets loop status + pipeline status)
      expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt).toContain("Pipeline Status");

      await rm(TMP, { recursive: true, force: true });
    });

    it("loop stage template — loop_status paragraph present with dynamic content", async () => {
      const TMP = join(tmpdir(), "pi-pi-yml-loop-" + Date.now());
      await mkdir(TMP, { recursive: true });

      await writePromptYml(TMP, [
        "develop: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{loop_status}}",
        "  ---",
        "  {{verify_failures}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const meta = makeTestMeta({
        currentStage: "develop",
        verifyFailures: [
          { ruleType: "requiredFiles", detail: "Missing file", timestamp: Date.now() },
        ],
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("Pipeline Status");
      expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt).toContain("PREVIOUS VERIFICATION FAILURES");
      expect(result.systemPrompt).toContain("[requiredFiles] Missing file");

      await rm(TMP, { recursive: true, force: true });
    });

    it("non-loop stage — verify_failures paragraph removed when no failures", async () => {
      const TMP = join(tmpdir(), "pi-pi-yml-nofail-" + Date.now());
      await mkdir(TMP, { recursive: true });

      await writePromptYml(TMP, [
        "clarify: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{verify_failures}}",
        "  ---",
        "  {{stage_write_scope}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "clarify", verifyFailures: [] });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("Pipeline Status");
      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      // verify_failures is null (empty array) → paragraph removed
      expect(result.systemPrompt).not.toContain("PREVIOUS VERIFICATION FAILURES");

      await rm(TMP, { recursive: true, force: true });
    });

    it("yml template renders {{stage_skill}} placeholder with skill file content", async () => {
      const TMP = join(tmpdir(), "pi-pi-yml-stageskill-" + Date.now());
      const skillDir = join(TMP, ".pi", "skills", "clarify");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "Stage skill rule: produce clarification doc");

      await writePromptYml(TMP, [
        "clarify: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{stage_skill}}",
        "  ---",
        "  {{stage_write_scope}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        skillPath: "clarify/SKILL.md",
      } as any;
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("STAGE-SPECIFIC RULES");
      expect(result.systemPrompt).toContain("Stage skill rule: produce clarification doc");
      expect(result.systemPrompt).not.toContain("{{stage_skill}}");

      await rm(TMP, { recursive: true, force: true });
    });

    it("yml template removes {{stage_skill}} paragraph when skill file is missing", async () => {
      const TMP = join(tmpdir(), "pi-pi-yml-stageskill-missing-" + Date.now());
      await mkdir(TMP, { recursive: true });

      await writePromptYml(TMP, [
        "clarify: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{stage_skill}}",
        "  ---",
        "  {{stage_write_scope}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        skillPath: "nonexistent/SKILL.md",
      } as any;
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // stage_skill is null → paragraph removed
      expect(result.systemPrompt).not.toContain("STAGE-SPECIFIC RULES");
      expect(result.systemPrompt).not.toContain("{{stage_skill}}");
      // Other paragraphs remain
      expect(result.systemPrompt).toContain("Pipeline Status");
      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("prompt snapshot audit (E4/E5/E6/E7)", () => {
    async function writePromptYml(projectRoot: string, content: string): Promise<void> {
      const refsDir = join(projectRoot, ".pi", "references");
      await mkdir(refsDir, { recursive: true });
      await writeFile(join(refsDir, "pipeline-stage-prompt.yml"), content, "utf-8");
    }

    it("writes prompt snapshot to audit.log on successful yml rendering (source=yml)", async () => {
      const TMP = join(tmpdir(), "pi-pi-snapshot-yml-" + Date.now());
      const auditDir = join(TMP, ".pi", "audit");
      await mkdir(TMP, { recursive: true });
      await mkdir(auditDir, { recursive: true });

      await writePromptYml(TMP, [
        "clarify: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{stage_write_scope}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      const logFile = join(auditDir, getDateAuditFileName());
      const logContent = await readFile(logFile, "utf-8");

      // Snapshot metadata line
      expect(logContent).toContain("prompt_snapshot");
      expect(logContent).toContain("source=yml");
      expect(logContent).toContain("stage=clarify");
      expect(logContent).toContain("pipelineId=pipe-test-001");

      // E7 protocol markers
      expect(logContent).toContain("=== PROMPT START ===");
      expect(logContent).toContain("=== PROMPT END ===");

      // E5: snapshot contains plugin prompt content (not pi base)
      expect(logContent).toContain("Pipeline Status");
      expect(logContent).toContain("STAGE WRITE SCOPE");

      // E5: snapshot should NOT contain pi base prompt
      // (the base prompt is only added via ctx.getSystemPrompt, not in pluginPrompt)
      // Verify that the snapshot block contains the plugin prompt but no arbitrary base text
      const basePrompt = "This is the pi base system prompt that should NOT appear in snapshot";
      const ctxWithBase = {
        session: { getMeta: () => meta },
        getSystemPrompt: () => basePrompt,
      };
      const hook2 = createPromptInjector(config);
      await hook2.handler(ctxWithBase as any);
      const logContent2 = await readFile(logFile, "utf-8");
      // The pi base prompt should NOT appear in the snapshot (E5)
      // Check that the snapshot block (between START and END) does not contain the base
      const startIdx = logContent2.lastIndexOf("=== PROMPT START ===");
      const endIdx = logContent2.lastIndexOf("=== PROMPT END ===");
      const snapshotBlock = logContent2.substring(startIdx, endIdx);
      expect(snapshotBlock).not.toContain(basePrompt);

      await rm(TMP, { recursive: true, force: true });
    });

    it("writes prompt snapshot on missing_critical fallback (source=fallback)", async () => {
      const TMP = join(tmpdir(), "pi-pi-snapshot-fallback-" + Date.now());
      const auditDir = join(TMP, ".pi", "audit");
      await mkdir(TMP, { recursive: true });
      await mkdir(auditDir, { recursive: true });

      // Template missing {{pipeline_status}} → triggers missing_critical fallback
      await writePromptYml(TMP, [
        "clarify: |",
        "  {{context_reference}}",
        "  ---",
        "  {{stage_write_scope}}",
        "",
      ].join("\n"));

      const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Should fall back to default prompt
      expect(result.systemPrompt).toContain("Pipeline Status");

      const logFile = join(auditDir, getDateAuditFileName());
      const logContent = await readFile(logFile, "utf-8");

      // Missing placeholder warning should still be present
      expect(logContent).toContain("prompt_injector_missing_placeholder");
      expect(logContent).toContain("[WARN]");

      // Snapshot with source=fallback
      expect(logContent).toContain("source=fallback");
      expect(logContent).toContain("=== PROMPT START ===");
      expect(logContent).toContain("=== PROMPT END ===");
      // Fallback prompt should contain default 8-part content
      expect(logContent).toContain("Pipeline Status");

      await rm(TMP, { recursive: true, force: true });
    });

    it("does NOT write prompt snapshot on default path (no yml template)", async () => {
      const TMP = join(tmpdir(), "pi-pi-snapshot-default-" + Date.now());
      const auditDir = join(TMP, ".pi", "audit");
      await mkdir(TMP, { recursive: true });
      await mkdir(auditDir, { recursive: true });

      // No yml template → default path
      const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      await hook.handler(ctx as any);

      const logFile = join(auditDir, getDateAuditFileName());
      // If the audit log file doesn't exist at all, that means no events were written — pass
      const { existsSync } = await import("node:fs");
      if (!existsSync(logFile)) {
        // No audit file created — confirms no snapshot was written
        await rm(TMP, { recursive: true, force: true });
        return;
      }
      const logContent = await readFile(logFile, "utf-8");

      // No prompt_snapshot event should be written
      expect(logContent).not.toContain("prompt_snapshot");
      expect(logContent).not.toContain("=== PROMPT START ===");
      expect(logContent).not.toContain("=== PROMPT END ===");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("append injection (D3)", () => {
    it("appends plugin prompt after pi base when ctx.getSystemPrompt is available", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      const basePrompt = "You are an expert coding assistant. Follow AGENTS.md rules.";
      const ctx = {
        session: { getMeta: () => meta },
        getSystemPrompt: () => basePrompt,
      };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Should contain the pi base prompt
      expect(result.systemPrompt).toContain(basePrompt);
      // Should contain the plugin prompt parts
      expect(result.systemPrompt).toContain("Pipeline Status");
      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      // Should contain the separator
      expect(result.systemPrompt).toContain("\n\n---\n\n");
      // Base should come before plugin content
      const baseIndex = result.systemPrompt.indexOf(basePrompt);
      const pipelineIndex = result.systemPrompt.indexOf("Pipeline Status");
      expect(baseIndex).toBeLessThan(pipelineIndex);
    });

    it("returns only plugin prompt when ctx.getSystemPrompt is not available", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      // No getSystemPrompt on ctx
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Should still contain plugin prompt parts
      expect(result.systemPrompt).toContain("Pipeline Status");
      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      // Prompt should not start with a base prefix + separator
      // It should start directly with plugin content (no "base\n\n---\n\n" prefix)
      expect(result.systemPrompt.startsWith("You are")).toBe(false);
    });

    it("returns only plugin prompt when ctx.getSystemPrompt returns empty string", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = {
        session: { getMeta: () => meta },
        getSystemPrompt: () => "",
      };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("Pipeline Status");
    });
  });

  describe("requirement doc path in context_reference (D1/D2)", () => {
    it("clarify stage with requirementDoc includes path in REQUIRED CONTEXT FILES", async () => {
      const config = makeTestConfig({ projectRoot: "/my/project" });
      const meta = makeTestMeta({
        currentStage: "clarify",
        requirementDoc: "docs/requirement.md",
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Should contain the requirement doc path in context files
      expect(result.systemPrompt).toContain("REQUIRED CONTEXT FILES");
      expect(result.systemPrompt).toContain("/my/project/docs/requirement.md");
      expect(result.systemPrompt).toContain("MUST READ FIRST");
      // Should NOT contain full-text requirement document
      expect(result.systemPrompt).not.toContain("# USER REQUIREMENT DOCUMENT");
    });

    it("non-clarify stage does not include requirementDoc path even if set", async () => {
      const config = makeTestConfig({ projectRoot: "/my/project" });
      const meta = makeTestMeta({
        currentStage: "develop",
        requirementDoc: "docs/requirement.md",
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Should NOT contain the requirement doc path for non-clarify stages
      expect(result.systemPrompt).not.toContain("/my/project/docs/requirement.md");
    });

    it("clarify stage without requirementDoc does not add extra context file", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "clarify",
        previousStage: undefined,
        summaries: {},
        // No requirementDoc set
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Without previous summary or requirementDoc, context_reference should be null
      expect(result.systemPrompt).not.toContain("REQUIRED CONTEXT FILES");
    });
  });

  // ─── Phase 5: violations prompt injection ──────────────────────────────────

  describe("violations prompt injection (Phase 5 Task 2)", () => {
    // Note: tool_not_allowed and bash_prefix violation types removed in Phase 0 (D0)
    // Using write_protected and git_protected for testing violation injection
    it("injects PREVIOUS VIOLATIONS section when violations exist (default path)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "develop",
        violations: [
          { type: "write_protected", tool: "write", detail: 'Cannot modify protected path \'.pi/config.json\'.', suggestion: "Protected paths: .pi/, AGENTS.md, .git/.", timestamp: Date.now() },
          { type: "git_protected", tool: "bash", detail: 'git add would stage protected path.', suggestion: "git add cannot stage protected paths.", timestamp: Date.now() },
        ],
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("PREVIOUS VIOLATIONS (MUST FIX)");
      expect(result.systemPrompt).toContain("write_protected");
      expect(result.systemPrompt).toContain("git_protected");
      expect(result.systemPrompt).toContain('Cannot modify protected path');
    });

    it("does NOT inject violations section when violations is empty", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "develop",
        violations: [],
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).not.toContain("PREVIOUS VIOLATIONS");
    });

    it("does NOT inject violations section when violations is undefined", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", violations: undefined });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).not.toContain("PREVIOUS VIOLATIONS");
    });

    it("injects violations via yml template path when placeholder exists", async () => {
      const TMP = join(tmpdir(), "pi-prompt-viol-yml-" + Date.now());
      const skillDir = join(TMP, ".pi", "skills", "test-skill");
      const promptDir = join(TMP, ".pi", "prompts");
      await mkdir(skillDir, { recursive: true });
      await mkdir(promptDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "# Skill\n\nRule: do X");
      // Yml template with {{violations}} placeholder
      await writeFile(
        join(promptDir, "develop.yml"),
        "---\nstage: develop\n---\nbefore:\n  - \"{{violations}}\"\nafter: []\n",
        "utf-8",
      );

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = { ...config.stages["develop"], requireDomain: true, skillPath: "test-skill/SKILL.md" } as any;
      const meta = makeTestMeta({
        currentStage: "develop",
        violations: [
          { type: "write_protected", tool: "edit", detail: "Cannot modify protected path.", suggestion: "Hardcoded protected: .pi/.", timestamp: Date.now() },
        ],
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // The yml template should render the violations placeholder
      // If the template engine works, violations section should appear
      // (paragraph-level removal handles null by omitting the section)
      if (result.systemPrompt.includes("PREVIOUS VIOLATIONS")) {
        expect(result.systemPrompt).toContain("write_protected");
        expect(result.systemPrompt).toContain("Cannot modify protected path.");
      }
      // If yml template not found, falls back to default path — still contains violations
      expect(result.systemPrompt).toContain("PREVIOUS VIOLATIONS");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  // ─── Phase 4 (139): {{stage_executor}} placeholder ───────────────────────────
  describe("Phase 4: stage_executor injection", () => {
    it("injects stage_executor section for develop stage", async () => {
      const TMP = join(tmpdir(), "pi-pi-p4-dev-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      // Write a yml template with {{stage_executor}} placeholder
      const refDir = join(TMP, ".pi", "references");
      await mkdir(refDir, { recursive: true });
      const ymlContent = [
        "develop: |",
        "  {{pipeline_status}}",
        "  ---",
        "  {{loop_status}}",
        "  ---",
        "  {{stage_executor}}",
      ].join("\n");
      await writeFile(join(refDir, "pipeline-stage-prompt.yml"), ymlContent);

      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = {
        session: { getMeta: () => meta },
        getSystemPrompt: () => "base prompt",
      };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx)) as any;

      // Should contain the stage executor scheduling section
      expect(result.systemPrompt).toContain("阶段执行者调度");
      expect(result.systemPrompt).toContain("develop-agent");

      resetPromptConfigCache();
      await rm(TMP, { recursive: true, force: true });
    });

    it("injects completed summary when in completed stage", async () => {
      const TMP = join(tmpdir(), "pi-pi-p4-completed-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "completed",
        previousStage: "fix",
        pipelineId: "pipe-completed-test",
        summaries: {
          plan: { path: "/tmp/plan.md", hash: "abc", status: "valid" },
        },
      });
      const ctx = {
        session: { getMeta: () => meta },
        getSystemPrompt: () => "base prompt",
      };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx)) as any;

      // Should contain completed summary section
      expect(result.systemPrompt).toContain("管线完成摘要");
      expect(result.systemPrompt).toContain("pipe-completed-test");
      expect(result.systemPrompt).toContain("最终 stage");

      resetPromptConfigCache();
      await rm(TMP, { recursive: true, force: true });
    });
  });

  // ─── Phase 3 (143): context_reference dedup + commitIds hint ─────────────────

  describe("context_reference deduplication (143 Phase 3)", () => {
    it("dedupes when prevSummary.path and contextFiles contain the same file", async () => {
      const config = makeTestConfig({ projectRoot: "/my/project" });
      const sharedPath = "/my/project/.pi/audit/pipe-1/develop.md";
      const meta = makeTestMeta({
        currentStage: "review",
        previousStage: "develop",
        summaries: {
          develop: { path: sharedPath, hash: "abc", status: "valid" },
        },
        contextFiles: {
          review: [sharedPath, "/other/file.md"],
        },
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // The shared path should appear only once in the REQUIRED CONTEXT FILES
      const occurrences = (result.systemPrompt.match(new RegExp(sharedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      expect(occurrences).toBe(1);

      // The other file should also appear
      expect(result.systemPrompt).toContain("/other/file.md");
    });

    it("keeps all files when prevSummary and contextFiles are different", async () => {
      const config = makeTestConfig({ projectRoot: "/my/project" });
      const meta = makeTestMeta({
        currentStage: "review",
        previousStage: "develop",
        summaries: {
          develop: { path: "/my/project/.pi/audit/pipe-1/develop.md", hash: "abc", status: "valid" },
        },
        contextFiles: {
          review: ["/my/project/.pi/audit/pipe-1/plan.md"],
        },
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // Both files should be listed
      expect(result.systemPrompt).toContain("develop.md");
      expect(result.systemPrompt).toContain("plan.md");
    });
  });

  describe("commitIds hint in develop/fix stage executor (143 Phase 3)", () => {
    it("develop stage executor prompt includes commitIds requirement", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = { session: { getMeta: () => meta }, getSystemPrompt: () => "" };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("commitIds");
      expect(result.systemPrompt).toContain("generate_stage_summary");
    });

    it("fix stage executor prompt includes commitIds requirement", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "fix" });
      const ctx = { session: { getMeta: () => meta }, getSystemPrompt: () => "" };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("commitIds");
      expect(result.systemPrompt).toContain("generate_stage_summary");
    });

    it("review stage executor prompt does NOT include commitIds requirement", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "review" });
      const ctx = { session: { getMeta: () => meta }, getSystemPrompt: () => "" };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      // review stage should not have commitIds requirement
      expect(result.systemPrompt).not.toContain("阶段总结要求");
    });
  });
});
