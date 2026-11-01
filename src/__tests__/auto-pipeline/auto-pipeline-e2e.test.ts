/**
 * 220 Phase 6 (INV-2/INV-3): one unattended run, end to end, at seam level.
 *
 * What is proven here:
 * - ONE real chain driven by document evidence (not by hand-written stage
 *   values): clarify self-answer → `full-und?` → marker → plan → design-review
 *   (with the ledger traceability guidance) → develop → review → fix →
 *   completed, each step audited on the single auto-decision channel;
 * - the three round budgets are INDEPENDENT: exhausting clarify, design-review
 *   or review↔fix never freezes another stage's budget;
 * - the four 220 stop reasons are all reachable and each one names its cause.
 *
 * The 6 start stages × 2 tiers matrix lives in `auto-start-stage-matrix.test.ts`
 * (it drives the command entry, not the settle seam) to keep this file within
 * the 400-line test budget.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, setSystemTime } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineStage, SessionMeta } from "../../types";
import { handleAutoSettle } from "../../core/auto-pipeline/settle-seam";
import {
  runAutoClarifyRound,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "../../core/auto-pipeline/clarify-entry";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { isClarifyRoundBudgetExhausted, noteClarifyRoundDispatch } from "../../core/auto-pipeline/clarify-round-budget";
import {
  isDesignReviewRoundBudgetExhausted,
  noteDesignReviewDispatch,
} from "../../core/auto-pipeline/round-budget";
import { writeJobState } from "../../core/auto-pipeline/job-state";
import { resolveAutoLedgerGuidance } from "../../core/auto-pipeline/design-review-ledger-inject";
import { derivePlanDocPath } from "../../core/auto-pipeline/start-stage-evidence";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, type AutoHarness } from "./auto-harness";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");

const DOC = HARNESS_DOCS[0]!;
const MANDATORY = ["## 目标", "Ship it.", "## 范围", "Clarify only.", "## 验收标准", "One round."];
const FRESH_DOC = ["# 200_Feat", ...MANDATORY].join("\n");

let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
});

// ─── 1. one real chain ──────────────────────────────────────────────────────

const PLAN_DOC = derivePlanDocPath(DOC);
const PLAN_TEXT = ["# 200_Feat_Plan", "", "## 方案", "存储选型：方案 B（按台账执行）", ""].join("\n");
const LEDGER = [
  "## 组合决策台账",
  "",
  "| 决策项 | 结论 | 淘汰理由 |",
  "|---|---|---|",
  "| 存储选型 | 方案 B | 淘汰方案 A：写入延迟 |",
  "| 日志方案 | 方案 C | 淘汰方案 D：成本 |",
].join("\n");

describe("auto run — one unattended chain from clarify to completed", () => {
  let harness: AutoHarness;
  let audits: string[];
  let dispatches: Array<{ extraArgs?: string }>;
  let deps: ClarifyEntryDeps;
  let docAbs: string;

  /**
   * Mutable session whose patches land on the meta the test advances.
   *
   * INV-2: `stage-advancer` stays the ONLY advancement authority, so the auto
   * layer never advances by itself. This suite stands in for the pipeline
   * (the plan's 替身 wording): `advance()` is what the real advancer would do
   * after the preceding stage verified.
   */
  function makeSession(initial: SessionMeta) {
    let current = initial;
    const session = {
      getMeta: () => current,
      updateMeta: (patch: Partial<SessionMeta>): SessionMeta => {
        current = { ...current, ...patch };
        return current;
      },
    };
    return {
      ctx: {
        session,
        ui: { notify: () => {} },
        pi: { sendUserMessage: () => {} },
        _ctx: { sessionManager: { getHeader: () => ({}), getSessionName: () => "owner" } },
      },
      meta: (): SessionMeta => current,
      advance: (stage: PipelineStage): SessionMeta => {
        current = { ...current, currentStage: stage };
        return current;
      },
    };
  }

  /** Move the clock past the 30s dedupe window (one settle burst is over). */
  function nextBurst(seconds: number): void {
    setSystemTime(new Date(Date.UTC(2026, 10, 1, 0, 0, seconds)));
  }

  beforeEach(async () => {
    harness = createAutoHarness();
    // The real clarify contract, so the round derivation is the production one.
    const specDir = path.join(harness.projectRoot, ".pi", "references", "clarify_spec");
    fs.mkdirSync(specDir, { recursive: true });
    fs.copyFileSync(
      path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"),
      path.join(specDir, "verify.md"),
    );
    await harness.install();
    __resetFinalizeStateForTests();
    docAbs = path.join(harness.projectRoot, DOC);
    audits = [];
    dispatches = [];
    deps = {
      spawn: (async (...args: unknown[]): Promise<{ spawned: boolean; fallback: boolean }> => {
        dispatches.push(args[4] as { extraArgs?: string });
        return { spawned: true, fallback: false };
      }) as unknown as ClarifyEntryDeps["spawn"],
      freeze: (async (): Promise<void> => {
        throw new Error("freeze must not be reached in the happy chain");
      }) as ClarifyEntryDeps["freeze"],
    };
    __setSafeWriteAuditLogOverride(async (stage, message) => {
      audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
    });
    nextBurst(0);
  });

  afterEach(() => {
    __resetFinalizeStateForTests();
    setSystemTime();
    harness.dispose();
  });

  it("clarify self-answer → full-und? → marker → plan → design-review → develop → review → fix → completed", async () => {
    fs.mkdirSync(path.dirname(docAbs), { recursive: true });
    fs.writeFileSync(docAbs, FRESH_DOC, "utf8");
    const h = makeSession(makeTestMeta({ currentStage: "clarify", flowState: "running", requirementDoc: DOC }));

    // clarify 1/3: a fresh document dispatches the first round (" 1").
    expect(await runAutoClarifyRound(h.ctx, harness.config, h.meta(), deps)).toBe(true);
    expect(dispatches[0]?.extraArgs?.startsWith(" 1")).toBe(true);

    // clarify 2/3: the self-answered round requests the finalisation (" full-und?").
    fs.appendFileSync(docAbs, "\n# 第 1 轮澄清\n- **方案 A** self-answer\n答：方案 A\n", "utf8");
    nextBurst(31);
    expect(await runAutoClarifyRound(h.ctx, harness.config, h.meta(), deps)).toBe(true);
    expect(dispatches[1]?.extraArgs?.startsWith(" full-und?")).toBe(true);

    // clarify 3/3: the marker ends clarify without a third dispatch and refunds
    // the per-doc counters; the decision is audited.
    fs.appendFileSync(docAbs, `\nfull-und? 理解确认：是\n\n## 模型确认\n是\n\n${LEDGER}\n`, "utf8");
    nextBurst(62);
    expect(await runAutoClarifyRound(h.ctx, harness.config, h.meta(), deps)).toBe(false);
    expect(dispatches).toHaveLength(2);
    expect(audits.some((line) => line.includes('"gate":"clarify_confirmed"'))).toBe(true);

    // The plan deliverable the next stages consume.
    const planAbs = path.join(harness.projectRoot, PLAN_DOC);
    fs.mkdirSync(path.dirname(planAbs), { recursive: true });
    fs.writeFileSync(planAbs, PLAN_TEXT, "utf8");

    // design-review 回指: the requirement ledger reaches the review prompt, and
    // only the labels the plan never mentions are named.
    const guidance = await resolveAutoLedgerGuidance({ config: harness.config, planDoc: PLAN_DOC });
    expect(guidance ?? "").toContain("日志方案");
    expect(guidance ?? "").not.toContain("存储选型");
    expect(guidance ?? "").toContain("Checklist:");
    expect(guidance ?? "").toContain("PASS/FAIL contract is unchanged");

    // plan → design-review → develop → review → fix: each settle stamps its stage.
    for (const stage of ["plan", "design-review", "develop", "review", "fix"] as PipelineStage[]) {
      expect(await handleAutoSettle(h.ctx as never, harness.config, h.advance(stage))).toBe(false);
      expect(harness.state().docs[0]?.lastStage).toBe(stage);
    }

    // completed: the doc closes and the chain hands the next doc over.
    expect(await handleAutoSettle(h.ctx as never, harness.config, h.advance("completed"))).toBe(true);
    const state = harness.state();
    expect(state.docs[0]?.status).toBe("completed");
    expect(state.status).toBe("running"); // the job stays alive for the chain
    expect(state.docs[1]?.status).toBe("pending"); // doc b awaits the dispatched continuation

    // Two dispatches, one confirmation and the chain handover are all on record.
    expect(audits.filter((line) => line.includes('"gate":"clarify_dispatch"'))).toHaveLength(2);
    expect(audits.some((line) => line.startsWith("pipeline_auto_chain"))).toBe(true);
  });
});

// ─── 2. budget isolation ────────────────────────────────────────────────────

describe("auto run — three independent round budgets", () => {
  it("clarify exhaustion leaves the design-review round budget usable", () => {
    const meta = makeTestMeta({
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 0,
      },
    });
    expect(isClarifyRoundBudgetExhausted(5, 5)).toBe(true);
    expect(isDesignReviewRoundBudgetExhausted(meta)).toBe(false);
    // Counting a clarify round never touches meta.autoJob.
    expect(noteClarifyRoundDispatch({ usedRounds: 4, lastRound: 4, lastDispatchedAt: 1 }, 5, 2).usedRounds).toBe(5);
    expect(meta.autoJob?.designReviewRounds).toBe(0);
  });

  it("design-review exhaustion leaves the clarify round budget usable", () => {
    const meta = makeTestMeta({
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 3,
      },
    });
    expect(isDesignReviewRoundBudgetExhausted(meta)).toBe(true);
    // Counting a design-review round only writes `meta.autoJob`.
    expect(noteDesignReviewDispatch(meta, 4)?.autoJob?.designReviewRounds).toBe(4);
    expect(isClarifyRoundBudgetExhausted(0, 5)).toBe(false);
  });

  it("clarify and design-review budgets ignore the review↔fix loop counter", () => {
    const meta = makeTestMeta({
      loopCycleCount: 99,
      maxLoopCycles: 1,
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 0,
      },
    });
    expect(isDesignReviewRoundBudgetExhausted(meta)).toBe(false);
    expect(isClarifyRoundBudgetExhausted(0, 5)).toBe(false);
  });
});

// ─── 3. the four 220 stop reasons ───────────────────────────────────────────

describe("auto run — the four clarify stop reasons", () => {
  let harness: AutoHarness;
  let freezeReasons: string[];
  let deps: ClarifyEntryDeps;

  beforeEach(async () => {
    harness = createAutoHarness();
    await harness.install();
    const abs = path.join(harness.projectRoot, DOC);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, FRESH_DOC, "utf8");
    const specDir = path.join(harness.projectRoot, ".pi", "references", "clarify_spec");
    fs.mkdirSync(specDir, { recursive: true });
    fs.copyFileSync(
      path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"),
      path.join(specDir, "verify.md"),
    );
    freezeReasons = [];
    deps = {
      spawn: (async () => ({ spawned: true, fallback: false })) as unknown as ClarifyEntryDeps["spawn"],
      freeze: (async (...args: Parameters<ClarifyEntryDeps["freeze"]>): Promise<void> => {
        freezeReasons.push(args[2]);
      }) as ClarifyEntryDeps["freeze"],
    };
  });

  afterEach(() => {
    harness.dispose();
  });

  function meta(): SessionMeta {
    return makeTestMeta({
      currentStage: "clarify",
      flowState: "running",
      requirementDoc: DOC,
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 0,
      },
    });
  }

  function ctx(metaIn: SessionMeta): ClarifyEntryCtx {
    const stub = createSessionStub(metaIn);
    return { session: stub.session, ui: stub.ui, pi: {} };
  }

  async function patchDoc(patch: Record<string, unknown>): Promise<void> {
    const state = harness.state();
    Object.assign(state.docs[0]!, patch);
    await writeJobState(harness.projectRoot, state);
  }

  it("stall → clarify_stalled", async () => {
    await patchDoc({ clarifyStalls: 3 });
    const m = meta();
    expect(await runAutoClarifyRound(ctx(m), harness.config, m, deps)).toBe(true);
    expect(freezeReasons).toEqual(["clarify_stalled"]);
  });

  it("unclear requirement → clarify_requirement_unclear", async () => {
    await patchDoc({ clarifyNeedsClarifyStreak: 2 });
    const m = meta();
    expect(await runAutoClarifyRound(ctx(m), harness.config, m, deps)).toBe(true);
    expect(freezeReasons).toEqual(["clarify_requirement_unclear"]);
  });

  it("budget exhausted → clarify_budget_exhausted", async () => {
    await patchDoc({ clarifyRounds: harness.job.clarify.maxRounds });
    const m = meta();
    expect(await runAutoClarifyRound(ctx(m), harness.config, m, deps)).toBe(true);
    expect(freezeReasons).toEqual(["clarify_budget_exhausted"]);
  });

  it("awaiting_human inside an auto job → awaiting_human_in_auto", async () => {
    const m = makeTestMeta({
      currentStage: "awaiting_human",
      flowState: "running",
      autoJob: meta().autoJob,
    });
    const ctxStub = createMockCtx(m);
    await createAgentSettled(makeTestConfig()).handler(ctxStub as never);
    expect((ctxStub.session.getMeta() as SessionMeta).blockedReason).toBe("awaiting_human_in_auto");
  });
});
