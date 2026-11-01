/**
 * 220 Phase 5 (D5): the start-stage wiring in the auto runner.
 *
 * Scope (Y3): ONLY the command-layer wiring — evidence gate ordering, failure
 * routing (`onFailure`, `docIndex`, single audit, `reason` encoding) and the
 * sidecar evidence stamps. The pure evidence matrix lives in
 * `start-stage-evidence.test.ts`; the `"auto"` derivation lives in
 * `resolve-start-stage.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, PipelineStage, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { RESUMABLE_STAGES } from "../../constants";
import { startAutoJob } from "../../commands/pipeline-auto";
import { isAutoJobActive, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { readJobState } from "../../core/auto-pipeline/job-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "alpha_loop";
const REJECT_AUDIT = "pipeline_auto_start_stage_rejected";
const REQUIREMENT = "docs/design/200_Feat.md";
const PLAN = "docs/design/200_Feat_Plan.md";
const COMMIT = "docs/design/200_Feat_Develop_Commit.md";
const REVIEW_REPORT = "docs/review/Code_Review_200_Feat_Develop_Commit_1.md";

let ROOT: string;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

function jobYaml(opts: {
  docs?: string[];
  startStage?: string;
  defaultStartStage?: string;
  onFailure?: string;
}): string {
  const lines = [
    "version: 1",
    "enabled: true",
    // 220 C-2: the resolved config has no verify blocks (the runner never
    // verifies), so the `assisted` tier precondition would refuse the job.
    "tier: rule",
    "docs:",
    "  list:",
  ];
  for (const doc of opts.docs ?? [REQUIREMENT]) {
    lines.push(`    - doc: ${doc}`);
    if (opts.startStage) lines.push(`      startStage: ${opts.startStage}`);
  }
  lines.push("  skipCompleted: false");
  lines.push(`  onFailure: ${opts.onFailure ?? "stop"}`);
  // Same-session continuation keeps the assertion on THIS invocation's sidecar.
  lines.push("chain:");
  lines.push("  newSession: false");
  if (opts.defaultStartStage) {
    lines.push("defaults:");
    lines.push(`  startStage: ${opts.defaultStartStage}`);
  }
  return lines.join("\n");
}

function writeJob(yaml: string): void {
  const jobPath = path.join(ROOT, "docs", "jobs", `${JOB_ID}.yaml`);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, yaml, "utf8");
}

function writeFile(rel: string, content: string): void {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function config(): PipelineConfig {
  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: ROOT };
  const jsonPath = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  const resolved = resolvePipelineConfig(json);
  for (const stage of Object.values(resolved.stages)) {
    if (stage) delete (stage as { verify?: unknown }).verify;
  }
  return { ...resolved, configSourcePath: jsonPath };
}

function makeCtx() {
  let meta: SessionMeta | undefined;
  const notified: string[] = [];
  return {
    ctx: {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
          return meta;
        },
      },
      ui: { notify: (message: string) => notified.push(message), select: async () => undefined },
      pi: { sendUserMessage: () => undefined },
    },
    meta: () => meta,
    notified,
  };
}

/**
 * Write exactly the evidence a stage needs. The requirement document is also
 * written because the pipeline start itself reads it (the evidence gate only
 * proves the STAGE is startable — it never substitutes for the requirement).
 */
function writeEvidence(stage: PipelineStage): void {
  if (stage !== "clarify" && stage !== "plan") writeFile(REQUIREMENT, "# requirement\n");
  switch (stage) {
    case "clarify":
    case "plan":
      writeFile(REQUIREMENT, "# requirement\n");
      return;
    case "design-review":
      writeFile(PLAN, "# plan\n");
      return;
    case "develop":
      writeFile(PLAN, "# plan\n## User Confirmation\nconfirmed\n");
      return;
    case "review":
      writeFile(COMMIT, "# commit\n");
      return;
    case "fix":
      writeFile(REVIEW_REPORT, "## To-Fix\n- one issue\n");
      return;
    default:
      throw new Error(`unexpected stage ${stage}`);
  }
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-220-start-stage-"));
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  audits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage) => {
    audits.push(stage);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("start-stage runner — every start stage is startable with its evidence", () => {
  for (const stage of RESUMABLE_STAGES) {
    it(`${stage}: starts, records lastStage + evidence stamps`, async () => {
      writeJob(jobYaml({ startStage: stage }));
      writeEvidence(stage);
      const { ctx, meta } = makeCtx();

      const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

      expect(result.success).toBe(true);
      expect(meta()?.currentStage).toBe(stage);
      const state = readJobState(ROOT, JOB_ID)!;
      expect(state.docs[0]?.status).toBe("running");
      expect(state.docs[0]?.lastStage).toBe(stage); // H4: same value as the start
      expect(state.docs[0]?.startStageDerivation).toBe("explicit");
      expect(state.docs[0]?.startStageBasis).toBeDefined();
      expect(state.docIndex).toBe(0);
      expect(audits).not.toContain(REJECT_AUDIT);
    });
  }
});

describe("start-stage runner — missing evidence is a doc failure, never a fallback", () => {
  it("clarify without the requirement → failed, docIndex untouched, one audit", async () => {
    writeJob(jobYaml({ startStage: "clarify" }));
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(false);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.status).toBe("failed");
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[0]?.failReason).toBe("start_stage_evidence_missing:requirement");
    expect(state.docs[0]?.lastStage).toBeUndefined(); // no pipeline started
    expect(state.docIndex).toBe(0);
    expect(meta()?.requirementDoc).toBeUndefined(); // no fallback start either
    expect(audits.filter((stage) => stage === REJECT_AUDIT)).toHaveLength(1);
    expect(isAutoJobActive()).toBe(false);
  });

  it("design-review without the derived plan → missing:plan (never another doc's plan)", async () => {
    writeFile(REQUIREMENT, "# requirement\n"); // the requirement exists, the plan does not
    writeFile("docs/design/999_Other_Plan.md", "# someone else's plan\n");
    writeJob(jobYaml({ startStage: "design-review" }));
    const { ctx } = makeCtx();

    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.failReason).toBe(
      "start_stage_evidence_missing:plan",
    );
  });

  it("develop without the confirmation marker → missing:plan-confirmed", async () => {
    writeFile(PLAN, "# plan\n## 目的\nnot confirmed\n");
    writeJob(jobYaml({ startStage: "develop" }));
    const { ctx } = makeCtx();

    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.failReason).toBe(
      "start_stage_evidence_missing:plan-confirmed",
    );
  });

  it("develop without any plan → missing:plan (distinguishable from unconfirmed)", async () => {
    writeFile(REQUIREMENT, "# requirement\n"); // the plan is absent entirely
    writeJob(jobYaml({ startStage: "develop" }));
    const { ctx } = makeCtx();

    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.failReason).toBe(
      "start_stage_evidence_missing:plan",
    );
  });

  it("review without the commit document → missing:commit", async () => {
    writeFile(REQUIREMENT, "# requirement\n");
    writeJob(jobYaml({ startStage: "review" }));
    const { ctx } = makeCtx();

    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.failReason).toBe(
      "start_stage_evidence_missing:commit",
    );
  });

  it("fix without a fixable report → missing:review-verdict", async () => {
    writeFile(REVIEW_REPORT, "Verdict: PASS\nall good\n");
    writeJob(jobYaml({ startStage: "fix" }));
    const { ctx } = makeCtx();

    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.failReason).toBe(
      "start_stage_evidence_missing:review-verdict",
    );
  });

  it("onFailure:continue → the next (startable) doc runs, docIndex advances to it", async () => {
    writeJob(
      jobYaml({
        docs: [REQUIREMENT, "docs/design/201_Feat.md"],
        startStage: "clarify",
        onFailure: "continue",
      }),
    );
    writeFile("docs/design/201_Feat.md", "# second requirement\n");
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[0]?.failReason).toBe("start_stage_evidence_missing:requirement");
    expect(state.docs[1]?.status).toBe("running");
    expect(state.docs[1]?.startStageBasis).toBe("requirement");
    expect(state.docIndex).toBe(1);
    expect(meta()?.requirementDoc).toBe("docs/design/201_Feat.md");
    expect(audits.filter((stage) => stage === REJECT_AUDIT)).toHaveLength(1);
  });
});

describe("start-stage runner — job-wide auto derivation", () => {
  it("auto + confirmed plan → develop, stamped derivation:auto", async () => {
    writeFile(REQUIREMENT, "# requirement\n");
    writeFile(PLAN, "# plan\n## User Confirmation\nconfirmed\n");
    writeJob(jobYaml({ defaultStartStage: "auto" }));
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(meta()?.currentStage).toBe("develop");
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.lastStage).toBe("develop");
    expect(state.docs[0]?.startStageDerivation).toBe("auto");
    expect(state.docs[0]?.startStageBasis).toBe("plan-confirmed");
  });

  it("auto + plan without confirmation → plan, stamped derivation:auto", async () => {
    writeFile(REQUIREMENT, "# requirement\n");
    writeFile(PLAN, "# plan\n## 目的\npending\n");
    writeJob(jobYaml({ defaultStartStage: "auto" }));
    const { ctx, meta } = makeCtx();

    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(meta()?.currentStage).toBe("plan");
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.startStageDerivation).toBe("auto");
  });

  it("auto + no plan → clarify, stamped derivation:auto", async () => {
    writeFile(REQUIREMENT, "# requirement\n");
    writeJob(jobYaml({ defaultStartStage: "auto" }));
    const { ctx, meta } = makeCtx();

    await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(meta()?.currentStage).toBe("clarify");
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.startStageDerivation).toBe("auto");
    expect(state.docs[0]?.startStageBasis).toBe("requirement");
  });
});
