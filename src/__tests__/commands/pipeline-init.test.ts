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
  for (const stage of ["design", "plan", "develop", "review", "fix"]) {
    const skillDir = path.join(dir, "skills", stage);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `- **Must** ${stage}-output.md\n`,
      "utf-8",
    );
  }

  // agents
  for (const stage of ["clarify", "design", "plan", "develop", "review", "fix"]) {
    const agentDir = path.join(dir, "agents", stage);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, `${stage}.md`), `# ${stage} agent\n`, "utf-8");
  }

  // guide.md
  await fs.writeFile(path.join(dir, "guide.md"), "# Guide\n", "utf-8");

  // pipeline_loop.json
  await fs.writeFile(
    path.join(dir, "pipeline_loop.json"),
    JSON.stringify({ stages: { clarify: { nextStage: "design" } } }),
    "utf-8",
  );
}

/** Helper to create a config pointing to the test directory */
function makeInitConfig() {
  return makeTestConfig({
    projectRoot: TMP,
    stages: Object.fromEntries(
      ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
        (s, i, a) => [
          s,
          {
            agentFile: `.pi/agents/${s}/${s}.md`,
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
      for (const stage of ["design", "develop"]) {
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

      // Pre-create some .pi files so existingCount > 0
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(path.join(piDir, "skills", "design", "SKILL.md"), "existing", "utf-8");

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
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(path.join(piDir, "skills", "design", "SKILL.md"), "existing", "utf-8");

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
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(path.join(piDir, "skills", "design", "SKILL.md"), "existing", "utf-8");

      const ctx = {
        ui: {
          select: async (): Promise<string> => "4. 取消",
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

      // Pre-create some .pi files to trigger skip strategy
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(path.join(piDir, "skills", "design", "SKILL.md"), "existing", "utf-8");

      const cmd = createPipelineInitCommand(config);
      // No UI → defaults to skip strategy
      const result: any = await cmd.execute({ sub: "0" });

      expect(result.success).toBe(true);
      expect(result.content).toContain("Skipped files:");
      expect(result.content).toContain(".pi/skills/design/SKILL.md");
    });

    it("cancel branch returns content with 'cancelled'", async () => {
      const config = makeInitConfig();

      // Pre-create files to trigger multi-execution detection
      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(path.join(piDir, "skills", "design", "SKILL.md"), "existing", "utf-8");

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
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "design", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );
      await fs.mkdir(path.join(piDir, "agents", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "clarify", "clarify.md"),
        "existing agent",
        "utf-8",
      );

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3. 重新执行 verify 生成",
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);

      // Verify branch should have run and generated design verify.md
      expect(result.success).toBe(true);
      expect(
        fsSync.existsSync(path.join(TMP, ".pi", "references", "design_spec", "verify.md")),
      ).toBe(true);
    });

    it("runs verify generation after option 3 numeric fallback selected", async () => {
      const config = makeInitConfig();

      const piDir = path.join(TMP, ".pi");
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "design", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );
      await fs.mkdir(path.join(piDir, "agents", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "clarify", "clarify.md"),
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
        fsSync.existsSync(path.join(TMP, ".pi", "references", "design_spec", "verify.md")),
      ).toBe(true);
    });
  });

  describe("Phase 1 — verify branch content and combined merge", () => {
    it('sub="1" with successful generation returns content with generated count and verify.md path', async () => {
      const config = makeInitConfig();

      // Create .pi/skills with skill files
      for (const stage of ["design", "develop"]) {
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
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "design", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );
      await fs.mkdir(path.join(piDir, "agents", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "clarify", "clarify.md"),
        "existing agent",
        "utf-8",
      );

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3. 重新执行 verify 生成",
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

    it("output.pipelineStage: true — command-level no longer calls setStatus", async () => {
      const config = makeInitConfig();
      // Override output to enable pipelineStage
      (config as any).output = { pipelineStage: true };

      const { ctx, statusCalls } = makeUICtx();
      const cmd = createPipelineInitCommand(config);
      await cmd.execute({ sub: "1" }, ctx);

      // Command-level stageEntry/clearStage removed — no status bar calls from the command
      expect(statusCalls).toEqual([]);
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

      // Pre-create a skill file to trigger multi-execution detection (existingCount > 0)
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "design", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );

      // Note: agents/clarify/clarify.md does NOT exist — option 3 should NOT copy it

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3. 重新执行 verify 生成",
        },
      };

      const cmd = createPipelineInitCommand(config);
      const result: any = await cmd.execute({ sub: "0" }, ctx);

      expect(result.success).toBe(true);

      // guide.md should NOT have been overwritten (still old content)
      const guideContent = await fs.readFile(path.join(piDir, "guide.md"), "utf-8");
      expect(guideContent).toBe("# OLD Guide Content\n");

      // agents/clarify/clarify.md should NOT have been copied (option 3 does no file copy)
      expect(
        fsSync.existsSync(path.join(piDir, "agents", "clarify", "clarify.md")),
      ).toBe(false);

      // verify.md should still be generated (verify ran)
      expect(
        fsSync.existsSync(path.join(TMP, ".pi", "references", "design_spec", "verify.md")),
      ).toBe(true);
    });

    it("zero-result hint: sub=1 with all skills present but no Must markers shows marker hint", async () => {
      const config = makeInitConfig();

      // Create .pi/skills with SKILL.md that has NO Must markers — ALL stages
      for (const stage of ["clarify", "design", "plan", "develop", "review", "fix"]) {
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
      for (const stage of ["design", "develop"]) {
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
      await fs.mkdir(path.join(piDir, "skills", "design"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "skills", "design", "SKILL.md"),
        "- **Must** design-output.md\n",
        "utf-8",
      );
      await fs.mkdir(path.join(piDir, "agents", "clarify"), { recursive: true });
      await fs.writeFile(
        path.join(piDir, "agents", "clarify", "clarify.md"),
        "existing agent",
        "utf-8",
      );

      const ctx = {
        ui: {
          select: async (): Promise<string> => "3. 重新执行 verify 生成",
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
        fsSync.existsSync(path.join(TMP, ".pi", "references", "design_spec", "verify.md")),
      ).toBe(true);
    });
  });

  describe("Phase 2 — llmExtract TUI/audit observability", () => {
    it("llmExtract: off → TUI shows 'llmExtract: off' and no per-stage llm detail", async () => {
      const config = makeInitConfig();

      // Create .pi/skills with Must markers
      for (const stage of ["design"]) {
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
      for (const stage of ["design"]) {
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
      const skillDir = path.join(TMP, ".pi", "skills", "design");
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
      const skillDir = path.join(TMP, ".pi", "skills", "design");
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
      for (const stage of ["design", "develop"]) {
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
      for (const stage of ["design"]) {
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
      const designResult = result.results?.find((r: any) => r.stage === "design");
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
      const designResult = result.results?.find((r: any) => r.stage === "design");
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
      const designResult = result.results?.find((r: any) => r.stage === "design");
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
      const designResult = result.results?.find((r: any) => r.stage === "design");
      expect(designResult).toBeDefined();
      expect(designResult.llmStatus).toBe("fail");
      // Hardcoded items fallback still generates verify
      expect(designResult.status).toBe("generated");
    });
  });
});

// Need to import PipelineConfig type for the Phase 0 tests
import type { PipelineConfig } from "../../types";
