/**
 * 211_Bug Phase 0: owner-side re-presentation entry for a child-suppressed
 * confirm gate (`src/core/confirm-gate-owner-reprompt.ts`).
 *
 * Coverage:
 * - hook level: child / predicate_mismatch refusals (zero UI, zero meta writes)
 * - hook level: Approve / Auto Review Plan / Esc / defer outcomes reuse the
 *   177/179/180 gate semantics via the chat-turn settle path
 * - module level (defence branch): `not_bound` is unreachable at hook level
 *   (isDormant) — verified by direct module call only (review #6)
 * - module level: review-stage `defaultReject:true` keeps "Reject & Send to
 *   Fix" as the FIRST option (review #5)
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { maybeRepromptOwnerConfirmGate } from "../../core/confirm-gate-owner-reprompt";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import { createProductionSemanticsCtx } from "./confirm-gate-test-helpers";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog } from "../../utils/auditLog";
import type { PipelineStage, SessionMeta } from "../../types";

const TMP = join(tmpdir(), "pi-pipeline-agent-settled-owner-reprompt-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

// ── Shared fixtures ──────────────────────────────────────────────────────────

/**
 * Review #2: `makeTestConfig()` defaults `plan.nextStage` to "design-review"
 * and injects no `verify` block. Explicitly give the incident's three
 * prerequisites: `plan.nextStage = "develop"`, plan manual confirm, and a
 * plan stage the Approve test can advance from. helpers.ts defaults must NOT
 * be changed (global blast radius of 2000+ tests).
 */
function makePlanGateConfig(root: string) {
  const base = makeTestConfig({ projectRoot: root });
  return {
    ...base,
    stages: {
      ...base.stages,
      plan: {
        ...base.stages.plan,
        nextStage: "develop" as PipelineStage,
        allowedWritePaths: ["docs/"],
        confirm: { mode: "manual" as const },
      },
    },
  } as typeof base;
}

/** Writes the plan document the gate resolves/marker-checks against. */
async function createPlanDoc(root: string, content: string): Promise<void> {
  const docsDir = join(root, "docs", "design");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "77_Config_Plan.md"), content, "utf-8");
}

/** Chat message that misses every PIPELINE_TURN_SIGNATURES entry. */
function installChatMessage(ctx: ReturnType<typeof createMockCtx>, text = "阅读理解项目SOP规范"): void {
  (ctx._ctx.sessionManager as unknown as { getBranch: () => unknown[] }).getBranch = () => [
    { type: "message", message: { role: "user", content: text } },
  ];
}

// ── Hook-level refusals (child / predicate_mismatch) ─────────────────────────

describe("211 Phase 0: hook-level refusals (zero UI, zero meta writes)", () => {
  it("child chat settle → skipped reason=child, ui.select 0, updateMeta 0", async () => {
    const stageTmp = join(tmpdir(), "pi-211-or-child-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanGateConfig(stageTmp);
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/tmp/parent.jsonl" },
      sessionFile: "/tmp/child.jsonl",
    });
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    installChatMessage(ctx);

    await createAgentSettled(config).handler(ctx as unknown as Parameters<ReturnType<typeof createAgentSettled>["handler"]>[0]);

    expect(selectCalls).toBe(0);
    expect(ctx.metadataUpdates).toHaveLength(0);
    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_owner_reprompt_skipped");
    expect(logContent).toContain("reason=child");
    // Child falls back to the pre-existing ordinary-chat audit (suppression
    // stamp refresh remains owned by the child's own pipeline-turn gate).
    expect(logContent).toContain("agent_settled_non_pipeline_turn");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("deferred stamp for another stage → skipped reason=predicate_mismatch (no gate implied)", async () => {
    const stageTmp = join(tmpdir(), "pi-211-or-mismatch-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanGateConfig(stageTmp);
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");

    const meta = makeTestMeta({
      // Default stage develop: the stamp (plan) cannot act on this visit.
      currentStage: "develop",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    installChatMessage(ctx);

    await createAgentSettled(config).handler(ctx as unknown as Parameters<ReturnType<typeof createAgentSettled>["handler"]>[0]);

    expect(selectCalls).toBe(0);
    expect(ctx.metadataUpdates).toHaveLength(0);
    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_owner_reprompt_skipped");
    expect(logContent).toContain("reason=predicate_mismatch");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── Hook-level gate outcomes through the chat-turn settle path ───────────────

describe("211 Phase 0: hook-level gate outcomes", () => {
  it("Approve & Advance on chat settle → advance to develop, stamp cleared, exactly one spawn-attempt audit", async () => {
    const stageTmp = join(tmpdir(), "pi-211-or-approve-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanGateConfig(stageTmp);
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Advance" });
    installChatMessage(ctx);

    await createAgentSettled(config).handler(ctx as unknown as Parameters<ReturnType<typeof createAgentSettled>["handler"]>[0]);

    // Gate resolved: stage advanced beyond the incident's plan.nextStage.
    expect(meta.currentStage).toBe("develop");
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    // Review #1: resolution clears the re-ask bookkeeping — asserted exactly,
    // never with a two-value tolerant form (constraint 9).
    expect(meta.confirmGateReask).toBeUndefined();

    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_owner_reprompt");
    expect(logContent).toContain("action=advanced");
    expect(logContent).toContain("reask=0");
    expect(logContent).toContain("deferred=false");
    // R4Q3-A: no extra dispatch wiring — assert exactly one stage_spawn attempt
    // audit (any channel reason) was made, without pinning the implementation.
    const spawnAttemptAudit = logContent.match(/stage_spawn_(skipped|rpc|fallback|deferred)/g) ?? [];
    expect(spawnAttemptAudit).toHaveLength(1);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("Auto Review Plan on chat settle → stage switches to design-review", async () => {
    const stageTmp = join(tmpdir(), "pi-211-or-auto-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Review #2: reuse the auto-review config fixture (copied, original file
    // untouched) so design-review carries verify.require + agent/skill paths.
    const base = makeTestConfig({ projectRoot: stageTmp });
    const drStage = {
      ...base.stages["design-review"],
      verify: { require: true },
      agentPath: "agents/design-review.md",
      skillPath: "skills/design-review.md",
    };
    const planStage = {
      ...base.stages.plan,
      nextStage: "design-review" as PipelineStage | null,
      allowedWritePaths: ["docs/"],
      confirm: { mode: "manual" as const },
    };
    const config = {
      ...base,
      stages: { ...base.stages, plan: planStage, "design-review": drStage },
    } as typeof base;

    await createPlanDoc(stageTmp, "# Plan\nTest plan content.");

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    installChatMessage(ctx);

    await createAgentSettled(config).handler(ctx as unknown as Parameters<ReturnType<typeof createAgentSettled>["handler"]>[0]);

    // Authorisation/coordinator internals are covered by
    // auto-review-plan-handler.test.ts — only the reprompt path is asserted.
    expect(meta.currentStage).toBe("design-review");
    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_owner_reprompt");
    expect(logContent).toContain("action=advanced");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("Esc on chat settle → reask count becomes exactly 1, audit action=pending", async () => {
    const stageTmp = join(tmpdir(), "pi-211-or-esc-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanGateConfig(stageTmp);
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return undefined; }; // Esc → pending
    installChatMessage(ctx);

    await createAgentSettled(config).handler(ctx as unknown as Parameters<ReturnType<typeof createAgentSettled>["handler"]>[0]);

    expect(selectCalls).toBe(1);
    expect(meta.confirmGateReask?.stage).toBe("plan");
    expect(meta.confirmGateReask?.count).toBe(1);

    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_owner_reprompt");
    expect(logContent).toContain("action=pending");
    expect(logContent).toContain("reask=1");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("subagent still live on chat settle → defer does not consume the budget (deferred=true)", async () => {
    const stageTmp = join(tmpdir(), "pi-211-or-defer-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanGateConfig(stageTmp);
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    installChatMessage(ctx);

    // Reuse the deferral probe stub from confirm-gate-spawn-deferral.test.ts:
    // a top-level subagent report live ⇒ popup deferred, gate stays pending.
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      hasRunning: () => true,
    };
    try {
      await createAgentSettled(config).handler(ctx as unknown as Parameters<ReturnType<typeof createAgentSettled>["handler"]>[0]);
    } finally {
      delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    }

    expect(selectCalls).toBe(0);
    // System deferral must NOT consume the bounded re-ask budget (fb9822d).
    expect(meta.confirmGateReask).toBeUndefined();

    const logContent = await readFile(auditLogFileFor(join(stageTmp, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("confirm_gate_owner_reprompt");
    expect(logContent).toContain("deferred=true");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── Module-level defence branch (not_bound) + review option order ────────────

describe("211 Phase 0: module-level defence and review option order", () => {
  it("not_bound (module direct call) → reason=not_bound, zero UI, zero state writes", async () => {
    // initAuditLog is module-global state: re-point it at THIS test's root so
    // the concurrent hook tests' rm(tmpDir) cannot delete the log underneath.
    const modTmp = join(tmpdir(), "pi-211-or-mod-nobound-" + Date.now());
    await mkdir(modTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: modTmp }));

    const baseMeta = makeTestMeta({
      currentStage: "plan",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    const prodCtx = createProductionSemanticsCtx(baseMeta);
    // Strip pipelineId: the defence branch must refuse an unbound session.
    const { pipelineId: _omitted, ...metaNoPipeline } = baseMeta;

    let selectCalls = 0;
    const ui = {
      notify: (_ctx: unknown, _msg: string) => {},
      select: async () => { selectCalls++; return "Approve & Advance"; },
    };

    const outcome = await maybeRepromptOwnerConfirmGate(
      prodCtx as unknown as Parameters<typeof maybeRepromptOwnerConfirmGate>[0],
      makeTestConfig(),
      metaNoPipeline as SessionMeta,
      ui,
    );

    expect(outcome).toEqual({ consumed: false, reask: 0 });
    expect(selectCalls).toBe(0);
    // Zero state writes: the persisted snapshot is byte-identical to itself.
    expect(prodCtx._persisted()).toEqual(baseMeta);

    // Audit reason is written with the module-level guard note: this state is
    // unreachable through the hook (isDormant already returned) — a hook-level
    // case would be dead code. The unbound session routes to the "unknown"
    // audit directory (no pipelineId to key on).
    const logContent = await readFile(
      auditLogFileFor(join(modTmp, ".pi", "audit"), "unknown"),
      "utf-8",
    );
    expect(logContent).toContain("reason=not_bound");

    await rm(modTmp, { recursive: true, force: true });
  });

  it("review-stage reprompt (module direct) → first option is Reject & Send to Fix (defaultReject=true)", async () => {
    // Same module-global initAuditLog re-pointing as the not_bound case.
    const modTmp = join(tmpdir(), "pi-211-or-mod-review-" + Date.now());
    await mkdir(modTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: modTmp }));

    const base = makeTestConfig();
    const config = {
      ...base,
      stages: {
        ...base.stages,
        review: {
          ...base.stages.review,
          confirm: { mode: "manual" as const },
        },
      },
    } as typeof base;
    const captured: string[][] = [];
    const prodCtx = createProductionSemanticsCtx(
      makeTestMeta({
        currentStage: "review",
        requirementDoc: "docs/design/77_Config.md",
        confirmGateReask: { stage: "review", count: 0 },
      }),
    );
    prodCtx.ui.select = async (_message: string, options: string[]) => {
      captured.push(options);
      return undefined; // Esc → pending
    };

    const ui = { notify: (_ctx: unknown, _msg: string) => {} };
    const outcome = await maybeRepromptOwnerConfirmGate(
      prodCtx as unknown as Parameters<typeof maybeRepromptOwnerConfirmGate>[0],
      config,
      makeTestMeta({
        currentStage: "review",
        requirementDoc: "docs/design/77_Config.md",
        confirmGateReask: { stage: "review", count: 0 },
      }),
      ui,
    );

    expect(outcome.consumed).toBe(true);
    expect(captured).toHaveLength(1);
    // Review #5: no freshly parsed report ⇒ conservative reject-first default,
    // matching the pipeline-turn rule (agent-settled.ts:631-633).
    expect(captured[0][0]).toBe("Reject & Send to Fix");
    expect(captured[0][1]).toBe("Approve & Complete");
    // Esc accounted exactly once through the shared 180 bookkeeping.
    expect(prodCtx._persisted().confirmGateReask?.count).toBe(1);

    await rm(modTmp, { recursive: true, force: true });
  });
});
