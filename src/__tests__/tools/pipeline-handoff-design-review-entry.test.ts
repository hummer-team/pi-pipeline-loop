/**
 * 227 Phase 2 (D-8): `pipeline_handoff` into design-review goes through the
 * SAME authorisation entry as every other path.
 *
 * Pins:
 * - success: the domain state lands atomically with the handoff, the generic
 *   spawn is skipped (the coordinator owns the dispatch);
 * - failure: nothing is committed and the error is actionable;
 * - leaving design-review without a domain is refused.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

let seq = 0;
const roots: string[] = [];

interface Env {
  root: string;
  meta: SessionMeta;
  ctx: Record<string, unknown>;
  config: ReturnType<typeof makeTestConfig>;
}

async function makeEnv(opts: {
  currentStage: "plan" | "design-review";
  planDoc?: boolean;
  confirm?: boolean;
}): Promise<Env> {
  const root = join(tmpdir(), `pi-227-handoff-entry-${Date.now()}-${++seq}`);
  roots.push(root);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await writeFile(join(root, "docs", "design", "227_Bug.md"), "# Requirement\n", "utf-8");
  if (opts.planDoc !== false) {
    await writeFile(join(root, "docs", "design", "227_Bug_Plan.md"), "# Plan\n", "utf-8");
  }
  const summaryPath = join(root, "summary.md");
  const content = "# Summary\n";
  await writeFile(summaryPath, content, "utf-8");
  const hash = crypto.createHash("sha256").update(content).digest("hex");

  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);

  const meta = makeTestMeta({
    currentStage: opts.currentStage,
    pipelineId: `pipe-227-handoff-${seq}`,
    requirementDoc: "docs/design/227_Bug.md",
    summaries: {
      [opts.currentStage]: { path: summaryPath, hash, status: "valid" as const },
    },
  });
  const ctx: Record<string, unknown> = {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: {
      notify: () => {},
      select: async () => undefined,
      confirm: async () => opts.confirm !== false,
    },
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
  };
  return { root, meta, ctx, config };
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("227 P2: pipeline_handoff → design-review", () => {
  it("authorises the domain, commits it with the handoff, and skips the generic spawn", async () => {
    const env = await makeEnv({ currentStage: "plan" });
    const tool = createPipelineHandoff(env.config);

    const result = (await tool.execute({ nextStage: "design-review" }, env.ctx as never)) as {
      success?: boolean;
    };

    expect(result.success).toBe(true);
    expect(env.meta.currentStage).toBe("design-review");
    expect(env.meta.designReview).toBeDefined();
    expect(env.meta.designReviewEntryPending).toBeUndefined();
  });

  it("a failed authorisation commits NOTHING", async () => {
    const env = await makeEnv({ currentStage: "plan", planDoc: false });
    const tool = createPipelineHandoff(env.config);

    const result = (await tool.execute({ nextStage: "design-review" }, env.ctx as never)) as {
      success?: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("plan document is missing");
    expect(env.meta.currentStage).toBe("plan");
    expect(env.meta.designReview).toBeUndefined();
  });

  it("leaving design-review without a domain is refused", async () => {
    const env = await makeEnv({ currentStage: "design-review" });
    const tool = createPipelineHandoff(env.config);

    const result = (await tool.execute({ nextStage: "develop" }, env.ctx as never)) as {
      success?: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("no authorisation domain");
    expect(env.meta.currentStage).toBe("design-review");
  });
});
