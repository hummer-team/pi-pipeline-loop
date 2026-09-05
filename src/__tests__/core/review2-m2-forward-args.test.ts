/**
 * @module review2-m2-forward-args
 * Tests for review#2 M2: forwardArgs passthrough on 4 residual branches.
 * Phase 3 Q3-A: explicit forwardArgs are passed through unconditionally.
 *
 * review#3 H1 fix: Each test now provides a mock pi with EventBus that captures
 * the spawn RPC prompt, and asserts the prompt contains the user's original
 * forwardArgs content (not just success/stage proxy assertions).
 * Removing forwardArgs from the implementation must turn each test red.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";

/** Write an agent definition file so resolveAgentMention returns a name. */
async function writeAgentFile(
  projectRoot: string,
  agentPath: string,
  name: string,
): Promise<void> {
  const fullPath = path.join(projectRoot, agentPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(fullPath, `---\nname: ${name}\n---\n# Agent\n`);
}

/**
 * Build a mock pi EventBus that auto-responds to ping+spawn RPCs.
 * Captures all emitted events so tests can inspect the spawn prompt.
 */
function createMockEventBus() {
  const capturedEmits: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(payload: unknown) => void>>();

  const bus = {
    emit(event: string, payload: Record<string, unknown>) {
      capturedEmits.push({ event, payload });
      if (event === "subagents:rpc:ping") {
        setTimeout(
          () =>
            (handlers.get(`subagents:rpc:ping:reply:${payload.requestId}`) ?? [])
              .forEach((h) => h({ success: true })),
          5,
        );
      } else if (event === "subagents:rpc:spawn") {
        setTimeout(
          () =>
            (handlers.get(`subagents:rpc:spawn:reply:${payload.requestId}`) ?? [])
              .forEach((h) =>
                h({ success: true, data: { id: `subagent-m2-${Date.now()}` } }),
              ),
          5,
        );
      }
    },
    on(event: string, handler: (payload: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event: string, handler: (payload: unknown) => void) {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
  };

  return { bus, capturedEmits };
}

describe("M2: forwardArgs passthrough on residual branches", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-r2-forward-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
  });

  it("M2a: aborted + different doc + forwardArgs → spawn prompt contains user forwardArgs verbatim", async () => {
    // Write both old and new docs
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "old.md"), "# Old\n", "utf-8");
    await fsp.writeFile(path.join(TMP, "docs", "new.md"), "# New\n", "utf-8");

    // Write agent file so resolveAgentMention("clarify") returns a name
    const config = makeTestConfig({ projectRoot: TMP, startStageMode: "auto" });
    await writeAgentFile(TMP, config.stages["clarify"].agentPath!, "feat-design-plan-agent");

    const cmd = createPipelineStartCommand(config);

    // Existing aborted pipeline for a different doc
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "aborted",
      requirementDoc: "docs/old.md",
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });

    // Attach mock pi with EventBus (captures spawn prompt)
    const { bus, capturedEmits } = createMockEventBus();
    (ctx as any).pi = { events: bus };

    // Execute with a NEW doc + forwardArgs
    const result: any = await cmd.execute(
      { file: "docs/new.md", forwardArgs: "focus-on-X" },
      ctx as any,
    );

    // Different doc → goes to startNewPipeline → maybeAutoLaunchClarify → RPC spawn
    expect(result.success).toBe(true);
    expect(result.currentStage).toBe("clarify");
    expect(ctx.session.getMeta().requirementDoc).toBe("docs/new.md");

    // H1 key assertion: the spawn RPC prompt must contain the user's forwardArgs verbatim.
    // If forwardArgs is removed from the implementation, the prompt would be derived from
    // doc text (fresh doc → "1") and would NOT contain "focus-on-X" → test turns red.
    const spawnEmit = capturedEmits.find((e) => e.event === "subagents:rpc:spawn");
    expect(spawnEmit).toBeDefined();
    const spawnPrompt = (spawnEmit!.payload as any).prompt as string;
    expect(spawnPrompt).toContain("focus-on-X");
  });

  it("M2b: fresh + mode=ask + 'New pipeline' + forwardArgs → spawn prompt contains user forwardArgs verbatim", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "feature.md"), "# Feature\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: TMP,
      startStageMode: "ask",
    });
    await writeAgentFile(TMP, config.stages["clarify"].agentPath!, "feat-design-plan-agent");

    const cmd = createPipelineStartCommand(config);
    const freshMeta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = createMockCtx(freshMeta, {
      sessionFile: "main-session",
      selectReturn: "New pipeline",
      confirmReturn: true,
    });

    // Attach mock pi with EventBus
    const { bus, capturedEmits } = createMockEventBus();
    (ctx as any).pi = { events: bus };

    const result: any = await cmd.execute(
      { file: "docs/feature.md", forwardArgs: "full-und?" },
      ctx as any,
    );

    expect(result.success).toBe(true);
    expect(result.currentStage).toBe("clarify");

    // H1 key assertion: spawn prompt must contain "full-und?" from forwardArgs.
    // Removing forwardArgs from handleAskMenu→startNewPipeline would cause derivation
    // from fresh doc → "1" → prompt would not contain "full-und?" → test turns red.
    const spawnEmit = capturedEmits.find((e) => e.event === "subagents:rpc:spawn");
    expect(spawnEmit).toBeDefined();
    const spawnPrompt = (spawnEmit!.payload as any).prompt as string;
    expect(spawnPrompt).toContain("full-und?");
  });

  it("M2c: ask menu 'Spec stage' → clarify + forwardArgs → spawn prompt contains user forwardArgs verbatim", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "feature.md"), "# Feature\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: TMP,
      startStageMode: "ask",
    });
    await writeAgentFile(TMP, config.stages["clarify"].agentPath!, "feat-design-plan-agent");

    const cmd = createPipelineStartCommand(config);
    const freshMeta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = createMockCtx(freshMeta, {
      sessionFile: "main-session",
      confirmReturn: true,
    });
    // First select: "Spec stage", second select: "Start at: clarify"
    const origSelect = ctx.ui.select;
    let selectCalls = 0;
    ctx.ui.select = async (_msg: string, opts: string[]) => {
      selectCalls++;
      if (selectCalls === 1) return "Spec stage";
      if (selectCalls === 2) return "Start at: clarify";
      return origSelect?.(_msg, opts);
    };

    // Attach mock pi with EventBus
    const { bus, capturedEmits } = createMockEventBus();
    (ctx as any).pi = { events: bus };

    const result: any = await cmd.execute(
      { file: "docs/feature.md", forwardArgs: "focus-on-review" },
      ctx as any,
    );

    // Spec stage 'clarify' → startNewPipeline with startStage=clarify → maybeAutoLaunchClarify
    expect(result.success).toBe(true);
    expect(result.currentStage).toBe("clarify");

    // H1 key assertion: spawn prompt must contain "focus-on-review" from forwardArgs.
    // Removing forwardArgs from handleAskMenu→startNewPipeline spec-stage branch would
    // cause derivation from fresh doc → "1" → prompt would not contain "focus-on-review" → red.
    const spawnEmit = capturedEmits.find((e) => e.event === "subagents:rpc:spawn");
    expect(spawnEmit).toBeDefined();
    const spawnPrompt = (spawnEmit!.payload as any).prompt as string;
    expect(spawnPrompt).toContain("focus-on-review");
  });

  // M2 fallback path: when pi.events is absent but sendUserMessage is available,
  // maybeAutoLaunchClarify falls through to the sendUserMessage fallback.
  // This test verifies forwardArgs content reaches the fallback message.
  it("M2-fallback: aborted + diff doc + forwardArgs + sendUserMessage (no events) → message contains forwardArgs", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "old.md"), "# Old\n", "utf-8");
    await fsp.writeFile(path.join(TMP, "docs", "new.md"), "# New\n", "utf-8");

    const config = makeTestConfig({ projectRoot: TMP, startStageMode: "auto" });
    await writeAgentFile(TMP, config.stages["clarify"].agentPath!, "feat-design-plan-agent");

    const cmd = createPipelineStartCommand(config);
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "aborted",
      requirementDoc: "docs/old.md",
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });

    // Provide pi with sendUserMessage but NO events bus → fallback path
    const sentMessages: string[] = [];
    (ctx as any).pi = {
      sendUserMessage: (msg: string) => { sentMessages.push(msg); },
    };

    await cmd.execute(
      { file: "docs/new.md", forwardArgs: "focus-on-fallback" },
      ctx as any,
    );

    // The fallback sendUserMessage message must contain the forwardArgs content.
    // Removing forwardArgs → effectiveArgs derived from fresh doc → "1" →
    // message would contain "1" not "focus-on-fallback" → test turns red.
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("focus-on-fallback");
  });

  // M2 no-pi path: when ctx.pi is completely absent, maybeAutoLaunchClarify
  // falls through to the notify-only path. This verifies forwardArgs still
  // reaches the user-visible notification.
  it("M2-no-pi: aborted + diff doc + forwardArgs + no pi → notify text contains forwardArgs", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "old.md"), "# Old\n", "utf-8");
    await fsp.writeFile(path.join(TMP, "docs", "new.md"), "# New\n", "utf-8");

    const config = makeTestConfig({ projectRoot: TMP, startStageMode: "auto" });
    // Don't write agent file → resolveAgentMention returns null → notify-only path
    const cmd = createPipelineStartCommand(config);
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "aborted",
      requirementDoc: "docs/old.md",
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });
    // No ctx.pi at all → notify fallback

    await cmd.execute(
      { file: "docs/new.md", forwardArgs: "focus-on-notify" },
      ctx as any,
    );

    // The notify text must contain forwardArgs content.
    // The notify message is: "Next: run @feat-design-plan-agent {file} {effectiveArgs}"
    // Removing forwardArgs → effectiveArgs = "1" (fresh doc) → notify won't contain "focus-on-notify" → red.
    const notifications = (ctx as any).notifications as string[];
    expect(notifications.length).toBeGreaterThan(0);
    const hasForwardArgs = notifications.some((n) => n.includes("focus-on-notify"));
    expect(hasForwardArgs).toBe(true);
  });
});
