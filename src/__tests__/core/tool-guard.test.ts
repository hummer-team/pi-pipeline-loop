import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import type { ExecFn } from "../../types";

describe("createToolGuard", () => {
  beforeEach(() => {
    resetGitignoreCache();
  });

  it("creates a hook with event 'tool_call'", () => {
    const hook = createToolGuard(makeTestConfig());
    expect(hook.event).toBe("tool_call");
  });

  // Tool permission check removed in Phase 0 (D0) — tools are no longer restricted
  // Bash command prefix check removed in Phase 0 (D0) — commands no longer checked against prefix allowlist
  // Tests for these features have been removed accordingly.

  describe("freeze state check", () => {
    it("blocks all tools when pipeline is awaiting_human", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "awaiting_human" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "read", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("frozen");
    });

    it("blocks all tools when flowState is blocked", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "read", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("frozen");
      expect((result as any).reason).toContain("ctrl+enter");
    });

    it("blocks all tools when flowState is aborted", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ flowState: "aborted" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "read", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("aborted");
    });

    it("blocks with custom shortcut key in reason message", async () => {
      const config = makeTestConfig({ decisionShortcutKey: "alt+f" });
      const meta = makeTestMeta({ flowState: "blocked" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "read", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("alt+f");
    });
  });

  describe("file write protection", () => {
    it("blocks writes to .pi/", async () => {
      const TMP = join(tmpdir(), "pi-tg-pi-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("FORBIDDEN");
    });

    it("blocks writes to AGENTS.md", async () => {
      const TMP = join(tmpdir(), "pi-tg-agents-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "edit", arguments: { file_path: join(TMP, "AGENTS.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
    });

    it("allows writes to unprotected paths and records oldHash", async () => {
      const TMP = join(tmpdir(), "pi-tg-allow-" + Date.now());
      await mkdir(join(TMP, "src"), { recursive: true });
      await writeFile(join(TMP, "src", "app.ts"), "test content");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "src", "app.ts") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      expect(typeof (ctx.toolCall as any).oldHash).toBe("string");
      expect((ctx.toolCall as any).oldHash).toHaveLength(64);
    });

    it("blocks writes to gitignore-protected paths", async () => {
      const TMP = join(tmpdir(), "pi-tg-gitignore-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("gitignore protected");

      await rm(TMP, { recursive: true, force: true });
    });

    it("allows writes to gitignore-protected paths when in allow list", async () => {
      const TMP = join(tmpdir(), "pi-tg-allow-gitignore-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "file.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { allow: ["docs/"] },
      });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
    });

    it("hardcoded protection cannot be exempted by allow list", async () => {
      const TMP = join(tmpdir(), "pi-tg-hardcoded-" + Date.now());
      await mkdir(join(TMP, ".pi"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { allow: [".pi/"] }, // Try to exempt
      });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("hardcoded protected");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("bash file modification protection", () => {
    it("blocks bash redirect to gitignore-protected path", async () => {
      const TMP = join(tmpdir(), "pi-tg-bash-redirect-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({ projectRoot: TMP });
      // Override develop stage to allow echo command
      config.stages["develop"] = {
        ...config.stages["develop"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "echo hi > docs/x.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("Bash command modifies protected path");

      await rm(TMP, { recursive: true, force: true });
    });

    it("blocks bash rm to gitignore-protected path", async () => {
      const TMP = join(tmpdir(), "pi-tg-bash-rm-" + Date.now());
      await mkdir(join(TMP, "logs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "logs\n");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm logs/app.log" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);

      await rm(TMP, { recursive: true, force: true });
    });

    it("allows bash modification to allow-listed paths", async () => {
      const TMP = join(tmpdir(), "pi-tg-bash-allow-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { allow: ["docs/"] },
      });
      // Override develop stage to allow echo command
      config.stages["develop"] = {
        ...config.stages["develop"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "echo hi > docs/x.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("git add protection", () => {
    it("blocks git add that would stage protected path", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-add-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "secrets\n");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add AGENTS.md" } };

      // Mock execFn that simulates git add --dry-run output
      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "add" && args[1] === "--dry-run") {
          return { stdout: "add 'AGENTS.md'\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("'git add' would stage protected path");

      await rm(TMP, { recursive: true, force: true });
    });

    it("blocks git add for user-configured protect.paths (Problem 1 fix)", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-add-userpath-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { paths: ["dist/"] },
      });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add dist/bundle.js" } };

      // Mock execFn that simulates git add --dry-run output
      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "add" && args[1] === "--dry-run") {
          return { stdout: "add 'dist/bundle.js'\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("'git add' would stage protected path");

      await rm(TMP, { recursive: true, force: true });
    });

    it("allows git add for safe paths", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-add-safe-" + Date.now());
      await mkdir(join(TMP, "src"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add src/index.ts" } };

      // Mock execFn that simulates safe git add --dry-run output
      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "add" && args[1] === "--dry-run") {
          return { stdout: "add 'src/index.ts'\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
    });

    it("fail-closed blocks git add when execFn is missing", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-add-noexec-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add ." } };

      // No execFn provided
      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("execFn not available");

      await rm(TMP, { recursive: true, force: true });
    });

    it("provides precise reason when dry-run fails with ignored hint (Problem 12 fix)", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-add-ignored-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "dist\n");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add dist/bundle.js" } };

      // Mock execFn: dry-run fails with stderr hint about ignored files
      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "add" && args[1] === "--dry-run") {
          return { stdout: "", stderr: "The following paths are ignored:\ndist/bundle.js\n", code: 1 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("rejected by git");
      expect((result as any).reason).toContain("ignored");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("git commit protection", () => {
    it("blocks git commit with staged protected path", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-commit-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git commit -m 'test'" } };

      // Mock execFn that simulates git diff --cached output
      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "diff" && args[1] === "--cached") {
          return { stdout: "AGENTS.md\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("'git commit' includes protected path");

      await rm(TMP, { recursive: true, force: true });
    });

    it("blocks git commit -a with unstaged protected path", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-commit-a-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "logs\n");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git commit -a -m 'test'" } };

      // Mock execFn: cached diff is empty, unstaged diff has protected file
      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "diff" && args[1] === "--cached") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") {
          return { stdout: "logs/app.log\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("'git commit -a' includes protected path");

      await rm(TMP, { recursive: true, force: true });
    });

    it("blocks git commit -am (combined flag) with unstaged protected path (Problem 2 fix)", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-commit-am-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "logs\n");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git commit -am 'test msg'" } };

      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "diff" && args[1] === "--cached") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") {
          return { stdout: "logs/app.log\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("'git commit -a' includes protected path");

      await rm(TMP, { recursive: true, force: true });
    });

    it("blocks git commit -A (uppercase) with unstaged protected path (Problem 2 fix)", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-commit-A-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "logs\n");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git commit -A -m 'test'" } };

      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "diff" && args[1] === "--cached") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") {
          return { stdout: "logs/app.log\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("'git commit -a' includes protected path");

      await rm(TMP, { recursive: true, force: true });
    });

    it("fail-closed blocks git commit when execFn is missing", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-commit-noexec-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git commit -m 'test'" } };

      // No execFn provided
      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("execFn not available");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("TUI notifications", () => {
    it("sends TUI notification on protection block when pipelineStage is true", async () => {
      const TMP = join(tmpdir(), "pi-tg-notify-" + Date.now());
      await mkdir(join(TMP, ".pi"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        output: { pipelineStage: true },
      });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect(ctx.notifications.length).toBeGreaterThan(0);
      expect(ctx.notifications[0]).toContain("FORBIDDEN");

      await rm(TMP, { recursive: true, force: true });
    });

    it("does not send TUI notification when pipelineStage is false", async () => {
      const TMP = join(tmpdir(), "pi-tg-no-notify-" + Date.now());
      await mkdir(join(TMP, ".pi"), { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        output: { pipelineStage: false },
      });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect(ctx.notifications.length).toBe(0);

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("R4Q2 no side effects", () => {
    it("protection block does not freeze pipeline or increment loop count (violations recording allowed)", async () => {
      const TMP = join(tmpdir(), "pi-tg-no-sideffect-" + Date.now());
      await mkdir(join(TMP, ".pi"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta();
      const initialLoopCount = meta.loopCount;
      const initialStage = meta.currentStage;

      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      // Violations recording IS a metadata update (R4Q2 relaxed: pure recording allowed)
      expect(ctx.metadataUpdates.length).toBeGreaterThanOrEqual(1);
      // Loop count unchanged
      expect(meta.loopCount).toBe(initialLoopCount);
      // Stage unchanged
      expect(meta.currentStage).toBe(initialStage);
      // Not terminated
      expect(meta.terminated).toBeUndefined();
      // Violation was recorded
      const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
      expect(lastUpdate.violations).toBeDefined();
      expect(lastUpdate.violations!.length).toBe(1);
      expect(lastUpdate.violations![0].type).toBe("write_protected");

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("git channel config respect", () => {
    it("respects protect.gitignore=false for git add (Problem 3 fix)", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-no-gitignore-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "logs\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: false },
      });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add logs/app.log" } };

      // Mock execFn: dry-run shows gitignored file
      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "add" && args[1] === "--dry-run") {
          return { stdout: "add 'logs/app.log'\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      // When gitignore is disabled, gitignored paths should NOT be blocked for git
      expect(result).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
    });

    it("still blocks hardcoded paths when gitignore is disabled", async () => {
      const TMP = join(tmpdir(), "pi-tg-git-hardcoded-nogi-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: false },
      });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add AGENTS.md" } };

      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "add" && args[1] === "--dry-run") {
          return { stdout: "add 'AGENTS.md'\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);

      await rm(TMP, { recursive: true, force: true });
    });
  });

  describe("stage write whitelist (allowedWritePaths)", () => {
    it("write: whitelist hit on docs/ → allowed", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-hit-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, "docs", "plan.md"), "");

      const config = makeTestConfig({ projectRoot: TMP });
      // clarify stage with whitelist restricted to docs/
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "plan.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("write: whitelist miss on src/ → blocked", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-miss-" + Date.now());
      await mkdir(join(TMP, "src"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "src", "app.ts") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");
      expect((result as any).reason).toContain("develop");
      await rm(TMP, { recursive: true, force: true });
    });

    it("write: allowedWritePaths=['**'] → full access (global protect applies)", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-all-" + Date.now());
      await mkdir(join(TMP, "src"), { recursive: true });
      await writeFile(join(TMP, "src", "app.ts"), "");

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["**"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "src", "app.ts") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("write: allowedWritePaths=[] → completely forbidden", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-empty-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: [],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "plan.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");
      await rm(TMP, { recursive: true, force: true });
    });

    it("write: hardcoded path blocked even if whitelist hits", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-hardcoded-" + Date.now());
      await mkdir(join(TMP, ".pi"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      // Whitelist includes ".pi/" — but hardcoded should still block
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: [".pi/", "docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("hardcoded protected");
      await rm(TMP, { recursive: true, force: true });
    });

    it("bash: redirect to whitelisted docs/ → allowed", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-bash-hit-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "echo hi > docs/x.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("bash: redirect to non-whitelisted src/ → blocked", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-bash-miss-" + Date.now());
      await mkdir(join(TMP, "src"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "echo hi > src/x.ts" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");
      await rm(TMP, { recursive: true, force: true });
    });

    it("bash: rm on whitelisted docs/ → allowed (rm is modification)", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-bash-rm-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, "docs", "old.md"), "content");

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm docs/old.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("exemption: docs/ in gitignore but in stage whitelist → write allowed", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-gitignore-exempt-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");
      await writeFile(join(TMP, "docs", "file.md"), "");

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Whitelist exempts from gitignore write protection
      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("git add still blocked by global git protection even if path in whitelist", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-git-add-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add docs/file.md" } };

      // git add dry-run shows docs/file.md would be staged
      const mockExecFn: ExecFn = async (cmd, args, cwd) => {
        if (cmd === "git" && args[0] === "add" && args[1] === "--dry-run") {
          return { stdout: "add 'docs/file.md'\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      const result = await hook.handler(ctx as any);

      // git add channel uses global git protection (allow does NOT exempt)
      // docs/ is gitignored → git add is blocked
      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("'git add' would stage protected path");
      await rm(TMP, { recursive: true, force: true });
    });

    it("write: absolute path outside project root in whitelist mode → blocked", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-outside-abs-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      // Absolute path clearly outside project root
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/outside-x.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("outside project root");
      expect((result as any).reason).toContain("develop");
      await rm(TMP, { recursive: true, force: true });
    });

    it("write: relative path escaping project root in whitelist mode → blocked", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-outside-rel-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      // Relative path that escapes project root via ../
      ctx.toolCall = { name: "write", arguments: { file_path: "../../outside/x.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("outside project root");
      expect((result as any).reason).toContain("develop");
      await rm(TMP, { recursive: true, force: true });
    });

    it("write: path outside project root in full mode (['**']) → allowed (legacy)", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-outside-full-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["**"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      // Absolute path outside project root, but full mode should not block
      ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/outside-legacy.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Full mode: out-of-project paths bypass stage whitelist (legacy behavior)
      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("bash: redirect to path outside project root in whitelist mode → blocked", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-bash-outside-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      // Absolute path outside project root via bash redirect
      ctx.toolCall = { name: "bash", arguments: { command: "echo hi > /tmp/outside-x.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("outside project root");
      expect((result as any).reason).toContain("develop");
      await rm(TMP, { recursive: true, force: true });
    });
  });

  // ─── protect.ask TUI decision flow ──────────────────────────────────────────
  describe("protect.ask interactive approval", () => {
    const ASK_OPTIONS = [
      "Follow plugin default rules (default)",
      "Allow this edit only",
      "Allow edits for this session",
    ];

    it("ask=true + write hits gitignore → follow_default → block + audit action=follow_default", async () => {
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

      // Verify audit
      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(logContent).toContain("pipeline_protect_ask");
      expect(logContent).toContain("action=follow_default");
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

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
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

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
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

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(logContent).toContain("action=allow_once");
      expect(logContent).toContain("action=follow_default");
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
        const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
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

    it("Esc / no UI → block + audit action=canceled", async () => {
      const TMP = join(tmpdir(), "pi-tg-ask-esc-" + Date.now());
      await mkdir(join(TMP, "docs"), { recursive: true });
      await writeFile(join(TMP, ".gitignore"), "docs\n");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { gitignore: true, ask: true },
      });
      await initAuditLog(config);

      const meta = makeTestMeta();
      // select returns undefined (Esc)
      const ctx = createMockCtx(meta, { selectReturn: undefined });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "docs", "file.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(logContent).toContain("action=canceled");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("ask=true select throws → logged via console.error + fail-safe block + audit action=canceled", async () => {
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

        // Fail-safe: select error → block (same as canceled)
        expect((result as any).block).toBe(true);

        // console.error should have been called with diagnostic info
        expect(captured.some(msg => msg.includes("askProtectDecision") && msg.includes("docs/file.md"))).toBe(true);

        // Audit still written with action=canceled
        const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
        expect(logContent).toContain("action=canceled");
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

    it("whitelist block + hardcoded protected path (AGENTS.md) + ask=true + allow_once → pass + audit allow_once", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-wl-ask-hardcoded-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: true },
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

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(logContent).toContain("pipeline_protect_ask");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("whitelist block + hardcoded protected path (AGENTS.md) + ask=true + Esc → block with whitelist reason", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-wl-ask-hardcoded-esc-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "");

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
      const ctx = createMockCtx(meta, { selectReturn: undefined });
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP, "AGENTS.md") } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not in allowed write paths");

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(logContent).toContain("action=canceled");
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

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });

    it("regression: ask=false + whitelist block + protected path → direct block, no popup", async () => {
      const TMP = join(tmpdir(), "pi-tg-p1-ask-false-wl-block-" + Date.now());
      await mkdir(TMP, { recursive: true });
      await writeFile(join(TMP, "AGENTS.md"), "");

      const config = makeTestConfig({
        projectRoot: TMP,
        protect: { ask: false },
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
        protect: { ask: true },
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

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
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
        protect: { ask: true },
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

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
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
        protect: { ask: true },
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

      const logContent = await readFile(join(TMP, ".pi", "audit", getDateAuditFileName()), "utf-8");
      expect(logContent).toContain("action=allow_once");
      // Note: TMP intentionally not deleted — initAuditLog sets module-level auditDirPath
    });
  });

  // ─── Phase 5: violation recording tests ──────────────────────────────────
  // Note: tool_not_allowed and bash_prefix violation types removed in Phase 0 (D0)

  describe("violation recording (Phase 5 Task 2)", () => {
    it("git_protected records a violation for git add on protected path", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "git add .pi/config.json" } };

      // Mock execFn: dry-run shows protected path
      const mockExecFn: ExecFn = async (_cmd, args, _cwd) => {
        if (args[0] === "add" && args[1] === "--dry-run") {
          return { stdout: "add '.pi/config.json'\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const hook = createToolGuard(config, { execFn: mockExecFn });
      await hook.handler(ctx as any);

      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations).toBeDefined();
      expect(finalMeta.violations.length).toBe(1);
      expect(finalMeta.violations[0].type).toBe("git_protected");
      expect(finalMeta.violations[0].tool).toBe("bash");
      expect(finalMeta.violations[0].suggestion).toContain("git add");
    });

    it("frozen state does NOT record a violation (flow-state, not model violation)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const ctx = createMockCtx(meta);
      // "read" is allowed so passes step 1, not bash so skips step 2,
      // then hits step 3 (freeze check) → blocks without recording a violation
      ctx.toolCall = { name: "read", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations).toBeUndefined();
    });

    it("write_protected (hardcoded) records a violation", async () => {
      const TMP2 = join(tmpdir(), "pi-tg-write-viol-" + Date.now());
      await mkdir(join(TMP2, ".pi"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP2 });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: { file_path: join(TMP2, ".pi", "config.json") } };

      const hook = createToolGuard(config);
      await hook.handler(ctx as any);

      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations).toBeDefined();
      expect(finalMeta.violations.length).toBe(1);
      expect(finalMeta.violations[0].type).toBe("write_protected");
      expect(finalMeta.violations[0].tool).toBe("write");
      expect(finalMeta.violations[0].detail).toContain("hardcoded protected");

      await rm(TMP2, { recursive: true, force: true });
    });
  });

  // ─── Phase 1: Destructive command interception tests ────────────────────────
  describe("destructive command interception", () => {
    it("blocks rm -rf / and records bash_destructive violation", async () => {
      const TMP2 = join(tmpdir(), "pi-tg-destruct-" + Date.now());
      await mkdir(TMP2, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP2, protect: { ask: false } });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("Destructive command blocked");
      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations).toBeDefined();
      expect(finalMeta.violations[0].type).toBe("bash_destructive");

      await rm(TMP2, { recursive: true, force: true });
    });

    it("blocks rm -rf /* (root glob pattern)", async () => {
      const TMP2 = join(tmpdir(), "pi-tg-destruct2-" + Date.now());
      await mkdir(TMP2, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP2, protect: { ask: false } });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /*" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("Destructive command blocked");

      await rm(TMP2, { recursive: true, force: true });
    });

    it("blocks rm -rf --no-preserve-root / (GNU delete-root command)", async () => {
      const TMP2 = join(tmpdir(), "pi-tg-destruct3-" + Date.now());
      await mkdir(TMP2, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP2, protect: { ask: false } });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm -rf --no-preserve-root /" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("Destructive command blocked");

      await rm(TMP2, { recursive: true, force: true });
    });

    it("blocks chmod -R 777 /* (permission change on root glob)", async () => {
      const TMP2 = join(tmpdir(), "pi-tg-destruct4-" + Date.now());
      await mkdir(TMP2, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP2, protect: { ask: false } });
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "chmod -R 777 /*" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("Destructive command blocked");

      await rm(TMP2, { recursive: true, force: true });
    });

    it("allows previously session-allowed destructive commands within project", async () => {
      const TMP2 = join(tmpdir(), "pi-tg-destruct5-" + Date.now());
      await mkdir(TMP2, { recursive: true });
      await mkdir(join(TMP2, "node_modules"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP2, protect: { ask: false } });
      // Command already allowed in session
      const meta = makeTestMeta({ sessionAllowedCommands: ["rm -rf node_modules"] });
      const ctx = createMockCtx(meta);
      // A less dangerous command that is session-allowed and within project
      ctx.toolCall = { name: "bash", arguments: { command: "rm -rf node_modules" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Should not block because command is session-allowed AND not targeting system paths
      expect((result as any)?.block).not.toBe(true);

      await rm(TMP2, { recursive: true, force: true });
    });

    it("full-mode still blocks destructive commands targeting system paths", async () => {
      const TMP2 = join(tmpdir(), "pi-tg-destruct6-" + Date.now());
      await mkdir(TMP2, { recursive: true });

      // Full mode: allowedWritePaths = ["**"]
      const config = makeTestConfig({
        projectRoot: TMP2,
        protect: { ask: false },
        stages: {
          develop: {
            agentFile: "a.md",
            skillPath: "s.md",
            nextStage: "review",
            requireDomain: false,
            allowedWritePaths: ["**"],
          },
        } as any,
      });
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = createMockCtx(meta);
      // Command targeting /etc (system path) outside project root
      ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /etc/passwd" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Should be blocked - either by destructive command pattern or system path check
      expect((result as any).block).toBe(true);
      // The message could be either "Destructive command" (pattern match) or "system path" (Tier 2)
      expect((result as any).reason).toMatch(/Destructive command|system path/);

      await rm(TMP2, { recursive: true, force: true });
    });

    it("full-mode blocks rm -rf / targeting root directory", async () => {
      const TMP2 = join(tmpdir(), "pi-tg-destruct7-" + Date.now());
      await mkdir(TMP2, { recursive: true });

      // Full mode: allowedWritePaths = ["**"]
      const config = makeTestConfig({
        projectRoot: TMP2,
        protect: { ask: false },
        stages: {
          develop: {
            agentFile: "a.md",
            skillPath: "s.md",
            nextStage: "review",
            requireDomain: false,
            allowedWritePaths: ["**"],
          },
        } as any,
      });
      const meta = makeTestMeta({ currentStage: "develop" });
      const ctx = createMockCtx(meta);
      // Command targeting / (root) - this is caught by destructive pattern matching first
      ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Should be blocked by destructive command pattern check
      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("Destructive command");

      await rm(TMP2, { recursive: true, force: true });
    });
  });
});
