/**
 * 220 Phase 6 (D1/D3): one unattended clarify chain, end to end, with stand-ins.
 *
 * Sealed behaviors:
 * - the three forwarding states are requested in DOCUMENT order
 *   (`fresh` → `await-answer` → `full-und?`), each through the same `extraArgs`
 *   channel the human path uses;
 * - the protocol directive (D3) rides along while `## 需求评估` is missing;
 * - the confirmation marker ends the chain WITHOUT a fourth dispatch and refunds
 *   the per-doc counters;
 * - every step is audited (`pipeline_auto_decision`).
 *
 * The subagent is a stand-in (`ClarifyEntryDeps`), so no process-wide module mock
 * is involved.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, setSystemTime } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "../../types";
import {
  runAutoClarifyRound,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "../../core/auto-pipeline/clarify-entry";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, type AutoHarness } from "./auto-harness";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOC = HARNESS_DOCS[0]!;
const MANDATORY = ["## 目标", "Ship it.", "## 范围", "Clarify only.", "## 验收标准", "One round."];
const FRESH_DOC = ["# 200_Feat", ...MANDATORY].join("\n");

let harness: AutoHarness;
let audits: string[];
let spawnCalls: Array<{ extraArgs?: string }>;
let deps: ClarifyEntryDeps;
let errorSpy: ReturnType<typeof spyOn>;

function writeDoc(text: string): void {
  const abs = path.join(harness.projectRoot, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function appendDoc(text: string): void {
  fs.appendFileSync(path.join(harness.projectRoot, DOC), text, "utf8");
}

function meta(): SessionMeta {
  return {
    pipelineId: "pipe-220-p6-chain",
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
  } as SessionMeta;
}

function ctx(metaIn: SessionMeta): ClarifyEntryCtx {
  const stub = createSessionStub(metaIn);
  return { session: stub.session, ui: stub.ui, pi: {} };
}

/** Move the clock past the 30s dedupe window (one settle burst is over). */
function nextBurst(seconds: number): void {
  setSystemTime(new Date(Date.UTC(2026, 10, 1, 0, 0, seconds)));
}

beforeEach(async () => {
  harness = createAutoHarness();
  const specDir = path.join(harness.projectRoot, ".pi", "references", "clarify_spec");
  fs.mkdirSync(specDir, { recursive: true });
  fs.copyFileSync(
    path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"),
    path.join(specDir, "verify.md"),
  );
  writeDoc(FRESH_DOC);
  await harness.install();
  __resetFinalizeStateForTests();
  audits = [];
  spawnCalls = [];
  deps = {
    spawn: (async (...args: unknown[]): Promise<{ spawned: boolean; fallback: boolean }> => {
      spawnCalls.push(args[4] as { extraArgs?: string });
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
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  setSystemTime();
  harness.dispose();
});

describe("clarify chain — self answer to confirmation", () => {
  it("dispatches 1 → 1 答 → full-und? and stops at the marker", async () => {
    const m = meta();

    // 1) fresh document → the first round is dispatched with " 1".
    expect(await runAutoClarifyRound(ctx(m), harness.config, m, deps)).toBe(true);
    expect(spawnCalls[0]?.extraArgs?.startsWith(" 1")).toBe(true);
    // D3: the protocol directive rides along (no `## 需求评估` yet).
    expect(spawnCalls[0]?.extraArgs).toContain("Add a `## 需求评估`");

    // 2) the model answered the round → the answer is forwarded.
    appendDoc("\n# 第 1 轮澄清\n- **方案 A** self-answer\n");
    nextBurst(31);
    expect(await runAutoClarifyRound(ctx(m), harness.config, m, deps)).toBe(true);
    expect(spawnCalls[1]?.extraArgs?.startsWith(" 1 答")).toBe(true);

    // 3) still unanswered by the user → the finalisation round is requested.
    appendDoc("答：方案 A\n");
    nextBurst(62);
    expect(await runAutoClarifyRound(ctx(m), harness.config, m, deps)).toBe(true);
    expect(spawnCalls[2]?.extraArgs?.startsWith(" full-und?")).toBe(true);

    // 4) the marker lands → clarify is confirmed, counters are refunded.
    appendDoc("\nfull-und? 理解确认：是\n\n## 模型确认\n是\n");
    nextBurst(93);
    expect(await runAutoClarifyRound(ctx(m), harness.config, m, deps)).toBe(false);

    expect(spawnCalls).toHaveLength(3);
    expect(harness.state().docs[0]?.clarifyRounds).toBeUndefined();
    expect(harness.state().docs[0]?.clarifyStalls).toBeUndefined();
    // The whole chain is auditable: three dispatches, the protocol directive and
    // the confirmation, all on the single auto-decision channel.
    expect(audits.filter((line) => line.includes('"gate":"clarify_dispatch"'))).toHaveLength(3);
    expect(audits.some((line) => line.includes('"gate":"clarify_protocol"'))).toBe(true);
    expect(audits.some((line) => line.includes('"gate":"clarify_confirmed"'))).toBe(true);
  });
});
