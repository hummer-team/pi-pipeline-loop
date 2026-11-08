/**
 * 227 Phase 4 (D-3): a silent settle in an unattended job becomes a BOUNDED,
 * auditable re-prompt instead of an unbounded stall.
 *
 * Pins:
 * - the pure trigger matrix (auto job, same visit, work stage, no gate /
 *   spawn / pending marker);
 * - the per-visit budget (3 deliveries, the 4th settle hard-stops);
 * - a new stage visit resets the budget;
 * - the child never reprompts; a missing `pi.sendUserMessage` fails open.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldReprompt,
  maybeAutoAskReprompt,
} from "../../core/auto-pipeline/ask-reprompt";
import { createJobState, writeJobState } from "../../core/auto-pipeline/job-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestMeta, createMockCtx } from "../helpers";
import type { SessionMeta } from "../../types";

const STAGE_START = 1_700_000_000_000;
const VISITS = ["clarify", "plan", "develop"] as const;

const JOB_ID = "ask_loop";
const roots: string[] = [];

/**
 * A project whose SIDECAR names a RUNNING document for {@link JOB_ID}.
 * `maybeAutoAskReprompt` judges liveness from this sidecar on every settle
 * (227 review fix, issue 2), so delivery tests must model a live job.
 */
async function makeRunningJobRoot(opts?: { docStatus?: "running" | "completed" }): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "pi-227-ask-reprompt-"));
  roots.push(root);
  const state = createJobState({
    jobId: JOB_ID,
    jobPath: "docs/jobs/ask_loop.yaml",
    jobHash: "hash",
    docs: [{ doc: "docs/design/227_Bug.md" }],
  });
  state.status = "running";
  state.docs[0]!.status = opts?.docStatus ?? "running";
  await writeJobState(root, state);
  mkdirSync(join(root, ".pi", "auto_pipeline"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "auto_pipeline", "lock.json"),
    JSON.stringify({ token: "tok", jobId: JOB_ID, pid: process.pid, startedAt: Date.now() }),
    "utf-8",
  );
  return root;
}


function autoMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    currentStage: "develop",
    stageStartTime: STAGE_START,
    stageVisitOrder: [...VISITS],
    autoJob: { jobId: "ask_loop", jobPath: "docs/jobs/ask_loop.yaml", docIndex: 0, totalDocs: 1 },
    ...overrides,
  });
}

const BEFORE = { stage: "develop" as const, stageStartTime: STAGE_START, visitCount: VISITS.length };

let audits: Array<{ event: string; message?: Record<string, string | boolean> }> = [];

beforeEach(() => {
  audits = [];
  __setSafeWriteAuditLogOverride(async (event, message) => {
    audits.push({ event, message: message as Record<string, string | boolean> | undefined });
  });
  return () => __setSafeWriteAuditLogOverride(null);
});

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("227 P4: shouldReprompt trigger matrix", () => {
  it("a silent settle in an auto job delivers the first re-prompt", () => {
    const decision = shouldReprompt({ meta: autoMeta(), before: BEFORE, now: Date.now() });
    expect(decision).toMatchObject({ deliver: true, reason: "silent_settle", count: 1 });
  });

  it("human track is inert", () => {
    const decision = shouldReprompt({ meta: autoMeta({ autoJob: undefined }), before: BEFORE, now: Date.now() });
    expect(decision).toMatchObject({ deliver: false, reason: "not_auto_job" });
  });

  it("an advanced visit is not a silent settle", () => {
    const advanced = autoMeta({ stageStartTime: STAGE_START + 1 });
    expect(shouldReprompt({ meta: advanced, before: BEFORE, now: Date.now() }).deliver).toBe(false);
    const revisited = autoMeta({ stageVisitOrder: [...VISITS, "develop"] });
    expect(shouldReprompt({ meta: revisited, before: BEFORE, now: Date.now() }).deliver).toBe(false);
  });

  it("clarify / awaiting_human / completed are excluded", () => {
    for (const stage of ["clarify", "awaiting_human", "completed"] as const) {
      const meta = autoMeta({ currentStage: stage });
      const decision = shouldReprompt({
        meta,
        before: { stage, stageStartTime: STAGE_START, visitCount: VISITS.length },
        now: Date.now(),
      });
      expect(decision.deliver).toBe(false);
      if (!decision.deliver) expect(decision.reason).toBe("non_work_stage");
    }
  });

  it("frozen / aborted pipelines are excluded", () => {
    for (const flowState of ["blocked", "aborted"] as const) {
      expect(shouldReprompt({ meta: autoMeta({ flowState }), before: BEFORE, now: Date.now() }).deliver).toBe(false);
    }
  });

  it("pending spawns / confirm gate / design-review entry are excluded", () => {
    expect(
      shouldReprompt({
        meta: autoMeta({
          pendingSpawns: { review: { pipelineId: "p", agentName: "a", requestedAt: 1, attempts: 0 } },
        }),
        before: BEFORE,
        now: Date.now(),
      }).deliver,
    ).toBe(false);
    expect(
      shouldReprompt({
        meta: autoMeta({ confirmGateDeferredAt: { stage: "develop", at: 1 } }),
        before: BEFORE,
        now: Date.now(),
      }).deliver,
    ).toBe(false);
    expect(
      shouldReprompt({
        meta: autoMeta({ designReviewEntryPending: { at: 1 } }),
        before: BEFORE,
        now: Date.now(),
      }).deliver,
    ).toBe(false);
  });
});

describe("227 P4: per-visit budget", () => {
  it("delivers 1..3 and hard-stops on the 4th silent settle", () => {
    const fingerprint = `${STAGE_START}:${VISITS.length}`;
    for (const count of [1, 2, 3]) {
      const meta = autoMeta({ autoAskReprompt: { stage: "develop", fingerprint, count: count - 1 } });
      const decision = shouldReprompt({ meta, before: BEFORE, now: Date.now() });
      expect(decision.deliver).toBe(true);
      if (decision.deliver) expect(decision.count).toBe(count);
    }
    const meta = autoMeta({ autoAskReprompt: { stage: "develop", fingerprint, count: 3 } });
    const decision = shouldReprompt({ meta, before: BEFORE, now: Date.now() });
    expect(decision.deliver).toBe(false);
    if (!decision.deliver) {
      expect(decision.exhausted).toBe(true);
      expect(decision.count).toBe(4);
    }
  });

  it("a new visit (new fingerprint) resets the budget", () => {
    const meta = autoMeta({
      stageStartTime: STAGE_START + 5,
      autoAskReprompt: { stage: "develop", fingerprint: `${STAGE_START}:${VISITS.length}`, count: 3 },
    });
    const decision = shouldReprompt({
      meta,
      before: { stage: "develop", stageStartTime: STAGE_START + 5, visitCount: VISITS.length },
      now: Date.now(),
    });
    expect(decision.deliver).toBe(true);
    if (decision.deliver) expect(decision.count).toBe(1);
  });
});

describe("227 P4: maybeAutoAskReprompt wiring", () => {
  it("delivers one follow-up with the contract copy and records the budget", async () => {
    const meta = autoMeta();
    const sent: Array<{ msg: string; opts?: Record<string, unknown> }> = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string, opts?: Record<string, unknown>) => sent.push({ msg, opts }) },
    });
    // 227 review fix (issue 2): liveness is judged from the sidecar, so the
    // delivery path requires a RUNNING job/document.
    const projectRoot = await makeRunningJobRoot();

    await maybeAutoAskReprompt({
      ctx: ctx as never,
      config: { stages: { develop: { nextStage: "review" } }, projectRoot } as never,
      before: BEFORE,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.opts).toEqual({ deliverAs: "followUp" });
    expect(sent[0]!.msg).toContain("stage_advance");
    expect(sent[0]!.msg).toContain("stop-and-report");
    expect(meta.autoAskReprompt).toMatchObject({ stage: "develop", count: 1 });
    expect(audits.some((a) => a.event === "auto_ask_reprompt")).toBe(true);
  });

  it("the child never reprompts", async () => {
    const meta = autoMeta();
    const sent: string[] = [];
    const ctx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/sessions/owner.jsonl" },
      pi: { sendUserMessage: (msg: string) => sent.push(msg) },
    });

    await maybeAutoAskReprompt({ ctx: ctx as never, config: { stages: {} } as never, before: BEFORE });

    expect(sent).toHaveLength(0);
    expect(meta.autoAskReprompt).toBeUndefined();
  });

  it("a missing sendUserMessage fails open with an error audit", async () => {
    const meta = autoMeta();
    const ctx = createMockCtx(meta);
    const projectRoot = await makeRunningJobRoot();

    await maybeAutoAskReprompt({
      ctx: ctx as never,
      config: { stages: {}, projectRoot } as never,
      before: BEFORE,
    });

    expect(meta.autoAskReprompt).toBeUndefined();
    expect(audits.some((a) => a.event === "auto_ask_reprompt_error")).toBe(true);
  });

  it("the exhausted budget hard-stops through the shared seam", async () => {
    const meta = autoMeta({
      autoAskReprompt: { stage: "develop", fingerprint: `${STAGE_START}:${VISITS.length}`, count: 3 },
    });
    const ctx = createMockCtx(meta);
    const projectRoot = await makeRunningJobRoot();

    await maybeAutoAskReprompt({
      ctx: ctx as never,
      config: { stages: {}, projectRoot } as never,
      before: BEFORE,
    });

    expect(audits.some((a) => a.event === "auto_ask_reprompt_exhausted")).toBe(true);
    expect(audits.some((a) => a.event === "auto_ask_reprompt")).toBe(false);
  });

  it("227 review fix 4: an exhausted budget never hard-stops a turn with a live executor", async () => {
    // The 3 deliveries are spent, then the owner dispatches an executor without
    // advancing the stage. That settle is NOT silent — it must not be counted as
    // the 4th ASK, and it must not kill the running job.
    const projectRoot = await makeRunningJobRoot();
    mkdirSync(join(projectRoot, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".pi", "agents", "develop.md"),
      "---\nname: develop-agent\n---\nbody\n",
      "utf-8",
    );
    const meta = autoMeta({
      autoAskReprompt: { stage: "develop", fingerprint: `${STAGE_START}:${VISITS.length}`, count: 3 },
      activeSpawns: {
        develop: { agentName: "develop-agent", reserved: true, startedAt: Date.now() },
      },
    });
    const ctx = createMockCtx(meta);

    await maybeAutoAskReprompt({
      ctx: ctx as never,
      config: {
        stages: { develop: { nextStage: "review", agentPath: ".pi/agents/develop.md" } },
        projectRoot,
      } as never,
      before: BEFORE,
    });

    expect(audits.some((a) => a.event === "auto_ask_reprompt_exhausted")).toBe(false);
    expect(audits.some((a) => a.event === "auto_ask_reprompt")).toBe(false);
    expect(meta.autoAskReprompt).toMatchObject({ count: 3 });
  });

  it("227 review fix 1/2: a settle for an already-finalized job never re-prompts", async () => {
    // The job legitimately ended before this settle (crash recovery, another
    // terminal, a hard stop in an earlier turn): the sidecar is no longer
    // `running` while `meta.autoJob` still exists until the next period.
    const meta = autoMeta();
    const sent: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => sent.push(msg) },
    });
    const projectRoot = await makeRunningJobRoot();
    const state = createJobState({
      jobId: JOB_ID,
      jobPath: "docs/jobs/ask_loop.yaml",
      jobHash: "hash",
      docs: [{ doc: "docs/design/227_Bug.md" }],
    });
    state.status = "failed";
    state.docs[0]!.status = "failed";
    await writeJobState(projectRoot, state);

    await maybeAutoAskReprompt({
      ctx: ctx as never,
      config: { stages: {}, projectRoot } as never,
      before: BEFORE,
    });

    expect(sent).toHaveLength(0);
    expect(meta.autoAskReprompt).toBeUndefined();
    expect(audits.some((a) => a.event === "auto_ask_reprompt_skipped")).toBe(true);
  });

  it("227 review fix 1/2: a job whose document is no longer running never re-prompts", async () => {
    const meta = autoMeta();
    const sent: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => sent.push(msg) },
    });
    const projectRoot = await makeRunningJobRoot({ docStatus: "completed" });

    await maybeAutoAskReprompt({
      ctx: ctx as never,
      config: { stages: {}, projectRoot } as never,
      before: BEFORE,
    });

    expect(sent).toHaveLength(0);
    expect(audits.some((a) => a.event === "auto_ask_reprompt_skipped")).toBe(true);
  });
});
