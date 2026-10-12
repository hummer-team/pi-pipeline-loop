import { describe, it, expect, beforeEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog } from "../../utils/auditLog";
import type { ExecFn } from "../../types";
import { auditLogFileFor } from "../helpers";

describe("createToolGuard", () => {
  beforeEach(() => {
    resetGitignoreCache();
  });

  // ─── protect.ask TUI decision flow ──────────────────────────────────────────
  describe("protect.ask interactive approval", () => {
    const ASK_OPTIONS = [
      "Follow plugin default rules (default)",
      "Allow this edit only",
      "Allow edits for this session",
    ];

    it("ask=true + write hits gitignore → denied (follow_default) → block + audit action=denied", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-gitignore-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      const meta = makeTestMeta();
      // select returns "Follow plugin default rules (default)"
      const ctx = createMockCtx(meta, { selectReturn: ASK_OPTIONS[0] });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("gitignore protected");

      // Verify audit — Phase 4 (173) C11: follow_default → denied (tri-state)
      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("pipeline_protect_ask");
      expect(logContent).toContain("action=denied");
      expect(logContent).toContain("file=docs/file.md");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("ask=true + write hits gitignore → allow_once → not blocked + audit action=allow_once", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-allow-once-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "file.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta, { selectReturn: ASK_OPTIONS[1] });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Should NOT be blocked
      expect(result).toBeUndefined();

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("ask=true + allow_session → meta.sessionAllowedWritePaths contains path + audit action=allow_session", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-allow-session-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "file.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta, { selectReturn: ASK_OPTIONS[2] });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      // sessionAllowedWritePaths should contain the path
      expect(meta.sessionAllowedWritePaths).toContain("docs/file.md");

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=allow_session");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("session allowance persists: second edit of same file bypasses protection (no ask, no audit)", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-session-persist-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "file.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      const meta = makeTestMeta({ sessionAllowedWritePaths: ["docs/file.md"] });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return undefined; };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Should pass without calling select
      expect(result).toBeUndefined();
      expect(selectCalls).toBe(0);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("session allowance can exempt hardcoded paths (.pi/)", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-hardcoded-session-" + Date.now());
      await mkdir(join(TMP, ".pi"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      // Pre-set session allowance for .pi/config.json
      const meta = makeTestMeta({ sessionAllowedWritePaths: [".pi/config.json"] });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return undefined; };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Session allowance should exempt hardcoded
      expect(result).toBeUndefined();
      expect(selectCalls).toBe(0);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("ask=true + bash mv two protected files → two select calls (per-file)", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-bash-multi-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "a.md"), "");
      await writeFile(join(TMP, "docs", "b.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      config.stages["develop"] = {
        ...config.stages["develop"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta();
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      // First file: allow_once; second file: follow_default (block)
      ctx.ui.select = async () => {
        selectCalls++;
        return selectCalls === 1 ? ASK_OPTIONS[1] : ASK_OPTIONS[0];
      };
      // mv extracts both source and dest as targets
      ctx.toolCall = { name: "bash", arguments: { command: "mv docs/a.md docs/b.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // First file allowed, second file blocked
      expect((result as any).block).toBe(true);
      expect(selectCalls).toBe(2);

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=allow_once");
      // Phase 4 (173) C11: follow_default → denied (tri-state)
      expect(logContent).toContain("action=denied");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("ask=true + stage whitelist rejection → direct block, no ask, no audit", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-whitelist-block-" + Date.now());
      await mkdir(join(TMP, "src"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP, protect: { ask: true } });
      // clarify stage: whitelist = docs/ only (does not include src/)
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return ASK_OPTIONS[1]; };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "src", "x.ts") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");
      expect(selectCalls).toBe(0);

      // No audit for stage whitelist rejection
      let hasAudit = false;
      try {
        const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
        hasAudit = logContent.includes("pipeline_protect_ask");
      } catch { /* no audit file = no audit */ }
      expect(hasAudit).toBe(false);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("ask=false (default) → existing behavior unchanged (no popup)", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-false-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: false },
      });
      await initAuditLog(config);

      const meta = makeTestMeta();
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return ASK_OPTIONS[1]; };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Should block directly
      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("gitignore protected");
      // No select call
      expect(selectCalls).toBe(0);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("Esc fast (< 1500ms) → block + audit action=dismissed (Phase 4/173 C11 tri-state)", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-esc-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      const meta = makeTestMeta();
      // select returns undefined immediately (fast dismiss, < 1500ms)
      const ctx = createMockCtx(meta, { selectReturn: undefined });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);

      // Phase 4 (173) C11: fast undefined → dismissed (not canceled)
      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=dismissed");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("ask=true select throws → logged via console.error + fail-safe block + audit action=dismissed (fast)", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-select-err-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      // Override select to throw
      ctx.ui.select = async (_message: string, _options: string[]) => {
        throw new Error("TUI unavailable");
      };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      // Spy on console.error
      const origError = console.error;
      const captured: string[] = [];
      console.error = (...args: unknown[]) => {
        captured.push(args.map(String).join(" "));
      };

      try {
        const hook = createToolGuard(config);
        const result = await hook.handler(ctx as any);

        // Fail-safe: select error → block
        expect((result as any).block).toBe(true);

        // console.error should have been called with diagnostic info
        expect(captured.some(msg => msg.includes("askProtectDecision") && msg.includes("docs/file.md"))).toBe(true);

        // Phase 4 (173) C11: fast error → dismissed (not canceled)
        const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
        expect(logContent).toContain("action=dismissed");
      } finally {
        console.error = origError;
      }
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("ask=true select message includes the protected file path", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-msg-path-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "secret.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta, { selectReturn: "Allow this edit only" });

      // Override select to capture the message passed by askProtectDecision
      let capturedMessage = "";
      ctx.ui.select = async (message: string, _options: string[]) => {
        capturedMessage = message;
        return "Allow this edit only";
      };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "secret.md") } };

      const hook = createToolGuard(config);
      await hook.handler(ctx as any);

      // Verify the TUI dialog includes the protected file's relative path
      expect(capturedMessage).toContain("docs/secret.md");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("git add/commit NOT exempted by session allowance", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-git-no-exempt-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      // No initAuditLog — this test doesn't verify audit, and removing TMP
      // after initAuditLog would break module-level auditDirPath for subsequent tests.

      // Session allowance includes docs/file.md — but git add should still block
      const meta = makeTestMeta({ sessionAllowedWritePaths: ["docs/file.md"] });
      const ctx = createMockCtx(meta);

      const mockExecFn: ExecFn = async () => ({
        stdout: "add 'docs/file.md'\n",
        stderr: "",
        code: 0,
      });

      ctx.toolCall = { name: "bash", arguments: { command: "git add docs/file.md" } };
      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      // git add should still be blocked despite session allowance
      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("git add");
      // Note: intentionally NOT deleting TMP to avoid breaking module-level auditDirPath
    });
  });

  // ─── Phase 1: write/edit ask override on stage whitelist block ───────────────
  describe("write/edit ask override on stage whitelist block (Phase 1)", () => {
    const ASK_OPTIONS = [
      "Follow plugin default rules (default)",
      "Allow this edit only",
      "Allow edits for this session",
    ];

    it("whitelist block + hardcoded protected path (AGENTS.md via protect.paths) + ask=true + allow_once → pass + audit allow_once", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-wl-ask-hardcoded-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true, paths: ["AGENTS.md"] },
      });
      // clarify: whitelist = docs/ only (does NOT include AGENTS.md)
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = createMockCtx(meta, { selectReturn: ASK_OPTIONS[1] });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "AGENTS.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("pipeline_protect_ask");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("whitelist block + hardcoded protected path (AGENTS.md via protect.paths) + ask=true + Esc fast → block with whitelist reason + action=dismissed", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-wl-ask-hardcoded-esc-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true, paths: ["AGENTS.md"] },
      });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = createMockCtx(meta, { selectReturn: undefined });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "AGENTS.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");

      // Phase 4 (173) C11: fast undefined → dismissed (not canceled)
      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=dismissed");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("whitelist block + non-protected path (src/app.ts) + ask=true → block, select not triggered", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-wl-nonprotected-" + Date.now());
      await mkdir(join(TMP, "src"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true },
      });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return ASK_OPTIONS[1]; };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "src", "app.ts") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");
      // Non-protected path → no ask popup
      expect(selectCalls).toBe(0);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("session allowance early bypass: sessionAllowedWritePaths contains .pi/config.json → pass without select", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-session-bypass-" + Date.now());
      await mkdir(join(TMP, ".pi"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true },
      });
      // clarify whitelist does NOT include .pi/
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "clarify",
        sessionAllowedWritePaths: [".pi/config.json"],
      });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return undefined; };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Session bypass → no whitelist check, no ask
      expect(result).toBeUndefined();
      expect(selectCalls).toBe(0);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("whitelist block + gitignore protected path + ask=true + allow → pass", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-wl-gitignore-ask-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "file.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      // clarify whitelist does NOT include docs/
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["src/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = createMockCtx(meta, { selectReturn: ASK_OPTIONS[1] });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // whitelist block + gitignore protected + ask=true + allow_once → pass
      expect(result).toBeUndefined();

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("regression: ask=false + whitelist block + protected path → direct block, no popup", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-ask-false-wl-block-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: false, paths: ["AGENTS.md"] },
      });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return ASK_OPTIONS[1]; };
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "AGENTS.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");
      expect(selectCalls).toBe(0);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("regression: full mode (**) + hardcoded protected + ask=true → existing global chain ask", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-full-mode-hardcoded-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true, paths: ["AGENTS.md"] },
      });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["**"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = createMockCtx(meta, { selectReturn: ASK_OPTIONS[1] });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "AGENTS.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Full mode: hardcoded path hits global chain ask (not whitelist ask)
      expect(result).toBeUndefined();

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });
  });

  // ─── Phase 2: bash ask override on stage whitelist block ─────────────────────
  describe("bash ask override on stage whitelist block (Phase 2)", () => {
    const ASK_OPTIONS = [
      "Follow plugin default rules (default)",
      "Allow this edit only",
      "Allow edits for this session",
    ];

    it("bash rm AGENTS.md (whitelist block) + ask=true + allow → pass", async () => {
      const TMP = join(tmpdir(), "pi-tg-p2-bash-rm-ask-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "content");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true, paths: ["AGENTS.md"] },
      });
      // clarify: whitelist = docs/ only (does NOT include AGENTS.md)
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      const ctx = createMockCtx(meta, { selectReturn: ASK_OPTIONS[1] });
      ctx.toolCall = { name: "bash", arguments: { command: "rm AGENTS.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("bash redirect to non-protected path + whitelist block + ask=true → block without popup", async () => {
      const TMP = join(tmpdir(), "pi-tg-p2-bash-nonprotected-" + Date.now());
      await mkdir(join(TMP, "src"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true },
      });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "clarify" });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return ASK_OPTIONS[1]; };
      ctx.toolCall = { name: "bash", arguments: { command: "echo hi > src/x.ts" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");
      expect(selectCalls).toBe(0);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("bash session allowance early bypass: sessionAllowedWritePaths contains target → pass without select", async () => {
      const TMP = join(tmpdir(), "pi-tg-p2-bash-session-bypass-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "content");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true, paths: ["AGENTS.md"] },
      });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        allowedWritePaths: ["docs/"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "clarify",
        sessionAllowedWritePaths: ["AGENTS.md"],
      });
      let selectCalls = 0;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => { selectCalls++; return undefined; };
      ctx.toolCall = { name: "bash", arguments: { command: "rm AGENTS.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      expect(selectCalls).toBe(0);
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("regression: existing bash global-chain ask (gitignore + ask=true) still works", async () => {
      const TMP = join(tmpdir(), "pi-tg-p2-bash-regression-gitignore-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "a.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      // Full mode (no whitelist restriction)
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["**"],
      } as any;
      await initAuditLog(config);

      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = createMockCtx(meta, { selectReturn: ASK_OPTIONS[1] });
      ctx.toolCall = { name: "bash", arguments: { command: "rm docs/a.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Global chain ask still triggers for gitignore protected path
      expect(result).toBeUndefined();

      const logContent = await readFile(auditLogFileFor(join(TMP, ".pi", "audit")), "utf-8");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });
  });
});
