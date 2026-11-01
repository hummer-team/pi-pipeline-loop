/**
 * 220 Phase 6 (INV-2/INV-3): one unattended run, end to end, at seam level.
 *
 * What is proven here:
 * - the settle transaction walks the whole stage sequence and records it in the
 *   sidecar (`docs[].lastStage`) without ever calling `recordStageVisit` itself;
 * - the three round budgets are INDEPENDENT: exhausting clarify, design-review
 *   or review↔fix never freezes another stage's budget;
 * - the four 220 stop reasons are all reachable and each one names its cause;
 * - six start stages work under both tiers (`rule` / `assisted`).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, PipelineJsonConfig, PipelineStage, SessionMeta } from "../../types";
import { RESUMABLE_STAGES } from "../../constants";
import { resolvePipelineConfig } from "../../core/json-config-loader";
import { handleAutoSettle } from "../../core/auto-pipeline/settle-seam";
import {
  runAutoClarifyRound,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "../../core/auto-pipeline/clarify-entry";
import { __resetAutoJobLockForTests, isAutoJobActive } from "../../core/auto-pipeline/config-overlay";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { isClarifyRoundBudgetExhausted, noteClarifyRoundDispatch } from "../../core/auto-pipeline/clarify-round-budget";
import {
  isDesignReviewRoundBudgetExhausted,
  noteDesignReviewDispatch,
} from "../../core/auto-pipeline/round-budget";
import { writeJobState } from "../../core/auto-pipeline/job-state";
import { startAutoJob } from "../../commands/pipeline-auto";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, type AutoHarness } from "./auto-harness";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const TEMPLATE_JSON: PipelineJsonConfig = JSON.parse(
  fs.readFileSync(path.join(SRC_ROOT, "src", "template", "pipeline_loop.json"), "utf8"),
) as PipelineJsonConfig;

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

// ─── 1. stage walk ───────────────────────────────────────────────────────────

describe("auto run — the settle transaction records the whole stage walk", () => {
  let harness: AutoHarness;
  const AUDIT: string[] = [];

  function settleCtx(meta: SessionMeta) {
    let current = { ...meta };
    return {
      session: {
        getMeta: () => current,
        updateMeta: (patch: Partial<SessionMeta>) => {
          current = { ...current, ...patch };
          return current;
        },
      },
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      _ctx: { sessionManager: { getHeader: () => ({}), getSessionName: () => "owner" } },
    };
  }

  beforeEach(async () => {
    harness = createAutoHarness();
    await harness.install();
    AUDIT.length = 0;
    __setSafeWriteAuditLogOverride(async (stage) => {
      AUDIT.push(stage);
    });
  });

  afterEach(() => {
    harness.dispose();
  });

  it("clarify → plan → design-review → develop → review → fix are each stamped", async () => {
    const meta = makeTestMeta({ currentStage: "clarify", flowState: "running", requirementDoc: DOC });
    const ctx = settleCtx(meta);
    for (const stage of ["clarify", "plan", "design-review", "develop", "review", "fix"] as PipelineStage[]) {
      meta.currentStage = stage;
      // No hard stop is judged: the human-visible pipeline keeps control.
      expect(await handleAutoSettle(ctx as never, harness.config, meta)).toBe(false);
      expect(harness.state().docs[0]?.lastStage).toBe(stage);
    }
    expect(AUDIT.some((stage) => stage.includes("stop"))).toBe(false);
  });

  it("completed closes the doc and hands over to the next one", async () => {
    const meta = makeTestMeta({ currentStage: "completed", flowState: "running", requirementDoc: DOC });
    const ctx = settleCtx(meta);

    expect(await handleAutoSettle(ctx as never, harness.config, meta)).toBe(true);

    const state = harness.state();
    expect(state.docs[0]?.status).toBe("completed");
    expect(state.status).toBe("running"); // doc b is still pending
    expect(AUDIT).toContain("pipeline_auto_chain");
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

// ─── 4. six start stages × two tiers ────────────────────────────────────────

describe("auto run — start-stage × tier smoke matrix", () => {
  const REQUIREMENT = "docs/design/200_Feat.md";
  const PLAN = "docs/design/200_Feat_Plan.md";
  const COMMIT = "docs/design/200_Feat_Develop_Commit.md";
  const REPORT = "docs/review/Code_Review_200_Feat_Develop_Commit_1.md";

  function evidence(stage: PipelineStage): Array<[string, string]> {
    const requirement: [string, string] = [REQUIREMENT, "# requirement\n"];
    switch (stage) {
      case "design-review":
        return [requirement, [PLAN, "# plan\n"]];
      case "develop":
        return [requirement, [PLAN, "# plan\n## User Confirmation\nok\n"]];
      case "review":
        return [requirement, [COMMIT, "# commit\n"]];
      case "fix":
        return [requirement, [REPORT, "## To-Fix\n- one issue\n"]];
      default:
        return [requirement];
    }
  }

  function runCase(stage: PipelineStage, tier: "rule" | "assisted", root: string): PipelineConfig {
    const jobPath = path.join(root, "docs", "jobs", "alpha.yaml");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(
      jobPath,
      [
        "version: 1",
        "enabled: true",
        `tier: ${tier}`,
        "docs:",
        "  list:",
        `    - doc: ${REQUIREMENT}`,
        `      startStage: ${stage}`,
        "chain:",
        "  newSession: false",
      ].join("\n"),
      "utf8",
    );
    if (tier === "assisted") {
      // Starting at a verifying stage needs its deployed contract file.
      const specDir = path.join(root, ".pi", "references", "design-review_spec");
      fs.mkdirSync(specDir, { recursive: true });
      fs.copyFileSync(
        path.join(SRC_ROOT, "src", "template", "references", "design-review_spec", "verify.md"),
        path.join(specDir, "verify.md"),
      );
    }
    for (const [rel, content] of evidence(stage)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
    const json: PipelineJsonConfig = { ...structuredClone(TEMPLATE_JSON), projectRoot: root };
    const jsonPath = path.join(root, ".pi", "pipeline_loop.json");
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
    const resolved = resolvePipelineConfig(json);
    // `rule` needs no verify block; `assisted` keeps ONLY the design-review one.
    for (const [name, stageConfig] of Object.entries(resolved.stages)) {
      if (stageConfig && (tier === "rule" || name !== "design-review")) {
        delete (stageConfig as { verify?: unknown }).verify;
      }
    }
    return { ...resolved, configSourcePath: jsonPath };
  }

  for (const tier of ["rule", "assisted"] as const) {
    for (const stage of RESUMABLE_STAGES) {
      it(`tier ${tier} + start ${stage} → starts at that stage`, async () => {
        const root = fs.mkdtempSync(path.join(tmpdir(), "pi-220-matrix-"));
        __resetAutoJobLockForTests();
        __resetFinalizeStateForTests();
        __setSafeWriteAuditLogOverride(async () => {});
        try {
          let meta: SessionMeta | undefined;
          const ctx = {
            session: {
              getMeta: () => meta,
              updateMeta: (patch: Partial<SessionMeta>) => {
                meta = { ...(meta ?? ({} as SessionMeta)), ...patch } as SessionMeta;
                return meta;
              },
            },
            ui: { notify: () => {}, select: async () => undefined },
            pi: { sendUserMessage: () => {} },
          };
          const result = await startAutoJob({ config: runCase(stage, tier, root), ctx: ctx as never, jobId: "alpha" });
          expect(result.success).toBe(true);
          expect(meta?.currentStage).toBe(stage);
          expect(isAutoJobActive()).toBe(true);
        } finally {
          __resetAutoJobLockForTests();
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});

// ─── 5. invariants that are visible in the source ───────────────────────────

describe("auto run — INV-2 / INV-3 source guards", () => {
  const AUTO_DIR = path.join(SRC_ROOT, "src", "core", "auto-pipeline");

  function moduleSources(): Array<{ file: string; source: string }> {
    return fs
      .readdirSync(AUTO_DIR)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => ({ file, source: fs.readFileSync(path.join(AUTO_DIR, file), "utf8") }));
  }

  it("the auto layer never starts or advances a pipeline itself", () => {
    const offenders = moduleSources()
      .filter(({ source }) => source.includes("startNewPipeline(") || source.includes("advanceStage("))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("recordStageVisit is only WRAPPED (stop-policy), never called elsewhere", () => {
    const callers = moduleSources()
      .filter(({ source }) => source.includes("recordStageVisit("))
      .map(({ file }) => file);
    expect(callers).toEqual(["stop-policy.ts"]);
  });

  it("FlowState keeps its three members (no new state was introduced)", () => {
    const types = fs.readFileSync(path.join(SRC_ROOT, "src", "types.ts"), "utf8");
    const match = /export type FlowState = ([^;]+);/.exec(types);
    expect(match?.[1]).toBe('"running" | "blocked" | "aborted"');
  });
});
