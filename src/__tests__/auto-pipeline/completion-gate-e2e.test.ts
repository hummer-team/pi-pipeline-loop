/**
 * 227 Phase 5 (D-12): every `completed` write point runs the SAME completion
 * gate — a blocked gate writes NO terminal state and audits
 * `completion_gate_blocked`.
 *
 * Covered branches: verify forward (review→completed), verify terminal
 * (`nextStage: null`), `stage_advance`, `pipeline_handoff`.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { createStageAdvancer } from "../../core/stage-advancer";
import { applyVerifyPass, autoAdvanceAfterVerify } from "../../core/verify-advance";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { createPipelineUI } from "../../core/pipeline-ui";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import type { PipelineConfig, SessionMeta } from "../../types";

let seq = 0;
const roots: string[] = [];

const PASS_RESULT = { structuredResult: { failures: [] }, ruleMissing: [], verifyResult: null };

interface Env {
  root: string;
  config: PipelineConfig;
  meta: SessionMeta;
  ctx: ReturnType<typeof createMockCtx>;
}

async function makeEnv(): Promise<Env> {
  const root = join(tmpdir(), `pi-227-gate-e2e-${Date.now()}-${++seq}`);
  roots.push(root);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);

  // A valid summary whose hash matches, but the review evidence is missing
  // (no round, no PASS report) — the gate must block on evidence ①.
  const developContent = "---\n{}\n---\n# develop\n";
  const developPath = join(root, "docs", "design", "develop_summary.md");
  await writeFile(developPath, developContent, "utf-8");
  const summaryPath = join(root, "docs", "design", "review_summary.md");
  await writeFile(summaryPath, developContent, "utf-8");

  const meta = makeTestMeta({
    currentStage: "review",
    pipelineId: `pipe-227-gate-e2e-${seq}`,
    requirementDoc: "docs/design/227_Bug.md",
    stageStartTime: Date.now() - 1000,
    stageVisitOrder: ["clarify", "plan", "develop", "review"],
    summaries: {
      develop: {
        path: developPath,
        hash: crypto.createHash("sha256").update(developContent).digest("hex"),
        status: "valid",
      },
      review: {
        path: summaryPath,
        hash: crypto.createHash("sha256").update(developContent).digest("hex"),
        status: "valid",
      },
    },
  });
  const ctx = createMockCtx(meta);
  (ctx as unknown as { config?: PipelineConfig }).config = config;
  return { root, config, meta, ctx };
}

function countEvents(content: string, event: string): number {
  const re = new RegExp(`\\] ${event} \\|`);
  return content.split("\n").filter((line) => re.test(line)).length;
}

afterEach(async () => {
  __setSafeWriteAuditLogOverride(null);
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("227 P5: the gate blocks every completed write point", () => {
  it("verify forward branch (review → completed)", async () => {
    const env = await makeEnv();
    const outcome = await autoAdvanceAfterVerify(
      env.config,
      env.ctx as never,
      env.meta,
      "review",
      "completed",
      PASS_RESULT,
      createPipelineUI(env.config),
      { caller: "auto_advance" },
    );

    expect(outcome.advanced).toBe(false);
    expect(env.meta.currentStage).toBe("review");
  });

  it("verify terminal branch (nextStage: null)", async () => {
    const env = await makeEnv();
    const result = await applyVerifyPass(
      { session: env.ctx.session, config: env.config, ui: env.ctx.ui } as never,
      env.meta,
      "review",
      null,
      PASS_RESULT,
      { method: "tool", handleTerminal: true, returnResult: true },
    );

    expect(result?.success).toBe(false);
    expect(result?.blockReason).toBe("completion_gate_blocked");
    expect(env.meta.currentStage).toBe("review");
  });

  it("stage_advance branch", async () => {
    const env = await makeEnv();
    env.config.stages.review = { ...env.config.stages.review, nextStage: "completed" };

    const result = (await createStageAdvancer(env.config).execute({}, env.ctx as never)) as {
      success?: boolean;
      message?: string;
    };

    expect(result.success).toBe(false);
    expect(result.message).toContain("review_not_passed");
    expect(env.meta.currentStage).toBe("review");
  });

  it("pipeline_handoff branch", async () => {
    const env = await makeEnv();
    const result = (await createPipelineHandoff(env.config).execute(
      { nextStage: "completed" },
      env.ctx as never,
    )) as { success?: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("review_not_passed");
    expect(env.meta.currentStage).toBe("review");
  });
});
