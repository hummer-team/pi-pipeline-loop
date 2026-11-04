/**
 * 223 Phase 4: the HUMAN track stays byte-identical once the auto track gets
 * its own wake marker and clarify advances.
 *
 * What is sealed here (regression matrix T2 / T3, see 223_Bug.md §4):
 * - the SAME session meta and the SAME document, settled twice:
 *   - human text (no `[plugin auto-settle] ` marker, no `meta.autoJob`):
 *     `agent_settled_non_pipeline_turn` is audited, the stage never moves and
 *     no `clarify_*` dispatch is recorded;
 *   - auto text (marker + `meta.autoJob` + an ACTIVE job): the clarify seam is
 *     reached (`clarify_dispatch…` audited) and the non-pipeline audit is
 *     ABSENT.
 * - the wake wording itself: the human summary is byte-for-byte the pre-223
 *   literal while the auto summary is the same text behind the trusted prefix,
 *   so the two tracks differ by exactly that prefix.
 *
 * The wake text is captured through the production owner-wake observer (the
 * builder is module-private) and then replayed as the owner's last user message,
 * which is exactly how the settle gate consumes it.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import { createAgentSettled } from "../../core/agent-settled";
import {
  registerOwnerWakeObserver,
  setOwnerWakeDeps,
  type OwnerWakeDeps,
} from "../../core/owner-wake";
import { registerTerminal, __resetLifecycleRegistry } from "../../utils/subagent-lifecycle-registry";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import { createAutoHarness, HARNESS_DOCS, type AutoHarness } from "../auto-pipeline/auto-harness";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOC = HARNESS_DOCS[0]!;
const MANDATORY = ["## 目标", "Ship the invariance check.", "## 范围", "The clarify settle only.", "## 验收标准", "Two tracks stay separate."];
/** No clarification round: the auto seam would dispatch round 1. */
const FRESH_DOC = ["# 223_Bug", ...MANDATORY].join("\n");

const AUTO_WAKE_PREFIX = "[plugin auto-settle] ";

/** The pre-223 human wake literal (frozen wording, stage/id interpolated). */
const HUMAN_WAKE =
  `Subagent "agent-223" (stage: clarify) has reached terminal state. ` +
  `The current stage has not been closed yet. Pipeline: pipe-223-invariance ` +
  `Please review and take appropriate action.`;

let harness: AutoHarness;
let errorSpy: ReturnType<typeof spyOn>;

function deployClarifySpec(): void {
  const target = path.join(harness.projectRoot, ".pi", "references", "clarify_spec", "verify.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"), target);
}

function writeDoc(text: string): void {
  const abs = path.join(harness.projectRoot, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/**
 * The harness strips `verify` from every stage (transaction tests do not need
 * it), but the clarify seam sits BEHIND `verify.require`, so both tracks are
 * settled with the production clarify contract enabled. One visit is enough.
 */
function pipelineConfig(): PipelineConfig {
  return {
    ...harness.config,
    maxLoops: 1,
    stages: {
      ...harness.config.stages,
      clarify: { ...harness.config.stages.clarify!, verify: { require: true } },
    },
  } as PipelineConfig;
}

/** Absolute audit file the run writes to (created by `initAuditLog`). */
function auditPath(): string {
  return auditLogFileFor(path.join(harness.projectRoot, harness.config.auditDir!));
}

/** Byte offset of the last settle, so an assertion only sees its own trace. */
let logOffset = 0;

/** Full audit log on disk (empty when the file is absent yet). */
async function rawAuditLog(): Promise<string> {
  try {
    return await readFile(auditPath(), "utf-8");
  } catch {
    return "";
  }
}

/** Read the audit log from the last settle boundary onwards. */
async function readAudits(): Promise<string> {
  return (await rawAuditLog()).slice(logOffset);
}

/** Audit lines without their `YYYY-MM-DD HH:MM:SS - ` stamp (stable compare). */
function stripStamps(log: string): string {
  return log
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - /, ""))
    .join("\n");
}

/** Capture the summary the production observer delivers for one terminal event. */
function captureWake(meta: SessionMeta): string[] {
  const captured: string[] = [];
  const deps: OwnerWakeDeps = {
    getMeta: () => meta,
    updateMeta: () => {},
    sendFollowUp: (summary) => { captured.push(summary); },
    deliver: (summary) => {
      captured.push(summary);
      return { delivered: true, via: "registry_run_binding" as const };
    },
    audit: () => {},
    syncStatusBar: () => {},
  };
  setOwnerWakeDeps(deps);
  const cleanup = registerOwnerWakeObserver();
  registerTerminal(
    "feat-design-plan-agent",
    "agent-223",
    "terminal",
    "completed",
    "clarify" as PipelineStage,
    meta.pipelineId,
  );
  cleanup();
  setOwnerWakeDeps(null);
  return captured;
}

/** Settle once with `wakeText` as the owner's last user message. */
async function settleWith(
  config: PipelineConfig,
  wakeText: string,
  overrides: Partial<SessionMeta>,
): Promise<SessionMeta> {
  await initAuditLog(config);
  // Only this settle's own rows are asserted (earlier settles excluded).
  logOffset = (await rawAuditLog()).length;
  const meta = makeTestMeta({
    currentStage: "clarify",
    flowState: "running",
    requirementDoc: DOC,
    pipelineId: "pipe-223-invariance",
    ...overrides,
  });
  const ctx = createMockCtx(meta);
  (ctx._ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [
    { type: "message", message: { role: "user", content: wakeText } },
  ];
  await createAgentSettled(config).handler(ctx as never);
  return ctx.session.getMeta() as SessionMeta;
}

/** The audit trace of the LAST settle (real JSONL, production formatting). */
async function lastAudits(): Promise<string> {
  return readAudits();
}

beforeEach(() => {
  __resetLifecycleRegistry();
  __resetAutoJobLockForTests();
  harness = createAutoHarness();
  deployClarifySpec();
  writeDoc(FRESH_DOC);
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  __resetLifecycleRegistry();
  __resetAutoJobLockForTests();
  harness.dispose();
});

describe("T2 — the human track is unchanged", () => {
  it("human wake text without an auto job: non-pipeline audit, no dispatch, stage frozen", async () => {
    // No `harness.install()`: no job holds the lock, so the auto seam is inert
    // even though the requirement doc is bound.
    const after = await settleWith(
      pipelineConfig(),
      HUMAN_WAKE,
      {},
    );

    const log = await lastAudits();
    expect(log).toContain("agent_settled_non_pipeline_turn");
    expect(log).not.toContain("clarify_dispatch");
    expect(after.currentStage).toBe("clarify");
    expect(after.activeSpawns ?? {}).toEqual({});
  });

  it("human wake text from a session carrying a stale autoJob block: still the human trace", async () => {
    // A human session in another terminal may still carry the meta block; with
    // no ACTIVE job the seam must not fire (220 INV-1).
    const baseline = await settleWith(pipelineConfig(), HUMAN_WAKE, {});
    const baselineStage = baseline.currentStage;
    const baselineLog = await lastAudits();

    const withBlock = await settleWith(
      pipelineConfig(),
      HUMAN_WAKE,
      {
        autoJob: {
          jobId: "alpha_loop",
          jobPath: "docs/jobs/alpha_loop.yaml",
          docIndex: 0,
          totalDocs: 1,
        },
      },
    );
    const withBlockLog = await lastAudits();

    expect(withBlock.currentStage).toBe(baselineStage);
    expect(stripStamps(withBlockLog)).toBe(stripStamps(baselineLog));
    expect(withBlockLog).toContain("agent_settled_non_pipeline_turn");
    expect(withBlockLog).not.toContain("clarify_dispatch");
  });
});

describe("T3 — the auto track reaches the clarify seam and never files a chat audit", () => {
  it("auto wake text with an active job: clarify_dispatch audited, no non-pipeline audit", async () => {
    await harness.install();

    await settleWith(
      pipelineConfig(),
      `${AUTO_WAKE_PREFIX}${HUMAN_WAKE}`,
      {
        autoJob: {
          jobId: "alpha_loop",
          jobPath: "docs/jobs/alpha_loop.yaml",
          docIndex: 0,
          totalDocs: 1,
        },
      },
    );

    // The seam is reached: a dispatch was attempted (`clarify_dispatch` on
    // success, `clarify_dispatch_failed` when the host cannot spawn here).
    const log = await lastAudits();
    expect(log).toContain("clarify_dispatch");
    expect(log).not.toContain("agent_settled_non_pipeline_turn");
  });

  it("the same auto text WITHOUT the marker is treated as ordinary chat (marker is the whole gate)", async () => {
    await harness.install();

    await settleWith(
      pipelineConfig(),
      HUMAN_WAKE,
      {
        autoJob: {
          jobId: "alpha_loop",
          jobPath: "docs/jobs/alpha_loop.yaml",
          docIndex: 0,
          totalDocs: 1,
        },
      },
    );

    // Proves the Phase 0 fix is load-bearing: the pre-223 wording alone did NOT
    // make the turn a pipeline turn, which is what stalled the auto pipeline.
    const log = await lastAudits();
    expect(log).toContain("agent_settled_non_pipeline_turn");
    expect(log).not.toContain("clarify_dispatch");
  });
});

describe("wake wording — the two tracks differ by exactly the trusted prefix", () => {
  function metaWith(autoJob: boolean): SessionMeta {
    return {
      pipelineId: "pipe-223-invariance",
      currentStage: "clarify",
      stageStartTime: Date.now(),
      summaries: {},
      loopCount: 0,
      currentStepIndex: 0,
      maxLoops: 3,
      activeSpawns: { clarify: { agentId: "agent-223", agentName: "feat-design-plan-agent", startedAt: Date.now() } },
      ...(autoJob
        ? { autoJob: { jobId: "alpha_loop", jobPath: "docs/jobs/alpha_loop.yaml", docIndex: 0, totalDocs: 1 } }
        : {}),
      domain: {} as never,
    } as SessionMeta;
  }

  it("human summary is the frozen literal", () => {
    const captured = captureWake(metaWith(false));
    expect(captured).toEqual([HUMAN_WAKE]);
  });

  it("auto summary is the same literal behind the marker", () => {
    const captured = captureWake(metaWith(true));
    expect(captured).toEqual([`${AUTO_WAKE_PREFIX}${HUMAN_WAKE}`]);
    // Byte-level relationship: the human text is a SUFFIX of the auto text.
    expect(captured[0]!.endsWith(HUMAN_WAKE)).toBe(true);
  });
});