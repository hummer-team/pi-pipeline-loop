/**
 * 220 Phase 6 (D5/C-2): the 6 start stages × 2 tiers smoke matrix.
 *
 * Why it is its own file: `auto-pipeline-e2e.test.ts` stays the chain + budget +
 * stop-reason proof the plan names (Phase 6 任务 2/3/5); the start matrix
 * (Phase 6 任务 4) drives the COMMAND entry (`startAutoJob`) with a real job
 * file and real on-disk evidence, which is a different seam and a different
 * fixture, and keeping both in one file broke the 400-line test budget.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, PipelineStage, SessionMeta } from "../../types";
import { RESUMABLE_STAGES } from "../../constants";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { __resetAutoJobLockForTests, isAutoJobActive } from "../../core/auto-pipeline/config-overlay";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { startAutoJob } from "../../commands/pipeline-auto";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const REQUIREMENT = "docs/design/200_Feat.md";
const PLAN = "docs/design/200_Feat_Plan.md";
const COMMIT = "docs/design/200_Feat_Develop_Commit.md";
const REPORT = "docs/review/Code_Review_200_Feat_Develop_Commit_1.md";

/** The evidence each start stage needs on disk (D5). */
function evidence(stage: PipelineStage): Array<[string, string]> {
  const requirement: [string, string] = [REQUIREMENT, "# requirement\n"];
  switch (stage) {
    case "design-review":
      return [requirement, [PLAN, "# plan\n"]];
    case "develop":
      return [requirement, [PLAN, "# plan\n## User Confirmation\nok\n"]];
    case "review":
      return [requirement, [COMMIT, "# commit\n"]];
    case "fix":
      return [requirement, [REPORT, "## To-Fix\n- one issue\n"]];
    default:
      return [requirement];
  }
}

/** Build one project-shaped root: job file, json config and the stage evidence. */
function prepareCase(stage: PipelineStage, tier: "rule" | "assisted", root: string): PipelineConfig {
  const jobPath = path.join(root, "docs", "jobs", "alpha_loop.yaml");
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(
    jobPath,
    [
      "version: 1",
      "enabled: true",
      `tier: ${tier}`,
      "docs:",
      "  list:",
      `    - doc: ${REQUIREMENT}`,
      `      startStage: ${stage}`,
      "chain:",
      "  newSession: false",
    ].join("\n"),
    "utf8",
  );
  if (tier === "assisted") {
    // Starting at a verifying stage needs its deployed contract file.
    const specDir = path.join(root, ".pi", "references", "design-review_spec");
    fs.mkdirSync(specDir, { recursive: true });
    fs.copyFileSync(
      path.join(SRC_ROOT, "src", "template", "references", "design-review_spec", "verify.md"),
      path.join(specDir, "verify.md"),
    );
  }
  for (const [rel, content] of evidence(stage)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: root };
  const jsonPath = path.join(root, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  const resolved = resolvePipelineConfig(json);
  // `rule` needs no verify block; `assisted` keeps ONLY the design-review one.
  for (const [name, stageConfig] of Object.entries(resolved.stages)) {
    if (stageConfig && (tier === "rule" || name !== "design-review")) {
      delete (stageConfig as { verify?: unknown }).verify;
    }
  }
  return { ...resolved, configSourcePath: jsonPath };
}

/**
 * 224 Phase 1: the auto track dispatches the start-stage executor, so the
 * harness must satisfy the P-A pre-check (`resolveAgentMention`) — copy the
 * template agent files into the project root.
 */
function writeAgentFixtures(root: string): void {
  const dir = path.join(root, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [
    "feat-design-plan-agent",
    "design-review-agent",
    "develop-agent",
    "code-review-agent",
    "code-review-withfix-agent",
  ]) {
    fs.copyFileSync(
      path.join(SRC_ROOT, "src", "template", "agents", `${name}.md`),
      path.join(dir, `${name}.md`),
    );
  }
}

describe("auto run — start-stage × tier smoke matrix", () => {
  for (const tier of ["rule", "assisted"] as const) {
    for (const stage of RESUMABLE_STAGES) {
      it(`tier ${tier} + start ${stage} → starts at that stage`, async () => {
        const root = fs.mkdtempSync(path.join(tmpdir(), "pi-220-matrix-"));
        __resetAutoJobLockForTests();
        __resetFinalizeStateForTests();
        __setSafeWriteAuditLogOverride(async () => {});
        writeAgentFixtures(root);
        try {
          let meta: SessionMeta | undefined;
          const ctx = {
            session: {
              getMeta: () => meta,
              updateMeta: (patch: Partial<SessionMeta>) => {
                meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
                return meta;
              },
            },
            ui: { notify: () => {}, select: async () => undefined },
            pi: { sendUserMessage: () => {} },
          };
          const result = await startAutoJob({ config: prepareCase(stage, tier, root), ctx: ctx as never, jobId: "alpha_loop" });
          expect(result.success).toBe(true);
          expect(meta?.currentStage).toBe(stage);
          expect(isAutoJobActive()).toBe(true);
        } finally {
          __resetAutoJobLockForTests();
          __setSafeWriteAuditLogOverride(null);
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
