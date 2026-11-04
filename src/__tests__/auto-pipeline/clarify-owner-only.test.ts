/**
 * 223 Phase 4 (223_Bug.md, "incidental finding"): the clarify auto round is
 * OWNER-ONLY.
 *
 * Background: `runAutoClarifyRound` used to rely on the round id never matching
 * a child session name (`/^\d+$/` vs `^[a-z0-9-]+#[0-9a-f]{8}$`) — an accident,
 * not a contract. A CHILD session (a subagent that happens to carry the same
 * `autoJob` meta block) could therefore consume an unattended clarify round on
 * the owner's behalf: it would spawn, charge the budget and freeze on the
 * owner's sidecar. Phase 0 made the guard explicit (`detectSessionRole(...)
 * .isChild`), and this suite pins it:
 *
 * - every child signal (SDK `parentSession`, subagent session name, fork) keeps
 *   the round inert: no spawn, no accounting, no freeze;
 * - the OWNER session with the SAME meta still dispatches, so the guard does
 *   not swallow legitimate unattended rounds (the 220 D1 contract).
 *
 * Failure is asserted through the injected `ClarifyEntryDeps`, so a regression
 * that starts spawning in a child shows up as a spawn call, not as a missing log.
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
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { createAutoHarness, createSessionStub, HARNESS_DOCS, type AutoHarness } from "./auto-harness";

const DOC = HARNESS_DOCS[0]!;
const SRC_ROOT = path.resolve(__dirname, "..", "..", "..");

const MANDATORY = ["## 目标", "Ship the owner-only guard.", "## 范围", "The clarify round only.", "## 验收标准", "Children never dispatch."];
/** A document with mandatory sections and no round heading → `fresh` (would dispatch). */
const FRESH_DOC = ["# 223_Bug", ...MANDATORY].join("\n");

type SpawnArgs = Parameters<ClarifyEntryDeps["spawn"]>;
type SpawnResult = Awaited<ReturnType<ClarifyEntryDeps["spawn"]>>;

/** Shape of the SDK session manager fields `detectSessionRole` reads. */
interface SessionManagerStub {
  getHeader?: () => Record<string, unknown> | undefined;
  getSessionName?: () => string;
  getSessionFile?: () => string;
}

let harness: AutoHarness;
let audits: string[];
let spawnCalls: SpawnArgs[];
let spawnResult: SpawnResult;
let freezeCalls: number;
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

/** Same meta for the owner and the child: only the SESSION ROLE differs. */
function makeMeta(): SessionMeta {
  return {
    pipelineId: "pipe-223-owner-only",
    currentStage: "clarify",
    flowState: "running",
    requirementDoc: DOC,
    autoJob: {
      jobId: "alpha_loop",
      jobPath: "docs/jobs/alpha_loop.yaml",
      docIndex: 0,
      totalDocs: 1,
    },
    spawnedStages: {},
    activeSpawns: {},
  } as SessionMeta;
}

/**
 * Build the entry ctx. `role` shapes ONLY the session manager fields that
 * `detectSessionRole` inspects, mirroring the three production child signals.
 */
function makeCtx(meta: SessionMeta, role: "owner" | "child-parent" | "child-name" | "child-fork") {
  const stub = createSessionStub(meta);
  const sessionManager: SessionManagerStub = { getSessionFile: () => "/tmp/session.jsonl" };
  if (role === "child-parent") {
    sessionManager.getHeader = () => ({ parentSession: "ses_owner_session_000001" });
  } else if (role === "child-name") {
    sessionManager.getSessionName = () => "clarify-round#a1b2c3d4";
  }
  const ctx: ClarifyEntryCtx & {
    _ctx?: { sessionManager: SessionManagerStub };
    event?: Record<string, unknown>;
  } = {
    session: stub.session,
    ui: stub.ui,
    pi: {},
    _ctx: { sessionManager },
  };
  if (role === "child-fork") ctx.event = { reason: "fork" };
  return { ctx, stub };
}

function gateEvents(): string[] {
  return audits.filter((line) => line.includes("clarify_"));
}

beforeEach(async () => {
  harness = createAutoHarness();
  deployClarifySpec();
  writeDoc(FRESH_DOC);
  await harness.install();
  audits = [];
  spawnCalls = [];
  freezeCalls = 0;
  spawnResult = { spawned: true, fallback: false };
  deps = {
    spawn: (async (...args: SpawnArgs): Promise<SpawnResult> => {
      spawnCalls.push(args);
      return spawnResult;
    }) as ClarifyEntryDeps["spawn"],
    freeze: (async (): Promise<void> => {
      freezeCalls++;
    }) as ClarifyEntryDeps["freeze"],
  };
  __setSafeWriteAuditLogOverride(async (stage, message) => {
    audits.push(`${stage} ${JSON.stringify(message ?? {})}`);
  });
  setSystemTime(new Date("2026-11-02T00:00:00.000Z"));
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  setSystemTime();
  harness.dispose();
});

describe("runAutoClarifyRound — child sessions are inert", () => {
  it("owner session with the same meta DOES dispatch (control)", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta, "owner");

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(gateEvents().some((line) => line.includes("clarify_dispatch"))).toBe(true);
  });

  it("parentSession header → no spawn, no accounting, no freeze", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta, "child-parent");

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe(false);

    expect(spawnCalls).toHaveLength(0);
    expect(freezeCalls).toBe(0);
    expect(audits).toEqual([]);
    // Sidecar untouched: the owner's budget is exactly as the harness left it.
    const progress = harness.state().docs[0]!;
    expect(progress.clarifyRounds ?? 0).toBe(0);
    expect(progress.clarifyDispatchedAt).toBeUndefined();
    expect(progress.clarifyStalls ?? 0).toBe(0);
  });

  it("subagent session name → no spawn, no accounting, no freeze", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta, "child-name");

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe(false);

    expect(spawnCalls).toHaveLength(0);
    expect(freezeCalls).toBe(0);
    expect(audits).toEqual([]);
    expect(harness.state().docs[0]!.clarifyDispatchedAt).toBeUndefined();
  });

  it("fork event → no spawn, no accounting, no freeze", async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta, "child-fork");

    expect(await runAutoClarifyRound(ctx, harness.config, meta, deps)).toBe(false);

    expect(spawnCalls).toHaveLength(0);
    expect(freezeCalls).toBe(0);
    expect(audits).toEqual([]);
    expect(harness.state().docs[0]!.clarifyDispatchedAt).toBeUndefined();
  });

  it("a child settle does not consume the owner's round (owner still dispatches after)", async () => {
    // The child is settled FIRST; the owner's budget must be untouched so the
    // following owner settle still dispatches round 1.
    const meta = makeMeta();
    const child = makeCtx(meta, "child-parent");
    expect(await runAutoClarifyRound(child.ctx, harness.config, meta, deps)).toBe(false);
    expect(spawnCalls).toHaveLength(0);

    const owner = makeCtx(meta, "owner");
    expect(await runAutoClarifyRound(owner.ctx, harness.config, meta, deps)).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });
});