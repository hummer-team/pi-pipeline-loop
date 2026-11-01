/**
 * 220 Phase 6 (INV-1): the human track is byte-identical to pre-220.
 *
 * What is proven here:
 * - The clarify settle seam is gated by `meta.autoJob` AND an ACTIVE job: a
 *   session that merely carries an `autoJob` block (no job running) produces the
 *   exact same observable trace as a plain human session — notifications, audit
 *   events and the resulting meta/stage walk.
 * - The three human clarify paths (fresh / awaiting answer / confirmed) keep
 *   their respective behavior, and the awaited-answer hint is the pre-220 text.
 * - The design-review prompt on the human track is the untouched `task.prompt`:
 *   the auto guidance is a SUFFIX only, so a session without a job never gets it.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { createAgentSettled } from "../../core/agent-settled";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { computeHash, createInitialState } from "../../core/design-review/state";
import { coordinateDesignReview, type CoordinatorContext } from "../../core/design-review/coordinator";
import { matchCommitExpectation } from "../../core/session-state";
import { resolveAutoLedgerGuidance } from "../../core/auto-pipeline/design-review-ledger-inject";
import { createAutoHarness, HARNESS_DOCS, type AutoHarness } from "./auto-harness";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOC = "docs/design/a.md";
const MANDATORY = ["## 目标", "Ship the clarify seam.", "## 范围", "Clarify only.", "## 验收标准", "One dispatch."];

/** No clarification round at all. */
const FRESH_DOC = ["# 200_Feat", ...MANDATORY].join("\n");
/** Latest round without the answer field → verification defers to the human. */
const AWAIT_DOC = ["# 200_Feat", ...MANDATORY, "", "# 第 1 轮澄清", "- **方案 A** self-answer"].join("\n");
/** Fully answered and confirmed → the stage advances. */
const CONFIRMED_DOC = [
  "# 200_Feat",
  ...MANDATORY,
  "",
  "# 第 1 轮澄清",
  "- **方案 A**",
  "答：方案 A",
  "full-und? 理解确认：是",
  "## 模型确认",
  "是",
].join("\n");

const AUTO_JOB = {
  jobId: "alpha",
  jobPath: "docs/jobs/alpha.yaml",
  docIndex: 0,
  totalDocs: 1,
  designReviewMaxRounds: 3,
  designReviewRounds: 0,
  lastCountedDesignReviewRound: 0,
};

let root: string;
let config: PipelineConfig;
let audits: string[];
let errorSpy: ReturnType<typeof spyOn>;

/** A trace of everything externally observable about one settle. */
interface SettleTrace {
  notifications: string[];
  auditStages: string[];
  stage: string | undefined;
  previousStage: string | undefined;
  stageVisitOrder: string[] | undefined;
  blockedReason: string | undefined;
}

function deployClarifySpec(): void {
  const dir = path.join(root, ".pi", "references", "clarify_spec");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(
    path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"),
    path.join(dir, "verify.md"),
  );
}

function writeDoc(text: string): void {
  const abs = path.join(root, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

async function settle(docText: string, overrides: Partial<SessionMeta> = {}): Promise<SettleTrace> {
  writeDoc(docText);
  audits = [];
  const meta = makeTestMeta({
    currentStage: "clarify",
    flowState: "running",
    requirementDoc: DOC,
    ...overrides,
  });
  const ctx = createMockCtx(meta);
  await createAgentSettled(config).handler(ctx as never);
  const after = ctx.session.getMeta() as SessionMeta;
  return {
    notifications: [...ctx.notifications],
    auditStages: [...audits],
    stage: after.currentStage,
    previousStage: after.previousStage,
    stageVisitOrder: after.stageVisitOrder,
    blockedReason: after.blockedReason,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "pi-220-invariance-"));
  deployClarifySpec();
  const base = makeTestConfig({ projectRoot: root });
  config = {
    ...base,
    // One clarify visit is enough to observe every path.
    maxLoops: 1,
    stages: {
      ...base.stages,
      clarify: { ...base.stages.clarify!, verify: { require: true } },
    },
  } as PipelineConfig;
  __resetAutoJobLockForTests();
  audits = [];
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  __setSafeWriteAuditLogOverride(async (stage) => {
    audits.push(stage);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
  __resetAutoJobLockForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("clarify settle — the three human paths are unchanged", () => {
  it("fresh: verification runs and blocks (no auto round is ever dispatched)", async () => {
    const trace = await settle(FRESH_DOC);
    expect(trace.notifications[0]).toBe('Agent settled in "clarify" stage');
    expect(trace.notifications.join("\n")).toContain("verify failed");
    expect(trace.auditStages).toContain("pipeline_blocked");
    expect(trace.auditStages.some((stage) => stage.startsWith("clarify_"))).toBe(false);
  });

  it("await-answer: the pre-220 human hint is emitted verbatim", async () => {
    const trace = await settle(AWAIT_DOC);
    expect(trace.notifications.slice(1)).toEqual([
      "Clarify round 1 is awaiting your answer. Please write your answer in the requirement " +
        "document (答：...) then re-mention @agent docs/design/a.md 1 答 " +
        "(or @agent docs/design/a.md full-und? to finalize).",
    ]);
    expect(trace.stage).toBe("clarify");
    expect(trace.auditStages).toEqual([]);
  });

  it("confirmed: the stage advances exactly as before", async () => {
    const trace = await settle(CONFIRMED_DOC);
    expect(trace.stage).toBe("plan");
    expect(trace.previousStage).toBe("clarify");
    expect(trace.stageVisitOrder).toEqual(["plan"]);
  });
});

describe("clarify settle — an INACTIVE job block changes nothing", () => {
  for (const [name, doc] of [
    ["fresh", FRESH_DOC],
    ["await-answer", AWAIT_DOC],
    ["confirmed", CONFIRMED_DOC],
  ] as const) {
    it(`${name}: trace with an unused autoJob block === trace without it`, async () => {
      const human = await settle(doc);
      // The meta block is present but no job holds the lock: this is the
      // "human session in another terminal" shape and must stay inert.
      const withJobBlock = await settle(doc, { autoJob: AUTO_JOB });

      expect(withJobBlock.notifications).toEqual(human.notifications);
      expect(withJobBlock.auditStages).toEqual(human.auditStages);
      expect(withJobBlock.stage).toBe(human.stage);
      expect(withJobBlock.previousStage).toBe(human.previousStage);
      expect(withJobBlock.stageVisitOrder).toEqual(human.stageVisitOrder);
      expect(withJobBlock.blockedReason).toBe(human.blockedReason);
    });
  }
});

describe("design-review prompt — auto guidance is a SUFFIX only", () => {
  const PLAN_DOC = "docs/design/a_Plan.md";
  const LEDGER = [
    "## 组合决策台账",
    "| 题目 | 选定 | 淘汰 | 理由 | 冲突矩阵 |",
    "| --- | --- | --- | --- | --- |",
    "| 缓存方案 | 方案 A | 方案 B | 淘汰理由：B 更慢 | 是 |",
    "| 队列方案 | 方案 C | 方案 D | 淘汰理由：D 更贵 | 是 |",
  ].join("\n");

  let harness: AutoHarness;
  let planHash: string;
  let prompts: string[];

  function writeFile(rel: string, text: string): void {
    const abs = path.join(harness.projectRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  }

  function coordinatorCtx(initial: SessionMeta): CoordinatorContext {
    let current = { ...initial };
    return {
      config: harness.config,
      session: {
        getMeta: () => current,
        updateMeta: (patch: Partial<SessionMeta>) => {
          current = { ...current, ...patch };
          return current;
        },
        updateMetaVerified: (
          patch: Partial<SessionMeta>,
          expected: Parameters<typeof matchCommitExpectation>[1],
        ) => {
          const conflict = matchCommitExpectation(current, expected);
          if (conflict) return { status: "conflict" as const, reason: conflict };
          current = { ...current, ...patch };
          return { status: "persisted" as const, meta: current };
        },
      },
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async (_config: PipelineConfig, _stage: string, _meta: SessionMeta, prompt: string) => {
        prompts.push(prompt);
        return { spawned: true, fallback: false, deferred: false, agentId: "a", dispatchOutcome: "spawned_id" as const };
      },
    } as unknown as CoordinatorContext;
  }

  /** Drive ONE `review_ready` dispatch and return the composed prompt. */
  async function dispatchOnce(auto: boolean): Promise<string> {
    const planAbs = path.join(harness.projectRoot, PLAN_DOC);
    const state = createInitialState(planAbs, "menu", planHash, undefined, { pipelineId: "pipe-220-p6" });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: { ...state, phase: "review_ready", round: 1 },
      ...(auto ? { autoJob: AUTO_JOB } : {}),
    });
    prompts = [];
    const result = await coordinateDesignReview(coordinatorCtx(meta), meta, "settle");
    expect(result.status).toBe("handled");
    expect(prompts).toHaveLength(1);
    return prompts[0]!;
  }

  beforeEach(async () => {
    harness = createAutoHarness();
    writeFile(HARNESS_DOCS[0]!, ["# 200_Feat", "", "## 目标", "Ship it.", "", LEDGER].join("\n"));
    const planContent = "# Plan\n\nImplements 缓存方案 only.\n";
    writeFile(PLAN_DOC, planContent);
    planHash = computeHash(planContent);
  });

  afterEach(() => {
    __resetAutoJobLockForTests();
    harness.dispose();
  });

  it("the human prompt is the untouched prefix of the auto prompt", async () => {
    const human = await dispatchOnce(false);
    expect(human).not.toContain("[auto-pipeline] Ledger traceability");
    // No active job ⇒ the resolver returns null, so the coordinator keeps
    // `task.prompt` as-is (the byte-identical guarantee).
    expect(await resolveAutoLedgerGuidance({ config: harness.config, planDoc: PLAN_DOC })).toBeNull();

    await harness.install();
    const auto = await dispatchOnce(true);
    // The operation id is random per dispatch; everything else must match.
    const normalize = (prompt: string): string => prompt.replace(/^Operation: .*$/m, "Operation: <id>");
    const humanPrompt = normalize(human);
    const autoPrompt = normalize(auto);
    expect(autoPrompt.startsWith(humanPrompt)).toBe(true);
    // Everything after the original prompt is the appended guidance.
    const suffix = autoPrompt.slice(humanPrompt.length);
    expect(suffix.startsWith("\n\n[auto-pipeline] Ledger traceability (facts, not a verdict):")).toBe(true);
  });
});

// ─── INV-2 / INV-3: invariants that are visible in the source ───────────────

describe("INV-2 / INV-3 — source guards", () => {
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
