/**
 * 225 Phase 6 (T1): the incident interleavings replayed through the REAL
 * agent-settled → exit gate → routing → spawn chain (integration).
 *
 * The two forms re-use the production primitives without unit fakes on the
 * decision path; only the RPC bus and the subagent registry are mocked.
 *
 * - Form ① (22:54:57): review executor live + stale `_1.md` ⇒ NO route; then a
 *   fresh round-2 fail report routes once with the ROUND-2 fix description.
 * - Form ② (22:18:04): explicit `reviewConclusion:"fail"` while live ⇒
 *   declaration debt; post-terminal settle routes exactly once.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utimesSync } from "node:fs";
import { createAgentSettled } from "../../core/agent-settled";
import { createStageAdvancer } from "../../core/stage-advancer";
import { spawnStageSubagent } from "../../utils/subagent-rpc";
import { makeTestConfig, makeTestMeta, createMockCtx, makeRealisticManagerRegistry, auditLogFileFor } from "../helpers";
import { markSubagentsReady, __resetSubagentsReady } from "../../utils/subagent-availability";
import { initAuditLog } from "../../utils/auditLog";
import type { PipelineConfig, SessionMeta } from "../../types";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
markSubagentsReady();

beforeEach(() => {
  __resetSubagentsReady();
  markSubagentsReady();
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-pipeline:subagent-state")];
  // Restore the latch for downstream files (same fixture hybrid the unit suite uses).
  markSubagentsReady();
});

const FAIL_BODY = "# Code Review\n\n- 等级：Blocker: crash\n\n**Verdict: FAIL**\n";
const T = 1_760_000_000_000;

function makeEnv(stage: "review" | "fix") {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), `replay-${stage}-`));
  fs.mkdirSync(join(projectRoot, "agents"), { recursive: true });
  fs.writeFileSync(join(projectRoot, "agents", "review-agent.md"), "---\nname: review-agent\n---\n# review\n");
  fs.writeFileSync(join(projectRoot, "agents", "fix-agent.md"), "---\nname: fix-agent\n---\n# fix\n");
  fs.mkdirSync(join(projectRoot, "docs", "review"), { recursive: true });
  fs.mkdirSync(join(projectRoot, "docs", "design"), { recursive: true });
  fs.writeFileSync(join(projectRoot, "docs", "design", "225_Bug.md"), "# requirement\n");
  const base = makeTestConfig({ projectRoot });
  const config: PipelineConfig = makeTestConfig({
    projectRoot,
    stages: {
      ...base.stages,
      review: { ...(base.stages.review ?? {}), agentPath: "agents/review-agent.md", skillPath: "review/SKILL.md", nextStage: "fix" },
      fix: { ...(base.stages.fix ?? {}), agentPath: "agents/fix-agent.md", skillPath: "fix/SKILL.md", nextStage: "awaiting_human" },
    },
  } as PipelineConfig);
  const meta: SessionMeta = makeTestMeta({
    currentStage: stage,
    stageStartTime: T,
    pipelineId: "pipe-replay",
    requirementDoc: "docs/design/225_Bug.md",
  });
  const bus = spawnReplyBus();
  return { projectRoot, config, meta, bus, session: { getMeta: () => meta, updateMeta: (p: Partial<SessionMeta>) => { Object.assign(meta, p); return meta; } } };
}

function spawnReplyBus() {
  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const bus = {
    emitted,
    handlers,
    on(event: string, handler: (p: unknown) => void) {
      (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(handler);
      return bus;
    },
    off(event: string, handler: (p: unknown) => void) {
      const list = handlers.get(event) ?? [];
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
      return bus;
    },
    emit(event: string, payload: Record<string, unknown>) {
      emitted.push({ event, payload });
      return true;
    },
    trigger(event: string, payload: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) {
        try { h(payload); } catch { /* ignore lifecycle errors in replay */ }
      }
    },
  };
  const origEmit = bus.emit.bind(bus);
  bus.emit = (event: string, payload: Record<string, unknown>) => {
    origEmit(event, payload);
    if (event === "subagents:rpc:ping") {
      const channel = `subagents:rpc:ping:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(channel, { success: true }), 5);
    } else if (event === "subagents:rpc:spawn") {
      const channel = `subagents:rpc:spawn:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(channel, { success: true, data: { id: "replay-agent-1" } }), 5);
    }
    return true;
  };
  return bus;
}

function settleCtx(meta: SessionMeta) {
  const ctx = createMockCtx(meta);
  ctx.pi = { sendUserMessage: () => {} } as never;
  return ctx;
}

async function auditText(projectRoot: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(auditLogFileFor(join(projectRoot, ".pi", "audit"), "pipe-replay"), "utf-8");
  } catch {
    return "";
  }
}

describe("225 Phase 6 T1 — interleaving replays (integration)", () => {
  it("form ① (22:54:57): stale report + live executor → no route; fresh `_2.md` fail routes once", async () => {
    const env = makeEnv("review");
    await initAuditLog(env.config);

    // Incident state: review entered at T; stale `_1.md` (mtime T−19min);
    // pendingSpawns.review consumed in seconds; activeSpawns.review live with
    // the agentId; reviewRound allocated for THIS visit.
    const stale = join(env.projectRoot, "docs", "review", "Code_Review_225_Bug_Develop_Commit_1.md");
    fs.writeFileSync(stale, FAIL_BODY);
    utimesSync(stale, new Date(T - 19 * 60_000), new Date(T - 19 * 60_000));
    env.meta.reviewRound = { index: 1, stageStartTime: T, enteredAt: T, pipelineId: "pipe-replay" };
    env.meta.activeSpawns = { review: { agentName: "review-agent", agentId: "replay-agent-1", startedAt: T } };
    env.meta.reviewDispatchedAt = { stageStartTime: T, at: T };
    // Enough lifecycle evidence for the pre-225 G5 guard? NO registry installed
    // (probe "unknown") — same as the incident's post-dispatch settle window.

    // ONE owner settle.
    await createAgentSettled(env.config).handler(settleCtx(env.meta) as never);

    // Assertions: no route, no fix spawn, deferral audited (reason=live).
    expect(env.meta.currentStage).toBe("review");
    const text = await auditText(env.projectRoot);
    expect(text.includes("review_auto_route_fix")).toBe(false);
    expect(text).toContain("review_verdict_deferred_live_executor");
    expect(text).toContain("reason=live");
    expect(env.meta.reviewDispatchedAt).toBeUndefined(); // consumed on first evaluate

    // Then: the executor writes `_2.md`, terminates (ledger + evidence die),
    // and the next settle resolves the fail and routes once to fix.
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry();
    env.meta.activeSpawns = undefined;
    env.meta.reviewRound = { index: 2, stageStartTime: T, enteredAt: T + 60_000, pipelineId: "pipe-replay" };
    const fresh = join(env.projectRoot, "docs", "review", "Code_Review_225_Bug_Develop_Commit_2.md");
    fs.writeFileSync(fresh, FAIL_BODY);
    utimesSync(fresh, new Date(T + 60_100), new Date(T + 60_100));

    const ctx2 = settleCtx(env.meta);
    await createAgentSettled(env.config).handler(ctx2 as never);

    expect(env.meta.currentStage).toBe("fix");
    const text2 = await auditText(env.projectRoot);
    expect(text2.split("review_auto_route_fix").length - 1).toBe(1);

    fs.rmSync(env.projectRoot, { recursive: true, force: true });
  });

  it("form ② (22:18:04): explicit fail while the executor is live defers; post-terminal settle routes once", async () => {
    const env = makeEnv("review");
    await initAuditLog(env.config);

    // Dispatch the review executor via the REAL primitive (withSpawnReplies).
    await spawnStageSubagent({ events: env.bus } as never, env.config, "review", env.meta, {
      ui: { notify: () => {} },
      session: env.session,
    });
    expect(env.meta.activeSpawns?.review?.agentId).toBe("replay-agent-1");
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry({ "replay-agent-1": "running" });

    // The REVIEW EXECUTOR declares fail through the real tool while live.
    const advancer = createStageAdvancer(env.config);
    const decl = (await advancer.execute(
      { reviewConclusion: "fail" } as never,
      { session: env.session, pi: { sendUserMessage: () => {} }, _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } } } as never,
    )) as { success?: boolean; currentStage?: string };
    expect(decl.success).toBe(true);

    // NO route, NO fix spawn, debt persisted with the explicit-declaration audit.
    expect(env.meta.currentStage).toBe("review");
    expect(env.meta.reviewPendingFail?.stageStartTime).toBe(env.meta.stageStartTime);
    const preText = await auditText(env.projectRoot);
    expect(preText.includes("review_auto_route_fix")).toBe(false);
    expect(preText).toContain("review_verdict_deferred_live_executor");
    expect(preText).toContain("reason=explicit-declaration");

    // Executor terminates → evidence dies; next settle routes EXACTLY once.
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry();
    env.meta.activeSpawns = undefined;
    env.meta.reviewDispatchedAt = undefined;
    await createAgentSettled(env.config).handler(settleCtx(env.meta) as never);

    expect(env.meta.currentStage).toBe("fix");
    expect(env.meta.reviewPendingFail).toBeUndefined();
    const postText = await auditText(env.projectRoot);
    expect(postText.split("review_auto_route_fix").length - 1).toBe(1);

    fs.rmSync(env.projectRoot, { recursive: true, force: true });
  });
});

// (225 code-review fix, issue 12): the empty `withSpawnRepliesPatched()`
// scaffolding was deleted — the emit override already routes replies inside
// `spawnReplyBus`, so there was nothing to patch. The dispatch above uses the
// bus directly.

