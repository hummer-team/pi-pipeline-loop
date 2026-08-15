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
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
              agentFile: "a.md",
              skillPath: "s.md",
              allowedTools: ["read"],
              allowedBashPrefixes: ["ls"],
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
});
