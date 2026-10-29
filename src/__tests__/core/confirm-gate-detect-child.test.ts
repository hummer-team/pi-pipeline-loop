import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { join } from "node:path";
import {
  maybeHandleConfirmGate,
  detectPendingConfirmGate,
  recordConfirmGateOutcome,
} from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor, makeRealisticManagerRegistry } from "../helpers";
import type { PipelineConfig } from "../../types";
import {
  makePlanConfigWithConfirm,
  createPlanDoc,
  setupConfirmGateTmpDir,
  getTmpDir,
  createProductionSemanticsCtx,
} from "./confirm-gate-test-helpers";

setupConfirmGateTmpDir();

// ─── Phase 3 / 180: detectPendingConfirmGate predicate ───────────────────────

describe("Phase 3 / 180: detectPendingConfirmGate", () => {
  it("re-ask trace for the current stage → true", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 1 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("effective deferral stamp for the current stage → true", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const now = Date.now();
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: now,
      confirmGateDeferredAt: { stage: "plan", at: now },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("stale stamp (at < stageStartTime) only → false", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const now = Date.now();
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: now,
      confirmGateDeferredAt: { stage: "plan", at: now - 200_000 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });

  it("confirm marker already written → false", async () => {
    await createPlanDoc("# Plan\n\n## 用户确认：确认无误\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 1 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });

  it("non-gate stage (develop) → false", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "develop", count: 1 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });

  it("smart confirm mode → false", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "smart");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 1 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });

  it("re-ask budget exhausted (count=3) → still true (resume is deterministic)", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 3 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("no trace at all → false", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });
});

// ─── Phase 1 / 181: child session zero-side-effect bypass ─────────────────────

describe("Phase 1 / 181: child session zero-side-effect bypass", () => {
  it("child + non-gate stage → no-gate, deferral stamp preserved, zero meta writes", async () => {
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "completed",
      confirmGateDeferredAt: { stage: "completed", at: Date.now() },
    });
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "manual",
      isChild: true,
      sessionFile: "child-1",
    });

    expect(result).toEqual({ result: "no-gate" });
    expect(ctx.metadataUpdates).toEqual([]);
    // Owner would clear the stale stamp here; the child must not.
    expect(meta.confirmGateDeferredAt?.stage).toBe("completed");
  });

  it("child + smart needConfirm=false → no-gate, deferral stamp preserved, zero meta writes", async () => {
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "smart");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "smart",
      needConfirm: false,
      isChild: true,
      sessionFile: "child-1",
    });

    expect(result).toEqual({ result: "no-gate" });
    expect(ctx.metadataUpdates).toEqual([]);
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
  });

  it("child + confirm marker already present → no-gate, deferral stamp preserved, zero meta writes", async () => {
    await createPlanDoc("# Plan\n\n## 用户确认：确认无误\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "manual",
      isChild: true,
      sessionFile: "child-1",
    });

    expect(result).toEqual({ result: "no-gate" });
    expect(ctx.metadataUpdates).toEqual([]);
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
  });

  it("child + real gate (plan/manual/no marker) → handled+pending+deferred, suppression audit, deferred stamp written to shared meta", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    const beforeBypass = Date.now();
    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "manual",
      isChild: true,
      sessionFile: "child-42",
    });

    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    // Zero UI, but deferred stamp is written to shared meta (Phase 2 / 190 Fix-E).
    expect(selectCalls).toBe(0);
    expect(ctx.metadataUpdates.length).toBe(1);
    expect(meta.confirmGateDeferredAt).toBeDefined();
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    expect(meta.confirmGateDeferredAt!.at).toBeGreaterThanOrEqual(beforeBypass);
    // Suppression audit with attribution fields and deferredAt stamp.
    const logContent = await fs.readFile(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_suppressed_child");
    expect(logContent).toContain("stage=plan");
    expect(logContent).toContain("sessionFile=child-42");
    expect(logContent).not.toContain("confirm_gate_deferred");
  });

  it("owner (default isChild=false) still presents the dialog and advances", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, {
      mode: "manual",
    });

    expect(selectCalls).toBe(1);
    expect(result.result).toBe("handled");
  });
});

// ─── Phase 2 (190) Fix-E: child bypass stamp → detectPendingConfirmGate ───────

describe("Phase 2 (190) Fix-E: child bypass stamp → detectPendingConfirmGate", () => {
  it("child bypass stamp makes detectPendingConfirmGate return true (e2e)", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const stageStartTime = Date.now() - 1000; // stage started 1s ago
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime,
    });
    const ctx = createMockCtx(meta);

    // Child bypass writes the stamp
    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "manual",
      isChild: true,
      sessionFile: "child-e2e",
    });

    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    expect(meta.confirmGateDeferredAt).toBeDefined();
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    // stamp.at should be after stageStartTime (non-stale)
    expect(meta.confirmGateDeferredAt!.at).toBeGreaterThan(stageStartTime);

    // Now detectPendingConfirmGate should return true
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("child bypass stamp with at < stageStartTime → detectPendingConfirmGate returns false (regression)", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);

    // Child bypass writes the stamp
    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "manual",
      isChild: true,
      sessionFile: "child-stale",
    });

    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    expect(meta.confirmGateDeferredAt).toBeDefined();

    // Now simulate stale: set stageStartTime to after the stamp
    const stampAt = meta.confirmGateDeferredAt!.at;
    meta.stageStartTime = stampAt + 1000;

    // detectPendingConfirmGate should return false because stamp is stale
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });
});

// ─── Phase 2 / 181: present-time re-stamp of the pending gate ─────────────────

describe("Phase 2 / 181: present-time pending re-stamp", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  });

  it("refreshes confirmGateDeferredAt BEFORE ui.select is awaited", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const before = Date.now();
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: before,
    });
    let stampAtSelect: { stage: string; at: number } | undefined;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => {
      // Snapshot the stamp at the moment the dialog is presented.
      stampAtSelect = meta.confirmGateDeferredAt as { stage: string; at: number } | undefined;
      return "Cancel";
    };

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(result).toEqual({ result: "handled", action: "pending" });
    expect(stampAtSelect?.stage).toBe("plan");
    expect(stampAtSelect!.at).toBeGreaterThanOrEqual(before);
  });

  it("unresolved select (process dies while dialog open) → predicate recovers after reload", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);
    // Never resolves — the user never answers and the process is torn down.
    ctx.ui.select = () => new Promise<string | undefined>(() => {});

    const pending = maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    // Wait until the pre-select stamp refresh has been persisted.
    for (let i = 0; i < 100 && meta.confirmGateDeferredAt === undefined; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    // Rebuilt session state (same meta) → resume predicate hits.
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);

    void pending; // intentionally left unresolved
  });

  it("Cancel keeps pending and the refreshed stamp allows /pipeline-resume re-entry", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Cancel";

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(result).toEqual({ result: "handled", action: "pending" });
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("Esc (undefined) keeps pending and the refreshed stamp allows re-entry", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(result).toEqual({ result: "handled", action: "pending" });
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("Approve clears deferral + reask and advances to design-review", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
      confirmGateReask: { stage: "plan", count: 2 },
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Approve & Advance";

    const gate = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });
    // Mirror the production callers: shared accounting runs after the gate.
    recordConfirmGateOutcome(ctx.session, meta, gate, false);

    expect(gate).toEqual({ result: "handled", action: "advanced", toStage: "design-review" });
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    expect(meta.confirmGateReask).toBeUndefined();
    expect(meta.currentStage).toBe("design-review");
  });

  it("Reject routes to clarify and clears the pending stamp", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Reject & Rework (back to clarify)";

    const gate = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });

    expect(gate).toEqual({ result: "handled", action: "routed", toStage: "clarify" });
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    expect(meta.currentStage).toBe("clarify");
  });

  it("stale presentation stamp + reask → subagent live triggers fresh defer (not premature timeout) [production semantics]", async () => {
    // Regression test for review #1→#2 (High): under production semantics,
    // updateMeta returns a new object without mutating the caller's `meta`
    // snapshot. The stale-stamp clearing must re-read via getMeta() so that
    // evaluateConfirmGateDeferral sees the cleared state, not the stale input.
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const stageStart = Date.now();
    // Stamp from a presentation 300ms ago, with reask=1 (user Esc'd earlier).
    const staleStamp = { stage: "plan" as const, at: stageStart - 300 };
    const inputMeta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: stageStart - 1000,
      confirmGateDeferredAt: staleStamp,
      confirmGateReask: { stage: "plan", count: 1 },
    });
    // Simulate a running subagent via the global manager symbol
    // (218 T4.2 real-shape double; hasRunning override — no top-level record).
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] =
      makeRealisticManagerRegistry({}, { hasRunning: true });

    try {
      // Production-semantic mock: updateMeta returns a new object via spread,
      // getMeta returns the latest persisted state. The input `meta` is NOT
      // mutated by updateMeta — matching createSessionState.updateMeta().
      const prodCtx = createProductionSemanticsCtx(inputMeta);
      const configShortTimeout = { ...config, spawnWaitTimeoutMs: 50 } as PipelineConfig;
      const notifyMessages: string[] = [];

      const gate = await maybeHandleConfirmGate(
        configShortTimeout, prodCtx, inputMeta,
        { notify: (_ctx: unknown, msg: string) => { notifyMessages.push(msg); } } as any,
        { mode: "manual" },
      );

      // The gate should DEFER (fresh window), not TIME OUT.
      expect(gate).toEqual({ result: "handled", action: "pending", deferred: true });
      // First deferral of the new window → notify with defer message, NOT timeout.
      expect(notifyMessages.some(m => m.includes("deferred"))).toBe(true);
      expect(notifyMessages.some(m => m.includes("timeout"))).toBe(false);
      // The persisted state (via getMeta) has a fresh deferral stamp.
      const persisted = prodCtx.session.getMeta();
      expect(persisted?.confirmGateDeferredAt).toBeDefined();
      expect(persisted?.confirmGateDeferredAt?.stage).toBe("plan");
      expect(persisted!.confirmGateDeferredAt!.at).toBeGreaterThan(staleStamp.at);
      // The input meta snapshot is NOT mutated (production semantics).
      expect(inputMeta.confirmGateDeferredAt).toEqual(staleStamp);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    }
  });

  it("existing deferral stamp is preserved at presentation (anchor not shifted) [production semantics]", async () => {
    // Under production semantics: when a deferral stamp exists from a prior
    // defer in this visit, the presentation must NOT overwrite it — preserving
    // the defer-timeout anchor. The input meta snapshot is not mutated.
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const deferStamp = { stage: "plan" as const, at: Date.now() - 50 };
    const inputMeta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 5000,
      confirmGateDeferredAt: deferStamp,
    });
    const prodCtx = createProductionSemanticsCtx(inputMeta);
    let stampAtSelect: { stage: string; at: number } | undefined;
    prodCtx.ui.select = async () => {
      // Read from the session's latest state (production semantics).
      const live = prodCtx.session.getMeta();
      stampAtSelect = live?.confirmGateDeferredAt as { stage: string; at: number } | undefined;
      return "Cancel";
    };

    await maybeHandleConfirmGate(config, prodCtx, inputMeta, { notify: () => {} } as any, { mode: "manual" });

    // The stamp at the moment of presentation is the ORIGINAL deferral stamp,
    // not a fresh one — the anchor is preserved.
    expect(stampAtSelect).toEqual(deferStamp);
    // Persisted state still has the original stamp (reload recovery intact).
    const persisted = prodCtx.session.getMeta();
    expect(persisted?.confirmGateDeferredAt).toBeDefined();
    expect(persisted!.confirmGateDeferredAt!.at).toBe(deferStamp.at);
    // The input meta snapshot is NOT mutated.
    expect(inputMeta.confirmGateDeferredAt).toEqual(deferStamp);
  });

  it("present with no existing stamp → persists a new stamp for reload recovery [production semantics]", async () => {
    // When no deferral stamp exists (first presentation of this visit), the
    // gate must persist a new stamp so that /pipeline-resume can recover the
    // pending gate across reloads.
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const inputMeta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    // No confirmGateDeferredAt — fresh state.
    expect(inputMeta.confirmGateDeferredAt).toBeUndefined();

    const prodCtx = createProductionSemanticsCtx(inputMeta);
    prodCtx.ui.select = async () => undefined; // Esc

    await maybeHandleConfirmGate(config, prodCtx, inputMeta, { notify: () => {} } as any, { mode: "manual" });

    // Persisted state now has a stamp for reload recovery.
    const persisted = prodCtx.session.getMeta();
    expect(persisted?.confirmGateDeferredAt).toBeDefined();
    expect(persisted?.confirmGateDeferredAt?.stage).toBe("plan");
    // detectPendingConfirmGate must return true.
    expect(await detectPendingConfirmGate(config, persisted!)).toBe(true);
    // The input meta snapshot is NOT mutated.
    expect(inputMeta.confirmGateDeferredAt).toBeUndefined();
  });
});

// ── G3 (188): evaluateConfirmGateDeferral narrow defer to expected agent ─────

describe("G3 (188): narrow confirm gate defer to expected stage agent liveness", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  // 218 T0.6: the 0.22.0 manager exposes NO enumeration — liveness resolves
  // per-id via getRecord. Records are keyed by id; ledger entries carry the
  // ids, so a seeded entry probes live exactly when its record is running.
  // 218 T4.2: converted to the real-shape double — `hasRunning` now derives
  // from the REAL live statuses (queued/running/steered); "spawning" is not
  // an upstream registry status and never counted in production.
  function setManagerWithRecords(records: Array<{ id: string; name: string; status: string }>): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] =
      makeRealisticManagerRegistry(
        new Map(records.map((r) => [r.id, { status: r.status }])),
      );
  }

  function setManagerRunning(running: boolean): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] =
      makeRealisticManagerRegistry({}, { hasRunning: running });
  }

  function clearManager(): void {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  }

  afterEach(() => clearManager());

  /** Helper: create plan config with agentPath and agent file, using the beforeEach tmpDir */
  async function makePlanConfigWithAgent(root: string) {
    const base = makeTestConfig({ projectRoot: root });
    const agentDir = path.join(root, "agents");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "plan-agent.md"), "---\nname: plan-agent\n---\n# Plan Agent\n");
    const planStage = {
      ...base.stages.plan,
      agentPath: "agents/plan-agent.md",
      allowedWritePaths: ["docs/", "doc/", "documentation/"],
      confirm: { mode: "manual" as const },
    };
    return { ...base, stages: { ...base.stages, plan: planStage as typeof base.stages.plan } };
  }

  it("expected agent settled (no ledger evidence) → gate fires (present)", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = await makePlanConfigWithAgent(tmpDir);

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);
    let selectCalls = 0;
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    // No live agents at all → no ledger probe can hit for "plan-agent"
    setManagerWithRecords([]);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });

    // Gate should fire (not deferred) because expected agent is not live
    expect(selectCalls).toBe(1);
    expect((result as any).result).toBe("handled");
    expect((result as any).action).toBe("advanced");
    expect((result as any).toStage).toBe("design-review");
  });

  it("expected agent live (ledger hit + probe_live) → gate defers", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = await makePlanConfigWithAgent(tmpDir);

    // 218 T0.6: evidence is the LEDGER entry whose agentId probes live.
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      activeSpawns: {
        plan: { agentName: "plan-agent", agentId: "agent-1", startedAt: Date.now() },
      },
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Approve & Advance";

    // Expected agent "plan-agent" (agent-1) is live
    setManagerWithRecords([{ id: "agent-1", name: "plan-agent", status: "running" }]);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });

    // Gate should defer because expected agent is live
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
  });

  it("no agentPath configured (expectedAgentName=undefined) → falls back to anyTopLevelRunning", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    // Config WITHOUT agentPath → resolveAgentMention returns null → expectedAgentName=undefined
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);
    let selectCalls = 0;
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    // anyTopLevelRunning returns true (unrelated subagent live)
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    // Should defer (legacy behavior — falls back to anyTopLevelRunning)
    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
  });

  it("unrelated agent live but expected agent settled → gate fires (narrow probe wins)", async () => {
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = await makePlanConfigWithAgent(tmpDir);

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);
    let selectCalls = 0;
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    // Unrelated agent "develop-agent" is live, but expected "plan-agent" is NOT live
    setManagerWithRecords([{ id: "agent-2", name: "develop-agent", status: "running" }]);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });

    // G3: gate should fire because expected agent ("plan-agent") is not live,
    // even though an unrelated agent is running
    expect(selectCalls).toBe(1);
    expect((result as any).result).toBe("handled");
    expect((result as any).action).toBe("advanced");
    expect((result as any).toStage).toBe("design-review");
  });

  it("manager singleton unavailable + expectedAgentName set → falls back to anyTopLevelRunning/evidence", async () => {
    // Plan Phase 3 boundary: when the manager singleton is unavailable,
    // (legacy) the name probe returned null (same as "agent not found"). The
    // code must distinguish these cases and fall back to the global evidence
    // scan instead of immediately returning "present".
    await createPlanDoc("# Plan\n");
    const tmpDir = getTmpDir();
    const config = await makePlanConfigWithAgent(tmpDir);

    // Case A: manager unavailable + activeSpawns evidence exists → should defer
    {
      clearManager(); // Simulate manager singleton unavailable
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc: "docs/design/77_Config.md",
        activeSpawns: {
          plan: { agentName: "plan-agent", agentId: "reserved-1", startedAt: Date.now(), reserved: true },
        },
      });
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => "Approve & Advance";

      const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

      // With activeSpawns evidence and no manager → fallback detects evidence → defer
      expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    }

    // Case B: manager unavailable + NO activeSpawns evidence → should present (gate fires)
    {
      clearManager(); // Simulate manager singleton unavailable
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc: "docs/design/77_Config.md",
        // No activeSpawns — fallback has nothing to detect
      });
      const ctx = createMockCtx(meta);
      let selectCalls = 0;
      ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

      const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });

      // No manager + no evidence → fallback returns false → gate fires
      expect(selectCalls).toBe(1);
      expect((result as any).result).toBe("handled");
      expect((result as any).action).toBe("advanced");
    }
  });
});
