import { describe, it, expect } from "bun:test";
import { createSessionStarter } from "../../core/session-starter";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { resetPromptConfigCache, loadPromptConfig } from "../../core/prompt-config";
import { registerSession } from "../../utils/session-registry";

function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (m: any) => {
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
      await initAuditLog(config);
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
      await initAuditLog(config);
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
      await initAuditLog(config);
      const ctx = createCtx({});

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(ctx.updates[0].maxLoops).toBe(5);
    });

    // NOTE: model management tests removed (Q4-A) — model is managed by user via /model command.
    // Phase 3 will add model_select event tests.

    it("parses domain from filename when no frontmatter", async () => {
      const TMP = join(tmpdir(), "pi-ss-nofm-" + Date.now());
      const domainDir = join(TMP, ".pi", "domains");
      await mkdir(domainDir, { recursive: true });
      await writeFile(join(domainDir, "domain.md"), "# Just a markdown file without frontmatter");

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const ctx = createCtx({});

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(ctx.updates[0].domain.id).toBe("domain");
    });

    it("writes audit log with session_start action", async () => {
      const TMP = join(tmpdir(), "pi-ss-audit-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const ctx = createCtx({});

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
      const content = await readFile(logPath, "utf-8");
      const line = content.trim().split("\n")[0];

      expect(line).toContain(" - [INFO] session_start");
      expect(line).toContain("pipelineId=");
      expect(line).toContain("stage=clarify");

      // Verify pipelineId in the log matches the one in metadata
      const meta = ctx.updates[0];
      expect(line).toContain(`pipelineId=${meta.pipelineId}`);
    });

    // Phase 0 (169) P1: new session must initialize stageVisitOrder to ["clarify"]
    // and explicitly clear spawnedStages + terminalCompact (no cross-run residue).
    it("new session initializes stageVisitOrder=['clarify'] and clears transient fields", async () => {
      const TMP = join(tmpdir(), "pi-ss-visit-init-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      const ctx = createCtx({});

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      const meta = ctx.updates[0];
      expect(meta.stageVisitOrder).toEqual(["clarify"]);
      // Explicit clears (P2-8): no residue from prior run
      expect(meta.spawnedStages).toBeUndefined();
      expect(meta.terminalCompact).toBeUndefined();
    });
  });

  describe("session resume", () => {
    it("does not overwrite metadata on resume", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "review", pipelineId: "existing-pipe-1" });
      const ctx = createCtx(meta);

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(ctx.updates.length).toBe(0);
    });

    it("notifies with blockedReason when resuming a frozen pipeline (no shortcut key)", async () => {
      const notifications: string[] = [];
      const config = makeTestConfig({ decisionShortcutKey: "ctrl+shift+d" });
      const meta = makeTestMeta({
        currentStage: "develop",
        pipelineId: "existing-pipe-1",
        flowState: "blocked",
        blockedReason: "loop_overflow",
      });
      const ctx = {
        ...createCtx(meta),
        ui: { notify: (msg: string) => { notifications.push(msg); } },
      };

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(notifications.length).toBe(1);
      expect(notifications[0]).toContain("blocked");
      expect(notifications[0]).toContain("loop_overflow");
      // Should NOT contain shortcut key
      expect(notifications[0]).not.toContain("ctrl+shift+d");
    });
  });

  describe("stale startup recovery", () => {
    const TMP_STALE = join(tmpdir(), "pi-ss-stale-" + Date.now());

    it("resets running flowState to aborted on reason='startup' and writes pipeline_stale_reset audit", async () => {
      await mkdir(TMP_STALE, { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP_STALE });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "develop",
        pipelineId: "pipe-stale-1",
        flowState: "running",
      });
      const ctx = {
        ...createCtx(meta),
        event: { reason: "startup" },
      };

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("aborted");
      expect(meta.terminateReason).toBe("stale_startup");

      // Verify pipeline_stale_reset audit
      const logPath = join(TMP_STALE, ".pi", "audit", getDateAuditFileName());
      const content = await readFile(logPath, "utf-8");
      expect(content).toContain("pipeline_stale_reset");
      expect(content).toContain("pipelineId=pipe-stale-1");
    });

    it("does NOT notify 'Pipeline blocked' after stale startup reset (aborted is not blocked)", async () => {
      const notifications: string[] = [];
      await mkdir(TMP_STALE, { recursive: true });
      const config = makeTestConfig({ projectRoot: TMP_STALE });
      await initAuditLog(config);

      const meta = makeTestMeta({
        currentStage: "develop",
        pipelineId: "pipe-stale-notify",
        flowState: "running",
      });
      const baseCtx = createCtx(meta);
      const ctx = {
        ...baseCtx,
        event: { reason: "startup" },
        ui: { notify: (_ctx: unknown, msg: string) => { notifications.push(msg); } },
      };

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      // Reset sets flowState to "aborted" — must NOT trigger the frozen/blocked
      // notification (isFrozen("aborted")===true but the correct action is
      // /pipeline-start, not the decision shortcut).
      expect(meta.flowState).toBe("aborted");
      expect(notifications.length).toBe(0);
    });

    it("does NOT reset when flowState is already 'aborted' on reason='startup'", async () => {
      const config = makeTestConfig({ projectRoot: TMP_STALE });
      const meta = makeTestMeta({
        currentStage: "develop",
        pipelineId: "pipe-stale-2",
        flowState: "aborted",
      });
      const ctx = {
        ...createCtx(meta),
        event: { reason: "startup" },
      };

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      // Should remain aborted, no updateMeta call
      expect(meta.flowState).toBe("aborted");
      expect(ctx.updates.length).toBe(0);
    });

    it("does NOT reset when reason is 'resume' even if flowState is 'running'", async () => {
      const config = makeTestConfig({ projectRoot: TMP_STALE });
      const meta = makeTestMeta({
        currentStage: "develop",
        pipelineId: "pipe-stale-3",
        flowState: "running",
      });
      const ctx = {
        ...createCtx(meta),
        event: { reason: "resume" },
      };

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("running");
      expect(ctx.updates.length).toBe(0);
    });

    it("resets when meta has no explicit flowState (default 'running') on reason='startup'", async () => {
      const config = makeTestConfig({ projectRoot: TMP_STALE });
      // Meta without flowState — getFlowState returns "running" by default
      const meta: Record<string, unknown> = { ...makeTestMeta({
        currentStage: "plan",
        pipelineId: "pipe-stale-4",
      }) };
      // Explicitly delete flowState to simulate old-format meta
      delete meta.flowState;

      const ctx = {
        ...createCtx(meta as any),
        event: { reason: "startup" },
      };

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(meta.flowState).toBe("aborted");
      expect(meta.terminateReason).toBe("stale_startup");
    });
  });

  describe("prompt-config cache warmup", () => {
    it("session_start preloads prompt-config cache", async () => {
      const TMP = join(tmpdir(), "pi-ss-warmup-" + Date.now());
      const refsDir = join(TMP, ".pi", "references");
      await mkdir(refsDir, { recursive: true });
      await writeFile(
        join(refsDir, "pipeline-stage-prompt.yml"),
        "clarify: test template\n",
        "utf-8",
      );

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      // Reset cache to ensure it's empty before session_start
      resetPromptConfigCache();

      const ctx = createCtx({});
      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      // After session_start, the cache should be loaded
      // Verify by loading config again — should return cached value
      const promptConfig = await loadPromptConfig(TMP);
      expect(promptConfig.clarify).toBe("test template");
    });

    it("session_start does not fail when yml file is missing", async () => {
      const TMP = join(tmpdir(), "pi-ss-no-yml-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      resetPromptConfigCache();

      const ctx = createCtx({});
      const hook = createSessionStarter(config);

      // Should not throw even when yml doesn't exist
      await expect(hook.handler(ctx as any)).resolves.toBeUndefined();

      // Cache should be loaded with empty config
      const promptConfig = await loadPromptConfig(TMP);
      expect(promptConfig).toEqual({});
    });
  });

  describe("subagent JOIN (Q7)", () => {
    /** Create a ctx with sessionManager mock for JOIN tests */
    function createJoinCtx(meta: Record<string, unknown>, opts: {
      parentSession?: string;
      sessionName?: string;
      sessionFile?: string;
      event?: Record<string, unknown>;
    }) {
      const updates: any[] = [];
      return {
        session: {
          getMeta: () => meta,
          updateMeta: (m: any) => {
            updates.push(m);
            Object.assign(meta, m);
          },
        },
        updates,
        ui: { notify: () => {}, setStatus: () => {} },
        _ctx: {
          sessionManager: {
            getBranch: () => [],
            getEntries: () => [],
            getHeader: opts.parentSession ? () => ({ parentSession: opts.parentSession }) : () => ({}),
            getSessionName: opts.sessionName ? () => opts.sessionName! : () => "",
            getSessionFile: opts.sessionFile ? () => opts.sessionFile! : () => "",
          },
        },
        event: opts.event,
      };
    }

    it("JOIN: header.parentSession + registry hit → inherits parent meta", async () => {
      const TMP = join(tmpdir(), "pi-ss-join-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit", "pipe-parent-1"), { recursive: true });
      const parentMeta = makeTestMeta({
        currentStage: "develop",
        pipelineId: "pipe-parent-1",
        stageStartTime: 1000000,
        advancedThisTurn: true,
      });
      await writeFile(
        join(TMP, ".pi", "audit", "pipe-parent-1", "meta.json"),
        JSON.stringify(parentMeta),
      );

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      await registerSession(config, "parent-session-file", "pipe-parent-1");

      const meta: Record<string, unknown> = {};
      const ctx = createJoinCtx(meta, {
        parentSession: "parent-session-file",
        sessionName: "code-review-agent#a1b2c3d4",
        sessionFile: "subagent-session-file",
      });

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(meta.currentStage).toBe("develop");
      expect(meta.pipelineId).toBe("pipe-parent-1");
      expect(meta.stageStartTime).toBe(1000000);
      expect(meta.pipelineId).not.toMatch(/^pipe-\d+-/);
    });

    it("JOIN: parentSession + registry miss → new pipeline + audit warn", async () => {
      const TMP = join(tmpdir(), "pi-ss-join-miss-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit"), { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta: Record<string, unknown> = {};
      const ctx = createJoinCtx(meta, {
        parentSession: "missing-parent-session",
        sessionFile: "subagent-file",
      });

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(meta.currentStage).toBe("clarify");
      expect(meta.pipelineId).toMatch(/^pipe-/);

      const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
      const content = await readFile(logPath, "utf-8");
      expect(content).toContain("session_join_missing_registry");
    });

    it("JOIN: fork signal (reason=fork) with parentSession → JOIN", async () => {
      const TMP = join(tmpdir(), "pi-ss-join-fork-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit", "pipe-fork-parent"), { recursive: true });
      const parentMeta = makeTestMeta({
        currentStage: "review",
        pipelineId: "pipe-fork-parent",
        stageStartTime: 2000000,
      });
      await writeFile(
        join(TMP, ".pi", "audit", "pipe-fork-parent", "meta.json"),
        JSON.stringify(parentMeta),
      );

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      await registerSession(config, "fork-parent-session", "pipe-fork-parent");

      const meta: Record<string, unknown> = {};
      const ctx = createJoinCtx(meta, {
        parentSession: "fork-parent-session",
        sessionFile: "fork-child-session",
        event: { reason: "fork" },
      });

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(meta.pipelineId).toBe("pipe-fork-parent");
      expect(meta.currentStage).toBe("review");
    });

    it("no subagent signal → existing new pipeline behavior", async () => {
      const TMP = join(tmpdir(), "pi-ss-no-join-" + Date.now());
      await mkdir(TMP, { recursive: true });

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);

      const meta: Record<string, unknown> = {};
      const ctx = createJoinCtx(meta, { sessionFile: "normal-session" });

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(meta.currentStage).toBe("clarify");
      expect(meta.pipelineId).toMatch(/^pipe-/);
    });

    it("JOIN preserves advancedThisTurn from parent (skip guard timing point 1)", async () => {
      const TMP = join(tmpdir(), "pi-ss-join-adv-" + Date.now());
      await mkdir(join(TMP, ".pi", "audit", "pipe-adv-parent"), { recursive: true });
      const parentMeta = makeTestMeta({
        currentStage: "review",
        pipelineId: "pipe-adv-parent",
        advancedThisTurn: true,
      });
      await writeFile(
        join(TMP, ".pi", "audit", "pipe-adv-parent", "meta.json"),
        JSON.stringify(parentMeta),
      );

      const config = makeTestConfig({ projectRoot: TMP });
      await initAuditLog(config);
      await registerSession(config, "adv-parent-session", "pipe-adv-parent");

      const meta: Record<string, unknown> = {};
      const ctx = createJoinCtx(meta, {
        parentSession: "adv-parent-session",
        sessionFile: "adv-child-session",
      });

      const hook = createSessionStarter(config);
      await hook.handler(ctx as any);

      expect(meta.advancedThisTurn).toBe(true);
    });
  });
});
