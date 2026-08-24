import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import type { PipelineStage } from "../../types";

const TMP = join(tmpdir(), "pi-pipeline-agent-settled-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

describe("createAgentSettled", () => {
  it("creates a hook with event 'agent_settled'", () => {
    const hook = createAgentSettled(makeTestConfig());
    expect(hook.event).toBe("agent_settled");
  });

  it("writes audit log with agent_settled action", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "plan" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    const line = content.trim().split("\n")[0];

    expect(line).toContain(" - [INFO] agent_settled");
    expect(line).toContain("pipelineId=pipe-test-001");
    expect(line).toContain("stage=plan");
  });

  it("notifies ui when notify is available", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    expect(ctx.notifications).toContain('Agent settled in "review" stage');
  });

  it("does not throw when ui.notify is absent", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta();
    const ctx = createMockCtx(meta);
    delete (ctx as any).ui;

    const hook = createAgentSettled(config);
    await expect(hook.handler(ctx as any)).resolves.toBeUndefined();
  });

  it("writes verifyFailures to meta when verification fails", async () => {
    const stageTmp = join(tmpdir(), "pi-agent-settled-verify-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create a verify.md with requiredFiles that don't exist
    const vrDir = join(stageTmp, "references", "develop_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"nonexistent.md\"\n---\nBody\n",
    );

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify: s === "develop" ? { require: true, verifyFile: "references/develop_spec/verify.md" } : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should NOT advance
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("develop"); // still develop, not advanced
    expect(lastMeta.verifyFailures).toBeDefined();
    expect(lastMeta.verifyFailures!.length).toBeGreaterThan(0);
    expect(lastMeta.verifyFailures![0].ruleType).toBe("requiredFiles");

    // Should have audit log for verify failure
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("auto_verify_fail");

    await rm(stageTmp, { recursive: true, force: true });
  });

  // ── Phase 3: frozen short-circuit ────────────────────────────────────────────

  it("skips verification when pipeline is frozen (flowState=blocked)", async () => {
    const stageTmp = join(tmpdir(), "pi-agent-settled-frozen-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create verify.md that would FAIL
    const vrDir = join(stageTmp, "references", "develop_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"nonexistent.md\"\n---\nBody\n",
    );

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "develop" ? { require: true, verifyFile: "references/develop_spec/verify.md" } : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should NOT run verification — no metadata updates beyond the initial
    // (no verifyFailures written, no stage advance)
    const verifyUpdates = ctx.metadataUpdates.filter(u => u.verifyFailures);
    expect(verifyUpdates.length).toBe(0);

    // Should write agent_settled_skipped_frozen audit
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("agent_settled_skipped_frozen");

    // Should notify user about frozen state and shortcut key (Medium #7)
    expect(ctx.notifications.some(n => n.includes("frozen") || n.includes("decision menu"))).toBe(true);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Regression: frozen short-circuit uses custom shortcut key in notify
  it("frozen short-circuit notify renders custom shortcut key", async () => {
    const stageTmp = join(tmpdir(), "pi-agent-settled-frozen-notify-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({
      projectRoot: stageTmp,
      decisionShortcutKey: "alt+f",
    });

    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should render the custom shortcut key in the notification
    expect(ctx.notifications.some(n => n.includes("alt+f"))).toBe(true);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // ── Phase 3: verify.mode tests ──────────────────────────────────────────────

  it("mode 'tool': skips verification — does NOT run runVerification", async () => {
    const stageTmp = join(tmpdir(), "pi-agent-settled-tool-mode-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create a verify.md that would FAIL (file doesn't exist)
    const vrDir = join(stageTmp, "references", "develop_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"nonexistent.md\"\n---\nBody\n",
    );

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "develop"
                ? { require: true, verifyFile: "references/develop_spec/verify.md", mode: "tool" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // In tool mode, no verification runs and no metadata update occurs
    // The handler simply returns after audit log + skip notification
    // Check audit log for mode=tool skip
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("verify_mode_tool_skip");
    expect(logContent).toContain("verify.mode=tool");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("mode 'hook': keeps existing behavior — runs verification", async () => {
    const stageTmp = join(tmpdir(), "pi-agent-settled-hook-mode-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create verify.md with a file that EXISTS → should pass and advance
    const vrDir = join(stageTmp, "references", "develop_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "develop"
                ? { require: true, verifyFile: "references/develop_spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should advance to review (next after develop)
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("review");

    await rm(stageTmp, { recursive: true, force: true });
  });

  // ── Phase 2: Wake-up tests (138) ──────────────────────────────────────────

  /** Helper: create a stageTmp with a verify.md that PASSES (required file exists) */
  async function makePassingVerifyTmp(prefix: string): Promise<string> {
    const stageTmp = join(tmpdir(), prefix + "-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");
    return stageTmp;
  }

  /** Helper: create a stageTmp with a verify.md that FAILS (required file missing) */
  async function makeFailingVerifyTmp(prefix: string): Promise<string> {
    const stageTmp = join(tmpdir(), prefix + "-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"nonexistent.md\"\n---\nBody\n",
    );
    return stageTmp;
  }

  /** Helper: create a config where `stage` has hook-mode verify.require=true */
  function makeHookVerifyConfig(stageTmp: string, stage: string) {
    return makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === stage
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });
  }

  // Case 1: clarify verify pass → advance to plan → sendUserMessage called
  it("138 wake: clarify→plan advance triggers sendUserMessage with stage names", async () => {
    const stageTmp = await makePassingVerifyTmp("pi-settled-wake-1");

    const config = makeHookVerifyConfig(stageTmp, "clarify");
    const meta = makeTestMeta({ currentStage: "clarify" });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should advance to plan
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("plan");

    // sendUserMessage should be called exactly once with clarify and plan
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("clarify");
    expect(sentMessages[0]).toContain("plan");

    // Audit log should contain auto_advance_wake
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("auto_advance_wake");

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Case 2: verify fails → sendUserMessage NOT called
  it("138 wake: verification failure does NOT trigger sendUserMessage", async () => {
    const stageTmp = await makeFailingVerifyTmp("pi-settled-wake-2");

    const config = makeHookVerifyConfig(stageTmp, "develop");
    const meta = makeTestMeta({ currentStage: "develop" });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should NOT advance
    expect(sentMessages.length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Case 3: verify.mode="tool" → sendUserMessage NOT called
  it("138 wake: tool-mode verify does NOT trigger sendUserMessage", async () => {
    const stageTmp = await makePassingVerifyTmp("pi-settled-wake-3");

    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "plan"
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "tool" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "plan" });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Tool mode skips verification entirely — no wake
    expect(sentMessages.length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Case 4: advancedThisTurn=true (C2) → sendUserMessage NOT called
  it("138 wake: C2 advancedThisTurn=true does NOT trigger sendUserMessage", async () => {
    const stageTmp = await makePassingVerifyTmp("pi-settled-wake-4");

    const config = makeHookVerifyConfig(stageTmp, "develop");
    const meta = makeTestMeta({ currentStage: "develop", advancedThisTurn: true });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // C2 guard returns early — no wake
    expect(sentMessages.length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Case 5: frozen (flowState=blocked) → sendUserMessage NOT called
  it("138 wake: frozen pipeline does NOT trigger sendUserMessage", async () => {
    const stageTmp = await makePassingVerifyTmp("pi-settled-wake-5");

    const config = makeHookVerifyConfig(stageTmp, "develop");
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Frozen guard returns early — no wake
    expect(sentMessages.length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Case 6: terminal stage (nextStage=null) → sendUserMessage NOT called
  // Uses currentStage="completed" where nextStage is genuinely null (not "completed").
  it("138 wake: terminal stage (nextStage=null) does NOT trigger sendUserMessage", async () => {
    const stageTmp = await makePassingVerifyTmp("pi-settled-wake-6");

    // Enable verify on "completed" stage — its nextStage is null (terminal boundary)
    const config = makeHookVerifyConfig(stageTmp, "completed");
    const meta = makeTestMeta({ currentStage: "completed" });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // completed has nextStage=null — should NOT wake (real null boundary, not "completed" exclusion)
    expect(sentMessages.length).toBe(0);

    // Stage should NOT advance (terminal stage, applyVerifyPass skips updateMeta when nextStage=null)
    expect(ctx.metadataUpdates.length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Case 7: ctx.pi is undefined → no error, no sendUserMessage
  it("138 wake: missing pi does NOT throw and does NOT call sendUserMessage", async () => {
    const stageTmp = await makePassingVerifyTmp("pi-settled-wake-7");

    const config = makeHookVerifyConfig(stageTmp, "clarify");
    const meta = makeTestMeta({ currentStage: "clarify" });
    // No pi mock provided — ctx.pi will be undefined
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await expect(hook.handler(ctx as any)).resolves.toBeUndefined();

    // Should still advance (wake just skipped silently)
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("plan");

    // Audit log should contain auto_advance_wake_skipped
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("auto_advance_wake_skipped");

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Case 8: nextStage="completed" → sendUserMessage NOT called
  it("138 wake: nextStage='completed' does NOT trigger sendUserMessage", async () => {
    const stageTmp = await makePassingVerifyTmp("pi-settled-wake-8");

    // fix → awaiting_human (not completed), but we want to test the completed boundary.
    // Use awaiting_human where nextStage=completed.
    const config = makeTestConfig({
      projectRoot: stageTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentPath: "a.md",
              skillPath: "s.md",
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              verify: s === "awaiting_human"
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "awaiting_human" });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // awaiting_human → completed (nextStage === "completed") — should NOT wake
    expect(sentMessages.length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  // Case 9: sendUserMessage throws → hook does NOT reject, failure audit logged
  it("138 wake: sendUserMessage exception is caught and logged as auto_advance_wake_failed", async () => {
    const stageTmp = await makePassingVerifyTmp("pi-settled-wake-9");

    const config = makeHookVerifyConfig(stageTmp, "clarify");
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = createMockCtx(meta, {
      pi: {
        sendUserMessage: (_msg: string) => {
          throw new Error("pi SDK internal failure");
        },
      },
    });

    const hook = createAgentSettled(config);

    // Hook must NOT reject even when sendUserMessage throws
    await expect(hook.handler(ctx as any)).resolves.toBeUndefined();

    // Stage should still advance (advance happened before the wake call)
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("plan");

    // Audit log should contain auto_advance_wake_failed (not auto_advance_wake)
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("auto_advance_wake_failed");
    expect(logContent).toContain("pi SDK internal failure");
    expect(logContent).not.toContain("auto_advance_wake\n");

    await rm(stageTmp, { recursive: true, force: true });
  });
});
