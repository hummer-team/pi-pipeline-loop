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
    // agentPath is transparent — no default fallback; undefined when not configured
    expect(result.stages.clarify.agentPath).toBeUndefined();
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
    // Read-only stages: allowedWritePaths defaults to doc directories
    expect(result.stages.clarify.allowedWritePaths).toEqual([
      "docs/",
      "doc/",
      "documentation/",
    ]);
    expect(result.stages.clarify.requireDomain).toBe(false);
  });

  it("uses develop/fix defaults for read-write stages", () => {
    const json: PipelineJsonConfig = { stages: { develop: {} } };
    const result = resolvePipelineConfig(json);
    // Read-write stages: allowedWritePaths defaults to full access
    expect(result.stages.develop.allowedWritePaths).toEqual(["**"]);
  });

  it("preserves user-specified values over defaults", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: {
          agentPath: "custom/agent.md",
          allowedWritePaths: ["custom/"],
          nextStage: "plan",
        },
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.agentPath).toBe("custom/agent.md");
    expect(result.stages.clarify.allowedWritePaths).toEqual(["custom/"]);
  });

  it("handles require: false by creating empty config for that stage", () => {
    const json: PipelineJsonConfig = {
      stages: { plan: { require: false } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.plan.allowedWritePaths).toEqual([]);
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

  it("verify.selfVerifySkip defaults to false", () => {
    const json: PipelineJsonConfig = {
      stages: { develop: { verify: {} } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.develop.verify!.selfVerifySkip).toBe(false);
  });

  it("verify.selfVerifySkip is parsed from JSON", async () => {
    await writeJson({
      stages: { develop: { verify: { selfVerifySkip: true } } },
    });
    const loaded = loadJsonConfig(jsonPath);
    expect(loaded.stages.develop!.verify!.selfVerifySkip).toBe(true);
    const result = resolvePipelineConfig(loaded);
    expect(result.stages.develop.verify!.selfVerifySkip).toBe(true);
  });

  it("verify.selfVerifySkip false is preserved when explicitly set", () => {
    const json: PipelineJsonConfig = {
      stages: { develop: { verify: { selfVerifySkip: false } } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.develop.verify!.selfVerifySkip).toBe(false);
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

  it("resolvePipelineConfig defaults protect to { gitignore: true, paths: [], allow: [], ask: false }", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.protect).toBeDefined();
    expect(result.protect!.gitignore).toBe(true);
    expect(result.protect!.paths).toEqual([]);
    expect(result.protect!.allow).toEqual([]);
    expect(result.protect!.ask).toBe(false);
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
    expect(result.protect!.ask).toBe(false); // default
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

  it("loadJsonConfig parses protect.ask: true", async () => {
    await writeJson({
      stages: { clarify: {} },
      protect: { ask: true },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.protect!.ask).toBe(true);
  });

  it("loadJsonConfig ignores non-boolean protect.ask", async () => {
    await writeJson({
      stages: { clarify: {} },
      protect: { ask: "yes" },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.protect!.ask).toBeUndefined();
  });

  it("resolvePipelineConfig defaults protect.ask to false", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.protect!.ask).toBe(false);
  });

  it("resolvePipelineConfig preserves protect.ask: true", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      protect: { ask: true },
    };
    const result = resolvePipelineConfig(json);
    expect(result.protect!.ask).toBe(true);
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

  it("resolvePipelineConfig defaults decisionShortcutKey to 'ctrl+enter'", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+enter");
  });

  it("resolvePipelineConfig accepts valid decisionShortcutKey", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "alt+x",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("alt+x");
  });

  it("resolvePipelineConfig accepts 'ctrl+enter' (new default, multi-char SpecialKey)", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "ctrl+enter",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+enter");
  });

  it("resolvePipelineConfig falls back to 'ctrl+enter' for invalid decisionShortcutKey", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "INVALID_KEY!!!",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+enter");
  });

  it("resolvePipelineConfig falls back to 'ctrl+enter' for empty string", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+enter");
  });

  // Regression: multi-modifier combos (Medium #4)
  it("resolvePipelineConfig accepts multi-modifier combo 'ctrl+shift+d'", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "ctrl+shift+d",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+shift+d");
  });

  it("resolvePipelineConfig accepts multi-modifier combo 'alt+shift+x'", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "alt+shift+x",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("alt+shift+x");
  });

  it("resolvePipelineConfig accepts 'ctrl+shift+alt+d' (triple modifier)", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "ctrl+shift+alt+d",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+shift+alt+d");
  });

  it("resolvePipelineConfig rejects 'ctrl+' (modifier without key)", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "ctrl+",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+enter");
  });

  it("resolvePipelineConfig rejects 'ctrl+foo' (arbitrary multi-char not in SpecialKey whitelist)", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "ctrl+foo",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+enter");
  });

  it("resolvePipelineConfig accepts SpecialKey 'alt+tab'", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "alt+tab",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("alt+tab");
  });

  it("resolvePipelineConfig accepts function key 'ctrl+f1'", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "ctrl+f1",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("ctrl+f1");
  });

  it("resolvePipelineConfig accepts function key 'shift+f12'", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      decisionShortcutKey: "shift+f12",
    };
    const result = resolvePipelineConfig(json);
    expect(result.decisionShortcutKey).toBe("shift+f12");
  });
});

describe("stage allowedWritePaths config", () => {
  it("resolvePipelineConfig uses stage-type default for clarify (docs multi-candidate)", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.allowedWritePaths).toEqual([
      "docs/",
      "doc/",
      "documentation/",
    ]);
  });

  it("resolvePipelineConfig uses stage-type default for develop (full access)", () => {
    const json: PipelineJsonConfig = { stages: { develop: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.stages.develop.allowedWritePaths).toEqual(["**"]);
  });

  it("resolvePipelineConfig uses stage-type default for fix (full access)", () => {
    const json: PipelineJsonConfig = { stages: { fix: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.stages.fix.allowedWritePaths).toEqual(["**"]);
  });

  it("resolvePipelineConfig uses stage-type default for review (docs multi-candidate)", () => {
    const json: PipelineJsonConfig = { stages: { review: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.stages.review.allowedWritePaths).toEqual([
      "docs/",
      "doc/",
      "documentation/",
    ]);
  });

  it("resolvePipelineConfig explicit config overrides default", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { allowedWritePaths: ["src/"] } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.allowedWritePaths).toEqual(["src/"]);
  });

  it("resolvePipelineConfig disabled stage gets empty allowedWritePaths", () => {
    const json: PipelineJsonConfig = {
      stages: { plan: { require: false } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.plan.allowedWritePaths).toEqual([]);
  });

  it("loadJsonConfig parses allowedWritePaths from JSON", async () => {
    await writeJson({
      stages: { clarify: { allowedWritePaths: ["custom/"] } },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.stages.clarify!.allowedWritePaths).toEqual(["custom/"]);
  });

  it("resolvePipelineConfig warns and ignores non-array allowedWritePaths", async () => {
    await writeJson({
      stages: { clarify: { allowedWritePaths: "not-an-array" } },
    });
    const loaded = loadJsonConfig(jsonPath);
    const result = resolvePipelineConfig(loaded);
    // Invalid → falls back to stage-type default
    expect(result.stages.clarify.allowedWritePaths).toEqual([
      "docs/",
      "doc/",
      "documentation/",
    ]);
  });

  it("resolvePipelineConfig warns and ignores allowedWritePaths with non-string entries", async () => {
    await writeJson({
      stages: { clarify: { allowedWritePaths: [123, 456] } },
    });
    const loaded = loadJsonConfig(jsonPath);
    const result = resolvePipelineConfig(loaded);
    // Invalid entries → falls back to stage-type default
    expect(result.stages.clarify.allowedWritePaths).toEqual([
      "docs/",
      "doc/",
      "documentation/",
    ]);
  });

  it("resolvePipelineConfig accepts '**' as valid allowedWritePaths entry", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { allowedWritePaths: ["**"] } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.allowedWritePaths).toEqual(["**"]);
  });
});

describe("Phase 0 (140): agentPath transparency", () => {
  it("agentPath is passed through from JSON config without default fallback", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { agentPath: ".pi/agents/clarify.md", nextStage: "plan" },
        plan: { agentPath: ".pi/agents/plan.md", nextStage: "develop" },
        develop: { nextStage: "review" },
        review: { nextStage: "fix" },
        fix: { nextStage: "completed" },
      },
    };
    const result = resolvePipelineConfig(json);

    // Configured agentPath values are passed through as-is
    expect(result.stages.clarify.agentPath).toBe(".pi/agents/clarify.md");
    expect(result.stages.plan.agentPath).toBe(".pi/agents/plan.md");
    // Unconfigured agentPath is undefined (no default fallback)
    expect(result.stages.develop.agentPath).toBeUndefined();
    expect(result.stages.review.agentPath).toBeUndefined();
    expect(result.stages.fix.agentPath).toBeUndefined();
  });

  it("disabled stage gets agentPath = undefined and disabled = true", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { agentPath: "clarify.md" },
        plan: { require: false },
        develop: { agentPath: "develop.md" },
      },
    };
    const result = resolvePipelineConfig(json);
    // plan is explicitly disabled via require: false
    expect(result.stages.plan.agentPath).toBeUndefined();
    expect(result.stages.plan.disabled).toBe(true);
    // clarify and develop are enabled and should not have disabled field
    expect(result.stages.clarify.disabled).toBeUndefined();
    expect(result.stages.develop.disabled).toBeUndefined();
    // review and fix are not in config → also disabled
    expect(result.stages.review.disabled).toBe(true);
    expect(result.stages.fix.disabled).toBe(true);
  });

  it("fix.nextStage = completed eliminates develop→fix→develop loop", () => {
    const json: PipelineJsonConfig = {
      stages: {
        fix: { nextStage: "completed" },
        completed: { nextStage: null },
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.fix.nextStage).toBe("completed");
  });

  it("Phase 0 (141): linear config produces no circular reference warning", () => {
    const originalInfo = console.info;
    const captured: string[] = [];
    console.info = (...args: unknown[]) => {
      if (typeof args[0] === "string") captured.push(args[0]);
    };
    try {
      const json: PipelineJsonConfig = {
        stages: {
          clarify: { nextStage: "plan" },
          plan: { nextStage: "develop" },
          develop: { nextStage: "review" },
          review: { nextStage: "fix" },
          fix: { nextStage: "completed" },
          completed: { nextStage: null },
        },
      };
      resolvePipelineConfig(json);
      const circularWarnings = captured.filter((msg) =>
        msg.includes("Circular reference detected"),
      );
      expect(circularWarnings).toHaveLength(0);
    } finally {
      console.info = originalInfo;
    }
  });

  it("Phase 0 (141): real cycle (review↔fix) produces exactly 1 warning with normalized path", () => {
    const originalInfo = console.info;
    const captured: string[] = [];
    console.info = (...args: unknown[]) => {
      if (typeof args[0] === "string") captured.push(args[0]);
    };
    try {
      const json: PipelineJsonConfig = {
        stages: {
          develop: { nextStage: "review" },
          review: { nextStage: "fix" },
          fix: { nextStage: "review" }, // creates real cycle: review → fix → review
        },
      };
      resolvePipelineConfig(json);
      const circularWarnings = captured.filter((msg) =>
        msg.includes("Circular reference detected"),
      );
      expect(circularWarnings).toHaveLength(1);
      // Normalized cycle should start with lexicographically smallest node ("fix")
      expect(circularWarnings[0]).toContain("fix → review → fix");
    } finally {
      console.info = originalInfo;
    }
  });
});

describe("startStageMode config", () => {
  it("loadJsonConfig parses startStageMode: 'ask'", async () => {
    await writeJson({
      stages: { clarify: {} },
      startStageMode: "ask",
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.startStageMode).toBe("ask");
  });

  it("loadJsonConfig parses startStageMode: 'confirm'", async () => {
    await writeJson({
      stages: { clarify: {} },
      startStageMode: "confirm",
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.startStageMode).toBe("confirm");
  });

  it("loadJsonConfig parses startStageMode: 'auto'", async () => {
    await writeJson({
      stages: { clarify: {} },
      startStageMode: "auto",
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.startStageMode).toBe("auto");
  });

  it("loadJsonConfig warns and returns undefined for invalid startStageMode", async () => {
    const originalWarn = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string") captured.push(args[0]);
    };
    try {
      await writeJson({
        stages: { clarify: {} },
        startStageMode: "foo",
      });
      const result = loadJsonConfig(jsonPath);
      expect(result.startStageMode).toBeUndefined();
      expect(captured.some((msg) => msg.includes("Invalid startStageMode"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("loadJsonConfig returns undefined when startStageMode is missing", async () => {
    await writeJson({
      stages: { clarify: {} },
    });
    const result = loadJsonConfig(jsonPath);
    expect(result.startStageMode).toBeUndefined();
  });

  it("resolvePipelineConfig defaults startStageMode to 'auto'", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.startStageMode).toBe("auto");
  });

  it("resolvePipelineConfig preserves startStageMode: 'ask'", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      startStageMode: "ask",
    };
    const result = resolvePipelineConfig(json);
    expect(result.startStageMode).toBe("ask");
  });

  it("resolvePipelineConfig preserves startStageMode: 'confirm'", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      startStageMode: "confirm",
    };
    const result = resolvePipelineConfig(json);
    expect(result.startStageMode).toBe("confirm");
  });

  it("backward compatible: old config without startStageMode resolves to 'auto'", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { nextStage: "plan" },
        plan: { nextStage: "develop" },
        develop: { nextStage: "review" },
        review: { nextStage: "fix" },
        fix: { nextStage: "completed" },
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.startStageMode).toBe("auto");
  });
});

describe("confirm config (Phase 1 — 162)", () => {
  describe("stage-level confirm", () => {
    it("missing confirm → StageConfig.confirm is undefined (current behavior)", () => {
      const json: PipelineJsonConfig = { stages: { plan: {} } };
      const result = resolvePipelineConfig(json);
      expect(result.stages.plan.confirm).toBeUndefined();
    });

    it("confirm: { mode: 'manual' } is parsed correctly", async () => {
      await writeJson({
        stages: { plan: { confirm: { mode: "manual" } } },
      });
      const loaded = loadJsonConfig(jsonPath);
      expect(loaded.stages.plan!.confirm).toBeDefined();
      expect(loaded.stages.plan!.confirm!.mode).toBe("manual");
      const result = resolvePipelineConfig(loaded);
      expect(result.stages.plan.confirm!.mode).toBe("manual");
    });

    it("confirm: { mode: 'smart', maxRejections: 3 } is parsed", () => {
      const json: PipelineJsonConfig = {
        stages: { review: { confirm: { mode: "smart", maxRejections: 3 } } },
      };
      const result = resolvePipelineConfig(json);
      expect(result.stages.review.confirm!.mode).toBe("smart");
      expect(result.stages.review.confirm!.maxRejections).toBe(3);
    });

    it("invalid confirm.mode ('xor') → warn + fallback to 'auto'", () => {
      const originalWarn = console.warn;
      const captured: string[] = [];
      console.warn = (...args: unknown[]) => {
        if (typeof args[0] === "string") captured.push(args[0]);
      };
      try {
        const json: PipelineJsonConfig = {
          stages: { plan: { confirm: { mode: "xor" as any } } },
        };
        const result = resolvePipelineConfig(json);
        expect(result.stages.plan.confirm!.mode).toBe("auto");
        expect(captured.some((m) => m.includes("Invalid confirm.mode"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("invalid confirm.maxRejections (0) → warn + ignored", () => {
      const originalWarn = console.warn;
      const captured: string[] = [];
      console.warn = (...args: unknown[]) => {
        if (typeof args[0] === "string") captured.push(args[0]);
      };
      try {
        const json: PipelineJsonConfig = {
          stages: { plan: { confirm: { maxRejections: 0 } } },
        };
        const result = resolvePipelineConfig(json);
        expect(result.stages.plan.confirm!.maxRejections).toBeUndefined();
        expect(captured.some((m) => m.includes("Invalid confirm.maxRejections"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("invalid confirm.maxRejections (-1) → warn + ignored", () => {
      const json: PipelineJsonConfig = {
        stages: { plan: { confirm: { maxRejections: -1 } } },
      };
      const result = resolvePipelineConfig(json);
      expect(result.stages.plan.confirm!.maxRejections).toBeUndefined();
    });

    it("invalid confirm.maxRejections (string) → warn + ignored", () => {
      const json: PipelineJsonConfig = {
        stages: { plan: { confirm: { maxRejections: "three" as any } } },
      };
      const result = resolvePipelineConfig(json);
      expect(result.stages.plan.confirm!.maxRejections).toBeUndefined();
    });

    it("invalid confirm (non-object) → warn + undefined", () => {
      const json: PipelineJsonConfig = {
        stages: { plan: { confirm: "manual" as any } },
      };
      const result = resolvePipelineConfig(json);
      expect(result.stages.plan.confirm).toBeUndefined();
    });
  });

  describe("top-level maxConfirmRejections", () => {
    it("defaults to 5 when not configured", () => {
      const json: PipelineJsonConfig = { stages: { clarify: {} } };
      const result = resolvePipelineConfig(json);
      expect(result.maxConfirmRejections).toBe(5);
    });

    it("parses user-specified value", () => {
      const json: PipelineJsonConfig = {
        stages: { clarify: {} },
        maxConfirmRejections: 10,
      };
      const result = resolvePipelineConfig(json);
      expect(result.maxConfirmRejections).toBe(10);
    });

    it("loadJsonConfig parses from JSON file", async () => {
      await writeJson({
        stages: { clarify: {} },
        maxConfirmRejections: 7,
      });
      const result = loadJsonConfig(jsonPath);
      expect(result.maxConfirmRejections).toBe(7);
    });

    it("loadJsonConfig ignores non-number maxConfirmRejections", async () => {
      await writeJson({
        stages: { clarify: {} },
        maxConfirmRejections: "many",
      });
      const result = loadJsonConfig(jsonPath);
      expect(result.maxConfirmRejections).toBeUndefined();
    });
  });

  describe("top-level confirmOverflow", () => {
    it("defaults to 'ask' when not configured", () => {
      const json: PipelineJsonConfig = { stages: { clarify: {} } };
      const result = resolvePipelineConfig(json);
      expect(result.confirmOverflow).toBe("ask");
    });

    it("parses 'terminate'", () => {
      const json: PipelineJsonConfig = {
        stages: { clarify: {} },
        confirmOverflow: "terminate",
      };
      const result = resolvePipelineConfig(json);
      expect(result.confirmOverflow).toBe("terminate");
    });

    it("invalid value → warn + fallback to 'ask'", () => {
      const originalWarn = console.warn;
      const captured: string[] = [];
      console.warn = (...args: unknown[]) => {
        if (typeof args[0] === "string") captured.push(args[0]);
      };
      try {
        const json: PipelineJsonConfig = {
          stages: { clarify: {} },
          confirmOverflow: "invalid" as any,
        };
        const result = resolvePipelineConfig(json);
        expect(result.confirmOverflow).toBe("ask");
        expect(captured.some((m) => m.includes("Invalid confirmOverflow"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("loadJsonConfig parses confirmOverflow from JSON", async () => {
      await writeJson({
        stages: { clarify: {} },
        confirmOverflow: "terminate",
      });
      const result = loadJsonConfig(jsonPath);
      expect(result.confirmOverflow).toBe("terminate");
    });

    it("loadJsonConfig ignores invalid confirmOverflow", async () => {
      await writeJson({
        stages: { clarify: {} },
        confirmOverflow: "abort",
      });
      const result = loadJsonConfig(jsonPath);
      expect(result.confirmOverflow).toBeUndefined();
    });
  });

  describe("backward compatibility", () => {
    it("old config without confirm fields parses without changes", () => {
      const json: PipelineJsonConfig = {
        stages: {
          clarify: { nextStage: "plan" },
          plan: { nextStage: "develop" },
          develop: { nextStage: "review" },
          review: { nextStage: "fix" },
          fix: { nextStage: "completed" },
        },
      };
      const result = resolvePipelineConfig(json);
      // Confirm is undefined on all stages (current behavior preserved)
      expect(result.stages.clarify.confirm).toBeUndefined();
      expect(result.stages.plan.confirm).toBeUndefined();
      expect(result.stages.develop.confirm).toBeUndefined();
      expect(result.stages.review.confirm).toBeUndefined();
      expect(result.stages.fix.confirm).toBeUndefined();
      // Global defaults
      expect(result.maxConfirmRejections).toBe(5);
      expect(result.confirmOverflow).toBe("ask");
    });
  });
});
