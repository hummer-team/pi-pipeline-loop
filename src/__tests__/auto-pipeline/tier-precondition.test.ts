/**
 * 220 Phase 5 (C-2/B15): the `tier` precondition at the command layer.
 *
 * Facts:
 * - `tier: "assisted"` promises the full comparison, so it is only meaningful
 *   when the design-review verification stage is enabled (`verify.require`).
 * - The rejection happens BEFORE the lock and the sidecar: a misconfigured job
 *   leaves no state behind and is audited exactly once.
 * - `tier: "rule"` never requires the design-review stage.
 * - The job schema stays a pure parser: the constraint is NOT raised by
 *   `parseAutoJob` (a job with `tier: assisted` parses fine on its own).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, SessionMeta } from "../../types";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { startAutoJob } from "../../commands/pipeline-auto";
import { __resetAutoJobLockForTests, isAutoJobActive, readJobLock } from "../../core/auto-pipeline/config-overlay";
import { readJobState } from "../../core/auto-pipeline/job-state";
import { parseAutoJob } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { deployHarnessAgents } from "./auto-harness";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "alpha_loop";
const REQUIREMENT = "docs/design/200_Feat.md";

let ROOT: string;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

function jobYaml(tier: "rule" | "assisted"): string {
  return [
    "version: 1",
    "enabled: true",
    `tier: ${tier}`,
    "docs:",
    "  list:",
    `    - doc: ${REQUIREMENT}`,
    "  skipCompleted: false",
    "  onFailure: stop",
    "chain:",
    "  newSession: false",
  ].join("\n");
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

/** 226 review #1: deploy the clarify executor so the startup round really dispatches.
 *  226 review round 2 (issue 3): reuses the shared harness fixture (DRY). */
function writeAgentFixtures(): void {
  deployHarnessAgents({ root: ROOT });
}

/** Resolved config with the design-review stage kept or dropped. */
function config(opts: { designReview: boolean }): PipelineConfig {
  const json: PipelineJsonConfig = {
    ...structuredClone(TEMPLATE_JSON),
    projectRoot: ROOT,
    stages: structuredClone(TEMPLATE_JSON.stages),
  };
  if (!opts.designReview) delete (json.stages as Record<string, unknown>)["design-review"];
  const jsonPath = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  const resolved = resolvePipelineConfig(json);
  // Verify-file preflight is out of scope here: keep the design-review flag that
  // the precondition reads, strip every other stage's verify block.
  for (const [name, stage] of Object.entries(resolved.stages)) {
    if (stage && name !== "design-review") delete (stage as { verify?: unknown }).verify;
  }
  return { ...resolved, configSourcePath: jsonPath };
}

function makeCtx() {
  let meta: SessionMeta | undefined;
  return {
    ctx: {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
          return meta;
        },
      },
      ui: { notify: () => undefined, select: async () => undefined },
      pi: { sendUserMessage: () => undefined },
    },
    meta: () => meta,
  };
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-220-tier-"));
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

describe("tier precondition — assisted requires design-review", () => {
  it("assisted + design-review disabled → rejected before any state is written", async () => {
    writeFile(REQUIREMENT, "# requirement\n");
    writeJob(jobYaml("assisted"));
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({ config: config({ designReview: false }), ctx, jobId: JOB_ID });

    expect(result.success).toBe(false);
    expect(result.error).toContain('tier "assisted" requires the design-review stage to be enabled');
    // No sidecar, no lock, no pipeline start.
    expect(readJobState(ROOT, JOB_ID)).toBeNull();
    expect(readJobLock(ROOT)).toBeNull();
    expect(isAutoJobActive()).toBe(false);
    expect(meta()).toBeUndefined();
    expect(audits).toContain("pipeline_auto_tier_rejected");
    expect(audits).not.toContain("pipeline_auto_start");
  });

  it("assisted + design-review enabled → the job starts normally", async () => {
    writeFile(REQUIREMENT, "# requirement\n");
    writeAgentFixtures();
    writeJob(jobYaml("assisted"));
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({ config: config({ designReview: true }), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(meta()?.currentStage).toBe("clarify");
    expect(readJobState(ROOT, JOB_ID)?.docs[0]?.status).toBe("running");
    expect(audits).not.toContain("pipeline_auto_tier_rejected");
  });
});

describe("tier precondition — rule never needs design-review", () => {
  it("rule + design-review disabled → the job starts normally", async () => {
    writeFile(REQUIREMENT, "# requirement\n");
    writeAgentFixtures();
    writeJob(jobYaml("rule"));
    const { ctx, meta } = makeCtx();

    const result = await startAutoJob({ config: config({ designReview: false }), ctx, jobId: JOB_ID });

    expect(result.success).toBe(true);
    expect(meta()?.currentStage).toBe("clarify");
    expect(audits).not.toContain("pipeline_auto_tier_rejected");
  });
});

describe("tier precondition — the schema stays a pure parser", () => {
  it("parseAutoJob accepts `tier: assisted` and reports `assisted`", () => {
    const parsed = parseAutoJob(jobYaml("assisted"), `docs/jobs/${JOB_ID}.yaml`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.job.tier).toBe("assisted");
  });

  it("the default tier is `assisted` (the stricter promise)", () => {
    const parsed = parseAutoJob(
      ["version: 1", "enabled: true", "docs:", "  list:", `    - doc: ${REQUIREMENT}`].join("\n"),
      `docs/jobs/${JOB_ID}.yaml`,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.job.tier).toBe("assisted");
  });
});
