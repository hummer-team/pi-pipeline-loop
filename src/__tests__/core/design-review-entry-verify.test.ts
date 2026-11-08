/**
 * 227 Phase 2 (D-8): the verify PASS chain enters design-review through the
 * domain seam exactly ONCE — for both the tool path (`applyVerifyPass`) and the
 * hook path (`autoAdvanceAfterVerify`), with the exit evidence intact.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyVerifyPass, autoAdvanceAfterVerify } from "../../core/verify-advance";
import { createPipelineUI } from "../../core/pipeline-ui";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx, auditLogFileFor } from "../helpers";
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
  const root = join(tmpdir(), `pi-227-entry-verify-${Date.now()}-${++seq}`);
  roots.push(root);
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await writeFile(join(root, "docs", "design", "227_Bug.md"), "# Requirement\n", "utf-8");
  await writeFile(join(root, "docs", "design", "227_Bug_Plan.md"), "# Plan\n", "utf-8");

  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);
  const meta = makeTestMeta({
    currentStage: "plan",
    pipelineId: `pipe-227-entry-verify-${seq}`,
    requirementDoc: "docs/design/227_Bug.md",
  });
  const ctx = createMockCtx(meta);
  return { root, config, meta, ctx };
}

function countEvents(content: string, event: string): number {
  const re = new RegExp(`\\] ${event} \\|`);
  return content.split("\n").filter((line) => re.test(line)).length;
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("227 P2: verify PASS enters design-review through the domain", () => {
  it("tool path → one dispatch + domainEntry marker + exit evidence", async () => {
    const env = await makeEnv();
    const result = await applyVerifyPass(
      { session: env.ctx.session, config: env.config, ui: env.ctx.ui } as never,
      env.meta,
      "plan",
      "design-review",
      PASS_RESULT,
      { method: "tool", handleTerminal: false, returnResult: true, emitExitEvidence: true },
    );

    expect(result?.success).toBe(true);
    expect(result?.domainEntry).toBe("entered");
    expect(env.meta.designReview).toBeDefined();
    expect(env.meta.currentStage).toBe("design-review");

    const audit = await readFile(
      auditLogFileFor(join(env.root, ".pi", "audit"), env.meta.pipelineId),
      "utf-8",
    );
    expect(countEvents(audit, "design_review_auto_entry")).toBe(1);
    // The exiting stage's evidence chain is preserved.
    expect(countEvents(audit, "auto_verify_pass")).toBe(1);
    expect(countEvents(audit, "stage_usage")).toBeLessThanOrEqual(1);
  });

  it("hook path → {advanced:true} with the same single dispatch", async () => {
    const env = await makeEnv();
    const outcome = await autoAdvanceAfterVerify(
      env.config,
      { session: env.ctx.session, config: env.config, ui: env.ctx.ui } as never,
      env.meta,
      "plan",
      "design-review",
      PASS_RESULT,
      createPipelineUI(env.config),
      { caller: "auto_advance" },
    );

    expect(outcome.advanced).toBe(true);
    expect(env.meta.designReview).toBeDefined();

    const audit = await readFile(
      auditLogFileFor(join(env.root, ".pi", "audit"), env.meta.pipelineId),
      "utf-8",
    );
    expect(countEvents(audit, "design_review_auto_entry")).toBe(1);
    expect(countEvents(audit, "stage_advance")).toBe(1);
  });

  it("leaving design-review without a domain is blocked (PASS does not release)", async () => {
    const env = await makeEnv();
    env.meta.currentStage = "design-review";

    const result = await applyVerifyPass(
      { session: env.ctx.session, config: env.config, ui: env.ctx.ui } as never,
      env.meta,
      "design-review",
      "develop",
      PASS_RESULT,
      { method: "tool", handleTerminal: false, returnResult: true },
    );

    expect(result?.success).toBe(false);
    expect(result?.blockReason).toBe("design_review_entry_required");
    expect(env.meta.currentStage).toBe("design-review");
  });
});
