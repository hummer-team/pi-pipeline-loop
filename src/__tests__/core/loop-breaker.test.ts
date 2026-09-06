import { describe, it, expect } from "bun:test";
import { createLoopBreaker } from "../../core/loop-breaker";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";

describe("createLoopBreaker", () => {
  it("creates a hook with event 'tool_result'", () => {
    const hook = createLoopBreaker(makeTestConfig());
    expect(hook.event).toBe("tool_result");
  });

  describe("test failure circuit breaker", () => {
    it("increments loopCount on bash test failure in develop stage", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx.result = { exitCode: 1 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(1);
      expect(ctx.metadataUpdates[0].loopCount).toBe(1);
    });

    it("freezes pipeline when loopCount reaches maxLoops", async () => {
      const TMP = join(tmpdir(), "pi-breaker-freeze-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP, maxLoops: 2 });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 1, maxLoops: 2 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx.result = { exitCode: 1 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.flowState).toBe("blocked");
      expect(lastUpdate.blockedReason).toBe("loop_overflow");
      expect(lastUpdate.loopCount).toBe(2);

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      const lines = logContent.trim().split("\n");
      // Should have both loop_break_fatal and pipeline_blocked audit entries
      expect(lines.some(l => l.includes("loop_break_fatal"))).toBe(true);
      expect(lines.some(l => l.includes("pipeline_blocked"))).toBe(true);
    });

    it("does not break on bash test pass", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx.result = { exitCode: 0 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(0);
    });

    it("only triggers circuit breaker in develop and fix stages", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify", loopCount: 0 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx.result = { exitCode: 1 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(0);
    });

    it("detects various test runners via isTestCommand", async () => {
      const config = makeTestConfig();
      const testCommands = ["bun test", "jest --coverage", "vitest run", "pytest", "mocha test/", "mvn test"];
      for (const cmd of testCommands) {
        const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
        const ctx = createMockCtx(meta);
        ctx.toolCall = { name: "bash", arguments: { command: cmd } };
        ctx.result = { exitCode: 1 };

        const hook = createLoopBreaker(config);
        await hook.handler(ctx as any);

        expect(ctx.metadataUpdates.length).toBeGreaterThan(0);
        expect(ctx.metadataUpdates[0].loopCount).toBe(1);
      }
    });

    it("does NOT count mvn compile/clean/install as test commands (structural detection)", async () => {
      const config = makeTestConfig();
      const nonTestMvnCommands = [
        "mvn compile",
        "mvn clean",
        "mvn install -DskipTests",
        "mvn package",
      ];
      for (const cmd of nonTestMvnCommands) {
        const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
        const ctx = createMockCtx(meta);
        ctx.toolCall = { name: "bash", arguments: { command: cmd } };
        ctx.result = { exitCode: 1 };

        const hook = createLoopBreaker(config);
        await hook.handler(ctx as any);

        // mvn without test subcommand should NOT trigger loop counting
        expect(ctx.metadataUpdates.length).toBe(0);
      }
    });

    it("detects mvn test and mvn -Dtest=... as test commands", async () => {
      const config = makeTestConfig();
      const testCommands = ["mvn test", "mvn -Dtest=MyTest test", "mvn verify -Dtest=Foo"];
      for (const cmd of testCommands) {
        const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
        const ctx = createMockCtx(meta);
        ctx.toolCall = { name: "bash", arguments: { command: cmd } };
        ctx.result = { exitCode: 1 };

        const hook = createLoopBreaker(config);
        await hook.handler(ctx as any);

        expect(ctx.metadataUpdates.length).toBeGreaterThan(0);
        expect(ctx.metadataUpdates[0].loopCount).toBe(1);
      }
    });

    it("detects node --test as a test command", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "node --test src/test.ts" } };
      ctx.result = { exitCode: 1 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(1);
      expect(ctx.metadataUpdates[0].loopCount).toBe(1);
    });

    it("does NOT count non-test commands as test commands (false matrix)", async () => {
      const config = makeTestConfig();
      const nonTestCommands = [
        "git log --grep=test",
        "tail test.md",
        "grep -r test src/",
        "git commit -m 'test fix'",
      ];
      for (const cmd of nonTestCommands) {
        const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
        const ctx = createMockCtx(meta);
        ctx.toolCall = { name: "bash", arguments: { command: cmd } };
        ctx.result = { exitCode: 1 };

        const hook = createLoopBreaker(config);
        await hook.handler(ctx as any);

        // Non-test commands should not trigger loop counting
        expect(ctx.metadataUpdates.length).toBe(0);
      }
    });
  });

  describe("file modification diff archiving", () => {
    it("archives diff when file content changes", async () => {
      const TMP = join(tmpdir(), "pi-diff-archive-" + Date.now());
      await mkdir(TMP, { recursive: true });
      const testFile = join(TMP, "test-file.ts");

      const crypto = await import("node:crypto");
      await writeFile(testFile, "initial content");
      const oldHash = crypto.createHash("sha256").update("initial content").digest("hex");

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      (ctx.toolCall as any) = { name: "write", arguments: { file_path: testFile }, oldHash };
      ctx.result = { success: true };

      await writeFile(testFile, "modified content");

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      const line = logContent.trim().split("\n")[0];
      expect(line).toContain(" - [INFO] file_modified");
    });

    it("skips diff when oldHash equals newHash", async () => {
      const TMP = join(tmpdir(), "pi-diff-skip-" + Date.now());
      await mkdir(TMP, { recursive: true });
      const testFile = join(TMP, "test-file2.ts");

      const crypto = await import("node:crypto");
      await writeFile(testFile, "same content");
      const hash = crypto.createHash("sha256").update("same content").digest("hex");

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      (ctx.toolCall as any) = { name: "write", arguments: { file_path: testFile }, oldHash: hash };
      ctx.result = { success: true };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      let logExists = true;
      try { await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8"); } catch { logExists = false; }
      expect(logExists).toBe(false);
    });

    it("skips diff when result is not successful", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      (ctx.toolCall as any) = { name: "write", arguments: { file_path: "/tmp/file.ts" }, oldHash: "old" };
      ctx.result = { success: false };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(0);
    });
  });

  describe("plan step counting", () => {
    it("increments currentStepIndex on successful plan_run_script", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "plan", currentStepIndex: 0 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "plan_run_script", arguments: {} };
      ctx.result = { success: true };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(1);
      expect(ctx.metadataUpdates[0].currentStepIndex).toBe(1);
    });

    it("does not increment when plan_run_script fails", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "plan", currentStepIndex: 2 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "plan_run_script", arguments: {} };
      ctx.result = { success: false };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(0);
    });

    it("only counts in plan stage", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", currentStepIndex: 0 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "plan_run_script", arguments: {} };
      ctx.result = { success: true };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(0);
    });
  });

  describe("verification failure loop counting", () => {
    it("increments loopCount on bash failure when verifyFailures exist", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "develop",
        loopCount: 0,
        verifyFailures: [{ ruleType: "requiredFiles", detail: "Missing file", timestamp: Date.now() }],
      });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx.result = { exitCode: 1 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      // Should increment (from both test failure counting AND verify failure counting)
      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.loopCount).toBeGreaterThan(0);
    });

    it("does not increment when verifyFailures is empty", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "develop",
        loopCount: 0,
        verifyFailures: [],
      });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git status" } };
      ctx.result = { exitCode: 1 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      // Non-test bash command with no verifyFailures should not trigger
      // (git status is not a test command, and verifyFailures is empty)
      expect(ctx.metadataUpdates.length).toBe(0);
    });

    it("increments loopCount on write success when verifyFailures exist", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "develop",
        loopCount: 0,
        verifyAttempts: 1,
        verifyFailures: [{ ruleType: "requiredFiles", detail: "Missing file", timestamp: Date.now() }],
      });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/some-file.ts" } };
      ctx.result = { success: true };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.loopCount).toBe(1);
    });

    it("increments loopCount on edit success when verifyFailures exist", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "fix",
        loopCount: 0,
        verifyAttempts: 2,
        verifyFailures: [{ ruleType: "requiredCommands", detail: "Build failed", timestamp: Date.now() }],
      });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "edit", arguments: { file_path: "/tmp/some-file.ts" } };
      ctx.result = { success: true };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.loopCount).toBe(1);
    });

    it("throttles: same verifyAttempts + multiple writes → loopCount increments only once", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "develop",
        loopCount: 0,
        verifyAttempts: 3,
        verifyFailures: [{ ruleType: "requiredFiles", detail: "Missing", timestamp: Date.now() }],
      });
      const ctx = createMockCtx(meta);

      const hook = createLoopBreaker(config);

      // First write — should increment
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/a.ts" } };
      ctx.result = { success: true };
      await hook.handler(ctx as any);
      expect(ctx.metadataUpdates[ctx.metadataUpdates.length - 1].loopCount).toBe(1);

      // Second write (same verifyAttempts=3) — should NOT increment again
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/b.ts" } };
      ctx.result = { success: true };
      await hook.handler(ctx as any);
      // metadataUpdates should not have a new entry with loopCount > 1
      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.loopCount).toBe(1); // Still 1, throttled

      // Third write (same verifyAttempts=3) — still throttled
      ctx.toolCall = { name: "edit", arguments: { file_path: "/tmp/c.ts" } };
      ctx.result = { success: true };
      await hook.handler(ctx as any);
      const finalUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(finalUpdate.loopCount).toBe(1); // Still 1
    });

    it("increments again when verifyAttempts changes (new verification cycle)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "develop",
        loopCount: 0,
        verifyAttempts: 1,
        verifyFailures: [{ ruleType: "requiredFiles", detail: "Missing", timestamp: Date.now() }],
      });
      const ctx = createMockCtx(meta);

      const hook = createLoopBreaker(config);

      // First write at verifyAttempts=1
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/a.ts" } };
      ctx.result = { success: true };
      await hook.handler(ctx as any);
      expect(ctx.metadataUpdates[ctx.metadataUpdates.length - 1].loopCount).toBe(1);

      // Simulate new verification cycle: verifyAttempts incremented to 2
      Object.assign(meta, { verifyAttempts: 2 });

      // Second write at verifyAttempts=2 — should increment again
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/b.ts" } };
      ctx.result = { success: true };
      await hook.handler(ctx as any);
      expect(ctx.metadataUpdates[ctx.metadataUpdates.length - 1].loopCount).toBe(2);
    });

    it("does not increment loopCount on write success when verifyFailures is empty", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        currentStage: "develop",
        loopCount: 0,
        verifyFailures: [],
      });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/some-file.ts" } };
      ctx.result = { success: true };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      // Normal development flow — no verifyFailures means no loopCount increment from 1b
      expect(ctx.metadataUpdates.length).toBe(0);
    });

    it("freezes pipeline on write/edit loop overflow when verifyFailures persist", async () => {
      const TMP = join(tmpdir(), "pi-breaker-write-freeze-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP, maxLoops: 2 });
      await initAuditLog(config);
      const meta = makeTestMeta({
        currentStage: "develop",
        loopCount: 1,
        maxLoops: 2,
        verifyAttempts: 1,
        verifyFailures: [{ ruleType: "requiredFiles", detail: "Missing", timestamp: Date.now() }],
      });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/file.ts" } };
      ctx.result = { success: true };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.flowState).toBe("blocked");
      expect(lastUpdate.blockedReason).toBe("verify_failure_loop_overflow");
      expect(lastUpdate.loopCount).toBe(2);
    });
  });

  describe("TUI output gating (output.pipelineStage)", () => {
    it("freeze produces TUI fail output when pipelineStage is true", async () => {
      const TMP = join(tmpdir(), "pi-breaker-tui-on-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP, maxLoops: 2, output: { pipelineStage: true } });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 1, maxLoops: 2 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx.result = { exitCode: 1 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.flowState).toBe("blocked");

      // TUI fail output: "[ {pipelineId} • {stage} ] ⚠ {reason}"
      expect(ctx.notifications).toContain("[ pipe-test-001 • develop ] ⚠ pipeline frozen");
      expect(ctx.statusCalls).toContainEqual({ key: "pipeline-stage", text: "[ pipe-test-001 • develop ] ⚠ pipeline frozen" });
    });

    it("freeze produces no TUI output when pipelineStage is false (default)", async () => {
      const TMP = join(tmpdir(), "pi-breaker-tui-off-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP, maxLoops: 2, output: { pipelineStage: false } });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 1, maxLoops: 2 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx.result = { exitCode: 1 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.flowState).toBe("blocked");

      // No TUI output when switch is off
      expect(ctx.notifications).toEqual([]);
      expect(ctx.statusCalls).toEqual([]);
    });
  });

  // ─── Phase 3 (172): consecutive-fail reset + isTestCommand tightening ─────────
  describe("Phase 3 (172): consecutive-fail semantics", () => {
    it("test success resets loopCount to 0", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 2, maxLoops: 3 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "bun test" } };
      ctx.result = { exitCode: 0 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      expect(ctx.metadataUpdates.length).toBe(1);
      expect(ctx.metadataUpdates[0].loopCount).toBe(0);
    });

    it("test success when loopCount=0 does not write unnecessary audit", async () => {
      const config = makeTestConfig();
      await mkdir(join(config.projectRoot, config.auditDir!), { recursive: true });
      await initAuditLog(config);
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "bun test" } };
      ctx.result = { exitCode: 0 };

      const hook = createLoopBreaker(config);
      await hook.handler(ctx as any);

      // No metadata update (no reset needed)
      expect(ctx.metadataUpdates.length).toBe(0);
    });

    it("2 fail → 1 success → 2 fail does NOT freeze", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 0, maxLoops: 3 });
      const hook = createLoopBreaker(config);

      // Fail 1
      const ctx1 = createMockCtx(meta);
      ctx1.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx1.result = { exitCode: 1 };
      await hook.handler(ctx1 as any);
      expect(meta.loopCount).toBe(1);

      // Fail 2
      const ctx2 = createMockCtx(meta);
      ctx2.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx2.result = { exitCode: 1 };
      await hook.handler(ctx2 as any);
      expect(meta.loopCount).toBe(2);

      // Success → reset
      const ctx3 = createMockCtx(meta);
      ctx3.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx3.result = { exitCode: 0 };
      await hook.handler(ctx3 as any);
      expect(meta.loopCount).toBe(0);

      // Fail again × 2 → still not frozen
      const ctx4 = createMockCtx(meta);
      ctx4.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx4.result = { exitCode: 1 };
      await hook.handler(ctx4 as any);
      expect(meta.loopCount).toBe(1);

      const ctx5 = createMockCtx(meta);
      ctx5.toolCall = { name: "bash", arguments: { command: "npm test" } };
      ctx5.result = { exitCode: 1 };
      await hook.handler(ctx5 as any);
      expect(meta.loopCount).toBe(2);
      // Not frozen (below maxLoops=3)
      expect(meta.flowState).toBeUndefined();
    });

    it("3 consecutive failures freeze the pipeline", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", loopCount: 0, maxLoops: 3 });
      const hook = createLoopBreaker(config);

      for (let i = 0; i < 3; i++) {
        const ctx = createMockCtx(meta);
        ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
        ctx.result = { exitCode: 1 };
        await hook.handler(ctx as any);
      }

      expect(meta.flowState).toBe("blocked");
    });
  });
});
