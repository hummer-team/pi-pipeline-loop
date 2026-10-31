/**
 * 219 Phase 2: overlay residual handling — the `session_start` replay gate
 * (plan §3-a four states) and the shutdown rollback guard (M5).
 *
 * Key behaviors:
 * - Zero / several running jobs → inert (ambiguous ownership is never guessed).
 * - Exactly one running job + no lock (or a DEAD holder pid) → replay the
 *   overlay from the job file, verify the hash, persist the snapshot once.
 * - Lock alive in ANOTHER process → do NOT replay: a second terminal's human
 *   session must not be silently flipped to auto semantics (audit + notify).
 * - Lock held by THIS process (chained continuation) → do NOT replay; the
 *   `--next` command applies the overlay itself.
 * - Hash drift → do NOT replay; `stopReason: "job_drift"` + notify.
 * - Shutdown rollback only when the sidecar exists, carries a snapshot and is
 *   NOT running (`shouldRestoreOnShutdown` type guard).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineJsonConfig } from "../../types";
import {
  acquireJobLock,
  isAutoJobActive,
  readStateForActiveLock,
  replayOverlayForSessionStart,
  restoreOverlay,
  shouldRestoreOnShutdown,
  __resetAutoJobLockForTests,
  type AutoJobSnapshot,
} from "../../core/auto-pipeline/config-overlay";
import {
  createJobState,
  readJobState,
  resolveJobStatePath,
  writeJobState,
  type AutoJobState,
} from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { AUTO_PIPELINE_LOCK_FILE } from "../../constants";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

const JOB_ID = "alpha";
const JOB_REL_PATH = "docs/jobs/alpha.yaml";
const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/200_Feat.md",
  "confirm:",
  "  plan: auto",
  "  review: auto",
  "writePolicy:",
  "  whitelistMiss: deny",
].join("\n");

let ROOT: string;
let audits: string[];
let notified: string[];
let errorSpy: ReturnType<typeof spyOn>;

function writeJobFile(content = JOB_YAML): string {
  const jobPath = path.join(ROOT, JOB_REL_PATH);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, content, "utf8");
  return content;
}

function writeConfigFile(json: PipelineJsonConfig): string {
  const jsonPath = path.join(ROOT, ".pi", "pipeline_loop.json");
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
  return jsonPath;
}

/** Live config resolved exactly like production, wired to the on-disk JSON. */
function makeLiveConfig(): {
  config: ReturnType<typeof resolvePipelineConfig>;
  jsonPath: string;
} {
  const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: ROOT };
  const jsonPath = writeConfigFile(json);
  const config = resolvePipelineConfig(json);
  config.configSourcePath = jsonPath;
  return { config, jsonPath };
}

async function writeRunningState(overrides?: Partial<AutoJobState>): Promise<AutoJobState> {
  const raw = JOB_YAML;
  const state = createJobState({
    jobId: JOB_ID,
    jobPath: JOB_REL_PATH,
    jobHash: hashJobBytes(raw),
    docs: [{ doc: "docs/design/200_Feat.md" }],
  });
  const running: AutoJobState = { ...state, status: "running", ...overrides };
  await writeJobState(ROOT, running);
  return running;
}

function writeLock(pid: number, token = "lock-token", jobId = JOB_ID): void {
  const lockPath = path.join(ROOT, AUTO_PIPELINE_LOCK_FILE);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ token, jobId, pid, startedAt: 1 }, null, 2), "utf8");
}

const DEAD_PID = 4194303;

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-residual-"));
  __resetAutoJobLockForTests();
  audits = [];
  notified = [];
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

describe("overlay-residual — session_start replay gate", () => {
  it("state 0: no running job → inert", async () => {
    const { config } = makeLiveConfig();
    await replayOverlayForSessionStart(config, (m) => notified.push(m));
    expect(config.stages.plan?.confirm?.mode).toBe("manual");
    expect(notified).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("state 1: exactly one running job + no lock → replay + snapshot persisted + audit", async () => {
    const { config } = makeLiveConfig();
    writeJobFile();
    await writeRunningState();

    await replayOverlayForSessionStart(config, (m) => notified.push(m));

    expect(config.stages.plan?.confirm?.mode).toBe("auto");
    expect(config.stages.review?.confirm?.mode).toBe("auto");
    expect(config.protect?.whitelistMiss).toBe("deny");
    const persisted = readJobState(ROOT, JOB_ID);
    expect(persisted?.overlaySnapshot?.jobHash).toBe(hashJobBytes(JOB_YAML));
    expect(persisted?.overlaySnapshot?.before["stages.plan.confirm.mode"]).toBe("manual");
    expect(audits).toContain("pipeline_auto_overlay_replay");
  });

  it("state 1: a DEAD lock holder is reclaimed by the replay path", async () => {
    const { config } = makeLiveConfig();
    writeJobFile();
    await writeRunningState();
    writeLock(DEAD_PID, "dead-token");

    await replayOverlayForSessionStart(config, (m) => notified.push(m));
    expect(config.stages.plan?.confirm?.mode).toBe("auto");
  });

  it("state 2: lock alive in ANOTHER process → no replay, audit + notify", async () => {
    const { config } = makeLiveConfig();
    writeJobFile();
    await writeRunningState();
    writeLock(1, "foreign-token"); // pid 1 is alive and is not us

    await replayOverlayForSessionStart(config, (m) => notified.push(m));

    expect(config.stages.plan?.confirm?.mode).toBe("manual");
    expect(audits).toContain("pipeline_auto_lock");
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("another process");
    // No snapshot was recorded for this session.
    expect(readJobState(ROOT, JOB_ID)?.overlaySnapshot).toBeUndefined();
  });

  it("state 3: lock pid is THIS process (chained continuation) → no replay", async () => {
    const { config } = makeLiveConfig();
    writeJobFile();
    await writeRunningState();
    writeLock(process.pid, "own-token");

    await replayOverlayForSessionStart(config, (m) => notified.push(m));
    expect(config.stages.plan?.confirm?.mode).toBe("manual");
    expect(notified).toEqual([]);
  });

  it("state 3b: an in-process active runner → no replay even without a lock file", async () => {
    const { config } = makeLiveConfig();
    writeJobFile();
    await writeRunningState();
    const acquired = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
    expect(acquired.ok).toBe(true);
    fs.rmSync(path.join(ROOT, AUTO_PIPELINE_LOCK_FILE), { force: true });
    expect(isAutoJobActive()).toBe(true);

    await replayOverlayForSessionStart(config, (m) => notified.push(m));
    expect(config.stages.plan?.confirm?.mode).toBe("manual");
  });

  it("state 4: hash drift → no replay, stopReason job_drift + notify", async () => {
    const { config } = makeLiveConfig();
    writeJobFile(); // hash of YAML-A
    await writeRunningState({ jobHash: "hash-of-an-older-version" });

    await replayOverlayForSessionStart(config, (m) => notified.push(m));

    expect(config.stages.plan?.confirm?.mode).toBe("manual");
    expect(readJobState(ROOT, JOB_ID)?.stopReason).toBe("job_drift");
    expect(readJobState(ROOT, JOB_ID)?.overlaySnapshot).toBeUndefined();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("changed since the run started");
  });

  it("several running jobs → ambiguous ownership, inert", async () => {
    const { config } = makeLiveConfig();
    writeJobFile();
    await writeRunningState();
    const beta = createJobState({
      jobId: "beta",
      jobPath: "docs/jobs/beta.yaml",
      jobHash: "hash-b",
      docs: [{ doc: "docs/design/201_Feat.md" }],
    });
    await writeJobState(ROOT, { ...beta, status: "running" });

    await replayOverlayForSessionStart(config, (m) => notified.push(m));
    expect(config.stages.plan?.confirm?.mode).toBe("manual");
    expect(notified).toEqual([]);
  });

  it("unreadable job file → inert (never blocks session start)", async () => {
    const { config } = makeLiveConfig();
    await writeRunningState(); // job file deliberately absent
    await replayOverlayForSessionStart(config, (m) => notified.push(m));
    expect(config.stages.plan?.confirm?.mode).toBe("manual");
    expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("replaying twice reuses the recorded snapshot (B4: no before pollution)", async () => {
    const { config } = makeLiveConfig();
    writeJobFile();
    await writeRunningState();

    await replayOverlayForSessionStart(config, (m) => notified.push(m));
    const firstSnapshot = readJobState(ROOT, JOB_ID)?.overlaySnapshot;
    await replayOverlayForSessionStart(config, (m) => notified.push(m));
    const secondSnapshot = readJobState(ROOT, JOB_ID)?.overlaySnapshot;

    expect(secondSnapshot?.appliedAt).toBe(firstSnapshot?.appliedAt);
    expect(secondSnapshot?.before).toEqual(firstSnapshot?.before);
    expect(secondSnapshot?.before["stages.plan.confirm.mode"]).toBe("manual");
    expect(config.stages.plan?.confirm?.mode).toBe("auto");
  });
});

describe("overlay-residual — shutdown guard (M5)", () => {
  function snapshot(): AutoJobSnapshot {
    return {
      jobId: JOB_ID,
      jobPath: JOB_REL_PATH,
      jobHash: "h",
      appliedAt: 1,
      before: { "stages.plan.confirm.mode": "manual" },
      entries: [{ jobKey: "confirm.plan", configPath: "stages.plan.confirm.mode", from: "manual", to: "auto" }],
    };
  }

  async function stateWith(status: AutoJobState["status"], withSnapshot: boolean): Promise<AutoJobState> {
    const base = createJobState({
      jobId: JOB_ID,
      jobPath: JOB_REL_PATH,
      jobHash: "h",
      docs: [{ doc: "docs/design/200_Feat.md" }],
    });
    const state: AutoJobState = { ...base, status };
    if (withSnapshot) {
      const snap = snapshot();
      state.overlaySnapshot = {
        appliedAt: snap.appliedAt,
        jobHash: snap.jobHash,
        before: snap.before,
        entries: snap.entries,
      };
    }
    await writeJobState(ROOT, state);
    return state;
  }

  it("truth table: only a non-running state WITH a snapshot restores", async () => {
    expect(shouldRestoreOnShutdown(null)).toBe(false);

    const noSnapshot = await stateWith("completed", false);
    expect(shouldRestoreOnShutdown(noSnapshot)).toBe(false);

    const running = await stateWith("running", true);
    expect(shouldRestoreOnShutdown(running)).toBe(false); // job continues: keep the overlay

    for (const status of ["completed", "stopped", "failed", "idle"] as const) {
      const state = await stateWith(status, true);
      expect(shouldRestoreOnShutdown(state)).toBe(true);
    }
  });

  it("readStateForActiveLock resolves the sidecar behind the lock; null without a lock", async () => {
    await stateWith("completed", true);
    expect(readStateForActiveLock(ROOT)).toBeNull();

    writeLock(process.pid);
    const state = readStateForActiveLock(ROOT);
    expect(state?.jobId).toBe(JOB_ID);
    expect(resolveJobStatePath(ROOT, JOB_ID)).toContain(JOB_ID);
  });

  it("restoring from the sidecar snapshot returns the live config to the pre-overlay values", async () => {
    const { config } = makeLiveConfig();
    writeJobFile();
    await writeRunningState();
    await replayOverlayForSessionStart(config, () => undefined);
    expect(config.stages.plan?.confirm?.mode).toBe("auto");

    const state = readJobState(ROOT, JOB_ID);
    expect(state).not.toBeNull();
    // Job finished while this process was alive: shutdown is the only rollback.
    state!.status = "completed";
    await writeJobState(ROOT, state!);

    const reloaded = readJobState(ROOT, JOB_ID);
    if (shouldRestoreOnShutdown(reloaded)) {
      restoreOverlay(config, reloaded.overlaySnapshot);
    }
    expect(config.stages.plan?.confirm?.mode).toBe("manual");
  });
});
