import { describe, it, expect } from "bun:test";
import { createPromptInjector } from "../../core/prompt-injector";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("createPromptInjector", () => {
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
    const ctx = { session: { getMetadata: () => meta } };

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
    const ctx = { session: { getMetadata: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).not.toContain("BUSINESS DOMAIN RULES");
  });

  it("skips loop status for non-loop stages", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "design" });
    const ctx = { session: { getMetadata: () => meta } };

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
    const ctx = { session: { getMetadata: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).toContain("LOOP ENGINEERING STATUS");
  });

  it("includes pipeline status in every prompt", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta();
    const ctx = { session: { getMetadata: () => meta } };

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
    const ctx = { session: { getMetadata: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).not.toContain("Skill file not found at");
    // With null return, the prompt should not include any skill-related text
    expect(result.systemPrompt).not.toContain("STAGE-SPECIFIC RULES");
  });

  it("shows pending validation when previous summary is pending", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "design",
      previousStage: "clarify",
      summaries: {
        clarify: { path: "/tmp/clarify.md", hash: "abc", status: "pending" as const },
      },
    });
    const ctx = { session: { getMetadata: () => meta } };

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
    const ctx = { session: { getMetadata: () => meta } };

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
    const ctx = { session: { getMetadata: () => meta } };

    const hook = createPromptInjector(config);
    const result = await hook.handler(ctx as any);

    expect(result.systemPrompt).not.toContain("PREVIOUS VERIFICATION FAILURES");
  });
});
