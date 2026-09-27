import { describe, it, expect, beforeEach } from "bun:test";
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

    it("bash: redirect to path outside project root in whitelist mode → allowed (Phase 2: redirect-class out-of-project bypass)", async () => {
      const TMP = join(tmpdir(), "pi-tg-wl-bash-outside-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["docs/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      // Absolute path outside project root via bash redirect — Phase 2 allows this
      ctx.toolCall = { name: "bash", arguments: { command: "echo hi > /tmp/outside-x.md" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // Phase 2 (139): redirect-class out-of-project targets are allowed
      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });
  });

  // ─── Phase 2 (139): FORBIDDEN false-positive fix ──────────────────────────────
  describe("Phase 2: fd redirect and /dev/* non-write-target handling", () => {
    it("bash: 2>&1 does NOT produce any target (no block)", async () => {
      const TMP = join(tmpdir(), "pi-tg-p2-fd-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["src/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "bun run test 2>&1" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // 2>&1 is fd redirect, no write target → should not block
      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("bash: > /dev/null does NOT produce any target (no block)", async () => {
      const TMP = join(tmpdir(), "pi-tg-p2-devnull-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["src/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "echo hi > /dev/null" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // /dev/null is a device path → no write target → should not block
      expect(result).toBeUndefined();
      await rm(TMP, { recursive: true, force: true });
    });

    it("bash: rm /etc/xxx still blocked (file-arg class, out-of-project)", async () => {
      const TMP = join(tmpdir(), "pi-tg-p2-rm-etc-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["develop"] = {
        ...config.stages["develop"],
        allowedWritePaths: ["src/"],
      } as any;

      const meta = makeTestMeta();
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm /etc/xxx" } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      // file-arg class rm targeting /etc/xxx → blocked by destructive check
      expect((result as any).block).toBe(true);
      await rm(TMP, { recursive: true, force: true });
    });
  });

  // ─── Phase 1 / 177 (D3): suspicious bash write target → ask fallback ───────
  describe("Phase 1 / 177 (D3): suspicious write target ask fallback", () => {
    it("suspicious target + allow_once → pass", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
      const ctx = createMockCtx(meta, { selectReturn: "Allow this command once" });
      ctx.toolCall = { name: "bash", arguments: { command: "echo x > ids," } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
    });

    it("suspicious target + deny → block + violation", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
      const ctx = createMockCtx(meta, { selectReturn: "Follow default rules (block, default)" });
      ctx.toolCall = { name: "bash", arguments: { command: "echo x > ids," } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations).toHaveLength(1);
    });

    it("suspicious target + dismissed → block without violation", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "echo x > ids," } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect((result as any).block).toBe(true);
      const finalMeta = ctx.session.getMeta() as any;
      expect(finalMeta.violations ?? []).toHaveLength(0);
    });

    it("heredoc body is not parsed as a write target (no ask, no block)", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "develop", flowState: "running" });
      let selectCalled = false;
      const ctx = createMockCtx(meta);
      ctx.ui.select = async () => {
        selectCalled = true;
        return undefined;
      };
      const command = "cat >> docs/design/94_Bug.md <<'EOF'\n ...List<String> ids,...\nEOF";
      ctx.toolCall = { name: "bash", arguments: { command } };

      const hook = createToolGuard(config);
      const result = await hook.handler(ctx as any);

      expect(result).toBeUndefined();
      expect(selectCalled).toBe(false);
    });
  });
});
