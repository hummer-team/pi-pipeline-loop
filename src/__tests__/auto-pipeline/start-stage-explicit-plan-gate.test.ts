/**
 * 224 Phase 0: the explicit-plan clarify marker gate at the RUNNER level.
 *
 * Scope: the command wiring (`startAutoJob` → `checkStartStageEvidence`) for
 * `startStage: plan` with `derivation: "explicit"` — the sidecar basis, the
 * `pipeline_auto_start_stage_rejected` audit, the doc failure and the two new
 * user hints (`clarify-confirmation` / `plan-confirmed`). The pure evidence
 * matrix lives in `start-stage-evidence.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { startAutoJob } from "../../commands/pipeline-auto";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { readJobState } from "../../core/auto-pipeline/job-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "plan_gate_loop";
const REJECT_AUDIT = "pipeline_auto_start_stage_rejected";
const REQUIREMENT = "docs/design/200_Feat.md";
const PLAN = "docs/design/200_Feat_Plan.md";
const DEFAULT_MARKER = "## 模型确认";
const CUSTOM_MARKER = "## 澄清已确认";

let ROOT: string;
let audits: Array<{ stage: string; message?: Record<string, string | boolean> }>;
let errorSpy: ReturnType<typeof spyOn>;

function jobYaml(opts: { perDocStartStage?: string; defaultStartStage?: string } = {}): string {
  const lines = [
    "version: 1",
    "enabled: true",
    // 220 C-2: the resolved config has no verify blocks (the runner never
    // verifies), so the `assisted` tier precondition would refuse the job.
    "tier: rule",
    "docs:",
    "  list:",
    `    - doc: ${REQUIREMENT}`,
  ];
  if (opts.perDocStartStage) {
    lines.push(`      startStage: ${opts.perDocStartStage}`);
  }
  lines.push("  skipCompleted: false", "  onFailure: stop", "chain:", "  newSession: false");
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

/**
 * 224 Phase 1: the auto track dispatches the start-stage executor, so the
 * harness must satisfy the P-A pre-check (`resolveAgentMention`) — copy the
 * template agent files into the project root.
 */
function writeAgentFixtures(): void {
  const dir = path.join(ROOT, ".pi", "agents");
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

function writeFile(rel: string, content: string): void {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function config(opts: { completionMarker?: string } = {}): PipelineConfig {
  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: ROOT };
  const jsonPath = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  const resolved = resolvePipelineConfig(json);
  for (const stage of Object.values(resolved.stages)) {
    if (stage) delete (stage as { verify?: unknown }).verify;
  }
  const clarify = resolved.stages.clarify;
  if (opts.completionMarker && clarify) {
    (clarify as { verify?: { completionMarker?: string } }).verify = {
      completionMarker: opts.completionMarker,
    };
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

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-224-plan-gate-"));
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  audits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push({ stage, message });
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("explicit plan start — the clarify marker gate (224 Phase 0)", () => {
  it("no marker configured → no gate: the doc starts with basis clarify-confirmation", async () => {
    // Boundary: an UNCONFIGURED marker must NOT invent a gate (223 parity).
    writeJob(jobYaml({ perDocStartStage: "plan" }));
    writeAgentFixtures();
    writeFile(REQUIREMENT, "# requirement\nno confirmation marker here\n");
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(meta()?.currentStage).toBe("plan");
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.status).toBe("running");
    expect(state.docs[0]?.startStageDerivation).toBe("explicit");
    expect(state.docs[0]?.startStageBasis).toBe("clarify-confirmation");
    expect(audits.filter((audit) => audit.stage === REJECT_AUDIT)).toHaveLength(0);
  });

  it("default marker present on the requirement → starts with basis clarify-confirmation", async () => {
    writeJob(jobYaml({ perDocStartStage: "plan" }));
    writeAgentFixtures();
    writeFile(REQUIREMENT, `# requirement\n${DEFAULT_MARKER}\nok\n`);
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({
      config: config({ completionMarker: DEFAULT_MARKER }),
      ctx,
      jobId: JOB_ID,
    });

    expect(result.success).toBe(true);
    expect(meta()?.currentStage).toBe("plan");
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.startStageBasis).toBe("clarify-confirmation");
  });

  it("custom marker alias on the requirement → starts with basis clarify-confirmation", async () => {
    writeJob(jobYaml({ perDocStartStage: "plan" }));
    writeAgentFixtures();
    writeFile(REQUIREMENT, `# requirement\n${CUSTOM_MARKER}\nok\n`);
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({
      config: config({ completionMarker: CUSTOM_MARKER }),
      ctx,
      jobId: JOB_ID,
    });

    expect(result.success).toBe(true);
    expect(meta()?.currentStage).toBe("plan");
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.startStageBasis).toBe("clarify-confirmation");
  });

  it("marker configured but missing on the requirement → failed doc, one audit, hint notify", async () => {
    writeJob(jobYaml({ perDocStartStage: "plan" }));
    writeAgentFixtures();
    writeFile(REQUIREMENT, "# requirement\nno confirmation marker here\n");
    const { ctx, notified } = makeCtx();

    const result = await startAutoJob({
      config: config({ completionMarker: DEFAULT_MARKER }),
      ctx,
      jobId: JOB_ID,
    });

    expect(result.success).toBe(false);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.status).toBe("failed");
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[0]?.failReason).toBe("start_stage_evidence_missing:clarify-confirmation");
    expect(state.docs[0]?.lastStage).toBeUndefined(); // no pipeline started
    expect(state.docIndex).toBe(0);
    expect(state.docs[0]?.startStageBasis).toBeUndefined();
    const reject = audits.filter((audit) => audit.stage === REJECT_AUDIT);
    expect(reject).toHaveLength(1);
    expect(reject[0]?.message?.missing).toBe("clarify-confirmation");
    expect(notified.some((message) => message.includes("no clarification confirmation yet"))).toBe(
      true,
    );
  });

  it("plan document already confirmed → missing:plan-confirmed with a redirect hint", async () => {
    writeJob(jobYaml({ perDocStartStage: "plan" }));
    writeAgentFixtures();
    writeFile(REQUIREMENT, `# requirement\n${DEFAULT_MARKER}\nok\n`);
    writeFile(PLAN, "# plan\n## User Confirmation\nconfirmed\n");
    const { ctx, notified } = makeCtx();

    const result = await startAutoJob({
      config: config({ completionMarker: DEFAULT_MARKER }),
      ctx,
      jobId: JOB_ID,
    });

    expect(result.success).toBe(false);
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.status).toBe("failed");
    expect(state.docs[0]?.failReason).toBe("start_stage_evidence_missing:plan-confirmed");
    expect(state.docIndex).toBe(0);
    const reject = audits.filter((audit) => audit.stage === REJECT_AUDIT);
    expect(reject[0]?.message?.missing).toBe("plan-confirmed");
    // Never overwrite a plan the user already confirmed: point at develop/auto.
    expect(notified.some((message) => message.includes('"develop" or "auto"'))).toBe(true);
  });

  it("missing requirement document wins over the marker gate (requirement reported first)", async () => {
    // Boundary: the evidence gate reports `requirement` BEFORE any marker check.
    writeJob(jobYaml({ perDocStartStage: "plan" }));
    writeAgentFixtures();
    const { ctx, notified } = makeCtx();

    const result = await startAutoJob({
      config: config({ completionMarker: DEFAULT_MARKER }),
      ctx,
      jobId: JOB_ID,
    });

    expect(result.success).toBe(false);
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.failReason).toBe(
      "start_stage_evidence_missing:requirement",
    );
    // Hint only for the two NEW plan rejections; the requirement rejection
    // keeps the existing "audit + failDoc" behaviour (notifyAuto may still
    // report the doc failure itself).
    expect(notified.some((message) => message.includes("no clarification confirmation yet"))).toBe(
      false,
    );
    expect(notified.some((message) => message.includes('"develop" or "auto"'))).toBe(false);
  });

  it("derived auto start at plan is NOT vetoed by the gate (basis stays requirement)", async () => {
    // An unconfirmed plan sends `auto` derivation to plan; that path keeps the
    // 220 D5 semantics — the marker gate applies to explicit starts only.
    writeFile(REQUIREMENT, "# requirement\nno confirmation marker here\n");
    writeFile(PLAN, "# plan\n## 目的\nnot confirmed\n");
    writeJob(jobYaml({ defaultStartStage: "auto" }));
    writeAgentFixtures();
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({ config: config(), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(meta()?.currentStage).toBe("plan");
    const state = readJobState(ROOT, JOB_ID)!;
    expect(state.docs[0]?.startStageDerivation).toBe("auto");
    expect(state.docs[0]?.startStageBasis).toBe("requirement");
    expect(audits.filter((audit) => audit.stage === REJECT_AUDIT)).toHaveLength(0);
  });
});
