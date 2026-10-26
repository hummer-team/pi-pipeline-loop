/**
 * 211_Bug Phase 3: end-to-end incident-chain regression.
 *
 * Chain of the incident (211_Bug.md §1): a child/subagent session hits the
 * real plan confirm gate → the gate is suppressed (181) → the gate must no
 * longer be a SILENT deadlock — the owner must be able to release it either
 * by an owner turn (chain A) or via the one-shot wake escalation (chain B).
 *
 * These tests exercise the THREE entry points together (agent_settled hook,
 * stage-advancer child bypass + arm, owner-escalation wake channel) without
 * re-asserting the unit-level contracts covered by:
 * - agent-settled-owner-reprompt.test.ts (Phase 0 entry)
 * - confirm-gate-escalation.test.ts (Phase 1 arm/clear)
 * - owner-escalation.test.ts (Phase 1 wake predicates)
 *
 * Fixture note (review #2): `makeTestConfig()` defaults `plan.nextStage` to
 * "design-review"; the copied confirm-review fixture explicitly overrides
 * `plan.nextStage = "develop"` (helpers.ts defaults are never modified).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import {
  registerOwnerEscalationObserver,
  setOwnerEscalationDeps,
  type OwnerEscalationDeps,
} from "../../core/owner-escalation";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog } from "../../utils/auditLog";
import type { PipelineStage, SessionMeta } from "../../types";

// ── Shared fixtures (copied from agent-settled-confirm-review.test.ts) ──────

/**
 * The confirm-review fixture with `plan.nextStage = "develop"`, plan manual
 * confirm and `verify.require = true` (review #2 stage-shape override).
 */
function makePlanConfigWithConfirm(root: string, mode: "auto" | "manual" | "smart") {
  const base = makeTestConfig({ projectRoot: root });
  const planStage = {
    ...base.stages.plan,
    nextStage: "develop" as PipelineStage,
    verify: { require: true },
    allowedWritePaths: ["docs/"],
    confirm: { mode },
  };
  return {
    ...base,
    stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
  };
}

async function createPlanDoc(root: string, content: string): Promise<void> {
  const docsDir = join(root, "docs", "design");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "77_Config_Plan.md"), content, "utf-8");
}

async function createVerifyMd(root: string, content: string): Promise<void> {
  const stageDir = join(root, ".pi", "references", "plan_spec");
  await mkdir(stageDir, { recursive: true });
  await writeFile(join(stageDir, "verify.md"), content, "utf-8");
}

/** Pure chat message that misses every PIPELINE_TURN_SIGNATURES entry. */
function installChatMessage(ctx: ReturnType<typeof createMockCtx>, text = "阅读理解项目SOP规范"): void {
  (ctx._ctx.sessionManager as unknown as { getBranch: () => unknown[] }).getBranch = () => [
    { type: "message", message: { role: "user", content: text } },
  ];
}

/** Mock shared pi event bus (emit + on — both required by hasEventBus). */
function makeMockPi() {
  const listeners: Map<string, Array<(payload: unknown) => void>> = new Map();
  return {
    pi: {
      events: {
        emit: (_event: string, _payload: Record<string, unknown>) => {
          for (const handler of listeners.get(_event) ?? []) handler(_payload);
        },
        on: (event: string, handler: (payload: unknown) => void) => {
          const arr = listeners.get(event) ?? [];
          arr.push(handler);
          listeners.set(event, arr);
          return () => {};
        },
      },
    },
  };
}

type SettledCtx = ReturnType<typeof createMockCtx>;

/** Mock ctx whose ui.select returns "Approve & Advance" and counts calls. */
function makeSelectingCtx(
  meta: SessionMeta,
  opts?: Parameters<typeof createMockCtx>[1],
): { ctx: SettledCtx; calls: { select: number } } {
  const calls = { select: 0 };
  const ctx = createMockCtx(meta, opts);
  ctx.ui.select = async () => { calls.select++; return "Approve & Advance"; };
  return { ctx, calls };
}

async function settle(config: ReturnType<typeof makePlanConfigWithConfirm>, ctx: SettledCtx): Promise<void> {
  await createAgentSettled(config).handler(
    ctx as unknown as Parameters<ReturnType<typeof createAgentSettled>["handler"]>[0],
  );
}

async function readAudit(root: string): Promise<string> {
  return readFile(auditLogFileFor(join(root, ".pi", "audit")), "utf-8");
}

describe("211 Phase 3: child suppression → owner release incident chain", () => {
  let escalationCleanup: (() => void) | undefined;

  afterEach(() => {
    // Module-global deps must never leak between chains.
    setOwnerEscalationDeps(null);
    if (escalationCleanup) {
      escalationCleanup();
      escalationCleanup = undefined;
    }
  });

  it("chain A: owner chat turn re-presents the gate once, Approve releases it, interlock clears (no double dispatch)", async () => {
    const stageTmp = join(tmpdir(), "pi-211-flow-a-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");
    await createVerifyMd(
      stageTmp,
      `---\nrequiredFiles:\n  - "docs/design/77_Config_Plan.md"\n---\nVerify plan.`,
    );

    // Incident meta (review #1): plan stage, stageStartTime EARLIER than the
    // deferral stamp the child will write, reask budget untouched.
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 1000,
      pipelineId: `pipe-211-flow-a-${Date.now()}`,
    });
    // Pre-existing residue (179 deferred spawn): a live plan child left a
    // pendingSpawns entry. The incident chain must release the interlock
    // without double dispatching it.
    meta.pendingSpawns = {
      plan: {
        agentName: "plan-agent",
        requestedAt: Date.now(),
        attempts: 0,
        pipelineId: meta.pipelineId,
      },
    } as SessionMeta["pendingSpawns"];

    // Step 1: child session settles its plan turn → real gate suppressed.
    // The child ctx carries an events bus so the one-shot arm+BROADCAST runs.
    const { pi: busPi } = makeMockPi();
    const childCtx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/tmp/owner.jsonl" },
      sessionFile: "/tmp/child.jsonl",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pi: busPi as any,
    });
    await settle(config, childCtx);
    // NO owner escalation observer is registered in chain A (plan contract):
    // the broadcast must not inject a followUp and mix channel A with B.

    // Step 2: owner pure-chat settle → gate re-presented exactly once.
    const owner1 = makeSelectingCtx(meta);
    installChatMessage(owner1.ctx);
    await settle(config, owner1.ctx);

    expect(meta.currentStage).toBe("develop");
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    expect(meta.confirmGateReask).toBeUndefined();
    expect(owner1.calls.select).toBe(1);

    // Audit sequence in FILE ORDER: suppressed → armed → owner reprompt.
    const log1 = await readAudit(stageTmp);
    const idxSuppressed = log1.indexOf("confirm_gate_suppressed_child ");
    const idxArmed = log1.indexOf("confirm_gate_escalation_armed ");
    const idxReprompt = log1.indexOf("confirm_gate_owner_reprompt ");
    expect(idxSuppressed).toBeGreaterThanOrEqual(0);
    expect(idxArmed).toBeGreaterThan(idxSuppressed);
    expect(idxReprompt).toBeGreaterThan(idxArmed);
    // Review #1 resolution line: advanced with zero reask consumption and no
    // deferral (all three facts on the SAME audit line).
    const repromptLine = log1.slice(log1.lastIndexOf("\n", idxReprompt) + 1).split("\n")[0];
    expect(repromptLine).toContain("action=advanced");
    expect(repromptLine).toContain("reask=0");
    expect(repromptLine).toContain("deferred=false");

    // Step 3: the follow-up owner chat settle (no new user input about the
    // gate) runs consumePendingSpawns again — this is THE next consume of the
    // plan: the stale entry is discarded, and the G2 defer guard never fires
    // again for it (the stamp was cleared BEFORE the advance).
    const owner2 = makeSelectingCtx(meta);
    installChatMessage(owner2.ctx);
    await settle(config, owner2.ctx);
    expect(owner2.calls.select).toBe(0); // no re-presentation after release

    const log2 = await readAudit(stageTmp);
    // Sanity: the fixture actually exercised both interlock channels.
    expect(log2).toContain("confirm_gate_suppressed_child ");
    expect(log2).toContain("confirm_gate_escalation_armed ");
    expect(log2).toContain("confirm_gate_owner_reprompt ");
    // Interlock ①: exactly ONE confirm_gate_deferred skip exists (produced by
    // the pre-approve consume while the stamp was still armed) — the NEXT
    // consume did not repeat it.
    expect((log2.match(/reason=confirm_gate_deferred/g) ?? []).length).toBe(1);
    // Interlock ②: the stale plan entry was cleaned by the existing discard
    // channel (not re-dispatched for the develop visit).
    expect(log2).toContain("pending_spawn_discarded");
    expect(log2).toContain("stale_stage_mismatch");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("chain B: no owner turn — one-shot wake delivered; replaying the wake text re-presents the gate (never ordinary chat)", async () => {
    const stageTmp = join(tmpdir(), "pi-211-flow-b-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");
    await createVerifyMd(
      stageTmp,
      `---\nrequiredFiles:\n  - "docs/design/77_Config_Plan.md"\n---\nVerify plan.`,
    );

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 1000,
      pipelineId: `pipe-211-flow-b-${Date.now()}`,
    });

    // Owner wake channel: shared bus (child broadcasts, owner listens).
    const { pi: busPi } = makeMockPi();
    const followUps: string[] = [];
    const wakeAudits: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const deps: OwnerEscalationDeps = {
      getMeta: () => meta,
      sendFollowUp: (summary) => {
        followUps.push(summary);
        return true;
      },
      syncStatusBar: () => {},
      audit: (event, payload) => { wakeAudits.push({ event, payload }); },
    };
    setOwnerEscalationDeps(deps);
    escalationCleanup = registerOwnerEscalationObserver(busPi);

    // Step 1: child suppression → arm → broadcast → owner wake.
    const childCtx = createMockCtx(meta, {
      sessionHeader: { parentSession: "/tmp/owner.jsonl" },
      sessionFile: "/tmp/child.jsonl",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pi: busPi as any,
    });
    await settle(config, childCtx);

    // 203-style assertions: EXACTLY one wake, with the pending-gate summary.
    expect(followUps.length === 1).toBe(true);
    expect(followUps[0].startsWith("Pipeline notice: ")).toBe(true);
    expect(wakeAudits.some((a) => a.event === "owner_wake_escalation")).toBe(true);

    // Step 2: the owner replies to the wake — the wake text itself becomes
    // the owner's last user message (the wake is NOT a pipeline-turn trigger,
    // so this must land in the Phase 0 re-presentation entry, not ordinary
    // chat and not the pipeline verify path).
    const owner = makeSelectingCtx(meta);
    installChatMessage(owner.ctx, followUps[0]);
    await settle(config, owner.ctx);

    // Mutual exclusivity (Phase 0): presented gate ≠ ordinary chat audit.
    const log = await readAudit(stageTmp);
    expect(log).not.toContain("agent_settled_non_pipeline_turn");
    // The gate WAS re-presented on the owner side, exactly once.
    expect(log).toContain("confirm_gate_owner_reprompt ");
    expect((log.match(/confirm_gate_owner_reprompt /g) ?? []).length).toBe(1);
    expect(owner.calls.select).toBe(1); // closing the loop: Approve released it
    expect(meta.currentStage).toBe("develop");
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    // Review #1 rewrite: no verify machinery ran for the wake replay turn —
    // assert on the tail AFTER the reprompt line (the child's own pipeline
    // turn precedes it and is out of scope for this chain).
    const idxReprompt = log.indexOf("confirm_gate_owner_reprompt ");
    const tail = log.slice(idxReprompt);
    expect(tail).not.toMatch(/auto_verify/);
    expect(tail).not.toContain("verify_rule_deferred");

    await rm(stageTmp, { recursive: true, force: true });
  });
});
