/**
 * 220 review round 2 (issues 4 + 5): every clarify dispatch is accounted and
 * dispatched through ONE channel.
 *
 * Sealed behaviors:
 * - the STARTUP round `/pipeline-start` dispatches is charged to the same
 *   per-doc budget (`maxRounds` is the TOTAL allowance, D6) — monotonic, and
 *   only for the sidecar's running document;
 * - the plugin-forced `full-und?` round of a missing completion marker goes
 *   through `dispatchClarifyRound`, so it is counted, clears the same-visit
 *   spawn guard and carries the finalisation instruction; a failed dispatch is
 *   a document failure, never a silent stop (B1).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "../../types";
import {
  noteClarifyStartupDispatch,
  runAutoClarifyRound,
  type ClarifyEntryDeps,
} from "../../core/auto-pipeline/clarify-entry";
import { isClarifyRoundBudgetExhausted } from "../../core/auto-pipeline/clarify-round-budget";
import { handleAutoClarifyMarkerMiss } from "../../core/auto-pipeline/clarify-marker-miss";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { __resetFinalizeStateForTests } from "../../core/auto-pipeline/finalize";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, HARNESS_JOB_YAML, type AutoHarness } from "./auto-harness";

const DOC = HARNESS_DOCS[0]!;
/** A fresh document: mandatory sections only, no round headings, no marker. */
const FRESH_DOC = ["# 200_Feat", "## 目标", "Ship it.", "## 范围", "Clarify only.", "## 验收标准", "One round."].join("\n");

type SpawnArgs = Parameters<ClarifyEntryDeps["spawn"]>;
type SpawnResult = Awaited<ReturnType<ClarifyEntryDeps["spawn"]>>;

let harness: AutoHarness;
let audits: string[];
let spawnCalls: SpawnArgs[];
let freezeReasons: string[];
let deps: ClarifyEntryDeps;

/** Append job YAML (the sidecar's job bytes hash is not re-checked on read). */
function appendJobYaml(extra: string): void {
  fs.writeFileSync(path.join(harness.projectRoot, "docs", "jobs", "alpha_loop.yaml"), `${HARNESS_JOB_YAML}\n${extra}\n`, "utf8");
}

function writeDoc(text = FRESH_DOC): void {
  const abs = path.join(harness.projectRoot, DOC);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function makeMeta(): SessionMeta {
  return {
    pipelineId: "pipe-220-r2",
    currentStage: "clarify",
    flowState: "running",
    requirementDoc: DOC,
  } as SessionMeta;
}

function makeCtx(meta: SessionMeta) {
  const stub = createSessionStub(meta);
  const ctx = {
    session: stub.session,
    ui: stub.ui,
    pi: { sendUserMessage: () => {} },
    _ctx: { sessionManager: { getHeader: () => ({}), getSessionName: () => "owner" } },
  };
  return { ctx, stub };
}

beforeEach(async () => {
  harness = createAutoHarness();
  await harness.install();
  writeDoc();
  __resetFinalizeStateForTests();
  audits = [];
  spawnCalls = [];
  freezeReasons = [];
  deps = {
    spawn: (async (...args: SpawnArgs): Promise<SpawnResult> => {
      spawnCalls.push(args);
      return { spawned: true, fallback: false };
    }) as ClarifyEntryDeps["spawn"],
    freeze: (async (...args: Parameters<ClarifyEntryDeps["freeze"]>): Promise<void> => {
      freezeReasons.push(args[2]);
    }) as ClarifyEntryDeps["freeze"],
  };
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetFinalizeStateForTests();
  __resetAutoJobLockForTests();
  harness.dispose();
});

// ─── startup round accounting (issue 4) ─────────────────────────────────────

describe("noteClarifyStartupDispatch — the startup round is charged", () => {
  it("charges round 1 and — 226 Phase 2 — a repeated stamp counts ANOTHER dispatch", async () => {
    await noteClarifyStartupDispatch({ config: harness.config, doc: DOC, round: 1, now: 1_000 });
    const first = harness.state().docs[0]!;
    expect(first.clarifyRounds).toBe(1);
    expect(first.clarifyLastRound).toBe(1);
    expect(first.clarifyDispatchedAt).toBe(1_000);

    // 226 Phase 2: every dispatch consumes budget; `lastRound` keeps the max.
    await noteClarifyStartupDispatch({ config: harness.config, doc: DOC, round: 1, now: 2_000 });
    const second = harness.state().docs[0]!;
    expect(second.clarifyRounds).toBe(2);
    expect(second.clarifyLastRound).toBe(1);
    expect(second.clarifyDispatchedAt).toBe(2_000);
  });

  it("never charges a document the sidecar is not running", async () => {
    await noteClarifyStartupDispatch({ config: harness.config, doc: "docs/design/other.md", round: 1, now: 1_000 });
    expect(harness.state().docs[0]!.clarifyRounds).toBeUndefined();
  });

  it("maxRounds=1: the startup round consumes the budget, so the first settle freezes", async () => {
    appendJobYaml("clarify:\n  maxRounds: 1");
    await noteClarifyStartupDispatch({ config: harness.config, doc: DOC, round: 1, now: 1_000 });
    const progress = harness.state().docs[0]!;
    expect(isClarifyRoundBudgetExhausted(progress.clarifyRounds ?? 0, 1)).toBe(true);

    const meta = makeMeta();
    const { ctx } = makeCtx(meta);
    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("consumed");
    expect(freezeReasons).toEqual(["clarify_budget_exhausted"]);
    expect(spawnCalls).toHaveLength(0);
  });
});

// ─── the forced finalisation round (issue 5) ────────────────────────────────

describe("handleAutoClarifyMarkerMiss — unified dispatch channel", () => {
  it("self-confirm: one counted full-und? round, guard cleared, fallback recorded", async () => {
    appendJobYaml("clarify:\n  onExhausted: self-confirm");
    // A stale same-visit clarify guard must not block the forced round; the
    // other stages' guards must survive the patch.
    const meta = { ...makeMeta(), spawnedStages: { clarify: 1, plan: 1 } } as SessionMeta;
    const { ctx, stub } = makeCtx(meta);

    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta, deps)).toBe(true);

    expect(spawnCalls).toHaveLength(1);
    const opts = spawnCalls[0]![4] as { extraArgs?: string };
    expect(opts.extraArgs?.startsWith(" full-und?")).toBe(true);
    expect(opts.extraArgs).toContain("completion marker");
    // Counted like every other round, and the same-visit guard was cleared.
    const doc = harness.state().docs[0]!;
    expect(doc.clarifyRounds).toBe(1);
    expect(doc.clarifyDispatchedAt).toBeGreaterThan(0);
    const after = stub.meta() as SessionMeta;
    expect(after.spawnedStages?.clarify).toBeUndefined();
    expect(after.spawnedStages?.plan).toBe(1);
    expect(doc.clarifyFallbackUsed).toBe(true);
    expect(audits.some((line) => line.includes("clarify_completion_marker"))).toBe(true);
  });

  it("a failed forced dispatch does NOT claim the marker failure — it resets the fallback and shares the dispatch-failure routing", async () => {
    appendJobYaml("clarify:\n  onExhausted: self-confirm");
    deps = {
      ...deps,
      spawn: (async (): Promise<SpawnResult> => ({ spawned: false, fallback: false })) as ClarifyEntryDeps["spawn"],
    };
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta, deps)).toBe(true);
    const state = harness.state();
    // 226 Phase 2 (review B-#6/#8e): nothing really launched, so
    // `clarify_marker_missing` must NOT be the reason and the one-shot
    // fallback is made available again (a forced round that never ran is
    // not "used").
    expect(state.docs[0]!.failReason).toBeUndefined();
    expect(state.docs[0]!.clarifyFallbackUsed).toBeUndefined();
    // One failed dispatch = exactly ONE stall; under the limit → freeze
    // (freeze is the retry trigger through freezePolicy).
    expect(state.docs[0]!.clarifyStalls).toBe(1);
    expect(freezeReasons).toEqual(["clarify_dispatch_failed"]);
    expect(audits.some((line) => line.includes("clarify_dispatch_failed"))).toBe(true);
    expect(audits.some((line) => line.includes("clarify_round_refund"))).toBe(true);
    expect(state.status).toBe("running");
  });

  it("onExhausted=stop fails the document without dispatching", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta, deps)).toBe(true);
    expect(spawnCalls).toHaveLength(0);
    expect(harness.state().docs[0]!.failReason).toBe("clarify_marker_missing");
  });

  it("a foreign document is left to the ordinary settle flow", async () => {
    const meta = { ...makeMeta(), requirementDoc: "docs/design/other.md" } as SessionMeta;
    const { ctx } = makeCtx(meta);

    expect(await handleAutoClarifyMarkerMiss(ctx as never, harness.config, meta, deps)).toBe(false);
    expect(spawnCalls).toHaveLength(0);
    expect(harness.state().docs[0]!.clarifyFallbackUsed).toBeUndefined();
  });
});
