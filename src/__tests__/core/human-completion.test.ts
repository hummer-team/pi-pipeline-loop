/**
 * 221 Phase 2: a HUMAN pipeline that reaches `completed` releases the shared
 * session resources exactly once and hints the next round.
 *
 * Sealed behaviors:
 * - the release runs once (one-shot `terminalCleanupAt` stamp written first);
 * - the TUI message names `/pipeline-start <doc>`;
 * - an auto job (in-process lock or `meta.autoJob`) is NEVER released here;
 * - the terminal state itself does not change (`flowState` untouched).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { finalizeHumanPipelineCompletion } from "../../core/human-completion";
import { __resetAutoJobLockForTests, acquireJobLock } from "../../core/auto-pipeline/config-overlay";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig } from "../helpers";
import type { SessionMeta } from "../../types";

let TMP: string;
let audits: string[];

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-221-human-completion-"));
  __resetAutoJobLockForTests();
  audits = [];
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function completedMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    currentStage: "completed",
    stageStartTime: Date.now(),
    pipelineId: "pipe-221-p2",
    domain: { id: "general", version: "latest", skillPath: "/tmp/domain.md" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    flowState: "running",
    sessionAllowedCommands: ["git status"],
    sessionAllowedWritePaths: ["docs/**"],
    verifyAttempts: 2,
    verifyFailures: [{ rule: "x", detail: "y" } as never],
    ...overrides,
  } as SessionMeta;
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
          current = { ...current, ...patch } as SessionMeta;
          return current;
        },
      },
      ui: {
        notify: (msg: string) => {
          notified.push(msg);
        },
      },
    },
    patches,
    notified,
    meta: () => current,
  };
}

describe("finalizeHumanPipelineCompletion", () => {
  it("releases the session resources once and hints the next round", async () => {
    const harness = makeCtx(completedMeta());
    const config = makeTestConfig({ projectRoot: TMP });

    expect(await finalizeHumanPipelineCompletion(harness.ctx as never, config)).toBe(true);

    const meta = harness.meta();
    expect(meta.terminalCleanupAt).toBeGreaterThan(0);
    // The SHARED release really ran: allowlists / counters / approvals cleared.
    expect(meta.sessionAllowedCommands).toEqual([]);
    expect(meta.sessionAllowedWritePaths).toEqual([]);
    expect(meta.verifyAttempts).toBe(0);
    expect(meta.verifyFailures).toEqual([]);
    expect(meta.pendingOwnerApprovals).toBeUndefined();
    // Terminal attribution is untouched.
    expect(meta.flowState).toBe("running");
    expect(meta.terminateReason).toBeUndefined();
    // TUI hint + audit.
    expect(harness.notified).toHaveLength(1);
    expect(harness.notified[0]).toContain("/pipeline-start <doc>");
    expect(audits.some((line) => line.startsWith("pipeline_human_cleanup"))).toBe(true);
  });

  it("is idempotent: a second call neither releases nor notifies again", async () => {
    const harness = makeCtx(completedMeta());
    const config = makeTestConfig({ projectRoot: TMP });

    expect(await finalizeHumanPipelineCompletion(harness.ctx as never, config)).toBe(true);
    expect(await finalizeHumanPipelineCompletion(harness.ctx as never, config)).toBe(false);
    expect(harness.notified).toHaveLength(1);
  });

  it("skips a session that carries an auto job context (INV-2)", async () => {
    const harness = makeCtx(
      completedMeta({
        autoJob: {
          jobId: "alpha",
          jobPath: "docs/jobs/alpha.yaml",
          docIndex: 0,
          totalDocs: 2,
          designReviewMaxRounds: 3,
          designReviewRounds: 0,
        },
      }),
    );
    const config = makeTestConfig({ projectRoot: TMP });

    expect(await finalizeHumanPipelineCompletion(harness.ctx as never, config)).toBe(false);
    expect(harness.meta().terminalCleanupAt).toBeUndefined();
    expect(harness.meta().sessionAllowedCommands).toEqual(["git status"]);
    expect(harness.notified).toHaveLength(0);
  });

  it("skips while an auto job owns this process (lock active)", async () => {
    acquireJobLock({ projectRoot: TMP, jobId: "alpha" });
    const harness = makeCtx(completedMeta());
    const config = makeTestConfig({ projectRoot: TMP });

    expect(await finalizeHumanPipelineCompletion(harness.ctx as never, config)).toBe(false);
    expect(harness.meta().terminalCleanupAt).toBeUndefined();
  });

  it("does nothing outside the completed stage", async () => {
    const harness = makeCtx(completedMeta({ currentStage: "develop" }));
    const config = makeTestConfig({ projectRoot: TMP });

    expect(await finalizeHumanPipelineCompletion(harness.ctx as never, config)).toBe(false);
    expect(harness.meta().terminalCleanupAt).toBeUndefined();
    expect(harness.notified).toHaveLength(0);
  });
});
