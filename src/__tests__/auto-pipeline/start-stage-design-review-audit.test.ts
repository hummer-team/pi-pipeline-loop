/**
 * 227 Phase 6 (D-18): a late `startStage` that bypasses the design-review
 * branch is ALLOWED — but an `assisted` job must leave an audit trail for the
 * skipped branch (`design_review_skipped_by_start_stage`).
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, PipelineStage, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
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

interface CaseAudit {
  event: string;
  message?: Record<string, string | boolean>;
}

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
    fs.copyFileSync(path.join(SRC_ROOT, "src", "template", "agents", `${name}.md`), path.join(dir, `${name}.md`));
  }
}

function prepareCase(opts: {
  root: string;
  startStage: PipelineStage | "clarify";
  tier: "rule" | "assisted";
  withDesignReviewBranch: boolean;
}): PipelineConfig {
  const { root, startStage, tier, withDesignReviewBranch } = opts;
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
      `      startStage: ${startStage}`,
      "chain:",
      "  newSession: false",
    ].join("\n"),
    "utf8",
  );

  // Starting evidence for a develop/review start.
  for (const rel of [REQUIREMENT, PLAN, COMMIT]) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, rel === PLAN ? "# plan\n## User Confirmation\nok\n" : "# doc\n", "utf8");
  }
  if (tier === "assisted") {
    const specDir = path.join(root, ".pi", "references", "design-review_spec");
    fs.mkdirSync(specDir, { recursive: true });
    fs.copyFileSync(
      path.join(SRC_ROOT, "src", "template", "references", "design-review_spec", "verify.md"),
      path.join(specDir, "verify.md"),
    );
  }

  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: root };
  if (!withDesignReviewBranch) {
    // No branch: remove the design-review stage and point plan at develop.
    json.stages.plan!.nextStage = "develop";
    delete (json.stages as Partial<PipelineJsonConfig["stages"]>)["design-review"];
  }
  const jsonPath = path.join(root, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");

  const resolved = resolvePipelineConfig(json);
  for (const [name, stageConfig] of Object.entries(resolved.stages)) {
    if (stageConfig && (tier === "rule" || name !== "design-review")) {
      delete (stageConfig as { verify?: unknown }).verify;
    }
  }
  return { ...resolved, configSourcePath: jsonPath };
}

async function runCase(opts: {
  startStage: PipelineStage | "clarify";
  tier: "rule" | "assisted";
  withDesignReviewBranch?: boolean;
}): Promise<CaseAudit[]> {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-227-start-audit-"));
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  const audits: CaseAudit[] = [];
  __setSafeWriteAuditLogOverride(async (event, message) => {
    audits.push({ event, message: message as Record<string, string | boolean> | undefined });
  });
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
    const result = await startAutoJob({
      config: prepareCase({
        root,
        startStage: opts.startStage,
        tier: opts.tier,
        withDesignReviewBranch: opts.withDesignReviewBranch !== false,
      }),
      ctx: ctx as never,
      jobId: "alpha_loop",
    });
    expect(result.success).toBe(true);
    return audits;
  } finally {
    __resetAutoJobLockForTests();
    __resetFinalizeStateForTests();
    __setSafeWriteAuditLogOverride(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("227 P6: design-review branch skipped by a late startStage", () => {
  it("assisted + startStage develop + branch present → audited", async () => {
    const audits = await runCase({ startStage: "develop", tier: "assisted" });
    const hit = audits.filter((a) => a.event === "design_review_skipped_by_start_stage");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message?.startStage).toBe("develop");
  });

  it("rule tier → no audit (the branch was never promised)", async () => {
    const audits = await runCase({ startStage: "develop", tier: "rule" });
    expect(audits.some((a) => a.event === "design_review_skipped_by_start_stage")).toBe(false);
  });

  it("an early startStage (clarify) → no audit", async () => {
    const audits = await runCase({ startStage: "clarify", tier: "assisted" });
    expect(audits.some((a) => a.event === "design_review_skipped_by_start_stage")).toBe(false);
  });

  it("assisted WITHOUT a design-review branch → the start is rejected (Phase 0 conflict rule)", async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "pi-227-start-audit-nobranch-"));
    __resetAutoJobLockForTests();
    __resetFinalizeStateForTests();
    __setSafeWriteAuditLogOverride(async () => {});
    writeAgentFixtures(root);
    try {
      const ctx = {
        session: {
          getMeta: () => undefined,
          updateMeta: (patch: Partial<SessionMeta>) => patch as SessionMeta,
        },
        ui: { notify: () => {}, select: async () => undefined },
        pi: { sendUserMessage: () => {} },
      };
      const result = await startAutoJob({
        config: prepareCase({
          root,
          startStage: "develop",
          tier: "assisted",
          withDesignReviewBranch: false,
        }),
        ctx: ctx as never,
        jobId: "alpha_loop",
      });
      expect(result.success).toBe(false);
    } finally {
      __resetAutoJobLockForTests();
      __resetFinalizeStateForTests();
      __setSafeWriteAuditLogOverride(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
