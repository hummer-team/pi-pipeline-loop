/**
 * 227 Phase 1 (D-6): a CHILD session adopts the running job's overlay
 * READ-ONLY, by identity (`meta.autoJob.jobId` == the running job).
 *
 * Pins:
 * - identity match ⇒ the recorded values are stamped onto the live config;
 * - jobId mismatch / hash drift / absent snapshot ⇒ no adoption;
 * - zero side effects: no lock acquisition, no sidecar write;
 * - a child that never inherited `autoJob` (e.g. the pre-JOIN meta) is inert;
 * - the replayed value is the RESOLVED one, so owner and child cannot diverge
 *   around a disabled stage.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, SessionMeta } from "../../types";
import {
  applyOverlay,
  isAutoJobActive,
  replayOverlayForChildSessionStart,
  __resetAutoJobLockForTests,
} from "../../core/auto-pipeline/config-overlay";
import { parseAutoJob, hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { createJobState, readJobState, writeJobState, type AutoJobState } from "../../core/auto-pipeline/job-state";
import { resolvePipelineConfig } from "../../core/json-config-loader";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "childjob_loop";
const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/227_Bug.md",
  "confirm:",
  "  plan: auto",
  "",
].join("\n");

let ROOT: string;

function baseJson(): PipelineJsonConfig {
  const clone = structuredClone(TEMPLATE_JSON);
  clone.projectRoot = ROOT;
  return clone;
}

function writeJobFile(raw = JOB_YAML): void {
  const dir = path.join(ROOT, "docs", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${JOB_ID}.yaml`), raw, "utf8");
}

function writeLock(): void {
  const lockPath = path.join(ROOT, ".pi", "auto_pipeline", "lock.json");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ token: "tok", jobId: JOB_ID, pid: process.pid, startedAt: Date.now() }),
    "utf8",
  );
}

async function writeSidecar(input?: {
  jobHash?: string;
  status?: AutoJobState["status"];
  entries?: AutoJobState["overlaySnapshot"] extends undefined ? never : NonNullable<AutoJobState["overlaySnapshot"]>["entries"];
}): Promise<AutoJobState> {
  const state = createJobState({
    jobId: JOB_ID,
    jobPath: `docs/jobs/${JOB_ID}.yaml`,
    jobHash: input?.jobHash ?? hashJobBytes(JOB_YAML),
    docs: [{ doc: "docs/design/227_Bug.md" }],
  });
  state.status = input?.status ?? "running";
  state.overlaySnapshot = {
    appliedAt: Date.now(),
    jobHash: input?.jobHash ?? hashJobBytes(JOB_YAML),
    before: { "stages.plan.confirm.mode": "manual" },
    entries: input?.entries ?? [
      { jobKey: "confirm.plan", configPath: "stages.plan.confirm.mode", from: "manual", to: "auto" },
    ],
  };
  await writeJobState(ROOT, state);
  return state;
}

function childMeta(jobId = JOB_ID): SessionMeta {
  return {
    currentStage: "plan",
    pipelineId: "pipe-child",
    autoJob: { jobId, jobPath: `docs/jobs/${JOB_ID}.yaml`, docIndex: 0, totalDocs: 1 },
  } as SessionMeta;
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-227-child-overlay-"));
  __resetAutoJobLockForTests();
  writeJobFile();
  writeLock();
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  __resetAutoJobLockForTests();
});

describe("child overlay replay — identity + adoption", () => {
  it("adopts the recorded values when the jobId matches the running job", async () => {
    await writeSidecar();
    const live: PipelineConfig = resolvePipelineConfig(baseJson());
    expect(live.stages.plan.confirm?.mode).toBe("manual");

    const notices: string[] = [];
    await replayOverlayForChildSessionStart(live, childMeta(), (m) => notices.push(m));

    expect(live.stages.plan.confirm?.mode).toBe("auto");
    expect(live.configOverlayKeys).toEqual(["stages.plan.confirm.mode"]);
    expect(notices).toHaveLength(0);
  });

  it("never acquires the lock and never writes the sidecar", async () => {
    const state = await writeSidecar();
    const before = fs.readFileSync(
      path.join(ROOT, ".pi", "auto_pipeline", JOB_ID, "state.json"),
      "utf8",
    );
    const live: PipelineConfig = resolvePipelineConfig(baseJson());
    await replayOverlayForChildSessionStart(live, childMeta(), () => {});

    expect(isAutoJobActive()).toBe(false);
    const after = fs.readFileSync(
      path.join(ROOT, ".pi", "auto_pipeline", JOB_ID, "state.json"),
      "utf8",
    );
    expect(after).toBe(before);
    expect(readJobState(ROOT, JOB_ID)?.updatedAt).toBe(state.updatedAt);
  });
});

describe("child overlay replay — refusal paths", () => {
  it("a different jobId is never adopted", async () => {
    await writeSidecar();
    const live: PipelineConfig = resolvePipelineConfig(baseJson());
    await replayOverlayForChildSessionStart(live, childMeta("other_loop"), () => {});
    expect(live.stages.plan.confirm?.mode).toBe("manual");
  });

  it("hash drift skips adoption and notifies", async () => {
    await writeSidecar({ jobHash: "deadbeef" });
    const live: PipelineConfig = resolvePipelineConfig(baseJson());
    const notices: string[] = [];
    await replayOverlayForChildSessionStart(live, childMeta(), (m) => notices.push(m));
    expect(live.stages.plan.confirm?.mode).toBe("manual");
    expect(notices[0]).toContain("file changed");
  });

  it("a non-running sidecar is inert", async () => {
    await writeSidecar({ status: "stopped" });
    const live: PipelineConfig = resolvePipelineConfig(baseJson());
    await replayOverlayForChildSessionStart(live, childMeta(), () => {});
    expect(live.stages.plan.confirm?.mode).toBe("manual");
  });
});

describe("child overlay replay — human track + JOIN-ordering regression", () => {
  it("a meta WITHOUT autoJob (the pre-JOIN snapshot) is inert", async () => {
    await writeSidecar();
    const live: PipelineConfig = resolvePipelineConfig(baseJson());
    // Regression: replay must read the meta AFTER join — the pre-JOIN snapshot
    // carries no autoJob, and replaying with it must change nothing.
    await replayOverlayForChildSessionStart(live, { currentStage: "plan", pipelineId: "p1" } as SessionMeta, () => {});
    expect(live.stages.plan.confirm?.mode).toBe("manual");
    expect(live.configOverlayKeys).toBeUndefined();
  });

  it("a human child (no autoJob, null meta) is unaffected", async () => {
    await writeSidecar();
    const live: PipelineConfig = resolvePipelineConfig(baseJson());
    await replayOverlayForChildSessionStart(live, null, () => {});
    await replayOverlayForChildSessionStart(live, undefined, () => {});
    expect(live.stages.plan.confirm?.mode).toBe("manual");
  });
});

describe("child overlay replay — resolved-value parity", () => {
  it("child and owner land on the SAME resolved nextStage around a disabled stage", async () => {
    const json = baseJson();
    // The job asks for the branch, but the target stage is disabled, so the
    // loader reconnects plan → develop. A raw replay of the job's value would
    // leave the child on "design-review" while the owner runs "develop".
    expect(json.stages.plan!.nextStage).toBe("develop");
    json.stages["design-review"]!.require = false;
    json.stages["design-review"]!.verify = { ...(json.stages["design-review"]!.verify ?? {}), require: false };

    const parsed = parseAutoJob(`${JOB_YAML}designReview:\n  enabled: true\n`, `docs/jobs/${JOB_ID}.yaml`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const owner: PipelineConfig = resolvePipelineConfig(structuredClone(json));
    const snapshot = applyOverlay(owner, json, {
      ...parsed.job,
      jobHash: parsed.hash,
      jobId: JOB_ID,
      jobPath: `docs/jobs/${JOB_ID}.yaml`,
    });
    const topology = snapshot.entries.find((e) => e.configPath === "stages.plan.nextStage");
    expect(topology?.to).toBe("develop");
    expect(topology?.from).toBe("develop");
    expect(owner.stages.plan.nextStage).toBe("develop");

    await writeSidecar({ entries: snapshot.entries });
    const child: PipelineConfig = resolvePipelineConfig(structuredClone(json));
    await replayOverlayForChildSessionStart(child, childMeta(), () => {});

    expect(child.stages.plan.nextStage).toBe(owner.stages.plan.nextStage);
  });
});
