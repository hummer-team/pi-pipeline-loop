/**
 * 219 Phase 3 §8 (M3): the audit switch whitelist.
 *
 * Key behaviors:
 * - `audit.autoDecisions` gates EXACTLY ONE event: `pipeline_auto_decision`.
 * - Lifecycle / safety events are written directly (`safeWriteAuditLog`) and
 *   therefore survive `autoDecisions: false` — verified end-to-end through the
 *   freeze autopilot's stop path.
 * - The default is `true` (a config that never went through the loader keeps
 *   recording, matching `makeTestConfig` fixtures).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { auditAutoDecision, shouldRecordAutoDecision } from "../../core/auto-pipeline/auto-audit";
import { runFreezeAutopilot } from "../../core/auto-pipeline/freeze-autopilot";
import {
  acquireJobLock,
  __resetAutoJobLockForTests,
} from "../../core/auto-pipeline/config-overlay";
import { createJobState, writeJobState } from "../../core/auto-pipeline/job-state";
import { hashJobBytes } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const JOB_ID = "alpha";
const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/200_Feat.md",
  "freezePolicy:",
  "  onFreeze: stop-and-report",
].join("\n");

let ROOT: string;
let events: string[];
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(tmpdir(), "pi-219-audit-"));
  __resetAutoJobLockForTests();
  events = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage) => {
    events.push(stage);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("audit-whitelist — shouldRecordAutoDecision", () => {
  it("defaults to true when the block is absent", () => {
    expect(shouldRecordAutoDecision(makeTestConfig())).toBe(true);
  });

  it("explicit true records; explicit false suppresses", () => {
    expect(shouldRecordAutoDecision(makeTestConfig({ audit: { autoDecisions: true } }))).toBe(true);
    expect(shouldRecordAutoDecision(makeTestConfig({ audit: { autoDecisions: false } }))).toBe(false);
  });
});

describe("audit-whitelist — auditAutoDecision", () => {
  it("writes exactly one pipeline_auto_decision row with the auto source", async () => {
    await auditAutoDecision(makeTestConfig(), { gate: "protected_path", decision: "block" });
    expect(events).toEqual(["pipeline_auto_decision"]);
  });

  it("writes nothing when autoDecisions is false", async () => {
    await auditAutoDecision(makeTestConfig({ audit: { autoDecisions: false } }), {
      gate: "protected_path",
      decision: "block",
    });
    expect(events).toEqual([]);
  });

  it("never throws (fail-open on audit failure)", async () => {
    __setSafeWriteAuditLogOverride(async () => {
      throw new Error("audit sink down");
    });
    await expect(
      auditAutoDecision(makeTestConfig(), { gate: "set_budget", decision: "block" }),
    ).resolves.toBeUndefined();
  });
});

describe("audit-whitelist — events that are ALWAYS written", () => {
  it("autoDecisions:false suppresses pipeline_auto_decision only (pipeline_auto_stop survives)", async () => {
    // Install a running job whose only freeze action is stop-and-report.
    const jobPath = path.join(ROOT, "docs", "jobs", "alpha.yaml");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JOB_YAML, "utf8");
    const base = createJobState({
      jobId: JOB_ID,
      jobPath: "docs/jobs/alpha.yaml",
      jobHash: hashJobBytes(JOB_YAML),
      docs: [{ doc: "docs/design/200_Feat.md" }],
    });
    await writeJobState(ROOT, { ...base, status: "running" });
    const lock = acquireJobLock({ projectRoot: ROOT, jobId: JOB_ID });
    if (!lock.ok) throw new Error("lock acquire failed");

    const meta = makeTestMeta({ currentStage: "develop", flowState: "blocked", blockedReason: "verify_budget" });
    const ctx = {
      session: { getMeta: () => meta, updateMeta: () => meta },
      ui: { notify: () => undefined },
    };
    const config = makeTestConfig({ projectRoot: ROOT, audit: { autoDecisions: false } });

    await runFreezeAutopilot(ctx, meta, config, "verify_budget");

    expect(events).not.toContain("pipeline_auto_decision");
    expect(events).toContain("pipeline_auto_stop");
  });
});
