/**
 * 226 Phase 2 — the ONE clarify dispatch-failure accounting module.
 *
 * Covered acceptance items:
 * - the fixed failure trajectory 1 → 2 → 3 (one failed dispatch = exactly ONE
 *   stall; the third stops the document with `clarify_dispatch_failed`);
 * - three-channel bookkeeping (settle / startup / resume) shares the same cap
 *   and carries a `channel` label in the `clarify_dispatch_failed` audit;
 * - `docIndex` attribution: the startup/resume channel must charge the
 *   document the failure actually belongs to (226 review B-#4 — a silent
 *   charge on `state.docIndex` is a bug);
 * - `deferred` is NOT a failure: no stall, no freeze;
 * - a throwing injected `deps.freeze` escapes (never swallowed).
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
import { noteClarifyStartupChannelFailure } from "../../core/auto-pipeline/clarify-dispatch-failure";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, deployHarnessAgents, HARNESS_DOCS, HARNESS_JOB_YAML, type AutoHarness } from "./auto-harness";

const DOC = HARNESS_DOCS[0]!;
const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");

type SpawnResult = Awaited<ReturnType<ClarifyEntryDeps["spawn"]>>;

const FRESH_DOC = ["# 200_Feat", "## 目标", "Ship the failure accounting.", "## 范围", "Dispatch failures only.", "## 验收标准", "One stall per failure."].join("\n");

/** Answered + declared `ready` → the decision is the finalisation round (`full-und?`). */
const READY_ANSWERED_DOC = [
  "# 200_Feat",
  "## 目标",
  "Ship the failure accounting.",
  "## 范围",
  "Dispatch failures only.",
  "## 验收标准",
  "One stall per failure.",
  "## 需求评估",
  "ready",
  "",
  "# 第 1 轮澄清",
  "- **方案 A** self-answer",
  "答：方案 A",
].join("\n");

let harness: AutoHarness;
let audits: string[];
let freezeReasons: string[];

function writeDoc(text: string): void {
  const abs = path.join(harness.projectRoot, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function makeMeta(): SessionMeta {
  return {
    pipelineId: "pipe-226-failure",
    currentStage: "clarify",
    flowState: "running",
    requirementDoc: DOC,
    spawnedStages: { clarify: 1 },
    activeSpawns: {},
  } as SessionMeta;
}

function makeCtx(meta: SessionMeta) {
  const stub = createSessionStub(meta);
  const ctx: ClarifyEntryCtx = { session: stub.session, ui: stub.ui, pi: {} };
  return { ctx, stub };
}

function failingDeps(spawnResult: Partial<SpawnResult> = {}): ClarifyEntryDeps {
  return {
    spawn: (async (): Promise<SpawnResult> => ({ spawned: false, fallback: false, ...spawnResult })) as ClarifyEntryDeps["spawn"],
    freeze: (async (...args: Parameters<ClarifyEntryDeps["freeze"]>): Promise<void> => {
      freezeReasons.push(args[2] as string);
    }) as ClarifyEntryDeps["freeze"],
  };
}

beforeEach(async () => {
  // Some suites (index.test.ts) leave the process-level job lock held; this
  // module-under-test suite requires a CLEAN lock, so reset defensively.
  __resetAutoJobLockForTests();
  harness = createAutoHarness();
  // Deploy the production clarify contract (the round derivation reads it).
  const specTarget = path.join(harness.projectRoot, ".pi", "references", "clarify_spec", "verify.md");
  fs.mkdirSync(path.dirname(specTarget), { recursive: true });
  fs.copyFileSync(
    path.join(SRC_ROOT, "src", "template", "references", "clarify_spec", "verify.md"),
    specTarget,
  );
  await harness.install();
  // 226 Phase 2: the freeze auto-resume loop really re-dispatches — give the
  // clarify round its configured executor so the retry is a clean spawn
  // failure of the INJECTED stub, not a config error storm.
  deployHarnessAgents(harness);
  writeDoc(FRESH_DOC);
  __resetFinalizeStateForTests();
  audits = [];
  freezeReasons = [];
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  __resetFinalizeStateForTests();
  harness.dispose();
});

describe("noteClarifyDispatchFailure — the 1→2→3 stall trajectory", () => {
  it("failed dispatches freeze on stall 1 and 2, then fail the document on stall 3", async () => {
    const meta = makeMeta();

    // Attempt 1: stall 0 → 1, under the limit → freeze (retry trigger).
    expect(await runAutoClarifyRound(makeCtx(meta).ctx, harness.config, meta, failingDeps())).toBe("consumed");
    expect(harness.state().docs[0]!.clarifyStalls).toBe(1);
    expect(freezeReasons).toEqual(["clarify_dispatch_failed"]);
    expect(harness.state().status).toBe("running");

    // Attempt 2: stall 1 → 2, still under the limit → freeze again.
    expect(await runAutoClarifyRound(makeCtx(meta).ctx, harness.config, meta, failingDeps())).toBe("consumed");
    expect(harness.state().docs[0]!.clarifyStalls).toBe(2);
    expect(harness.state().status).toBe("running");

    // Attempt 3: stall 3 = DEFAULT_CLARIFY_STALL_LIMIT → the document stops.
    expect(await runAutoClarifyRound(makeCtx(meta).ctx, harness.config, meta, failingDeps())).toBe("consumed");
    const state = harness.state();
    expect(state.docs[0]!.clarifyStalls).toBe(3);
    expect(state.docs[0]!.failReason).toBe("clarify_dispatch_failed");
    expect(state.status).toBe("failed");
  });

  it("every failure audit carries its channel; no stall observation sandbagging on failures", async () => {
    const meta = makeMeta();
    expect(await runAutoClarifyRound(makeCtx(meta).ctx, harness.config, meta, failingDeps())).toBe("consumed");

    const failedLine = audits.find((line) => line.includes("clarify_dispatch_failed"));
    expect(failedLine).toBeDefined();
    expect(failedLine).toContain('"channel":"settle"');
    // The refund of the reserved round is audited (settle-channel pair).
    expect(audits.some((line) => line.includes("clarify_round_refund"))).toBe(true);
    // The budget never grew across the failure (refunded).
    expect(harness.state().docs[0]!.clarifyRounds ?? 0).toBe(0);
    // The success-side stall observation is NEVER written by a failed dispatch.
    expect(harness.state().docs[0]!.clarifyStallSignature).toBeUndefined();
  });
});

describe("noteClarifyDispatchFailure — the deferred twin is not a failure", () => {
  it("deferred → consumed, no stall, no freeze, clarify_dispatch_deferred audited", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, failingDeps({ deferred: true }))).toBe("consumed");

    const doc = harness.state().docs[0]!;
    expect(doc.clarifyStalls ?? 0).toBe(0);
    expect(freezeReasons).toEqual([]);
    expect(audits.some((line) => line.includes("clarify_dispatch_deferred"))).toBe(true);
    expect(audits.some((line) => line.includes("clarify_dispatch_failed"))).toBe(false);
  });

  it("deferred COMMITS the round reservation (charged once, no refund row)", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, failingDeps({ deferred: true }))).toBe("consumed");

    // 226 review #2: pendingSpawns dispatches the SAME round later, so the
    // reservation is kept — the budget is a real dispatch budget and the
    // deferred round is never charged twice.
    const doc = harness.state().docs[0]!;
    expect(doc.clarifyRounds).toBe(1);
    expect(doc.clarifyLastRound).toBe(1);
    expect(doc.clarifyDispatchedAt).toBeGreaterThan(0);
    expect(audits.some((line) => line.includes("clarify_round_refund"))).toBe(false);
  });

  it("deferred finalisation round commits the marker debt (no repeated full-und? dispatch)", async () => {
    writeDoc(READY_ANSWERED_DOC);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, failingDeps({ deferred: true }))).toBe("consumed");

    // The queued round IS the finalisation round: the fact is written now so the
    // next settle defers to the marker gate instead of re-dispatching.
    const doc = harness.state().docs[0]!;
    expect(doc.clarifyRounds).toBe(1);
    expect(doc.clarifyFinalisationRound).toBe(1);
    expect(freezeReasons).toEqual([]);
  });
});

describe("noteClarifyStartupChannelFailure — docIndex attribution", () => {
  it("startup failure with an explicit docIndex charges THAT document, not the lagging state.docIndex", async () => {
    // The harness job's freezePolicy default (resume) would auto-resume the
    // freeze and start its OWN retry loop — not what this test pins. Stop at
    // the first freeze so the ONLY charge is the one under test (the job
    // template is REWRITTEN, not appended, so the YAML stays valid).
    const jobPath = path.join(harness.root, "docs", "jobs", "alpha_loop.yaml");
    fs.writeFileSync(
      jobPath,
      HARNESS_JOB_YAML.replace("  onFreeze: resume", "  onFreeze: stop-and-report"),
      "utf8",
    );
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    // The startup seam points at the SECOND sidecar doc while docIndex lags on 0.
    await harness.install(); // ensures the fresh state is on disk
    const startupMeta = { ...meta, requirementDoc: HARNESS_DOCS[1]! } as SessionMeta;
    // Injected freeze deps: the REAL freezeAndPrompt joins the decision-provider
    // chain and leaves cross-suite timers behind — this suite pins ACCOUNTING.
    expect(
      await noteClarifyStartupChannelFailure(ctx, harness.config, startupMeta, { channel: "startup", docIndex: 1 }, failingDeps()),
    ).toBe(true);

    expect(harness.state().docs[0]!.clarifyStalls ?? 0).toBe(0);
    expect(harness.state().docs[1]!.clarifyStalls).toBe(1);
    const failedLine = audits.find((line) => line.includes("clarify_dispatch_failed"));
    expect(failedLine?.includes('"channel":"startup"')).toBe(true);
  });

  it("no active job or unbound doc → false (never a silent charge), no stall written", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);
    __resetAutoJobLockForTests();
    expect(
      await noteClarifyStartupChannelFailure(ctx, harness.config, meta, { channel: "startup", docIndex: 0 }),
    ).toBe(false);
    expect(harness.state().docs[0]!.clarifyStalls ?? 0).toBe(0);
  });
});

describe("noteClarifyDispatchFailure — error propagation", () => {
  it("a throwing injected freeze escapes the module (never swallowed)", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);
    const throwingDeps: ClarifyEntryDeps = {
      spawn: (async (): Promise<SpawnResult> => ({ spawned: false, fallback: false })) as ClarifyEntryDeps["spawn"],
      freeze: (async (): Promise<void> => {
        throw new Error("freeze boom");
      }) as ClarifyEntryDeps["freeze"],
    };
    await expect(runAutoClarifyRound(ctx, harness.config, meta, throwingDeps)).rejects.toThrow("freeze boom");
  });
});
