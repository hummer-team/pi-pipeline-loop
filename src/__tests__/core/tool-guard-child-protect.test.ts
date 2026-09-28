import { describe, it, expect, beforeEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { executeDecision } from "../../core/flow-state";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";

/**
 * Phase 1 (190): child session dismiss protection + dismissCount reset
 *
 * Tests for Fix-A (child hard-block) and Fix-B (dismissCount reset)
 */
describe("Phase 1 (190): child session dismiss protection", () => {
  beforeEach(() => {
    resetGitignoreCache();
  });

  // ─── Fix-A: child session hard-block for protected paths ──────────────────
  describe("Fix-A: child hard-block for hardcoded protected paths", () => {
    const ASK_OPTIONS = [
      "Follow plugin default rules (default)",
      "Allow this write only",
      "Allow all writes for this session",
    ];

    it("child + hardcoded path + protect.ask=true → hard-block, no dismissCount accumulation", async () => {
      const TMP = join(tmpdir(), "pi-tg-child-hardcoded-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true },
      });
      await initAuditLog(config);

      // Child session: has parentSession header
      const meta = makeTestMeta({ dismissCount: 0 });
      const ctx = createMockCtx(meta, {
        sessionHeader: { parentSession: "parent-session-id" },
      });
      ctx.toolCall = {
        name: "write",
        arguments: { file_path: join(TMP, ".pi", "audit", "fix.md") },
      };

      let selectCalls = 0;
      ctx.ui.select = async () => {
        selectCalls++;
        return ASK_OPTIONS[0]; // default follow
      };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Should be blocked
      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("FORBIDDEN");

      // dismissCount should NOT be incremented (no ask dialog shown)
      expect(meta.dismissCount).toBe(0);

      // Select should NOT be called (child bypasses ask)
      expect(selectCalls).toBe(0);

      // Audit log should NOT contain pipeline_protect_ask (no ask dialog)
      const logContent = await readFile(
        join(TMP, ".pi", "audit", getDateAuditFileName()),
        "utf-8"
      );
      expect(logContent).not.toContain("pipeline_protect_ask");
    });

    it("owner + hardcoded path + protect.ask=true → normal ask dialog (regression)", async () => {
      const TMP = join(tmpdir(), "pi-tg-owner-hardcoded-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true },
      });
      await initAuditLog(config);

      // Owner session: NO parentSession header
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = {
        name: "write",
        arguments: { file_path: join(TMP, ".pi", "audit", "fix.md") },
      };

      let selectCalls = 0;
      ctx.ui.select = async () => {
        selectCalls++;
        return ASK_OPTIONS[0]; // default follow → block
      };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Should be blocked
      expect((result as any).block).toBe(true);

      // Select SHOULD be called for owner (ask dialog shown)
      expect(selectCalls).toBe(1);

      // Audit log should contain pipeline_protect_ask
      const logContent = await readFile(
        join(TMP, ".pi", "audit", getDateAuditFileName()),
        "utf-8"
      );
      expect(logContent).toContain("pipeline_protect_ask");
    });
  });

  // ─── Fix-B: dismissCount reset on choose_stage and resume ─────────────────
  describe("Fix-B: dismissCount reset on choose_stage and resume", () => {
    it("choose_stage resets dismissCount to 0", async () => {
      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "blocked",
        blockedReason: "loop_overflow",
        dismissCount: 4,
      });
      const ctx = {
        session: {
          getMeta: () => meta,
          updateMeta: (patch: Partial<typeof meta>) => {
            Object.assign(meta, patch);
            return meta;
          },
        },
        ui: { notify: () => {} },
      };
      const config = makeTestConfig();

      const result = await executeDecision(
        ctx as any,
        meta,
        "choose_stage",
        config,
        { targetStage: "review" }
      );

      expect(result.success).toBe(true);
      expect(meta.dismissCount).toBe(0);
    });

    it("resume resets dismissCount to 0", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "loop_overflow",
        dismissCount: 3,
      });
      const ctx = {
        session: {
          getMeta: () => meta,
          updateMeta: (patch: Partial<typeof meta>) => {
            Object.assign(meta, patch);
            return meta;
          },
        },
        ui: { notify: () => {} },
      };
      const config = makeTestConfig();

      const result = await executeDecision(ctx as any, meta, "resume", config);

      expect(result.success).toBe(true);
      expect(meta.dismissCount).toBe(0);
    });
  });
});
