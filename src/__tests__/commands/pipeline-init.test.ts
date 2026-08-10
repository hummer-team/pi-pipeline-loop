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
});
