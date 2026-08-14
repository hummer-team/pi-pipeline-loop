import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetGitignoreCache } from "../../utils/gitignore";
import type { ExecFn } from "../../types";

describe("createToolGuard", () => {
  beforeEach(() => {
    resetGitignoreCache();
  });

  it("creates a hook with event 'tool_call'", () => {
    const hook = createToolGuard(makeTestConfig());
    expect(hook.event).toBe("tool_call");
  });

  describe("tool permission check", () => {
    it("blocks disallowed tools", async () => {
      const config = makeTestConfig();
      config.stages["develop"] = { ...config.stages["develop"], allowedTools: ["bash"] } as any;
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "write", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      expect((result as any).reason).toContain("not allowed");
    });

    it("allows tools in the allowed list", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "read", arguments: {} };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
    });
  });

  describe("bash command prefix check", () => {
    it("allows commands matching allowed prefix", async () => {
      const config = makeTestConfig();
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedBashPrefixes: ["ls", "npm test"],
      } as any;
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "ls -la" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
    });

    it("blocks commands not matching any prefix", async () => {
      const config = makeTestConfig();
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedBashPrefixes: ["ls"],
      } as any;
      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
    });
  });

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
        allowedBashPrefixes: ["echo", "rm", "git"],
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
        allowedBashPrefixes: ["echo", "rm", "git"],
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
    it("protection block does not update meta or freeze pipeline", async () => {
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
      // No metadata updates
      expect(ctx.metadataUpdates.length).toBe(0);
      // Loop count unchanged
      expect(meta.loopCount).toBe(initialLoopCount);
      // Stage unchanged
      expect(meta.currentStage).toBe(initialStage);
      // Not terminated
      expect(meta.terminated).toBeUndefined();

      await rm(TMP, { recursive: true, force: true });
    });
  });
});
