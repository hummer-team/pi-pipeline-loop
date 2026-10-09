/**
 * 194 Phase 3 (C4, task 1): lifecycle access tests for the design-review
 * permission matrix — runtime identity → dynamic scope → stage/global chain.
 *
 * Covers:
 * - the `finished` release rows of C4: release ONLY on the current
 *   develop-handoff's trusted success receipt; legacy finished records
 *   release with the cycle artifacts kept read-only; unproven receipts stay
 *   blocked (never ordinary because currentStage says develop);
 * - the pass_ready takeover row (unfinished handoff is never released);
 * - the stale/unknown closed-loop child identity overlay (a recorded
 *   `pi-pipeline:executor-binding` entry that does not match the owner's
 *   current run inherits NOTHING, not even the scoped files);
 * - `isFinishedReleaseProtectedPath` bounded matching (plan, every round's
 *   review-design-* report, plan-update-* receipts, pinned receipts) with
 *   `{reqBase}_plan_commit.md` and source files explicitly NOT matched;
 * - real-guard integration for write/edit and bash: finished develop writes
 *   work, artifacts stay refused (even via sessionAllowedWritePaths), and
 *   blocked/readonly lifecycles refuse mutating bash and git commands.
 *
 * No mock.module(): controlled temp roots + createMockCtx harness (same
 * pattern as tool-guard-design-review-scope.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DesignReviewOperation,
  DesignReviewState,
  PipelineConfig,
  SessionMeta,
} from "../../types";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { createInitialState, computeHash } from "../../core/design-review/state";
import {
  resolveDesignReviewWritePolicy,
  describeWriteScope,
} from "../../core/design-review/write-policy";
import {
  resolveLifecycleWriteAccess,
  isFinishedReleaseProtectedPath,
  type LifecycleRuntimeEvidence,
} from "../../core/stage-executor/lifecycle-access";
import { EXECUTOR_BINDING_ENTRY_TYPE } from "../../core/stage-executor/runtime-binding";
import type { StageExecutorBinding, StageExecutorRun } from "../../core/stage-executor/contracts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

let projectRoot: string;
let planDoc: string;
let reportDoc: string;
let planHash: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dr-lifecycle-"));
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  planDoc = path.join(projectRoot, "docs", "plan.md");
  reportDoc = path.join(projectRoot, "docs", "review-design-1-plan.md");
  fs.writeFileSync(planDoc, "# Plan\nv1\n", "utf-8");
  fs.writeFileSync(path.join(projectRoot, "src", "app.ts"), "export const a = 1;\n", "utf-8");
  planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

// ─── fixture builders ────────────────────────────────────────────────────────

function makeOp(
  kind: DesignReviewOperation["kind"],
  operationId: string,
  overrides?: Partial<DesignReviewOperation>,
): DesignReviewOperation {
  const now = Date.now();
  return {
    operationId,
    kind,
    stageVisitId: now,
    attempt: 1,
    dispatchState: "dispatched",
    agentId: "agent-1",
    round: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDrState(
  phase: DesignReviewState["phase"],
  operation: DesignReviewOperation | undefined,
  overrides?: Partial<DesignReviewState>,
): DesignReviewState {
  const base = createInitialState(planDoc, "menu", planHash, "/runtime/owner-session.jsonl", {
    pipelineId: "pipe-test-001",
  });
  return {
    ...base,
    phase,
    reportDoc,
    ...(operation !== undefined ? { operation } : {}),
    ...overrides,
  };
}

function makeDrMeta(
  stage: SessionMeta["currentStage"],
  state: DesignReviewState,
  metaOverrides?: Partial<SessionMeta>,
): SessionMeta {
  return makeTestMeta({
    currentStage: stage,
    requirementDoc: "docs/req.md",
    designReview: state,
    ...metaOverrides,
  });
}

/** The finished + trusted-handoff meta C4 releases (row 7). */
function finishedTrustedMeta(metaOverrides?: Partial<SessionMeta>): SessionMeta {
  const op = makeOp("develop-handoff", UUID_A, {
    dispatchState: "completed",
    dispatchEvidence: "trusted_id",
    agentId: "develop-agent#aaaa1111",
    settledAt: Date.now(),
  });
  return makeDrMeta("develop", makeDrState("finished", op), metaOverrides);
}

function makeBinding(overrides?: Partial<StageExecutorBinding>): StageExecutorBinding {
  return {
    runId: "run-1",
    pipelineId: "pipe-test-001",
    ownerSessionFile: "/runtime/owner-session.jsonl",
    stage: "design-review",
    stageVisitId: 1730000000000,
    operationId: UUID_A,
    agentId: "design-review-agent#abcd1234",
    executorSessionFile: "/runtime/child-session.jsonl",
    ...overrides,
  };
}

function makeRun(binding: StageExecutorBinding): StageExecutorRun {
  return {
    binding,
    status: "running",
    recovery: "none",
    consecutiveFailures: 0,
    terminalConsumed: false,
  };
}

function bindingEntry(binding: StageExecutorBinding): Record<string, unknown> {
  return { type: "custom", customType: EXECUTOR_BINDING_ENTRY_TYPE, data: binding };
}

const OWNER_FILE = "/runtime/owner-session.jsonl";
const CHILD_FILE = "/runtime/child-session.jsonl";

function ownerEvidence(): LifecycleRuntimeEvidence {
  return { isChild: false, callerSessionFile: OWNER_FILE, ownBinding: null };
}

function childEvidence(ownBinding: StageExecutorBinding | null): LifecycleRuntimeEvidence {
  return { isChild: true, callerSessionFile: CHILD_FILE, ownBinding };
}

function runGuard(
  config: PipelineConfig,
  meta: SessionMeta,
  toolName: string,
  args: Record<string, unknown>,
  ctxOpts?: Parameters<typeof createMockCtx>[1],
) {
  const ctx = createMockCtx(meta, ctxOpts);
  ctx.toolCall = { name: toolName, arguments: args };
  const hook = createToolGuard(config);
  return {
    ctx,
    result: hook.handler(ctx as never) as Promise<{ block?: boolean; reason?: string } | undefined>,
  };
}

// ─── C4 finished-release rows (write policy) ─────────────────────────────────

describe("194 Phase 3 (C4): finished release requires the trusted handoff receipt", () => {
  it("finished + develop-handoff completed with trusted_id + agentId → ordinary release", () => {
    const policy = resolveDesignReviewWritePolicy(finishedTrustedMeta());
    expect(policy.mode).toBe("ordinary");
    expect(policy.finishedRelease).toBe(true);
    expect(policy.reason).toBeUndefined();
  });

  it("finished + handoff still dispatched (not completed) → blocked, never ordinary", () => {
    const op = makeOp("develop-handoff", UUID_A, { dispatchEvidence: "trusted_id" });
    const meta = makeDrMeta("develop", makeDrState("finished", op));
    const policy = resolveDesignReviewWritePolicy(meta);
    expect(policy.mode).toBe("blocked");
    expect(policy.reason).toBe("finished_release_unproven");
  });

  it("finished + handoff completed WITHOUT trusted evidence → blocked", () => {
    const op = makeOp("develop-handoff", UUID_A, {
      dispatchState: "completed",
      dispatchEvidence: "unknown",
      agentId: "develop-agent#aaaa1111",
    });
    const meta = makeDrMeta("develop", makeDrState("finished", op));
    const policy = resolveDesignReviewWritePolicy(meta);
    expect(policy.mode).toBe("blocked");
    expect(policy.reason).toBe("finished_release_unproven");
  });

  it("finished + trusted evidence but no real agentId → blocked", () => {
    const op = makeOp("develop-handoff", UUID_A, {
      dispatchState: "completed",
      dispatchEvidence: "trusted_id",
      agentId: undefined,
    });
    const meta = makeDrMeta("develop", makeDrState("finished", op));
    const policy = resolveDesignReviewWritePolicy(meta);
    expect(policy.mode).toBe("blocked");
    expect(policy.reason).toBe("finished_release_unproven");
  });

  it("finished with incomplete identity → blocked (a phase label proves nothing)", () => {
    const op = makeOp("develop-handoff", UUID_A, {
      dispatchState: "completed",
      dispatchEvidence: "trusted_id",
      agentId: "develop-agent#aaaa1111",
    });
    const state = { ...makeDrState("finished", op), authorizationId: "" };
    const policy = resolveDesignReviewWritePolicy(makeDrMeta("develop", state as DesignReviewState));
    expect(policy.mode).toBe("blocked");
    expect(policy.reason).toBe("design_review_identity_incomplete");
  });

  it("legacy finished record (review operation, pre-192) → released with artifact guard", () => {
    const op = makeOp("review", UUID_A, { dispatchState: "completed" });
    const meta = makeDrMeta("develop", makeDrState("finished", op));
    const policy = resolveDesignReviewWritePolicy(meta);
    expect(policy.mode).toBe("ordinary");
    expect(policy.finishedRelease).toBe(true);
  });

  it("finished with no operation at all → released (191-compat) with artifact guard", () => {
    const meta = makeDrMeta("develop", makeDrState("finished", undefined));
    const policy = resolveDesignReviewWritePolicy(meta);
    expect(policy.mode).toBe("ordinary");
    expect(policy.finishedRelease).toBe(true);
  });

  it("pass_ready + currentStage develop + unfinished handoff → still takeover, never ordinary", () => {
    const op = makeOp("develop-handoff", UUID_A, { dispatchState: "pending", dispatchEvidence: "send_intent", agentId: undefined });
    const meta = makeDrMeta("develop", makeDrState("pass_ready", op));
    const policy = resolveDesignReviewWritePolicy(meta);
    expect(policy.mode).toBe("scoped");
    expect(policy.writable).toEqual([]);
    expect(policy.reason).toBe("handoff_is_plugin_owned");
  });

  it("describeWriteScope states the finished artifacts stay read-only", () => {
    const text = describeWriteScope(resolveDesignReviewWritePolicy(finishedTrustedMeta()));
    expect(text).toContain("finished design-review cycle");
    expect(text).toContain("read-only");
  });
});

// ─── runtime identity overlay ────────────────────────────────────────────────

describe("194 Phase 3 (C4): runtime identity gates the dynamic scope", () => {
  it("no design-review loop → ordinary, no identity claim", () => {
    const access = resolveLifecycleWriteAccess(makeTestMeta(), ownerEvidence());
    expect(access.policy.mode).toBe("ordinary");
    expect(access.callerRole).toBe("none");
  });

  it("stale closed-loop child (binding ≠ current run) → blocked even on scoped files", () => {
    const reviewOp = makeOp("review", UUID_A);
    const meta = makeDrMeta("design-review", makeDrState("review_running", reviewOp), {
      stageExecutorRun: makeRun(makeBinding({ operationId: UUID_A })),
    });
    // The child recorded an OLDER run (different runId).
    const staleBinding = makeBinding({ runId: "run-old", operationId: UUID_A });
    const access = resolveLifecycleWriteAccess(meta, childEvidence(staleBinding));
    expect(access.policy.mode).toBe("blocked");
    expect(access.policy.reason).toBe("executor_identity_stale");
    expect(access.callerRole).toBe("child-stale");
  });

  it("unknown closed-loop child (recorded binding, no current run) → blocked", () => {
    const reviewOp = makeOp("review", UUID_A);
    const meta = makeDrMeta("design-review", makeDrState("review_running", reviewOp));
    const access = resolveLifecycleWriteAccess(meta, childEvidence(makeBinding()));
    expect(access.policy.mode).toBe("blocked");
    expect(access.policy.reason).toBe("executor_identity_unknown");
    expect(access.callerRole).toBe("unknown");
  });

  it("current child (binding equals current run) → scoped policy passes through", () => {
    const reviewOp = makeOp("review", UUID_A);
    const binding = makeBinding({ operationId: UUID_A });
    const meta = makeDrMeta("design-review", makeDrState("review_running", reviewOp), {
      stageExecutorRun: makeRun(binding),
    });
    const access = resolveLifecycleWriteAccess(meta, childEvidence(binding));
    expect(access.policy.mode).toBe("scoped");
    expect(access.policy.writable).toEqual([path.resolve(reportDoc)]);
    expect(access.callerRole).toBe("child-current");
  });

  it("registry session-file contradiction on the current run → child-stale, not current", () => {
    const binding = makeBinding({ operationId: UUID_A });
    const runBinding = { ...binding, executorSessionFile: "/runtime/OTHER-session.jsonl" };
    const meta = makeDrMeta("design-review", makeDrState("review_running", makeOp("review", UUID_A)), {
      stageExecutorRun: makeRun(runBinding),
    });
    const access = resolveLifecycleWriteAccess(meta, childEvidence(binding));
    expect(access.policy.mode).toBe("blocked");
    expect(access.callerRole).toBe("child-stale");
  });

  it("owner session (no recorded binding) keeps the meta policy even with a live run", () => {
    const reviewOp = makeOp("review", UUID_A);
    const meta = makeDrMeta("design-review", makeDrState("review_running", reviewOp), {
      stageExecutorRun: makeRun(makeBinding()),
    });
    const access = resolveLifecycleWriteAccess(meta, ownerEvidence());
    expect(access.policy.mode).toBe("scoped");
    expect(access.callerRole).toBe("none");
  });

  it("child WITHOUT a recorded binding is not a proven executor → meta policy governs", () => {
    const reviewOp = makeOp("review", UUID_A);
    const meta = makeDrMeta("design-review", makeDrState("review_running", reviewOp));
    const access = resolveLifecycleWriteAccess(meta, childEvidence(null));
    expect(access.policy.mode).toBe("scoped");
    expect(access.callerRole).toBe("none");
  });
});

// ─── finished-cycle artifact matching ────────────────────────────────────────

describe("194 Phase 3 (C4): finished-cycle artifacts are bounded, not a directory grant", () => {
  const finishedState = () => makeDrState(
    "finished",
    makeOp("develop-handoff", UUID_A, { dispatchState: "completed", dispatchEvidence: "trusted_id", agentId: "develop-agent#aaaa1111" }),
  );

  it("matches the plan and the pinned report exactly", () => {
    const s = finishedState();
    expect(isFinishedReleaseProtectedPath(projectRoot, planDoc, s)).toBe(true);
    expect(isFinishedReleaseProtectedPath(projectRoot, reportDoc, s)).toBe(true);
  });

  it("matches every round's review-design report of THIS plan", () => {
    const s = finishedState();
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", "review-design-2-plan.md"), s)).toBe(true);
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", "review-design-17-plan.md"), s)).toBe(true);
  });

  it("matches update receipts of THIS plan and the consumed review-input report", () => {
    const s = {
      ...finishedState(),
      reviewInputReceipt: {
        reviewIdentity: {
          pipelineId: "pipe-test-001", planDoc, authorizationId: "auth-1",
          round: 1, kind: "review" as const, operationId: UUID_B, stageVisitId: 1,
        },
        reportDoc: path.join(projectRoot, "docs", "elsewhere-consumed.md"),
        reportHash: "a".repeat(64),
      },
    } as DesignReviewState;
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", `plan-update-1-${UUID_B}-plan.md`), s)).toBe(true);
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", "elsewhere-consumed.md"), s)).toBe(true);
  });

  it("does NOT match source files, the requirement doc or a legitimate {reqBase}_plan_commit.md", () => {
    const s = finishedState();
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "src", "app.ts"), s)).toBe(false);
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", "req.md"), s)).toBe(false);
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", "req_plan_commit.md"), s)).toBe(false);
  });

  it("does NOT match lookalikes outside the plan directory or with foreign shapes", () => {
    const s = finishedState();
    fs.mkdirSync(path.join(projectRoot, "docs", "sub"), { recursive: true });
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", "sub", "review-design-1-plan.md"), s)).toBe(false);
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", "review-design-1-other.md"), s)).toBe(false);
    expect(isFinishedReleaseProtectedPath(projectRoot, path.join(projectRoot, "docs", "plan-update-x-1-plan.md"), s)).toBe(false);
  });

  it("exact pinned matches still apply for plans OUTSIDE the project root", () => {
    const outsidePlan = path.join(fs.realpathSync(os.tmpdir()), "dr-lifecycle-outside-plan.md");
    const s = { ...finishedState(), planDoc: outsidePlan } as DesignReviewState;
    expect(isFinishedReleaseProtectedPath(projectRoot, outsidePlan, s)).toBe(true);
    expect(isFinishedReleaseProtectedPath(projectRoot, outsidePlan + ".bak", s)).toBe(false);
  });
});

// ─── guard integration: finished release ─────────────────────────────────────

describe("194 Phase 3 (C4): tool-guard finished release allows develop writes, refuses artifacts", () => {
  it("write to a source file under the release: allowed (original chain)", async () => {
    const config = makeTestConfig({ projectRoot });
    const res = await runGuard(config, finishedTrustedMeta(), "write", {
      file_path: path.join(projectRoot, "src", "feature.ts"),
      content: "x",
    }).result;
    expect(res?.block).toBeUndefined();
  });

  it("write to the plan: refused, and the reason states the release scope", async () => {
    const config = makeTestConfig({ projectRoot });
    const { ctx, result } = runGuard(config, finishedTrustedMeta(), "write", {
      file_path: planDoc,
      content: "# rewritten\n",
    });
    const res = await result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("finished design-review cycle");
    const violations = (ctx.session.getMeta() as SessionMeta).violations ?? [];
    expect(violations.some((v) => v.type === "write_protected")).toBe(true);
  });

  it("write to an OLD round's report and to an update receipt: refused", async () => {
    const config = makeTestConfig({ projectRoot });
    const resReport = await runGuard(config, finishedTrustedMeta(), "edit", {
      file_path: path.join(projectRoot, "docs", "review-design-1-plan.md"),
    }).result;
    expect(resReport?.block).toBe(true);
    const resReceipt = await runGuard(config, finishedTrustedMeta(), "write", {
      file_path: path.join(projectRoot, "docs", `plan-update-1-${UUID_B}-plan.md`),
      content: "forged receipt",
    }).result;
    expect(resReceipt?.block).toBe(true);
  });

  it("a legitimate {reqBase}_plan_commit.md stays writable", async () => {
    const config = makeTestConfig({ projectRoot });
    const res = await runGuard(config, finishedTrustedMeta(), "write", {
      file_path: path.join(projectRoot, "docs", "req_plan_commit.md"),
      content: "commit ledger\n",
    }).result;
    expect(res?.block).toBeUndefined();
  });

  it("sessionAllowedWritePaths does NOT reopen a finished artifact", async () => {
    const config = makeTestConfig({ projectRoot });
    const meta = finishedTrustedMeta({ sessionAllowedWritePaths: ["docs/plan.md"] });
    const res = await runGuard(config, meta, "write", {
      file_path: planDoc,
      content: "# sneaky rewrite\n",
    }).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("finished design-review cycle");
  });

  it("bash redirect into the plan: refused; into source: allowed", async () => {
    const config = makeTestConfig({ projectRoot });
    const bad = await runGuard(config, finishedTrustedMeta(), "bash", {
      command: `echo rewritten > docs/plan.md`,
    }).result;
    expect(bad?.block).toBe(true);
    expect(bad?.reason).toContain("finished design-review cycle");
    const good = await runGuard(config, finishedTrustedMeta(), "bash", {
      command: `echo new > src/added.ts`,
    }).result;
    expect(good?.block).toBeUndefined();
  });

  it("bash rename touching an artifact on EITHER end: refused", async () => {
    const config = makeTestConfig({ projectRoot });
    const src = await runGuard(config, finishedTrustedMeta(), "bash", {
      command: `mv docs/plan.md docs/plan-backup.md`,
    }).result;
    expect(src?.block).toBe(true);
    const dst = await runGuard(config, finishedTrustedMeta(), "bash", {
      command: `cp src/app.ts docs/plan.md`,
    }).result;
    expect(dst?.block).toBe(true);
  });

  it("bash rm of the current report under the release: refused", async () => {
    fs.writeFileSync(reportDoc, "report", "utf-8");
    const config = makeTestConfig({ projectRoot });
    const res = await runGuard(config, finishedTrustedMeta(), "bash", {
      command: `rm docs/review-design-1-plan.md`,
    }).result;
    expect(res?.block).toBe(true);
  });
});

// ─── guard integration: refusal rows ─────────────────────────────────────────

describe("194 Phase 3 (C4): guard refuses paused, unproven-finished and identity-incomplete loops", () => {
  it("paused (executor-failed) → write refused with the paused scope text", async () => {
    const config = makeTestConfig({ projectRoot });
    const meta = makeDrMeta(
      "design-review",
      makeDrState("paused", makeOp("review", UUID_A), { pauseReason: "executor-failed" }),
    );
    const res = await runGuard(config, meta, "write", {
      file_path: reportDoc,
      content: "attempt",
    }).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("executor-failed");
  });

  it("finished WITHOUT trusted receipt → bash source write still refused (fail closed)", async () => {
    const config = makeTestConfig({ projectRoot });
    const op = makeOp("develop-handoff", UUID_A, { dispatchState: "dispatched", dispatchEvidence: "unknown" });
    const meta = makeDrMeta("develop", makeDrState("finished", op));
    const res = await runGuard(config, meta, "bash", { command: `touch src/late.ts` }).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("finished_release_unproven");
  });

  it("identity-incomplete loop → write refused before any whitelist opening", async () => {
    const config = makeTestConfig({ projectRoot });
    const state = {
      ...makeDrState("review_running", makeOp("review", UUID_A)),
      authorizationId: "",
    } as DesignReviewState;
    const meta = makeDrMeta("design-review", state);
    const res = await runGuard(config, meta, "write", {
      file_path: reportDoc,
      content: "x",
    }).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("design_review_identity_incomplete");
  });

  it("scoped operation: git write commands are refused regardless of stage git policy", async () => {
    const config = makeTestConfig({ projectRoot });
    const meta = makeDrMeta("develop", makeDrState("review_running", makeOp("review", UUID_A)));
    // develop stage would normally allow git; the lifecycle must refuse it
    // while a review operation is scoped-open.
    const res = await runGuard(config, meta, "bash", { command: `git add docs/plan.md` }).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("Git mutation refused by the design-review lifecycle");
  });

  it("stale closed-loop child: even the scoped report write is refused at the guard", async () => {
    const config = makeTestConfig({ projectRoot });
    const binding = makeBinding({ operationId: UUID_A });
    const meta = makeDrMeta("design-review", makeDrState("review_running", makeOp("review", UUID_A)), {
      stageExecutorRun: makeRun(binding),
    });
    const stale = makeBinding({ runId: "run-old", operationId: UUID_A });
    const res = await runGuard(
      config,
      meta,
      "write",
      { file_path: reportDoc, content: "old run attempts to write the current report" },
      {
        sessionHeader: { parentSession: OWNER_FILE },
        sessionFile: CHILD_FILE,
        sessionEntries: [bindingEntry(stale)],
      },
    ).result;
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("executor_identity_stale");
  });

  it("current child binding: the scoped report write passes the lifecycle gate", async () => {
    const config = makeTestConfig({ projectRoot });
    const binding = makeBinding({ operationId: UUID_A });
    const meta = makeDrMeta("design-review", makeDrState("review_running", makeOp("review", UUID_A)), {
      stageExecutorRun: makeRun(binding),
    });
    const res = await runGuard(
      config,
      meta,
      "write",
      { file_path: reportDoc, content: "current review deliverable" },
      {
        sessionHeader: { parentSession: OWNER_FILE },
        sessionFile: CHILD_FILE,
        sessionEntries: [bindingEntry(binding)],
      },
    ).result;
    expect(res?.block).toBeUndefined();
  });
});
