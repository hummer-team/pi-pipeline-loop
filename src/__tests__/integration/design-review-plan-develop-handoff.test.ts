/**
 * 194 Phase 4 (task 1): continuous E2E chain integration for the
 * plan-revision loop → develop handoff → executor tools → trusted terminal →
 * owner consumption.
 *
 * Everything below runs the REAL production chain (see the header of
 * `executor-chain-harness.ts`): only the subagent RPC boundary is faked. The
 * assertions pin exactly what the plan demands for this chain:
 * - the per-step RPC ledger (one RPC per dispatch, replay adds nothing);
 * - the plan revision increments (round 1 FAIL → update → round 2 PASS);
 * - develop ALWAYS exits to its REAL next stage ("review" — the plan forbids
 *   hiding consumption behind a null terminal);
 * - the child's real tool entries only register declarations (rev1 → rev2,
 *   over-reach refused with ZERO writes);
 * - one trusted terminal → one owner wake; the owner's real `pipeline_verify`
 *   consumes with ONE atomic bound exit (`applied`, resultKey pinned, wake
 *   marker cleared, failure budget reset);
 * - stages WITHOUT a closed-loop run keep the legacy plain-write behavior.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SessionMeta, StageExecutorRun } from "../../types";
import { createStageAdvancer } from "../../core/stage-advancer";
import { createPipelineVerify } from "../../tools/pipeline-verify";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import {
  makeChainHarness,
  type ChainHarness,
  type ChainHarnessOptions,
} from "./executor-chain-harness";

const live: ChainHarness[] = [];

function mk(opts?: ChainHarnessOptions): ChainHarness {
  const h = makeChainHarness(opts);
  live.push(h);
  return h;
}

afterEach(() => {
  while (live.length > 0) live.pop()!.cleanup();
});

/** Run the tool `execute` and read the plain result object it returns. */
async function exec(
  tool: { execute: (args: Record<string, unknown>, ctx?: any) => Promise<unknown> },
  args: Record<string, unknown>,
  ctx: any,
): Promise<Record<string, any>> {
  return (await tool.execute(args, ctx)) as Record<string, any>;
}

describe("194 Phase 4: plan revision → develop handoff → trusted terminal → owner consumption", () => {
  test("continuous chain drives menu → FAIL → update → R2 PASS → handoff with the exact RPC ledger and one live run", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();

    // Per-step RPC ledger: review R1, update, review R2, develop handoff —
    // exactly one RPC per dispatch, nothing extra anywhere on the chain.
    expect(h.rpcCount()).toBe(4);
    expect(h.spawnIds()).toEqual(["agent-chain-1", "agent-chain-2", "agent-chain-3", "agent-chain-4"]);

    const meta = h.meta();
    expect(meta.currentStage).toBe("develop");

    // Plan revision increments across the loop: R1 FAIL → update receipt → R2.
    const st = h.state()!;
    expect(st.round).toBe(2);
    expect(st.phase).toBe("finished");
    expect(st.operation?.kind).toBe("develop-handoff");
    expect(st.operation?.dispatchEvidence).toBe("trusted_id");

    // The develop exit is the REAL configured stage — never a hidden null.
    expect(h.config.stages["develop"]!.nextStage).toBe("review");

    // One live run, bound to the LAST trusted dispatch (the develop executor).
    const run = h.run()!;
    expect(run.binding.stage).toBe("develop");
    expect(run.binding.agentId).toBe("agent-chain-4");
    expect(run.binding.operationId).toBe(st.operation!.operationId);
    expect(run.status).toBe("running");
    expect(run.recovery).toBe("none");
    expect(run.terminalConsumed).toBe(false);
    expect(run.pendingWakeId).toBeUndefined();

    // Replay settles after finish: zero extra RPC / menu (193 ledger kept).
    await h.settle();
    await h.settle();
    expect(h.rpcCount()).toBe(4);
    expect(h.meta().stageExecutorRun).toEqual(run);
  });

  test("bound child registers declarations through the REAL tools (rev1 → rev2) and every over-reach is refused with zero writes", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();

    const bound = h.bindChildToCurrentRun();
    expect(bound.recorded).toBe(true);

    const verifyTool = createPipelineVerify(h.config);
    const advanceTool = createStageAdvancer(h.config);
    const childCtx = h.childToolCtx();

    // Rev 1: a plain child `pipeline_verify` only DECLARES (no verification).
    const wakesBefore = h.wakeMessages.length; // intermediate auto-settle wakes
    const d1 = await exec(verifyTool, {}, childCtx);
    expect(d1.action).toBe("declared-for-owner");
    expect(d1.declarationRevision).toBe(1);
    expect(h.run()!.declaration?.revision).toBe(1);
    expect(h.run()!.declaration?.verificationRequested).toBe(true);
    // Zero side effects: stage untouched, no new wake for a declaration.
    expect(h.meta().currentStage).toBe("develop");
    expect(h.meta().verifyAttempts ?? 0).toBe(0);
    expect(h.wakeMessages.length).toBe(wakesBefore);

    // Byte-identical echo: the same request never re-writes or re-bumps
    // (the echo answer repeats the stored revision through the run itself).
    const before = canonicalRun(h.run()!);
    const d1b = await exec(verifyTool, {}, childCtx);
    expect(d1b.action).toBe("declared-for-owner");
    expect(d1b.declarationRevision).toBeUndefined(); // echo branch, no change
    expect(h.run()!.declaration?.revision).toBe(1);
    expect(canonicalRun(h.run()!)).toBe(before);

    // Over-reach: verify-file / stage overrides and skipVerify are refused
    // BEFORE any flow, with the run left exactly as persisted.
    const rejFile = await exec(verifyTool, { verifyFile: "verify/other.md" }, childCtx);
    expect(rejFile.action).toBe("declaration_rejected");
    expect(rejFile.reason).toBe("verify_file_override");
    expect(canonicalRun(h.run()!)).toBe(before);

    const rejAdvance = await exec(advanceTool, { skipVerify: true }, childCtx);
    expect(rejAdvance.action).toBe("declaration_rejected");
    expect(rejAdvance.reason).toBe("advance_skip_verify");
    expect(canonicalRun(h.run()!)).toBe(before);

    // Handoff is plugin-owned: a child call performs nothing.
    const handoffTool = createPipelineHandoff(h.config);
    const ho = await exec(handoffTool, {}, childCtx);
    expect(ho.action).toBe("caller_refused");
    expect(ho.reason).toBe("handoff_is_plugin_owned");
    expect(canonicalRun(h.run()!)).toBe(before);

    // Rev 2: a REAL stage_advance intent bumps the declaration once.
    const d2 = await exec(advanceTool, { nextStage: "review" }, childCtx);
    expect(d2.action).toBe("declared-for-owner");
    expect(d2.declarationRevision).toBe(2);
    expect(h.run()!.declaration?.revision).toBe(2);
    expect(h.run()!.declaration?.nextStage).toBe("review");
    // Still zero advancement: the owner alone consumes.
    expect(h.meta().currentStage).toBe("develop");
    expect(h.run()!.terminalConsumed).toBe(false);
  });

  test("one trusted terminal wakes the owner once; owner pipeline_verify consumes with ONE atomic bound exit", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();
    const bound = h.bindChildToCurrentRun();
    expect(bound.recorded).toBe(true);

    const verifyTool = createPipelineVerify(h.config);
    const advanceTool = createStageAdvancer(h.config);
    const childCtx = h.childToolCtx();
    await exec(verifyTool, {}, childCtx); // declaration rev1
    await exec(advanceTool, { nextStage: "review" }, childCtx); // rev2
    h.writeDevelopArtifact();

    const runId = h.run()!.binding.runId;
    const wakesBefore = h.wakeMessages.length;

    // Trusted terminal for THIS dispatch (correlated by the real reply id).
    h.emitTerminal("completed");
    await h.flush();

    const armed = h.run()!;
    expect(armed.status).toBe("completed");
    expect(armed.terminalConsumed).toBe(false);
    expect(armed.consumption?.state).toBe("awaiting-owner-tool");
    expect(armed.pendingWakeId).toBeDefined();
    expect(h.wakeMessages.length - wakesBefore).toBe(1);

    // The owner's real tool entry drives the one-commit consumption.
    const ownerRes = await exec(verifyTool, {}, h.ownerToolCtx());
    expect(ownerRes.passed).toBe(true);

    const meta = h.meta();
    expect(meta.currentStage).toBe("review"); // develop exits to review
    expect(meta.previousStage).toBe("develop");
    expect(meta.verifyAttempts).toBe(0);

    const consumed = meta.stageExecutorRun!;
    expect(consumed.binding.runId).toBe(runId);
    expect(consumed.terminalConsumed).toBe(true);
    expect(consumed.consumption?.state).toBe("applied");
    expect(consumed.consumption?.declarationRevision).toBe(2);
    expect(consumed.consumption?.resultKey).toBe(`${runId}|2|develop->review`);
    expect(consumed.pendingWakeId).toBeUndefined(); // wake marker cleared
    expect(consumed.consecutiveFailures).toBe(0); // budget reset
    // Consumption never re-wakes: the wake ledger is unchanged by the exit.
    expect(h.wakeMessages.length - wakesBefore).toBe(1);
  });

  test("terminal without any child declaration consumes honestly with the 'none' revision anchor", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();
    h.writeDevelopArtifact();
    const runId = h.run()!.binding.runId;
    const wakesBefore = h.wakeMessages.length;

    h.emitTerminal("completed");
    await h.flush();
    expect(h.run()!.consumption?.state).toBe("awaiting-declaration");
    expect(h.wakeMessages.length - wakesBefore).toBe(1);

    const ownerRes = await exec(createPipelineVerify(h.config), {}, h.ownerToolCtx());
    expect(ownerRes.passed).toBe(true);
    const consumed = h.meta().stageExecutorRun!;
    expect(consumed.terminalConsumed).toBe(true);
    expect(consumed.consumption?.state).toBe("applied");
    expect(consumed.consumption?.resultKey).toBe(`${runId}|none|develop->review`);
    expect(h.meta().currentStage).toBe("review");
  });

  test("stages without a closed-loop run keep the legacy single plain write (ordinary path untouched)", async () => {
    const h = mk();
    // Ordinary develop work — never dispatched through the closed loop.
    h.session.updateMeta({ currentStage: "develop", previousStage: "plan" } as Partial<SessionMeta>);
    h.writeDevelopArtifact();
    expect(h.run()).toBeUndefined();

    const res = await exec(createPipelineVerify(h.config), {}, h.ownerToolCtx());
    expect(res.passed).toBe(true);
    const meta = h.meta();
    expect(meta.currentStage).toBe("review");
    expect(meta.stageExecutorRun).toBeUndefined(); // no run ever appeared
  });
});

/** Byte-comparison helper for zero-write assertions (persisted parse order). */
function canonicalRun(run: StageExecutorRun): string {
  return JSON.stringify(run);
}
