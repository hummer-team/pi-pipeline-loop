import { describe, it, expect, beforeEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { auditLogFileFor } from "../helpers";

describe("createToolGuard", () => {
  beforeEach(() => {
    resetGitignoreCache();
  });

  // ─── Phase 3 (170): Frozen audit throttle tests ──

  describe("Phase 3 (170): frozen audit throttle", () => {
    it("tool_rejected_frozen audit fires once within throttle window, suppressed on repeat", async () => {
      const TMP = join(tmpdir(), "pi-tg-throttle-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      // Use "blocked" instead of "aborted" — aborted is now dormant (pass-through)
      const meta = makeTestMeta({ currentStage: "develop", flowState: "blocked", blockedReason: "loop_overflow" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { path: "src/x.ts" } };

      const hook = createToolGuard(config);

      // First call → should emit audit
      await hook.handler(ctx as any);
      // Second call (same tool+flowState) within window → suppressed
      await hook.handler(ctx as any);

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      const occurrences = logContent.split("tool_rejected_frozen").length - 1;
      expect(occurrences).toBe(1); // Only one audit within window

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });

    it("tool_rejected_frozen audit can fire again for different tool (different throttle key)", async () => {
      const TMP = join(tmpdir(), "pi-tg-throttle2-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      // Use "blocked" instead of "aborted" — aborted is now dormant (pass-through)
      const meta = makeTestMeta({ currentStage: "develop", flowState: "blocked", blockedReason: "loop_overflow" });

      // First call with "write" tool
      const ctx1 = createMockCtx(meta);
      ctx1.toolCall = { name: "write", arguments: { path: "src/x.ts" } };
      const hook = createToolGuard(config);
      await hook.handler(ctx1 as any);

      // Second call with "bash" tool → different key → should emit
      const ctx2 = createMockCtx(meta);
      ctx2.toolCall = { name: "bash", arguments: { command: "ls" } };
      await hook.handler(ctx2 as any);

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      const occurrences = logContent.split("tool_rejected_frozen").length - 1;
      expect(occurrences).toBe(2); // Two audits for different tools

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });
  });

  // ─── Phase 0 (171): Frozen rejection audit includes sessionFile ──

  describe("Phase 0 (171): frozen rejection sessionFile field", () => {
    it("tool_rejected_frozen audit includes sessionFile when available", async () => {
      const TMP = join(tmpdir(), "pi-tg-frozen-sf-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      // Use "blocked" instead of "aborted" — aborted is now dormant (pass-through)
      const meta = makeTestMeta({ currentStage: "develop", flowState: "blocked", blockedReason: "loop_overflow" });
      const ctx = createMockCtx(meta, { sessionFile: "zombie-subagent-session" });
      ctx.toolCall = { name: "write", arguments: { path: "src/x.ts" } };

      const hook = createToolGuard(config);
      await hook.handler(ctx as any);

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("tool_rejected_frozen");
      expect(logContent).toContain("sessionFile=zombie-subagent-session");

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });

    it("tool_rejected_frozen audit omits sessionFile when not available", async () => {
      const TMP = join(tmpdir(), "pi-tg-frozen-nosf-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      // Use "blocked" instead of "aborted" — aborted is now dormant (pass-through)
      const meta = makeTestMeta({ currentStage: "develop", flowState: "blocked", blockedReason: "loop_overflow" });
      const ctx = createMockCtx(meta); // No sessionFile
      ctx.toolCall = { name: "read", arguments: { path: "src/x.ts" } };

      const hook = createToolGuard(config);
      await hook.handler(ctx as any);

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("tool_rejected_frozen");
      expect(logContent).not.toContain("sessionFile=");

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });

    it("Phase 2b (173) C3: aborted frozen rejection is now dormant pass-through", async () => {
      const TMP = join(tmpdir(), "pi-tg-frozen-text-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "plan",
        flowState: "aborted",
        terminateReason: "session_quit",
        requirementDoc: "docs/design/82_Feat.md",
      });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { path: "src/x.ts" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Phase 2b (173) C3: aborted = dormant → full pass-through (🔴-1)
      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });
  });

  // ─── Phase 2 (171): Aborted-state read-only probe exemption (Q2-B) ──

  // ─── Phase 2b (173) C3: Aborted-state is now dormant (full pass-through) ──

  describe("Phase 2b (173) C3: aborted-state dormant pass-through", () => {
    it("aborted + pipeline_state → dormant pass-through (no probe audit)", async () => {
      const TMP = join(tmpdir(), "pi-tg-exempt-ps-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "develop", flowState: "aborted" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "pipeline_state", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Phase 2b (173) C3: aborted = dormant → full pass-through, returns before frozen check
      expect(result).toBeUndefined();

      // No probe audit (dormant returns before reaching frozen probe exemption)
      let logContent = "";
      try { logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8"); } catch { /* */ }
      expect(logContent).not.toContain("tool_allowed_frozen_probe");

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });

    it("aborted + get_subagent_result → dormant pass-through", async () => {
      const TMP = join(tmpdir(), "pi-tg-exempt-gsr-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "plan", flowState: "aborted" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "get_subagent_result", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });

    it("aborted + write → dormant pass-through (🔴-1 protection chain bypassed)", async () => {
      const TMP = join(tmpdir(), "pi-tg-exempt-write-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "develop", flowState: "aborted" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { path: "src/x.ts" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Phase 2b (173) C3: aborted = dormant → full pass-through (🔴-1)
      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });

    it("aborted + read → dormant pass-through (🔴-1)", async () => {
      const TMP = join(tmpdir(), "pi-tg-exempt-read-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "develop", flowState: "aborted" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "read", arguments: { path: "src/x.ts" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Phase 2b (173) C3: aborted = dormant → full pass-through (🔴-1)
      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });

    it("blocked + pipeline_state → allowed (Phase 4/172: exemption extended to blocked)", async () => {
      const TMP = join(tmpdir(), "pi-tg-exempt-blocked-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        currentStage: "develop",
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "pipeline_state", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Phase 4 (172) G6a: blocked state now exempts probe tools (same as aborted)
      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });

    it("blocked probe audit is throttled (only 1 within window)", async () => {
      const TMP = join(tmpdir(), "pi-tg-exempt-throttle-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));
      __resetMemoryThrottle();

      const config = makeTestConfig({ projectRoot: TMP });
      // Use "blocked" instead of "aborted" — aborted is now dormant (pass-through)
      const meta = makeTestMeta({ currentStage: "develop", flowState: "blocked", blockedReason: "loop_overflow" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "pipeline_state", arguments: {} };

      const hook = createToolGuard(config);

      // Call twice within window
      await hook.handler(ctx as any);
      await hook.handler(ctx as any);

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      const occurrences = logContent.split("tool_allowed_frozen_probe").length - 1;
      expect(occurrences).toBe(1); // Throttled to 1

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
      __resetMemoryThrottle();
    });
  });

  // ─── Fix #1 (172 review): .git/*.lock self-rescue in develop vs clarify ─────
  describe("Fix #1 (172 review): .git/*.lock self-rescue", () => {
    it("develop stage: rm -f .git/index.lock → allowed (gitPolicy=allow)", async () => {
      const TMP = join(tmpdir(), "pi-tg-gitlock-develop-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm -f .git/index.lock" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // develop stage has gitPolicy=allow → .git/*.lock targets exempted
      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
    });

    it("clarify stage: rm -f .git/index.lock → blocked (gitPolicy=block)", async () => {
      const TMP = join(tmpdir(), "pi-tg-gitlock-clarify-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "clarify", flowState: "running" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm -f .git/index.lock" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // clarify stage has gitPolicy=block → .git/ is hardcoded protected → blocked
      expect(result).toBeDefined();
      expect((result as any).block).toBe(true);

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
    });

    it("develop stage: rm -f .git/config → still blocked (only .git/*.lock exempted)", async () => {
      const TMP = join(tmpdir(), "pi-tg-gitconfig-develop-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await initAuditLog(makeTestConfig({ projectRoot: TMP }));

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
      const ctx = createMockCtx(meta);
      // .git/config is NOT a *.lock file → should still be protected
      ctx.toolCall = { name: "bash", arguments: { command: "rm -f .git/config" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeDefined();
      expect((result as any).block).toBe(true);

      await rm(TMP, { recursive: true, force: true });
      __resetAuditDirPath();
    });
  });

  // ─── Fix #3 (172 review): fail-closed git subcommand classification ──────────
  describe("Fix #3 (172 review): fail-closed git subcommand classification", () => {
    it("clarify stage: git config user.name x → blocked (not in readonly set)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify", flowState: "running" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git config user.name test" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // git config is not in GIT_READONLY_SUBCOMMANDS → treated as write → blocked in clarify
      expect(result).toBeDefined();
      expect((result as any).block).toBe(true);
    });

    it("clarify stage: git mv old new → blocked (not in readonly set)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify", flowState: "running" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git mv src/a.ts src/b.ts" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeDefined();
      expect((result as any).block).toBe(true);
    });

    it("clarify stage: git status → allowed (in readonly set)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify", flowState: "running" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git status" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // git status is in GIT_READONLY_SUBCOMMANDS → not write → passes through
      expect(result).toBeUndefined();
    });
  });

  // ─── Phase 1 / 177 (D2): git tri-state truth table + ask fallback ──────────
  describe("Phase 1 / 177 (D2): git tri-state truth table", () => {
    const ALLOW_ONCE = "Allow this command once";
    const DENY = "Follow default rules (block, default)";

    it("ask + allow_once → pass", async () => {
      const config = makeTestConfig({
        protect: { gitignore: true, paths: [], allow: [], gitModify: "ask" },
      });
      const meta = makeTestMeta({ currentStage: "review", flowState: "running" });
      const ctx = createMockCtx(meta, { selectReturn: ALLOW_ONCE });
      ctx.toolCall = { name: "bash", arguments: { command: "git merge feature" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations ?? []).toHaveLength(0);
    });

    it("ask + deny → block + violation", async () => {
      const config = makeTestConfig({
        protect: { gitignore: true, paths: [], allow: [], gitModify: "ask" },
      });
      const meta = makeTestMeta({ currentStage: "review", flowState: "running" });
      const ctx = createMockCtx(meta, { selectReturn: DENY });
      ctx.toolCall = { name: "bash", arguments: { command: "git merge feature" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations).toHaveLength(1);
      expect(finalMeta.violations[0].type).toBe("git_protected");
    });

    it("ask + dismissed → block without violation", async () => {
      const config = makeTestConfig({
        protect: { gitignore: true, paths: [], allow: [], gitModify: "ask" },
      });
      const meta = makeTestMeta({ currentStage: "review", flowState: "running" });
      // No selectReturn → select resolves undefined quickly → dismissed
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git merge feature" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations ?? []).toHaveLength(0);
    });

    it("block + protect.ask=false → hard block + violation (legacy behavior)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "review", flowState: "running" });
      let selectCalled = false;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => {
        selectCalled = true;
        return undefined;
      };
      ctx.toolCall = { name: "bash", arguments: { command: "git merge feature" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect(selectCalled).toBe(false);
      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations).toHaveLength(1);
    });

    it("block + protect.ask=true → asks first; allow_once passes", async () => {
      const config = makeTestConfig({
        protect: { gitignore: true, paths: [], allow: [], ask: true },
      });
      const meta = makeTestMeta({ currentStage: "review", flowState: "running" });
      const ctx = createMockCtx(meta, { selectReturn: ALLOW_ONCE });
      ctx.toolCall = { name: "bash", arguments: { command: "git merge feature" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
    });

    it("block + protect.ask=true → deny blocks", async () => {
      const config = makeTestConfig({
        protect: { gitignore: true, paths: [], allow: [], ask: true },
      });
      const meta = makeTestMeta({ currentStage: "review", flowState: "running" });
      const ctx = createMockCtx(meta, { selectReturn: DENY });
      ctx.toolCall = { name: "bash", arguments: { command: "git merge feature" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
    });

    it("allow → pass, ignores protect.ask (no prompt)", async () => {
      const config = makeTestConfig({
        protect: { gitignore: true, paths: [], allow: [], gitModify: "allow", ask: true },
      });
      const meta = makeTestMeta({ currentStage: "review", flowState: "running" });
      let selectCalled = false;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => {
        selectCalled = true;
        return DENY;
      };
      ctx.toolCall = { name: "bash", arguments: { command: "git merge feature" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      expect(selectCalled).toBe(false);
    });

    it("GIT_FORBIDDEN → always blocks, never asks", async () => {
      const config = makeTestConfig({
        protect: { gitignore: true, paths: [], allow: [], gitModify: "allow", ask: true },
      });
      const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
      let selectCalled = false;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => {
        selectCalled = true;
        return ALLOW_ONCE;
      };
      ctx.toolCall = { name: "bash", arguments: { command: "git reset --hard HEAD" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("forbidden pattern");
      expect(selectCalled).toBe(false);
    });

    it("expanded read-only subcommands pass in clarify", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify", flowState: "running" });

      for (const command of [
        "git cat-file -t abc123",
        "git rev-list --count HEAD",
        "git worktree list",
        "git remote get-url origin",
      ]) {
        const ctx = createMockCtx(meta);
        ctx.toolCall = { name: "bash", arguments: { command } };
        const hook = createToolGuard(config);
        const result = await hook.handler(ctx as any);
        expect(result).toBeUndefined();
      }
    });
  });
});
