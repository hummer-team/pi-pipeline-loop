import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta, writePromptYml } from "../helpers";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";

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
    const meta = makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      summaries: {
        plan: { path: "/tmp/plan-summary.md", hash: "abc123", status: "valid" as const },
      },
    });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("REQUIRED CONTEXT FILES");
    expect(result.systemPrompt!).toContain("STAGE-SPECIFIC RULES");
    expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
    expect(result.systemPrompt!).toContain("Pipeline Status");
  });

  it("skips domain skill when requireDomain is false", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).not.toContain("BUSINESS DOMAIN RULES");
  });

  it("skips loop status for non-loop stages", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "plan" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).not.toContain("LOOP ENGINEERING STATUS");
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
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
  });

  it("includes pipeline status in every prompt", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta();
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).toContain("pipe-test-001");
  });

  it("handles missing stage skill file gracefully", async () => {
    const TMP = join(tmpdir(), "pi-prompt-missing-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["clarify"] = { ...config.stages["clarify"], skillPath: "nonexistent/SKILL.md" } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).not.toContain("Skill file not found at");
    // With null return, the prompt should not include any skill-related text
    expect(result.systemPrompt!).not.toContain("STAGE-SPECIFIC RULES");
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
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("YES (Validate before proceed)");
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
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("PREVIOUS VERIFICATION FAILURES");
    expect(result.systemPrompt!).toContain("[requiredFiles] Missing: docs/commit.md");
    expect(result.systemPrompt!).toContain("[requiredGit] No commit within 10min");
  });

  it("does not include verification failures section when verifyFailures is empty", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      verifyFailures: [],
    });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).not.toContain("PREVIOUS VERIFICATION FAILURES");
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
    const result = (await hook.handler(ctx as any))!;

    // Skill content should be injected successfully (no double prefix bug)
    expect(result.systemPrompt!).toContain("STAGE-SPECIFIC RULES");
    expect(result.systemPrompt!).toContain("Clarify Skill");
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
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("VERIFICATION MODE: TOOL");
    expect(result.systemPrompt!).toContain("VERIFICATION MODE: TOOL");
    expect(result.systemPrompt!).toContain("stage_advance");
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
      const result = (await hook.handler(ctx as any))!;

      // Should contain LOOP ENGINEERING STATUS
      expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
      // Should list allow first
      expect(result.systemPrompt!).toContain("Allowed (editable): src/template/");
      // Should list protected paths
      expect(result.systemPrompt!).toContain("Protected:");
      // Should include hardcoded paths
      expect(result.systemPrompt!).toContain(".pi/");
      expect(result.systemPrompt!).not.toContain("AGENTS.md");
      // Should include gitignore patterns
      expect(result.systemPrompt!).toContain("docs");

      await rm(TMP, { recursive: true, force: true });
    });

    it("shows only hardcoded paths when no gitignore exists", async () => {
      const TMP = join(tmpdir(), "pi-pi-no-gitignore-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt!).toContain("Protected:");
      expect(result.systemPrompt!).toContain(".pi/");
      expect(result.systemPrompt!).not.toContain("AGENTS.md");
      // Should not contain allow line (no allow configured)
      expect(result.systemPrompt!).not.toContain("Allowed (editable):");

      await rm(TMP, { recursive: true, force: true });
    });

    it("fix stage also shows protection paths", async () => {
      const TMP = join(tmpdir(), "pi-pi-fix-protect-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "fix" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt!).toContain("Protected:");

      await rm(TMP, { recursive: true, force: true });
    });

    it("non-loop stages do not show loop status", async () => {
      const TMP = join(tmpdir(), "pi-pi-clarify-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).not.toContain("LOOP ENGINEERING STATUS");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("frozen state hint", () => {
    it("injects FROZEN hint when pipeline is blocked (with reason, no shortcut)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("FROZEN");
      expect(result.systemPrompt!).toContain("loop_overflow");
      expect(result.systemPrompt!).toContain("decision menu");
      // Should NOT contain shortcut key
      expect(result.systemPrompt!).not.toContain("ctrl+enter");
    });

    it("injects FROZEN hint with blockedReason, no shortcut key", async () => {
      const config = makeTestConfig({ decisionShortcutKey: "alt+x" });
      const meta = makeTestMeta({ flowState: "blocked", blockedReason: "verify_fail" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("FROZEN");
      expect(result.systemPrompt!).toContain("verify_fail");
      // Should NOT contain shortcut key
      expect(result.systemPrompt!).not.toContain("alt+x");
    });

    it("does not inject FROZEN hint when pipeline is running", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ flowState: "running" });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).not.toContain("FROZEN");
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
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");
      expect(result.systemPrompt!).toContain("Write Scope: docs/, doc/, documentation/");
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
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");
      expect(result.systemPrompt!).toContain("Write Scope: docs/");
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
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");
      expect(result.systemPrompt!).toContain("Write Scope: docs/");
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
      const result = (await hook.handler(ctx as any))!;

      // develop/fix: write scope is in LOOP ENGINEERING STATUS
      expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt!).toContain("Write Scope: all (global protect applies)");
      // No standalone STAGE WRITE SCOPE section for loop stages
      expect(result.systemPrompt!).not.toContain("# STAGE WRITE SCOPE");

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
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
      expect(result.systemPrompt!).toContain("Write Scope: all (global protect applies)");

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
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("Write Scope: none (write forbidden)");
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
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("Write Scope: all (global protect applies)");
      // clarify is git read-only regardless of allowedWritePaths (phase 1 stage-based logic)
      expect(result.systemPrompt!).toContain("Git: read-only");
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
      const result = (await hook.handler(ctx as any))!;

      // Should contain the pi base prompt
      expect(result.systemPrompt!).toContain(basePrompt);
      // Should contain the plugin prompt parts
      expect(result.systemPrompt!).toContain("Pipeline Status");
      expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");
      // Should contain the separator
      expect(result.systemPrompt!).toContain("\n\n---\n\n");
      // Base should come before plugin content
      const baseIndex = result.systemPrompt!.indexOf(basePrompt);
      const pipelineIndex = result.systemPrompt!.indexOf("Pipeline Status");
      expect(baseIndex).toBeLessThan(pipelineIndex);
    });

    it("returns only plugin prompt when ctx.getSystemPrompt is not available", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      // No getSystemPrompt on ctx
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      // Should still contain plugin prompt parts
      expect(result.systemPrompt!).toContain("Pipeline Status");
      expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");
      // Prompt should not start with a base prefix + separator
      // It should start directly with plugin content (no "base\n\n---\n\n" prefix)
      expect(result.systemPrompt!.startsWith("You are")).toBe(false);
    });

    it("returns only plugin prompt when ctx.getSystemPrompt returns empty string", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = {
        session: { getMeta: () => meta },
        getSystemPrompt: () => "",
      };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("Pipeline Status");
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
      const result = (await hook.handler(ctx as any))!;

      // Should contain the requirement doc path in context files
      expect(result.systemPrompt!).toContain("REQUIRED CONTEXT FILES");
      expect(result.systemPrompt!).toContain("/my/project/docs/requirement.md");
      expect(result.systemPrompt!).toContain("MUST READ FIRST");
      // Should NOT contain full-text requirement document
      expect(result.systemPrompt!).not.toContain("# USER REQUIREMENT DOCUMENT");
    });

    it("non-clarify stage does not include requirementDoc path even if set", async () => {
      const config = makeTestConfig({ projectRoot: "/my/project" });
      const meta = makeTestMeta({
        currentStage: "develop",
        requirementDoc: "docs/requirement.md",
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      // Should NOT contain the requirement doc path for non-clarify stages
      expect(result.systemPrompt!).not.toContain("/my/project/docs/requirement.md");
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
      const result = (await hook.handler(ctx as any))!;

      // Without previous summary or requirementDoc, context_reference should be null
      expect(result.systemPrompt!).not.toContain("REQUIRED CONTEXT FILES");
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
      const result = (await hook.handler(ctx as any))!;

      // The shared path should appear only once in the REQUIRED CONTEXT FILES
      const occurrences = (result.systemPrompt!.match(new RegExp(sharedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      expect(occurrences).toBe(1);

      // The other file should also appear
      expect(result.systemPrompt!).toContain("/other/file.md");
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
      const result = (await hook.handler(ctx as any))!;

      // Both files should be listed
      expect(result.systemPrompt!).toContain("develop.md");
      expect(result.systemPrompt!).toContain("plan.md");
    });
  });

  // ─── Bug 3.1: pending summary path inclusion ─────────────────────
  describe("pending summary path inclusion (Bug 3.1)", () => {
    it("pending summary path is included in context_reference", async () => {
      const config = makeTestConfig({ projectRoot: "/my/project" });
      const devPath = "/my/project/.pi/audit/pipe-1/develop.md";
      const meta = makeTestMeta({
        currentStage: "review",
        previousStage: "develop",
        summaries: {
          develop: { path: devPath, hash: "abc", status: "pending" },
        },
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      // Pending summary path should be included (Bug 3.1 fix)
      expect(result.systemPrompt!).toContain("REQUIRED CONTEXT FILES");
      expect(result.systemPrompt!).toContain(devPath);
    });

    it("invalid summary path is excluded from context_reference", async () => {
      const config = makeTestConfig({ projectRoot: "/my/project" });
      const devPath = "/my/project/.pi/audit/pipe-1/develop.md";
      const meta = makeTestMeta({
        currentStage: "review",
        previousStage: "develop",
        summaries: {
          develop: { path: devPath, hash: "abc", status: "invalid" },
        },
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      // Invalid summary path should NOT be included
      expect(result.systemPrompt!).not.toContain("REQUIRED CONTEXT FILES");
    });

    it("valid summary path still included (regression)", async () => {
      const config = makeTestConfig({ projectRoot: "/my/project" });
      const planPath = "/my/project/.pi/audit/pipe-1/plan.md";
      const meta = makeTestMeta({
        currentStage: "develop",
        previousStage: "plan",
        summaries: {
          plan: { path: planPath, hash: "xyz", status: "valid" },
        },
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("REQUIRED CONTEXT FILES");
      expect(result.systemPrompt!).toContain(planPath);
    });
  });

  describe("commitIds hint in develop/fix stage executor (143 Phase 3)", () => {
    it("develop stage executor prompt includes commitIds requirement", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = { session: { getMeta: () => meta }, getSystemPrompt: () => "" };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("commitIds");
      expect(result.systemPrompt!).toContain("generate_stage_summary");
    });

    it("fix stage executor prompt includes commitIds requirement", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "fix" });
      const ctx = { session: { getMeta: () => meta }, getSystemPrompt: () => "" };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      expect(result.systemPrompt!).toContain("commitIds");
      expect(result.systemPrompt!).toContain("generate_stage_summary");
    });

    it("review stage executor prompt does NOT include commitIds requirement", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "review" });
      const ctx = { session: { getMeta: () => meta }, getSystemPrompt: () => "" };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      // review stage should not have commitIds requirement
      expect(result.systemPrompt!).not.toContain("commitIds");
    });
  });

});

describe("Phase 5 (162): smart confirm guidance injection", () => {
  beforeEach(() => {
    resetGitignoreCache();
    resetPromptConfigCache();
  });

  afterEach(() => {
    resetPromptConfigCache();
    __resetAuditDirPath();
  });

  it("plan stage with confirm.mode='smart' includes SMART CONFIRM PROTOCOL", async () => {
    const TMP = join(tmpdir(), "pi-prompt-smart-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Plan Skill\n");
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const baseConfig = makeTestConfig({ projectRoot: TMP });
    const planStage = { ...baseConfig.stages.plan, confirm: { mode: "smart" as const } };
    const config = { ...baseConfig, stages: { ...baseConfig.stages, plan: planStage as typeof baseConfig.stages.plan } };
    const meta = makeTestMeta({ currentStage: "plan" });

    const hook = createPromptInjector(config);
    const result = (await hook.handler({
      session: { getMeta: () => meta, updateMeta: () => meta },
      ui: { notify: () => {}, setStatus: () => {} },
      getSystemPrompt: () => "base prompt",
    } as any))!;

    expect(result.systemPrompt!).toContain("SMART CONFIRM PROTOCOL");
    expect(result.systemPrompt!).toContain("needConfirm: true");
    expect(result.systemPrompt!).toContain("智能确认：复杂");

    await rm(TMP, { recursive: true, force: true });
  });

  it("plan stage with confirm.mode='auto' does NOT include smart confirm guidance", async () => {
    const TMP = join(tmpdir(), "pi-prompt-auto-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Plan Skill\n");
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "plan" });

    const hook = createPromptInjector(config);
    const result = (await hook.handler({
      session: { getMeta: () => meta, updateMeta: () => meta },
      ui: { notify: () => {}, setStatus: () => {} },
      getSystemPrompt: () => "base prompt",
    } as any))!;

    expect(result.systemPrompt!).not.toContain("SMART CONFIRM PROTOCOL");

    await rm(TMP, { recursive: true, force: true });
  });

  it("develop stage never includes smart confirm guidance (even with smart config)", async () => {
    const TMP = join(tmpdir(), "pi-prompt-develop-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Develop Skill\n");
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));

    const baseConfig = makeTestConfig({ projectRoot: TMP });
    const devStage = { ...baseConfig.stages.develop, confirm: { mode: "smart" as const } };
    const config = { ...baseConfig, stages: { ...baseConfig.stages, develop: devStage as typeof baseConfig.stages.develop } };
    const meta = makeTestMeta({ currentStage: "develop" });

    const hook = createPromptInjector(config);
    const result = (await hook.handler({
      session: { getMeta: () => meta, updateMeta: () => meta },
      ui: { notify: () => {}, setStatus: () => {} },
      getSystemPrompt: () => "base prompt",
    } as any))!;

    expect(result.systemPrompt!).not.toContain("SMART CONFIRM PROTOCOL");

    await rm(TMP, { recursive: true, force: true });
  });
});
// ─── Phase 0: Idempotent stage-skill injection ──────────────────────────────

describe("Phase 0: idempotent stage-skill injection", () => {
  beforeEach(() => {
    resetGitignoreCache();
    resetPromptConfigCache();
  });

  afterEach(() => {
    resetPromptConfigCache();
    __resetAuditDirPath();
  });

  it("removes {{stage_skill}} paragraph when base contains '# Preloaded Skill: {skillName}' marker", async () => {
    const TMP = join(tmpdir(), "pi-pi-idem-marker-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "design");
    await mkdir(skillDir, { recursive: true });
    const skillContent = "# Design Skill\n\nThis is the design skill content for clarify stage.";
    await writeFile(join(skillDir, "SKILL.md"), skillContent);

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
      skillPath: "design/SKILL.md",
    } as any;
    await initAuditLog(config);

    // Base contains the preload marker for "design" skill
    const base = "You are an assistant.\n\n# Preloaded Skill: design\n\n" + skillContent;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => base,
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    // stage_skill paragraph should be removed (idempotent hit)
    expect(result.systemPrompt!).not.toContain("STAGE-SPECIFIC RULES");
    expect(result.systemPrompt!).not.toContain("{{stage_skill}}");
    // Other paragraphs should remain
    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");

    await rm(TMP, { recursive: true, force: true });
  });

  it("removes {{stage_skill}} paragraph when base contains fingerprint (>=200 chars, no marker)", async () => {
    const TMP = join(tmpdir(), "pi-pi-idem-fingerprint-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "design");
    await mkdir(skillDir, { recursive: true });
    // Create a long skill content (>=200 chars after trim)
    const skillContent = "# Design Skill\n\n" + "A".repeat(250) + "\n\nEnd of skill.";
    await writeFile(join(skillDir, "SKILL.md"), skillContent);

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
      skillPath: "design/SKILL.md",
    } as any;
    await initAuditLog(config);

    // Base contains the skill content directly (no marker, but fingerprint match)
    const base = "You are an assistant.\n\n" + skillContent;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => base,
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    // stage_skill paragraph should be removed (fingerprint hit)
    expect(result.systemPrompt!).not.toContain("STAGE-SPECIFIC RULES (CLARIFY)");
    expect(result.systemPrompt!).not.toContain("{{stage_skill}}");
    // Pipeline status should still be present
    expect(result.systemPrompt!).toContain("Pipeline Status");

    await rm(TMP, { recursive: true, force: true });
  });

  it("injects full skill content when base has no marker and no fingerprint (zero regression)", async () => {
    const TMP = join(tmpdir(), "pi-pi-idem-nomatch-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "design");
    await mkdir(skillDir, { recursive: true });
    const skillContent = "# Design Skill\n\nShort content.";
    await writeFile(join(skillDir, "SKILL.md"), skillContent);

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
      skillPath: "design/SKILL.md",
    } as any;
    await initAuditLog(config);

    // Base does NOT contain skill content
    const base = "You are an assistant with no skill preloaded.";
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => base,
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    // stage_skill should be injected (no idempotent hit)
    expect(result.systemPrompt!).toContain("STAGE-SPECIFIC RULES (CLARIFY)");
    expect(result.systemPrompt!).toContain("Design Skill");
    expect(result.systemPrompt!).toContain("Short content.");

    await rm(TMP, { recursive: true, force: true });
  });

  it("does not false-match when base contains different stage skill (plan vs clarify)", async () => {
    const TMP = join(tmpdir(), "pi-pi-idem-nofalse-" + Date.now());
    const clarifySkillDir = join(TMP, ".pi", "skills", "design");
    await mkdir(clarifySkillDir, { recursive: true });
    const clarifySkillContent = "# Clarify Skill\n\nUnique clarify content XYZ123 for testing.";
    await writeFile(join(clarifySkillDir, "SKILL.md"), clarifySkillContent);

    // Also create a plan skill with different content
    const planSkillDir = join(TMP, ".pi", "skills", "plan");
    await mkdir(planSkillDir, { recursive: true });
    const planSkillContent = "# Plan Skill\n\n" + "B".repeat(300) + "\n\nPlan specific content.";
    await writeFile(join(planSkillDir, "SKILL.md"), planSkillContent);

    await writePromptYml(TMP, [
      "clarify: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_skill}}",
      "",
    ].join("\n"));

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      skillPath: "design/SKILL.md", // clarify uses design skill
    } as any;
    await initAuditLog(config);

    // Base contains PLAN skill content (not clarify/design skill)
    const base = "Assistant base.\n\n# Preloaded Skill: plan\n\n" + planSkillContent;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => base,
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    // stage_skill should be injected (no match — plan skill != design skill)
    expect(result.systemPrompt!).toContain("STAGE-SPECIFIC RULES (CLARIFY)");
    expect(result.systemPrompt!).toContain("Clarify Skill");

    await rm(TMP, { recursive: true, force: true });
  });

  it("preserves base system prompt when idempotent hit occurs (preload not lost)", async () => {
    const TMP = join(tmpdir(), "pi-pi-idem-basepreserve-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "design");
    await mkdir(skillDir, { recursive: true });
    const skillContent = "# Design Skill\n\nSkill content here.";
    await writeFile(join(skillDir, "SKILL.md"), skillContent);

    await writePromptYml(TMP, [
      "clarify: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_skill}}",
      "",
    ].join("\n"));

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      skillPath: "design/SKILL.md",
    } as any;
    await initAuditLog(config);

    const base = "UNIQUE BASE PROMPT PREFIX FOR TESTING\n\n# Preloaded Skill: design\n\n" + skillContent;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => base,
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    // Base should be preserved at the start
    expect(result.systemPrompt!.startsWith("UNIQUE BASE PROMPT PREFIX FOR TESTING")).toBe(true);
    // Separator between base and plugin prompt
    expect(result.systemPrompt!).toContain("\n\n---\n\n");
    // Plugin prompt should still contain pipeline status
    expect(result.systemPrompt!).toContain("Pipeline Status");

    await rm(TMP, { recursive: true, force: true });
  });
});
// ─── Phase 1: Empty content guard ───────────────────────────────────────────

describe("Phase 1: empty content guard", () => {
  beforeEach(() => {
    resetGitignoreCache();
    resetPromptConfigCache();
  });

  afterEach(() => {
    resetPromptConfigCache();
    __resetAuditDirPath();
  });

  it("stage skill with whitespace-only content returns null (no STAGE-SPECIFIC RULES paragraph)", async () => {
    const TMP = join(tmpdir(), "pi-pi-empty-stageskill-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "empty-skill");
    await mkdir(skillDir, { recursive: true });
    // Write whitespace-only content
    await writeFile(join(skillDir, "SKILL.md"), "   \n\n  \t  \n");

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      skillPath: "empty-skill/SKILL.md",
    } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    // No STAGE-SPECIFIC RULES paragraph when skill content is whitespace-only
    expect(result.systemPrompt!).not.toContain("STAGE-SPECIFIC RULES");

    await rm(TMP, { recursive: true, force: true });
  });

  it("stage skill with empty content returns null", async () => {
    const TMP = join(tmpdir(), "pi-pi-empty-stageskill-empty-" + Date.now());
    const skillDir = join(TMP, ".pi", "skills", "truly-empty");
    await mkdir(skillDir, { recursive: true });
    // Write truly empty content
    await writeFile(join(skillDir, "SKILL.md"), "");

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["clarify"] = {
      ...config.stages["clarify"],
      skillPath: "truly-empty/SKILL.md",
    } as any;
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    // No STAGE-SPECIFIC RULES paragraph when skill content is empty
    expect(result.systemPrompt!).not.toContain("STAGE-SPECIFIC RULES");

    await rm(TMP, { recursive: true, force: true });
  });

  it("domain file with whitespace-only content returns null (no BUSINESS DOMAIN RULES paragraph)", async () => {
    // Plan Phase 1 acceptance (a): domain file pure whitespace → no BUSINESS DOMAIN RULES paragraph.
    // buildDomainSkill reads from ~/.pi/domains/{domain.id}.md, so we create a unique domain file
    // in the real home directory and clean it up after the test.
    const uniqueDomainId = `test-empty-domain-${Date.now()}`;
    const domainDir = join(homedir(), ".pi", "domains");
    const domainFile = join(domainDir, `${uniqueDomainId}.md`);
    await mkdir(domainDir, { recursive: true });
    // Write whitespace-only content (spaces, tabs, newlines)
    await writeFile(domainFile, "   \n\n  \t  \n");

    try {
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        requireDomain: true,
      } as any;
      const meta = makeTestMeta({
        currentStage: "clarify",
        domain: { id: uniqueDomainId, version: "v1", skillPath: "" },
      });
      const ctx = { session: { getMeta: () => meta } };

      const hook = createPromptInjector(config);
      const result = (await hook.handler(ctx as any))!;

      // No BUSINESS DOMAIN RULES paragraph when domain content is whitespace-only
      expect(result.systemPrompt!).not.toContain("BUSINESS DOMAIN RULES");
    } finally {
      // Always clean up the domain file we created in home directory
      await rm(domainFile, { force: true });
    }
  });
});
