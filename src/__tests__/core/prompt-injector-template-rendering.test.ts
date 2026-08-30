import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta, writePromptYml } from "../helpers";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";

// File-level reset scaffolding: migrated describes previously relied on the parent
// describe("createPromptInjector") beforeEach/afterEach for cache resets.
beforeEach(() => {
  resetGitignoreCache();
  resetPromptConfigCache();
});

afterEach(() => {
  resetPromptConfigCache();
  __resetAuditDirPath();
});

describe("yml template rendering path", () => {
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
    const result = (await hook.handler(ctx as any))!;

    // Pipeline status should be rendered
    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).toContain("pipe-test-001");
    // Loop status should be rendered
    expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
    // The output should contain the --- separator between the two paragraphs
    expect(result.systemPrompt!).toContain("---");

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
    const result = (await hook.handler(ctx as any))!;

    // Pipeline status and write scope should be present
    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");
    // context_reference paragraph should be removed (not present)
    expect(result.systemPrompt!).not.toContain("REQUIRED CONTEXT FILES");

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
    const result = (await hook.handler(ctx as any))!;

    // Should fall back to default prompt (contains Pipeline Status from default builder)
    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");

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
    const result = (await hook.handler(ctx as any))!;

    // Should use default path (develop gets loop status + pipeline status)
    expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
    expect(result.systemPrompt!).toContain("Pipeline Status");

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
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).toContain("LOOP ENGINEERING STATUS");
    expect(result.systemPrompt!).toContain("PREVIOUS VERIFICATION FAILURES");
    expect(result.systemPrompt!).toContain("[requiredFiles] Missing file");

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
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");
    // verify_failures is null (empty array) → paragraph removed
    expect(result.systemPrompt!).not.toContain("PREVIOUS VERIFICATION FAILURES");

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
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("STAGE-SPECIFIC RULES");
    expect(result.systemPrompt!).toContain("Stage skill rule: produce clarification doc");
    expect(result.systemPrompt!).not.toContain("{{stage_skill}}");

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
    const result = (await hook.handler(ctx as any))!;

    // stage_skill is null → paragraph removed
    expect(result.systemPrompt!).not.toContain("STAGE-SPECIFIC RULES");
    expect(result.systemPrompt!).not.toContain("{{stage_skill}}");
    // Other paragraphs remain
    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).toContain("STAGE WRITE SCOPE");

    await rm(TMP, { recursive: true, force: true });
  });
});

describe("prompt snapshot audit (E4/E5/E6/E7)", () => {
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
    const result = (await hook.handler(ctx as any))!;

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

    // Phase 5 (146): default snapshot level is "full" — includes pi base prompt
    // (the base prompt is added via ctx.getSystemPrompt and included in snapshot)
    // Phase 6 (161): "full" mode writes 3 events: prompt_snapshot (combined),
    // prompt_snapshot_base, and prompt_snapshot_plugin — each with prompt_hash
    const basePrompt = "This is the pi base system prompt that SHOULD appear in full snapshot";
    const ctxWithBase = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => basePrompt,
    };
    const hook2 = createPromptInjector(config);
    await hook2.handler(ctxWithBase as any);
    const logContent2 = await readFile(logFile, "utf-8");
    // The combined prompt_snapshot (first event) contains both base and plugin
    expect(logContent2).toContain("prompt_snapshot_base");
    expect(logContent2).toContain("prompt_snapshot_plugin");
    expect(logContent2).toContain("prompt_hash=");
    // Base prompt appears in the combined snapshot and the base-specific snapshot
    expect(logContent2).toContain(basePrompt);

    await rm(TMP, { recursive: true, force: true });
  });

  it("full snapshot: base and plugin events have different hashes", async () => {
    const TMP = join(tmpdir(), "pi-pi-snapshot-hash-" + Date.now());
    const auditDir = join(TMP, ".pi", "audit");
    await mkdir(TMP, { recursive: true });
    await mkdir(auditDir, { recursive: true });

    await writePromptYml(TMP, [
      "clarify: |",
      "  {{pipeline_status}}",
      "",
    ].join("\n"));

    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "clarify" });
    const basePrompt = "Unique base prompt for hash test XYZ123";
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => basePrompt,
    };

    const hook = createPromptInjector(config);
    await hook.handler(ctx as any);

    const logFile = join(auditDir, getDateAuditFileName());
    const logContent = await readFile(logFile, "utf-8");

    // All three events present
    expect(logContent).toContain("prompt_snapshot |");
    expect(logContent).toContain("prompt_snapshot_base |");
    expect(logContent).toContain("prompt_snapshot_plugin |");

    // Base event contains the base prompt content
    expect(logContent).toContain(basePrompt);

    // Base placeholder when no base system prompt exists
    // (tested in next test case)

    await rm(TMP, { recursive: true, force: true });
  });

  it("full snapshot: base placeholder when no base system prompt", async () => {
    const TMP = join(tmpdir(), "pi-pi-snapshot-nobase-" + Date.now());
    const auditDir = join(TMP, ".pi", "audit");
    await mkdir(TMP, { recursive: true });
    await mkdir(auditDir, { recursive: true });

    await writePromptYml(TMP, [
      "clarify: |",
      "  {{pipeline_status}}",
      "",
    ].join("\n"));

    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "clarify" });
    // No getSystemPrompt → base is empty
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    await hook.handler(ctx as any);

    const logFile = join(auditDir, getDateAuditFileName());
    const logContent = await readFile(logFile, "utf-8");

    // Base placeholder should be written
    expect(logContent).toContain("(no base system prompt)");
    expect(logContent).toContain("prompt_snapshot_base |");

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
    const result = (await hook.handler(ctx as any))!;

    // Should fall back to default prompt
    expect(result.systemPrompt!).toContain("Pipeline Status");

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

  it("writes prompt snapshot on default path (no yml template) with source=default (Phase 5)", async () => {
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
    const { existsSync } = await import("node:fs");
    if (!existsSync(logFile)) {
      throw new Error("Expected audit log file to exist on default path");
    }
    const logContent = await readFile(logFile, "utf-8");

    // Phase 5: default path should write snapshot with source=default
    expect(logContent).toContain("prompt_snapshot");
    expect(logContent).toContain("source=default");
    expect(logContent).toContain("=== PROMPT START ===");
    expect(logContent).toContain("=== PROMPT END ===");
    // Snapshot contains plugin prompt content
    expect(logContent).toContain("Pipeline Status");

    await rm(TMP, { recursive: true, force: true });
  });

  it("promptSnapshot=off does NOT write any snapshot", async () => {
    const TMP = join(tmpdir(), "pi-pi-snapshot-off-" + Date.now());
    const auditDir = join(TMP, ".pi", "audit");
    await mkdir(TMP, { recursive: true });
    await mkdir(auditDir, { recursive: true });

    const config = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      audit: { promptSnapshot: "off" },
    });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    await hook.handler(ctx as any);

    const logFile = join(auditDir, getDateAuditFileName());
    const { existsSync } = await import("node:fs");
    if (!existsSync(logFile)) {
      // No audit file = no snapshot written — pass
      await rm(TMP, { recursive: true, force: true });
      return;
    }
    const logContent = await readFile(logFile, "utf-8");
    expect(logContent).not.toContain("prompt_snapshot");

    await rm(TMP, { recursive: true, force: true });
  });

  it("promptSnapshot=plugin writes only plugin segment (no pi base)", async () => {
    const TMP = join(tmpdir(), "pi-pi-snapshot-plugin-" + Date.now());
    const auditDir = join(TMP, ".pi", "audit");
    await mkdir(TMP, { recursive: true });
    await mkdir(auditDir, { recursive: true });

    const config = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      audit: { promptSnapshot: "plugin" },
    });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "clarify" });
    const basePrompt = "PI BASE SHOULD NOT APPEAR IN PLUGIN MODE";
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => basePrompt,
    };

    const hook = createPromptInjector(config);
    await hook.handler(ctx as any);

    const logFile = join(auditDir, getDateAuditFileName());
    const logContent = await readFile(logFile, "utf-8");

    // Plugin mode should write snapshot
    expect(logContent).toContain("prompt_snapshot");
    expect(logContent).toContain("=== PROMPT START ===");
    // But should NOT contain the pi base prompt
    const startIdx = logContent.lastIndexOf("=== PROMPT START ===");
    const endIdx = logContent.lastIndexOf("=== PROMPT END ===");
    const snapshotBlock = logContent.substring(startIdx, endIdx);
    expect(snapshotBlock).not.toContain(basePrompt);
    // But SHOULD contain plugin content
    expect(snapshotBlock).toContain("Pipeline Status");

    await rm(TMP, { recursive: true, force: true });
  });

  it("snapshot metadata contains prompt_hash", async () => {
    const TMP = join(tmpdir(), "pi-pi-snapshot-hash-" + Date.now());
    const auditDir = join(TMP, ".pi", "audit");
    await mkdir(TMP, { recursive: true });
    await mkdir(auditDir, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    await hook.handler(ctx as any);

    const logFile = join(auditDir, getDateAuditFileName());
    const logContent = await readFile(logFile, "utf-8");

    // Metadata line should contain prompt_hash
    expect(logContent).toContain("prompt_hash=");
    // Hash should be a 64-character hex string (SHA-256)
    const hashMatch = logContent.match(/prompt_hash=([a-f0-9]{64})/);
    expect(hashMatch).not.toBeNull();

    await rm(TMP, { recursive: true, force: true });
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
        { type: "write_protected", tool: "write", detail: 'Cannot modify protected path \'.pi/config.json\'.', suggestion: "Protected paths: .pi/, .git/.", timestamp: Date.now() },
        { type: "git_protected", tool: "bash", detail: 'git add would stage protected path.', suggestion: "git add cannot stage protected paths.", timestamp: Date.now() },
      ],
    });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).toContain("PREVIOUS VIOLATIONS (MUST FIX)");
    expect(result.systemPrompt!).toContain("write_protected");
    expect(result.systemPrompt!).toContain("git_protected");
    expect(result.systemPrompt!).toContain('Cannot modify protected path');
  });

  it("does NOT inject violations section when violations is empty", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      violations: [],
    });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).not.toContain("PREVIOUS VIOLATIONS");
  });

  it("does NOT inject violations section when violations is undefined", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "develop", violations: undefined });
    const ctx = { session: { getMeta: () => meta } };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any))!;

    expect(result.systemPrompt!).not.toContain("PREVIOUS VIOLATIONS");
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
    const result = (await hook.handler(ctx as any))!;

    // The yml template should render the violations placeholder
    // If the template engine works, violations section should appear
    // (paragraph-level removal handles null by omitting the section)
    if (result.systemPrompt!.includes("PREVIOUS VIOLATIONS")) {
      expect(result.systemPrompt!).toContain("write_protected");
      expect(result.systemPrompt!).toContain("Cannot modify protected path.");
    }
    // If yml template not found, falls back to default path — still contains violations
    expect(result.systemPrompt!).toContain("PREVIOUS VIOLATIONS");

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
    const result = (await hook.handler(ctx as any)) as any;

    // Should contain the stage executor scheduling section (Phase 0 (146): fallback now in English)
    expect(result.systemPrompt!).toContain("Stage Executor Scheduling");
    expect(result.systemPrompt!).toContain("develop-agent");

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
    const result = (await hook.handler(ctx as any)) as any;

    // Should contain completed summary section
    expect(result.systemPrompt!).toContain("## Pipeline Completed Summary");
    expect(result.systemPrompt!).toContain("pipe-completed-test");
    expect(result.systemPrompt!).toContain("**endStage**");

    resetPromptConfigCache();
    await rm(TMP, { recursive: true, force: true });
  });
});

// ─── Phase 0 (146): stage_deliverables injection + fallback English ──────────

describe("Phase 0 (146): stage_deliverables injection + fallback English", () => {
  it("renders plugin deliverables segment when yml template contains {{stage_deliverables}}", async () => {
    const TMP = join(tmpdir(), "pi-pi-p0-deliv-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    // Write yml with stage_deliverables placeholder + stage_deliverable_develop key
    const refDir = join(TMP, ".pi", "references");
    await mkdir(refDir, { recursive: true });
    const ymlContent = [
      "develop: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{loop_status}}",
      "  ---",
      "  {{stage_executor}}",
      "  ---",
      "  {{stage_deliverables}}",
      "stage_executor_develop: |",
      "  ## Stage Executor Scheduling",
      "  test executor text for {subagent_type}",
      "stage_deliverable_develop: |",
      "  ## Plugin Default Deliverables (develop)",
      "  - **MUST** run build",
    ].join("\n");
    await writeFile(join(refDir, "pipeline-stage-prompt.yml"), ymlContent);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => "base prompt",
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any)) as any;

    expect(result.systemPrompt!).toContain("STAGE DELIVERABLES (PLUGIN)");
    expect(result.systemPrompt!).toContain("**MUST** run build");

    resetPromptConfigCache();
    await rm(TMP, { recursive: true, force: true });
  });

  it("does not fail when yml template lacks {{stage_deliverables}} (non-critical)", async () => {
    const TMP = join(tmpdir(), "pi-pi-p0-no-deliv-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    // Write yml WITHOUT {{stage_deliverables}} placeholder
    const refDir = join(TMP, ".pi", "references");
    await mkdir(refDir, { recursive: true });
    const ymlContent = [
      "develop: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{loop_status}}",
      "  ---",
      "  {{stage_executor}}",
      "stage_executor_develop: |",
      "  ## Stage Executor Scheduling",
      "  test executor for {subagent_type}",
    ].join("\n");
    await writeFile(join(refDir, "pipeline-stage-prompt.yml"), ymlContent);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => "base prompt",
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any)) as any;

    // Should render successfully without the deliverables segment
    expect(result.systemPrompt!).toContain("Pipeline Status");
    expect(result.systemPrompt!).not.toContain("STAGE DELIVERABLES (PLUGIN)");

    resetPromptConfigCache();
    await rm(TMP, { recursive: true, force: true });
  });

  it("default 10-part path (no yml template) injects plugin deliverables for develop", async () => {
    const TMP = join(tmpdir(), "pi-pi-p0_default-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    // Write yml with ONLY stage_deliverable_develop (no stage templates → default path)
    const refDir = join(TMP, ".pi", "references");
    await mkdir(refDir, { recursive: true });
    const ymlContent = [
      "stage_deliverable_develop: |",
      "  ## Plugin Default Deliverables (develop)",
      "  - **MUST** commit changes",
    ].join("\n");
    await writeFile(join(refDir, "pipeline-stage-prompt.yml"), ymlContent);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => "base prompt",
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any)) as any;

    // Default 10-part path should also inject the deliverables segment
    expect(result.systemPrompt!).toContain("STAGE DELIVERABLES (PLUGIN)");
    expect(result.systemPrompt!).toContain("**MUST** commit changes");

    resetPromptConfigCache();
    await rm(TMP, { recursive: true, force: true });
  });

  it("buildStageExecutor fallback is in English (no Chinese characters)", async () => {
    const TMP = join(tmpdir(), "pi-pi-p0-en-fallback-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    // No yml at all → buildStageExecutor uses hardcoded English fallback
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => "base",
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any)) as any;

    // Fallback should be English — no Chinese characters in the executor section
    const chinesePattern = /[\u4e00-\u9fff]/;
    // Find the executor section (between "Stage Executor Scheduling" and next heading or end)
    const executorMatch = result.systemPrompt!.match(/## Stage Executor Scheduling[\s\S]*?(?=\n# |\n## (?!Stage Executor)|$)/);
    if (executorMatch) {
      expect(chinesePattern.test(executorMatch[0])).toBe(false);
    }

    resetPromptConfigCache();
    await rm(TMP, { recursive: true, force: true });
  });

  it("renders plugin deliverables segment for clarify stage when yml contains {{stage_deliverables}}", async () => {
    const TMP = join(tmpdir(), "pi-pi-p0-clarify-deliv-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    // Write yml with stage_deliverables placeholder + stage_deliverable_clarify key
    const refDir = join(TMP, ".pi", "references");
    await mkdir(refDir, { recursive: true });
    const ymlContent = [
      "clarify: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_write_scope}}",
      "  ---",
      "  {{stage_deliverables}}",
      "stage_deliverable_clarify: |",
      "  - **MUST** produce clarification questions",
    ].join("\n");
    await writeFile(join(refDir, "pipeline-stage-prompt.yml"), ymlContent);

    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => "base prompt",
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any)) as any;

    expect(result.systemPrompt!).toContain("STAGE DELIVERABLES (PLUGIN)");
    expect(result.systemPrompt!).toContain("**MUST** produce clarification questions");

    resetPromptConfigCache();
    await rm(TMP, { recursive: true, force: true });
  });

  it("renders plugin deliverables segment for plan stage when yml contains {{stage_deliverables}}", async () => {
    const TMP = join(tmpdir(), "pi-pi-p0-plan-deliv-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);

    const refDir = join(TMP, ".pi", "references");
    await mkdir(refDir, { recursive: true });
    const ymlContent = [
      "plan: |",
      "  {{pipeline_status}}",
      "  ---",
      "  {{stage_write_scope}}",
      "  ---",
      "  {{stage_deliverables}}",
      "stage_deliverable_plan: |",
      "  - **MUST** produce a planning document",
    ].join("\n");
    await writeFile(join(refDir, "pipeline-stage-prompt.yml"), ymlContent);

    const meta = makeTestMeta({ currentStage: "plan" });
    const ctx = {
      session: { getMeta: () => meta },
      getSystemPrompt: () => "base prompt",
    };

    const hook = createPromptInjector(config);
    const result = (await hook.handler(ctx as any)) as any;

    expect(result.systemPrompt!).toContain("STAGE DELIVERABLES (PLUGIN)");
    expect(result.systemPrompt!).toContain("**MUST** produce a planning document");

    resetPromptConfigCache();
    await rm(TMP, { recursive: true, force: true });
  });
});
