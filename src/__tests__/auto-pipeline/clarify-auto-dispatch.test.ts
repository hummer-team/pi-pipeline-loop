/**
 * 220 Phase 3 (D1): the unattended clarify dispatch seam.
 *
 * Sealed behaviors:
 * - the three forwarding states dispatch the SAME literals the human path uses
 *   (`" 1"` / `" {round} 答"` / `" full-und?"`) through the existing
 *   `extraArgs` channel;
 * - the `spawnedStages` guard is cleared before each dispatch, so two settles of
 *   the same visit really dispatch twice (B1: a guard must never swallow an auto
 *   round);
 * - a dispatch that never spawned is NOT a silent stop: the stall counter grows,
 *   `clarify_dispatch_failed` is audited and the settle flow keeps running;
 * - a repeated identical round inside the 30s window coalesces (no dispatch);
 * - without an active job the module is inert.
 *
 * The two side effects are injected (`ClarifyEntryDeps`) instead of mocking a
 * module that every other seam shares.
 */
import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
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
import { createAutoHarness, createSessionStub, HARNESS_DOCS, type AutoHarness } from "./auto-harness";

// ─── fixtures ────────────────────────────────────────────────────────────────

const DOC = HARNESS_DOCS[0]!;
const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");

const MANDATORY = ["## 目标", "Ship the clarify dispatch seam.", "## 范围", "The clarify stage only.", "## 验收标准", "One dispatch per round."];

/** A document with mandatory sections and no round heading → `fresh`. */
const FRESH_DOC = ["# 200_Feat", ...MANDATORY].join("\n");
/** Latest round without an answer marker → `await-answer`. */
const AWAIT_DOC = ["# 200_Feat", ...MANDATORY, "", "# 第 1 轮澄清", "- **方案 A** self-answer"].join("\n");
/** Latest round with an answer and a declared `ready` assessment → `full-und?` (226 convergence). */
const FULL_UND_DOC = [
  "# 200_Feat",
  ...MANDATORY,
  "## 需求评估",
  "ready",
  "",
  "# 第 1 轮澄清",
  "- **方案 A** self-answer",
  "答：方案 A",
].join("\n");

type SpawnArgs = Parameters<ClarifyEntryDeps["spawn"]>;
type SpawnResult = Awaited<ReturnType<ClarifyEntryDeps["spawn"]>>;

let harness: AutoHarness;
let audits: string[];
let spawnCalls: SpawnArgs[];
let spawnResult: SpawnResult;
let deps: ClarifyEntryDeps;

/** Deploy the real clarify contract so the round derivation is the production one. */
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

function makeMeta(): SessionMeta {
  return {
    pipelineId: "pipe-220-p3",
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

function gateEvents(): string[] {
  return audits.filter((line) => line.includes("clarify_"));
}

beforeEach(async () => {
  harness = createAutoHarness();
  deployClarifySpec();
  await harness.install();
  audits = [];
  spawnCalls = [];
  spawnResult = { spawned: true, fallback: false };
  deps = {
    spawn: (async (...args: SpawnArgs): Promise<SpawnResult> => {
      spawnCalls.push(args);
      return spawnResult;
    }) as ClarifyEntryDeps["spawn"],
    freeze: (async (): Promise<void> => {
      throw new Error("freeze must not be reached in this suite");
    }) as ClarifyEntryDeps["freeze"],
  };
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
  setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  setSystemTime();
  harness.dispose();
});

describe("runAutoClarifyRound — forwarding states", () => {
  it("fresh document dispatches ' 1' (leading space, human literal)", async () => {
    writeDoc(FRESH_DOC);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("consumed");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]![2]).toBe("clarify");
    const opts = spawnCalls[0]![4] as { extraArgs?: string; description?: string };
    expect(opts.extraArgs?.startsWith(" 1")).toBe(true);
    expect(opts.description).toBe(`Clarify: ${DOC} 1`);
  });

  it("await-answer dispatches ' 1 答'", async () => {
    writeDoc(AWAIT_DOC);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("consumed");

    const opts = spawnCalls[0]![4] as { extraArgs?: string };
    expect(opts.extraArgs?.startsWith(" 1 答")).toBe(true);
  });

  it("full-und? dispatches ' full-und?'", async () => {
    writeDoc(FULL_UND_DOC);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("consumed");

    const opts = spawnCalls[0]![4] as { extraArgs?: string };
    expect(opts.extraArgs?.startsWith(" full-und?")).toBe(true);
  });

  it("clears the visit spawn guard before dispatching", async () => {
    writeDoc(FRESH_DOC);
    const meta = makeMeta();
    const { ctx, stub } = makeCtx(meta);

    await runAutoClarifyRound(ctx, harness.config, meta, deps);

    const guards = stub.patches.filter((patch) => patch.spawnedStages !== undefined);
    expect(guards).toHaveLength(1);
    expect(guards[0]!.spawnedStages?.clarify).toBeUndefined();
    expect(guards[0]!.activeSpawns?.clarify).toBeUndefined();
  });

  it("two settles of the same visit both really dispatch (guard cleared, B1)", async () => {
    writeDoc(FRESH_DOC);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("consumed");
    setSystemTime(new Date("2026-11-01T00:00:31.000Z"));
    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("consumed");

    expect(spawnCalls).toHaveLength(2);
  });

  it("a repeated identical round inside the 30s window coalesces", async () => {
    writeDoc(FULL_UND_DOC);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    await runAutoClarifyRound(ctx, harness.config, meta, deps);
    setSystemTime(new Date("2026-11-01T00:00:05.000Z"));
    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("consumed");

    expect(spawnCalls).toHaveLength(1);
    expect(audits.some((line) => line.includes('"decision":"coalesced"'))).toBe(true);
  });
});

describe("220 Phase 1: 226 Phase 1 — finalisation fact + three-state boundary", () => {
  it("clarifyFinalisationRound is read into the decision: answered doc → defer-to-marker, no dispatch", async () => {
    writeDoc(FULL_UND_DOC); // answered, not confirmed, NOT ready → looping doc
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    // Seed the sidecar fact: the finalisation round was already dispatched.
    const state = harness.state();
    state.docs[0]!.clarifyFinalisationRound = 1;
    await writeJobState(harness.projectRoot, state);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("defer-to-marker");
    expect(spawnCalls).toHaveLength(0);
    // `await-finalisation` is not a dispatch action → never coalesced.
    expect(gateEvents().some((line) => line.includes('"decision":"coalesced"'))).toBe(false);
  });

  it("resetClarifyCounters clears the finalisation fact together with the counters", async () => {
    writeDoc(`${FULL_UND_DOC}\n\n## 模型确认\nfull-und? 理解确认：是\n`);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    const state = harness.state();
    state.docs[0]!.clarifyFinalisationRound = 1;
    state.docs[0]!.clarifyRounds = 1;
    await writeJobState(harness.projectRoot, state);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("pass-through");

    const after = harness.state().docs[0]!;
    expect(after.clarifyFinalisationRound).toBeUndefined();
    expect(after.clarifyRounds).toBeUndefined();
  });
});

describe("runAutoClarifyRound — dispatch failure is visible", () => {
  it("spawned:false → NOT consumed (settle continues), stall +1 and clarify_dispatch_failed audited", async () => {
    // 226 Phase 1 mapping: a failed dispatch still hands control back to the
    // ordinary settle flow ("pass-through"); Phase 2 routes the failure
    // itself through `noteClarifyDispatchFailure` (it becomes `"consumed"`).
    writeDoc(FRESH_DOC);
    spawnResult = { spawned: false, fallback: false };
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("pass-through");

    expect(harness.state().docs[0]!.clarifyStalls).toBe(1);
    expect(gateEvents().some((line) => line.includes("clarify_dispatch_failed"))).toBe(true);
  });
});

describe("runAutoClarifyRound — gates", () => {
  it("no active job → pass-through (no dispatch)", async () => {
    writeDoc(FRESH_DOC);
    __resetAutoJobLockForTests();
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("pass-through");
    expect(spawnCalls).toHaveLength(0);
  });

  it("a non-clarify stage → inert", async () => {
    writeDoc(FRESH_DOC);
    const meta = { ...makeMeta(), currentStage: "plan" } as SessionMeta;
    const { ctx } = makeCtx(meta);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("pass-through");
    expect(spawnCalls).toHaveLength(0);
  });

  it("a confirmed document resets the counters and hands control back", async () => {
    writeDoc(`${FULL_UND_DOC}\n\n## 模型确认\nfull-und? 理解确认：是\n`);
    const meta = makeMeta();
    const { ctx } = makeCtx(meta);

    const state = harness.state();
    state.docs[0]!.clarifyRounds = 2;
    state.docs[0]!.clarifyStalls = 1;
    state.docs[0]!.clarifyNeedsClarifyStreak = 1;
    await writeJobState(harness.projectRoot, state);

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe("pass-through");

    expect(spawnCalls).toHaveLength(0);
    expect(harness.state().docs[0]!.clarifyRounds).toBeUndefined();
    expect(harness.state().docs[0]!.clarifyStalls).toBeUndefined();
  });
});
