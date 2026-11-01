/**
 * 219 Phase 5 §3.1 (Seam A) — the SOFT loop-brake stop.
 *
 * Review round 2 (issue 1, Medium): `finalizeOnSoftStop` used to call ONLY
 * `finalizeCurrentDoc`, so a `budget_exhausted` soft stop wrote a `:failed`
 * receipt and then the SAME doc could still land a second `:completed` receipt
 * (the brake refuses to advance, not to finish), while the sidecar stayed
 * `running`, the process lock stayed held and no `pipeline_auto_stop` / summary
 * was ever written. `stopConditions.maxTotalLoops` was therefore inert.
 *
 * Key behaviors asserted here:
 * - the soft stop goes through the ONE failure-scheduling transaction
 *   (`handleDocFailure`): receipt + audit + `onFailure` decision;
 * - `onFailure: stop` ends the job with `budget_exhausted` and releases the lock;
 * - `onFailure: continue` starts the next doc in the same session (job running);
 * - a doc that already has a `:failed` receipt can never flip to `:completed`.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTestMeta } from "../helpers";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, HARNESS_JOB_ID } from "./auto-harness";
import { finalizeOnSoftStop } from "../../core/auto-pipeline/stop-policy";
import { finalizeCurrentDoc, __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { isAutoJobActive, readJobLock, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { writeJobState } from "../../core/auto-pipeline/job-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

let harness: ReturnType<typeof createAutoHarness>;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

const SOFT_VERDICT = { kind: "soft", stopReason: "budget_exhausted" } as const;

/** Rewrite the harness job file (the soft stop re-reads it via the lock). */
function writeJobYaml(lines: string[]): void {
  fs.writeFileSync(path.join(harness.root, "docs", "jobs", `${HARNESS_JOB_ID}.yaml`), lines.join("\n"), "utf8");
}

beforeEach(() => {
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  audits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage) => {
    audits.push(stage);
  });
  harness = createAutoHarness();
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  harness.dispose();
});

describe("soft stop — onFailure: stop (default)", () => {
  it("receipts the doc, stops the job with budget_exhausted and releases the lock", async () => {
    await harness.install();
    const stub = createSessionStub(makeTestMeta({ currentStage: "fix", pipelineId: "pipe-soft" }));

    await finalizeOnSoftStop(stub, harness.config, SOFT_VERDICT);

    const state = harness.state()!;
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[0]?.finalizeKey).toBe(`${HARNESS_JOB_ID}:0:failed`);
    expect(state.docs[0]?.failReason).toBe("budget_exhausted");
    // The job itself is terminal — not left `running` with a held lock.
    expect(state.status).toBe("failed");
    expect(state.stopReason).toBe("budget_exhausted");
    expect(isAutoJobActive()).toBe(false);
    expect(readJobLock(harness.root)).toBeNull();
    expect(audits).toContain("pipeline_auto_cleanup");
    expect(audits).toContain("pipeline_auto_stop");
    expect(stub.notified.some((m) => m.includes("failed"))).toBe(true);
  });

  it("a doc with a :failed receipt can never flip to :completed", async () => {
    const installed = await harness.install();
    installed.docs[0]!.status = "failed";
    installed.docs[0]!.finalizeKey = `${HARNESS_JOB_ID}:0:failed`;
    installed.docs[0]!.failReason = "budget_exhausted";
    await writeJobState(harness.root, installed);
    const stub = createSessionStub(makeTestMeta({ currentStage: "develop" }));

    const second = await finalizeCurrentDoc(stub, harness.config, { outcome: "completed" });

    expect(second.skipped).toBe(true);
    const state = harness.state()!;
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.docs[0]?.finalizeKey).toBe(`${HARNESS_JOB_ID}:0:failed`);
  });
});

describe("soft stop — onFailure: continue", () => {
  it("starts the next doc in the same session and keeps the job running", async () => {
    writeJobYaml([
      "version: 1",
      "enabled: true",
      // 220 C-2: the harness config has no verify blocks ⇒ `rule` tier.
      "tier: rule",
      "docs:",
      "  list:",
      `    - doc: ${HARNESS_DOCS[0]}`,
      `    - doc: ${HARNESS_DOCS[1]}`,
      "  onFailure: continue",
      "chain:",
      "  newSession: false",
      "stopConditions:",
      "  maxTotalLoops: 5",
    ]);
    await harness.install();
    harness.writeDoc(HARNESS_DOCS[1]!);
    const stub = createSessionStub(makeTestMeta({ currentStage: "fix", pipelineId: "pipe-soft" }));

    await finalizeOnSoftStop(stub, harness.config, SOFT_VERDICT);

    const state = harness.state()!;
    expect(state.docs[0]?.status).toBe("failed");
    expect(state.status).toBe("running");
    expect(state.stopReason).toBeUndefined();
    expect(state.docIndex).toBe(1);
    expect(state.docs[1]?.status).toBe("running");
    // The overlay + lock survive: the job continues with the next document.
    expect(isAutoJobActive()).toBe(true);
    expect(audits).toContain("pipeline_auto_chain");
  });
});
