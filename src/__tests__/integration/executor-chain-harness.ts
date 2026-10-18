/**
 * 194 Phase 4 (tasks 1/2): shared continuous-chain harness for the
 * design-review → plan update → R2 → develop-handoff → executor tools →
 * trusted terminal → owner consumption integration files.
 *
 * The harness runs the REAL production chain end to end:
 * - REAL files (plan / report / receipt / develop artifact / verify files);
 * - REAL session adapter (`createSessionState` with the shared meta.json
 *   store under a temp projectRoot — child sessions read the SAME store the
 *   way a JOINed child session does in production);
 * - REAL `agent_settled` hook driving the coordinator (the only user input
 *   is the scripted TUI menu pick, mirroring `design-review-loop.test.ts`);
 * - REAL tool entries (`pipeline_verify`, `stage_advance`) for both child
 *   and owner calls — the C5 gate, declaration registration and bound
 *   consumption commits all run for real;
 * - REAL child-side binding through the production
 *   `recordChildBindingFromRuntimeEvidence` (the function the session
 *   starter calls after a JOIN);
 * - the ONLY mock is the RPC boundary: a fake event bus that answers
 *   `subagents:rpc:spawn` with verifiable full ids, delivers lifecycle
 *   terminal events, and a registry probe (`Symbol.for
 *   ("pi-subagents:manager")`) that proves the executor session file —
 *   exactly the runtime evidence the C3 identity checks demand.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DesignReviewState,
  PipelineConfig,
  SessionMeta,
  SpawnOperationContext,
  StageExecutorRun,
} from "../../types";
import { createSessionState, __resetSharedStateDir } from "../../core/session-state";
import { createAgentSettled } from "../../core/agent-settled";
import { deriveReportPath } from "../../core/design-review/state";
import { handleDesignReviewOperationTerminal } from "../../core/design-review/coordinator";
import { setDesignReviewTerminalHandler } from "../../utils/subagent-rpc";
import { markSubagentsReady, __resetSubagentsReady } from "../../utils/subagent-availability";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import {
  recordChildBindingFromRuntimeEvidence,
  type BindingEntryLike,
} from "../../core/stage-executor/runtime-binding";
import {
  makeTestConfig,
  makeTestMeta,
  reviewReportContent,
  writeStandaloneUpdateDeliverables,
  deployDispatchAssets,
} from "../helpers";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export interface ChainHarnessOptions {
  /** Omit dispatch assets so the production preflight blocks (task 2 case). */
  skipDispatchAssets?: boolean;
  /** Scripted menu answer; defaults to the first `Auto Review Plan` pick. */
  menuChoice?: string | undefined;
}

export interface ChainHarness {
  projectRoot: string;
  reqDoc: string;
  planDoc: string;
  ownerFile: string;
  childFile: string;
  devArtifact: string;
  config: PipelineConfig;
  session: ReturnType<typeof createSessionState>;
  /**
   * 200 Bug Phase 5: the owner-side pi mock (event bus + sendUserMessage),
   * exposed so regression tests can wire the PRODUCTION lifecycle listeners
   * exactly as index.ts does at composition time.
   */
  ownerPi: unknown;
  ownerEntries: unknown[];
  childEntries: BindingEntryLike[];
  wakeMessages: string[];
  rpcCount(): number;
  lastPrompt(): string;
  /** Full agent ids returned by the fake bus, in dispatch order. */
  spawnIds(): string[];
  /** Current persisted meta (shared-first read, like every production entry). */
  meta(): SessionMeta;
  state(): DesignReviewState | undefined;
  run(): StageExecutorRun | undefined;
  /** One real `agent_settled` hook run (optional scripted branch user message). */
  settle(userMessage?: string): Promise<void>;
  /** Flush the fake bus's deferred replies / async watcher tails. */
  flush(): Promise<void>;
  /**
   * Emit a REAL lifecycle terminal on the shared bus (the fake RPC boundary):
   * the payload id correlates exactly like `watchSubagentLifecycle` demands.
   * Defaults to the most recent spawn id.
   */
  emitTerminal(event: "completed" | "failed", agentId?: string): void;
  /** Write the report for the CURRENT round from the identity the state bound. */
  writeReport(verdict: "PASS" | "FAIL", issues?: string[]): void;
  /** Revise the plan + standalone receipt exactly as the update prompt requires. */
  writePlanUpdate(): { receiptDoc: string };
  /** Produce the develop-stage deliverable the develop verify file requires. */
  writeDevelopArtifact(): void;
  /**
   * Record the CHILD-side binding through the production function with real
   * runtime evidence (parentSession header + own session file + registry).
   */
  bindChildToCurrentRun(): { recorded: boolean; reason?: string };
  /** ctx for a child-session tool entry (bound develop executor). */
  childToolCtx(): unknown;
  /** ctx for an owner-session tool entry. */
  ownerToolCtx(): unknown;
  /** Drive the real chain to finished + trusted develop executor run. */
  driveToDevelopHandoff(): Promise<void>;
  cleanup(): void;
}

export function makeChainHarness(opts?: ChainHarnessOptions): ChainHarness {
  const projectRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-exec-chain-"));
  const prevManager = (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  fs.mkdirSync(path.join(projectRoot, "docs", "design"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "agents"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "verify"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".pi", "audit"), { recursive: true });

  const reqDoc = path.join(projectRoot, "docs", "design", "191_Feat.md");
  const planDoc = path.join(projectRoot, "docs", "design", "191_Feat_Plan.md");
  fs.writeFileSync(reqDoc, "# Requirements\ncontent\n", "utf-8");
  fs.writeFileSync(planDoc, "# Plan\ninitial design\n", "utf-8");

  const ownerFile = path.join(projectRoot, "owner.jsonl");
  const childFile = path.join(projectRoot, "develop-executor.jsonl");
  const devArtifact = path.join(projectRoot, "docs", "design", "191_Feat_dev.md");

  const config = makeTestConfig({ projectRoot }) as PipelineConfig;
  for (const [stage, agent] of [
    ["design-review", "design-review-agent"],
    ["plan", "plan-agent"],
    ["develop", "develop-agent"],
  ] as const) {
    const agentRel = `agents/${agent}.md`;
    fs.writeFileSync(path.join(projectRoot, agentRel), `---\nname: ${agent}\n---\nbody\n`, "utf-8");
    config.stages[stage] = { ...config.stages[stage], agentPath: agentRel };
  }
  config.stages["design-review"] = {
    ...config.stages["design-review"]!,
    verify: { require: true },
  };
  const planVerifyFile = path.join(projectRoot, "verify", "plan-verify.md");
  fs.writeFileSync(
    planVerifyFile,
    "---\nrules:\n  requiredFiles:\n    - \"docs/design/191_Feat_Plan.md\"\n---\nplan gate\n",
    "utf-8",
  );
  config.stages["plan"] = {
    ...config.stages["plan"]!,
    verify: { require: true, verifyFile: planVerifyFile },
    confirm: { mode: "manual" },
  };
  // develop keeps its REAL next stage (the plan forbids hiding consumption
  // behind a null terminal) and runs in TOOL mode: the owner consumes the
  // trusted terminal through the real `pipeline_verify` entry.
  const developVerifyFile = path.join(projectRoot, "verify", "develop-verify.md");
  fs.writeFileSync(
    developVerifyFile,
    "---\nrules:\n  requiredFiles:\n    - \"docs/design/191_Feat_dev.md\"\n---\ndevelop gate\n",
    "utf-8",
  );
  config.stages["develop"] = {
    ...config.stages["develop"]!,
    nextStage: "review",
    verify: { require: true, mode: "tool", verifyFile: developVerifyFile },
  };
  if (!opts?.skipDispatchAssets) {
    deployDispatchAssets(config);
  }
  void initAuditLog(config);

  // The composition root registers exactly this handler (index.ts:114).
  setDesignReviewTerminalHandler(handleDesignReviewOperationTerminal);
  markSubagentsReady();

  // ── fake RPC bus (the ONLY mock) ─────────────────────────────────────────
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const ownerEntries: unknown[] = [];
  const rpcPrompts: string[] = [];
  const spawnIds: string[] = [];
  const wakeMessages: string[] = [];
  let rpcCount = 0;
  let nextId = 0;
  // Lifecycle-aware registry: production records move out of the live set
  // when the run ends, so report consumption is never deferred forever.
  const agentRecords = new Map<string, { status: string; sessionFile: string }>();
  const ownerPi = {
    appendEntry: (customType: string, data: unknown) => {
      ownerEntries.push({ type: "custom", customType, data });
    },
    events: {
      emit: (event: string, payload: Record<string, unknown>) => {
        if (event === "subagents:rpc:spawn") {
          rpcCount++;
          const id = `agent-chain-${++nextId}`;
          spawnIds.push(id);
          agentRecords.set(id, { status: "running", sessionFile: childFile });
          rpcPrompts.push(String(payload.prompt ?? ""));
          setTimeout(() => {
            for (const h of handlers.get(`subagents:rpc:spawn:reply:${payload.requestId}`) ?? []) {
              h({ success: true, data: { id } });
            }
          }, 0);
          return;
        }
        for (const h of handlers.get(event) ?? []) h(payload);
      },
      on: (event: string, h: (p: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), h]);
      },
      off: (event: string, h: (p: unknown) => void) => {
        handlers.set(event, (handlers.get(event) ?? []).filter((x) => x !== h));
      },
    },
    sendUserMessage: (m: string) => {
      wakeMessages.push(m);
    },
  };
  // Registry probe: the executor session file is PROVEN, exactly like the
  // runtime registry evidence C3 requires (one unique record per id).
  (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = {
    getRecord: (id: string) => agentRecords.get(id),
    listRecords: () => spawnIds.map((id) => ({ id, ...agentRecords.get(id) })),
  };

  const ownerAdapterCtx = {
    sessionManager: { getEntries: () => ownerEntries, getBranch: () => ownerEntries },
  };
  const session = createSessionState(ownerPi as never, ownerAdapterCtx as never, {
    projectRoot,
    auditDir: ".pi/audit",
  });

  session.updateMeta(
    makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/191_Feat.md",
      pipelineId: "pipe-exec-chain",
      loopCycleCount: 0,
    }) as SessionMeta,
  );

  let branchUserMessage = "docs/design/191_Feat.md 1 答";
  const menuCalls: { options: string[]; chosen?: string }[] = [];
  const ownerHookManager = {
    getEntries: () => ownerEntries,
    getBranch: () => [
      ...ownerEntries,
      { type: "message", message: { role: "user", content: branchUserMessage } },
    ],
    getSessionFile: () => ownerFile,
    getSessionName: () => "owner",
    getHeader: () => undefined,
  };
  const hookCtx = {
    session,
    pi: ownerPi,
    ui: {
      notify: () => {},
      setStatus: () => {},
      select: async (titleOrOpts: unknown, maybeOptions?: unknown) => {
        const options = Array.isArray(maybeOptions)
          ? (maybeOptions as string[])
          : Array.isArray(titleOrOpts)
            ? (titleOrOpts as string[])
            : [];
        const call: { options: string[]; chosen?: string } = { options };
        if (menuCalls.length === 0) {
          call.chosen = opts?.menuChoice !== undefined ? opts.menuChoice : "Auto Review Plan";
        }
        menuCalls.push(call);
        return call.chosen;
      },
      confirm: async () => false,
    },
    _ctx: { sessionManager: ownerHookManager },
  };
  const hook = createAgentSettled(config);

  // ── child session (the bound develop executor) ───────────────────────────
  const childEntries: BindingEntryLike[] = [];
  const childPi = {
    appendEntry: (customType: string, data: unknown) => {
      childEntries.push({ type: "custom", customType, data });
    },
    events: ownerPi.events, // same bus: children share the runtime channel
    sendUserMessage: (_m: string) => {},
  };
  const childManager = {
    getEntries: () => childEntries,
    getBranch: () => childEntries,
    getSessionFile: () => childFile,
    getSessionName: () => "develop-executor#a1b2c3d4",
    getHeader: () => ({ parentSession: ownerFile }),
  };
  const childSession = createSessionState(childPi as never, { sessionManager: childManager } as never, {
    projectRoot,
    auditDir: ".pi/audit",
  });

  // Async lifecycle/wake observers run through promise chains whose length
  // varies with scheduler load, so a fixed timer is a flake. Poll until the
  // observable state (run record + wake queue) repeats across two
  // consecutive ticks before declaring the chain settled.
  const flush = async (): Promise<void> => {
    let lastSnapshot = "";
    for (let tick = 0; tick < 100; tick++) {
      await new Promise((r) => setTimeout(r, 10));
      const snapshot =
        JSON.stringify(session.getMeta()?.stageExecutorRun ?? null) +
        "|" +
        wakeMessages.length;
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
    }
  };

  const harness: ChainHarness = {
    projectRoot,
    reqDoc,
    planDoc,
    ownerFile,
    childFile,
    devArtifact,
    config,
    session,
    ownerPi,
    ownerEntries,
    childEntries,
    wakeMessages,
    rpcCount: () => rpcCount,
    lastPrompt: () => rpcPrompts[rpcPrompts.length - 1] ?? "",
    spawnIds: () => [...spawnIds],
    meta: () => session.getMeta()!,
    state: () => session.getMeta()?.designReview,
    run: () => session.getMeta()?.stageExecutorRun,
    settle: async (userMessage?: string) => {
      if (userMessage !== undefined) branchUserMessage = userMessage;
      await hook.handler(hookCtx as never);
      await flush();
    },
    flush,
    emitTerminal: (event, agentId) => {
      const id = agentId ?? spawnIds[spawnIds.length - 1] ?? "";
      // The registry record leaves the live set exactly when the lifecycle
      // terminal is announced (production correlation: reply id == event id).
      agentRecords.set(id, { status: event, sessionFile: childFile });
      ownerPi.events.emit(
        event === "completed" ? "subagents:completed" : "subagents:failed",
        { id },
      );
    },
    writeReport: (verdict, issues = []) => {
      const st = harness.state();
      if (!st?.operation) throw new Error("writeReport: no current design-review operation");
      const content = reviewReportContent({
        pipelineId: harness.meta().pipelineId ?? "unknown",
        planDoc: st.planDoc,
        round: st.round,
        operationId: st.operation.operationId,
        inputHash: st.operation.inputHash ?? "",
        verdict,
        issues,
      });
      fs.writeFileSync(deriveReportPath(st.planDoc, st.round), content, "utf-8");
    },
    writePlanUpdate: () => {
      const st = harness.state();
      if (!st) throw new Error("writePlanUpdate: no design-review state");
      return writeStandaloneUpdateDeliverables({
        planDoc: harness.planDoc,
        state: st,
        pipelineId: harness.meta().pipelineId ?? "unknown",
      });
    },
    writeDevelopArtifact: () => {
      fs.writeFileSync(harness.devArtifact, "# Development result\nimplemented per plan\n", "utf-8");
    },
    bindChildToCurrentRun: () => {
      // Step 1 mirrors handleSubagentJoin's merge: the WHOLE owner snapshot is
      // copied through the child's own adapter (local meta entry + shared
      // echo), so child getMeta() resolves the shared-first source exactly
      // like a JOINed production child session does.
      childSession.updateMeta({ ...harness.meta() });
      // Step 2 is the PRODUCTION C3 composition: identity is proven from the
      // child's own runtime evidence before anything enters its entries.
      return recordChildBindingFromRuntimeEvidence({
        writer: { appendEntry: (t: string, d: unknown) => harness.childEntries.push({ type: "custom", customType: t, data: d }) },
        entries: childEntries,
        parentSession: ownerFile,
        ownSessionFile: childFile,
        currentRun: harness.run(),
      });
    },
    childToolCtx: () => ({
      session: childSession,
      pi: childPi,
      ui: { notify: () => {} },
      _ctx: { sessionManager: childManager },
    }),
    ownerToolCtx: () => ({
      session,
      pi: ownerPi,
      ui: { notify: () => {}, setStatus: () => {} },
      _ctx: { sessionManager: ownerHookManager },
    }),
    driveToDevelopHandoff: async () => {
      // Step 1: real menu authorization on the ordinary plan settle.
      await harness.settle();
      // Step 2: FAIL report + the review child's trusted terminal → routed to
      // plan with the standalone-update dispatch (settles never defer on a
      // child that already ended).
      harness.writeReport("FAIL", ["Missing error handling", "Incomplete API contract"]);
      harness.emitTerminal("completed");
      await harness.settle();
      // Step 3: revised plan + receipt + update terminal → round-2 review.
      harness.writePlanUpdate();
      harness.emitTerminal("completed");
      await harness.settle();
      // Step 4: R2 PASS + terminal → approval + develop handoff dispatch.
      harness.writeReport("PASS");
      harness.emitTerminal("completed");
      await harness.settle();
    },
    cleanup: () => {
      setDesignReviewTerminalHandler(null);
      if (prevManager === undefined) delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
      else (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = prevManager;
      __resetSubagentsReady();
      __resetAuditDirPath();
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
  return harness;
}

/**
 * SpawnOperationContext matching the CURRENT live design-review identity —
 * exactly the shape `makeOperationContext` freezes at dispatch (the only
 * difference is the runId, supplied by the caller: the current run's id for
 * duplicate-terminal drives, an old id for late/stale-event drives). Used by
 * the direct-drive recovery cases, which must invoke the production terminal
 * handler just as `watchSubagentLifecycle` would.
 */
export function operationContextFromState(
  meta: SessionMeta,
  state: DesignReviewState,
  runId: string,
): SpawnOperationContext {
  if (!state.operation) throw new Error("operationContextFromState: no current operation");
  return {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: state.authorizationId,
    round: state.round,
    kind: state.operation.kind,
    operationId: state.operation.operationId,
    stageVisitId: state.operation.stageVisitId,
    ...(state.operation.inputHash !== undefined ? { inputHash: state.operation.inputHash } : {}),
    runId,
  };
}
