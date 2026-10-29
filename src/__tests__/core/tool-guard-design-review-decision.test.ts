/**
 * 193 Phase 3 (task 8): read-only enforcement while a design-review HUMAN
 * DECISION is pending.
 *
 * Acceptance covered here:
 * - `paused(decision-pending)` blocks write/edit at the OPENING of the
 *   permission chain and blocks bash commands that carry file-mutation
 *   targets (reusing the EXISTING bash classification — no new parser);
 * - pure-read bash still passes while the decision waits;
 * - the corrective window of an invalid running report stays writable
 *   (only paused/decision-pending is read-only);
 * - non-design-review pipelines keep their exact pre-193 whitelist semantics.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import type { DesignReviewState, SessionMeta } from "../../types";

function pendingState(): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/plan.md",
    planHash: "abc123",
    round: 1,
    authorizationId: "auth-pending",
    authorizationSource: "menu",
    phase: "paused",
    pauseReason: "decision-pending",
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makePendingMeta(): SessionMeta {
  return makeTestMeta({
    currentStage: "design-review",
    designReview: pendingState(),
  });
}

describe("193 Phase 3: tool-guard decision-pending read-only", () => {
  let TMP: string;

  beforeEach(() => {
    resetGitignoreCache();
  });

  async function withTmpDir(suffix: string): Promise<string> {
    const dir = join(tmpdir(), `pi-tg-pending-${suffix}-${Date.now()}`);
    await mkdir(join(dir, "docs"), { recursive: true });
    return dir;
  }

  it("write is BLOCKED while the human decision is pending", async () => {
    TMP = await withTmpDir("write");
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makePendingMeta();
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "a.md") } };

    const result = await createToolGuard(config).handler(ctx as any);

    expect((result as any)?.block).toBe(true);
    expect((result as any).reason).toContain("READ-ONLY");
    expect((result as any).reason).toContain("human plan-revision decision");
    // the read-only block records a violation through the standard path
    expect(Array.isArray(meta.violations)).toBe(true);
    expect((meta.violations ?? []).length).toBe(1);
    await rm(TMP, { recursive: true, force: true });
  });

  it("edit is BLOCKED while the human decision is pending", async () => {
    TMP = await withTmpDir("edit");
    const config = makeTestConfig({ projectRoot: TMP });
    const ctx = createMockCtx(makePendingMeta());
    ctx.toolCall = {
      name: "edit",
      arguments: { file_path: join(TMP, "docs", "a.md"), oldString: "x", newString: "y" },
    };

    const result = await createToolGuard(config).handler(ctx as any);

    expect((result as any)?.block).toBe(true);
    expect((result as any).reason).toContain("READ-ONLY");
    await rm(TMP, { recursive: true, force: true });
  });

  it("bash with a file-mutation target is BLOCKED while the decision waits", async () => {
    TMP = await withTmpDir("bash-mutate");
    const config = makeTestConfig({ projectRoot: TMP });
    const ctx = createMockCtx(makePendingMeta());
    ctx.toolCall = { name: "bash", arguments: { command: `echo x > ${join(TMP, "docs", "a.md")}` } };

    const result = await createToolGuard(config).handler(ctx as any);

    expect((result as any)?.block).toBe(true);
    expect((result as any).reason).toContain("READ-ONLY");
    await rm(TMP, { recursive: true, force: true });
  });

  it("pure-read bash still passes while the decision waits", async () => {
    TMP = await withTmpDir("bash-read");
    const config = makeTestConfig({ projectRoot: TMP });
    const ctx = createMockCtx(makePendingMeta());
    ctx.toolCall = { name: "bash", arguments: { command: "ls -la" } };

    const result = await createToolGuard(config).handler(ctx as any);

    expect(result).toBeUndefined();
    await rm(TMP, { recursive: true, force: true });
  });

  it("the corrective window (running report) stays WRITABLE", async () => {
    TMP = await withTmpDir("running");
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      allowedWritePaths: ["docs/"],
    } as any;
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: {
        ...pendingState(),
        phase: "review_running",
        pauseReason: undefined,
      } as DesignReviewState,
    });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "report.md") } };

    const result = await createToolGuard(config).handler(ctx as any);

    expect(result).toBeUndefined();
    await rm(TMP, { recursive: true, force: true });
  });

  it("drift-pause is NOT the read-only pending window (decision cleared)", async () => {
    TMP = await withTmpDir("drift");
    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["design-review"] = {
      ...config.stages["design-review"],
      allowedWritePaths: ["docs/"],
    } as any;
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: {
        ...pendingState(),
        pauseReason: "drift",
      } as DesignReviewState,
    });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "note.md") } };

    const result = await createToolGuard(config).handler(ctx as any);

    expect(result).toBeUndefined();
    await rm(TMP, { recursive: true, force: true });
  });

  it("no design-review pipeline keeps the EXACT pre-193 whitelist behavior", async () => {
    TMP = await withTmpDir("nodomain");
    const config = makeTestConfig({ projectRoot: TMP });
    // 218: pin the PRE-218 deny behaviour — whitelist-miss now defaults to the merged ask
    config.protect = { ...config.protect, whitelistMiss: "deny" };
    config.stages["develop"] = {
      ...config.stages["develop"],
      allowedWritePaths: ["docs/"],
    } as any;
    const meta = makeTestMeta({ currentStage: "develop" });
    const okCtx = createMockCtx(meta);
    okCtx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "ok.md") } };
    expect(await createToolGuard(config).handler(okCtx as any)).toBeUndefined();

    const badCtx = createMockCtx(meta);
    badCtx.toolCall = { name: "write", arguments: { file_path: join(TMP, "src", "app.ts") } };
    const blocked = await createToolGuard(config).handler(badCtx as any) as { block?: boolean; reason?: string } | undefined;
    expect(blocked?.block).toBe(true);
    // the reason is the WHITELIST one — the read-only guard never fired
    expect(blocked?.reason ?? "").not.toContain("READ-ONLY");
    expect(blocked?.reason ?? "").toContain("not in allowed write paths");
    await rm(TMP, { recursive: true, force: true });
  });
});
