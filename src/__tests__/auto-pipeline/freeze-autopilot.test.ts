/**
 * 219 Phase 3 (G6): the freeze autopilot — the ONLY auto decision-maker for a
 * frozen pipeline while a job owns this process.
 *
 * Key behaviors:
 * - Precedence is fixed: `byReason[reason]` → `onFreeze` → `"stop-and-report"`.
 * - `maxAutoResumes` is a cross-doc counter from the sidecar; exhaustion
 *   downgrades a would-be resume to `stop-and-report`.
 * - `totalFreezes` is incremented exactly once per intervention (single write
 *   point next to `autoResumes`).
 * - `"stop-and-report"` never falls back to the 210 provider chain (M7): even
 *   a provider rule that would resume is never consulted.
 * - Human mode (no active job) → `null`, provider chain untouched.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";
import {
  resolveFreezeAction,
  runFreezeAutopilot,
  isUnresolvableFreeze,
} from "../../core/auto-pipeline/freeze-autopilot";
import {
  acquireJobLock,
  __resetAutoJobLockForTests,
} from "../../core/auto-pipeline/config-overlay";
import {
  createJobState,
  readJobState,
  writeJobState,
  type AutoJobState,
} from "../../core/auto-pipeline/job-state";
import { hashJobBytes, parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { requestDecision } from "../../core/flow-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const JOB_ID = "alpha";
const JOB_REL_PATH = "docs/jobs/alpha.yaml";

const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/200_Feat.md",
  "freezePolicy:",
  "  onFreeze: resume",
  "  maxAutoResumes: 2",
  "  byReason:",
  "    verify_budget: stop-and-report",
  "    aborted_by_job: abort",
].join("\n");

let ROOT: string;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

function job(): AutoJobConfig {
  const parsed = parseAutoJob(JOB_YAML, JOB_REL_PATH);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.job;
}

async function installJob(input?: { counters?: Partial<AutoJobState["counters"]>; status?: AutoJobState["status"] }): Promise<AutoJobState> {
  const jobPath = path.join(ROOT, JOB_REL_PATH);
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, JOB_YAML, "utf8");
  const base = createJobState({
    jobId: JOB_ID,
    jobPath: JOB_REL_PATH,
    jobHash: hashJobBytes(JOB_YAML),
    docs: [{ doc: "docs/design/200_Feat.md" }],
  });
  const state: AutoJobState = {
    ...base,
    status: input?.status ?? "running",
    counters: { ...base.counters, ...(input?.counters ?? {}) },
  };
  await writeJobState(ROOT, state);
  const lock = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
  if (!lock.ok) throw new Error("lock acquire failed");
  return state;
}

function makeCtx(meta: SessionMeta) {
  let current = meta;
  const patches: Partial<SessionMeta>[] = [];
  const notified: string[] = [];
  return {
    ctx: {
      session: {
        getMeta: () => current,
        updateMeta: (patch: Partial<SessionMeta>) => {
          patches.push(patch);
          current = { ...current, ...patch };
          return current;
        },
      },
      ui: { notify: (message: string) => notified.push(message) },
    },
    patches,
    notified,
    current: () => current,
  };
}

function config(extra?: Partial<PipelineConfig>): PipelineConfig {
  return makeTestConfig({ projectRoot: ROOT, ...extra });
}

function blockedMeta(reason: string): SessionMeta {
  return makeTestMeta({
    currentStage: "develop",
    flowState: "blocked",
    blockedReason: reason,
  });
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-freeze-"));
  __resetAutoJobLockForTests();
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

describe("freeze-autopilot — resolveFreezeAction precedence", () => {
  it("byReason wins over onFreeze", () => {
    const state = createJobState({
      jobId: JOB_ID,
      jobPath: JOB_REL_PATH,
      jobHash: "h",
      docs: [{ doc: "docs/a.md" }],
    });
    const resolved = resolveFreezeAction({ meta: blockedMeta("verify_budget"), job: job(), state, reason: "verify_budget" });
    expect(resolved).toEqual({ action: "stop-and-report", basis: "by_reason" });
  });

  it("unmatched reason falls through to onFreeze", () => {
    const state = createJobState({ jobId: JOB_ID, jobPath: JOB_REL_PATH, jobHash: "h", docs: [{ doc: "docs/a.md" }] });
    expect(resolveFreezeAction({ meta: blockedMeta("loop_overflow"), job: job(), state, reason: "loop_overflow" })).toEqual({
      action: "resume",
      basis: "on_freeze",
    });
  });

  it("missing onFreeze falls through to stop-and-report", () => {
    const state = createJobState({ jobId: JOB_ID, jobPath: JOB_REL_PATH, jobHash: "h", docs: [{ doc: "docs/a.md" }] });
    const bare = { ...job(), freezePolicy: { ...job().freezePolicy, onFreeze: undefined as never } };
    expect(resolveFreezeAction({ meta: blockedMeta("x"), job: bare, state, reason: "x" }).action).toBe("stop-and-report");
  });

  it("maxAutoResumes exhaustion downgrades resume to stop-and-report", () => {
    const state = createJobState({ jobId: JOB_ID, jobPath: JOB_REL_PATH, jobHash: "h", docs: [{ doc: "docs/a.md" }] });
    state.counters.autoResumes = 2;
    expect(resolveFreezeAction({ meta: blockedMeta("loop_overflow"), job: job(), state, reason: "loop_overflow" })).toEqual({
      action: "stop-and-report",
      basis: "max_auto_resumes",
    });
  });

  it("isUnresolvableFreeze shares the same precedence", () => {
    const state = createJobState({ jobId: JOB_ID, jobPath: JOB_REL_PATH, jobHash: "h", docs: [{ doc: "docs/a.md" }] });
    expect(isUnresolvableFreeze({ meta: blockedMeta("verify_budget"), job: job(), state, reason: "verify_budget" })).toBe(true);
    expect(isUnresolvableFreeze({ meta: blockedMeta("loop_overflow"), job: job(), state, reason: "loop_overflow" })).toBe(false);
  });
});

describe("freeze-autopilot — runFreezeAutopilot", () => {
  it("returns null without an active job (human mode untouched)", async () => {
    const { ctx } = makeCtx(blockedMeta("loop_overflow"));
    const result = await runFreezeAutopilot(ctx, blockedMeta("loop_overflow"), config(), "loop_overflow");
    expect(result).toBeNull();
  });

  it("returns null when the sidecar is not running", async () => {
    await installJob({ status: "completed" });
    const meta = blockedMeta("loop_overflow");
    const { ctx } = makeCtx(meta);
    expect(await runFreezeAutopilot(ctx, meta, config(), "loop_overflow")).toBeNull();
  });

  it("resume path: counts totalFreezes + autoResumes and applies the decision", async () => {
    await installJob();
    const meta = blockedMeta("loop_overflow");
    const { ctx, patches } = makeCtx(meta);

    const result = await runFreezeAutopilot(ctx, meta, config(), "loop_overflow");

    expect(result).not.toBeNull();
    expect(patches.length).toBeGreaterThan(0); // executeDecision actually ran
    const persisted = readJobState(ROOT, JOB_ID)!;
    expect(persisted.counters.totalFreezes).toBe(1);
    expect(persisted.counters.autoResumes).toBe(1);
    expect(audits).toContain("pipeline_auto_decision");
  });

  it("abort path applies abort and counts totalFreezes only", async () => {
    await installJob();
    const meta = blockedMeta("aborted_by_job");
    const { ctx } = makeCtx(meta);

    await runFreezeAutopilot(ctx, meta, config(), "aborted_by_job");

    const persisted = readJobState(ROOT, JOB_ID)!;
    expect(persisted.counters.totalFreezes).toBe(1);
    expect(persisted.counters.autoResumes).toBe(0);
  });

  it("stop-and-report: sidecar stopped, audit written, notify sent, NO provider fallback", async () => {
    await installJob();
    const meta = blockedMeta("verify_budget");
    const { ctx, patches, notified } = makeCtx(meta);

    const result = await runFreezeAutopilot(ctx, meta, config(), "verify_budget");

    expect(result?.applied).toBe(true);
    // M7: no DECISION was applied — the provider would have resumed. (The
    // shared finalize legitimately clears session allowlists; it never touches
    // the flow state, so the pipeline stays blocked.)
    expect(patches.every((p) => p.flowState === undefined)).toBe(true);
    const persisted = readJobState(ROOT, JOB_ID)!;
    expect(persisted.status).toBe("failed");
    expect(persisted.stopReason).toBe("freeze_unresolvable");
    expect(persisted.counters.totalFreezes).toBe(1);
    expect(audits).toContain("pipeline_auto_stop");
    expect(notified.length).toBeGreaterThan(0);
  });

  it("an ACTIVE runner whose job file is unreadable stops with job_drift (never null)", async () => {
    // Review round 3 (issue 2): `readActiveJobContext()` re-parses the
    // user-maintained job file, so a deleted/corrupted file used to make the
    // freeze seam return `null` and fall back to the 210 provider chain — a
    // provider could then auto-resume a freeze the job policy should have
    // stopped. The settle seam already treats the same fault as `job_drift`.
    await installJob();
    fs.rmSync(path.join(ROOT, JOB_REL_PATH));
    const meta = blockedMeta("verify_budget");
    const { ctx, patches, notified } = makeCtx(meta);

    const result = await runFreezeAutopilot(ctx, meta, config(), "verify_budget");

    expect(result).not.toBeNull();
    expect(result?.applied).toBe(true);
    expect(patches.every((p) => p.flowState === undefined)).toBe(true);
    const persisted = readJobState(ROOT, JOB_ID)!;
    expect(persisted.status).toBe("stopped");
    expect(persisted.stopReason).toBe("job_drift");
    expect(audits).toContain("pipeline_auto_stop");
    expect(notified.some((m) => m.includes("job_drift"))).toBe(true);
  });

  it("totalFreezes increments once per intervention and autoResumes stops at the cap", async () => {
    await installJob({ counters: { autoResumes: 1 } });
    const meta = blockedMeta("loop_overflow");

    // First intervention: resume (second and last allowed resume).
    const first = makeCtx(meta);
    await runFreezeAutopilot(first.ctx, meta, config(), "loop_overflow");
    // Second intervention: cap reached → stop-and-report.
    const second = makeCtx(meta);
    await runFreezeAutopilot(second.ctx, meta, config(), "loop_overflow");

    const persisted = readJobState(ROOT, JOB_ID)!;
    expect(persisted.counters.totalFreezes).toBe(2);
    expect(persisted.counters.autoResumes).toBe(2);
    expect(persisted.status).toBe("failed");
  });
});

describe("freeze-autopilot — M7: direct requestDecision path", () => {
  it("never consults the 210 provider chain when the job says stop-and-report", async () => {
    await installJob();
    const meta = blockedMeta("verify_budget");
    const { ctx, patches } = makeCtx(meta);
    const cfg = config({
      // A provider rule that WOULD resume this exact reason.
      decisionPolicy: {
        enabled: true,
        byReason: { verify_budget: { decision: "resume" } },
      },
    });

    const result = await requestDecision(ctx, meta, cfg, "verify_budget");

    expect(result).not.toBeNull();
    // The provider chain would have RESUMED (flowState change); it never ran.
    expect(patches.every((p) => p.flowState === undefined)).toBe(true);
    expect(ctx.session.getMeta()?.flowState).toBe("blocked");
    expect(audits).not.toContain("decision_policy_applied");
    expect(readJobState(ROOT, JOB_ID)?.stopReason).toBe("freeze_unresolvable");
  });

  it("an unreadable job file (active runner) never falls back to the provider chain", async () => {
    // Review round 3 (issue 2): the seam is decided by `isAutoJobActive()`, so
    // the provider chain must stay unreachable even when the job record itself
    // cannot be re-read. The fault converges to `job_drift`, not to a resume.
    await installJob();
    fs.rmSync(path.join(ROOT, JOB_REL_PATH));
    const meta = blockedMeta("loop_overflow");
    const { ctx, patches } = makeCtx(meta);
    const cfg = config({
      decisionPolicy: {
        enabled: true,
        byReason: { loop_overflow: { decision: "resume" } },
      },
    });

    const result = await requestDecision(ctx, meta, cfg, "loop_overflow");

    expect(result).not.toBeNull();
    expect(patches.every((p) => p.flowState === undefined)).toBe(true);
    expect(ctx.session.getMeta()?.flowState).toBe("blocked");
    expect(audits).not.toContain("decision_policy_applied");
    expect(readJobState(ROOT, JOB_ID)?.stopReason).toBe("job_drift");
  });
});
