/**
 * 225 Phase 3 (T4): the two incident interleavings, replayed end to end.
 *
 * Form ① (22:54:57, "dispatch first, then judge"): a live review executor +
 * a stale round-1 report ⇒ one settle MUST NOT draw a verdict, MUST NOT route
 * fix, and MUST audit the deferral; the marker is consumed. After the executor
 * terminates and a FRESH round-2 report exists, the next settle parses the
 * fail and routes ONCE with the round-2 target doc.
 *
 * Form ② (22:18:04, explicit declaration): `stage_advance({reviewConclusion:
 * "fail"})` while the review executor is live ⇒ NO route, NO fix spawn,
 * `reviewPendingFail` persisted with the explicit-declaration audit. After the
 * executor's settle, the next owner settle routes EXACTLY ONCE and clears the
 * declaration.
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
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { probeAgentState } from "../../utils/subagents-introspect";
import type { PipelineConfig, SessionMeta } from "../../types";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
// Enable the RPC availability latch (fixtures follow subagent-rpc.test.ts).
markSubagentsReady();
void __setSafeWriteAuditLogOverride;

function harnessEnv(stage: "review" | "fix") {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), `review-guard-${stage}-`));
  fs.mkdirSync(join(projectRoot, "agents"), { recursive: true });
  fs.writeFileSync(join(projectRoot, "agents", "review-agent.md"), "---\nname: review-agent\n---\n# review\n");
  fs.writeFileSync(join(projectRoot, "agents", "fix-agent.md"), "---\nname: fix-agent\n---\n# fix\n");
  fs.mkdirSync(join(projectRoot, "docs", "review"), { recursive: true });
  fs.mkdirSync(join(projectRoot, "docs", "design"), { recursive: true });
  fs.writeFileSync(join(projectRoot, "docs", "design", "225_Bug.md"), "# requirement\n");
  const base = makeTestConfig({ projectRoot, auditDir: ".pi/audit" });
  const config: PipelineConfig = makeTestConfig({
    projectRoot,
    auditDir: ".pi/audit",
    stages: {
      ...base.stages,
      review: { ...(base.stages.review ?? {}), agentPath: "agents/review-agent.md", skillPath: "review/SKILL.md", nextStage: "fix" },
      fix: { ...(base.stages.fix ?? {}), agentPath: "agents/fix-agent.md", skillPath: "fix/SKILL.md", nextStage: "awaiting_human" },
    },
  } as PipelineConfig);
  const T = 1_760_000_000_000;
  const meta: SessionMeta = makeTestMeta({
    currentStage: stage,
    stageStartTime: T,
    pipelineId: "pipe-guard",
    requirementDoc: "docs/design/225_Bug.md",
  });
  const bus = createSpawnReplyBus();
  const pi = { events: bus } as never;
  return { projectRoot, config, meta, pi, bus, T, session: { getMeta: () => meta, updateMeta: (p: Partial<SessionMeta>) => { Object.assign(meta, p); return meta; } } };
}

/** Reads the harness set's audit text (routing / deferral events are line-based). */
async function auditText(projectRoot: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(auditLogFileFor(join(projectRoot, ".pi", "audit"), "pipe-guard"), "utf-8");
  } catch {
    return "";
  }
}

function installLiveAudits(config: PipelineConfig): void {
  // Real audit init; per-env (deferred-route audits use the direct writer).
  void installLiveAudits;
  void config;
}

/** Mock event-bus with RPC replies + spawn payload capture. */
function createSpawnReplyBus() {
  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const bus = {
    handlers,
    emitted,
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
      const channel = event.replace(/:spawn$/, ":spawn");
      void channel;
      return true;
    },
    trigger(event: string, payload: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) {
        try { h(payload); } catch { /* lifecycle callbacks must not break the replay */ }
      }
    },
  };
  return bus;
}

function withSpawnReplies(bus: ReturnType<typeof createSpawnReplyBus>): void {
  const origEmit = bus.emit.bind(bus);
  bus.emit = (event: string, payload: Record<string, unknown>) => {
    origEmit(event, payload);
    if (event === "subagents:rpc:ping") {
      const channel = `subagents:rpc:ping:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(channel, { success: true }), 5);
    } else if (event === "subagents:rpc:spawn") {
      const channel = `subagents:rpc:spawn:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(channel, { success: true, data: { id: "guard-agent-1" } }), 5);
    }
    return true;
  };
}

const FAIL_BODY = "# Code Review\n\n- 等级：Blocker: crash\n\n**Verdict: FAIL**\n";

// ─── Form ① (22:54:57) ────────────────────────────────────────────────────────

describe("form ① — same-turn dispatch + stale report must not route", () => {
  it("settle adopts neither the stale report nor routes fix; later fresh round-2 fail routes once", async () => {
    const env = harnessEnv("review");
    const T = env.T;

    // Legacy stale `_1.md` with round-1 semantics (mtime = T − 19min), plus a
    // same-turn dispatch marker. The executor's RPC id is UNCONFIRMED (no
    // registry installed → probe returns "unknown"), which is exactly the
    // dispatch reality `reviewDispatchedAt` exists for: G5's ledger probe
    // cannot classify it, so the phase-3 gate owns the deferral.
    const stale = join(env.projectRoot, "docs", "review", "Code_Review_225_Bug_Develop_Commit_1.md");
    fs.writeFileSync(stale, FAIL_BODY);
    utimesSync(stale, new Date(T - 19 * 60_000), new Date(T - 19 * 60_000));
    env.meta.reviewRound = { index: 1, stageStartTime: T, enteredAt: T, pipelineId: "pipe-guard" };
    env.meta.activeSpawns = { review: { agentName: "review-agent", agentId: "guard-agent-1", startedAt: T } };
    env.meta.reviewDispatchedAt = { stageStartTime: T, at: T };

    // ONE owner settle.
    const ctx = createMockCtx(env.meta);
    ctx.pi = { sendUserMessage: () => {} } as never;
    await initAuditLog(env.config);
    await createAgentSettled(env.config).handler(ctx as never);

    // No verdict, no routing, deferral audited; marker consumed.
    expect(env.meta.currentStage).toBe("review");
    const text = await auditText(env.projectRoot);
    expect(text.includes("review_auto_route_fix")).toBe(false);
    expect(text).toContain("review_verdict_deferred_live_executor");
    expect(text).toContain("reason=live");
    expect(env.meta.reviewDispatchedAt).toBeUndefined();

    // Executor terminates → evidence dies; a FRESH round-2 report is written.
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry();
    env.meta.activeSpawns = undefined;
    env.meta.reviewRound = { index: 2, stageStartTime: T, enteredAt: T + 60_000, pipelineId: "pipe-guard" };
    const fresh = join(env.projectRoot, "docs", "review", "Code_Review_225_Bug_Develop_Commit_2.md");
    fs.writeFileSync(fresh, FAIL_BODY); // mtime now — fresh vs enteredAt T+60s? (older!) backdate enteredAt below
    utimesSync(fresh, new Date(T + 60_100), new Date(T + 60_100));
    await createAgentSettled(env.config).handler(ctx as never);

    // Exactly one route to fix.
    expect(env.meta.currentStage).toBe("fix");
    const finalText = await auditText(env.projectRoot);
    expect(finalText.split("review_auto_route_fix").length - 1).toBe(1);

    fs.rmSync(env.projectRoot, { recursive: true, force: true });
  });
});

// ─── Form ② (22:18:04) ────────────────────────────────────────────────────────

describe("form ② — explicit fail declaration while executor live defers the route", () => {
  it("stage_advance defers (no fix spawn); after terminal, the settle routes ONCE and clears the debt", async () => {
    const env = harnessEnv("review");

    // Dispatch the review executor through the REAL primitive (writes the
    // same-turn marker via writeGuard, exactly like the incident's owner).
    withSpawnReplies(env.bus);
    await initAuditLog(env.config);
    await spawnStageSubagent(env.pi, env.config, "review", env.meta, {
      ui: { notify: () => {} },
      session: env.session,
    });
    expect(env.meta.activeSpawns?.review?.agentId).toBe("guard-agent-1");
    expect(env.meta.reviewDispatchedAt?.stageStartTime).toBe(env.meta.stageStartTime);

    // Registry: executor LIVE and stays live until its terminal is emitted.
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry({ "guard-agent-1": "running" });
    expect(probeAgentState("guard-agent-1")).toBe("live");

    // The review executor declares fail via the REAL stage_advance tool.
    const execCtx = { session: env.session, pi: { sendUserMessage: () => {} }, _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } } };
    const tool = createStageAdvancer(env.config);
    const result = (await tool.execute({ reviewConclusion: "fail" } as never, execCtx as never)) as { success?: boolean; currentStage?: string; message?: string };
    expect(result.success).toBe(true);
    expect(result.currentStage).toBe("review");

    // 22:18:04 assertion: NO route, NO fix executor, debt persisted.
    expect(env.meta.currentStage).toBe("review");
    expect(env.meta.reviewPendingFail?.stageStartTime).toBe(env.meta.stageStartTime);
    expect(await auditText(env.projectRoot)).toContain("review_verdict_deferred_live_executor");
    expect(await auditText(env.projectRoot)).toContain("reason=explicit-declaration");
    expect(env.meta.activeSpawns?.review?.agentId).toBe("guard-agent-1"); // executor is UNTOUCHED
    expect((await auditText(env.projectRoot)).includes("review_auto_route_fix")).toBe(false);

    // The executor settles → its termination clears the live probe evidence
    // AND the spawn ledger entry (lifecycle callback semantics).
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry();
    env.meta.activeSpawns = undefined;
    env.meta.reviewDispatchedAt = undefined;

    // The next owner settle routes EXACTLY once and consumes the debt.
    const ctx = createMockCtx(env.meta);
    ctx.pi = { sendUserMessage: () => {} } as never;
    await createAgentSettled(env.config).handler(ctx as never);
    expect(env.meta.currentStage).toBe("fix");
    expect(env.meta.reviewPendingFail).toBeUndefined();
    const finalText = await auditText(env.projectRoot);
    expect(finalText.split("review_auto_route_fix").length - 1).toBe(1);

    fs.rmSync(env.projectRoot, { recursive: true, force: true });
  });
});
