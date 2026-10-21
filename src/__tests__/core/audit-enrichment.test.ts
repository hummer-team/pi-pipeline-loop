/**
 * 210 Phase 4 integration tests — audit enrichment across the exit channels.
 *
 * Covers plan acceptance "field assertions for the three exit paths (tool
 * advance / hook auto-advance / confirm reject) and the terminal paths":
 * - tool-path `stage_advance` carries duration / counters / evidence extras and
 *   records `meta.stageStats[stage]`;
 * - tool-path `pipeline_completed` carries the full run aggregate;
 * - hook-path (autoAdvanceAfterVerify) `stage_advance` / `pipeline_completed`
 *   share the same vocabulary;
 * - `confirm_rejected` carries `stageEnteredAt` + `durationMs`;
 * - `pipeline_session_aborted` carries the same aggregate;
 * - the single-line `k=v` audit format is preserved (no JSON / multi-line).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStageAdvancer, maybeHandleConfirmGate } from "../../core/stage-advancer";
// 210 review issue 3: applyVerifyPass gains the tool-mode exit evidence chain.
import { applyVerifyPass, autoAdvanceAfterVerify } from "../../core/verify-advance";
import { markPipelineAborted } from "../../core/flow-state";
// 210 review issue 3: touch the usage ledger so `stage_usage` has a snapshot.
import { createUsageRecorder } from "../../core/usage-recorder";
import { createPipelineUI } from "../../core/pipeline-ui";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, auditLogFileFor } from "../helpers";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";

// ─── Harness ──────────────────────────────────────────────────────────────────

let seq = 0;
/** Unique pipelineId per case (watchdog/timer tables are process-global). */
const nextPid = () => `pipe-210-enrich-${Date.now()}-${++seq}`;

/** Shared-store style ctx: updateMeta mutates the SAME meta object. */
function makeCtx(meta: SessionMeta, config: PipelineConfig, selectReturn?: string) {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      transition: () => {},
      select: async () => selectReturn,
    },
    pi: { sendUserMessage: () => {} },
    config,
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
  };
}

/** Fresh tmp projectRoot + initialized audit subsystem for one case. */
async function setupRoot(label: string): Promise<string> {
  const root = join(tmpdir(), `pi-210-audit-${label}-${Date.now()}-${seq}`);
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: root }));
  return root;
}

async function readAudit(root: string, pipelineId: string): Promise<string> {
  return readFile(auditLogFileFor(join(root, ".pi", "audit"), pipelineId), "utf-8");
}

/**
 * Parses the LAST exact-event audit line into its `k=v` map.
 * Line shape: `YYYY-MM-DD HH:mm:ss - [INFO] event | k=v | k=v`.
 */
function auditFields(content: string, event: string): Record<string, string> {
  const re = new RegExp(`\\] ${event} \\|`);
  const lines = content.split("\n").filter((l) => re.test(l));
  if (lines.length === 0) throw new Error(`no audit line for event "${event}" in:\n${content}`);
  const out: Record<string, string> = {};
  for (const part of lines[lines.length - 1].split(" | ").slice(1)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** Every audit line must keep the single-line `k=v` contract. */
function assertSingleLineFormat(content: string): void {
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - \[(INFO|WARN|ERROR)\] \S+( \| .*)?$/);
  }
}

const PASS_RESULT = { structuredResult: { failures: [] }, ruleMissing: [], verifyResult: null };

// ─── Exit path 1: tool advance ────────────────────────────────────────────────

describe("210 Phase 4 audit enrichment: tool advance", () => {
  it("stage_advance carries duration, counters and evidence extras; stageStats recorded", async () => {
    const root = await setupRoot("tool-stage");
    const config = makeTestConfig({ projectRoot: root });
    const enteredAt = Date.now() - 1500;
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/Req.md",
      stageStartTime: enteredAt,
      verifyAttempts: 2,
      confirmRejections: 1,
      loopCycleCount: 3,
      summaries: {}, // no summary → evidence flagged unavailable, advance unaffected
    });
    const ctx = makeCtx(meta, config);

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as any)) as { success: boolean };
    expect(result.success).toBe(true);

    const content = await readAudit(root, meta.pipelineId);
    assertSingleLineFormat(content);
    const f = auditFields(content, "stage_advance");

    // Existing keys are UNCHANGED (append-only contract).
    expect(f.fromStage).toBe("develop");
    expect(f.toStage).toBe("review");
    expect(f.override).toBe("no");

    // New Phase 4 keys.
    expect(f.stageEnteredAt).toBe(String(enteredAt));
    expect(Number(f.durationMs)).toBeGreaterThanOrEqual(1500);
    expect(f.verifyAttempts).toBe("2");
    expect(f.confirmRejections).toBe("1");
    expect(f.loopCycleCount).toBe("3");
    expect(f.summaryPath).toBe("");
    expect(f.commitIds).toBe("");
    expect(f.evidenceUnavailable).toBe("true");

    // stageStats[stage] accumulates with the SAME duration the line reports.
    const stageStats = f.stageStats;
    expect(stageStats.startsWith("develop:")).toBe(true);
    const recorded = meta.stageStats?.develop;
    expect(recorded).toBeDefined();
    expect(recorded!.durationMs).toBeGreaterThanOrEqual(1500);
    expect(recorded!.verifyAttempts).toBe(2);
    expect(recorded!.confirmRejections).toBe(1);
    expect(stageStats).toBe(`develop:${recorded!.durationMs}:2:1`);

    await rm(root, { recursive: true, force: true });
  });

  it("pipeline_completed (awaiting_human → completed) carries the full run aggregate", async () => {
    const root = await setupRoot("tool-completed");
    const config = makeTestConfig({ projectRoot: root });

    const summaryPath = join(root, "fix-summary.md");
    await writeFile(summaryPath, "---\ncommit_ids: [abc1234, def5678]\n---\n# Fix\n", "utf-8");

    const enteredAt = Date.now() - 1200;
    const startedAt = Date.now() - 90_000;
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: enteredAt,
      pipelineStartedAt: startedAt,
      verifyAttempts: 1,
      confirmRejections: 2,
      loopCycleCount: 1,
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "awaiting_human"],
      stageStats: { clarify: { durationMs: 10, verifyAttempts: 0, confirmRejections: 0 } },
      // Historical-stage summary: the tool hash-check only guards the CURRENT
      // stage's summary, while the aggregate reads ALL recorded summaries.
      summaries: { fix: { path: summaryPath, hash: "h", status: "valid" } },
    });
    const ctx = makeCtx(meta, config);

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as any)) as { success: boolean };
    expect(result.success).toBe(true);

    const content = await readAudit(root, meta.pipelineId);
    assertSingleLineFormat(content);
    const f = auditFields(content, "pipeline_completed");

    // Existing keys unchanged.
    expect(f.finalStage).toBe("awaiting_human");
    // C0 edge semantics (pre-existing): first entry to a never-visited target
    // resets loopCycleCount — and per plan the terminal audit reads the POST-advance
    // fresh meta, so the reported value is the reset 0. Cumulative loop activity
    // stays visible via stageVisitOrder.
    expect(f.loopCycleCount).toBe("0");
    // Fresh meta already contains the terminal "completed" visit appended by the commit.
    expect(f.stageVisitOrder).toBe("clarify,plan,develop,review,fix,awaiting_human,completed");

    // Aggregate keys (requirement 5.5 table) — the LAST stage's duration is
    // measured from the pre-advance entry clock.
    expect(f.startedAt).toBe(String(startedAt));
    expect(Number(f.durationMs)).toBeGreaterThanOrEqual(1200);
    expect(f.stageStats).toBe("clarify:10:0:0"); // terminal does not record the final stage
    // verifyAttempts is a per-stage counter — the completed commit resets it
    // (168 Phase 0) before the aggregate reads fresh meta; the per-stage totals
    // live in stageStats. confirmRejections is run-scoped and survives.
    expect(f.verifyAttempts).toBe("0");
    expect(f.confirmRejections).toBe("2");
    expect(f.requirementDoc).toBe("docs/design/77_Config.md");
    expect(f.planDoc).toBe("docs/design/77_Config_Plan.md");
    expect(f.summaryPaths).toBe(summaryPath);
    expect(f.commitIds).toBe("abc1234,def5678");
    expect(f.auditPath!.length).toBeGreaterThan(0);
    expect(f.auditPath).toContain(meta.pipelineId);

    await rm(root, { recursive: true, force: true });
  });
});

// ─── Exit path 2: hook auto-advance (verify-advance) ──────────────────────────

describe("210 Phase 4 audit enrichment: hook auto-advance", () => {
  it("stage_advance (auto) carries the same exit vocabulary and records stageStats", async () => {
    const root = await setupRoot("hook-stage");
    const config = makeTestConfig({ projectRoot: root });
    const enteredAt = Date.now() - 1300;
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      stageStartTime: enteredAt,
      verifyAttempts: 1,
      summaries: {},
    });
    const ctx = makeCtx(meta, config);

    await autoAdvanceAfterVerify(
      config, ctx as any, meta, "develop", "review" as PipelineStage, PASS_RESULT, createPipelineUI(config),
    );

    const content = await readAudit(root, meta.pipelineId);
    assertSingleLineFormat(content);
    const f = auditFields(content, "stage_advance");
    expect(f.method).toBe("hook_auto_advance");
    expect(f.stageEnteredAt).toBe(String(enteredAt));
    expect(Number(f.durationMs)).toBeGreaterThanOrEqual(1300);
    expect(f.verifyAttempts).toBe("1");
    expect(f.confirmRejections).toBe("0");
    expect(f.evidenceUnavailable).toBe("true");
    expect(f.commitIds).toBe("");
    expect(f.stageStats.startsWith("develop:")).toBe(true);
    expect(meta.stageStats?.develop?.durationMs).toBeGreaterThanOrEqual(1300);

    await rm(root, { recursive: true, force: true });
  });

  it("pipeline_completed (auto) carries the run aggregate with summaries evidence", async () => {
    const root = await setupRoot("hook-completed");
    const config = makeTestConfig({ projectRoot: root });
    const summaryPath = join(root, "review-summary.md");
    await writeFile(summaryPath, "---\n{\n  \"commit_ids\": [\"9aa11bb\"]\n}\n---\n", "utf-8");

    const enteredAt = Date.now() - 1100;
    const startedAt = Date.now() - 80_000;
    const meta = makeTestMeta({
      currentStage: "review",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: enteredAt,
      pipelineStartedAt: startedAt,
      stageVisitOrder: ["clarify", "plan", "develop", "review"],
      stageStats: { plan: { durationMs: 20, verifyAttempts: 1, confirmRejections: 0 } },
      summaries: { review: { path: summaryPath, hash: "h", status: "valid" } },
    });
    const ctx = makeCtx(meta, config);

    await autoAdvanceAfterVerify(
      config, ctx as any, meta, "review", "completed", PASS_RESULT, createPipelineUI(config),
    );

    const content = await readAudit(root, meta.pipelineId);
    assertSingleLineFormat(content);
    const f = auditFields(content, "pipeline_completed");
    expect(f.finalStage).toBe("review");
    expect(f.startedAt).toBe(String(startedAt));
    expect(Number(f.durationMs)).toBeGreaterThanOrEqual(1100);
    expect(f.stageStats).toBe("plan:20:1:0");
    expect(f.requirementDoc).toBe("docs/design/77_Config.md");
    expect(f.planDoc).toBe("docs/design/77_Config_Plan.md");
    expect(f.summaryPaths).toBe(summaryPath);
    expect(f.commitIds).toBe("9aa11bb");
    // Correct behavior: the terminal commit appends "completed" to the visit order.
    expect(f.stageVisitOrder).toBe("clarify,plan,develop,review,completed");
    expect(f.auditPath).toContain(meta.pipelineId);

    await rm(root, { recursive: true, force: true });
  });
});

// ─── Exit path 3: confirm reject ──────────────────────────────────────────────

describe("210 Phase 4 audit enrichment: confirm reject", () => {
  it("confirm_rejected carries stageEnteredAt + durationMs (entry clock frozen pre-commit)", async () => {
    const root = await setupRoot("reject");
    await mkdir(join(root, "docs", "design"), { recursive: true });
    await writeFile(join(root, "docs", "design", "77_Config_plan.md"), "# Plan\n", "utf-8");
    await initAuditLog(makeTestConfig({ projectRoot: root }));

    const base = makeTestConfig({ projectRoot: root });
    const config: PipelineConfig = {
      ...base,
      stages: {
        ...base.stages,
        plan: {
          ...base.stages.plan,
          allowedWritePaths: ["docs/"],
          confirm: { mode: "manual" as const },
        },
      },
    };
    const enteredAt = Date.now() - 1400;
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: enteredAt,
    });
    const ctx = makeCtx(meta, config, "Reject & Rework (back to clarify)");

    const result = await maybeHandleConfirmGate(
      config, ctx as any, meta, { notify: () => {} } as any, { mode: "manual" },
    );
    expect(result.result).toBe("handled");

    const content = await readAudit(root, meta.pipelineId);
    assertSingleLineFormat(content);
    const f = auditFields(content, "confirm_rejected");
    expect(f.stage).toBe("plan");
    expect(f.confirmRejections).toBe("1");
    // Pre-commit entry clock survives the reject patch rewriting stageStartTime.
    expect(f.stageEnteredAt).toBe(String(enteredAt));
    expect(Number(f.durationMs)).toBeGreaterThanOrEqual(1400);

    await rm(root, { recursive: true, force: true });
  });
});

// ─── Terminal path 3: abort (in-memory capture, no file routing) ─────────────

describe("210 Phase 4 audit enrichment: pipeline_session_aborted", () => {
  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
  });

  it("aborted audit carries the same run aggregate", async () => {
    const events: Array<{ event: string; message?: Record<string, string | boolean> }> = [];
    __setSafeWriteAuditLogOverride(async (event, message) => {
      events.push({ event, message: message as Record<string, string | boolean> });
    });

    const enteredAt = Date.now() - 1000;
    const startedAt = Date.now() - 70_000;
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: enteredAt,
      pipelineStartedAt: startedAt,
      loopCycleCount: 2,
      stageVisitOrder: ["clarify", "plan", "develop"],
      stageStats: { clarify: { durationMs: 5, verifyAttempts: 0, confirmRejections: 0 } },
      summaries: {},
    });
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: { notify: () => {} },
    };

    await markPipelineAborted(ctx as any, "session_quit");

    const rec = events.find((e) => e.event === "pipeline_session_aborted");
    expect(rec).toBeDefined();
    const m = rec!.message!;
    // Existing frozen-transition fields untouched.
    expect(m.stage).toBe("develop");
    expect(m.reason).toBe("session_quit");
    // Aggregate appended (requirement 5.5): the aborted stage's own clock drives durationMs.
    expect(m.startedAt).toBe(String(startedAt));
    expect(Number(m.durationMs)).toBeGreaterThanOrEqual(1000);
    expect(m.stageStats).toBe("clarify:5:0:0");
    expect(m.loopCycleCount).toBe("2");
    expect(m.stageVisitOrder).toBe("clarify,plan,develop");
    expect(m.requirementDoc).toBe("docs/design/77_Config.md");
    expect(m.planDoc).toBe("docs/design/77_Config_Plan.md");
    expect(m.finalStage).toBe("develop");
    expect(typeof m.auditPath).toBe("string");
    expect((m.auditPath as string).length).toBeGreaterThan(0);
    expect(m.commitIds).toBe("");

    // The abort mutation itself still lands on meta (guard/idempotence intact).
    expect(meta.flowState).toBe("aborted");
    expect(meta.terminateReason).toBe("session_quit");
  });

  it("completed guard keeps writing the skip audit WITHOUT the aggregate", async () => {
    const events: Array<{ event: string; message?: Record<string, string | boolean> }> = [];
    __setSafeWriteAuditLogOverride(async (event, message) => {
      events.push({ event, message: message as Record<string, string | boolean> });
    });

    const meta = makeTestMeta({ currentStage: "completed", pipelineId: nextPid() });
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: { notify: () => {} },
    };

    await markPipelineAborted(ctx as any, "session_quit");

    expect(events.some((e) => e.event === "pipeline_abort_skipped_completed")).toBe(true);
    expect(events.some((e) => e.event === "pipeline_session_aborted")).toBe(false);
  });
});

// ─── Exit path 4: tool-mode verify exit (210 review issue 3) ─────────────────
//
// `stages[x].verify.mode = "tool"` exits went through `applyVerifyPass`
// directly and produced NO exit evidence (no stage_usage / stageStats /
// enriched stage_advance), violating requirement 5.11 #10. The fix gates
// `applyVerifyPass` with `emitExitEvidence` and routes BOTH paths through the
// one shared bundle producer.

describe("210 review issue 3: tool-mode verify exit evidence", () => {
  /** Feed one assistant usage message so the pipeline is touched and `stage_usage` renders. */
  async function feedUsage(meta: SessionMeta): Promise<void> {
    const hook = createUsageRecorder();
    await (hook.handler as (c: unknown) => Promise<void>)({
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      event: {
        message: {
          role: "assistant",
          model: "qwen3.8-flash",
          provider: "bailian",
          timestamp: Date.now(),
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, costUsd: 0.25 },
        },
      },
    });
  }

  /** Count audit lines for an exact event name. */
  function countEvents(content: string, event: string): number {
    return content.split("\n").filter((l) => new RegExp(`\\] ${event} \\|`).test(l)).length;
  }

  it("applyVerifyPass (tool opts) writes stage_usage + enriched stage_advance and records stageStats", async () => {
    const root = await setupRoot("tool-verify-stage");
    const config = makeTestConfig({ projectRoot: root });
    const enteredAt = Date.now() - 1200;
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      stageStartTime: enteredAt,
      verifyAttempts: 2,
      confirmRejections: 1,
      loopCycleCount: 2,
      summaries: {},
    });
    const ctx = makeCtx(meta, config);
    await feedUsage(meta);

    // Production semantics: the caller's snapshot is NOT the live store object
    // (the real session-state returns fresh merged reads), so the exit evidence
    // sees the PRE-advance clocks even though the harness store mutates in place.
    const snapshot = { ...meta };
    const res = await applyVerifyPass(
      ctx as any,
      snapshot,
      "develop",
      "review",
      PASS_RESULT,
      { method: "tool", handleTerminal: true, returnResult: true, ui: createPipelineUI(config), emitExitEvidence: true },
    );
    expect(res.success).toBe(true);

    const content = await readAudit(root, meta.pipelineId);
    assertSingleLineFormat(content);

    const f = auditFields(content, "stage_advance");
    expect(f.method).toBe("verify_tool");
    expect(f.fromStage).toBe("develop");
    expect(f.toStage).toBe("review");
    expect(f.stageEnteredAt).toBe(String(enteredAt));
    expect(Number(f.durationMs)).toBeGreaterThanOrEqual(1200);
    expect(f.verifyAttempts).toBe("2");
    expect(f.confirmRejections).toBe("1");
    expect(f.loopCycleCount).toBe("2");
    expect(f.evidenceUnavailable).toBe("true");
    expect(f.commitIds).toBe("");
    expect(f.stageStats.startsWith("develop:")).toBe(true);

    // Requirement 5.11 #10: exactly ONE stage_usage per tool-mode exit.
    expect(countEvents(content, "stage_usage")).toBe(1);
    const u = auditFields(content, "stage_usage");
    expect(u.stage).toBe("develop");
    expect(u.model).toBe("qwen3.8-flash");
    expect(u.totalTokens).toBe("150");

    // The exited stage's stats are persisted into meta (same as the hook path).
    expect(meta.stageStats?.develop?.durationMs).toBeGreaterThanOrEqual(1200);

    await rm(root, { recursive: true, force: true });
  });

  it("applyVerifyPass (tool opts, terminal) writes pipeline_completed aggregate + stage_usage, no stage_advance", async () => {
    const root = await setupRoot("tool-verify-terminal");
    const config = makeTestConfig({ projectRoot: root });
    const summaryPath = join(root, "review-summary.md");
    await writeFile(summaryPath, "---\n{\n  \"commit_ids\": [\"9aa11bb\"]\n}\n---\n", "utf-8");

    const enteredAt = Date.now() - 1100;
    const startedAt = Date.now() - 80_000;
    const meta = makeTestMeta({
      currentStage: "review",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: enteredAt,
      pipelineStartedAt: startedAt,
      stageVisitOrder: ["clarify", "plan", "develop", "review"],
      stageStats: { plan: { durationMs: 20, verifyAttempts: 1, confirmRejections: 0 } },
      summaries: { review: { path: summaryPath, hash: "h", status: "valid" } },
    });
    const ctx = makeCtx(meta, config);
    await feedUsage(meta);

    const res = await applyVerifyPass(
      ctx as any,
      meta,
      "review",
      null,
      PASS_RESULT,
      { method: "tool", handleTerminal: true, returnResult: true, ui: createPipelineUI(config), emitExitEvidence: true },
    );
    expect(res.success).toBe(true);

    const content = await readAudit(root, meta.pipelineId);
    assertSingleLineFormat(content);
    // Terminal exit: the run aggregate replaces stage_advance (hook semantics).
    expect(countEvents(content, "stage_advance")).toBe(0);
    expect(countEvents(content, "stage_usage")).toBe(1);

    const f = auditFields(content, "pipeline_completed");
    expect(f.method).toBe("verify_tool");
    expect(f.finalStage).toBe("review");
    expect(f.startedAt).toBe(String(startedAt));
    expect(Number(f.durationMs)).toBeGreaterThanOrEqual(1100);
    expect(f.stageStats).toBe("plan:20:1:0");
    expect(f.commitIds).toBe("9aa11bb");
    expect(f.auditPath).toContain(meta.pipelineId);

    await rm(root, { recursive: true, force: true });
  });

  it("applyVerifyPass WITHOUT the flag emits nothing (hook path stays caller-owned, no double writes)", async () => {
    const root = await setupRoot("tool-verify-quiet");
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      stageStartTime: Date.now() - 900,
      summaries: {},
    });
    const ctx = makeCtx(meta, config);

    const res = await applyVerifyPass(
      ctx as any,
      meta,
      "develop",
      "review",
      PASS_RESULT,
      { method: "rule", handleTerminal: false, returnResult: true, ui: createPipelineUI(config) },
    );
    expect(res.success).toBe(true);

    const content = await readAudit(root, meta.pipelineId);
    // auto_verify_pass is written by applyVerifyPass itself…
    expect(countEvents(content, "auto_verify_pass")).toBe(1);
    // …but the exit evidence stays with the hook caller (no drift / doubles).
    expect(countEvents(content, "stage_advance")).toBe(0);
    expect(countEvents(content, "stage_usage")).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  it("hook path emits exactly one stage_usage + stage_advance pair (regression pin)", async () => {
    const root = await setupRoot("hook-single");
    const config = makeTestConfig({ projectRoot: root });
    const enteredAt = Date.now() - 1300;
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      stageStartTime: enteredAt,
      verifyAttempts: 1,
      summaries: {},
    });
    const ctx = makeCtx(meta, config);
    await feedUsage(meta);

    await autoAdvanceAfterVerify(
      config, ctx as any, meta, "develop", "review" as PipelineStage, PASS_RESULT, createPipelineUI(config),
    );

    const content = await readAudit(root, meta.pipelineId);
    // applyVerifyPass (no flag) + autoAdvanceAfterVerify = exactly one pair.
    expect(countEvents(content, "stage_advance")).toBe(1);
    expect(countEvents(content, "stage_usage")).toBe(1);
    expect(auditFields(content, "stage_advance").method).toBe("hook_auto_advance");

    await rm(root, { recursive: true, force: true });
  });
});
