import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineInitCommand } from "../../commands/pipeline-init";
import { makeTestConfig } from "../helpers";

let TMP: string;
let templateDir: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-init-cmd-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });

  // Create a minimal template directory structure
  templateDir = path.join(TMP, "template-src");
  await createMinimalTemplate(templateDir);
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Create a minimal template directory for testing */
async function createMinimalTemplate(dir: string) {
  // skills
  for (const stage of ["plan", "develop", "review", "fix"]) {
    const skillDir = path.join(dir, "skills", stage);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `- **Must** ${stage}-output.md\n`,
      "utf-8",
    );
  }

  // agents
  for (const stage of ["clarify", "plan", "develop", "review", "fix"]) {
    const agentDir = path.join(dir, "agents", stage);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, `${stage}.md`), `# ${stage} agent\n`, "utf-8");
  }

  // guide.md
  await fs.writeFile(path.join(dir, "guide.md"), "# Guide\n", "utf-8");

  // pipeline_loop.json
  await fs.writeFile(
    path.join(dir, "pipeline_loop.json"),
    JSON.stringify({ stages: { clarify: { nextStage: "plan" } } }),
    "utf-8",
  );
}

/** Helper to create a config pointing to the test directory */
function makeInitConfig() {
  return makeTestConfig({
    projectRoot: TMP,
    stages: Object.fromEntries(
      ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
        (s, i, a) => [
          s,
          {
            agentPath: `.pi/agents/${s}/${s}.md`,
            skillPath: `${s}/SKILL.md`,
            nextStage: a[i + 1] ?? null,
            requireDomain: false,
          },
        ],
      ),
    ) as any,
  });
}

describe("createPipelineInitCommand", () => {
  it("creates a command with correct name and description", () => {
    const config = makeInitConfig();
    const cmd = createPipelineInitCommand(config);
    expect(cmd.name).toBe("pipeline-init");
    expect(cmd.description).toContain("Initialize");
  });

  describe("verify branch (sub=1)", () => {
    it("skips when .pi/skills directory does not exist", async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.summary).toContain("skipped");
      expect(result.summary).toContain(".pi/skills not found");
    });

    it("generates verify.md files when skills exist", async () => {
      const config = makeInitConfig();

      // Create .pi/skills with skill files
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-result.md\n`,
          "utf-8",
        );
      }

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.summary).toContain("Generated");
      expect(result.results).toBeDefined();
    });
  });

  describe("argument parsing", () => {
    it("accepts string argument '0'", async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      // String "0" should trigger dir branch only.
      // TEMPLATE_DIR resolves to src/template (exists in dev/test).
      const result: any = await cmd.execute("0" as any);
      expect(result.success).toBe(true);
      expect(fsSync.existsSync(path.join(TMP, ".pi", "guide.md"))).toBe(true);
      expect(fsSync.existsSync(path.join(TMP, ".pi", "skills", "design", "SKILL.md"))).toBe(true);
      expect(fsSync.existsSync(path.join(TMP, "pipeline_loop.json"))).toBe(true);
    });

    it("accepts string argument '1'", async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute("1" as any);
      // .pi/skills doesn't exist → skipped
      expect(result.success).toBe(true);
      expect(result.summary).toContain("skipped");
    });

    it("accepts empty string (runs both dir + verify)", async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute("" as any);
      // sub="" runs dir then verify; .pi/skills should exist after dir copy
      expect(result.success).toBe(true);
      expect(fsSync.existsSync(path.join(TMP, ".pi", "skills"))).toBe(true);
    });

    it("accepts object { sub: '1' }", async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });
      expect(result.success).toBe(true);
      expect(result.summary).toContain("skipped");
    });
  });

  describe("no-UI mode", () => {
    it("defaults to skip strategy when files exist and no UI is available", async () => {
      const config = makeInitConfig();

      // Pre-create a .pi file that matches a template file to trigger existingCount > 0
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(piDir, "agents", "feat-design-plan-agent.md"), "existing", "utf-8");

      const cmd = createPipelineInitCommand(config);
      // No ctx.ui provided — should default to skip strategy
      const result: any = await cmd.execute({ sub: "0" });
      expect(result.success).toBe(true);
      expect(fsSync.existsSync(path.join(TMP, ".pi", "guide.md"))).toBe(true);
    });
  });

  describe("with UI mock", () => {
    it("handles cancel (undefined return from ui.select)", async () => {
      const config = makeInitConfig();

      // Pre-create files to trigger multi-execution detection
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(piDir, "agents", "feat-design-plan-agent.md"), "existing", "utf-8");

      const ctx = {
        ui: {
          select: async (_msg: string, _options: string[]): Promise<string | undefined> => {
            return undefined; // User pressed Escape
          },
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);
      expect(result.success).toBe(true);
      expect(result.summary).toContain("Cancelled");
    });

    it("handles cancel option '4'", async () => {
      const config = makeInitConfig();

      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(piDir, "agents", "feat-design-plan-agent.md"), "existing", "utf-8");

      const ctx = {
        ui: {
          select: async (): Promise<string> => "4. Cancel",
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);
      expect(result.success).toBe(true);
      expect(result.summary).toContain("Cancelled");
    });
  });

  describe("Phase 0 — content result with file lists (dir branch)", () => {
    it('sub="0" returns content with copied count and .pi/guide.md in file list', async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      expect(result.content).toContain("# pipeline-init — .pi/ directory setup");
      expect(result.content).toContain("copied:");
      expect(result.content).toContain(".pi/guide.md");
      expect(result.content).toContain("Copied files:");
    });

    it("skip strategy produces Skipped files section with existing paths", async () => {
      const config = makeInitConfig();

      // Pre-create a .pi file that matches a template file to trigger existingCount > 0
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(piDir, "agents", "feat-design-plan-agent.md"), "existing", "utf-8");

      const cmd = createPipelineInitCommand(config);
      // No UI → defaults to skip strategy
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("Skipped files:");
      expect(result.content).toContain(".pi/agents/feat-design-plan-agent.md");
    });

    it("cancel branch returns content with 'cancelled'", async () => {
      const config = makeInitConfig();

      // Pre-create files to trigger multi-execution detection
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(piDir, "agents", "feat-design-plan-agent.md"), "existing", "utf-8");

      const ctx = {
        ui: {
          select: async (): Promise<string | undefined> => undefined,
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain("cancelled");
    });
  });

  describe("option 3 - verify after skip (Phase 1 bug fix)", () => {
    it("runs verify generation after option 3 Chinese text selected", async () => {
      const config = makeInitConfig();

      // Pre-create .pi/skills/design/SKILL.md with Must marker so verify can extract items.
      // Also pre-create an agent file to ensure existingCount > 0 triggers multi-execution UI.
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "skills", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "clarify", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "feat-design-plan-agent.md"),
        "existing agent",
        "utf-8",
      );

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3. Re-run verify generation",
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);

      // Verify branch should have run and generated design verify.md
      expect(result.success).toBe(true);
      expect(
        fsSync.existsSync(path.join(TMP, ".pi", "references", "clarify_spec", "verify.md")),
      ).toBe(true);
    });

    it("runs verify generation after option 3 numeric fallback selected", async () => {
      const config = makeInitConfig();

      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "skills", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "clarify", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "feat-design-plan-agent.md"),
        "existing agent",
        "utf-8",
      );

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3",
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);

      expect(result.success).toBe(true);
      expect(
        fsSync.existsSync(path.join(TMP, ".pi", "references", "clarify_spec", "verify.md")),
      ).toBe(true);
    });
  });

  describe("Phase 1 — verify branch content and combined merge", () => {
    it('sub="1" with successful generation returns content with generated count and verify.md path', async () => {
      const config = makeInitConfig();

      // Create .pi/skills with skill files
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-result.md\n`,
          "utf-8",
        );
      }

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("generated:");
      expect(result.content).toContain("verify.md");
      expect(result.content).toContain("Generated:");
    });

    it("sub=\"1\" with missing .pi/skills returns content with 'not found'", async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("not found");
      expect(result.content).toContain("verify.md generation");
    });

    it('sub="" merges dir + verify content (both sections present)', async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute("" as any);

      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      // Dir section: should contain .pi/ directory setup info
      expect(result.content).toContain(".pi/ directory setup");
      expect(result.content).toContain(".pi/guide.md");
      // Verify section: should contain verify.md generation info
      expect(result.content).toContain("verify.md generation");
    });

    it("option 3 (verifyAfter) only outputs verify section (no dir copy)", async () => {
      const config = makeInitConfig();

      // Pre-create files to trigger multi-execution detection
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "skills", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "clarify", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "feat-design-plan-agent.md"),
        "existing agent",
        "utf-8",
      );

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3. Re-run verify generation",
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      // Dir section NOT present — option 3 no longer copies template files
      expect(result.content).not.toContain(".pi/ directory setup");
      // Verify section present
      expect(result.content).toContain("verify.md generation");
      expect(result.content).toContain("Generated:");
    });
  });

  describe("Phase 2 — Bug 1: exists-skip display shows 'rules already present'", () => {
    it("reason='exists' shows 'rules already present' in skipped section (not 'unknown reason')", async () => {
      const config = makeInitConfig();

      // Pre-create skill + verify.md with the exact expected rules → triggers status=skipped, reason=exists
      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "- **Must** develop-result.md\n",
        "utf-8",
      );

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      // Well-formed verify.md with matching rules → skipped with reason=exists
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n  requiredFiles:\n    - \"develop-result.md\"\n---\nExisting body\n",
        "utf-8",
      );

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("rules already present");
      expect(result.content).not.toContain("unknown reason");
    });

    it("reason='exists_custom' keeps 'user-authored custom rules protected' text (no regression)", async () => {
      const config = makeInitConfig();

      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "- **Must** develop-result.md\n",
        "utf-8",
      );

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      // Verify.md with custom fileContentPattern rule → triggers exists_custom skip
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n  requiredFiles:\n    - \"develop-result.md\"\n  fileContentPattern:\n    - path: \"develop-result.md\"\n      pattern: \"^phase:\"\n---\nCustom content\n",
        "utf-8",
      );

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("user-authored custom rules protected");
      // Must NOT be confused with the generic exists display
      expect(result.content).not.toContain("rules already present");
    });
  });

  describe("Phase 4 — Bug 4-B: pipeline-init warns when verify.md contains {requirementDoc} placeholder", () => {
    it("report includes placeholder warning when verify.md references {requirementDoc}", async () => {
      const config = makeInitConfig();

      // Pre-create skill + verify.md containing the placeholder
      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "- **Must** develop-result.md\n",
        "utf-8",
      );

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      // Existing verify.md with placeholder in a requiredFiles path
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n  requiredFiles:\n    - \"{requirementDoc}\"\n---\nBody\n",
        "utf-8",
      );

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("warn:");
      expect(result.content).toContain("{requirementDoc}");
      expect(result.content).toContain("/pipeline-start");
    });

    it("report does NOT include placeholder warning when verify.md has no placeholder", async () => {
      const config = makeInitConfig();

      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "- **Must** develop-result.md\n",
        "utf-8",
      );

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      // Well-formed verify.md without placeholder
      await fs.writeFile(
        path.join(verifyDir, "verify.md"),
        "---\nrules:\n  requiredFiles:\n    - \"develop-result.md\"\n---\nBody\n",
        "utf-8",
      );

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).not.toContain("warn:");
      expect(result.content).not.toContain("{requirementDoc}");
    });

    it("protect.ask=true + no session meta → merge is blocked (fail-safe, consistent with askProtectDecision)", async () => {
      const config = makeInitConfig();
      // Enable protect.ask to activate the onMergeAsk callback
      (config as any).protect = { ask: true, gitignore: true, paths: [], allow: [] };

      // Pre-create skill + existing verify.md (triggers merge path)
      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "- **Must** develop-result.md\n",
        "utf-8",
      );

      const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
      await fs.mkdir(verifyDir, { recursive: true });
      const originalContent = "---\nrules:\n---\nExisting body\n";
      await fs.writeFile(path.join(verifyDir, "verify.md"), originalContent, "utf-8");

      const cmd = createPipelineInitCommand(config);
      // ctx has no session at all → getMeta() returns undefined → onMergeAsk must return "block"
      const result: any = await cmd.execute({ sub: "1" }, {});

      expect(result.success).toBe(true);
      // develop stage should be skipped (blocked), NOT merged — count must be 0
      expect(result.content).toContain("merged: 0");
      // The develop stage detail line must show user_declined, not merged
      expect(result.content).toContain("develop (skipped: user declined overwrite)");
      // File on disk must remain unchanged (merge was blocked)
      const afterContent = await fs.readFile(path.join(verifyDir, "verify.md"), "utf-8");
      expect(afterContent).toBe(originalContent);
    });
  });

  describe("Phase 2 — PipelineUI status bar lifecycle (command-level removed)", () => {
    function makeUICtx() {
      const notifications: string[] = [];
      const statusCalls: { key: string; text: string | undefined }[] = [];
      return {
        ctx: {
          ui: {
            notify: (msg: string) => { notifications.push(msg); },
            setStatus: (key: string, text: string | undefined) => { statusCalls.push({ key, text }); },
          },
        },
        notifications,
        statusCalls,
      };
    }

    it("output.pipelineStage: true — command sets Pipeline → init then restores session stage", async () => {
      const config = makeInitConfig();
      // Override output to enable pipelineStage
      (config as any).output = { pipelineStage: true };

      const { ctx, statusCalls } = makeUICtx();
      const cmd = createPipelineInitCommand(config);
      await cmd.execute({ sub: "1" }, ctx);

      // Command-level setStage("Pipeline → init") at start, restore "Pipeline → clarify" in finally (ctx has no session → fallback)
      const texts = statusCalls.map(c => c.text);
      expect(texts).toContain("Pipeline → init");
      expect(texts).toContain("Pipeline → clarify");
      // First call should be "Pipeline → init", last call should be "Pipeline → clarify"
      expect(texts[0]).toBe("Pipeline → init");
      expect(texts[texts.length - 1]).toBe("Pipeline → clarify");
    });

    it("output.pipelineStage: false — no setStatus or notify calls", async () => {
      const config = makeInitConfig();
      // Override output to disable pipelineStage (default)
      (config as any).output = { pipelineStage: false };

      const { ctx, notifications, statusCalls } = makeUICtx();
      const cmd = createPipelineInitCommand(config);
      await cmd.execute({ sub: "1" }, ctx);

      expect(notifications).toEqual([]);
      expect(statusCalls).toEqual([]);
    });

    it("ctx without ui — does not throw (no-op safe)", async () => {
      const config = makeInitConfig();
      (config as any).output = { pipelineStage: true };

      const cmd = createPipelineInitCommand(config);
      // ctx without ui — should not throw
      await expect(cmd.execute({ sub: "1" }, {})).resolves.toBeDefined();
    });
  });

  describe("Phase 3 — E2E fix: no-copy, zero-hint, sub=\"\" option 3", () => {
    it("option 3 does NOT trigger copyTemplateFiles — preserves existing guide.md and missing files", async () => {
      const config = makeInitConfig();

      const piDir = path.join(TMP, ".pi");

      // Pre-create guide.md with OLD content (should NOT be overwritten)
      await fs.mkdir(piDir, { recursive: true });
      await fs.writeFile(path.join(piDir, "guide.md"), "# OLD Guide Content\n", "utf-8");

      // Pre-create a file that matches a template file to trigger multi-execution detection (existingCount > 0)
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "feat-design-plan-agent.md"),
        "existing agent",
        "utf-8",
      );

      // Also pre-create a skill file with Must marker for verify generation to find
      // (Note: skills/clarify/SKILL.md is NOT in the template, so this won't affect existingCount)
      await fs.mkdir(path.join(piDir, "skills", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "clarify", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );

      // Note: agents/clarify.md does NOT exist — option 3 should NOT copy it

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3. Re-run verify generation",
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);

      expect(result.success).toBe(true);

      // guide.md should NOT have been overwritten (still old content)
      const guideContent = await fs.readFile(path.join(piDir, "guide.md"), "utf-8");
      expect(guideContent).toBe("# OLD Guide Content\n");

      // agents/plan/plan.md should NOT have been copied (option 3 does no file copy)
      expect(
        fsSync.existsSync(path.join(piDir, "agents", "plan", "plan.md")),
      ).toBe(false);

      // verify.md should still be generated (verify ran)
      expect(
        fsSync.existsSync(path.join(TMP, ".pi", "references", "clarify_spec", "verify.md")),
      ).toBe(true);
    });

    it("zero-result hint: sub=1 with all skills present but no Must markers shows marker hint", async () => {
      const config = makeInitConfig();

      // Create .pi/skills with SKILL.md that has NO Must markers — ALL stages
      for (const stage of ["clarify", "plan", "develop", "review", "fix"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `# ${stage} skill\nNo markers here.\n`,
          "utf-8",
        );
      }

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("generated: 0");
      // All skills read but no markers → marker hint
      expect(result.content).toContain("no **Must**/**必须** markers");
    });

    it("zero-result hint: sub=1 with all skill_not_found shows path fix guidance instead of marker hint", async () => {
      const config = makeInitConfig();

      // Create .pi/skills directory (so early return doesn't trigger) but no skill files
      await fs.mkdir(path.join(TMP, ".pi", "skills"), { recursive: true });

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("generated: 0");
      // skill_not_found → path fix hint, NOT marker hint
      expect(result.content).toContain("skill files not found");
      expect(result.content).not.toContain("no **Must**/**必须** markers");
    });

    it("zero-result hint: sub=1 with mix of skill_not_found and no_items shows both hints", async () => {
      const config = makeInitConfig();

      // Only create skills for design and develop (no markers); rest will be skill_not_found
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `# ${stage} skill\nNo markers here.\n`,
          "utf-8",
        );
      }

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("generated: 0");
      // Mixed case: both hints shown
      expect(result.content).toContain("skill files not found");
      expect(result.content).toContain("no **Must**/**必须** markers");
    });

    it('sub="" with UI option 3 — unified dispatch runs verify once and succeeds', async () => {
      const config = makeInitConfig();

      // Pre-create .pi files to trigger multi-execution detection
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "skills", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "clarify", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "feat-design-plan-agent.md"),
        "existing agent",
        "utf-8",
      );

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3. Re-run verify generation",
        },
      };

      const cmd = createPipelineInitCommand(config);
      // sub="" triggers both runDir and runVerify; option 3 in dir branch flags verifyAfter
      const result: any = await cmd.execute("" as any, ctx);

      expect(result.success).toBe(true);
      // Verify output should be present (unified dispatch path)
      expect(result.content).toContain("verify.md generation");
      expect(result.content).toContain("Generated:");
      // verify.md file should exist
      expect(
        fsSync.existsSync(path.join(TMP, ".pi", "references", "clarify_spec", "verify.md")),
      ).toBe(true);
    });
  });

  describe("Phase 2 — llmExtract TUI/audit observability", () => {
    it("llmExtract: off → TUI shows 'llmExtract: off' and no per-stage llm detail", async () => {
      const config = makeInitConfig();

      // Create .pi/skills with Must markers
      for (const stage of ["plan"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-output.md\n`,
          "utf-8",
        );
      }

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("llmExtract: off");
      // No llm detail in per-stage output when llmExtract is off
      expect(result.content).not.toContain("llm:");
    });

    it("llmExtract: true + model unavailable → TUI shows 'llm: unavailable'", async () => {
      const config = makeInitConfig();
      (config as any).llmExtract = true;

      // Create .pi/skills with Must markers
      for (const stage of ["plan"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-output.md\n`,
          "utf-8",
        );
      }

      const cmd = createPipelineInitCommand(config);
      // No modelRegistry in ctx → model unavailable
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("llm: unavailable");
    });

    it("pipeline-init_verify audit is written on sub='1' with llmEnabled field", async () => {
      const config = makeInitConfig();
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      (config as any).auditDir = ".pi/audit";

      // Create .pi/skills with Must markers
      const skillDir = path.join(TMP, ".pi", "skills", "clarify");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `- **Must** design-output.md\n`,
        "utf-8",
      );

      // Initialize audit log
      const { initAuditLog, getDateAuditFileName, __resetAuditDirPath } = await import("../../utils/auditLog");
      await initAuditLog(config);

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);

      // Verify audit log contains pipeline-init_verify
      const logFile = path.join(auditDir, getDateAuditFileName());
      const logContent = await fs.readFile(logFile, "utf-8");
      expect(logContent).toContain("pipeline-init_verify");
      expect(logContent).toContain("llmEnabled=false");

      __resetAuditDirPath();
    });

    it("pipeline-init_verify audit is written on sub='' (combined dir+verify) with llmEnabled field", async () => {
      const config = makeInitConfig();
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      (config as any).auditDir = ".pi/audit";

      // Create .pi/skills with Must markers (verify side will use these)
      const skillDir = path.join(TMP, ".pi", "skills", "clarify");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `- **Must** design-output.md\n`,
        "utf-8",
      );

      // Initialize audit log
      const { initAuditLog, getDateAuditFileName, __resetAuditDirPath } = await import("../../utils/auditLog");
      await initAuditLog(config);

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "" });

      expect(result.success).toBe(true);

      // Verify audit log contains pipeline-init_verify
      const logFile = path.join(auditDir, getDateAuditFileName());
      const logContent = await fs.readFile(logFile, "utf-8");
      expect(logContent).toContain("pipeline-init_verify");
      expect(logContent).toContain("llmEnabled=false");

      __resetAuditDirPath();
    });

    it("per-stage TUI shows hardcoded count when llmExtract is off", async () => {
      const config = makeInitConfig();

      // Create .pi/skills with Must markers
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-output.md\n`,
          "utf-8",
        );
      }

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      // Per-stage should show hardcoded count
      expect(result.content).toContain("hardcoded: 1");
    });

    it("skipped stages show reason in TUI (skill_not_found / no_items)", async () => {
      const config = makeInitConfig();

      // Create .pi/skills directory but no skill files → all skill_not_found
      await fs.mkdir(path.join(TMP, ".pi", "skills"), { recursive: true });

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("skipped: skill_not_found");
    });
  });

  describe("Phase 0 — buildCallLLM compat complete() mode", () => {
    afterEach(() => {
      mock.restore();
    });

    /** Helper: create config with llmExtract enabled and skills dir */
    async function makeLLMConfig(): Promise<PipelineConfig> {
      const config = makeInitConfig();
      (config as any).llmExtract = true;
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      (config as any).auditDir = ".pi/audit";

      // Initialize audit log
      const { initAuditLog } = await import("../../utils/auditLog");
      await initAuditLog(config);

      // Create skill files with Must markers
      for (const stage of ["plan"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-output.md\n`,
          "utf-8",
        );
      }

      return config;
    }

    /** Helper: create mock ctx with modelRegistry */
    function makeModelCtx(mockModel: Record<string, unknown> = { name: "test-model", api: "openai" }) {
      return {
        _ctx: {
          modelRegistry: {
            getAvailable: () => [mockModel],
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
          },
          model: mockModel,
          sessionManager: { getBranch: () => [], getEntries: () => [] },
        },
      };
    }

    it("llmExtract:true + compat complete success → llmStatus='ok' with extracted items", async () => {
      const config = await makeLLMConfig();
      const modelCtx = makeModelCtx();

      // Mock compat complete to return a valid LLM response with JSON items
      const mockComplete = mock(() =>
        Promise.resolve({
          content: [{ type: "text", text: '[{"type":"file","target":"llm-extracted.md"}]' }],
          stopReason: "end_turn",
        }),
      );
      mock.module("@earendil-works/pi-ai/compat", () => ({ complete: mockComplete }));

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" }, modelCtx);

      expect(result.success).toBe(true);
      // llmExtract should be "on" and llm items should be extracted
      expect(result.content).toContain("llmExtract: on");
      // The result should have generated verify with both hardcoded and llm items
      const designResult = result.results?.find((r: any) => r.stage === "plan");
      expect(designResult).toBeDefined();
      expect(designResult.llmStatus).toBe("ok");
      expect(designResult.llmCount).toBe(1);
      expect(mockComplete).toHaveBeenCalled();
    });

    it("compat complete returns stopReason='error' → callLLM throws → llmStatus='fail'", async () => {
      const config = await makeLLMConfig();
      const modelCtx = makeModelCtx();

      // Mock compat complete to return an error response
      const mockComplete = mock(() =>
        Promise.resolve({
          content: [],
          stopReason: "error",
          errorMessage: "provider not found",
        }),
      );
      mock.module("@earendil-works/pi-ai/compat", () => ({ complete: mockComplete }));

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" }, modelCtx);

      expect(result.success).toBe(true);
      // LLM should have failed but hardcoded items still work (fallback)
      const designResult = result.results?.find((r: any) => r.stage === "plan");
      expect(designResult).toBeDefined();
      expect(designResult.llmStatus).toBe("fail");
      // Hardcoded items should still generate verify.md (fallback)
      expect(designResult.status).toBe("generated");
      expect(designResult.hardcodedCount).toBe(1);
    });

    it("no available models → buildCallLLM returns null → llmStatus='off'", async () => {
      const config = await makeLLMConfig();
      const modelCtx = {
        _ctx: {
          modelRegistry: {
            getAvailable: () => [],
            getApiKeyAndHeaders: async () => ({ ok: false }),
          },
          sessionManager: { getBranch: () => [], getEntries: () => [] },
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" }, modelCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain("llm: unavailable");
      // No LLM extraction
      const designResult = result.results?.find((r: any) => r.stage === "plan");
      expect(designResult.llmStatus).toBe("off");
    });

    it("modelRegistry.getAvailable throws → llm_build_error audit + buildCallLLM returns null", async () => {
      const config = await makeLLMConfig();
      const brokenModelCtx = {
        _ctx: {
          modelRegistry: {
            getAvailable: () => { throw new Error("Registry corrupted"); },
            getApiKeyAndHeaders: async () => ({ ok: false }),
          },
          sessionManager: { getBranch: () => [], getEntries: () => [] },
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" }, brokenModelCtx);

      expect(result.success).toBe(true);
      // Should show unavailable (buildCallLLM caught the error)
      expect(result.content).toContain("llm: unavailable");

      // Verify llm_build_error audit was written
      const { getDateAuditFileName, __resetAuditDirPath } = await import("../../utils/auditLog");
      const auditDir = path.join(TMP, ".pi", "audit");
      const logFile = path.join(auditDir, getDateAuditFileName());
      const logContent = await fs.readFile(logFile, "utf-8");
      expect(logContent).toContain("llm_build_error");

      __resetAuditDirPath();
    });

    it("compat complete returns errorMessage (no stopReason) → callLLM throws → llmStatus='fail'", async () => {
      const config = await makeLLMConfig();
      const modelCtx = makeModelCtx();

      // Mock compat complete to return error via errorMessage field only
      const mockComplete = mock(() =>
        Promise.resolve({
          content: [],
          stopReason: "end_turn",
          errorMessage: "API rate limit exceeded",
        }),
      );
      mock.module("@earendil-works/pi-ai/compat", () => ({ complete: mockComplete }));

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" }, modelCtx);

      expect(result.success).toBe(true);
      const designResult = result.results?.find((r: any) => r.stage === "plan");
      expect(designResult).toBeDefined();
      expect(designResult.llmStatus).toBe("fail");
      // Hardcoded items fallback still generates verify
      expect(designResult.status).toBe("generated");
    });

    it("Phase 4 — compat complete returns empty array → llmStatus='ok' (no false failure)", async () => {
      const config = await makeLLMConfig();
      const modelCtx = makeModelCtx();

      // Mock compat complete to return a valid empty array
      const mockComplete = mock(() =>
        Promise.resolve({
          content: [{ type: "text", text: "[]" }],
          stopReason: "end_turn",
        }),
      );
      mock.module("@earendil-works/pi-ai/compat", () => ({ complete: mockComplete }));

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" }, modelCtx);

      expect(result.success).toBe(true);
      const designResult = result.results?.find((r: any) => r.stage === "plan");
      expect(designResult).toBeDefined();
      // Empty array is valid — should NOT be judged as failure
      expect(designResult.llmStatus).toBe("ok");
      expect(designResult.llmCount).toBe(0);
      // Hardcoded items still generate verify.md
      expect(designResult.status).toBe("generated");
      expect(designResult.hardcodedCount).toBe(1);
    });
  });

  describe("Phase 3 — LLM extraction progress animation (PipelineUI)", () => {
    afterEach(() => {
      mock.restore();
    });

    it("pipelineStage:true + llmExtract:true → setStatus shows Pipeline → init progress + restore", async () => {
      const config = makeInitConfig();
      (config as any).llmExtract = true;
      (config as any).output = { pipelineStage: true };

      // Create skill files
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-output.md\n`,
          "utf-8",
        );
      }

      const statusCalls: { key: string; text: string | undefined }[] = [];
      const workingMessages: (string | undefined)[] = [];
      const modelCtx = {
        _ctx: {
          modelRegistry: {
            getAvailable: () => [{ name: "test-model", api: "openai" }],
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
          },
          model: { name: "test-model", api: "openai" },
          sessionManager: { getBranch: () => [], getEntries: () => [] },
        },
        ui: {
          setStatus: (key: string, text: string | undefined) => { statusCalls.push({ key, text }); },
          setWorkingMessage: (msg?: string) => { workingMessages.push(msg); },
          setWorkingIndicator: () => {},
        },
      };

      // Mock compat complete to return valid JSON
      const mockComplete = mock(() =>
        Promise.resolve({
          content: [{ type: "text", text: "[]" }],
          stopReason: "end_turn",
        }),
      );
      mock.module("@earendil-works/pi-ai/compat", () => ({ complete: mockComplete }));

      const cmd = createPipelineInitCommand(config);
      await cmd.execute({ sub: "1" }, modelCtx);

      // statusCalls should contain Pipeline → init (progressStart first frame)
      const texts = statusCalls.map(c => c.text);
      expect(texts.some(t => t?.includes("Pipeline → init"))).toBe(true);
      // statusCalls should contain Pipeline → init base text (progressEnd)
      expect(texts.some(t => t === "Pipeline → init")).toBe(true);
      // statusCalls should contain Pipeline → clarify (execute finally restore)
      expect(texts[texts.length - 1]).toBe("Pipeline → clarify");
      // setWorkingMessage should NOT be called (replaced by PipelineUI progress)
      expect(workingMessages).toEqual([]);
    });

    it("pipelineStage:false → no status calls for progress", async () => {
      const config = makeInitConfig();
      (config as any).llmExtract = true;
      (config as any).output = { pipelineStage: false };

      const skillDir = path.join(TMP, ".pi", "skills", "clarify");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );

      const statusCalls: { key: string; text: string | undefined }[] = [];
      const modelCtx = {
        _ctx: {
          modelRegistry: {
            getAvailable: () => [{ name: "test-model", api: "openai" }],
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
          },
          model: { name: "test-model", api: "openai" },
          sessionManager: { getBranch: () => [], getEntries: () => [] },
        },
        ui: {
          setStatus: (key: string, text: string | undefined) => { statusCalls.push({ key, text }); },
        },
      };

      const mockComplete = mock(() =>
        Promise.resolve({
          content: [{ type: "text", text: "[]" }],
          stopReason: "end_turn",
        }),
      );
      mock.module("@earendil-works/pi-ai/compat", () => ({ complete: mockComplete }));

      const cmd = createPipelineInitCommand(config);
      await cmd.execute({ sub: "1" }, modelCtx);

      // pipelineStage:false → no status calls (all PipelineUI methods are no-ops)
      expect(statusCalls).toEqual([]);
    });

    it("llmExtract:false + pipelineStage:true → only setStage init + restore, no animation frames", async () => {
      const config = makeInitConfig();
      (config as any).output = { pipelineStage: true };
      // llmExtract is NOT set (defaults to false)

      const skillDir = path.join(TMP, ".pi", "skills", "clarify");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );

      const statusCalls: { key: string; text: string | undefined }[] = [];
      const ctx = {
        ui: {
          setStatus: (key: string, text: string | undefined) => { statusCalls.push({ key, text }); },
        },
      };

      const cmd = createPipelineInitCommand(config);
      await cmd.execute({ sub: "1" }, ctx);

      // Only setStage("Pipeline → init") + restore setStage("Pipeline → clarify") — no progress animation
      const texts = statusCalls.map(c => c.text);
      expect(texts[0]).toBe("Pipeline → init");
      expect(texts[texts.length - 1]).toBe("Pipeline → clarify");
      // No progress frames with spinner characters — llmExtract is off so no animation
      expect(texts.filter(t => t?.includes("⠋"))).toEqual([]);
    });
  });

  describe("Phase 4 — docs/ directory creation", () => {
    it("dir branch creates docs/ directory when it does not exist", async () => {
      const config = makeInitConfig();
      const docsDir = path.join(TMP, "docs");
      expect(fsSync.existsSync(docsDir)).toBe(false);

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);
      expect(fsSync.existsSync(docsDir)).toBe(true);
      expect(result.content).toContain("docs/: created");
    });

    it("dir branch does not fail when docs/ already exists", async () => {
      const config = makeInitConfig();
      const docsDir = path.join(TMP, "docs");
      await fs.mkdir(docsDir, { recursive: true });
      // Put a file in docs/ to verify it's not overwritten
      await fs.writeFile(path.join(docsDir, "existing.md"), "preserve me", "utf-8");

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);
      expect(fsSync.existsSync(docsDir)).toBe(true);
      expect(result.content).toContain("docs/: already exists");
      // Existing file preserved
      const content = await fs.readFile(path.join(docsDir, "existing.md"), "utf-8");
      expect(content).toBe("preserve me");
    });

    it("summary reflects docs/ creation", async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.summary).toContain("docs/");
    });
  });

  describe("Phase 4 — pipeline-stage-prompt.yml template copy", () => {
    it("dir branch copies pipeline-stage-prompt.yml to .pi/references/", async () => {
      const config = makeInitConfig();
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);
      const targetPath = path.join(TMP, ".pi", "references", "pipeline-stage-prompt.yml");
      expect(fsSync.existsSync(targetPath)).toBe(true);

      // Verify the copied content is valid YAML with expected keys
      const content = await fs.readFile(targetPath, "utf-8");
      expect(content).toContain("clarify:");
      expect(content).toContain("verify_extract:");
    });

    it("skip strategy preserves existing pipeline-stage-prompt.yml (user modifications)", async () => {
      const config = makeInitConfig();

      // Pre-create .pi/references/pipeline-stage-prompt.yml with custom content
      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        "# User-modified content\nclarify: custom\n",
        "utf-8",
      );

      // Also pre-create an agent file to trigger multi-execution (existingCount > 0)
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "feat-design-plan-agent.md"),
        "existing agent",
        "utf-8",
      );

      const cmd = createPipelineInitCommand(config);
      // No UI → defaults to skip strategy
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);
      // User-modified content should be preserved (not overwritten)
      const content = await fs.readFile(path.join(refsDir, "pipeline-stage-prompt.yml"), "utf-8");
      expect(content).toContain("# User-modified content");
      expect(content).toContain("clarify: custom");
    });
  });

  // ─── Phase 0 (146): stripped templates migration ──────────────────────────

  describe("Phase 0 (146): stripped template migration", () => {
    it("new template SKILL files do not contain plugin control keywords after copy", async () => {
      // Create template with stripped SKILL files (no plugin keywords)
      for (const stage of ["develop", "review", "fix"]) {
        const skillDir = path.join(templateDir, "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        // Stripped template: no stage_advance, loop_check, pipeline marker, nextStage
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `## ${stage} business rules\n- **必须** ${stage}-output.md\n`,
          "utf-8",
        );
      }

      const config = makeTestConfig({ projectRoot: TMP });
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);

      // Verify copied SKILL files don't contain plugin keywords
      for (const stage of ["develop", "review", "fix"]) {
        const skillPath = path.join(TMP, ".pi", "skills", stage, "SKILL.md");
        const content = await fs.readFile(skillPath, "utf-8");
        // 163: review SKILL intentionally references stage_advance for reviewConclusion declaration
        if (stage !== "review") {
          expect(content).not.toContain("stage_advance");
        }
        expect(content).not.toContain("loop_check");
        expect(content).not.toContain("nextStage:");
        expect(content).not.toMatch(/pipeline:\s*\{pipelineId\}/);
        // Phase 3: all SKILLs no longer contain **必须** delivery markers (moved to yml)
        // develop uses Template-TODO placeholder for business-specific items
        if (stage === "develop") {
          expect(content).toContain("Template-TODO");
        }
        // All stages: no **必须** delivery markers (now in yml stage_deliverable_{stage})
        expect(content).not.toContain("**必须**");
      }
    });
  });

  // ─── Phase 6 (146): conflict detection ────────────────────────────────────

  describe("Phase 6 (146): conflict detection", () => {
    it("conflictCheck=off skips detection and no conflict output appears", async () => {
      const config = makeTestConfig({
        projectRoot: TMP,
        init: { conflictCheck: "off" },
      });
      // Create .pi/skills with skill files so verify branch runs
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-result.md\n`,
          "utf-8",
        );
      }
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" });
      // conflictCheck=off → no conflict detection output
      expect(result.success).toBe(true);
      expect(result.content).not.toContain("Conflict Detection");
      expect(config.init?.conflictCheck).toBe("off");
    });

    it("conflictCheck=model with unavailable LLM emits TUI hint, not silent (check branch sub=2)", async () => {
      // 147 Phase 5: conflict detection moved from init 1 (verify) to init 2 (check).
      const config = makeTestConfig({
        projectRoot: TMP,
        init: { conflictCheck: "model" },
        llmExtract: false,
      });
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-result.md\n`,
          "utf-8",
        );
      }
      const notifications: string[] = [];
      const mockCtx = { ui: { notify: (m: string) => { notifications.push(m); } } };
      const cmd = createPipelineInitCommand(config);
      // sub="2" → check branch (residue + conflict detection)
      const result: any = await cmd.execute({ sub: "2" }, mockCtx);
      // Model unavailable → TUI hint about degraded conflictCheck
      expect(result.success).toBe(true);
      const hint = notifications.find(n => n.includes("conflictCheck"));
      expect(hint).toBeDefined();
      expect(hint).toContain("off");
    });

    it("init sub=1 (verify) does NOT trigger conflict detection (147 Phase 5)", async () => {
      // init 1 is now pure verify generation — conflict detection moved to sub=2.
      const config = makeTestConfig({
        projectRoot: TMP,
        init: { conflictCheck: "model" },
        llmExtract: false,
      });
      for (const stage of ["plan", "develop"]) {
        const skillDir = path.join(TMP, ".pi", "skills", stage);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `- **Must** ${stage}-result.md\n`,
          "utf-8",
        );
      }
      const notifications: string[] = [];
      const mockCtx = { ui: { notify: (m: string) => { notifications.push(m); } } };
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "1" }, mockCtx);
      expect(result.success).toBe(true);
      // No conflictCheck hint should be emitted by verify branch
      const hint = notifications.find(n => n.includes("conflictCheck"));
      expect(hint).toBeUndefined();
      expect(result.content).not.toContain("Conflict Detection");
    });

    it("JSON config loader resolves audit.promptSnapshot and init.conflictCheck defaults", async () => {
      const { loadJsonConfig, resolvePipelineConfig } = await import("../../core/json-config-loader");
      // Write a minimal pipeline_loop.json with audit/init fields
      const jsonPath = path.join(TMP, "pipeline_loop.json");
      await fs.writeFile(jsonPath, JSON.stringify({
        stages: { clarify: { nextStage: "plan" } },
        audit: { promptSnapshot: "off" },
        init: { conflictCheck: "off" },
      }), "utf-8");
      const json = loadJsonConfig(jsonPath);
      expect(json.audit?.promptSnapshot).toBe("off");
      expect(json.init?.conflictCheck).toBe("off");

      const resolved = resolvePipelineConfig(json, TMP);
      expect(resolved.audit?.promptSnapshot).toBe("off");
      expect(resolved.init?.conflictCheck).toBe("off");
    });

    it("JSON config loader defaults audit.promptSnapshot=full and init.conflictCheck=model", async () => {
      const { loadJsonConfig, resolvePipelineConfig } = await import("../../core/json-config-loader");
      const jsonPath = path.join(TMP, "pipeline_loop_default.json");
      await fs.writeFile(jsonPath, JSON.stringify({
        stages: { clarify: { nextStage: "plan" } },
      }), "utf-8");
      const json = loadJsonConfig(jsonPath);
      const resolved = resolvePipelineConfig(json, TMP);
      expect(resolved.audit?.promptSnapshot).toBe("full");
      expect(resolved.init?.conflictCheck).toBe("model");
    });

    it("DEFAULT_CONFLICT_CHECK_PROMPT is defined and non-empty", async () => {
      const { DEFAULT_CONFLICT_CHECK_PROMPT } = await import("../../constants");
      expect(DEFAULT_CONFLICT_CHECK_PROMPT).toBeDefined();
      expect(typeof DEFAULT_CONFLICT_CHECK_PROMPT).toBe("string");
      expect(DEFAULT_CONFLICT_CHECK_PROMPT.length).toBeGreaterThan(100);
      expect(DEFAULT_CONFLICT_CHECK_PROMPT).toContain("conflict analyzer");
      expect(DEFAULT_CONFLICT_CHECK_PROMPT).toContain("JSON");
    });

    it("getConflictCheckPrompt returns yml value when present", async () => {
      const { getConflictCheckPrompt } = await import("../../core/prompt-config");
      const { resetPromptConfigCache } = await import("../../core/prompt-config");
      resetPromptConfigCache();

      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        "conflict_check_prompt: Custom conflict check prompt\n",
        "utf-8",
      );

      const result = await getConflictCheckPrompt(TMP);
      expect(result).toBe("Custom conflict check prompt");

      resetPromptConfigCache();
    });

    it("getConflictCheckPrompt falls back to DEFAULT when yml missing", async () => {
      const { getConflictCheckPrompt } = await import("../../core/prompt-config");
      const { DEFAULT_CONFLICT_CHECK_PROMPT } = await import("../../constants");
      const { resetPromptConfigCache } = await import("../../core/prompt-config");
      resetPromptConfigCache();

      const result = await getConflictCheckPrompt(TMP);
      expect(result).toBe(DEFAULT_CONFLICT_CHECK_PROMPT);

      resetPromptConfigCache();
    });

    it("getConflictCheckPrompt per-stage fallback chain works", async () => {
      const { getConflictCheckPrompt } = await import("../../core/prompt-config");
      const { resetPromptConfigCache } = await import("../../core/prompt-config");
      resetPromptConfigCache();

      const refsDir = path.join(TMP, ".pi", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "pipeline-stage-prompt.yml"),
        "conflict_check_prompt: Global prompt\nconflict_check_prompt_develop: Develop-specific prompt\n",
        "utf-8",
      );

      // Per-stage lookup: should return per-stage value
      const developResult = await getConflictCheckPrompt(TMP, "develop");
      expect(developResult).toBe("Develop-specific prompt");

      // Other stage falls back to global
      const reviewResult = await getConflictCheckPrompt(TMP, "review");
      expect(reviewResult).toBe("Global prompt");

      resetPromptConfigCache();
    });

    // ─── Phase 5 (147) code-review fix: conflict three-choice interaction tests ─

    it("handleConflictResults: mock callLLM conflict JSON → outputs conflict list + three choices; skip writes no files", async () => {
      // Create .pi/skills/develop/SKILL.md so readSkillBody returns content
      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      const skillContent = "- **Must** develop-output.md\n";
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

      const config = makeTestConfig({
        projectRoot: TMP,
        init: { conflictCheck: "model" },
      });

      // Mock @earendil-works/pi-ai/compat so buildCallLLM succeeds
      const conflictJson = JSON.stringify({
        items: [{
          kind: "conflict",
          skillSnippet: "**Must** develop-output.md",
          pluginSnippet: "plugin instruction",
          reason: "Test conflict between skill and plugin",
          suggestion: "Replace with optimized text",
        }],
      });
      mock.module("@earendil-works/pi-ai/compat", () => ({
        complete: async () => ({
          content: [{ type: "text", text: conflictJson }],
        }),
      }));

      // Mock prompt-config so runConflictCheck gets non-empty plugin segments
      // for the develop stage (other stages return empty → skipped via `continue`).
      mock.module("../../core/prompt-config", () => ({
        loadPromptConfig: async () => ({
          stage_executor_develop: "test executor segment",
        }),
        getConflictCheckPrompt: async () => "Test conflict check prompt",
        resetPromptConfigCache: () => {},
      }));

      const selections = ["skip"];
      let selectIdx = 0;
      const notifications: string[] = [];
      const mockCtx = {
        _ctx: {
          modelRegistry: {
            getAvailable: () => [{ id: "test-model", api: "openai" }],
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
          },
          model: { id: "test-model", api: "openai" },
        },
        ui: {
          notify: (m: string) => { notifications.push(m); },
          select: async (_msg: string, _opts: string[]) => selections[selectIdx++],
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "2" }, mockCtx);

      expect(result.success).toBe(true);
      // Conflict detection output should appear
      expect(result.content).toContain("Conflict Detection");
      expect(result.content).toContain("1 issue(s)");
      // SKILL file should NOT be modified (skip path)
      const afterContent = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
      expect(afterContent).toBe(skillContent);
      // Skip message should appear
      expect(result.content).toContain("skipped by user");
    });

    it("handleConflictResults: auto-optimize + confirm → writes modified SKILL + backup", async () => {
      // SKILL.md with a known snippet that the mock LLM will suggest replacing
      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      const originalContent = "- **Must** develop-output.md\n- **Must** extra-rule.md\n";
      await fs.writeFile(path.join(skillDir, "SKILL.md"), originalContent, "utf-8");

      const config = makeTestConfig({
        projectRoot: TMP,
        init: { conflictCheck: "model" },
      });

      // Mock callLLM to return a conflict suggesting replacement
      const conflictJson = JSON.stringify({
        items: [{
          kind: "conflict",
          skillSnippet: "**Must** develop-output.md",
          pluginSnippet: "plugin instruction",
          reason: "Test conflict",
          suggestion: "**Must** plugin-optimized-output.md",
        }],
      });
      mock.module("@earendil-works/pi-ai/compat", () => ({
        complete: async () => ({
          content: [{ type: "text", text: conflictJson }],
        }),
      }));

      mock.module("../../core/prompt-config", () => ({
        loadPromptConfig: async () => ({
          stage_executor_develop: "test executor segment",
        }),
        getConflictCheckPrompt: async () => "Test conflict check prompt",
        resetPromptConfigCache: () => {},
      }));

      const selections = ["auto-optimize", "yes"];
      let selectIdx = 0;
      const notifications: string[] = [];
      const mockCtx = {
        _ctx: {
          modelRegistry: {
            getAvailable: () => [{ id: "test-model", api: "openai" }],
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
          },
          model: { id: "test-model", api: "openai" },
        },
        ui: {
          notify: (m: string) => { notifications.push(m); },
          select: async (_msg: string, _opts: string[]) => selections[selectIdx++],
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "2" }, mockCtx);

      expect(result.success).toBe(true);
      expect(result.content).toContain("Conflict Detection");

      // SKILL file should be modified (snippet replaced with suggestion)
      const afterContent = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
      expect(afterContent).toContain("plugin-optimized-output.md");
      expect(afterContent).not.toContain("develop-output.md");

      // Backup file should exist (.bak-<timestamp>)
      const dirEntries = await fs.readdir(skillDir);
      const backupFile = dirEntries.find(e => e.startsWith("SKILL.md.bak-"));
      expect(backupFile).toBeDefined();

      // Auto-optimize message should appear
      expect(result.content).toContain("Auto-optimize");
    });
  });

  // ─── Phase 5 (147): check branch (sub="2") ──────────────────────────────

  describe("Phase 5 (147): check branch (sub=\"2\")", () => {
    it("sub=2 with residues → content lists hits, gate status NOT written", async () => {
      const config = makeTestConfig({ projectRoot: TMP, init: { conflictCheck: "off" } });
      // Create a template with Template-TODO placeholders
      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "## Deliverables\n<!-- Template-TODO: 补充业务交付项 -->\n- **Template-TODO**: 补充项目特有的业务交付项\n",
        "utf-8",
      );
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "2" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("RESIDUES FOUND");
      expect(result.content).toContain(".pi/skills/develop/SKILL.md");
      expect(result.content).toContain("Template-TODO");
      // Gate status file should not exist (residues → cleared)
      const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
      expect(fsSync.existsSync(statusPath)).toBe(false);
    });

    it("sub=2 clean → writes gate status with passed=true and fingerprint", async () => {
      const config = makeTestConfig({ projectRoot: TMP, init: { conflictCheck: "off" } });
      // Create a clean template (no Template-TODO)
      const skillDir = path.join(TMP, ".pi", "skills", "develop");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "## Deliverables\n- **必须** run build\n",
        "utf-8",
      );
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "2" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("ALL CLEAR");
      // Gate status file should exist with passed=true
      const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
      expect(fsSync.existsSync(statusPath)).toBe(true);
      const statusContent = JSON.parse(await fs.readFile(statusPath, "utf-8"));
      expect(statusContent.passed).toBe(true);
      expect(typeof statusContent.fingerprint).toBe("string");
      expect(typeof statusContent.checkedAt).toBe("string");
    });

    it("migration smoke: init 0 distributes → init 2 detects residues → fix → clean", async () => {
      // Simulate migration of an existing project: run init 0 (distributes new
      // templates with Template-TODO markers) → init 2 should detect residues →
      // user fixes templates → init 2 should pass and write gate status.
      const config = makeTestConfig({ projectRoot: TMP, init: { conflictCheck: "off" } });
      const cmd = createPipelineInitCommand(config);

      // Step 1: init 0 distributes templates
      const init0: any = await cmd.execute({ sub: "0" });
      expect(init0.success).toBe(true);
      expect(init0.content).toContain("pipeline-init 2");

      // Step 2: init 2 detects residues (the newly distributed templates have Template-TODO)
      const init2a: any = await cmd.execute({ sub: "2" });
      expect(init2a.success).toBe(true);
      expect(init2a.content).toContain("RESIDUES FOUND");
      // Gate status should NOT be written when residues exist
      const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
      expect(fsSync.existsSync(statusPath)).toBe(false);

      // Step 3: "user" replaces Template-TODO placeholders with real content
      // Iterate all SKILL files in .pi/skills/*/SKILL.md + agents/*.md
      const skillsRoot = path.join(TMP, ".pi", "skills");
      if (fsSync.existsSync(skillsRoot)) {
        for (const stageDir of await fs.readdir(skillsRoot)) {
          const skillFile = path.join(skillsRoot, stageDir, "SKILL.md");
          if (!fsSync.existsSync(skillFile)) continue;
          let content = await fs.readFile(skillFile, "utf-8");
          content = content.replace(/Template-TODO/g, "项目业务交付项");
          await fs.writeFile(skillFile, content, "utf-8");
        }
      }
      const agentsDir = path.join(TMP, ".pi", "agents");
      if (fsSync.existsSync(agentsDir)) {
        for (const agentFile of await fs.readdir(agentsDir)) {
          if (!agentFile.endsWith(".md")) continue;
          const agentPath = path.join(agentsDir, agentFile);
          let content = await fs.readFile(agentPath, "utf-8");
          content = content.replace(/Template-TODO/g, "资深工程师");
          await fs.writeFile(agentPath, content, "utf-8");
        }
      }

      // Step 4: init 2 should now pass and write gate status
      const init2b: any = await cmd.execute({ sub: "2" });
      expect(init2b.success).toBe(true);
      expect(init2b.content).toContain("ALL CLEAR");
      expect(fsSync.existsSync(statusPath)).toBe(true);
      const status = JSON.parse(await fs.readFile(statusPath, "utf-8"));
      expect(status.passed).toBe(true);
    });

    it("sub=0 first-time distribution clears gate status and includes hint", async () => {
      // Pre-write a stale passed gate status
      const auditDir = path.join(TMP, ".pi", "audit");
      await fs.mkdir(auditDir, { recursive: true });
      await fs.writeFile(
        path.join(auditDir, "template-residue-check.json"),
        JSON.stringify({ passed: true, checkedAt: "2020-01-01", fingerprint: "stale" }),
        "utf-8",
      );

      // Ensure TEMPLATE_DIR exists (uses real src/template via dist/)
      const config = makeTestConfig({ projectRoot: TMP });
      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);
      // Stale gate status should be cleared
      const statusPath = path.join(TMP, ".pi", "audit", "template-residue-check.json");
      expect(fsSync.existsSync(statusPath)).toBe(false);
      // Content should include hint
      expect(result.content).toContain("pipeline-init 2");
    });
  });
});

// Need to import PipelineConfig type for the Phase 0 tests
import type { PipelineConfig } from "../../types";

describe("Phase 6 (162): template confirm config", () => {
  it("real template pipeline_loop.json contains plan/review confirm manual mode", async () => {
    // Read the real template file from dist/ (build output)
    const distPath = path.join(process.cwd(), "dist", "template", "pipeline_loop.json");
    const content = await fs.readFile(distPath, "utf-8");
    const parsed = JSON.parse(content);

    // Verify plan stage has confirm.mode = "manual"
    expect(parsed.stages?.plan?.confirm?.mode).toBe("manual");
    // Verify review stage has confirm.mode = "manual"
    expect(parsed.stages?.review?.confirm?.mode).toBe("manual");
    // Verify global confirmOverflow
    expect(parsed.confirmOverflow).toBe("ask");
  });

  it("template confirm config is parseable by json-config-loader", async () => {
    const { resolvePipelineConfig } = await import("../../core/json-config-loader");
    const distPath = path.join(process.cwd(), "dist", "template", "pipeline_loop.json");
    const content = await fs.readFile(distPath, "utf-8");
    const raw = JSON.parse(content);

    const config = resolvePipelineConfig(raw, process.cwd());
    expect(config.stages.plan.confirm?.mode).toBe("manual");
    expect(config.stages.review.confirm?.mode).toBe("manual");
    expect(config.confirmOverflow).toBe("ask");
    // Default maxConfirmRejections should be 5
    expect(config.maxConfirmRejections).toBe(5);
  });
});
