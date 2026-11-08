/**
 * 227 Phase 5 (D-11/D-15): the five completion-gate evidence items, each
 * failing on its own, plus the exemptions and the auto-validate behaviour.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  evaluateCompletionGate,
  enforceCompletionGate,
} from "../../core/auto-pipeline/completion-gate";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, seedCompletionEvidence, seedReviewPassEvidence } from "../helpers";
import type { ExecFn, PipelineConfig, SessionMeta } from "../../types";

let seq = 0;
const roots: string[] = [];

interface Env {
  root: string;
  config: PipelineConfig;
  meta: SessionMeta;
  session: {
    getMeta: () => SessionMeta;
    updateMeta: (p: Partial<SessionMeta>) => SessionMeta;
  };
}

const START = 1_700_000_000_000;

async function makeEnv(opts: {
  visit: SessionMeta["currentStage"][];
  auto?: boolean;
  summaries?: boolean;
  reviewPass?: boolean;
  extra?: Partial<SessionMeta>;
}): Promise<Env> {
  const root = join(tmpdir(), `pi-227-gate-${Date.now()}-${++seq}`);
  roots.push(root);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);

  const meta = makeTestMeta({
    currentStage: "review",
    pipelineId: `pipe-227-gate-${seq}`,
    requirementDoc: "docs/design/227_Bug.md",
    stageStartTime: START,
    pipelineStartedAt: START - 60_000,
    stageVisitOrder: opts.visit as SessionMeta["stageVisitOrder"],
    summaries: {},
    ...(opts.auto
      ? { autoJob: { jobId: "gate_loop", jobPath: "docs/jobs/gate_loop.yaml", docIndex: 0, totalDocs: 1 } }
      : {}),
    ...(opts.extra ?? {}),
  });
  if (opts.summaries !== false) await seedCompletionEvidence(config, meta);
  else if (opts.reviewPass !== false && opts.visit.includes("review")) {
    await seedReviewPassEvidence(config, meta);
  }

  let current: SessionMeta = meta;
  const session = {
    getMeta: () => current,
    updateMeta: (patch: Partial<SessionMeta>) => {
      current = { ...current, ...patch };
      Object.assign(meta, patch);
      return current;
    },
  };
  return { root, config, meta, session };
}

function summaryFile(root: string, stage: string, body: string): Promise<string> {
  const file = join(root, "docs", "design", `${stage}_summary_${seq}.md`);
  return writeFile(file, body, "utf-8").then(() => file);
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const STUB_EXEC: ExecFn = async (_cmd, args) => {
  if (args[0] === "rev-parse") return { code: 0, stdout: ".git\n", stderr: "" };
  if (args[0] === "cat-file") return { code: 0, stdout: "", stderr: "" };
  if (args[0] === "show") return { code: 0, stdout: String(Math.floor((START + 1000) / 1000)), stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

afterEach(async () => {
  __setSafeWriteAuditLogOverride(null);
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("227 P5: evidence ① — this round's review PASS", () => {
  it("a visited review without a recorded round is not proof", async () => {
    const env = await makeEnv({ visit: ["clarify", "plan", "review"], summaries: false });
    const result = await evaluateCompletionGate({ ...env.config, ...{} } as never).catch(() => null);
    // (guard: the object above is intentionally invalid) — run the real call:
    expect(result).toBeNull();

    const real = await evaluateCompletionGate({
      config: env.config,
      meta: { ...env.meta, reviewRound: undefined },
      session: env.session,
    });
    expect(real.ok).toBe(false);
    if (!real.ok) expect(real.failure.code).toBe("review_not_passed");
  });

  it("a round without a fresh PASS report fails", async () => {
    const env = await makeEnv({
      visit: ["clarify", "plan", "review"],
      summaries: false,
      reviewPass: false,
    });
    const real = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.session,
    });
    expect(real.ok).toBe(false);
    if (!real.ok) expect(real.failure.code).toBe("review_not_passed");
  });
});

describe("227 P5: evidence ② — design-review closed", () => {
  it("an unfinished domain fails", async () => {
    const env = await makeEnv({
      visit: ["clarify", "plan", "design-review", "develop", "review"],
      extra: {
        designReview: {
          phase: "review_ready",
        } as never,
      },
    });
    const result = await evaluateCompletionGate({ config: env.config, meta: env.meta, session: env.session });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("design_review_not_closed");
  });
});

describe("227 P5: evidence ③ — no To-Fix debt", () => {
  it("a declared FAIL pending routing fails", async () => {
    const env = await makeEnv({
      visit: ["clarify", "plan", "develop", "review"],
      extra: { reviewPendingFail: { stageStartTime: START, declaredAt: START } },
    });
    const result = await evaluateCompletionGate({ config: env.config, meta: env.meta, session: env.session });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("pending_debt");
  });

  it("a blocked flow fails", async () => {
    const env = await makeEnv({
      visit: ["clarify", "plan", "develop", "review"],
      extra: { flowState: "blocked", blockedReason: "max_loop_cycles" },
    });
    const result = await evaluateCompletionGate({ config: env.config, meta: env.meta, session: env.session });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("pending_debt");
  });
});

describe("227 P5: evidence ④ — fix commit reconciliation", () => {
  it("no readable commit ids fails", async () => {
    const env = await makeEnv({ visit: ["clarify", "plan", "develop", "review", "fix"], summaries: false });
    const summaryPath = await summaryFile(env.root, "fix", "---\n{}\n---\n# fix\n");
    const content = "---\n{}\n---\n# fix\n";
    env.meta.summaries = { fix: { path: summaryPath, hash: hash(content), status: "valid" } };
    env.meta.stageStats = { fix: { durationMs: 1, verifyAttempts: 0, confirmRejections: 0, startedAt: START } };

    const result = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.session,
      execFn: STUB_EXEC,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("fix_commit_unproven");
  });

  it("ids without execFn never pass", async () => {
    const env = await makeEnv({ visit: ["clarify", "plan", "develop", "review", "fix"], summaries: false });
    const content = '---\n{"commit_ids": ["abc1234"]}\n---\n# fix\n';
    const summaryPath = await summaryFile(env.root, "fix", content);
    env.meta.summaries = { fix: { path: summaryPath, hash: hash(content), status: "valid" } };
    env.meta.stageStats = { fix: { durationMs: 1, verifyAttempts: 0, confirmRejections: 0, startedAt: START } };

    const result = await evaluateCompletionGate({ config: env.config, meta: env.meta, session: env.session });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("fix_commit_unproven");
  });

  it("a git error (non-repo) fails strictly", async () => {
    const env = await makeEnv({ visit: ["clarify", "plan", "develop", "review", "fix"], summaries: false });
    const content = '---\n{"commit_ids": ["abc1234"]}\n---\n# fix\n';
    const summaryPath = await summaryFile(env.root, "fix", content);
    env.meta.summaries = { fix: { path: summaryPath, hash: hash(content), status: "valid" } };
    env.meta.stageStats = { fix: { durationMs: 1, verifyAttempts: 0, confirmRejections: 0, startedAt: START } };
    const notRepo: ExecFn = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });

    const result = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.session,
      execFn: notRepo,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("fix_commit_unproven");
  });

  it("proven commits pass", async () => {
    // No develop visit: this case isolates evidence ④/⑤ (review + fix only).
    const env = await makeEnv({ visit: ["clarify", "plan", "review", "fix"], summaries: false });
    const content = '---\n{"commit_ids": ["abc1234"]}\n---\n# fix\n';
    const summaryPath = await summaryFile(env.root, "fix", content);
    env.meta.summaries = { fix: { path: summaryPath, hash: hash(content), status: "valid" } };
    env.meta.stageStats = { fix: { durationMs: 1, verifyAttempts: 0, confirmRejections: 0, startedAt: START } };
    await seedReviewPassEvidence(env.config, env.meta);
    const reviewContent = "---\n{}\n---\n# review\n";
    const reviewPath = await summaryFile(env.root, "review", reviewContent);
    env.meta.summaries.review = { path: reviewPath, hash: hash(reviewContent), status: "valid" };

    const result = await evaluateCompletionGate({
      config: env.config,
      meta: env.meta,
      session: env.session,
      execFn: STUB_EXEC,
    });
    expect(result.ok).toBe(true);
  });
});

describe("227 P5: evidence ⑤ — delivery summaries", () => {
  it("a hash mismatch fails", async () => {
    const env = await makeEnv({ visit: ["clarify", "plan", "develop", "review"], summaries: false });
    const content = "---\n{}\n---\n# develop\n";
    const summaryPath = await summaryFile(env.root, "develop", content);
    env.meta.summaries = { develop: { path: summaryPath, hash: "deadbeef", status: "valid" } };
    await seedReviewPassEvidence(env.config, env.meta);

    const result = await evaluateCompletionGate({ config: env.config, meta: env.meta, session: env.session });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("summary_not_valid");
  });

  it("a pending summary blocks the human track but is auto-validated in an auto job", async () => {
    const human = await makeEnv({ visit: ["clarify", "plan", "develop"], summaries: false });
    const content = "---\n{}\n---\n# develop\n";
    const humanPath = await summaryFile(human.root, "develop", content);
    human.meta.summaries = { develop: { path: humanPath, hash: hash(content), status: "pending" } };
    const humanResult = await evaluateCompletionGate({
      config: human.config,
      meta: human.meta,
      session: human.session,
    });
    expect(humanResult.ok).toBe(false);
    if (!humanResult.ok) expect(humanResult.failure.code).toBe("summary_not_valid");

    const auto = await makeEnv({ visit: ["clarify", "plan", "develop"], summaries: false, auto: true });
    const autoPath = await summaryFile(auto.root, "develop", content);
    auto.meta.summaries = { develop: { path: autoPath, hash: hash(content), status: "pending" } };
    const autoResult = await evaluateCompletionGate({
      config: auto.config,
      meta: auto.meta,
      session: auto.session,
    });
    expect(autoResult.ok).toBe(true);
    if (autoResult.ok) expect(autoResult.autoValidated).toEqual(["develop"]);
    expect(auto.meta.summaries?.develop?.status).toBe("valid");
  });
});

describe("227 P5: unvisited evidence is exempt", () => {
  it("no fix / design-review visit → no proof required", async () => {
    const env = await makeEnv({ visit: ["clarify", "plan"], summaries: false });
    const result = await evaluateCompletionGate({ config: env.config, meta: env.meta, session: env.session });
    expect(result.ok).toBe(true);
  });
});

describe("227 P5: enforceCompletionGate", () => {
  it("human track → allowed:false with actionable copy and no completed write", async () => {
    const audits: string[] = [];
    __setSafeWriteAuditLogOverride(async (event) => {
      audits.push(event);
    });
    const env = await makeEnv({
      visit: ["clarify", "plan", "develop", "review"],
      summaries: false,
      reviewPass: false,
    });
    const result = await enforceCompletionGate({ config: env.config, meta: env.meta, session: env.session });

    expect(result.allowed).toBe(false);
    expect(result.message).toContain("review_not_passed");
    expect(env.meta.currentStage).toBe("review");
    expect(audits).toContain("completion_gate_blocked");
  });
});
