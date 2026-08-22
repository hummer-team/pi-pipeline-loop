import { describe, it, expect, beforeAll } from "bun:test";
import { applyVerifyPass, applyVerifyFail, isConfigError } from "../../core/verify-advance";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import type { SessionMeta, PipelineStage } from "../../types";
import { createPipelineUI, STAGE_STATUS_KEY } from "../../core/pipeline-ui";

const TMP = join(tmpdir(), "pi-verify-advance-test-" + Date.now());

function createCtx(meta: SessionMeta) {
  const updates: SessionMeta[] = [];
  const notifications: string[] = [];
  const statusCalls: { key: string; text: string }[] = [];
  const config = makeTestConfig(); // output.pipelineStage: true
  const pipelineUI = createPipelineUI(config);
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (m: SessionMeta) => {
        updates.push(m);
        Object.assign(meta, m);
      },
      setModel: async (_model: string) => {},
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
      setStatus: (key: string, text: string) => {
        statusCalls.push({ key, text });
      },
    },
    pipelineUI,
    updates,
    notifications,
    statusCalls,
  };
}

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

describe("applyVerifyPass", () => {
  // A: pass + nextStage non-null → advance + audit method correct
  it("advances to nextStage and writes audit with correct method", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: { failures: [] },
      ruleMissing: [],
      verifyResult: { structured: { passed: true }, llm: null, overallPassed: true },
    };

    const result = await applyVerifyPass(
      ctx as any,
      meta,
      "develop",
      "review" as PipelineStage,
      sharedResult,
      { method: "tool", handleTerminal: true, returnResult: true, ui: ctx.pipelineUI },
    );

    // Should have advanced
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("review");
    expect(lastUpdate.previousStage).toBe("develop");
    expect(lastUpdate.loopCount).toBe(0);
    expect(lastUpdate.currentStepIndex).toBe(0);
    expect(lastUpdate.verifyFailures).toEqual([]);

    // Should have TUI transition output (gated by output.pipelineStage)
    expect(ctx.notifications).toContain("develop → review");
    expect(ctx.statusCalls).toContainEqual({ key: STAGE_STATUS_KEY, text: "develop → review" });

    // Should have audit log
    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("auto_verify_pass");
    expect(logContent).toContain("method=tool");

    // Should return structured result
    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect(result!.passed).toBe(true);
    expect(result!.message).toContain("Advanced to");
  });

  it("writes audit with method=rule when called from hook", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: { failures: [] },
      ruleMissing: [],
      verifyResult: { structured: { passed: true }, llm: null, overallPassed: true },
    };

    await applyVerifyPass(
      ctx as any,
      meta,
      "develop",
      "review" as PipelineStage,
      sharedResult,
      { method: "rule", handleTerminal: false, returnResult: false, ui: ctx.pipelineUI },
    );

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("method=rule");
  });

  // B: pass + terminal stage + handleTerminal=true → write audit + return message
  it("terminal stage + handleTerminal=true → writes audit and returns message", async () => {
    const meta = makeTestMeta({ currentStage: "completed" });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: { failures: [] },
      ruleMissing: [],
      verifyResult: { structured: { passed: true }, llm: null, overallPassed: true },
    };

    const result = await applyVerifyPass(
      ctx as any,
      meta,
      "completed",
      null,
      sharedResult,
      { method: "tool", handleTerminal: true, returnResult: true, ui: ctx.pipelineUI },
    );

    // Should NOT advance (terminal stage) — no metadata update occurs
    expect(ctx.updates.length).toBe(0);

    // Should have audit log for terminal stage
    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("terminal stage, no advance");

    // Should return structured result with terminal message
    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect(result!.message).toContain("terminal stage");
  });

  // B (cont): handleTerminal=false → silent skip
  it("terminal stage + handleTerminal=false → silent skip, no notification", async () => {
    const meta = makeTestMeta({ currentStage: "completed" });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: { failures: [] },
      ruleMissing: [],
      verifyResult: { structured: { passed: true }, llm: null, overallPassed: true },
    };

    await applyVerifyPass(
      ctx as any,
      meta,
      "completed",
      null,
      sharedResult,
      { method: "rule", handleTerminal: false, returnResult: false, ui: ctx.pipelineUI },
    );

    // No notifications should be sent (silent skip)
    expect(ctx.notifications.length).toBe(0);

    // No metadata update should occur
    expect(ctx.updates.length).toBe(0);
  });

  // D: returnResult=true → returns structured object; false → void
  it("returnResult=true returns VerifyPassReturn; returnResult=false returns void", async () => {
    const meta1 = makeTestMeta({ currentStage: "develop" });
    const ctx1 = createCtx(meta1);
    const meta2 = makeTestMeta({ currentStage: "develop" });
    const ctx2 = createCtx(meta2);

    const sharedResult = {
      structuredResult: { failures: [] },
      ruleMissing: [],
      verifyResult: { structured: { passed: true }, llm: null, overallPassed: true },
    };

    // returnResult=true
    const result1 = await applyVerifyPass(
      ctx1 as any,
      meta1,
      "develop",
      "review" as PipelineStage,
      sharedResult,
      { method: "tool", handleTerminal: true, returnResult: true, ui: ctx1.pipelineUI },
    );
    expect(result1).toBeDefined();
    expect(result1!.success).toBe(true);
    expect(result1!.passed).toBe(true);

    // returnResult=false
    const result2 = await applyVerifyPass(
      ctx2 as any,
      meta2,
      "develop",
      "review" as PipelineStage,
      sharedResult,
      { method: "rule", handleTerminal: false, returnResult: false, ui: ctx2.pipelineUI },
    );
    expect(result2).toBeUndefined();
  });
});

describe("applyVerifyFail", () => {
  // C: fail → verifyFailures written + audit auto_verify_fail + method correct
  it("writes verifyFailures to meta and audit auto_verify_fail", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: {
        failures: [
          { ruleType: "requiredFiles", detail: "missing: output.md" },
          { ruleType: "requiredCommands", detail: "npm test failed" },
        ],
      },
      ruleMissing: ["keyword1"],
      verifyResult: null,
    };

    const result = await applyVerifyFail(
      ctx as any,
      meta,
      "develop",
      sharedResult,
      "tool",
      ctx.pipelineUI,
    );

    // Should NOT advance
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("develop");
    expect(lastUpdate.verifyFailures).toBeDefined();
    expect(lastUpdate.verifyFailures!.length).toBe(3); // 2 structured + 1 keyword
    expect(lastUpdate.verifyFailures![0].ruleType).toBe("requiredFiles");
    expect(lastUpdate.verifyFailures![0].timestamp).toBeGreaterThan(0);
    expect(lastUpdate.verifyAttempts).toBe(1);
    // NOTE: assistantMessages removed from metadata (Q4-A) — Phase 3 will use extractAssistantMessages

    // Should have audit log
    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("auto_verify_fail");
    expect(logContent).toContain("method=tool");

    // Should have TUI failure output (gated by output.pipelineStage)
    expect(ctx.notifications).toContain("develop ⚠ verify failed");
    expect(ctx.statusCalls).toContainEqual({ key: STAGE_STATUS_KEY, text: "develop ⚠ verify failed" });

    // Should return structured result
    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBe(3);
    expect(result.message).toContain("Verification failed");
  });

  it("writes audit with method=rule when called from hook", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: {
        failures: [{ ruleType: "requiredFiles", detail: "missing" }],
      },
      ruleMissing: [],
      verifyResult: null,
    };

    await applyVerifyFail(ctx as any, meta, "develop", sharedResult, "rule", ctx.pipelineUI);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("method=rule");
  });

  it("avoids duplicate keyword failures when already captured in structuredResult", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    // keywords already in structuredResult failures
    const sharedResult = {
      structuredResult: {
        failures: [{ ruleType: "keywords", detail: "Missing keywords: kw1" }],
      },
      ruleMissing: ["kw1", "kw2"],
      verifyResult: null,
    };

    const result = await applyVerifyFail(
      ctx as any,
      meta,
      "develop",
      sharedResult,
      "tool",
      ctx.pipelineUI,
    );

    // Should NOT duplicate keywords — only 1 failure
    expect(result.failures.length).toBe(1);
    expect(result.failures[0].ruleType).toBe("keywords");
  });
});

describe("output.pipelineStage: false (silent)", () => {
  function createSilentCtx(meta: SessionMeta) {
    const updates: SessionMeta[] = [];
    const notifications: string[] = [];
    const statusCalls: { key: string; text: string }[] = [];
    const config = makeTestConfig({ output: { pipelineStage: false } });
    const pipelineUI = createPipelineUI(config);
    return {
      session: {
        getMeta: () => meta,
        updateMeta: (m: SessionMeta) => {
          updates.push(m);
          Object.assign(meta, m);
        },
        setModel: async (_model: string) => {},
      },
      ui: {
        notify: (msg: string) => { notifications.push(msg); },
        setStatus: (key: string, text: string) => { statusCalls.push({ key, text }); },
      },
      pipelineUI,
      updates,
      notifications,
      statusCalls,
    };
  }

  it("applyVerifyPass produces no TUI output when pipelineStage is false", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createSilentCtx(meta);
    const sharedResult = {
      structuredResult: { failures: [] },
      ruleMissing: [],
      verifyResult: { structured: { passed: true }, llm: null, overallPassed: true },
    };

    await applyVerifyPass(
      ctx as any,
      meta,
      "develop",
      "review" as PipelineStage,
      sharedResult,
      { method: "tool", handleTerminal: true, returnResult: true, ui: ctx.pipelineUI },
    );

    // Should have advanced (metadata updated)
    expect(ctx.updates.length).toBeGreaterThan(0);
    expect(ctx.updates[ctx.updates.length - 1].currentStage).toBe("review");

    // But no TUI output
    expect(ctx.notifications).toEqual([]);
    expect(ctx.statusCalls).toEqual([]);
  });

  it("applyVerifyFail produces no TUI output when pipelineStage is false", async () => {
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createSilentCtx(meta);
    const sharedResult = {
      structuredResult: { failures: [{ ruleType: "requiredFiles", detail: "missing" }] },
      ruleMissing: [],
      verifyResult: null,
    };

    await applyVerifyFail(ctx as any, meta, "develop", sharedResult, "tool", ctx.pipelineUI);

    // Should have updated metadata (verifyFailures)
    expect(ctx.updates.length).toBeGreaterThan(0);

    // But no TUI output
    expect(ctx.notifications).toEqual([]);
    expect(ctx.statusCalls).toEqual([]);
  });

  it("applyVerifyFail freezes pipeline when verifyAttempts reaches maxVerifyAttempts", async () => {
    const config = makeTestConfig({ maxVerifyAttempts: 2 });
    const meta = makeTestMeta({
      currentStage: "develop",
      verifyAttempts: 1, // will become 2 after this call
    });
    const ctx = createCtx(meta);
    const sharedResult = {
      structuredResult: { failures: [{ ruleType: "requiredFiles", detail: "missing" }] },
      ruleMissing: [],
      verifyResult: null,
    };

    await applyVerifyFail(
      ctx as any, meta, "develop", sharedResult, "rule", ctx.pipelineUI, config,
    );

    // verifyAttempts should be 2 now (1 + 1)
    expect(meta.verifyAttempts).toBe(2);
    // Pipeline should be frozen
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("verify_attempt_overflow");
  });

  it("applyVerifyFail does NOT freeze when verifyAttempts below maxVerifyAttempts", async () => {
    const config = makeTestConfig({ maxVerifyAttempts: 5 });
    const meta = makeTestMeta({
      currentStage: "develop",
      verifyAttempts: 1, // will become 2 (below 5)
    });
    const ctx = createCtx(meta);
    const sharedResult = {
      structuredResult: { failures: [{ ruleType: "requiredFiles", detail: "missing" }] },
      ruleMissing: [],
      verifyResult: null,
    };

    await applyVerifyFail(
      ctx as any, meta, "develop", sharedResult, "rule", ctx.pipelineUI, config,
    );

    expect(meta.verifyAttempts).toBe(2);
    // Pipeline should NOT be frozen
    expect(meta.flowState).toBeUndefined();
  });
});

// ─── Phase 3: config-error freeze + isConfigError ────────────────────────────

describe("Phase 3: config-error freeze in applyVerifyFail", () => {
  it("config error (EISDIR) → freezeAndPrompt called, verifyAttempts NOT incremented, audit written", async () => {
    const config = makeTestConfig({ maxVerifyAttempts: 5 });
    const meta = makeTestMeta({
      currentStage: "clarify",
      verifyAttempts: 1,
    });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: {
        failures: [
          { ruleType: "fileContentPattern", detail: "path 指向目录（EISDIR）（配置错误）" },
        ],
      },
      ruleMissing: [],
      verifyResult: null,
    };

    const result = await applyVerifyFail(
      ctx as any,
      meta,
      "clarify",
      sharedResult,
      "tool",
      ctx.pipelineUI,
      config,
    );

    // verifyAttempts should NOT be incremented (config error path)
    expect(meta.verifyAttempts).toBe(1);
    // Pipeline should be frozen
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("verify_config_error");
    // Return message should mention config error
    expect(result.message).toContain("验证配置错误");
    // Audit should contain verify_config_error
    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("verify_config_error");
  });

  it("config error (requirementDoc unset) → freezeAndPrompt called", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: {
        failures: [
          { ruleType: "fileContentPattern", detail: "requirementDoc 未设置，无法解析 {requirementDoc} 验证规则路径" },
        ],
      },
      ruleMissing: [],
      verifyResult: null,
    };

    const result = await applyVerifyFail(
      ctx as any,
      meta,
      "clarify",
      sharedResult,
      "tool",
      ctx.pipelineUI,
      config,
    );

    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("verify_config_error");
    expect(result.message).toContain("验证配置错误");
  });

  it("content failure (pattern not found) → normal path, NO freeze, verifyAttempts incremented", async () => {
    const config = makeTestConfig({ maxVerifyAttempts: 5 });
    const meta = makeTestMeta({
      currentStage: "develop",
      verifyAttempts: 0,
    });
    const ctx = createCtx(meta);

    const sharedResult = {
      structuredResult: {
        failures: [
          { ruleType: "fileContentPattern", detail: 'doc.md: pattern "missing" not found' },
        ],
      },
      ruleMissing: [],
      verifyResult: null,
    };

    const result = await applyVerifyFail(
      ctx as any,
      meta,
      "develop",
      sharedResult,
      "tool",
      ctx.pipelineUI,
      config,
    );

    // verifyAttempts SHOULD be incremented (normal failure path)
    expect(meta.verifyAttempts).toBe(1);
    // Pipeline should NOT be frozen (below maxAttempts)
    expect(meta.flowState).toBeUndefined();
    // Return message should be normal failure, NOT config error
    expect(result.message).toContain("Verification failed");
    expect(result.message).not.toContain("验证配置错误");
  });
});

describe("isConfigError helper", () => {
  it("detects EISDIR config error", () => {
    expect(isConfigError([
      { ruleType: "fileContentPattern", detail: "path 指向目录（EISDIR）（配置错误）" },
    ])).toBe(true);
  });

  it("detects empty path config error", () => {
    expect(isConfigError([
      { ruleType: "fileContentPattern", detail: "fileContentPattern path 为空（配置错误）" },
    ])).toBe(true);
  });

  it("detects requirementDoc unset config error", () => {
    expect(isConfigError([
      { ruleType: "fileContentPattern", detail: "requirementDoc 未设置，无法解析 {requirementDoc}" },
    ])).toBe(true);
  });

  it("returns false for content failure (pattern not found)", () => {
    expect(isConfigError([
      { ruleType: "fileContentPattern", detail: 'doc.md: pattern "xyz" not found' },
    ])).toBe(false);
  });

  it("returns false for non-fileContentPattern rule types", () => {
    expect(isConfigError([
      { ruleType: "requiredFiles", detail: "EISDIR somewhere" },
    ])).toBe(false);
  });

  it("returns false for empty failures array", () => {
    expect(isConfigError([])).toBe(false);
  });
});
