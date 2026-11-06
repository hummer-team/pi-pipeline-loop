/**
 * 225 code-review fix (issue 7): `reviewPendingFail` ownership + invalidation.
 *
 * Two failure channels closed here:
 * 1. A debt from an EARLIER visit (same period) is consumed only after an
 *    ownership check — `stageStartTime` mismatch ⇒ audited `stale-debt`
 *    invalidation, and the ordinary exit gate decides (never an old debt
 *    overriding this visit's outcomfm through a blind route).
 * 2. A NEW declaration in the same visit ("fail then pass") clears the debt
 *    at the declaration write point, so nothing routes at settle for a visit
 *    whose LAST verdict is pass.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSettled } from "../../core/agent-settled";
import { createStageAdvancer } from "../../core/stage-advancer";
import {
  makeTestConfig,
  makeTestMeta,
  createMockCtx,
  auditLogFileFor,
  makeRealisticManagerRegistry,
} from "../helpers";
import { initAuditLog } from "../../utils/auditLog";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";

const T = 1_760_000_000_000;

function makeFixture(stage: PipelineStage) {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), `pending-fail-${stage}-`));
  fs.mkdirSync(join(projectRoot, "agents"), { recursive: true });
  fs.writeFileSync(join(projectRoot, "agents", "review-agent.md"), "---\nname: review-agent\n---\n# review\n", "utf-8");
  fs.writeFileSync(join(projectRoot, "agents", "fix-agent.md"), "---\nname: fix-agent\n---\n# fix\n", "utf-8");
  fs.mkdirSync(join(projectRoot, "docs", "review"), { recursive: true });
  fs.mkdirSync(join(projectRoot, "docs", "design"), { recursive: true });
  fs.writeFileSync(join(projectRoot, "docs", "design", "225_Bug.md"), "# requirement\n", "utf-8");
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
    pipelineId: "pipe-debt",
    requirementDoc: "docs/design/225_Bug.md",
  });
  const session = {
    getMeta: () => meta,
    updateMeta: (p: Partial<SessionMeta>) => {
      Object.assign(meta, p);
      return meta;
    },
  };
  return { projectRoot, config, meta, session };
}

async function auditText(projectRoot: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(auditLogFileFor(join(projectRoot, ".pi", "audit"), "pipe-debt"), "utf-8");
  } catch {
    return "";
  }
}

describe("issue 7 — reviewPendingFail ownership & invalidation", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-pipeline:subagent-state")];
  });

  it("debt from an EARLIER visit is invalidated (stale-debt) and never routes", async () => {
    const { projectRoot, config, meta } = makeFixture("review");
    await initAuditLog(config);

    // The debt belongs to a PREVIOUS review visit of the same period: the
    // stage re-entered (fresh stageStartTime), the executor died, no report.
    meta.reviewPendingFail = { stageStartTime: T - 1000, declaredAt: T - 900 };
    meta.stageStartTime = T;
    const oldStageStartTime = T;
    meta.stageStartTime = oldStageStartTime;

    const ctx = createMockCtx(meta);
    (ctx as unknown as { pi: unknown }).pi = { sendUserMessage: () => {} };
    await createAgentSettled(config).handler(ctx as never);

    // Debt consumed by invalidation, NOT by routing.
    expect(meta.currentStage).toBe("review");
    expect(meta.reviewPendingFail).toBeUndefined();
    const text = await auditText(projectRoot);
    expect(text).toContain("review_pending_fail_stale");
    expect(text).toContain("reason=stale-debt");
    expect(text.includes("review_auto_route_fix")).toBe(false);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("fail declared while live, then pass re-declared in the SAME visit → no routing debt", async () => {
    const { projectRoot, config, meta, session } = makeFixture("review");
    await initAuditLog(config);

    const MANAGER_KEY = Symbol.for("pi-subagents:manager");
    (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = makeRealisticManagerRegistry({ "debt-agent-1": "running" });
    // The production ledger shape: the live executor's probe goes through the
    // activeSpawns entry written by the spawn guard.
    meta.activeSpawns = { review: { agentName: "review-agent", agentId: "debt-agent-1", startedAt: Date.now() } };

    const advancer = createStageAdvancer(config);
    const toolCtx = {
      session,
      pi: { sendUserMessage: () => {} },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    };

    // Executor LIVE ⇒ fail declaration defers as a debt owned by THIS visit.
    const failResult = (await (advancer.execute as unknown as (args: unknown, ctx: unknown) => Promise<{ success?: boolean }>)(
      { reviewConclusion: "fail" } as never,
      toolCtx as never,
    )) as { success?: boolean };
    expect(failResult.success).toBe(true);
    expect(meta.reviewPendingFail?.stageStartTime).toBe(meta.stageStartTime);

    // The executor re-declares PASS in the same visit — the declaration write
    // point invalidates the debt (the pass branch then proceeds normally).
    try {
      await (advancer.execute as unknown as (args: unknown, ctx: unknown) => Promise<unknown>)(
        { reviewConclusion: "pass" } as never,
        toolCtx as never,
      );
    } catch {
      // The pass path may fail on an unconfigured verify setup — the CONTRACT
      // under test is the debt lifecycle, not the pass flow.
    }
    expect(meta.reviewPendingFail).toBeUndefined();

    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});
