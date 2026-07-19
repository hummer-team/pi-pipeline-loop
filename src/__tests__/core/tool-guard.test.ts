import { describe, it, expect } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("createToolGuard", () => {
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
  });
});
