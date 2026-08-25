import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createSessionState, extractAssistantMessages, extractToolCallRecords, PIPELINE_META_CUSTOM_TYPE, __resetSharedStateDir } from "../../core/session-state";
import type { SessionMeta } from "../../types";
import { makeTestMeta, makeTestConfig, makeMockSessionManager } from "../helpers";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";

let AUDIT_TMP: string;

/**
 * Minimal mock of ExtensionAPI for testing SessionState.
 */
function makeMockPi() {
  const appended: Array<{ customType: string; data: unknown }> = [];
  return {
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
    },
    appended,
  };
}

describe("SessionState", () => {
  describe("getMeta", () => {
    it("returns undefined when no pipeline meta entries exist", () => {
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager([]) } as any;
      const state = createSessionState(pi as any, ctx);

      expect(state.getMeta()).toBeUndefined();
    });

    it("returns undefined when entries exist but none match pipeline custom type", () => {
      const entries = [
        { type: "custom", customType: "other-type", data: { foo: "bar" } },
        { type: "message", message: { role: "user", content: "hello" } },
      ];
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
      const state = createSessionState(pi as any, ctx);

      expect(state.getMeta()).toBeUndefined();
    });

    it("returns the latest pipeline meta entry when multiple exist", () => {
      const meta1: Partial<SessionMeta> = { currentStage: "clarify", pipelineId: "pipe-1" } as SessionMeta;
      const meta2: Partial<SessionMeta> = { currentStage: "plan", pipelineId: "pipe-1" } as SessionMeta;
      const entries = [
        { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: meta1 },
        { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: meta2 },
      ];
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
      const state = createSessionState(pi as any, ctx);

      const result = state.getMeta();
      expect(result).toBeDefined();
      expect(result!.currentStage).toBe("plan");
    });
  });

  describe("updateMeta", () => {
    it("merges patch with existing meta and appends new entry", () => {
      const existing: SessionMeta = makeTestMeta({ currentStage: "clarify" });
      const entries = [
        { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: existing },
      ];
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
      const state = createSessionState(pi as any, ctx);

      const result = state.updateMeta({ currentStage: "plan" });

      expect(result).toBeDefined();
      expect(result!.currentStage).toBe("plan");
      expect(result!.pipelineId).toBe(existing.pipelineId); // preserved from existing
      expect(pi.appended.length).toBe(1);
      expect(pi.appended[0].customType).toBe(PIPELINE_META_CUSTOM_TYPE);
    });

    it("creates new meta when no existing entry", () => {
      const pi = makeMockPi();
      const ctx = { sessionManager: makeMockSessionManager([]) } as any;
      const state = createSessionState(pi as any, ctx);

      const patch = { currentStage: "clarify" as const, pipelineId: "new-pipe" };
      const result = state.updateMeta(patch);

      expect(result).toBeDefined();
      expect(result!.currentStage).toBe("clarify");
      expect(pi.appended.length).toBe(1);
    });
  });
});

describe("extractAssistantMessages", () => {
  it("returns empty array when no entries", () => {
    const ctx = { sessionManager: makeMockSessionManager([]) } as any;
    expect(extractAssistantMessages(ctx)).toEqual([]);
  });

  it("extracts text from assistant message entries with string content", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "I'll help with that" } },
      { type: "message", message: { role: "assistant", content: "Done!" } },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const result = extractAssistantMessages(ctx);

    expect(result).toEqual(["I'll help with that", "Done!"]);
  });

  it("extracts text from assistant message entries with array content", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Part 1" },
            { type: "image", data: "..." },
            { type: "text", text: " Part 2" },
          ],
        },
      },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const result = extractAssistantMessages(ctx);

    expect(result).toEqual(["Part 1 Part 2"]);
  });

  it("skips non-message and non-assistant entries", () => {
    const entries = [
      { type: "custom", customType: "other", data: {} },
      { type: "message", message: { role: "user", content: "user message" } },
      { type: "model_change", provider: "openai", modelId: "gpt-4" },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const result = extractAssistantMessages(ctx);

    expect(result).toEqual([]);
  });
});

describe("Phase 1 — catch block audit logging", () => {
  beforeEach(async () => {
    AUDIT_TMP = path.join(tmpdir(), "pi-ss-audit-" + Date.now());
    await fs.mkdir(AUDIT_TMP, { recursive: true });
  });

  afterEach(async () => {
    __resetAuditDirPath();
    await fs.rm(AUDIT_TMP, { recursive: true, force: true });
  });

  it("getMeta throws → session_state_error audit with operation='getMeta'", async () => {
    const config = makeTestConfig({ projectRoot: AUDIT_TMP, auditDir: ".pi/audit" });
    const auditDir = path.join(AUDIT_TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    await initAuditLog(config);

    // Create a ctx where getEntries() throws
    const brokenCtx = {
      sessionManager: {
        getEntries: () => { throw new Error("Session store unavailable"); },
        getBranch: () => [],
      },
    } as any;
    const pi = { appendEntry: () => {} } as any;
    const state = createSessionState(pi, brokenCtx);

    // Should return undefined (graceful degradation)
    expect(state.getMeta()).toBeUndefined();

    // Wait for async safeWriteAuditLog (fire-and-forget) to flush
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify audit
    const logFile = path.join(auditDir, getDateAuditFileName());
    const logContent = await fs.readFile(logFile, "utf-8");
    expect(logContent).toContain("session_state_error");
    expect(logContent).toContain("getMeta");
    expect(logContent).toContain("Session store unavailable");
  });

  it("extractAssistantMessages throws → session_state_error audit with operation='extractAssistantMessages'", async () => {
    const config = makeTestConfig({ projectRoot: AUDIT_TMP, auditDir: ".pi/audit" });
    const auditDir = path.join(AUDIT_TMP, ".pi", "audit");
    await fs.mkdir(auditDir, { recursive: true });
    await initAuditLog(config);

    // Create a ctx where getBranch() throws
    const brokenCtx = {
      sessionManager: {
        getEntries: () => [],
        getBranch: () => { throw new Error("Branch read failure"); },
      },
    } as any;

    // Should return [] (graceful degradation)
    expect(extractAssistantMessages(brokenCtx)).toEqual([]);

    // Wait for async safeWriteAuditLog (fire-and-forget) to flush
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify audit
    const logFile = path.join(auditDir, getDateAuditFileName());
    const logContent = await fs.readFile(logFile, "utf-8");
    expect(logContent).toContain("session_state_error");
    expect(logContent).toContain("extractAssistantMessages");
    expect(logContent).toContain("Branch read failure");
  });
});

describe("extractToolCallRecords", () => {
  it("returns empty array when no entries", () => {
    const ctx = { sessionManager: makeMockSessionManager([]) } as any;
    expect(extractToolCallRecords(ctx)).toEqual([]);
  });

  it("uses real timestamp from entry.timestamp when available", () => {
    const entries = [
      {
        type: "message",
        timestamp: 1700000000000,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "bash", input: { command: "bun run build" } },
          ],
        },
      },
      {
        type: "message",
        timestamp: 1700000000100,
        message: {
          role: "user",
          toolCallId: "call_1",
          content: "Exit code: 0",
        },
      },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const records = extractToolCallRecords(ctx);

    expect(records).toHaveLength(1);
    expect(records[0].ts).toBe(1700000000000);
    expect(records[0].name).toBe("bash");
    expect(records[0].command).toBe("bun run build");
    expect(records[0].exitCode).toBe(0);
  });

  it("falls back to Date.now() when entry has no timestamp", () => {
    const before = Date.now();
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          toolCallId: "call_1",
          content: "exit code 0",
        },
      },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const records = extractToolCallRecords(ctx);
    const after = Date.now();

    expect(records).toHaveLength(1);
    // Timestamp should be a real Unix timestamp (ms), not an index
    expect(records[0].ts).toBeGreaterThanOrEqual(before);
    expect(records[0].ts).toBeLessThanOrEqual(after);
  });

  it("leaves exitCode undefined when not parseable from result (no heuristic 0)", () => {
    const entries = [
      {
        type: "message",
        timestamp: 1700000000000,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "bash", input: { command: "some-command" } },
          ],
        },
      },
      {
        type: "message",
        timestamp: 1700000000100,
        message: {
          role: "user",
          toolCallId: "call_1",
          content: "some output without exit code info",
        },
      },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const records = extractToolCallRecords(ctx);

    expect(records).toHaveLength(1);
    // exitCode should remain undefined — no heuristic assumption of 0
    expect(records[0].exitCode).toBeUndefined();
  });

  it("leaves exitCode undefined even when result has no 'error' keyword", () => {
    const entries = [
      {
        type: "message",
        timestamp: 1700000000000,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "bash", input: { command: "bun run build" } },
          ],
        },
      },
      {
        type: "message",
        timestamp: 1700000000100,
        message: {
          role: "user",
          toolCallId: "call_1",
          content: "Build completed successfully",
        },
      },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const records = extractToolCallRecords(ctx);

    expect(records).toHaveLength(1);
    // Even without "error" in output, exitCode must not be heuristically set to 0
    expect(records[0].exitCode).toBeUndefined();
  });

  it("correctly parses exit code when present in result text", () => {
    const entries = [
      {
        type: "message",
        timestamp: 1700000000000,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "bash", input: { command: "bun run build" } },
          ],
        },
      },
      {
        type: "message",
        timestamp: 1700000000100,
        message: {
          role: "user",
          toolCallId: "call_1",
          content: "build ok\n(exit code: 0)",
        },
      },
    ];
    const ctx = { sessionManager: makeMockSessionManager(entries) } as any;
    const records = extractToolCallRecords(ctx);

    expect(records).toHaveLength(1);
    expect(records[0].exitCode).toBe(0);
  });
});

// ─── Phase 1 (143): Shared state source tests ────────────────────────────────

let SHARED_TMP: string;

describe("SessionState — shared state source (143)", () => {
  beforeEach(async () => {
    SHARED_TMP = path.join(tmpdir(), "pi-ss-shared-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await fs.mkdir(SHARED_TMP, { recursive: true });
    __resetSharedStateDir();
  });

  afterEach(async () => {
    __resetSharedStateDir();
    await fs.rm(SHARED_TMP, { recursive: true, force: true });
  });

  /** Build a mock pi + ctx for shared-state tests */
  function makeSharedMocks(
    localEntries: unknown[] = [],
    pipelineId = "pipe-shared-001",
  ) {
    const appended: Array<{ customType: string; data: unknown }> = [];
    const pi: any = {
      appendEntry: (customType: string, data: unknown) => {
        appended.push({ customType, data });
      },
      appended,
    };
    const ctx = {
      sessionManager: makeMockSessionManager(localEntries),
    } as any;
    return { pi, ctx, appended };
  }

  /** Write a shared meta.json into the temp directory */
  async function writeSharedMeta(pipelineId: string, meta: Partial<SessionMeta>) {
    const dir = path.join(SHARED_TMP, ".pi", "audit", pipelineId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  }

  it("returns shared source content when shared meta.json exists", async () => {
    const pipelineId = "pipe-shared-exist";
    // Local entries have old stage (clarify)
    const localMeta = makeTestMeta({ currentStage: "clarify", pipelineId });
    const localEntries = [
      { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: localMeta },
    ];
    // Shared source has newer stage (develop)
    const sharedMeta = makeTestMeta({ currentStage: "develop", pipelineId });
    await writeSharedMeta(pipelineId, sharedMeta);

    const { pi, ctx } = makeSharedMocks(localEntries, pipelineId);
    const state = createSessionState(pi, ctx, {
      projectRoot: SHARED_TMP,
      auditDir: ".pi/audit",
    });

    const result = state.getMeta();
    expect(result).toBeDefined();
    expect(result!.currentStage).toBe("develop"); // shared source wins
    expect(result!.pipelineId).toBe(pipelineId);
  });

  it("updateMeta dual-writes meta.json and local entries", async () => {
    const pipelineId = "pipe-shared-dual";
    const existing = makeTestMeta({ currentStage: "clarify", pipelineId });
    const localEntries = [
      { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: existing },
    ];
    await writeSharedMeta(pipelineId, existing);

    const { pi, ctx } = makeSharedMocks(localEntries, pipelineId);
    const state = createSessionState(pi, ctx, {
      projectRoot: SHARED_TMP,
      auditDir: ".pi/audit",
    });

    // Update stage to "plan"
    state.updateMeta({ currentStage: "plan" });

    // Verify: local appendEntry was called
    expect(pi.appended.length).toBeGreaterThanOrEqual(1);
    const lastAppend = pi.appended[pi.appended.length - 1];
    expect((lastAppend.data as SessionMeta).currentStage).toBe("plan");

    // Verify: meta.json was written
    const metaPath = path.join(SHARED_TMP, ".pi", "audit", pipelineId, "meta.json");
    expect(fsSync.existsSync(metaPath)).toBe(true);
    const diskMeta = JSON.parse(fsSync.readFileSync(metaPath, "utf-8"));
    expect(diskMeta.currentStage).toBe("plan");
    expect(diskMeta.pipelineId).toBe(pipelineId);
  });

  it("falls back to local entries when shared meta.json is missing", () => {
    const pipelineId = "pipe-shared-missing";
    const localMeta = makeTestMeta({ currentStage: "plan", pipelineId });
    const localEntries = [
      { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: localMeta },
    ];

    const { pi, ctx } = makeSharedMocks(localEntries, pipelineId);
    const state = createSessionState(pi, ctx, {
      projectRoot: SHARED_TMP,
      auditDir: ".pi/audit",
    });

    const result = state.getMeta();
    expect(result).toBeDefined();
    expect(result!.currentStage).toBe("plan"); // local fallback
    expect(result!.pipelineId).toBe(pipelineId);
  });

  it("sub-agent scenario: local entries stale (clarify), shared source authoritative (develop)", async () => {
    const pipelineId = "pipe-subagent-001";
    // Sub-agent forked when main was at clarify — local entries reflect clarify
    const staleLocalMeta = makeTestMeta({ currentStage: "clarify", pipelineId });
    const localEntries = [
      { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: staleLocalMeta },
    ];
    // Main session advanced to develop — shared meta.json reflects develop
    const advancedSharedMeta = makeTestMeta({
      currentStage: "develop",
      previousStage: "plan",
      pipelineId,
    });
    await writeSharedMeta(pipelineId, advancedSharedMeta);

    const { pi, ctx } = makeSharedMocks(localEntries, pipelineId);
    const state = createSessionState(pi, ctx, {
      projectRoot: SHARED_TMP,
      auditDir: ".pi/audit",
    });

    // getMeta() should return the shared (develop) state, not local (clarify)
    const result = state.getMeta();
    expect(result).toBeDefined();
    expect(result!.currentStage).toBe("develop");
    expect(result!.pipelineId).toBe(pipelineId);
  });

  it("falls back to local when shared source pipelineId mismatches", async () => {
    const localPipelineId = "pipe-local-001";
    const sharedPipelineId = "pipe-other-002";
    const localMeta = makeTestMeta({ currentStage: "plan", pipelineId: localPipelineId });
    const localEntries = [
      { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: localMeta },
    ];
    // Shared file has a DIFFERENT pipelineId (e.g. leftover from another run)
    const sharedMeta = makeTestMeta({ currentStage: "develop", pipelineId: sharedPipelineId });
    await writeSharedMeta(localPipelineId, sharedMeta); // write under localPipelineId dir but content has different pipelineId

    const { pi, ctx } = makeSharedMocks(localEntries, localPipelineId);
    const state = createSessionState(pi, ctx, {
      projectRoot: SHARED_TMP,
      auditDir: ".pi/audit",
    });

    const result = state.getMeta();
    expect(result).toBeDefined();
    expect(result!.currentStage).toBe("plan"); // local fallback (pipelineId mismatch)
    expect(result!.pipelineId).toBe(localPipelineId);
  });

  it("updateMeta is fail-open when shared write fails (bad dir)", async () => {
    const pipelineId = "pipe-shared-failopen";
    const existing = makeTestMeta({ currentStage: "clarify", pipelineId });
    const localEntries = [
      { type: "custom", customType: PIPELINE_META_CUSTOM_TYPE, data: existing },
    ];

    // Use a path that cannot be written (file instead of directory)
    const blockingFile = path.join(SHARED_TMP, "blocking-file");
    fsSync.writeFileSync(blockingFile, "blocker");

    const { pi, ctx } = makeSharedMocks(localEntries, pipelineId);
    const state = createSessionState(pi, ctx, {
      projectRoot: blockingFile, // invalid: points to a file
      auditDir: ".pi/audit",
    });

    // updateMeta should succeed (local write) even if shared write fails
    const result = state.updateMeta({ currentStage: "plan" });
    expect(result).toBeDefined();
    expect(result!.currentStage).toBe("plan");
  });
});
