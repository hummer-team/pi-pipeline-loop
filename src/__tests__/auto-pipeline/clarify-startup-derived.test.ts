/**
 * 223 Phase 1: the clarify STARTUP round (re-)derivation through the shared
 * decision layer.
 *
 * Sealed behaviors:
 * - four-state derivation → args/instruction (no leading space, one space in
 *   the assembled prompt) instead of the pre-223 constant `fresh(1)`;
 * - the round budget: `usedRounds >= maxRounds` → blocked; the startup
 *   seam routes it through the SAME gate handlers (`self-confirm` → exactly
 *   one forced `full-und?`);
 * - document attribution: with `docIndex` still pointing at the previous
 *   (completed) doc, deriving for the NEXT doc resolves THAT doc's sidecar
 *   entry (the docIndex is proven by the decision itself — a wrong index
 *   would derive the other doc's state);
 * - accounting attribution: fallback flags and doc failures land on the doc
 *   being started; the first doc keeps its completed state untouched;
 * - boundaries: status !== "running" / unmatched doc → `null` (human
 *   derivation) without crashing; await-answer takes its round number from
 *   the DOCUMENT's latest round, not the sidecar counter.
 */
import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "../../types";
import type { AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { buildClarifyAutoPlan, type ClarifyAutoPlan } from "../../core/auto-pipeline/clarify-autopilot";
import { runBlockedClarifyStartup } from "../../core/auto-pipeline/clarify-startup";
import { noteClarifyStartupDispatch } from "../../core/auto-pipeline/clarify-entry";
import {
  buildClarifyDocState,
  type ClarifyEntryCtx,
  type ClarifyEntryDeps,
} from "../../core/auto-pipeline/clarify-state";
import { writeJobState, readJobState } from "../../core/auto-pipeline/job-state";
import { parseAutoJob } from "../../core/auto-pipeline/job-schema";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, HARNESS_JOB_YAML, type AutoHarness } from "./auto-harness";

// ─── fixtures ────────────────────────────────────────────────────────────────

const DOC_A = HARNESS_DOCS[0]!;
const DOC_B = HARNESS_DOCS[1]!;
const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");

const MANDATORY = ["## 目标", "Ship the clarify startup seam.", "## 范围", "The clarify stage only.", "## 验收标准", "One derivation per state."];

/** A document with mandatory sections and no round heading → `fresh`. */
const FRESH_DOC = ["# 223_Bug", ...MANDATORY].join("\n");
/** Latest round without an answer marker → `await-answer`. */
const AWAIT_R3_DOC = ["# 223_Bug", ...MANDATORY, "", "# 第 3 轮澄清", "- **方案 A** self-answer"].join("\n");
/** Latest round with an answer but no confirmation → `full-und?`. */
/** Answered + declared `ready` (226 convergence) → the finalisation round is planned. */
const FULL_UND_R3_DOC = [
  "# 223_Bug",
  ...MANDATORY,
  "## 需求评估",
  "ready",
  "",
  "# 第 3 轮澄清",
  "- **方案 A** self-answer",
  "答：方案 A",
].join("\n");
/** Answer + completion marker → `confirmed`. */
const CONFIRMED_DOC = ["# 223_Bug", ...MANDATORY, "", "# 第 1 轮澄清", "- **方案 A** self-answer", "答：方案 A", "full-und? 理解确认：是", "", "## 模型确认", "是"].join("\n");

type SpawnArgs = Parameters<ClarifyEntryDeps["spawn"]>;
type SpawnResult = Awaited<ReturnType<ClarifyEntryDeps["spawn"]>>;

/** Narrow a plan to its dispatch variant or fail the test with the real kind. */
function expectDispatch(plan: ClarifyAutoPlan | null): Extract<ClarifyAutoPlan, { kind: "dispatch" }> {
  if (!plan || plan.kind !== "dispatch") {
    throw new Error(`expected a dispatch plan, got ${(plan as { kind?: string } | null)?.kind ?? "null"}`);
  }
  return plan;
}

/** Narrow a plan to its blocked variant or fail the test with the real kind. */
function expectBlocked(plan: ClarifyAutoPlan | null): Extract<ClarifyAutoPlan, { kind: "blocked" }> {
  if (!plan || plan.kind !== "blocked") {
    throw new Error(`expected a blocked plan, got ${(plan as { kind?: string } | null)?.kind ?? "null"}`);
  }
  return plan;
}

let harness: AutoHarness;
let audits: string[];
let spawnCalls: SpawnArgs[];
let freezeReasons: string[];
let deps: ClarifyEntryDeps;

function deployClarifySpec(): void {
  const target = path.join(harness.projectRoot, ".pi", "references", "clarify_spec", "verify.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"), target);
}

function writeDoc(rel: string, text: string): void {
  const abs = path.join(harness.projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function appendJobYaml(extra: string): void {
  const jobPath = path.join(harness.projectRoot, "docs", "jobs", "alpha_loop.yaml");
  fs.writeFileSync(jobPath, `${HARNESS_JOB_YAML}\n${extra}\n`, "utf8");
}

/** Persist a doc-level patch for the given doc index (the seam re-reads it). */
async function patchDoc(index: number, patch: Record<string, unknown>, setStatus?: string): Promise<void> {
  const state = harness.state();
  Object.assign(state.docs[index]!, patch);
  if (setStatus) {
    (state.docs[index]! as { status?: string }).status = setStatus;
  }
  await writeJobState(harness.projectRoot, state);
}

function makeCtx(meta: SessionMeta): ClarifyEntryCtx {
  const stub = createSessionStub(meta);
  return { session: stub.session, ui: stub.ui, pi: {} };
}

/** A startup context meta (no requirementDoc needed by these seams). */
function makeStartupMeta(): SessionMeta {
  return {
    pipelineId: "pipe-223-p1",
    currentStage: "clarify",
    flowState: "running",
  } as SessionMeta;
}

/** Re-parse the job YAML after an append — the harness `job` is the pre-edit parse. */
function readJob(): AutoJobConfig {
  const raw = fs.readFileSync(path.join(harness.projectRoot, "docs", "jobs", "alpha_loop.yaml"), "utf8");
  const parsed = parseAutoJob(raw, "docs/jobs/alpha_loop.yaml");
  if (!parsed.ok) throw new Error(`job re-parse failed: ${parsed.errors.join("; ")}`);
  return parsed.job;
}

beforeEach(async () => {
  setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
  harness = createAutoHarness();
  deployClarifySpec();
  await harness.install();
  audits = [];
  spawnCalls = [];
  freezeReasons = [];
  deps = {
    spawn: (async (...args: SpawnArgs): Promise<SpawnResult> => {
      spawnCalls.push(args);
      return { spawned: true, fallback: false };
    }) as ClarifyEntryDeps["spawn"],
    freeze: (async (...args: Parameters<ClarifyEntryDeps["freeze"]>): Promise<void> => {
      freezeReasons.push(args[2] as string);
    }) as ClarifyEntryDeps["freeze"],
  };
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  setSystemTime();
  harness.dispose();
});

describe("buildClarifyAutoPlan — four-state derivation", () => {
  it("fresh document → args '1' with NO leading space; assembled prompt is exactly 'doc 1' (one space)", async () => {
    writeDoc(DOC_A, FRESH_DOC);
    const p = expectDispatch(await buildClarifyAutoPlan(harness.config, DOC_A));

    expect(p.action).toBe("fresh");
    expect(p.args).toBe("1");
    // No leading/trailing space — the launch path adds its own separator.
    expect(p.args.trim()).toBe(p.args);
    // The assembled prompt has exactly ONE space between file and args.
    expect(`${DOC_A} ${p.args}`).toBe(`${DOC_A} 1`);
    expect(p.instruction).toContain("auto-pipeline");
    expect(p.maxRounds).toBe(harness.job.clarify.maxRounds);
  });

  it("latest round without an answer → args '{round} 答' with the DOCUMENT's round number (not the sidecar count)", async () => {
    await patchDoc(0, { clarifyRounds: 2 });
    writeDoc(DOC_A, AWAIT_R3_DOC);
    const p = expectDispatch(await buildClarifyAutoPlan(harness.config, DOC_A));

    expect(p.action).toBe("await-answer");
    expect(p.args).toBe("3 答");
  });

  it("answer without confirmation marker → full-und? + finalisation instruction names the completion marker", async () => {
    writeDoc(DOC_A, FULL_UND_R3_DOC);
    const p = expectDispatch(await buildClarifyAutoPlan(harness.config, DOC_A));

    expect(p.action).toBe("spawn-full-und");
    expect(p.args).toBe("full-und?");
    expect(p.instruction).toContain("full-und?");
    expect(p.instruction).toContain("## 模型确认");
  });

  it("completion marker on disk → kind confirmed (no spawn traffic in the plan)", async () => {
    writeDoc(DOC_A, CONFIRMED_DOC);
    const plan = await buildClarifyAutoPlan(harness.config, DOC_A);

    expect(plan!.kind).toBe("confirmed");
  });

  it("226 Phase 1: answered but NOT converged → continue plan with the self-answer instruction", async () => {
    // Answered doc WITHOUT the ready assessment — the loop keeps going.
    writeDoc(DOC_A, ["# 223_Bug", ...MANDATORY, "", "# 第 3 轮澄清", "- **方案 A** self-answer", "答：方案 A"].join("\n"));
    const p = expectDispatch(await buildClarifyAutoPlan(harness.config, DOC_A));

    expect(p.action).toBe("continue");
    expect(p.args).toBe("3 答");
    expect(p.instruction).toContain("unattended");
    // The continue round carries the SELF-ANSWER instruction, not the
    // finalisation instruction (that one owns the marker wording).
    expect(p.instruction).not.toContain("Finalise the clarification");
  });

  it("226 Phase 1: finalisation round already dispatched → marker-pending plan (no dispatch)", async () => {
    writeDoc(DOC_A, FULL_UND_R3_DOC);
    await patchDoc(0, { clarifyFinalisationRound: 3 });
    const plan = await buildClarifyAutoPlan(harness.config, DOC_A);

    expect(plan!.kind).toBe("marker-pending");
  });

  it("sidecar lacks the doc entry → null (human derivation) + clarify_startup_doc_unmatched diagnostic", async () => {
    writeDoc(DOC_A, FRESH_DOC);
    const plan = await buildClarifyAutoPlan(harness.config, "docs/design/not_in_job.md");

    expect(plan).toBeNull();
    expect(audits.some((line) => line.includes("clarify_startup_doc_unmatched"))).toBe(true);
  });

  it("status !== running → null, no crash", async () => {
    await harness.install({ status: "completed" });
    writeDoc(DOC_A, FRESH_DOC);
    const plan = await buildClarifyAutoPlan(harness.config, DOC_A);
    expect(plan).toBeNull();
  });
});

describe("223 Phase 1 — blocked startup routes through the existing gates", () => {
  it("budget exhausted with the default onExhausted=stop → freeze, never a spawn", async () => {
    await patchDoc(0, { clarifyRounds: harness.job.clarify.maxRounds });
    writeDoc(DOC_A, FRESH_DOC);

    const plan = expectBlocked(await buildClarifyAutoPlan(harness.config, DOC_A));
    expect(plan.action).toBe("budget-exhausted");

    const state = harness.state();
    const docState = (await buildClarifyDocState({
      config: harness.config, state, job: harness.job, doc: DOC_A,
      docIndex: 0, now: Date.now(),
    }))!;
    const meta = makeStartupMeta();
    const ctx = makeCtx(meta);
    const handled = await runBlockedClarifyStartup(
      ctx, harness.config, meta, state, harness.job, docState, 0, deps,
    );
    expect(handled).toBe(true);
    expect(freezeReasons).toEqual(["clarify_budget_exhausted"]);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("223 Phase 1 — document attribution through buildClarifyDocState's docIndex", () => {
  it("docIndex stuck on the completed FIRST doc: deriving for the SECOND doc reads the SECOND doc's counters", async () => {
    // Sidecar: doc 1 completed (its entry has no clarify counters), doc 2 has
    // an exhausted budget. If the derivation fell back to `state.docIndex`
    // (doc 1), it would produce a `fresh(1)` dispatch plan instead.
    await patchDoc(0, {}, "completed");
    await patchDoc(1, { clarifyRounds: harness.job.clarify.maxRounds });
    writeDoc(DOC_B, FRESH_DOC);

    const plan = await buildClarifyAutoPlan(harness.config, DOC_B);
    const p = expectBlocked(plan);
    expect(p.action).toBe("budget-exhausted");

    // Pin the hand-down directly: the docState the seam builds with the same
    // index must expose the SECOND doc's progress entry.
    const state = harness.state();
    const docState = await buildClarifyDocState({
      config: harness.config, state, job: readJob(), doc: DOC_B, docIndex: 1, now: Date.now(),
    });
    expect(docState).not.toBeNull();
    expect(docState!.progress.doc).toBe(DOC_B);
    expect(docState!.progress.clarifyRounds).toBe(harness.job.clarify.maxRounds);
  });
});

describe("223 Phase 1 — startup accounting attribution (blocked docIndex pass-down)", () => {
  it("budget exhausted on the SECOND doc + self-confirm → the doc failure/fallback land on doc 2; doc 1 stays completed", async () => {
    appendJobYaml("clarify:\n  onExhausted: self-confirm");
    await patchDoc(0, {}, "completed");
    await patchDoc(1, { clarifyRounds: harness.job.clarify.maxRounds });
    writeDoc(DOC_B, FRESH_DOC);

    const state = harness.state();
    const job = readJob();
    const docState = (await buildClarifyDocState({
      config: harness.config, state, job, doc: DOC_B, docIndex: 1, now: Date.now(),
    }))!;
    expect(docState.decision.action).toBe("budget-exhausted");

    const meta = makeStartupMeta();
    const ctx = makeCtx(meta);
    const handled = await runBlockedClarifyStartup(
      ctx, harness.config, meta, state, job, docState, 1, deps,
    );
    expect(handled).toBe(true);

    // Exactly ONE forced full-und? dispatch through the normal spawn seam.
    expect(spawnCalls).toHaveLength(1);
    const opts = spawnCalls[0]![4] as { extraArgs?: string };
    expect(opts.extraArgs?.includes("full-und?")).toBe(true);

    // The fallback flag is on doc 2; doc 1 keeps its completed state untouched.
    const after = harness.state()!;
    const doc2 = after.docs[1]!;
    expect(doc2.clarifyFallbackUsed).toBe(true);
    const doc1 = after.docs[0]!;
    expect(doc1.clarifyFallbackUsed).toBeUndefined();
    expect((doc1 as { status?: string }).status).toBe("completed");

    // The fallback audit carries the doc-2 decision round.
    const fallback = audits.find((line) => line.includes("clarify_fallback"));
    expect(fallback).toBeDefined();
    expect(fallback).toContain("budget_exhausted_forced_full_und");
  });

  it("noteClarifyStartupDispatch with the hand-down docIndex charges the doc being started", async () => {
    // docIndex still at 0 (doc 1 completed); the STARTUP round belongs to doc 2.
    await patchDoc(0, {}, "completed");
    writeDoc(DOC_B, FRESH_DOC);

    await noteClarifyStartupDispatch({
      config: harness.config, doc: DOC_B, docIndex: 1, round: 1, now: 1_000,
    });

    const state = harness.state()!;
    expect(state.docs[1]!.clarifyLastRound).toBe(1);
    expect(state.docs[1]!.clarifyRounds).toBe(1);
    expect(state.docs[0]!.clarifyRounds).toBeUndefined();
    expect(state.docs[0]!.clarifyLastRound).toBeUndefined();

    // The startup dispatch audit is emitted.
    expect(audits.some((line) => line.includes("clarify_dispatch") && line.includes("clarify_startup_round"))).toBe(true);
  });
});
