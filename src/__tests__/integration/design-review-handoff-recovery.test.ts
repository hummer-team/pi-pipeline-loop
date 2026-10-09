/**
 * 194 Phase 4 (task 2): handoff recovery, duplicate/late terminals and the
 * same-visit failure budget — driven through the PRODUCTION entry points.
 *
 * The chain up to the develop handoff runs for real (see
 * `executor-chain-harness.ts`); from there each case exercises exactly one
 * recovery rule of the C3/C5 contract:
 * - before a trusted terminal the owner stays `awaiting-terminal` (zero
 *   verification, zero counting, zero wake);
 * - a failed terminal parks the owner on `awaiting-owner-recovery` — the
 *   recovery call itself mutates NOTHING (D4: recovery is an explicit owner
 *   decision, automatic advancement is withheld);
 * - a duplicate terminal of an already-terminal run is `duplicate_ignored`
 *   (never a second failure count, never a second wake, never a rewrite);
 * - a superseded run's late event is `late_ignored` (identity mismatch with
 *   zero side effects — the current record is never touched);
 * - a child whose own recorded binding belongs to an older run is refused as
 *   `child-stale` with ZERO writes;
 * - same-visit attempts inherit the failure budget and the FOURTH attempt is
 *   refused as `budget_exhausted_same_visit` (no silent infinite retries).
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SpawnOperationContext, StageExecutorRun } from "../../types";
import { createPipelineVerify } from "../../tools/pipeline-verify";
import { handleDesignReviewOperationTerminal } from "../../core/design-review/coordinator";
import type { DesignReviewTerminalEvent } from "../../utils/subagent-rpc";
import {
  applyExecutorTerminal,
  issueExecutorRunOnDispatch,
} from "../../core/stage-executor/terminal";
import {
  EXECUTOR_BINDING_ENTRY_TYPE,
  recordChildBindingFromRuntimeEvidence,
} from "../../core/stage-executor/runtime-binding";
import {
  makeChainHarness,
  operationContextFromState,
  type ChainHarness,
} from "./executor-chain-harness";

const live: ChainHarness[] = [];

function mk(): ChainHarness {
  const h = makeChainHarness();
  live.push(h);
  return h;
}

afterEach(() => {
  while (live.length > 0) live.pop()!.cleanup();
});

async function exec(
  tool: { execute: (args: Record<string, unknown>, ctx?: any) => Promise<unknown> },
  args: Record<string, unknown>,
  ctx: any,
): Promise<Record<string, any>> {
  return (await tool.execute(args, ctx)) as Record<string, any>;
}

function canonicalRun(run: StageExecutorRun): string {
  return JSON.stringify(run);
}

/** A pi handle that records ANY wake/append attempt (must stay empty). */
function forbiddenPi(calls: string[]) {
  return {
    sendUserMessage: () => calls.push("sendUserMessage"),
    appendEntry: () => calls.push("appendEntry"),
  };
}

/** The day-rotated audit text (async appends get a small settle grace). */
async function auditText(h: ChainHarness): Promise<string> {
  await new Promise((r) => setTimeout(r, 30));
  const dir = path.join(h.projectRoot, ".pi", "audit");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith("_audit.log"));
  return files.map((f) => fs.readFileSync(path.join(dir, f), "utf-8")).join("\n");
}

describe("194 Phase 4: handoff recovery and terminal identity rules", () => {
  test("before the trusted terminal the owner stays awaiting-terminal with zero side effects", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();
    h.writeDevelopArtifact();
    const wakesBefore = h.wakeMessages.length;
    const runBefore = canonicalRun(h.run()!);

    const res = await exec(createPipelineVerify(h.config), {}, h.ownerToolCtx());
    expect(res.action).toBe("awaiting-terminal");
    expect(res.pending).toBe(true);

    // NOTHING happened: no verification, no counting, no wake, no write.
    expect(canonicalRun(h.run()!)).toBe(runBefore);
    expect(h.meta().currentStage).toBe("develop");
    expect(h.meta().verifyAttempts ?? 0).toBe(0);
    expect(h.wakeMessages.length).toBe(wakesBefore);
  });

  test("a failed terminal parks the owner on awaiting-owner-recovery and the recovery call mutates nothing", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();
    const wakesBefore = h.wakeMessages.length;

    h.emitTerminal("failed");
    await h.flush();

    const run = h.run()!;
    expect(run.status).toBe("failed");
    expect(run.consecutiveFailures).toBe(1);
    expect(run.recovery).toBe("awaiting-owner");
    expect(run.consumption?.state).toBe("awaiting-declaration");
    expect(run.terminalConsumed).toBe(false);
    expect(run.pendingWakeId).toBeDefined();
    expect(h.wakeMessages.length - wakesBefore).toBe(1); // one honest wake

    const runBefore = canonicalRun(run);
    const res = await exec(createPipelineVerify(h.config), {}, h.ownerToolCtx());
    expect(res.action).toBe("awaiting-owner-recovery");
    expect(res.pending).toBe(true);
    // Recovery is an OWNER decision: the tool entry performs no mutation.
    expect(canonicalRun(h.run()!)).toBe(runBefore);
    expect(h.meta().currentStage).toBe("develop");
    expect(h.wakeMessages.length - wakesBefore).toBe(1); // no second wake
  });

  test("a duplicate terminal of an already-terminal run is duplicate_ignored — no recount, no rewrite, no wake", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();
    h.emitTerminal("failed");
    await h.flush();

    const evt: DesignReviewTerminalEvent = {
      // The SAME identity the real dispatch froze (current run id → passes
      // the fresh check and reaches the already-terminal duplicate guard).
      operationContext: operationContextFromState(h.meta(), h.state()!, h.run()!.binding.runId),
      event: "failed",
      agentId: "agent-chain-4",
    };
    const before = canonicalRun(h.run()!);
    const wakesBefore = h.wakeMessages.length;
    const forbidden: string[] = [];

    await handleDesignReviewOperationTerminal(
      forbiddenPi(forbidden) as never,
      h.config,
      h.session as never,
      evt,
    );

    expect(canonicalRun(h.run()!)).toBe(before); // zero rewrite
    expect(h.run()!.consecutiveFailures).toBe(1); // never recounted
    expect(h.wakeMessages.length).toBe(wakesBefore); // no second wake
    expect(forbidden).toEqual([]); // no forbidden side call attempted
    expect(await auditText(h)).toContain("duplicate_ignored");
  });

  test("a superseded run's late event is late_ignored — the current record stays untouched", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();
    h.emitTerminal("failed");
    await h.flush();

    const evt: DesignReviewTerminalEvent = {
      // Same operation, DIFFERENT run id — a superseded attempt's listener.
      operationContext: operationContextFromState(h.meta(), h.state()!, "run-superseded-0000"),
      event: "completed",
      agentId: "agent-chain-4",
    };
    const before = canonicalRun(h.run()!);
    const wakesBefore = h.wakeMessages.length;
    const forbidden: string[] = [];

    await handleDesignReviewOperationTerminal(
      forbiddenPi(forbidden) as never,
      h.config,
      h.session as never,
      evt,
    );

    expect(canonicalRun(h.run()!)).toBe(before);
    expect(h.wakeMessages.length).toBe(wakesBefore);
    expect(forbidden).toEqual([]);
    expect(await auditText(h)).toContain("late_event_ignored");
  });

  test("a child bound to an older run is refused as child-stale with ZERO writes", async () => {
    const h = mk();
    await h.driveToDevelopHandoff();

    // JOIN exactly like the production child session starter does (meta seed
    // + evidence-proven identity record in the child's OWN entries).
    expect(h.bindChildToCurrentRun().recorded).toBe(true);
    const current = h.run()!;

    // Simulate the child having JOINed during a SUPERSEDED attempt: the
    // child's latest identity entry belongs to an earlier run.
    h.childEntries.push({
      type: "custom",
      customType: EXECUTOR_BINDING_ENTRY_TYPE,
      data: { ...current.binding, runId: "run-previous-attempt" },
    });

    const before = canonicalRun(current);
    const res = await exec(createPipelineVerify(h.config), {}, h.childToolCtx());
    expect(res.action).toBe("caller_refused");
    expect(res.reason).toBe("stale_executor_binding");
    // Zero side effects: the owner's run is byte-identical, nothing advanced.
    expect(canonicalRun(h.run()!)).toBe(before);
    expect(h.meta().currentStage).toBe("develop");

    // Identity is frozen first-record-wins: a re-JOIN for the CURRENT run
    // refuses to refresh the child's older identity record.
    const rebound = recordChildBindingFromRuntimeEvidence({
      writer: { appendEntry: (t: string, d: unknown) => h.childEntries.push({ type: "custom", customType: t, data: d }) },
      entries: h.childEntries,
      parentSession: h.ownerFile,
      ownSessionFile: h.childFile,
      currentRun: h.run(),
    });
    expect(rebound.recorded).toBe(false);
    expect(rebound.reason).toBe("identity_frozen_by_earlier_run");
    expect(canonicalRun(h.run()!)).toBe(before);
  });

  test("same-visit attempts inherit the failure budget and the fourth attempt is refused outright", async () => {
    const h = mk();
    // Direct same-visit drives (no chain needed): three bounded failed
    // attempts, then the fourth dispatch is refused BEFORE any run is issued.
    const base = {
      pipelineId: "pipe-exec-chain",
      authorizationId: "auth-budget",
      round: 2,
      kind: "develop-handoff" as const,
      operationId: "op-budget-1",
      stageVisitId: 7,
    };
    const oc = (runId: string): SpawnOperationContext => ({ ...base, runId });
    const issue = (runId: string) =>
      issueExecutorRunOnDispatch({
        session: h.session as never,
        config: h.config,
        identity: { ownerSessionFile: h.ownerFile, agentId: "agent-chain-9", operationContext: oc(runId) },
      });
    const fail = (runId: string) =>
      applyExecutorTerminal({
        session: h.session as never,
        config: h.config,
        evt: { event: "failed", agentId: "agent-chain-9", operationContext: oc(runId) },
      });

    // Attempt 1
    expect((await issue("run-b1")).ok).toBe(true);
    expect((await fail("run-b1")).action).toBe("applied");
    expect(h.run()!.consecutiveFailures).toBe(1);
    expect(h.run()!.recovery).toBe("awaiting-owner");

    // Attempt 2 — new run, SAME visit: budget carried over, then fails again.
    const r2 = await issue("run-b2");
    expect(r2.ok).toBe(true);
    expect(r2.ok ? r2.run.consecutiveFailures : -1).toBe(1); // inherited
    expect((await fail("run-b2")).action).toBe("applied");
    expect(h.run()!.consecutiveFailures).toBe(2);

    // Attempt 3 — the third same-visit failure EXHAUSTS the budget (limit 3).
    const r3 = await issue("run-b3");
    expect(r3.ok).toBe(true);
    expect(r3.ok ? r3.run.consecutiveFailures : -1).toBe(2); // inherited
    expect((await fail("run-b3")).action).toBe("applied");
    expect(h.run()!.consecutiveFailures).toBe(3);
    expect(h.run()!.recovery).toBe("budget-exhausted");
    expect(h.meta().currentStage).toBe("plan"); // never auto-advanced (D4)

    // Attempt 4 — refused at issue time; the exhausted record stays untouched.
    const before = canonicalRun(h.run()!);
    const r4 = await issue("run-b4");
    expect(r4.ok).toBe(false);
    expect(r4.ok ? "issued" : r4.reason).toBe("budget_exhausted_same_visit");
    expect(canonicalRun(h.run()!)).toBe(before);

    // Re-reporting the exhausted attempt changes nothing (duplicate), and a
    // raw completed terminal NEVER resets the budget — only successful owner
    // verification or a legitimate new stage does (rule 6).
    expect((await fail("run-b3")).action).toBe("duplicate_ignored");
    const completed = await applyExecutorTerminal({
      session: h.session as never,
      config: h.config,
      evt: { event: "completed", agentId: "agent-chain-9", operationContext: oc("run-b3") },
    });
    expect(completed.action).toBe("duplicate_ignored");
    expect(h.run()!.recovery).toBe("budget-exhausted");
    expect(h.run()!.consecutiveFailures).toBe(3);
  });
});
