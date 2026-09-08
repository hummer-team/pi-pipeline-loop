/**
 * @module restart-rebind.test
 * Phase 0 (173) C1 — restart rebind + stale decision timer cleanup (V5/V7 root fix).
 *
 * Verifies the two additions in flow-state.ts executeDecision "restart" branch:
 *   1. clearDecisionTimer(oldPipelineId) — clears stale retry timer so the old
 *      frozen pipeline no longer re-prompts after the flow has moved on.
 *   2. registerSession(config, sessionFile, newPipelineId) — rebinds the owner
 *      session's registry entry so subagent JOINs resolve to the new pipeline
 *      (not the superseded frozen one).
 *
 * Test plan (per docs/design/173_E2E_Bug_plan.md §Phase 0):
 *   1. restart → registerSession(sessionFile, newPipelineId); registry file points to new flow
 *   2. restart after scheduleDecisionRetry(old pid) → timer cleared (no secondary prompt)
 *   3. restart without sessionManager (ctx._ctx missing) → zero exception, fail-open
 *   4. resume/skip/rollback/abort → registerSession zero calls (regression pin)
 *   5. restart → sub-session registry JOIN resolves to new flow with flowState=running
 *   6. V7: post-restart violations recorded on new flow; old meta.json on disk unchanged
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  executeDecision,
  scheduleDecisionRetry,
  clearAllDecisionTimers,
  __decisionTimerCount,
  __hasDecisionTimer,
} from "../../core/flow-state";
import type { FlowStateCtx } from "../../core/flow-state";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestMeta, makeTestConfig } from "../helpers";
import { registerSession, lookupParentPipeline } from "../../utils/session-registry";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { mkdir, rm, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a FlowStateCtx with a mutating mock session + optional _ctx injection. */
function makeRestartCtx(
  meta: SessionMeta,
  opts?: {
    sessionFile?: string;
    /** When true, _ctx is omitted entirely (simulates missing RuntimeCtx). */
    noCtx?: boolean;
    /** When true, _ctx is present but sessionManager is absent. */
    noSessionManager?: boolean;
    /** Optional select spy for retry-timer side-effect observation. */
    selectSpy?: () => Promise<string | undefined>;
  },
): FlowStateCtx {
  const ctx: FlowStateCtx = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: opts?.selectSpy
      ? { select: opts.selectSpy }
      : undefined,
  };
  if (!opts?.noCtx) {
    if (opts?.noSessionManager) {
      (ctx as unknown as { _ctx: Record<string, unknown> })._ctx = {};
    } else if (opts?.sessionFile) {
      (ctx as unknown as { _ctx: Record<string, unknown> })._ctx = {
        sessionManager: {
          getSessionFile: () => opts.sessionFile!,
        },
      };
    }
  }
  return ctx;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Phase 0 (173) C1: restart session-registry rebind", () => {
  let TMP: string;

  afterEach(async () => {
    clearAllDecisionTimers();
    if (TMP) {
      await rm(TMP, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function setupTmp(label: string): Promise<PipelineConfig> {
    TMP = join(tmpdir(), `pi-restart-rebind-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    return config;
  }

  it("restart rebinds owner registry entry to the new pipelineId (V5 root fix)", async () => {
    const config = await setupTmp("rebind");
    const originalPipelineId = "pipe-old-owner";
    const meta = makeTestMeta({
      pipelineId: originalPipelineId,
      flowState: "blocked",
      blockedReason: "loop_overflow",
      currentStage: "develop",
    });
    const ctx = makeRestartCtx(meta, { sessionFile: "session-owner-1" });

    const result = await executeDecision(ctx, meta, "restart", config);

    expect(result.success).toBe(true);
    const newPipelineId = meta.pipelineId;
    expect(newPipelineId).not.toBe(originalPipelineId);

    // Registry file must now map session-owner-1 → newPipelineId
    const lookupResult = await lookupParentPipeline(config, "session-owner-1");
    expect(lookupResult).toBe(newPipelineId);

    // Directly inspect registry file tail entry (atomic upsert semantics)
    const registryPath = join(TMP, ".pi", "audit", "session-registry.json");
    const registryContent = await readFile(registryPath, "utf-8");
    const registry = JSON.parse(registryContent);
    expect(registry["session-owner-1"].pipelineId).toBe(newPipelineId);
    expect(registry["session-owner-1"].registeredAt).toBeNumber();
  });

  it("restart clears stale decision retry timer (V7 orphan-timer fix)", async () => {
    const config = await setupTmp("timer");
    const oldPipelineId = "pipe-old-timer";
    const meta = makeTestMeta({
      pipelineId: oldPipelineId,
      flowState: "blocked",
      blockedReason: "loop_overflow",
      currentStage: "develop",
    });

    // Observe retry timer side effect via selectSpy — if the stale timer fires
    // after restart, it would call promptDecisionMenu → ui.select.
    let selectCalls = 0;
    const ctx = makeRestartCtx(meta, {
      sessionFile: "session-timer-1",
      selectSpy: async () => {
        selectCalls++;
        return undefined; // interrupted
      },
    });

    // Schedule a retry for the OLD pipelineId BEFORE restart (V7 orphan-timer scenario)
    scheduleDecisionRetry(ctx, meta, config);

    // Sanity: timer is registered for oldPipelineId before restart
    expect(__hasDecisionTimer(oldPipelineId)).toBe(true);
    expect(__decisionTimerCount()).toBe(1);

    // Execute restart — must clear the timer for oldPipelineId
    const result = await executeDecision(ctx, meta, "restart", config);
    expect(result.success).toBe(true);
    expect(meta.pipelineId).not.toBe(oldPipelineId);

    // Timer for the OLD pipelineId must be cleared (V7 root fix)
    expect(__hasDecisionTimer(oldPipelineId)).toBe(false);
    expect(__decisionTimerCount()).toBe(0);

    // selectCalls must be 0 — the stale timer did NOT fire
    expect(selectCalls).toBe(0);
  });

  it("restart without _ctx (missing RuntimeCtx) is fail-open — no exception", async () => {
    const config = await setupTmp("noctx");
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeRestartCtx(meta, { noCtx: true });

    // Must not throw even though ctx._ctx is undefined
    const result = await executeDecision(ctx, meta, "restart", config);
    expect(result.success).toBe(true);
    expect(meta.pipelineId).not.toBe("pipe-test-001");
    // Registry file must NOT exist (no sessionFile → no write)
    const registryPath = join(TMP, ".pi", "audit", "session-registry.json");
    let exists = true;
    try {
      await access(registryPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("restart with _ctx but no sessionManager is fail-open — no exception, no registry write", async () => {
    const config = await setupTmp("nosm");
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeRestartCtx(meta, { noSessionManager: true });

    const result = await executeDecision(ctx, meta, "restart", config);
    expect(result.success).toBe(true);
    // Registry file must NOT exist
    const registryPath = join(TMP, ".pi", "audit", "session-registry.json");
    let exists = true;
    try {
      await access(registryPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("restart with empty sessionFile from getSessionFile → no registry write (registerSession guard)", async () => {
    const config = await setupTmp("emptysf");
    const meta = makeTestMeta({
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    // sessionFile is "" — registerSession's internal guard returns early
    const ctx = makeRestartCtx(meta, { sessionFile: "" });

    const result = await executeDecision(ctx, meta, "restart", config);
    expect(result.success).toBe(true);
    const registryPath = join(TMP, ".pi", "audit", "session-registry.json");
    let exists = true;
    try {
      await access(registryPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("resume/skip/rollback/abort do NOT touch session registry (regression pin)", async () => {
    const config = await setupTmp("noreg");

    // Seed a pre-existing registry entry to prove we don't clobber it
    await registerSession(config, "session-owner-1", "pipe-should-survive");

    const decisions = ["resume", "skip", "rollback", "abort"] as const;
    for (const decision of decisions) {
      const meta = makeTestMeta({
        pipelineId: "pipe-regression-pin",
        flowState: "blocked",
        blockedReason: "loop_overflow",
        currentStage: "develop",
        previousStage: "plan",
        summaries: {
          plan: { path: "/tmp/p.md", hash: "h", status: "valid" },
          develop: { path: "/tmp/d.md", hash: "h", status: "valid" },
        },
      });
      const ctx = makeRestartCtx(meta, { sessionFile: "session-owner-1" });

      const result = await executeDecision(ctx, meta, decision, config);
      // All decisions should succeed (given the frozen+stage setup)
      expect(result.success).toBe(true);
    }

    // Registry entry must still point at the original pipeline (untouched)
    const lookupResult = await lookupParentPipeline(config, "session-owner-1");
    expect(lookupResult).toBe("pipe-should-survive");
  });

  it("restart → sub-session JOIN resolves to new flow (flowState=running)", async () => {
    const config = await setupTmp("join");
    const originalPipelineId = "pipe-pre-restart";
    const meta = makeTestMeta({
      pipelineId: originalPipelineId,
      flowState: "blocked",
      blockedReason: "loop_overflow",
      currentStage: "develop",
    });
    const parentSessionFile = "session-parent-main";
    const ctx = makeRestartCtx(meta, { sessionFile: parentSessionFile });

    // Pre-restart: register parent session against the old flow
    await registerSession(config, parentSessionFile, originalPipelineId);

    // Restart → rebinds parent session to new flow
    const result = await executeDecision(ctx, meta, "restart", config);
    expect(result.success).toBe(true);
    const newPipelineId = meta.pipelineId;

    // Sub-session JOIN lookup (the 22:20:19 accident replay):
    // a subagent spawned by the parent looks up the parent's registry entry
    // to find the active pipeline. After restart, this MUST resolve to the
    // new pipelineId, not the superseded frozen one.
    const resolvedPipelineId = await lookupParentPipeline(config, parentSessionFile);
    expect(resolvedPipelineId).toBe(newPipelineId);
    expect(resolvedPipelineId).not.toBe(originalPipelineId);

    // New flow is running (subagent will NOT be blocked by frozen-state guards)
    expect(meta.flowState).toBe("running");
    expect(meta.currentStage).toBe("clarify");
  });

  it("V7: post-restart violations go to new flow; old meta.json on disk unchanged", async () => {
    const config = await setupTmp("v7");
    const oldPipelineId = "pipe-old-v7";
    const oldMetaDir = join(TMP, ".pi", "audit", oldPipelineId);
    await mkdir(oldMetaDir, { recursive: true });

    // Simulate old meta on disk with a pre-existing violation
    const meta = makeTestMeta({
      pipelineId: oldPipelineId,
      flowState: "blocked",
      blockedReason: "violation_overflow",
      currentStage: "develop",
      violations: [
        { type: "write_protected", detail: "pre-existing violation", timestamp: Date.now() - 10000 },
      ],
    });
    const oldMetaPath = join(oldMetaDir, "meta.json");
    await writeFile(oldMetaPath, JSON.stringify(meta, null, 2), "utf-8");

    const ctx = makeRestartCtx(meta, { sessionFile: "session-v7" });
    const result = await executeDecision(ctx, meta, "restart", config);
    expect(result.success).toBe(true);

    // After restart, in-memory meta has new pipelineId and violations are cleared
    const newPipelineId = meta.pipelineId;
    expect(newPipelineId).not.toBe(oldPipelineId);
    expect(meta.violations ?? []).toEqual([]);

    // Simulate a new violation recorded against the (now new) pipeline
    meta.violations = meta.violations ?? [];
    meta.violations.push({
      type: "write_protected",
      detail: "new-flow violation",
      timestamp: Date.now(),
    });
    expect(meta.violations).toHaveLength(1);
    expect(meta.violations[0].detail).toBe("new-flow violation");

    // Old meta.json on disk (superseded pipeline's historical record) is UNCHANGED
    const oldMetaOnDisk = JSON.parse(await readFile(oldMetaPath, "utf-8"));
    expect(oldMetaOnDisk.pipelineId).toBe(oldPipelineId);
    expect(oldMetaOnDisk.violations).toHaveLength(1);
    expect(oldMetaOnDisk.violations[0].detail).toBe("pre-existing violation");
  });

  it("registerSession call during restart is awaited (not fire-and-forget) — registry readable immediately after", async () => {
    const config = await setupTmp("await");
    const meta = makeTestMeta({
      pipelineId: "pipe-await-test",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = makeRestartCtx(meta, { sessionFile: "session-await" });

    const result = await executeDecision(ctx, meta, "restart", config);
    expect(result.success).toBe(true);

    // The registry must be readable IMMEDIATELY after executeDecision resolves
    // (registerSession was awaited, not fire-and-forget)
    const lookupResult = await lookupParentPipeline(config, "session-await");
    expect(lookupResult).toBe(meta.pipelineId);
  });
});
