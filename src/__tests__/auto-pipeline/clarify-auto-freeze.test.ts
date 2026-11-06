/**
 * 220 Phase 3 (D2): the clarify freeze paths and the impossible idle state.
 *
 * Sealed behaviors:
 * - a stalled document (no growth, same signature) freezes with
 *   `clarify_stalled` once the limit is reached;
 * - a requirement that keeps assessing as `needs-clarify` freezes with
 *   `clarify_requirement_unclear`;
 * - an exhausted round budget freezes with `clarify_budget_exhausted` under
 *   `onExhausted: "stop"`, and forces exactly ONE `full-und?` round under
 *   `"self-confirm"` (recorded as `clarifyFallbackUsed`);
 * - an auto job never idles in `awaiting_human`: one settle freezes it with
 *   `awaiting_human_in_auto` (the stage is a FROZEN state, so the gate runs
 *   before the frozen short-circuit);
 * - the human track (no `meta.autoJob`) never reaches either seam.
 *
 * Side effects are injected (`ClarifyEntryDeps`); the `awaiting_human` seam is
 * asserted through the REAL settle hook so its position is pinned as well.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "../../types";
import {
  runAutoClarifyRound,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "../../core/auto-pipeline/clarify-entry";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { writeJobState } from "../../core/auto-pipeline/job-state";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, HARNESS_JOB_YAML, type AutoHarness } from "./auto-harness";

// ─── fixtures ────────────────────────────────────────────────────────────────

const DOC = HARNESS_DOCS[0]!;
const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");
const MANDATORY = ["## 目标", "Ship the clarify freeze seam.", "## 范围", "The clarify stage only.", "## 验收标准", "A stall freezes once."];
const FRESH_DOC = ["# 200_Feat", ...MANDATORY].join("\n");

type SpawnArgs = Parameters<ClarifyEntryDeps["spawn"]>;
type SpawnResult = Awaited<ReturnType<ClarifyEntryDeps["spawn"]>>;
type FreezeArgs = Parameters<ClarifyEntryDeps["freeze"]>;

let harness: AutoHarness;
let audits: string[];
let freezeReasons: string[];
let spawnCalls: SpawnArgs[];
let deps: ClarifyEntryDeps;

function deployClarifySpec(): void {
  const target = path.join(harness.projectRoot, ".pi", "references", "clarify_spec", "verify.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"), target);
}

function writeDoc(text: string): void {
  const abs = path.join(harness.projectRoot, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function appendJobYaml(extra: string): void {
  const jobPath = path.join(harness.projectRoot, "docs", "jobs", "alpha_loop.yaml");
  fs.writeFileSync(jobPath, `${HARNESS_JOB_YAML}\n${extra}\n`, "utf8");
}

function makeMeta(): SessionMeta {
  return {
    pipelineId: "pipe-220-p3-freeze",
    currentStage: "clarify",
    flowState: "running",
    requirementDoc: DOC,
  } as SessionMeta;
}

function makeCtx(meta: SessionMeta): ClarifyEntryCtx {
  const stub = createSessionStub(meta);
  return { session: stub.session, ui: stub.ui, pi: {} };
}

/** Persist one doc-level counter mutation (the seam re-reads the sidecar). */
async function patchDoc(patch: Record<string, unknown>): Promise<void> {
  const state = harness.state();
  Object.assign(state.docs[0]!, patch);
  await writeJobState(harness.projectRoot, state);
}

beforeEach(async () => {
  harness = createAutoHarness();
  deployClarifySpec();
  await harness.install();
  writeDoc(FRESH_DOC);
  audits = [];
  freezeReasons = [];
  spawnCalls = [];
  deps = {
    spawn: (async (...args: SpawnArgs): Promise<SpawnResult> => {
      spawnCalls.push(args);
      return { spawned: true, fallback: false };
    }) as ClarifyEntryDeps["spawn"],
    freeze: (async (...args: FreezeArgs): Promise<void> => {
      freezeReasons.push(args[2]);
    }) as ClarifyEntryDeps["freeze"],
  };
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  harness.dispose();
});

describe("runAutoClarifyRound — freeze paths", () => {
  it("stall limit reached → clarify_stalled", async () => {
    await patchDoc({ clarifyStalls: 3 });
    const meta = makeMeta();

    expect(await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps)).toBe("consumed");
    expect(freezeReasons).toEqual(["clarify_stalled"]);
  });

  it("needs-clarify streak reached → clarify_requirement_unclear", async () => {
    await patchDoc({ clarifyNeedsClarifyStreak: 2 });
    const meta = makeMeta();

    expect(await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps)).toBe("consumed");
    expect(freezeReasons).toEqual(["clarify_requirement_unclear"]);
  });

  it("round budget exhausted with onExhausted=stop → clarify_budget_exhausted", async () => {
    await patchDoc({ clarifyRounds: harness.job.clarify.maxRounds });
    const meta = makeMeta();

    expect(await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps)).toBe("consumed");
    expect(freezeReasons).toEqual(["clarify_budget_exhausted"]);
  });

  it("round budget exhausted with onExhausted=self-confirm → one forced full-und? round", async () => {
    appendJobYaml("clarify:\n  onExhausted: self-confirm");
    await patchDoc({ clarifyRounds: harness.job.clarify.maxRounds });
    const meta = makeMeta();

    expect(await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps)).toBe("consumed");

    expect(freezeReasons).toEqual([]);
    expect(spawnCalls).toHaveLength(1);
    const opts = spawnCalls[0]![4] as { extraArgs?: string };
    expect(opts.extraArgs?.startsWith(" full-und?")).toBe(true);
    expect(opts.extraArgs).toContain("completion marker");
    expect(harness.state().docs[0]!.clarifyFallbackUsed).toBe(true);
    expect(audits.some((line) => line.includes("clarify_fallback"))).toBe(true);
  });

  it("a second self-confirm exhaustion fails the document instead of looping", async () => {
    appendJobYaml("clarify:\n  onExhausted: self-confirm");
    await patchDoc({ clarifyRounds: harness.job.clarify.maxRounds, clarifyFallbackUsed: true });
    const meta = makeMeta();

    // The unified failure transaction finalizes the doc and releases the job.
    await runAutoClarifyRound(makeCtx(meta), harness.config, meta, deps);

    expect(freezeReasons).toEqual([]);
    expect(spawnCalls).toHaveLength(0);
    expect(harness.state().status).not.toBe("running");
  });
});

describe("agent_settled — awaiting_human seam", () => {
  const AUTO_JOB_META = {
    jobId: "alpha_loop",
    jobPath: "docs/jobs/alpha_loop.yaml",
    docIndex: 0,
    totalDocs: 1,
    designReviewMaxRounds: 3,
    designReviewRounds: 0,
    lastCountedDesignReviewRound: 0,
    totalLoopsBudget: 5,
  };

  it("an auto job freezes awaiting_human inside ONE settle", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      flowState: "running",
      autoJob: AUTO_JOB_META,
    });
    const ctx = createMockCtx(meta);

    await createAgentSettled(config).handler(ctx as never);

    const after = ctx.session.getMeta() as SessionMeta;
    expect(after.blockedReason).toBe("awaiting_human_in_auto");
  });

  it("the human track never freezes with the auto-only reason", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "awaiting_human", flowState: "running" });
    const ctx = createMockCtx(meta);

    await createAgentSettled(config).handler(ctx as never);

    const after = ctx.session.getMeta() as SessionMeta;
    expect(after.blockedReason).not.toBe("awaiting_human_in_auto");
  });
});
