import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
    expect(cmd.name).toBe("pipeline_init");
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
      expect(result.content).toContain("# pipeline_init — .pi/ directory setup");
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

    it("option 3 (verifyAfter) merges dir + verify content (both sections present)", async () => {
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
      // Dir section present
      expect(result.content).toContain(".pi/ directory setup");
      // Verify section present
      expect(result.content).toContain("verify.md generation");
    });
  });
});
