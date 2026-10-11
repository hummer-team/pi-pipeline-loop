import { describe, it, expect, beforeEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";

/**
 * 195 Phase 1: Deliverable exemption tests.
 *
 * Verifies that the commit doc (`{reqBase}_plan_commit.md`) is exempted
 * from read-only interception in develop/fix stages when requirementDoc
 * is present, even when a business-custom wide glob (e.g. `*_plan*.md`)
 * would otherwise block it.
 */
describe("195 Phase 1: deliverable exemption from read-only paths", () => {
  beforeEach(() => {
    resetGitignoreCache();
  });

  /**
   * Shared setup: creates a temp project with audit log, docs/design dir,
   * and returns paths + config for develop stage with custom wide glob.
   */
  async function setupExemptEnv(reqBase: string) {
    const TMP = join(tmpdir(), "pi-exempt-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await mkdir(TMP, { recursive: true });
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    await mkdir(join(TMP, "docs", "design"), { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP, auditDir: ".pi/audit" });
    await initAuditLog(config);

    // Create the plan doc and commit doc
    const planDoc = join(TMP, "docs", "design", `${reqBase}_plan.md`);
    const commitDoc = join(TMP, "docs", "design", `${reqBase}_plan_commit.md`);
    await writeFile(planDoc, "plan content");
    await writeFile(commitDoc, "commit content");

    return { TMP, config, planDoc, commitDoc };
  }

  function makeDevelopConfigWithWideGlob(TMP: string) {
    return makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "review",
          requireDomain: false,
          // Business custom wide glob: matches both _plan.md and _plan_commit.md
          allowedWritePaths: ["**"],
          allowedReadOnlyPaths: ["docs/design/*_plan*.md"],
        },
      },
    } as any);
  }

  // ── Test 1: Exemption overrides business custom wide glob ──────────────

  it("exempts commit doc from read-only even when business uses wide *_plan*.md glob (write tool)", async () => {
    const reqBase = "195_Bug";
    const { TMP, config, commitDoc } = await setupExemptEnv(reqBase);
    const devConfig = makeDevelopConfigWithWideGlob(TMP);

    // Set requirementDoc so exemption fires
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: `docs/design/${reqBase}.md`,
    });
    const ctx = createMockCtx(meta);
    ctx.toolCall = {
      name: "write",
      arguments: { path: commitDoc, content: "updated commit doc" },
    };

    const hook = createToolGuard(devConfig);
    const result = await hook.handler(ctx as any);

    // Should NOT be blocked — exempted from read-only
    expect(result).toBeUndefined();

    await rm(TMP, { recursive: true, force: true });
  });

  // ── Test 2: No requirementDoc → no exemption ───────────────────────────

  it("does NOT exempt when meta.requirementDoc is missing (write tool blocked by read-only)", async () => {
    const reqBase = "195_Bug";
    const { TMP, commitDoc } = await setupExemptEnv(reqBase);
    const devConfig = makeDevelopConfigWithWideGlob(TMP);

    // No requirementDoc set → getStageDeliverableExemptions returns []
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    ctx.toolCall = {
      name: "write",
      arguments: { path: commitDoc, content: "updated commit doc" },
    };

    const hook = createToolGuard(devConfig);
    const result = await hook.handler(ctx as any);

    // Should be blocked by read-only (no exemption)
    expect(result).toBeDefined();
    expect((result as any).reason).toContain("read-only");

    await rm(TMP, { recursive: true, force: true });
  });

  // ── Test 3a: Non develop/fix stages unaffected ─────────────────────────

  it("does NOT exempt in non-develop/fix stages (review stage)", async () => {
    const reqBase = "195_Bug";
    const { TMP, commitDoc } = await setupExemptEnv(reqBase);

    // Configure review stage with same wide glob
    const config = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      stages: {
        ...makeTestConfig().stages,
        review: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "completed",
          requireDomain: false,
          allowedWritePaths: ["**"],
          allowedReadOnlyPaths: ["docs/design/*_plan*.md"],
        },
      },
    } as any);
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "review",
      requirementDoc: `docs/design/${reqBase}.md`,
    });
    const ctx = createMockCtx(meta);
    ctx.toolCall = {
      name: "write",
      arguments: { path: commitDoc, content: "updated" },
    };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Review stage: exemption does NOT apply (only develop/fix)
    expect(result).toBeDefined();
    expect((result as any).reason).toContain("read-only");

    await rm(TMP, { recursive: true, force: true });
  });

  // ── Test 3b: readonly_exempt_applied audit field is complete ────────────

  it("produces readonly_exempt_applied audit event with stage, relPath, and tool", async () => {
    const reqBase = "195_Bug";
    const { TMP, commitDoc } = await setupExemptEnv(reqBase);
    const devConfig = makeDevelopConfigWithWideGlob(TMP);

    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: `docs/design/${reqBase}.md`,
    });
    const ctx = createMockCtx(meta);
    ctx.toolCall = {
      name: "write",
      arguments: { path: commitDoc, content: "updated commit doc" },
    };

    const hook = createToolGuard(devConfig);
    await hook.handler(ctx as any);

    // Read audit log and verify structured event fields
    const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    const events = logContent.split('\n').filter(line => line.trim());
    const exemptEvent = events.find(e => e.includes('readonly_exempt_applied'));
    expect(exemptEvent).toBeDefined();
    expect(exemptEvent).toMatch(/stage=develop/);
    expect(exemptEvent).toMatch(/relPath=docs\/design\/195_Bug_plan_commit\.md/);
    expect(exemptEvent).toMatch(/tool=write/);

    await rm(TMP, { recursive: true, force: true });
  });

  // ── Test 4: Bash write target exemption (I8) ──────────────────────────

  it("exempts bash write target to commit doc via checkBashFileTargets (I8)", async () => {
    const reqBase = "195_Bug";
    const { TMP, commitDoc } = await setupExemptEnv(reqBase);
    const devConfig = makeDevelopConfigWithWideGlob(TMP);

    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: `docs/design/${reqBase}.md`,
    });
    const ctx = createMockCtx(meta);
    // Bash command that writes to the commit doc (exempted path)
    ctx.toolCall = {
      name: "bash",
      arguments: { command: `echo "commit data" > ${commitDoc}` },
    };

    const hook = createToolGuard(devConfig);
    const result = await hook.handler(ctx as any);

    // Bash write to exempted path should NOT be blocked
    expect(result).toBeUndefined();

    // Verify audit event for bash exemption with structured fields
    const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
    const events = logContent.split('\n').filter(line => line.trim());
    const bashExemptEvent = events.find(e => e.includes('readonly_exempt_applied'));
    expect(bashExemptEvent).toBeDefined();
    expect(bashExemptEvent).toMatch(/stage=develop/);
    expect(bashExemptEvent).toMatch(/tool=bash/);

    await rm(TMP, { recursive: true, force: true });
  });

  // ── Test 4b: Bash write to _plan.md still blocked ─────────────────────

  it("bash write to _plan.md (non-deliverable) is still blocked by read-only", async () => {
    const reqBase = "195_Bug";
    const { TMP, planDoc } = await setupExemptEnv(reqBase);
    const devConfig = makeDevelopConfigWithWideGlob(TMP);

    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: `docs/design/${reqBase}.md`,
    });
    const ctx = createMockCtx(meta);
    // Bash command targeting the plan doc (NOT exempted)
    ctx.toolCall = {
      name: "bash",
      arguments: { command: `echo "overwrite" > ${planDoc}` },
    };

    const hook = createToolGuard(devConfig);
    const result = await hook.handler(ctx as any);

    // Plan doc is NOT a deliverable → still blocked
    expect(result).toBeDefined();
    expect((result as any).reason).toContain("read-only");

    await rm(TMP, { recursive: true, force: true });
  });

  // ── Test 5: Fix stage also gets exemption ──────────────────────────────

  it("exempts commit doc in fix stage (same as develop)", async () => {
    const reqBase = "195_Bug";
    const { TMP, commitDoc } = await setupExemptEnv(reqBase);

    const config = makeTestConfig({
      projectRoot: TMP,
      auditDir: ".pi/audit",
      stages: {
        ...makeTestConfig().stages,
        fix: {
          agentPath: "a.md",
          skillPath: "s.md",
          nextStage: "review",
          requireDomain: false,
          allowedWritePaths: ["**"],
          allowedReadOnlyPaths: ["docs/design/*_plan*.md"],
        },
      },
    } as any);
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      requirementDoc: `docs/design/${reqBase}.md`,
    });
    const ctx = createMockCtx(meta);
    ctx.toolCall = {
      name: "write",
      arguments: { path: commitDoc, content: "updated commit doc" },
    };

    const hook = createToolGuard(config);
    const result = await hook.handler(ctx as any);

    // Fix stage: exemption applies
    expect(result).toBeUndefined();

    await rm(TMP, { recursive: true, force: true });
  });
});
