/**
 * 216 Phase 0 (P1): the auto-advance chain TRUTHFULNESS contract.
 *
 * Breaks the `wake → settle → refused-exit → wake` self-exciting loop at its
 * root: `autoAdvanceAfterVerify` now returns a `StageAdvanceOutcome` and the
 * chain branches on the machine-readable verdict — NEVER on the assumption
 * that the transition committed. When the bound stage exit is REFUSED (a child
 * caller cannot consume the owner's run), when the recheck barrier holds, or
 * when the loop budget is exhausted, the chain must:
 *   1. report `{advanced:false, blockReason:...}` truthfully;
 *   2. write ZERO stage evidence (`stage_usage` / `stage_advance`) and emit
 *      ZERO wakes (`auto_advance_wake`) — nothing downstream may re-arm it;
 *   3. leave the persisted meta EXACTLY as it was (no partial advance).
 *
 * Every refusal audit additionally carries the entry `caller` (R2-Q2-A /
 * R6-6): explicit callers win, tool defaults to "tool", rule defaults to
 * "auto_advance" — the string "rule" is NEVER produced.
 *
 * Covers the plan matrix for `core/auto-advance-truthfulness.test.ts`
 * (cases ①–⑥ of 216_Bug_Plan Phase 0 / 216_Bug.md acceptance F1).
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyVerifyPass,
  autoAdvanceAfterVerify,
  type VerifyPassReturn,
} from "../../core/verify-advance";
import { createPipelineUI } from "../../core/pipeline-ui";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, makeStrictSession } from "../helpers";
import type {
  PipelineConfig,
  PipelineStage,
  SessionMeta,
  StageExecutorBinding,
  StageExecutorRun,
} from "../../types";

// ─── Harness ──────────────────────────────────────────────────────────────────

const AGENT = "01a11bbb-c3b4-72bc-9397-4f5b9881be41";
const OWNER_FILE = "/sessions/owner.jsonl";
const CHILD_FILE = "/sessions/child.jsonl";
const VISIT = 1_700_000_000_000;

const PASS_RESULT = {
  structuredResult: { failures: [] },
  ruleMissing: [],
  verifyResult: { structured: { passed: true }, llm: null as unknown, overallPassed: true },
};

/** A live (running) executor run bound to the CURRENT stage develop. */
function boundRun(pipelineId: string): StageExecutorRun {
  const binding: StageExecutorBinding = {
    runId: "run-216",
    pipelineId,
    ownerSessionFile: OWNER_FILE,
    stage: "develop",
    stageVisitId: VISIT,
    operationId: "op-216",
    agentId: AGENT,
    executorSessionFile: CHILD_FILE,
  };
  return {
    binding,
    status: "running",
    recovery: "none",
    consecutiveFailures: 0,
    terminalConsumed: false,
  };
}

let seq = 0;
/** Unique pipelineId per case — audit routing/throttle tables are process-global. */
const nextPid = () => `pipe-216-truth-${Date.now()}-${++seq}`;

interface Case {
  root: string;
  config: PipelineConfig;
  session: ReturnType<typeof makeStrictSession>;
  // Structural VerifyAdvanceCtx mock — `as any` is the established convention.
  ctx: any;
  wakes: string[];
}

/**
 * Fresh tmp projectRoot + initialized audit subsystem + strict-capable
 * in-memory session. `role` wires the trusted `_ctx.sessionManager` evidence
 * consumed by `detectSessionRole` at the bound-commit site:
 * - "owner": own session file == binding.ownerSessionFile, no parent header;
 * - "child": parent header + subagent name pattern + own (child) session file;
 * - "none": no session file at all (owner unprovable, non-executor cases).
 */
async function makeCase(opts: {
  label: string;
  role?: "owner" | "child" | "none";
  meta?: (pid: string) => Partial<SessionMeta>;
}): Promise<Case> {
  const root = join(tmpdir(), `pi-216-truth-${opts.label}-${Date.now()}-${seq}`);
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);
  const pid = nextPid();
  seq++;
  const meta = makeTestMeta({ pipelineId: pid, ...(opts.meta?.(pid) ?? {}) });
  const session = makeStrictSession(meta);

  const sessionManager: Record<string, unknown> = {
    getBranch: () => [],
    getEntries: () => [],
  };
  if (opts.role === "owner") {
    sessionManager.getSessionFile = () => OWNER_FILE;
    sessionManager.getSessionName = () => "owner-session";
    sessionManager.getHeader = () => undefined;
  } else if (opts.role === "child") {
    sessionManager.getSessionFile = () => CHILD_FILE;
    sessionManager.getSessionName = () => "develop-executor#a1b2c3d4";
    sessionManager.getHeader = () => ({ parentSession: OWNER_FILE });
  }

  const wakes: string[] = [];
  const ctx = {
    session,
    ui: { notify: () => {}, setStatus: () => {}, select: async () => undefined },
    pi: { sendUserMessage: (msg: string) => { wakes.push(msg); } },
    config,
    _ctx: { sessionManager },
  };
  return { root, config, session, ctx, wakes };
}

/** Concatenate EVERY audit file under the case root (pipeline AND system log). */
function readAllAudit(root: string): string {
  const base = join(root, ".pi", "audit");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, "utf-8"));
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out.join("\n");
}

/** Number of lines carrying EXACTLY this event token (`... - [LEVEL] event | ...`). */
function countEvents(content: string, event: string): number {
  const re = new RegExp(`\\] ${event} \\|`);
  return content.split("\n").filter((l) => re.test(l)).length;
}

/** Parse the LAST exact-event audit line into its `k=v` map. */
function fieldsOfLast(content: string, event: string): Record<string, string> {
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

// ─── ① child caller + bound run: the truthfulness path is effective ──────────

describe("216 P1: refused bound exit breaks the wake loop truthfully", () => {
  it("① child caller on a bound run → {advanced:false, blockReason} with zero evidence, zero wake, zero meta change", async () => {
    const c = await makeCase({
      label: "child-refused",
      role: "child",
      meta: (pid) => ({ stageExecutorRun: boundRun(pid) }),
    });

    const outcome = await autoAdvanceAfterVerify(
      c.config,
      c.ctx,
      c.session.getMeta()!,
      "develop",
      "review" as PipelineStage,
      PASS_RESULT,
      createPipelineUI(c.config),
      { caller: "auto_advance" },
    );

    // The verdict is machine-readable and exact (R6-4: bound refusals carry
    // the `bound_exit_refused:<reason>` code, never a bare message).
    expect(outcome).toEqual({
      advanced: false,
      blockReason: "bound_exit_refused:owner_unproven:child_caller",
    });

    // Nothing moved: the run stays pending for a reliable retry.
    const persisted = c.session.getMeta()!;
    expect(persisted.currentStage).toBe("develop");
    expect(persisted.previousStage).toBe("plan");
    expect(persisted.stageExecutorRun!.terminalConsumed).not.toBe(true);

    // The self-exciting loop is GONE: zero exit evidence, zero wake.
    const content = readAllAudit(c.root);
    expect(countEvents(content, "stage_usage")).toBe(0);
    expect(countEvents(content, "stage_advance")).toBe(0);
    expect(countEvents(content, "auto_advance_wake")).toBe(0);

    // Positive control: the refusal itself is audited ONCE with the entry
    // attribution added on top of the existing single truth (R2-Q2-A).
    expect(countEvents(content, "transition_commit")).toBe(1);
    const f = fieldsOfLast(content, "transition_commit");
    expect(f.action).toBe("bound_exit_refused");
    expect(f.method).toBe("rule");
    expect(f.caller).toBe("auto_advance");
    expect(f.reason).toBe("owner_unproven:child_caller");
  });

  // ─── ② budget: zero-side-effect early exit, own convergence kept ───────────

  it("② loop-budget block → {advanced:false, blockReason:'budget_exceeded'} without touching the persisted counters", async () => {
    const c = await makeCase({
      label: "budget-blocked",
      meta: () => ({
        // Counted backward edge develop→clarify at the last round:
        // loopCycleCount(1) + 1 >= effectiveMax(2) → recordStageVisit fails.
        maxLoopCycles: 2,
        loopCycleCount: 1,
        stageVisitOrder: ["clarify", "plan", "develop"],
      }),
    });

    const outcome = await autoAdvanceAfterVerify(
      c.config,
      c.ctx,
      c.session.getMeta()!,
      "develop",
      "clarify" as PipelineStage,
      PASS_RESULT,
      createPipelineUI(c.config),
      { caller: "auto_advance" },
    );

    // R6-4: the budget stall keeps its OWN convergence path (loop-breaker
    // `loop_overflow`) — it is NOT a stage-exit refusal and never counted.
    expect(outcome).toEqual({ advanced: false, blockReason: "budget_exceeded" });

    const persisted = c.session.getMeta()!;
    expect(persisted.currentStage).toBe("develop");
    // The failed visit did NOT persist its incremented counter either.
    expect(persisted.loopCycleCount).toBe(1);

    const content = readAllAudit(c.root);
    expect(countEvents(content, "stage_usage")).toBe(0);
    expect(countEvents(content, "stage_advance")).toBe(0);
    expect(countEvents(content, "auto_advance_wake")).toBe(0);
    // The loop-breaker event is not triggered by the early exit either.
    expect(countEvents(content, "loop_budget_exceeded")).toBe(0);

    // Positive control: the budget branch's own audit fired once.
    expect(countEvents(content, "auto_verify_pass_blocked_by_budget")).toBe(1);
    const f = fieldsOfLast(content, "auto_verify_pass_blocked_by_budget");
    expect(f.reason).toBe("budget_exceeded");
    expect(f.method).toBe("rule");
  });

  // ─── ④ recheck barrier: third convergence, zero side effects ───────────────

  it("④ recheck barrier → {advanced:false, blockReason:'recheck_blocked'} with zero evidence and zero meta change", async () => {
    const c = await makeCase({
      label: "recheck-blocked",
      meta: (pid) => ({
        designReviewRecheck: { pipelineId: pid, planDoc: "docs/design/216_test_plan.md" },
      }),
    });

    const outcome = await autoAdvanceAfterVerify(
      c.config,
      c.ctx,
      c.session.getMeta()!,
      "develop",
      "review" as PipelineStage,
      PASS_RESULT,
      createPipelineUI(c.config),
      { caller: "auto_advance" },
    );

    // The recheck barrier is NOT a bound-exit refusal (R6-4): own code.
    expect(outcome).toEqual({ advanced: false, blockReason: "recheck_blocked" });

    const persisted = c.session.getMeta()!;
    expect(persisted.currentStage).toBe("develop");

    const content = readAllAudit(c.root);
    expect(countEvents(content, "stage_usage")).toBe(0);
    expect(countEvents(content, "stage_advance")).toBe(0);
    expect(countEvents(content, "auto_advance_wake")).toBe(0);
    // Positive control: the 193 barrier event is untouched.
    expect(countEvents(content, "design_review_recheck_forward_release_blocked")).toBe(1);
  });

  // ─── ③ owner + bound run: the healthy path keeps working ───────────────────

  it("③ owner caller on a bound run → {advanced:true}, run consumed in one commit, exactly one stage_advance", async () => {
    const c = await makeCase({
      label: "owner-advanced",
      role: "owner",
      meta: (pid) => ({ stageExecutorRun: boundRun(pid) }),
    });

    const outcome = await autoAdvanceAfterVerify(
      c.config,
      c.ctx,
      c.session.getMeta()!,
      "develop",
      "review" as PipelineStage,
      PASS_RESULT,
      createPipelineUI(c.config),
      { caller: "auto_advance" },
    );

    expect(outcome).toEqual({ advanced: true });

    const persisted = c.session.getMeta()!;
    expect(persisted.currentStage).toBe("review");
    expect(persisted.previousStage).toBe("develop");
    expect(persisted.stageExecutorRun!.terminalConsumed).toBe(true);

    const content = readAllAudit(c.root);
    // ONE exit evidence pair only (hook path writes it via autoAdvance, never
    // doubled by applyVerifyPass): exactly one stage_advance for review.
    expect(countEvents(content, "stage_advance")).toBe(1);
    const f = fieldsOfLast(content, "stage_advance");
    expect(f.method).toBe("hook_auto_advance");
    expect(f.fromStage).toBe("develop");
    expect(f.toStage).toBe("review");
  });

  // ─── ⑤ terminal pass: returnResult:true never receives undefined ───────────

  it("⑤ terminal pass (toStage=null) → {advanced:true} with the terminal aggregate only", async () => {
    const c = await makeCase({
      label: "terminal-truth",
      meta: () => ({
        currentStage: "review",
        stageVisitOrder: ["clarify", "plan", "develop", "review"],
      }),
    });

    const outcome = await autoAdvanceAfterVerify(
      c.config,
      c.ctx,
      c.session.getMeta()!,
      "review",
      null,
      PASS_RESULT,
      createPipelineUI(c.config),
      { caller: "auto_advance" },
    );

    // R6-1: the terminal branch gives the consuming chain a REAL verdict
    // (the old code returned undefined through the returnResult:true promise).
    expect(outcome).toEqual({ advanced: true });

    const content = readAllAudit(c.root);
    expect(countEvents(content, "pipeline_completed")).toBe(1);
    expect(countEvents(content, "stage_advance")).toBe(0);
  });
});

// ─── ⑥ caller attribution matrix (R2-Q2-A / R6-6) ────────────────────────────

describe("216 P1: bound-exit refusal audits carry the entry caller, never 'rule'", () => {
  const variants = [
    { label: "tool-default", opts: { method: "tool", handleTerminal: false, returnResult: true }, caller: "tool" },
    { label: "rule-default", opts: { method: "rule", handleTerminal: false, returnResult: true }, caller: "auto_advance" },
    { label: "confirm-approve", opts: { method: "rule", handleTerminal: false, returnResult: true, caller: "confirm_approve" }, caller: "confirm_approve" },
    { label: "fix-executor-wins", opts: { method: "tool", handleTerminal: false, returnResult: true, caller: "fix_executor" }, caller: "fix_executor" },
  ] as const;

  for (const v of variants) {
    it(`⑥ ${v.label} → refusal audit caller=${v.caller}`, async () => {
      const c = await makeCase({
        label: `caller-${v.label}`,
        role: "child",
        meta: (pid) => ({ stageExecutorRun: boundRun(pid) }),
      });

      const res = (await applyVerifyPass(
        c.ctx,
        c.session.getMeta()!,
        "develop",
        "review" as PipelineStage,
        PASS_RESULT,
        v.opts as any,
      )) as VerifyPassReturn;

      // The verdict stays exact regardless of the entry attribution.
      expect(res.blockReason).toBe("bound_exit_refused:owner_unproven:child_caller");

      const f = fieldsOfLast(readAllAudit(c.root), "transition_commit");
      expect(f.action).toBe("bound_exit_refused");
      // R6-6: explicit caller wins; "rule" is NEVER produced (method rule →
      // auto_advance, method tool → tool).
      expect(f.caller).toBe(v.caller);
      expect(f.method).toBe(v.opts.method);
    });
  }
});
