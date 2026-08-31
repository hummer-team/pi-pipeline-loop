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

    // Create a verify.md with a fileContentPattern that fails (precheck passes — no requiredFiles)
    await writeFile(join(stageTmp, "doc.md"), "some content");
    const vrDir = join(stageTmp, "references", "develop_spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  fileContentPattern:\n    - path: \"doc.md\"\n      pattern: \"^NEVER_MATCH$\"\n---\nBody\n",
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
    expect(lastMeta.verifyFailures![0].ruleType).toBe("fileContentPattern");

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

  // Regression: frozen short-circuit uses blockedReason in notify (no shortcut key)
  it("frozen short-circuit notify includes blockedReason", async () => {
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

    // Should include blockedReason in the notification
    expect(ctx.notifications.some(n => n.includes("loop_overflow"))).toBe(true);
    // Should NOT include shortcut key
    expect(ctx.notifications.some(n => n.includes("alt+f"))).toBe(false);

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

  /** Helper: create a stageTmp with a verify.md that FAILS via fileContentPattern (precheck passes) */
  async function makeFailingVerifyTmp(prefix: string): Promise<string> {
    const stageTmp = join(tmpdir(), prefix + "-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));
    // Create a file that exists (precheck passes — no requiredFiles) but pattern fails
    await writeFile(join(stageTmp, "doc.md"), "some content");
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  fileContentPattern:\n    - path: \"doc.md\"\n      pattern: \"^NEVER_MATCH$\"\n---\nBody\n",
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
  // 148 Phase 4: verification failure now DOES trigger sendUserMessage in hook mode
  it("148 wake: verification failure triggers sendUserMessage in hook mode", async () => {
    const stageTmp = await makeFailingVerifyTmp("pi-settled-wake-2");

    const config = makeHookVerifyConfig(stageTmp, "develop");
    const meta = makeTestMeta({ currentStage: "develop" });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // 148 Phase 4: Should wake the model to fix verification failures
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("Verification failed");
    expect(sentMessages[0]).toContain("develop");
    // 159 Phase 3: wake message must instruct SKILL-format compliance
    expect(sentMessages[0]).toContain("Please strictly follow the SKILL output format requirements");

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

  // ── Phase 4 (148): verify fail wake guards ─────────────────────────────────

  it("148 wake guard: tool mode fail → sendUserMessage NOT called (hook skips tool mode)", async () => {
    const stageTmp = await makeFailingVerifyTmp("pi-settled-wake-p4-1");

    const config = makeTestConfig({
      projectRoot: stageTmp,
      auditDir: ".pi/audit",
    });
    config.stages["develop"] = {
      ...config.stages["develop"],
      nextStage: "review",
      verify: { require: true, mode: "tool", verifyFile: ".pi/references/develop_spec/verify.md" },
    };
    const meta = makeTestMeta({ currentStage: "develop" });
    const sentMessages: string[] = [];
    const ctx = createMockCtx(meta, {
      pi: { sendUserMessage: (msg: string) => { sentMessages.push(msg); } },
    });

    // Tool mode doesn't go through agent_settled hook verify — hook skips it.
    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    expect(sentMessages.length).toBe(0);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("148 wake guard: sendUserMessage throws during fail wake → audit verify_fail_wake_failed", async () => {
    const stageTmp = await makeFailingVerifyTmp("pi-settled-wake-p4-2");

    const config = makeHookVerifyConfig(stageTmp, "develop");
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta, {
      pi: {
        sendUserMessage: (_msg: string) => {
          throw new Error("wake failure");
        },
      },
    });

    const hook = createAgentSettled(config);
    // Should not throw
    await expect(hook.handler(ctx as any)).resolves.toBeUndefined();

    // Audit log should contain verify_fail_wake_failed
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("verify_fail_wake_failed");
    expect(logContent).toContain("wake failure");

    await rm(stageTmp, { recursive: true, force: true });
  });
});
describe("Phase 3 (140): completionMarker precheck in agent_settled", () => {
  const markerTmp = join(tmpdir(), "pi-marker-settled-" + Date.now());

  it("completionMarker not on disk → skips verification, no verifyAttempts increment", async () => {
    const stageTmp = join(markerTmp, "no-marker");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Write requirement doc WITHOUT the marker
    await writeFile(join(stageTmp, "req.md"), "# Requirements\nNo marker here\n", "utf-8");

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
              verify: s === "clarify"
                ? { require: true, verifyFile: "verify.md", completionMarker: "## 模型确认" }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: "req.md",
      verifyAttempts: 0,
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // verifyAttempts must NOT be incremented (precheck skipped verification)
    expect(meta.verifyAttempts).toBe(0);
    // No stage advance occurred — metadataUpdates should be empty (no updateMeta calls)
    expect(ctx.metadataUpdates.length).toBe(0);
    expect(meta.currentStage).toBe("clarify");
    // Audit should contain verify_completion_marker_pending
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("verify_completion_marker_pending");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("completionMarker on disk → proceeds to normal verification", async () => {
    const stageTmp = join(markerTmp, "with-marker");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Write requirement doc WITH the marker
    await writeFile(
      join(stageTmp, "req.md"),
      "# Requirements\n## 模型确认\n- full-und? 理解确认：是\n",
      "utf-8",
    );

    // Create a verify.md that will pass (requiredFiles with existing file)
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nVerify\n",
      "utf-8",
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
              verify: s === "clarify"
                ? { require: true, verifyFile: "references/spec/verify.md", completionMarker: "## 模型确认" }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({
      currentStage: "clarify",
      requirementDoc: "req.md",
      verifyAttempts: 0,
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Verification ran and passed → stage should advance to plan
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("plan");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("no completionMarker configured → behavior unchanged (backward compatible)", async () => {
    const stageTmp = join(markerTmp, "no-config");
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create a verify.md that will pass
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nVerify\n",
      "utf-8",
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
              // No completionMarker configured
              verify: s === "clarify"
                ? { require: true, verifyFile: "references/spec/verify.md" }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Without completionMarker, verification runs normally → stage advances
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("plan");
    // No completionMarker audit
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).not.toContain("verify_completion_marker_pending");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── Phase 3 (148): verify config skip flows through agent_settled ──────────

describe("Phase 3 (148): agent_settled verify config skip", () => {
  it("config error (missing verify.md) → notify + audit verify_config_skip + auto-advance (pass)", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-skip-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await mkdir(join(stageTmp, ".pi", "audit"), { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp, auditDir: ".pi/audit" }));

    const config = makeTestConfig({ projectRoot: stageTmp, auditDir: ".pi/audit" });
    config.stages["develop"] = {
      ...config.stages["develop"],
      nextStage: "review",
      verify: { require: true },
    };
    const meta = makeTestMeta({ currentStage: "develop" });

    const notifies: string[] = [];
    const ctx = {
      _ctx: { messages: [] },
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => Object.assign(meta, m),
      },
      pi: { sendUserMessage: () => {} },
      ui: { notify: (msg?: string) => { if (msg) notifies.push(msg); } },
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should have notified about config skip
    expect(notifies.some(n => n.includes("config error"))).toBe(true);
    // Should have advanced (pass path)
    expect(meta.currentStage).toBe("review");
    // Should have audit log verify_config_skip
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("verify_config_skip");
    // M1 fix: skipped must NOT write auto_verify_pass audit
    expect(logContent).not.toContain("auto_verify_pass");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

describe("Phase 4 (162): agent_settled confirm gate integration", () => {
  function makePlanConfigWithConfirm(root: string, mode: "auto" | "manual" | "smart") {
    const base = makeTestConfig({ projectRoot: root });
    const planStage = {
      ...base.stages.plan,
      nextStage: "develop" as PipelineStage,
      verify: { require: true },
      allowedWritePaths: ["docs/"],
      confirm: { mode },
    };
    return {
      ...base,
      stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
    };
  }

  async function createPlanDoc(root: string, content: string) {
    const docsDir = join(root, "docs", "design");
    await mkdir(docsDir, { recursive: true });
    const planPath = join(docsDir, "77_Config_plan.md");
    await writeFile(planPath, content, "utf-8");
    return planPath;
  }

  async function createVerifyMd(root: string, content: string) {
    const stageDir = join(root, ".pi", "references", "plan_spec");
    await mkdir(stageDir, { recursive: true });
    const verifyPath = join(stageDir, "verify.md");
    await writeFile(verifyPath, content, "utf-8");
  }

  it("smart mode: short-circuits with confirm_smart_defer_to_tool audit", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-smart-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "smart");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("confirm_smart_defer_to_tool");
    // Stage should not change
    expect(meta.currentStage).toBe("plan");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("auto mode: pre-writes bilingual marker before verify (confirm_auto_write)", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-auto-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "auto");
    await createPlanDoc(stageTmp, "# Plan\nplan content here\n");
    // verify.md with requiredFiles pointing to existing plan doc → passes
    await createVerifyMd(stageTmp, `---
requiredFiles:
  - "docs/design/77_Config_plan.md"
---
Verify plan quality.`);

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
    });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_auto_write");

    // Plan doc should have bilingual marker
    const planDoc = await readFile(join(stageTmp, "docs", "design", "77_Config_plan.md"), "utf-8");
    expect(planDoc).toContain("## 用户确认：确认无误");
    expect(planDoc).toContain("## User Confirmation: Confirmed");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("manual mode: triggers confirm gate — approve advances to develop", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-manual-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    const planPath = await createPlanDoc(stageTmp, "# Plan\nplan content here\n");
    // verify.md with requiredFiles pointing to existing plan doc → passes
    const relPlanPath = "docs/design/77_Config_plan.md";
    await createVerifyMd(stageTmp, `---
requiredFiles:
  - "${relPlanPath}"
---
Verify plan.`);

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
    });
    // select returns "Approve & Advance" to simulate user approval
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Advance" });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // After approval, should advance to develop
    expect(meta.currentStage).toBe("develop");
    expect(meta.confirmRejections).toBeUndefined();

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_approved");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("deferContentPatterns: plan marker rule does not block verify in manual mode", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-defer-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makePlanConfigWithConfirm(stageTmp, "manual");
    // Plan doc WITHOUT the confirmation marker
    await createPlanDoc(stageTmp, "# Plan\nplan content here\nno marker yet\n");
    // verify.md with a requiredFiles rule (passes) + the plan marker rule that should be deferred
    await createVerifyMd(stageTmp, `---
requiredFiles:
  - "docs/design/77_Config_plan.md"
fileContentPattern:
  - path: "docs/design/*_plan.md"
    pattern: "^## (用户确认|User Confirmation)"
---
Verify plan.`);

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
    });
    // Select returns undefined (Esc) — pending
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    // Deferral should have been applied (marker rule skipped during verify)
    expect(logContent).toContain("verify_rule_deferred");
    // Confirm gate triggered — Esc → pending
    expect(logContent).toContain("confirm_pending");
    // Stage should not change (pending)
    expect(meta.currentStage).toBe("plan");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── Phase 1 (163): review_declaration_missing audit in agent_settled ─────────

describe("Phase 1 (163): review_declaration_missing audit", () => {
  it("review settle without declaration → auto mode falls through to verify (Bug 4)", async () => {
    const stageTmp = join(tmpdir(), "pi-163-decl-missing-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Config: review stage with verify.require=true, hook mode
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
              verify: s === "review"
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    // Create verify.md that passes (requiredFiles exists)
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Bug 4: No review report → null verdict → auto mode falls through to verify
    // Verify passes → auto-advance to next stage (fix, per test config)
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("fix");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("review settle with advancedThisTurn=true → hook skips (no review_declaration_missing)", async () => {
    const stageTmp = join(tmpdir(), "pi-163-decl-skip-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({ currentStage: "review", advancedThisTurn: true });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should have audit hook_skip_after_manual_advance (not review_declaration_missing)
    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("hook_skip_after_manual_advance");
    expect(logContent).not.toContain("review_declaration_missing");

    await rm(stageTmp, { recursive: true, force: true });
  });

  // 163 fix: reviewConclusionDeclared=true suppresses false-positive review_declaration_missing
  // when the model declared reviewConclusion but stage did not advance (verify fail / gate pending).
  it("review settle with reviewConclusionDeclared=true → no review_declaration_missing audit", async () => {
    const stageTmp = join(tmpdir(), "pi-163-decl-flag-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Config: review stage with verify.require=true, hook mode (same as the missing-decl test)
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
              verify: s === "review"
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    // Create verify.md that passes
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    // reviewConclusionDeclared=true simulates the model calling stage_advance({ reviewConclusion })
    // but the stage did not advance (e.g., verify fail or confirm gate pending).
    const meta = makeTestMeta({ currentStage: "review", reviewConclusionDeclared: true });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should NOT have review_declaration_missing (declaration was made)
    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).not.toContain("review_declaration_missing");

    // The flag should have been cleared after consumption
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.reviewConclusionDeclared).toBeUndefined();

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ─── Bug 4: manual mode review decision chain ───────────────────────────────

describe("Bug 4: agent-settled manual mode review decision chain", () => {
  /** Helper: build review-stage config with manual confirm mode */
  function makeReviewManualConfig(stageTmp: string) {
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
              verify: s === "review"
                ? { require: true, verifyFile: "references/spec/verify.md", mode: "hook" as const }
                : undefined,
              ...(s === "review" ? { confirm: { mode: "manual" as const }, allowedWritePaths: ["docs/"] } : {}),
            },
          ],
        ),
      ) as any,
    });
  }

  async function setupVerifyAndReport(stageTmp: string, reportContent: string) {
    // verify.md that passes
    const vrDir = join(stageTmp, "references", "spec");
    await mkdir(vrDir, { recursive: true });
    await writeFile(
      join(vrDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"exists.md\"\n---\nBody\n",
    );
    await writeFile(join(stageTmp, "exists.md"), "content");

    // Write review report
    const reviewDir = join(stageTmp, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_test.md"), reportContent, "utf-8");
  }

  it("manual mode: report fail → select shows Reject first → user picks Reject → confirmRejections+1 → route fix", async () => {
    const stageTmp = join(tmpdir(), "pi-manual-reject-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeReviewManualConfig(stageTmp);
    await setupVerifyAndReport(stageTmp,
      "# Review\n### 问题 1\n- 等级：Blocker\n- 是否修复：待修复\n\n## 结论\n- 结论：通过\n");

    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 0 });
    // User picks "Reject & Send to Fix" (which is first due to defaultReject=true)
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Send to Fix" });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should route to fix stage
    expect(meta.currentStage).toBe("fix");
    // confirmRejections should be incremented to 1
    expect(meta.confirmRejections).toBe(1);

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    // Should have confirm rejection audit
    expect(logContent).toContain("confirm_rejected");

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("manual mode: report fail → select shows Reject first → user picks Approve → completed, confirmRejections cleared", async () => {
    const stageTmp = join(tmpdir(), "pi-manual-approve-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeReviewManualConfig(stageTmp);
    await setupVerifyAndReport(stageTmp,
      "# Review\n### 问题 1\n- 等级：Blocker\n- 是否修复：待修复\n\n## 结论\n- 结论：通过\n");

    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 0 });
    // User picks "Approve & Complete" (despite Reject being first)
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Complete" });

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should advance to completed
    expect(meta.currentStage).toBe("completed");
    // confirmRejections should be cleared (approve resets counter)
    expect(meta.confirmRejections).toBeUndefined();

    const logPath = join(stageTmp, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("confirm_approved");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── 168 Phase 0: precheckRequiredFiles integration in agent_settled ──────────

describe("168 Phase 0: precheckRequiredFiles in agent_settled hook", () => {
  it("requiredFiles missing → verify_precheck_deferred audit, no runVerification, verifyAttempts not incremented, no freeze", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-precheck-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create verify.md with requiredFiles that don't exist
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
                ? { require: true, verifyFile: "references/develop_spec/verify.md", mode: "hook" as const }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "develop", verifyAttempts: 0 });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // verifyAttempts must NOT be incremented (precheck deferred)
    expect(meta.verifyAttempts).toBe(0);
    // Pipeline should NOT be frozen
    expect(meta.flowState).toBeUndefined();
    // Stage should NOT advance
    expect(meta.currentStage).toBe("develop");
    // No verifyFailures written (runVerification was NOT called)
    const verifyUpdates = ctx.metadataUpdates.filter(u => u.verifyFailures);
    expect(verifyUpdates.length).toBe(0);
    // Audit should contain verify_precheck_deferred
    const logContent = await readFile(join(stageTmp, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("verify_precheck_deferred");
    expect(logContent).toContain("nonexistent.md");
    // Should NOT contain auto_verify_fail (full verification was not run)
    expect(logContent).not.toContain("auto_verify_fail");

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── 168 Phase 2: agent_settled frozen re-popup ──────────────────────────────

describe("168 Phase 2: agent_settled frozen re-popup", () => {
  it("frozen agent_settled triggers ui.select (decision menu re-popup)", async () => {
    const stageTmp = join(tmpdir(), "pi-settled-repopup-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta, {
      selectReturn: undefined, // Esc → stay blocked
    });
    // Track ui.select calls
    const origSelect = ctx.ui.select;
    ctx.ui.select = async (msg: string, opts: string[]) => {
      selectCalls++;
      return origSelect!(msg, opts);
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // ui.select should have been called (decision menu re-popped up)
    expect(selectCalls).toBe(1);

    await rm(stageTmp, { recursive: true, force: true });
  });
});

// ── Phase 4 (169) P1: W1 terminal compact wiring in agent_settled ─────────────
//
// Locks the plan Phase 4验收 requirement:
// - W1: completed + no consumed flag → helper is called
// - W1: advancedThisTurn=true + completed → helper still called (locks pre-short-circuit)
// - W1: already consumed → helper is NOT called

describe("Phase 4 (169) P1: W1 terminal compact wiring", () => {
  it("W1: completed + no consumed flag → maybeCompactOnPipelineCompleted is called", async () => {
    const stageTmp = join(tmpdir(), "pi-169-w1-called-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // No verify.require on completed → hook returns after W1 check
    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "completed",
      pipelineId: "pipe-w1-001",
      // No terminalCompact flag → helper should be called
    });

    // Track compact calls via _ctx mock
    let compactCalled = false;
    const ctx = createMockCtx(meta);
    (ctx as any)._ctx = {
      ...((ctx as any)._ctx ?? {}),
      isIdle: () => true,
      compact: () => { compactCalled = true; },
      getContextUsage: () => ({ tokens: 1000 }), // below threshold → skips, but proves call
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Guard consumed the flag (below_threshold or compacted) — W1 was reached
    // The helper ran: either terminalCompact is set or compact was invoked
    const freshMeta = meta;
    // Helper was invoked: if tokens below threshold, it set skipped_below_threshold;
    // otherwise it attempted compact. Either way, the call happened.
    expect(freshMeta.terminalCompact !== undefined || compactCalled).toBe(true);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("W1: already consumed (terminalCompact set) → helper is a no-op", async () => {
    const stageTmp = join(tmpdir(), "pi-169-w1-noop-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "completed",
      pipelineId: "pipe-w1-consumed",
      terminalCompact: { outcome: "compacted", at: Date.now() },
    });

    let compactCalled = false;
    const ctx = createMockCtx(meta);
    (ctx as any)._ctx = {
      ...((ctx as any)._ctx ?? {}),
      isIdle: () => true,
      compact: () => { compactCalled = true; },
      getContextUsage: () => ({ tokens: 200_000 }),
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Helper returned early (terminalCompact already set) — compact must NOT be called
    expect(compactCalled).toBe(false);

    await rm(stageTmp, { recursive: true, force: true });
  });

  it("W1: advancedThisTurn=true + completed → helper still called (pre-short-circuit)", async () => {
    const stageTmp = join(tmpdir(), "pi-169-w1-advturn-" + Date.now());
    await mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "completed",
      pipelineId: "pipe-w1-adv",
      advancedThisTurn: true, // set by stage_advance tool
    });

    let compactCalled = false;
    const ctx = createMockCtx(meta);
    (ctx as any)._ctx = {
      ...((ctx as any)._ctx ?? {}),
      isIdle: () => true,
      compact: () => { compactCalled = true; },
      getContextUsage: () => ({ tokens: 1000 }),
    };

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // W1 fires BEFORE advancedThisTurn short-circuit → helper reached
    expect(meta.terminalCompact !== undefined || compactCalled).toBe(true);

    await rm(stageTmp, { recursive: true, force: true });
  });
});
