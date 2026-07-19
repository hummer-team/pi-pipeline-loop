import { describe, it, expect } from "bun:test";
import { createSessionStarter } from "../../core/session-starter";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMetadata: () => meta,
      updateMetadata: (m: any) => {
        updates.push(m);
        Object.assign(meta, m);
      },
      setModel: async (_model: string) => {},
    },
    updates,
    ui: { notify: () => {} },
  };
}

describe("createSessionStarter", () => {
  it("creates a hook with event 'session_start'", () => {
    const hook = createSessionStarter(makeTestConfig());
    expect(hook.event).toBe("session_start");
  });

  describe("new session initialization", () => {
    it("initializes metadata for new pipeline with domain from file", async () => {
      const TMP = join(tmpdir(), "pi-ss-init-" + Date.now());
      const domainDir = join(TMP, ".pi", "domains");
      await mkdir(domainDir, { recursive: true });
      await writeFile(join(domainDir, "domain.md"), "---\nid: ecommerce\nversion: 2.0\n---\n# Domain");

      const config = makeTestConfig({ projectRoot: TMP });
      const ctx = createCtx({});

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      const meta = ctx.updates[0];
      expect(meta.currentStage).toBe("clarify");
      expect(meta.pipelineId).toMatch(/^pipe-/);
      expect(meta.domain.id).toBe("ecommerce");
      expect(meta.domain.version).toBe("2.0");
    });

    it("uses default domain when domain file is missing", async () => {
      const TMP = join(tmpdir(), "pi-ss-default-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      const ctx = createCtx({});

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(ctx.updates[0].domain.id).toBe("general");
      expect(ctx.updates[0].domain.version).toBe("latest");
    });

    it("uses config.maxLoops for maxLoops if specified", async () => {
      const TMP = join(tmpdir(), "pi-ss-maxloops-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP, maxLoops: 5 });
      const ctx = createCtx({});

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(ctx.updates[0].maxLoops).toBe(5);
    });

    it("sets model for clarify stage if configured", async () => {
      const TMP = join(tmpdir(), "pi-ss-model-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["clarify"] = { ...config.stages["clarify"], model: "claude-sonnet" } as any;
      const ctx = createCtx({});

      let modelSet = "";
      ctx.session.setModel = async (m: string) => { modelSet = m; };

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(modelSet).toBe("claude-sonnet");
    });

    it("parses domain from filename when no frontmatter", async () => {
      const TMP = join(tmpdir(), "pi-ss-nofm-" + Date.now());
      const domainDir = join(TMP, ".pi", "domains");
      await mkdir(domainDir, { recursive: true });
      await writeFile(join(domainDir, "domain.md"), "# Just a markdown file without frontmatter");

      const config = makeTestConfig({ projectRoot: TMP });
      const ctx = createCtx({});

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(ctx.updates[0].domain.id).toBe("domain");
    });
  });

  describe("session resume", () => {
    it("sets the correct model on resume", async () => {
      const config = makeTestConfig();
      config.stages["design"] = { ...config.stages["design"], model: "gpt-4o" } as any;
      const meta = makeTestMeta({ currentStage: "design" });
      const ctx = createCtx(meta);

      let modelSet = "";
      ctx.session.setModel = async (m: string) => { modelSet = m; };

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(modelSet).toBe("gpt-4o");
    });

    it("does not overwrite metadata on resume", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "review", pipelineId: "existing-pipe-1" });
      const ctx = createCtx(meta);

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(ctx.updates.length).toBe(0);
    });
  });
});
