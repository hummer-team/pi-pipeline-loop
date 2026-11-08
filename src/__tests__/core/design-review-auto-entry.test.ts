/**
 * 227 Phase 2 (D-8/D-10): design-review is DOMAIN-owned — every entry
 * authorises first and the state rides the caller's single commit.
 *
 * Pins:
 * - auto job ⇒ auto channel (`authorizationSource: "auto"`, `authorised_auto`);
 * - human ⇒ direct-entry gate (`authorised`);
 * - child ⇒ `deferred` (the gate rejects children on BOTH tracks);
 * - a failed authorisation writes NO state and returns an actionable message;
 * - the owner completes a child-deferred entry on its next settle;
 * - leaving design-review without a domain is refused.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authoriseDesignReviewEntry,
  designReviewEntryPatch,
  maybeEnterPendingDesignReview,
} from "../../core/design-review/entry-automation";
import { createStageAdvancer } from "../../core/stage-advancer";
import { initAuditLog } from "../../utils/auditLog";
import { createJobState, writeJobState } from "../../core/auto-pipeline/job-state";
import { writeFileSync } from "node:fs";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
import type { PipelineConfig, SessionMeta } from "../../types";

let seq = 0;
const roots: string[] = [];

interface Env {
  root: string;
  config: PipelineConfig;
  meta: SessionMeta;
  ctx: ReturnType<typeof createMockCtx>;
}

async function makeEnv(opts: {
  auto?: boolean;
  child?: boolean;
  planDoc?: boolean;
  requirementDoc?: boolean;
  currentStage?: "plan" | "design-review";
  /**
   * Whether to model a RUNNING auto job (sidecar + process lock). The human
   * track has neither, so tests that pin the human deferral must turn this off.
   */
  withSidecar?: boolean;
} = {}): Promise<Env> {
  const root = join(tmpdir(), `pi-227-dr-entry-${Date.now()}-${++seq}`);
  roots.push(root);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  if (opts.requirementDoc !== false) {
    await writeFile(join(root, "docs", "design", "227_Bug.md"), "# Requirement\n", "utf-8");
  }
  if (opts.planDoc !== false) {
    await writeFile(join(root, "docs", "design", "227_Bug_Plan.md"), "# Plan\n", "utf-8");
  }
  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);

  // A RUNNING sidecar: the owner only completes a pending AUTO entry while the
  // job is actually running (`readStateForActiveLock`).
  if (opts.withSidecar !== false) {
    const jobId = "entry_loop";
    const state = createJobState({
      jobId,
      jobPath: "docs/jobs/entry_loop.yaml",
      jobHash: "hash",
      docs: [{ doc: "docs/design/227_Bug.md" }],
    });
    state.status = "running";
    await writeJobState(root, state);
    const lockPath = join(root, ".pi", "auto_pipeline", "lock.json");
    await mkdir(join(root, ".pi", "auto_pipeline"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ token: "tok", jobId, pid: process.pid, startedAt: Date.now() }), "utf-8");
  }

  const meta = makeTestMeta({
    currentStage: opts.currentStage ?? "plan",
    pipelineId: `pipe-227-dr-entry-${seq}`,
    requirementDoc: "docs/design/227_Bug.md",
    ...(opts.auto
      ? { autoJob: { jobId: "entry_loop", jobPath: "docs/jobs/entry_loop.yaml", docIndex: 0, totalDocs: 1 } }
      : {}),
  });
  const ctx = createMockCtx(meta, {
    ...(opts.child
      ? {
          sessionHeader: { parentSession: "/sessions/owner.jsonl" },
          sessionFile: "/sessions/child.jsonl",
          sessionName: "plan-executor#a1b2c3d4",
        }
      : {}),
  });
  return { root, config, meta, ctx };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    await rm(root, { recursive: true, force: true });
  }
});

describe("227 P2: authoriseDesignReviewEntry", () => {
  it("auto job → auto channel with the inherited jobId", async () => {
    const env = await makeEnv({ auto: true });
    const auth = await authoriseDesignReviewEntry({ ctx: env.ctx as never, config: env.config, meta: env.meta });

    expect(auth.kind).toBe("authorized");
    if (auth.kind !== "authorized") return;
    expect(auth.state.authorizationSource).toBe("auto");
    const audit = await readFile(
      auditLogFileFor(join(env.root, ".pi", "audit"), env.meta.pipelineId),
      "utf-8",
    );
    expect(audit).toContain("authorised_auto");
    expect(audit).toContain("entry_loop");
  });

  it("human owner → direct-entry gate", async () => {
    const env = await makeEnv();
    const auth = await authoriseDesignReviewEntry({ ctx: env.ctx as never, config: env.config, meta: env.meta });

    expect(auth.kind).toBe("authorized");
    if (auth.kind !== "authorized") return;
    expect(auth.state.authorizationSource).toBe("direct-entry");
  });

  it("child (auto track) → deferred without touching the gate", async () => {
    const env = await makeEnv({ auto: true, child: true });
    const auth = await authoriseDesignReviewEntry({ ctx: env.ctx as never, config: env.config, meta: env.meta });
    expect(auth).toEqual({ kind: "deferred" });
    expect(env.meta.designReview).toBeUndefined();
  });

  it("child (human track) → deferred as well", async () => {
    const env = await makeEnv({ child: true });
    const auth = await authoriseDesignReviewEntry({ ctx: env.ctx as never, config: env.config, meta: env.meta });
    expect(auth).toEqual({ kind: "deferred" });
  });

  it("missing plan document → failed with an actionable message and no state write", async () => {
    const env = await makeEnv({ auto: true, planDoc: false });
    const auth = await authoriseDesignReviewEntry({ ctx: env.ctx as never, config: env.config, meta: env.meta });

    expect(auth.kind).toBe("failed");
    if (auth.kind !== "failed") return;
    expect(auth.reason).toBe("plan_doc_missing");
    expect(auth.message).toContain("plan document is missing");
    expect(env.meta.designReview).toBeUndefined();
  });
});

describe("227 P2: designReviewEntryPatch", () => {
  it("authorized → the domain state (recheck cleared)", async () => {
    const env = await makeEnv({ auto: true });
    const auth = await authoriseDesignReviewEntry({ ctx: env.ctx as never, config: env.config, meta: env.meta });
    const patch = designReviewEntryPatch(auth, env.meta);
    expect(patch.designReview).toBeDefined();
    expect(patch.designReviewRecheck).toBeUndefined();
    expect(patch.designReviewEntryPending).toBeUndefined();
  });

  it("deferred → the owner hand-off marker (pipelineId bound)", async () => {
    const env = await makeEnv({ child: true });
    const patch = designReviewEntryPatch({ kind: "deferred" }, env.meta);
    expect(patch.designReviewEntryPending?.pipelineId).toBe(env.meta.pipelineId);
    expect(patch.designReview).toBeUndefined();
  });

  it("failed / undefined → empty patch", async () => {
    const env = await makeEnv();
    expect(designReviewEntryPatch(undefined, env.meta)).toEqual({});
    expect(designReviewEntryPatch({ kind: "failed", reason: "x", message: "y" }, env.meta)).toEqual({});
  });
});

describe("227 P2: owner completes a child-deferred entry", () => {
  it("child writes pending → owner builds the domain and clears the marker", async () => {
    const child = await makeEnv({ auto: true, child: true });
    const deferred = await authoriseDesignReviewEntry({
      ctx: child.ctx as never,
      config: child.config,
      meta: child.meta,
    });
    child.ctx.session.updateMeta(designReviewEntryPatch(deferred, child.meta));
    child.ctx.session.updateMeta({ currentStage: "design-review" });
    expect(child.meta.designReviewEntryPending).toBeDefined();
    expect(child.meta.designReview).toBeUndefined();

    // The OWNER shares the same meta store (dual-write) and consumes the marker.
    const ownerCtx = createMockCtx(child.meta);
    const handled = await maybeEnterPendingDesignReview(ownerCtx as never, child.config, child.meta);

    expect(handled).toBe(true);
    expect(child.meta.designReview?.authorizationSource).toBe("auto");
    expect(child.meta.designReviewEntryPending).toBeUndefined();
  });

  it("227 review fix 1: human track — child writes pending → owner builds the domain without a sidecar", async () => {
    // The human track has NO auto job: no sidecar, no lock. Requiring a running
    // sidecar here used to clear the marker on every owner settle, so nobody
    // ever ran the TUI authorisation and the pipeline deadlocked.
    const child = await makeEnv({ child: true, withSidecar: false });
    const deferred = await authoriseDesignReviewEntry({
      ctx: child.ctx as never,
      config: child.config,
      meta: child.meta,
    });
    expect(deferred).toEqual({ kind: "deferred" });
    child.ctx.session.updateMeta(designReviewEntryPatch(deferred, child.meta));
    child.ctx.session.updateMeta({ currentStage: "design-review" });

    const ownerCtx = createMockCtx(child.meta);
    const handled = await maybeEnterPendingDesignReview(ownerCtx as never, child.config, child.meta);

    expect(handled).toBe(true);
    expect(child.meta.designReview?.authorizationSource).toBe("direct-entry");
    expect(child.meta.designReviewEntryPending).toBeUndefined();
  });

  it("a stale marker (stage moved away) is cleared without building a domain", async () => {
    const env = await makeEnv({ auto: true });
    env.ctx.session.updateMeta({
      currentStage: "develop",
      designReviewEntryPending: { at: Date.now(), pipelineId: env.meta.pipelineId },
    });

    const handled = await maybeEnterPendingDesignReview(env.ctx as never, env.config, env.meta);

    expect(handled).toBe(false);
    expect(env.meta.designReview).toBeUndefined();
    expect(env.meta.designReviewEntryPending).toBeUndefined();
  });
});

describe("227 P2: leaving design-review requires the domain", () => {
  it("stage_advance from design-review without a domain is refused", async () => {
    const env = await makeEnv({ currentStage: "design-review" });
    const tool = createStageAdvancer(env.config);
    const result = (await tool.execute({}, env.ctx as never)) as { success?: boolean; message?: string };

    expect(result.success).toBe(false);
    expect(result.message).toContain("no authorisation domain");
  });
});
