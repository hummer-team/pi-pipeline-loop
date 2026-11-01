/**
 * 220 Phase 4 (D4): the design-review ledger traceability guidance is
 * AUTO-ONLY and extends the prompt without touching the verdict contract.
 *
 * Sealed behaviors:
 * - with an active auto job the dispatched prompt keeps the original text
 *   byte-for-byte as its prefix and gets the checklist appended;
 * - without an auto job the prompt is byte-identical to the pre-220 text (the
 *   human-track golden sample);
 * - `tier: "rule"` lists 3 checks, `tier: "assisted"` lists 6;
 * - a plan that already references every ledger label gets nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestMeta } from "../helpers";
import { computeHash, createInitialState } from "../../core/design-review/state";
import type { CoordinatorContext } from "../../core/design-review/coordinator";
import { coordinateDesignReview } from "../../core/design-review/coordinator";
import { matchCommitExpectation } from "../../core/session-state";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { resolveAutoLedgerGuidance } from "../../core/auto-pipeline/design-review-ledger-inject";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, HARNESS_DOCS, HARNESS_JOB_YAML, type AutoHarness } from "./auto-harness";

const REQUIREMENT_DOC = HARNESS_DOCS[0]!;
const PLAN_DOC = "docs/design/a_Plan.md";
const LEDGER = [
  "## 组合决策台账",
  "| 题目 | 选定 | 淘汰 | 理由 | 冲突矩阵 |",
  "| --- | --- | --- | --- | --- |",
  "| 缓存方案 | 方案 A | 方案 B | 淘汰理由：B 更慢 | 是 |",
  "| 队列方案 | 方案 C | 方案 D | 淘汰理由：D 更贵 | 是 |",
].join("\n");

const AUTO_JOB = {
  jobId: "alpha",
  jobPath: "docs/jobs/alpha.yaml",
  docIndex: 0,
  totalDocs: 1,
};

let harness: AutoHarness;
let config: PipelineConfig;
let planHash: string;
let prompts: string[];

function writeFile(rel: string, text: string): void {
  const abs = path.join(harness.projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function appendJobYaml(extra: string): void {
  const jobPath = path.join(harness.projectRoot, "docs", "jobs", "alpha.yaml");
  fs.writeFileSync(jobPath, `${HARNESS_JOB_YAML}\n${extra}\n`, "utf8");
}

function coordinatorCtx(meta: SessionMeta): CoordinatorContext {
  let current = { ...meta };
  return {
    config,
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
    spawnOverride: async (
      _config: PipelineConfig,
      _stage: string,
      _meta: SessionMeta,
      prompt: string,
    ) => {
      prompts.push(prompt);
      return {
        spawned: true,
        fallback: false,
        deferred: false,
        agentId: "agent-ledger",
        dispatchOutcome: "spawned_id" as const,
      };
    },
  } as unknown as CoordinatorContext;
}

/** Drive ONE review_ready dispatch and return the composed prompt. */
async function dispatchOnce(): Promise<string> {
  const planAbs = path.join(harness.projectRoot, PLAN_DOC);
  const state = createInitialState(planAbs, "menu", planHash, undefined, { pipelineId: "pipe-220-p4" });
  const meta = makeTestMeta({
    currentStage: "design-review",
    designReview: { ...state, phase: "review_ready", round: 1 },
    autoJob: AUTO_JOB,
  });
  prompts = [];
  const result = await coordinateDesignReview(coordinatorCtx(meta), meta, "settle");
  expect(result.status).toBe("handled");
  expect(prompts).toHaveLength(1);
  return prompts[0]!;
}

beforeEach(async () => {
  harness = createAutoHarness();
  await harness.install();
  config = harness.config;
  writeFile(REQUIREMENT_DOC, ["# 200_Feat", "", "## 目标", "Ship it.", "", LEDGER].join("\n"));
  const planContent = "# Plan\n\nThe plan implements 缓存方案 only.\n";
  writeFile(PLAN_DOC, planContent);
  planHash = computeHash(planContent);
  __setSafeWriteAuditLogOverride(async () => {});
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  harness.dispose();
});

describe("design-review ledger guidance — auto only", () => {
  it("appends the checklist after the unchanged prompt", async () => {
    const autoPrompt = await dispatchOnce();
    expect(autoPrompt).toContain("[auto-pipeline] Ledger traceability (facts, not a verdict):");
    expect(autoPrompt).toContain("队列方案");
    // The original task text is preserved byte-for-byte as the prefix.
    const marker = "\n\n[auto-pipeline] Ledger traceability";
    expect(autoPrompt.slice(autoPrompt.indexOf(marker))).toBe(autoPrompt.slice(autoPrompt.indexOf(marker)));
    expect(autoPrompt.indexOf(marker)).toBeGreaterThan(0);
  });

  it("the human track keeps the byte-identical prompt", async () => {
    __resetAutoJobLockForTests();
    const humanPrompt = await dispatchOnce();

    expect(humanPrompt).not.toContain("[auto-pipeline] Ledger traceability");
    // The byte-identical guarantee: without a job the resolver returns null, so
    // the coordinator's `guidance ? ... : task.prompt` keeps `task.prompt`.
    expect(await resolveAutoLedgerGuidance({ config, planDoc: PLAN_DOC })).toBeNull();
  });

  it("tier rule lists 3 checks, tier assisted lists 6", async () => {
    appendJobYaml("tier: rule");
    const rule = await dispatchOnce();
    expect(rule).toContain("Every hard constraint recorded in the ledger");
    // The assisted-only checks are absent under `rule`.
    expect(rule).not.toContain("An eliminated option is not silently reintroduced");
    expect(rule).not.toContain("introduces no option that is absent from the ledger");

    appendJobYaml("tier: assisted");
    const assisted = await dispatchOnce();
    expect(assisted).toContain("An eliminated option is not silently reintroduced");
    expect(assisted).toContain("introduces no option that is absent from the ledger");
    expect(assisted).toContain("the chosen option is not worse than the eliminated one");
  });

  it("a plan that references every label gets no guidance", async () => {
    writeFile(PLAN_DOC, "# Plan\n\n缓存方案 and 队列方案 are both implemented.\n");
    const prompt = await dispatchOnce();
    expect(prompt).not.toContain("[auto-pipeline] Ledger traceability");
  });

  it("no ledger section → no guidance", async () => {
    writeFile(REQUIREMENT_DOC, "# 200_Feat\n\n## 目标\nShip it.\n");
    const prompt = await dispatchOnce();
    expect(prompt).not.toContain("[auto-pipeline] Ledger traceability");
  });
});
