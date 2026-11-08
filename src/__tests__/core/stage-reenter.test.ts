/**
 * 227 Phase 3 (D-5): `stage_advance({ reenter: true })` is the ONLY same-stage
 * re-entry carrier — the old `nextStage: <current stage>` form is refused by
 * the sequence whitelist.
 *
 * Pins:
 * - the current visit's summary / verify / spawn artifacts are cleared;
 * - `stageStartTime` is rewritten (fresh executor clock);
 * - a combined `nextStage` is rejected;
 * - the event is audited as `stage_reenter`;
 * - a second re-entry is idempotent.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { createStageAdvancer } from "../../core/stage-advancer";
import { evaluateCompletionGate } from "../../core/auto-pipeline/completion-gate";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor, seedReviewPassEvidence } from "../helpers";
import { codeReviewDocFileName, docsDirsOf, reqBaseFromRequirementDoc } from "../../docs-paths";
import type { PipelineConfig, SessionMeta } from "../../types";

let seq = 0;
const roots: string[] = [];

interface Env {
  root: string;
  config: PipelineConfig;
  meta: SessionMeta;
  ctx: ReturnType<typeof createMockCtx>;
  summaryPath: string;
}

async function makeEnv(): Promise<Env> {
  const root = join(tmpdir(), `pi-227-reenter-${Date.now()}-${++seq}`);
  roots.push(root);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const summaryPath = join(root, "docs", "design", "227_develop_summary.md");
  const content = "# Develop summary\n";
  await writeFile(summaryPath, content, "utf-8");
  const hash = crypto.createHash("sha256").update(content).digest("hex");

  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);
  const meta = makeTestMeta({
    currentStage: "develop",
    pipelineId: `pipe-227-reenter-${seq}`,
    stageStartTime: Date.now() - 60_000,
    verifyAttempts: 2,
    verifyFailures: [{ ruleType: "requiredFiles", detail: "x", timestamp: 1 }],
    violations: [{ type: "x" } as never],
    precheckBlocked: { stage: "develop", missing: ["docs/x.md"], at: 1 },
    confirmGateDeferredAt: { stage: "develop", at: 1 },
    confirmGateReask: { stage: "develop", count: 2 },
    spawnedStages: { develop: 12345 },
    summaries: {
      develop: { path: summaryPath, hash, status: "valid" as const },
      review: { path: summaryPath, hash, status: "valid" as const },
    },
  });
  return { root, config, meta, ctx: createMockCtx(meta), summaryPath };
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("227 P3: stage_advance({ reenter: true })", () => {
  it("clears the current visit's artifacts and restarts the clock", async () => {
    const env = await makeEnv();
    const before = env.meta.stageStartTime;

    const result = (await createStageAdvancer(env.config).execute(
      { reenter: true },
      env.ctx as never,
    )) as { success?: boolean; message?: string };

    expect(result.success).toBe(true);
    expect(result.message).toContain("re-entered");
    expect(env.meta.currentStage).toBe("develop");
    expect(env.meta.summaries?.develop).toBeUndefined();
    // Only the CURRENT visit is dropped — other stages keep their summaries.
    expect(env.meta.summaries?.review).toBeDefined();
    expect(env.meta.verifyAttempts).toBe(0);
    expect(env.meta.verifyFailures).toEqual([]);
    expect(env.meta.violations).toEqual([]);
    expect(env.meta.precheckBlocked).toBeUndefined();
    expect(env.meta.confirmGateDeferredAt).toBeUndefined();
    expect(env.meta.confirmGateReask).toBeUndefined();
    expect(env.meta.spawnedStages?.develop).toBeUndefined();
    expect(env.meta.stageStartTime).toBeGreaterThan(before);
  });

  it("rejects a combined nextStage", async () => {
    const env = await makeEnv();
    const result = (await createStageAdvancer(env.config).execute(
      { reenter: true, nextStage: "review" },
      env.ctx as never,
    )) as { success?: boolean; message?: string };

    expect(result.success).toBe(false);
    expect(result.message).toContain("reenter does not accept nextStage");
    expect(env.meta.currentStage).toBe("develop");
    expect(env.meta.summaries?.develop).toBeDefined();
  });

  it("audits one stage_reenter per call and is idempotent", async () => {
    const env = await makeEnv();
    const tool = createStageAdvancer(env.config);

    await tool.execute({ reenter: true }, env.ctx as never);
    await tool.execute({ reenter: true }, env.ctx as never);

    expect(env.meta.currentStage).toBe("develop");
    expect(env.meta.verifyAttempts).toBe(0);
    const audit = await readFile(
      auditLogFileFor(join(env.root, ".pi", "audit"), env.meta.pipelineId),
      "utf-8",
    );
    const reentries = audit.split("\n").filter((line) => line.includes("stage_reenter"));
    expect(reentries).toHaveLength(2);
  });

  it("the old `nextStage: <current stage>` form is refused with the hint", async () => {
    const env = await makeEnv();
    const result = (await createStageAdvancer(env.config).execute(
      { nextStage: "develop" },
      env.ctx as never,
    )) as { success?: boolean; hint?: string };

    expect(result.success).toBe(false);
    expect(result.hint).toBe("stage_advance({ reenter: true })");
  });
});

describe("227 review fix 2: re-enter at review rebinds the review ROUND", () => {
  it("advances the round and binds it to the fresh visit clock, so the completion gate can pass", async () => {
    const env = await makeEnv();
    env.meta.currentStage = "review";
    env.meta.requirementDoc = "docs/design/227_Bug.md";
    env.meta.stageVisitOrder = ["clarify", "plan", "develop", "review"];
    env.meta.reviewRound = {
      index: 2,
      stageStartTime: (env.meta.stageStartTime ?? 0) - 1_000,
      enteredAt: 1,
      pipelineId: env.meta.pipelineId ?? "pipe",
    };
    env.config.stages.review = { ...env.config.stages.review, nextStage: "completed" };

    const result = (await createStageAdvancer(env.config).execute(
      { reenter: true },
      env.ctx as never,
    )) as { success?: boolean; message?: string };

    expect(result.success).toBe(true);
    expect(env.meta.currentStage).toBe("review");
    expect(env.meta.summaries?.review).toBeUndefined();
    // The ledger is re-bound to the NEW visit clock and stays monotonic.
    expect(env.meta.reviewRound?.stageStartTime).toBe(env.meta.stageStartTime);
    expect(env.meta.reviewRound?.index).toBe(3);

    // Regenerate the review deliverables for the new round → gate passes.
    const content = "---\n{}\n---\n# review\n";
    const summaryPath = join(env.root, "docs", "design", "227_review_summary.md");
    await writeFile(summaryPath, content, "utf-8");
    env.meta.summaries = {
      ...(env.meta.summaries ?? {}),
      review: {
        path: summaryPath,
        hash: crypto.createHash("sha256").update(content).digest("hex"),
        status: "valid",
      },
    };
    await seedReviewPassEvidence(env.config, env.meta);

    const gate = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.ctx.session as never,
    });
    expect(gate.ok).toBe(true);
  });
});

describe("227 review fix (round 4, issue 1): re-enter inside a resumed period is a NEW visit", () => {
  it("a PASS report written before the re-entry can no longer satisfy the completion gate", async () => {
    const env = await makeEnv();
    env.meta.currentStage = "review";
    env.meta.requirementDoc = "docs/design/227_Bug.md";
    env.meta.stageVisitOrder = ["clarify", "plan", "develop", "review"];

    // `/pipeline-start` resume: `periodResumedAt` is stamped and the visit clock
    // is re-pointed to "now", while the recorded round still predates the marker
    // (review-round rule 3 territory).
    const resumedAt = Date.now() - 5_000;
    env.meta.periodResumedAt = resumedAt;
    env.meta.stageStartTime = resumedAt;
    env.meta.reviewRound = {
      index: 2,
      stageStartTime: resumedAt - 60_000,
      enteredAt: resumedAt - 60_000,
      pipelineId: env.meta.pipelineId ?? "pipe",
    };
    const reviewDir = join(env.root, docsDirsOf(env.config).reviewDir);
    // Seeds the PASS report of round 2 (`Code_Review_227_Bug_Develop_Commit_2.md`)
    // plus the verdict spec, and models the resume rebind of the round.
    await seedReviewPassEvidence(env.config, env.meta);

    const gateBefore = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.ctx.session as never,
    });
    expect(gateBefore.ok).toBe(true);

    const result = (await createStageAdvancer(env.config).execute(
      { reenter: true },
      env.ctx as never,
    )) as { success?: boolean; message?: string };
    expect(result.success).toBe(true);

    // The explicit re-entry is a NEW visit: the round advances and the
    // freshness baseline moves to the re-entry clock.
    expect(env.meta.reviewRound?.index).toBe(3);
    expect(env.meta.reviewRound?.enteredAt).toBe(env.meta.stageStartTime);
    expect(env.meta.reviewRound?.enteredAt).toBeGreaterThan(resumedAt);
    expect(env.meta.reviewRound?.stageStartTime).toBe(env.meta.stageStartTime);

    // The pre-re-entry PASS report must NOT count for the new visit.
    const gateAfterReenter = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.ctx.session as never,
    });
    expect(gateAfterReenter.ok).toBe(false);
    if (!gateAfterReenter.ok) {
      expect(gateAfterReenter.failure.code).toBe("review_not_passed");
    }

    // Only a report regenerated for the NEW round lets the gate pass again.
    const passContent = "# Code Review\n\n## Verdict\n\n**Verdict: PASS**\n";
    const newReportPath = join(
      reviewDir,
      codeReviewDocFileName(reqBaseFromRequirementDoc(env.meta.requirementDoc ?? ""), 3),
    );
    await writeFile(newReportPath, passContent, "utf-8");
    const summaryContent = "---\n{}\n---\n# review\n";
    const summaryPath = join(env.root, "docs", "design", "227_review_summary.md");
    await writeFile(summaryPath, summaryContent, "utf-8");
    env.meta.summaries = {
      ...(env.meta.summaries ?? {}),
      review: {
        path: summaryPath,
        hash: crypto.createHash("sha256").update(summaryContent).digest("hex"),
        status: "valid",
      },
    };

    const gateAfterFreshReport = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.ctx.session as never,
    });
    expect(gateAfterFreshReport.ok).toBe(true);
  });
});
