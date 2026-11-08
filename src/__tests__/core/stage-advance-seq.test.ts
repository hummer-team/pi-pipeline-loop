/**
 * 227 Phase 3 (D-4/D-17): the forward target whitelist.
 *
 * Only the CONFIGURED `nextStage` is a legal forward target:
 * - an undefined stage / a non-successor / the same stage are refused;
 * - `completed` is plugin-exclusive (terminal_reserved);
 * - `awaiting_human` survives on the human track only.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStageAdvancer } from "../../core/stage-advancer";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
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
  currentStage?: SessionMeta["currentStage"];
  nextStage?: SessionMeta["currentStage"] | null;
  auto?: boolean;
} = {}): Promise<Env> {
  const root = join(tmpdir(), `pi-227-seq-${Date.now()}-${++seq}`);
  roots.push(root);
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const base = makeTestConfig({ projectRoot: root });
  const current = opts.currentStage ?? "plan";
  const config: PipelineConfig = {
    ...base,
    stages: {
      ...base.stages,
      [current]: {
        ...base.stages[current],
        nextStage: opts.nextStage === undefined ? "develop" : opts.nextStage,
      },
    },
  };
  await initAuditLog(config);
  const meta = makeTestMeta({
    currentStage: current,
    pipelineId: `pipe-227-seq-${seq}`,
    ...(opts.auto
      ? { autoJob: { jobId: "seq_loop", jobPath: "docs/jobs/seq_loop.yaml", docIndex: 0, totalDocs: 1 } }
      : {}),
  });
  return { root, config, meta, ctx: createMockCtx(meta) };
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("227 P3: legal forward target", () => {
  it("omitting nextStage advances to the configured successor", async () => {
    const env = await makeEnv();
    const result = (await createStageAdvancer(env.config).execute({}, env.ctx as never)) as {
      success?: boolean;
    };
    expect(result.success).toBe(true);
    expect(env.meta.currentStage).toBe("develop");
  });

  it("explicitly naming the configured successor is legal", async () => {
    const env = await makeEnv();
    const result = (await createStageAdvancer(env.config).execute(
      { nextStage: "develop" },
      env.ctx as never,
    )) as { success?: boolean };
    expect(result.success).toBe(true);
    expect(env.meta.currentStage).toBe("develop");
  });
});

describe("227 P3: refused forward targets (five classes)", () => {
  it("unknown stage", async () => {
    const env = await makeEnv();
    const result = (await createStageAdvancer(env.config).execute(
      { nextStage: "nonexistent" },
      env.ctx as never,
    )) as { success?: boolean; message?: string };
    expect(result.success).toBe(false);
    expect(result.message).toContain("not defined in pipeline config");
    expect(env.meta.currentStage).toBe("plan");
  });

  it("non-successor (plan → review)", async () => {
    const env = await makeEnv();
    const result = (await createStageAdvancer(env.config).execute(
      { nextStage: "review" },
      env.ctx as never,
    )) as { success?: boolean; message?: string };
    expect(result.success).toBe(false);
    expect(result.message).toContain("not the configured next stage");
    // The message always carries the full configured sequence.
    expect(result.message).toContain("plan");
    expect(result.message).toContain("develop");
  });

  it("same stage (with the reenter hint)", async () => {
    const env = await makeEnv();
    const result = (await createStageAdvancer(env.config).execute(
      { nextStage: "plan" },
      env.ctx as never,
    )) as { success?: boolean; message?: string; hint?: string };
    expect(result.success).toBe(false);
    expect(result.message).toContain("reenter");
    expect(result.hint).toBe("stage_advance({ reenter: true })");
  });

  it("completed is plugin-exclusive", async () => {
    const env = await makeEnv({ currentStage: "review", nextStage: "completed" });
    const result = (await createStageAdvancer(env.config).execute(
      { nextStage: "completed" },
      env.ctx as never,
    )) as { success?: boolean; message?: string };
    expect(result.success).toBe(false);
    expect(result.message).toContain("completion gate");
  });

  it("awaiting_human is refused in an auto job (human track keeps it)", async () => {
    const auto = await makeEnv({ auto: true });
    const refused = (await createStageAdvancer(auto.config).execute(
      { nextStage: "awaiting_human" },
      auto.ctx as never,
    )) as { success?: boolean; message?: string };
    expect(refused.success).toBe(false);
    expect(refused.message).toContain("not available in an auto job");

    const human = await makeEnv({ nextStage: "awaiting_human" });
    const allowed = (await createStageAdvancer(human.config).execute(
      { nextStage: "awaiting_human" },
      human.ctx as never,
    )) as { success?: boolean };
    expect(allowed.success).toBe(true);
    expect(human.meta.currentStage).toBe("awaiting_human");
  });
});

describe("227 P3: reviewConclusion early exit is unaffected", () => {
  it("review + fail declaration still routes to fix (no seq check)", async () => {
    const env = await makeEnv({ currentStage: "review", nextStage: "completed" });
    const result = (await createStageAdvancer(env.config).execute(
      { reviewConclusion: "fail" },
      env.ctx as never,
    )) as { success?: boolean; message?: string };
    expect(result.success).toBe(true);
    expect(env.meta.currentStage).toBe("fix");
  });

  it("227 review fix 3: an explicit nextStage alongside the fail declaration is ignored, not refused", async () => {
    // Natural spelling `{ nextStage: "fix", reviewConclusion: "fail" }` — the
    // fail branch ignores `nextStage`, so the whitelist must not judge it.
    const env = await makeEnv({ currentStage: "review", nextStage: "completed" });
    const result = (await createStageAdvancer(env.config).execute(
      { nextStage: "fix", reviewConclusion: "fail" },
      env.ctx as never,
    )) as { success?: boolean; message?: string };
    expect(result.success).toBe(true);
    expect(env.meta.currentStage).toBe("fix");
  });
});
