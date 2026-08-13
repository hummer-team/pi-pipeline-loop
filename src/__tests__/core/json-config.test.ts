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
    await writeJson({ stages: { clarify: { nextStage: "design" } } });
    const result = loadJsonConfig(jsonPath);
    expect(result.stages.clarify).toBeDefined();
    expect(result.stages.clarify!.nextStage).toBe("design");
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

  it("fills all 8 stages with defaults (even missing ones)", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: { nextStage: "design" } },
    };
    const result = resolvePipelineConfig(json);
    // design is not in config → disabled → chain reconnect resolves to null
    expect(result.stages.clarify.nextStage).toBeNull();
    expect(result.stages.clarify.agentFile).toContain("clarify");
    expect(result.stages.clarify.skillPath).toContain("clarify");
    // All 8 stages present
    expect(result.stages.clarify).toBeDefined();
    expect(result.stages.design).toBeDefined();
    expect(result.stages.plan).toBeDefined();
    expect(result.stages.develop).toBeDefined();
    expect(result.stages.review).toBeDefined();
    expect(result.stages.fix).toBeDefined();
    expect(result.stages.awaiting_human).toBeDefined();
    expect(result.stages.completed).toBeDefined();
  });

  it("uses clarify/design/plan defaults for read-only stages", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.allowedTools).toEqual(["read", "bash"]);
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
          nextStage: "design",
        },
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.agentFile).toBe("custom/agent.md");
    expect(result.stages.clarify.allowedTools).toEqual(["read"]);
  });

  it("handles require: false by creating empty config for that stage", () => {
    const json: PipelineJsonConfig = {
      stages: { design: { require: false } },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.design.allowedTools).toEqual([]);
    expect(result.stages.design.requireDomain).toBe(false);
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
        clarify: { nextStage: "design" },
        design: { require: false },
        plan: {},
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.nextStage).toBe("plan");
    expect(result.stages.design.nextStage).toBeNull();
  });

  it("Case B: stage missing from config is treated as disabled", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { nextStage: "design" },
        plan: { nextStage: "develop" },
        develop: {},
      },
    };
    const result = resolvePipelineConfig(json);
    // design not in config → disabled → clarify.nextStage resolves to plan
    expect(result.stages.clarify.nextStage).toBe("plan");
  });

  it("Case C: two consecutive disabled stages are both skipped", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { nextStage: "design" },
        design: { require: false },
        plan: { require: false },
        develop: {},
      },
    };
    const result = resolvePipelineConfig(json);
    expect(result.stages.clarify.nextStage).toBe("develop");
  });

  it("Case D: only one active stage → nextStage resolves to null", () => {
    const json: PipelineJsonConfig = {
      stages: {
        clarify: { nextStage: "design" },
        design: { require: false },
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

  it("resolvePipelineConfig defaults output.pipelineStage to false", () => {
    const json: PipelineJsonConfig = { stages: { clarify: {} } };
    const result = resolvePipelineConfig(json);
    expect(result.output!.pipelineStage).toBe(false);
  });

  it("resolvePipelineConfig passes through output.pipelineStage: true", () => {
    const json: PipelineJsonConfig = {
      stages: { clarify: {} },
      output: { pipelineStage: true },
    };
    const result = resolvePipelineConfig(json);
    expect(result.output!.pipelineStage).toBe(true);
  });

  it("resolvePipelineConfig falls back to false for invalid output.pipelineStage", async () => {
    await writeJson({
      stages: { clarify: {} },
      output: { pipelineStage: "yes" },
    });
    // loadJsonConfig should warn + ignore the invalid value
    const loaded = loadJsonConfig(jsonPath);
    // resolvePipelineConfig should default to false
    const result = resolvePipelineConfig(loaded);
    expect(result.output!.pipelineStage).toBe(false);
  });
});
