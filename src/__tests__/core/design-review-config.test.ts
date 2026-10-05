/**
 * Unit tests for design-review stage configuration loading.
 * Phase 0 / 191: Tests that the design-review stage is properly recognized
 * in the valid stages set, canonical order, and configuration defaults.
 * Tests old meta compatibility, disabled stage, and custom piWorkDir paths.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  loadJsonConfig,
  resolvePipelineConfig,
  rewritePiPrefix,
} from "../../core/json-config-loader";
import {
  RESUMABLE_STAGES,
  CANONICAL_STAGE_ORDER,
  STAGE_TYPE_TOOL_DEFAULTS,
  DEFAULT_READONLY_WRITE_PATHS,
} from "../../constants";
import type { PipelineStage, PipelineJsonConfig, PipelineConfig } from "../../types";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("design-review stage configuration — constants", () => {
  describe("RESUMABLE_STAGES", () => {
    test("includes design-review as a resumable stage", () => {
      expect(RESUMABLE_STAGES).toContain("design-review");
    });

    test("excludes awaiting_human and completed", () => {
      expect(RESUMABLE_STAGES).not.toContain("awaiting_human");
      expect(RESUMABLE_STAGES).not.toContain("completed");
    });

    test("has exactly 6 resumable stages", () => {
      expect(RESUMABLE_STAGES.length).toBe(6);
    });

    test("maintains correct order (plan < design-review < develop)", () => {
      const drIndex = RESUMABLE_STAGES.indexOf("design-review");
      const planIndex = RESUMABLE_STAGES.indexOf("plan");
      const developIndex = RESUMABLE_STAGES.indexOf("develop");
      expect(drIndex).toBeGreaterThan(planIndex);
      expect(drIndex).toBeLessThan(developIndex);
    });
  });

  describe("CANONICAL_STAGE_ORDER", () => {
    test("includes design-review in canonical order", () => {
      expect(CANONICAL_STAGE_ORDER).toContain("design-review");
    });

    test("places design-review between plan and develop", () => {
      const drIndex = CANONICAL_STAGE_ORDER.indexOf("design-review");
      const planIndex = CANONICAL_STAGE_ORDER.indexOf("plan");
      const developIndex = CANONICAL_STAGE_ORDER.indexOf("develop");
      expect(drIndex).toBeGreaterThan(planIndex);
      expect(drIndex).toBeLessThan(developIndex);
    });

    test("has exactly 8 stages in canonical order", () => {
      expect(CANONICAL_STAGE_ORDER.length).toBe(8);
    });

    test("maintains complete stage sequence", () => {
      const expectedOrder = [
        "clarify",
        "plan",
        "design-review",
        "develop",
        "review",
        "fix",
        "awaiting_human",
        "completed",
      ];
      expect([...CANONICAL_STAGE_ORDER]).toEqual(expectedOrder);
    });
  });

  describe("STAGE_TYPE_TOOL_DEFAULTS", () => {
    test("includes design-review stage defaults", () => {
      expect(STAGE_TYPE_TOOL_DEFAULTS["design-review"]).toBeDefined();
    });

    test("design-review has docs-only write paths (same as clarify/plan)", () => {
      const drDefaults = STAGE_TYPE_TOOL_DEFAULTS["design-review"];
      const clarifyDefaults = STAGE_TYPE_TOOL_DEFAULTS["clarify"];
      expect(drDefaults.allowedWritePaths).toEqual(clarifyDefaults.allowedWritePaths);
      expect(drDefaults.allowedWritePaths).toContain("docs/");
    });

    test("design-review does not allow all writes", () => {
      const drDefaults = STAGE_TYPE_TOOL_DEFAULTS["design-review"];
      expect(drDefaults.allowedWritePaths).not.toContain("**");
    });

    test("design-review allowedWritePaths matches DEFAULT_READONLY_WRITE_PATHS", () => {
      const drDefaults = STAGE_TYPE_TOOL_DEFAULTS["design-review"];
      expect(drDefaults.allowedWritePaths).toEqual(DEFAULT_READONLY_WRITE_PATHS);
    });

    test("all expected stages have defaults", () => {
      const expectedStages = ["clarify", "plan", "design-review", "develop", "review", "fix"];
      for (const stage of expectedStages) {
        expect(STAGE_TYPE_TOOL_DEFAULTS[stage]).toBeDefined();
      }
    });
  });
});

describe("design-review stage — JSON config loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): string {
    const configPath = path.join(tmpDir, "pipeline_loop.json");
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
    return configPath;
  }

  describe("design-review as a recognized stage", () => {
    test("accepts design-review as a valid stage key (no warn/skip)", () => {
      const configPath = writeConfig({
        stages: {
          clarify: {},
          plan: { nextStage: "design-review" },
          "design-review": { nextStage: "develop" },
          develop: { nextStage: "review" },
          review: { nextStage: "fix" },
          fix: { nextStage: "completed" },
        },
      });
      const json = loadJsonConfig(configPath);
      expect(json.stages["design-review"]).toBeDefined();
      expect(json.stages["design-review"]?.nextStage).toBe("develop");
    });

    test("resolvePipelineConfig creates stage entry for design-review", () => {
      const json: PipelineJsonConfig = {
        stages: {
          clarify: {},
          plan: { nextStage: "design-review" },
          "design-review": { nextStage: "develop" },
          develop: { nextStage: "review" },
          review: { nextStage: "fix" },
          fix: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      const drStage = config.stages["design-review"];
      expect(drStage).toBeDefined();
      expect(drStage.disabled).toBeUndefined();
      expect(drStage.nextStage).toBe("develop");
    });

    test("design-review defaults to write paths for documentation only", () => {
      const json: PipelineJsonConfig = {
        stages: {
          "design-review": { nextStage: "develop" },
          develop: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      const drStage = config.stages["design-review"];
      expect(drStage.allowedWritePaths).toEqual(DEFAULT_READONLY_WRITE_PATHS);
    });

    test("design-review defaults to doc-only skillPath and verifyFile", () => {
      const json: PipelineJsonConfig = {
        stages: {
          "design-review": { nextStage: "develop" },
          develop: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      const drStage = config.stages["design-review"];
      expect(drStage.skillPath).toBe("design-review/SKILL.md");
      // When verify is not configured, it's undefined (not defaulted)
      expect(drStage.verify).toBeUndefined();
    });

    test("design-review with verify config uses default verify file path", () => {
      const json: PipelineJsonConfig = {
        stages: {
          "design-review": { 
            nextStage: "develop",
            verify: { require: true },
          },
          develop: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      const drStage = config.stages["design-review"];
      expect(drStage.verify?.verifyFile).toBe(".pi/references/design-review_spec/verify.md");
    });

    test("design-review default nextStage is null when not configured", () => {
      const json: PipelineJsonConfig = {
        stages: {
          "design-review": {},
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      const drStage = config.stages["design-review"];
      expect(drStage.nextStage).toBeNull();
    });
  });

  describe("design-review disabled (require: false)", () => {
    test("design-review not in config creates disabled placeholder (Issue #24/R1 fix)", () => {
      const json: PipelineJsonConfig = {
        stages: {
          clarify: {},
          plan: { nextStage: "develop" },
          develop: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      // Phase 4 (191) fix for Issue #24/R1: design-review is a NEW stage,
      // old configs without it should have a disabled placeholder created
      // to ensure checkAgentPaths in pipeline-start.ts can properly skip it
      expect(config.stages["design-review"]).toBeDefined();
      expect(config.stages["design-review"].disabled).toBe(true);
    });

    test("design-review require: false explicitly disables stage", () => {
      const json: PipelineJsonConfig = {
        stages: {
          plan: { nextStage: "design-review" },
          "design-review": { require: false, nextStage: "develop" },
          develop: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      expect(config.stages["design-review"].disabled).toBe(true);
    });

    test("chain reconnection skips disabled design-review", () => {
      const json: PipelineJsonConfig = {
        stages: {
          plan: { nextStage: "design-review" },
          "design-review": { require: false, nextStage: "develop" },
          develop: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      // Plan should now skip design-review and point directly to develop
      expect(config.stages.plan.nextStage).toBe("develop");
    });
  });

  describe("custom piWorkDir paths", () => {
    test("design-review agentPath rewritten with custom piWorkDir", () => {
      const json: PipelineJsonConfig = {
        piWorkDir: ".custom",
        stages: {
          "design-review": {
            agentPath: ".pi/agents/design-review-agent.md",
            nextStage: "develop",
          },
          develop: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      expect(config.stages["design-review"].agentPath).toBe(
        ".custom/agents/design-review-agent.md",
      );
    });

    test("design-review verifyFile rewritten with custom piWorkDir", () => {
      const json: PipelineJsonConfig = {
        piWorkDir: ".custom",
        stages: {
          "design-review": { 
            nextStage: "develop",
            verify: { require: true },
          },
          develop: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      expect(config.stages["design-review"].verify?.verifyFile).toBe(
        ".custom/references/design-review_spec/verify.md",
      );
    });
  });

  describe("backward compatibility", () => {
    test("existing 7-stage config without design-review still resolves (Issue #24/R1 fix)", () => {
      const json: PipelineJsonConfig = {
        stages: {
          clarify: { nextStage: "plan" },
          plan: { nextStage: "develop" },
          develop: { nextStage: "review" },
          review: { nextStage: "fix" },
          fix: { nextStage: "completed" },
          completed: {},
        },
      };
      const config = resolvePipelineConfig(json);
      expect(config.stages.clarify.nextStage).toBe("plan");
      expect(config.stages.plan.nextStage).toBe("develop");
      expect(config.stages.develop.nextStage).toBe("review");
      // Phase 4 (191) fix for Issue #24/R1: design-review gets disabled placeholder
      expect(config.stages["design-review"]).toBeDefined();
      expect(config.stages["design-review"].disabled).toBe(true);
    });

    test("rewritePiPrefix unchanged for design-review paths with default piWorkDir", () => {
      const p = ".pi/references/design-review_spec/verify.md";
      expect(rewritePiPrefix(p, ".pi")).toBe(p);
    });

    test("rewritePiPrefix rewrites design-review paths with custom piWorkDir", () => {
      const p = ".pi/references/design-review_spec/verify.md";
      expect(rewritePiPrefix(p, ".custom")).toBe(
        ".custom/references/design-review_spec/verify.md",
      );
    });
  });
});
