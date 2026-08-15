import { describe, it, expect, beforeEach } from "bun:test";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";

describe("createPromptInjector", () => {
  beforeEach(() => {
    resetGitignoreCache();
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
    expect(result.systemPrompt).toContain("本阶段验证模式为 TOOL");
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
      expect(result.systemPrompt).toContain("ctrl+d");
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
    it("clarify stage: prompt contains STAGE WRITE SCOPE with docs whitelist", async () => {
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/", "doc/", "documentation/"],
        allowedBashPrefixes: ["ls", "cat", "find", "git log", "git status", "git diff", "git show"],
      } as any;
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      expect(result.systemPrompt).toContain("Write Scope: docs/, doc/, documentation/");
      expect(result.systemPrompt).toContain("Git: read-only (add/commit/push forbidden)");
    });

    it("plan stage: prompt contains STAGE WRITE SCOPE with git read-only hint", async () => {
      const config = makeTestConfig();
      config.stages["plan"] = {
        ...config.stages["plan"],
        allowedWritePaths: ["docs/"],
        allowedBashPrefixes: ["ls", "cat"],
      } as any;
      const meta = makeTestMeta({ currentStage: "plan" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("STAGE WRITE SCOPE");
      expect(result.systemPrompt).toContain("Write Scope: docs/");
      expect(result.systemPrompt).toContain("Git: read-only");
    });

    it("review stage: prompt contains STAGE WRITE SCOPE", async () => {
      const config = makeTestConfig();
      config.stages["review"] = {
        ...config.stages["review"],
        allowedWritePaths: ["docs/"],
        allowedBashPrefixes: ["ls", "git log"],
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
        allowedBashPrefixes: ["git"], // has git → no read-only hint
      } as any;
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = await hook.handler(ctx as any);

      expect(result.systemPrompt).toContain("Write Scope: all (global protect applies)");
      expect(result.systemPrompt).not.toContain("Git: read-only");
    });
  });
});
