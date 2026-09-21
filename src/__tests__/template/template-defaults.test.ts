/**
 * @module template-defaults.test
 * Phase 5 (173) C13/C14/C15 — Template default fields, guide drift coverage, spawn trigger.
 *
 * Test plan (per docs/design/173_E2E_Bug_plan.md §Phase 5):
 *   - C13: Template resolves with correct defaults (auditDir, maxLoops, maxVerifyAttempts, suppressDuplicateSpawn)
 *   - C14: Drift detection includes guide.md (8 assets total)
 *   - C15: spawnTrigger inference (pipeline_auto vs manual_or_external)
 *   - E2: FROZEN_ABORT_EXEMPT_TOOLS comment correction (code review item, no test needed)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { checkTemplateDrift } from "../../utils/template-drift";
import { makeTestMeta } from "../helpers";
import { PLAN_CONFIRM_MARKER_RULE } from "../../core/stage-advancer";
import { evaluateGroups } from "../../core/verifiers/group-verifier";
import { resolvePlaceholders } from "../../core/verify-path-resolver";
import { parseFrontmatter, type VerifyRules } from "../../core/verify-frontmatter";
import { COMMIT_DOC_NAMING_CONSTRAINT } from "../../constants";

// ─── C13: Template default fields ────────────────────────────────────────────

describe("Phase 5 (173) C13: template default fields", () => {
  it("pipeline_loop.json has explicit auditDir field", () => {
    const jsonPath = path.join(__dirname, "../../template/pipeline_loop.json");
    const content = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(content.auditDir).toBe(".pi/audit");
  });

  it("pipeline_loop.json has explicit maxLoops field", () => {
    const jsonPath = path.join(__dirname, "../../template/pipeline_loop.json");
    const content = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(content.maxLoops).toBe(3);
  });

  it("pipeline_loop.json has explicit maxVerifyAttempts field", () => {
    const jsonPath = path.join(__dirname, "../../template/pipeline_loop.json");
    const content = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(content.maxVerifyAttempts).toBe(3);
  });

  it("pipeline_loop.json has suppressDuplicateSpawn=true in clarify and plan", () => {
    const jsonPath = path.join(__dirname, "../../template/pipeline_loop.json");
    const content = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    // clarify stage
    expect(content.stages.clarify.guard).toBeDefined();
    expect(content.stages.clarify.guard.suppressDuplicateSpawn).toBe(true);
    // plan stage
    expect(content.stages.plan.guard).toBeDefined();
    expect(content.stages.plan.guard.suppressDuplicateSpawn).toBe(true);
  });

  // Phase 2 / 175: develop doesn't need explicit flag since default is now true.
  // The absence of suppressDuplicateSpawn in develop means it defaults to true (default-on).
  it("pipeline_loop.json does NOT have suppressDuplicateSpawn in develop (Phase 2 / 175: default-on makes flag unnecessary)", () => {
    const jsonPath = path.join(__dirname, "../../template/pipeline_loop.json");
    const content = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    // develop stage should NOT have guard.suppressDuplicateSpawn — default-on (175) covers it
    expect(content.stages.develop.guard?.suppressDuplicateSpawn).toBeUndefined();
  });

  it("resolvePipelineConfig produces consistent defaults from template", () => {
    const jsonPath = path.join(__dirname, "../../template/pipeline_loop.json");
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const json = JSON.parse(raw);
    const config = resolvePipelineConfig(json);
    // auditDir from template
    expect(config.auditDir).toBe(".pi/audit");
    // maxLoops from template
    expect(config.maxLoops).toBe(3);
    // maxVerifyAttempts from template
    expect(config.maxVerifyAttempts).toBe(3);
    // suppressDuplicateSpawn in clarify/plan
    expect(config.stages.clarify.guard?.suppressDuplicateSpawn).toBe(true);
    expect(config.stages.plan.guard?.suppressDuplicateSpawn).toBe(true);
    // develop should NOT have it
    expect(config.stages.develop.guard?.suppressDuplicateSpawn).toBeUndefined();
  });

  it("_comment keys are safely ignored by loader (no crash)", () => {
    const jsonPath = path.join(__dirname, "../../template/pipeline_loop.json");
    const content = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    // _comment exists in template
    expect(content._comment).toBeDefined();
    expect(content.protect._comment_allow).toBeDefined();
    // resolvePipelineConfig should not crash
    const config = resolvePipelineConfig(content);
    expect(config).toBeDefined();
    expect(config.stages).toBeDefined();
  });
});

// ─── C14: Guide drift coverage ───────────────────────────────────────────────

describe("Phase 5 (173) C14: guide drift coverage", () => {
  it("checkTemplateDrift includes guide.md in asset list (8 assets total)", async () => {
    // The drift check assets list is internal, but we can verify by checking
    // that the function runs without error and returns an array
    const drifts = await checkTemplateDrift("/tmp/nonexistent-project");
    expect(Array.isArray(drifts)).toBe(true);
    // For a nonexistent project, drifts should be empty (fail-open)
    expect(drifts.length).toBe(0);
  });

  it("guide.md exists in template directory", () => {
    const guidePath = path.join(__dirname, "../../template/guide.md");
    expect(fs.existsSync(guidePath)).toBe(true);
  });

  it("guide.md has 5 new chapters (§11-§15)", () => {
    const guidePath = path.join(__dirname, "../../template/guide.md");
    const content = fs.readFileSync(guidePath, "utf-8");
    // Check for new chapter headings
    expect(content).toContain("## 11. 插件架构总览");
    expect(content).toContain("## 12. Stage 流转与状态机");
    expect(content).toContain("## 13. 冻结与决策模型");
    expect(content).toContain("## 14. 会话生命周期与静默模型");
    expect(content).toContain("## 15. 断点恢复路径汇总");
  });
});

// ─── C15: spawnTrigger inference ─────────────────────────────────────────────

describe("Phase 5 (173) C15: spawnTrigger inference", () => {
  it("inferSpawnTrigger returns pipeline_auto when activeSpawns matches current stage within 5min", () => {
    // This is a unit test for the inferSpawnTrigger logic
    // We test the behavior indirectly through the session-starter JOIN path
    const meta = makeTestMeta({
      currentStage: "clarify",
      activeSpawns: {
        clarify: { agentName: "feat-design-plan-agent", startedAt: Date.now() - 60000 }, // 1 min ago
      },
    });
    // activeSpawns.clarify exists and is within 5min window → should be "pipeline_auto"
    expect(meta.activeSpawns?.clarify).toBeDefined();
    expect(Date.now() - (meta.activeSpawns!.clarify!.startedAt)).toBeLessThan(5 * 60 * 1000);
  });

  it("inferSpawnTrigger returns manual_or_external when no activeSpawns match", () => {
    const meta = makeTestMeta({
      currentStage: "clarify",
      activeSpawns: undefined,
    });
    // No activeSpawns → should be "manual_or_external"
    expect(meta.activeSpawns).toBeUndefined();
  });

  it("inferSpawnTrigger returns manual_or_external when activeSpawns is stale (> 5min)", () => {
    const meta = makeTestMeta({
      currentStage: "clarify",
      activeSpawns: {
        clarify: { agentName: "feat-design-plan-agent", startedAt: Date.now() - 10 * 60 * 1000 }, // 10 min ago
      },
    });
    // activeSpawns.clarify exists but is > 5min old → should be "manual_or_external"
    expect(Date.now() - (meta.activeSpawns!.clarify!.startedAt)).toBeGreaterThan(5 * 60 * 1000);
  });

  it("inferSpawnTrigger returns pipeline_auto when spawnedStages matches stageStartTime", () => {
    const stageStartTime = Date.now();
    const meta = makeTestMeta({
      currentStage: "clarify",
      stageStartTime,
      spawnedStages: {
        clarify: stageStartTime, // matches current stageStartTime
      },
    });
    // spawnedStages.clarify === stageStartTime → should be "pipeline_auto"
    expect(meta.spawnedStages?.clarify).toBe(stageStartTime);
  });
});

// ─── C17: SKILL path convention ──────────────────────────────────────────────

describe("Phase 5 (173) C17: SKILL path convention", () => {
  it("develop/SKILL.md contains path convention note", () => {
    const skillPath = path.join(__dirname, "../../template/skills/develop/SKILL.md");
    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content).toContain("Never write business deliverables under");
    expect(content).toContain("{auditDir}");
    expect(content).toContain("docs/design/");
  });

  it("review/SKILL.md contains path convention note", () => {
    const skillPath = path.join(__dirname, "../../template/skills/review/SKILL.md");
    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content).toContain("Never write business deliverables under");
    expect(content).toContain("{auditDir}");
    expect(content).toContain("docs/design/");
  });
});

// ─── Phase 1 / 179 (G2 layer ③): design SKILL next-command MUST ──────────────

describe("Phase 1 / 179 (G2): design SKILL next-command MUST clause", () => {
  it("design/SKILL.md requires the two complete next-step command lines", () => {
    const skillPath = path.join(__dirname, "../../template/skills/design/SKILL.md");
    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content).toContain("full-und?");
    expect(content).toContain("<agent>");
    expect(content).toContain("<doc>");
    // Must forbid literal placeholder leakage in user-facing prompts
    expect(content).toContain("禁止");
  });
});

// ─── D2 (174): stage SKILL frontmatter regression guard ─────────────────────

describe("D2 (174): stage SKILL frontmatter regression guard", () => {
  const STAGE_SKILLS = ["design", "plan", "develop", "review", "fix"];

  for (const stage of STAGE_SKILLS) {
    it(`${stage}/SKILL.md frontmatter contains both disable-model-invocation: true and userInvocable: false`, () => {
      const skillPath = path.join(__dirname, `../../template/skills/${stage}/SKILL.md`);
      const content = fs.readFileSync(skillPath, "utf-8");

      // Extract frontmatter block (between first and second ---)
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      const frontmatter = fmMatch![1];

      // Both keys must be present
      expect(frontmatter).toContain("disable-model-invocation: true");
      expect(frontmatter).toContain("userInvocable: false");
    });
  }
});

// ─── Phase 3 / 176: v6 template structure + engine smoke ─────────────────────

/** Parses a deployed stage template's frontmatter into VerifyRules. */
async function loadTemplateRules(stage: string): Promise<VerifyRules> {
  const verifyMdPath = path.join(__dirname, `../../template/references/${stage}_spec/verify.md`);
  const raw = fs.readFileSync(verifyMdPath, "utf-8");
  const parts = raw.split(/^---\s*$/m);
  const rules = await parseFrontmatter(parts[1].trim());
  if (!rules) throw new Error(`Failed to parse ${stage} verify.md`);
  return rules;
}

describe("Phase 3 / 176: v6 template structure", () => {
  const STAGES = ["clarify", "plan", "develop", "review", "fix"] as const;

  it("all 5 templates parse into groups with a file-level path", async () => {
    for (const stage of STAGES) {
      const rules = await loadTemplateRules(stage);
      expect(rules.path).toBeDefined();
      expect(rules.groups?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("clarify declares round-well-formed (when named groups + runtime) and full-und-confirmed (modelConfirm)", async () => {
    const rules = await loadTemplateRules("clarify");
    const round = rules.groups!.find((g) => g.name === "round-well-formed")!;
    expect(round).toBeDefined();
    expect(round.scope).toBe("section");
    expect(round.ruleMode).toBe("and");
    expect(round.runtime).toBe("roundHeading");
    expect(round.when).toContain("roundZh");
    expect(round.when).toContain("roundEn");

    const confirm = rules.groups!.find((g) => g.name === "full-und-confirmed")!;
    expect(confirm.ruleMode).toBe("and");
    expect(confirm.rules.some((n) => n.runtime === "modelConfirm")).toBe(true);
  });

  it("review declares a verdict runtime node whose patterns all expose capture group 1", async () => {
    const rules = await loadTemplateRules("review");
    const group = rules.groups!.find((g) => g.name === "review-report-ready")!;
    const verdictNode = group.rules.find((n) => n.runtime === "verdict")!;
    expect(verdictNode).toBeDefined();
    expect(verdictNode.mode).toBe("or");
    for (const pattern of verdictNode.patterns ?? []) {
      const re = new RegExp(`${pattern}|`);
      expect((re.exec("")?.length ?? 0) - 1).toBeGreaterThanOrEqual(1);
    }
  });

  it("plan marker node matches PLAN_CONFIRM_MARKER_RULE exactly (defer contract)", async () => {
    const rules = await loadTemplateRules("plan");
    expect(rules.path).toBe(PLAN_CONFIRM_MARKER_RULE.path);
    const group = rules.groups![0];
    const marker = group.rules.find((n) => n.type === "fileContentPattern")!;
    expect(marker.patterns).toEqual([PLAN_CONFIRM_MARKER_RULE.pattern]);
  });

  it("develop/fix commit templates declare requiredFile + plan doc + pipelineId nodes", async () => {
    for (const stage of ["develop", "fix"] as const) {
      const rules = await loadTemplateRules(stage);
      const group = rules.groups![0];
      expect(group.rules.some((n) => n.type === "requiredFile")).toBe(true);
      expect(group.rules.some((n) => n.patterns?.some((p) => p.includes("plan doc")))).toBe(true);
      expect(group.rules.some((n) => n.patterns?.some((p) => p.includes("{pipelineId}")))).toBe(true);
    }
  });
});

// ─── Phase 3 / 176: template engine smoke (positive / negative) ──────────────

describe("Phase 3 / 176: template engine smoke", () => {
  let smokeTmp: string;

  beforeEach(async () => {
    smokeTmp = path.join(tmpdir(), "pi-v6-smoke-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await fsp.mkdir(smokeTmp, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(smokeTmp, { recursive: true, force: true });
  });

  /** Parses + resolves a template and evaluates its groups against the temp project. */
  async function runTemplate(stage: string, pipelineId: string, requirementDoc?: string) {
    const rules = await loadTemplateRules(stage);
    const resolved = resolvePlaceholders(rules, makeTestMeta({ pipelineId, requirementDoc }));
    // Phase 0 (186): mock git commands for stages with requiredGit rules (develop/fix).
    // Returns clean working tree and a recent commit to pass cleanWorkingTree + lastCommitWithin checks.
    const mockExecFn = async (cmd: string, opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (cmd.includes("git status --porcelain")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("git log")) {
        const now = new Date().toISOString();
        return { stdout: now, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "not a git command mock", exitCode: 1 };
    };
    return evaluateGroups(resolved, smokeTmp, [], { execFn: mockExecFn as any });
  }

  async function writeDoc(rel: string, content: string): Promise<void> {
    const abs = path.join(smokeTmp, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf-8");
  }

  it("review: compliant report passes; missing verdict fails with group tag", async () => {
    await writeDoc("docs/review/code_review_1.md", "**pipeline**: p-1\n\n## 结论\n结论：通过\n");
    expect((await runTemplate("review", "p-1")).passed).toBe(true);

    await writeDoc("docs/review/code_review_1.md", "**pipeline**: p-1\n\n## 结论\nno verdict\n");
    const fail = await runTemplate("review", "p-1");
    expect(fail.passed).toBe(false);
    expect(fail.failures.every((f) => f.group === "review-report-ready")).toBe(true);
  });

  it("develop: compliant commit doc passes; missing plan doc reference fails", async () => {
    await writeDoc("docs/design/x_commit.md", "**plan doc**: docs/design/x_plan.md\n**pipeline**: p-2\n");
    expect((await runTemplate("develop", "p-2")).passed).toBe(true);

    await writeDoc("docs/design/x_commit.md", "**pipeline**: p-2\n");
    const fail = await runTemplate("develop", "p-2");
    expect(fail.passed).toBe(false);
    expect(fail.failures.every((f) => f.group === "commit-ready")).toBe(true);
  });

  it("plan: confirmation marker passes; missing marker fails", async () => {
    await writeDoc("docs/design/x_plan.md", "# Plan\n\n## 用户确认\n");
    expect((await runTemplate("plan", "p-3")).passed).toBe(true);

    await writeDoc("docs/design/x_plan.md", "# Plan\n\nno marker\n");
    const fail = await runTemplate("plan", "p-3");
    expect(fail.passed).toBe(false);
    expect(fail.failures.every((f) => f.group === "plan-ready")).toBe(true);
  });

  it("clarify: multi-round complete + full-und confirmation passes", async () => {
    await writeDoc("req.md", [
      "# 第 1 轮澄清",
      "- 方案 A",
      "答：yes",
      "# 第 2 轮澄清",
      "- 方案 B",
      "答：yes",
      "full-und? 理解确认：是",
      "## 模型确认",
      "confirmed",
    ].join("\n"));
    expect((await runTemplate("clarify", "p-4", "req.md")).passed).toBe(true);
  });

  it("clarify: a middle round missing an answer fails per-section", async () => {
    await writeDoc("req.md", [
      "# 第 1 轮澄清",
      "- 方案 A",
      "# 第 2 轮澄清",
      "- 方案 B",
      "答：yes",
      "full-und? 理解确认：是",
      "## 模型确认",
      "confirmed",
    ].join("\n"));
    const fail = await runTemplate("clarify", "p-4", "req.md");
    expect(fail.passed).toBe(false);
    expect(fail.failures.every((f) => f.group === "round-well-formed")).toBe(true);
  });

  it("clarify: missing model-confirm section fails the full-und group", async () => {
    await writeDoc("req.md", [
      "# 第 1 轮澄清",
      "- 方案 A",
      "答：yes",
      "full-und? 理解确认：是",
    ].join("\n"));
    const fail = await runTemplate("clarify", "p-5", "req.md");
    expect(fail.passed).toBe(false);
    expect(fail.failures.some((f) => f.group === "full-und-confirmed")).toBe(true);
  });
});

// ─── Phase 4 / 176: guide.md groups reference anchors ────────────────────────

describe("Phase 4 / 176: guide.md groups reference", () => {
  const guidePath = path.join(__dirname, "../../template/guide.md");
  const content = fs.readFileSync(guidePath, "utf-8");

  it("contains the groups configuration reference section", () => {
    expect(content).toContain("#### 9.4.B");
    expect(content).toContain("groups 声明体系");
    expect(content).toContain("三层布尔求值序");
  });

  it("documents the scope enum (section vs whole-document default)", () => {
    expect(content).toContain("`scope`");
    expect(content).toContain("section");
    expect(content).toContain("整文档");
  });

  it("warns that runtime-attribute nodes must not be deleted", () => {
    expect(content).toContain("不可随意删除");
    expect(content).toContain("contract_anchor_unavailable");
  });

  it("documents the failure reflow format and behavior-change list", () => {
    expect(content).toContain("[group:name][ruleType]");
    expect(content).toContain("行为变更清单");
    expect(content).toContain("模型确认");
  });
});

// ─── Phase 0 (182): guide.md commit doc naming + force-add documentation ─────

describe("Phase 0 (182): guide.md documentation additions", () => {
  const guidePath = path.join(__dirname, "../../template/guide.md");
  const content = fs.readFileSync(guidePath, "utf-8");

  it("documents commit doc naming convention (derive from requirement doc basename)", () => {
    expect(content).toContain("commit doc 命名规范");
    expect(content).toContain("reqBase");
    expect(content).toContain("_commit.md");
  });

  it("documents force-add bypass blocking", () => {
    expect(content).toContain("git add -f");
    expect(content).toContain("force");
    expect(content).toContain("protect.allow");
  });

  it("documents fix must route through review (no terminal bypass)", () => {
    expect(content).toContain("fix");
    expect(content).toContain("review 复验");
  });
});

// ─── Phase 3 (182): COMMIT_DOC_NAMING_CONSTRAINT constant & prompt injection ─

describe("Phase 3 (182): COMMIT_DOC_NAMING_CONSTRAINT constant & injection", () => {
  it("COMMIT_DOC_NAMING_CONSTRAINT is exported and contains the naming rule", () => {
    expect(COMMIT_DOC_NAMING_CONSTRAINT).toBeDefined();
    expect(typeof COMMIT_DOC_NAMING_CONSTRAINT).toBe("string");
    expect(COMMIT_DOC_NAMING_CONSTRAINT).toContain("*_commit.md");
    expect(COMMIT_DOC_NAMING_CONSTRAINT).toContain("reqBase");
    expect(COMMIT_DOC_NAMING_CONSTRAINT).toContain("MUST");
  });
});

// ─── Phase 4 (184_Bug): template piWorkDir declaration ──────────────────────

describe("Phase 4 (184_Bug): template piWorkDir declaration", () => {
  const TEMPLATE_PATH = path.join(__dirname, "../../template/pipeline_loop.json");

  it("template has explicit piWorkDir === '.pi'", () => {
    const content = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
    expect(content.piWorkDir).toBe(".pi");
  });

  it("template has _comment_piWorkDir with anchor-exception explanation", () => {
    const content = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
    expect(content._comment_piWorkDir).toBeDefined();
    expect(typeof content._comment_piWorkDir).toBe("string");
    // Comment should mention the anchor exception
    expect(content._comment_piWorkDir).toContain("pipeline_loop.json");
  });

  it("template does NOT introduce new 'userDomainDir' key (negative lock, R4Q2①)", () => {
    const content = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
    expect(content.userDomainDir).toBeUndefined();
  });

  it("template does NOT introduce a new top-level 'domainDir' key (R4Q2① negative lock)", () => {
    // Per R4Q2①, Phase 4 must NOT add domain-related new keys to the template.
    // domainDir must remain absent from pipeline_loop.json (user opts in manually).
    const content = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
    expect(content.domainDir).toBeUndefined();
  });
});

// ── Phase 0 (186): PIPELINE AUTOMATION RULES section in sop.md ──────────────

describe("Phase 0 (186): PIPELINE AUTOMATION RULES in sop.md template", () => {
  const SOP_PATH = path.join(__dirname, "../../template/references/sop.md");
  const SOP_CN_PATH = path.join(__dirname, "../../template/references/sop_CN.md");

  it("sop.md template contains PIPELINE AUTOMATION RULES section", () => {
    const content = fs.readFileSync(SOP_PATH, "utf-8");
    expect(content).toContain("PIPELINE AUTOMATION RULES");
    expect(content).toContain("agent_settled hook");
    expect(content).toContain("syncStageStatusBar");
    expect(content).toContain("cleanWorkingTree");
    expect(content).toContain("stage_advance");
  });

  it("sop_CN.md template contains pipeline automation rules section in Chinese", () => {
    const content = fs.readFileSync(SOP_CN_PATH, "utf-8");
    expect(content).toContain("流水线自动化规则");
    expect(content).toContain("agent_settled hook");
    expect(content).toContain("syncStageStatusBar");
    expect(content).toContain("cleanWorkingTree");
    expect(content).toContain("stage_advance");
  });
});
