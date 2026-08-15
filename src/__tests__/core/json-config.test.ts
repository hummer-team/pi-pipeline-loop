import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { loadJsonConfig, resolvePipelineConfig } from "../../core/json-config-loader";
import type { PipelineJsonConfig } from "../../types";

let TMP: string;
let jsonPath: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-json-cfg-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
  jsonPath = path.join(TMP, "pipeline_loop.json");
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

async function writeJson(obj: unknown) {
  await fs.writeFile(jsonPath, JSON.stringify(obj, null, 2), "utf-8");
}

describe("loadJsonConfig", () => {
  it("parses a minimal pipeline_loop.json", async () => {
    await writeJson({ stages: { clarify: { nextStage: "plan" } } });
    const result = loadJsonConfig(jsonPath);
    expect(result.stages.clarify).toBeDefined();
    expect(result.stages.clarify!.nextStage).toBe("plan");
  });

  it("fills defaults for missing top-level fields", async () => {
    await writeJson({ stages: { clarify: {} } });
    const result = loadJsonConfig(jsonPath);
    expect(result.projectRoot).toBeUndefined();
    expect(result.maxLoops).toBeUndefined();
  });

  it("throws on invalid JSON", async () => {
    await fs.writeFile(jsonPath, "not json", "utf-8");
    expect(() => loadJsonConfig(jsonPath)).toThrow("Invalid JSON");
  });

  it("throws when stages is missing", async () => {
    await writeJson({});
    expect(() => loadJsonConfig(jsonPath)).toThrow("must contain a \"stages\" object");
  });

  it("throws when stages is not an object", async () => {
    await writeJson({ stages: "bad" });
    expect(() => loadJsonConfig(jsonPath)).toThrow("must contain a \"stages\" object");
  });

  it("warns on unknown stage names", async () => {
    await writeJson({ stages: { foo: {} } });
    loadJsonConfig(jsonPath);
  });
});

describe("resolvePipelineConfig", () => {
  it("default skillPath is relative to .pi/skills/ (no double prefix)", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {}, develop: {} },
    };
    const result = resolvePipelineConfig(json);
    // DEFAULT_SKILL_PATH is "{stage}/SKILL.md" — relative to .pi/skills/
    expect(result.stages.clarify.skillPath).toBe("clarify/SKILL.md");
    expect(result.stages.develop.skillPath).toBe("develop/SKILL.md");
    // Must NOT contain the .pi/skills/ prefix (consumers prepend it)
    expect(result.stages.clarify.skillPath).not.toContain(".pi/skills/");
  });

  it("fills all 7 stages with defaults (even missing ones)", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { nextStage: "plan" }, plan: {} },
    };
    const result = resolvePipelineConfig(json);
    // plan is the next stage for clarify
    expect(result.stages.clarify.nextStage).toBe("plan");
    expect(result.stages.clarify.agentFile).toContain("clarify");
    expect(result.stages.clarify.skillPath).toContain("clarify");
    // All 7 stages present
    expect(result.stages.clarify).toBeDefined();
    expect(result.stages.plan).toBeDefined();
    expect(result.stages.develop).toBeDefined();
    expect(result.stages.review).toBeDefined();
    expect(result.stages.fix).toBeDefined();
    expect(result.stages.awaiting_human).toBeDefined();
    expect(result.stages.completed).toBeDefined();
  });

  it("uses clarify/plan defaults for read-only stages", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.allowedTools).toEqual(["read", "bash", "stage_advance"]);
    expect(result.stages.clarify.allowedBashPrefixes).toEqual([
      "ls",
      "cat",
      "find",
      "git log",
    ]);
    expect(result.stages.clarify.requireDomain).toBe(false);
  });

  it("uses develop/fix defaults for read-write stages", () => {
    const json: PipelineJsonConfig = { stages: { develop: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.stages.develop.allowedTools).toContain("write");
    expect(result.stages.develop.allowedTools).toContain("edit");
    expect(result.stages.develop.allowedBashPrefixes).toContain("npm test");
    expect(result.stages.develop.allowedBashPrefixes).toContain("bun test");
  });

  it("preserves user-specified values over defaults", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: {
          agentFile: "custom/agent.md",
          allowedTools: ["read"],
          nextStage: "plan",
        },
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.agentFile).toBe("custom/agent.md");
    expect(result.stages.clarify.allowedTools).toEqual(["read"]);
  });

  it("handles require: false by creating empty config for that stage", () => {
    const json: PipelineJsonConfig = {
      stages: { plan: { require: false } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.plan.allowedTools).toEqual([]);
    expect(result.stages.plan.requireDomain).toBe(false);
  });

  it("throws on unknown nextStage reference", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { nextStage: "nonexistent" as any } },
    };
    expect(() => resolvePipelineConfig(json)).toThrow("references unknown nextStage");
  });

  it("allows circular references (fix → develop)", () => {
    const json: PipelineJsonConfig = {
      stages: {
        develop: { nextStage: "review" },
        review: { nextStage: "fix" },
        fix: { nextStage: "develop" },
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.fix.nextStage).toBe("develop");
  });

  it("fills global defaults (projectRoot, auditDir, maxLoops, maxLoopCycles)", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.projectRoot).toBe(process.cwd());
    expect(result.auditDir).toBe(".pi/audit");
    expect(result.domainDir).toBe(".pi/domains");
    expect(result.maxLoops).toBe(3);
    expect(result.maxLoopCycles).toBe(3);
  });

  it("fills verify config defaults", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { verify: {} } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.verify).toBeDefined();
    expect(result.stages.clarify.verify!.require).toBe(true);
    expect(result.stages.clarify.verify!.verifyFile).toContain(
      "clarify_spec/verify.md",
    );
  });

  it("verify.mode defaults to 'hook' when not specified", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { verify: {} } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.verify!.mode).toBe("hook");
  });

  it("verify.mode 'tool' is parsed correctly", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { verify: { mode: "tool" } } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.verify!.mode).toBe("tool");
  });

  it("verify.mode invalid value falls back to 'hook' with warning", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { verify: { mode: "invalid" as any } } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.verify!.mode).toBe("hook");
  });

  it("Case A: require:false reconnects to next active stage", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { nextStage: "plan" },
        plan: { require: false },
        develop: {},
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.nextStage).toBe("develop");
    expect(result.stages.plan.nextStage).toBeNull();
  });

  it("Case B: stage missing from config is treated as disabled", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { nextStage: "plan" },
        plan: { nextStage: "develop" },
        develop: { nextStage: "review" },
        fix: {},
      },
    };
    const result = resolvePipelineConfig(json);
    // review not in config → disabled → develop.nextStage resolves to fix
    expect(result.stages.develop.nextStage).toBe("fix");
  });

  it("Case C: two consecutive disabled stages are both skipped", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { nextStage: "plan" },
        plan: { require: false },
        develop: { require: false },
        review: {},
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.nextStage).toBe("review");
  });

  it("Case D: only one active stage → nextStage resolves to null", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { nextStage: "plan" },
        plan: { require: false },
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.nextStage).toBeNull();
  });

  it("Case E: single active stage in config terminates correctly", () => {
    const json: PipelineJsonConfig = {
      stages: {
        develop: { nextStage: "review" },
      },
    };
    const result = resolvePipelineConfig(json);
    // review is not in config → disabled → develop.nextStage resolves to null
    expect(result.stages.develop.nextStage).toBeNull();
  });
});

describe("output.pipelineStage config", () => {
  it("loadJsonConfig parses output.pipelineStage: true", async () => {
    await writeJson({
      stages: { clarify: {} },
      output: { pipelineStage: true },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.output).toBeDefined();
    expect(result.output!.pipelineStage).toBe(true);
  });

  it("resolvePipelineConfig defaults output.pipelineStage to true", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.output!.pipelineStage).toBe(true);
  });

  it("resolvePipelineConfig passes through output.pipelineStage: true", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      output: { pipelineStage: true },
    };
    const result = resolvePipelineConfig(json);
    expect(result.output!.pipelineStage).toBe(true);
  });

  it("resolvePipelineConfig falls back to true for invalid output.pipelineStage", async () => {
    await writeJson({
      stages: { clarify: {} },
      output: { pipelineStage: "yes" },
    });
    // loadJsonConfig should warn + ignore the invalid value
    const loaded = loadJsonConfig(jsonPath);
    // resolvePipelineConfig should default to true
    const result = resolvePipelineConfig(loaded);
    expect(result.output!.pipelineStage).toBe(true);
  });
});

describe("llmExtract config", () => {
  it("resolvePipelineConfig defaults llmExtract to false", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.llmExtract).toBe(false);
  });

  it("resolvePipelineConfig preserves llmExtract: true", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      llmExtract: true,
    };
    const result = resolvePipelineConfig(json);
    expect(result.llmExtract).toBe(true);
  });

  it("loadJsonConfig parses llmExtract from JSON", async () => {
    await writeJson({
      stages: { clarify: {} },
      llmExtract: true,
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.llmExtract).toBe(true);
  });

  it("loadJsonConfig ignores non-boolean llmExtract", async () => {
    await writeJson({
      stages: { clarify: {} },
      llmExtract: "yes",
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.llmExtract).toBeUndefined();
  });
});

describe("protect config", () => {
  it("loadJsonConfig parses protect with all three fields", async () => {
    await writeJson({
      stages: { clarify: {} },
      protect: {
        gitignore: false,
        paths: ["dist/", "build/"],
        allow: ["docs/", "src/template/"],
      },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.protect).toBeDefined();
    expect(result.protect!.gitignore).toBe(false);
    expect(result.protect!.paths).toEqual(["dist/", "build/"]);
    expect(result.protect!.allow).toEqual(["docs/", "src/template/"]);
  });

  it("resolvePipelineConfig defaults protect to { gitignore: true, paths: [], allow: [] }", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.protect).toBeDefined();
    expect(result.protect!.gitignore).toBe(true);
    expect(result.protect!.paths).toEqual([]);
    expect(result.protect!.allow).toEqual([]);
  });

  it("resolvePipelineConfig preserves user-specified protect values", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      protect: {
        gitignore: false,
        paths: ["custom/"],
        allow: ["allowed/"],
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.protect!.gitignore).toBe(false);
    expect(result.protect!.paths).toEqual(["custom/"]);
    expect(result.protect!.allow).toEqual(["allowed/"]);
  });

  it("resolvePipelineConfig merges partial protect with defaults", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      protect: { paths: ["dist/"] },
    };
    const result = resolvePipelineConfig(json);
    expect(result.protect!.gitignore).toBe(true); // default
    expect(result.protect!.paths).toEqual(["dist/"]);
    expect(result.protect!.allow).toEqual([]); // default
  });

  it("loadJsonConfig ignores non-boolean protect.gitignore", async () => {
    await writeJson({
      stages: { clarify: {} },
      protect: { gitignore: "yes" },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.protect!.gitignore).toBeUndefined();
  });

  it("loadJsonConfig ignores non-string[] protect.paths", async () => {
    await writeJson({
      stages: { clarify: {} },
      protect: { paths: "not-an-array" },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.protect!.paths).toBeUndefined();
  });

  it("loadJsonConfig ignores non-string[] protect.allow", async () => {
    await writeJson({
      stages: { clarify: {} },
      protect: { allow: [123, 456] },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.protect!.allow).toBeUndefined();
  });

  it("loadJsonConfig ignores non-object protect", async () => {
    await writeJson({
      stages: { clarify: {} },
      protect: "invalid",
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.protect).toBeUndefined();
  });
});

describe("maxVerifyAttempts config", () => {
  it("loadJsonConfig parses maxVerifyAttempts from JSON", async () => {
    await writeJson({
      stages: { clarify: {} },
      maxVerifyAttempts: 5,
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.maxVerifyAttempts).toBe(5);
  });

  it("loadJsonConfig ignores non-number maxVerifyAttempts", async () => {
    await writeJson({
      stages: { clarify: {} },
      maxVerifyAttempts: "five",
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.maxVerifyAttempts).toBeUndefined();
  });

  it("resolvePipelineConfig defaults maxVerifyAttempts to 3", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.maxVerifyAttempts).toBe(3);
  });

  it("resolvePipelineConfig defaults maxVerifyAttempts to maxLoops when maxLoops is set", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      maxLoops: 5,
    };
    const result = resolvePipelineConfig(json);
    expect(result.maxVerifyAttempts).toBe(5);
  });

  it("resolvePipelineConfig prefers maxVerifyAttempts over maxLoops", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      maxLoops: 5,
      maxVerifyAttempts: 10,
    };
    const result = resolvePipelineConfig(json);
    expect(result.maxVerifyAttempts).toBe(10);
  });
});

describe("decisionShortcutKey config", () => {
  it("loadJsonConfig parses valid decisionShortcutKey from JSON", async () => {
    await writeJson({
      stages: { clarify: {} },
      decisionShortcutKey: "ctrl+shift+d",
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.decisionShortcutKey).toBe("ctrl+shift+d");
  });

  it("loadJsonConfig ignores non-string decisionShortcutKey", async () => {
    await writeJson({
      stages: { clarify: {} },
      decisionShortcutKey: 42,
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.decisionShortcutKey).toBeUndefined();
  });

  it("resolvePipelineConfig defaults decisionShortcutKey to 'ctrl+d'", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+d");
  });

  it("resolvePipelineConfig accepts valid decisionShortcutKey", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "alt+x",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("alt+x");
  });

  it("resolvePipelineConfig falls back to 'ctrl+d' for invalid decisionShortcutKey", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "INVALID_KEY!!!",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+d");
  });

  it("resolvePipelineConfig falls back to 'ctrl+d' for empty string", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+d");
  });
});
