import { describe, it, expect, beforeAll } from "bun:test";
import { createPipelineVerify } from "../../tools/pipeline-verify";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog } from "../../utils/auditLog";
import type { SessionMeta, PipelineStage } from "../../types";

// Use a stable module-level path (never cleaned up) to avoid shared auditDirPath
// conflicts with other test files that call initAuditLog in parallel
const TMP = join(tmpdir(), "pi-pipeline-verify-test-stable");

function createCtx(meta: SessionMeta) {
  const updates: SessionMeta[] = [];
  const notifications: string[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        const merged = { ...meta, ...patch };
        updates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
    },
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    updates,
    notifications,
  };
}

function makeConfigWithVerify(mode?: "hook" | "tool") {
  return makeTestConfig({
    projectRoot: TMP,
    stages: Object.fromEntries(
      ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
        (s, i, a) => [
          s,
          {
            agentFile: "a.md",
            skillPath: `${s}/SKILL.md`,
            allowedTools: ["read", "bash"],
            allowedBashPrefixes: ["ls", "bun"],
            nextStage: (a[i + 1] ?? null) as PipelineStage | null,
            requireDomain: false,
            verify:
              s === "develop"
                ? { require: true, verifyFile: "references/develop_spec/verify.md", mode }
                : undefined,
          },
        ],
      ),
    ) as any,
  });
}

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

describe("createPipelineVerify", () => {
  it("creates a tool named 'pipeline_verify'", () => {
    const tool = createPipelineVerify(makeTestConfig());
    expect(tool.name).toBe("pipeline_verify");
  });

  it("returns error when no session context", async () => {
    const tool = createPipelineVerify(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  // Scenario A: structured rules all pass → auto-advance
  it("Scenario A: all structured rules pass → auto-advance to next stage", async () => {
    const config = makeConfigWithVerify("tool");

    // Create verify.md with requiredFiles that WILL exist
    const verifyDir = join(TMP, "references", "develop_spec");
    await mkdir(verifyDir, { recursive: true });
    await writeFile(
      join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n---\nBody\n",
    );
    // Create the required file
    await writeFile(join(TMP, "output.md"), "content");

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const tool = createPipelineVerify(config);
    const result = await tool.execute({}, ctx as any) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.passed).toBe(true);

    // Should have advanced to next stage (review)
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("review");
  });

  // Scenario B: rules fail → verifyFailures written to SessionMeta
  it("Scenario B: rules fail → verifyFailures written to meta, no advance", async () => {
    const config = makeConfigWithVerify("tool");

    // Create verify.md with requiredFiles that DON'T exist
    const verifyDir = join(TMP, "references", "develop_spec");
    await mkdir(verifyDir, { recursive: true });
    await writeFile(
      join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"nonexistent-file.md\"\n---\nBody\n",
    );

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const tool = createPipelineVerify(config);
    const result = await tool.execute({}, ctx as any) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.failures).toBeDefined();
    expect((result.failures as unknown[]).length).toBeGreaterThan(0);

    // Should NOT have advanced
    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("develop");
    expect(lastUpdate.verifyFailures).toBeDefined();
    expect(lastUpdate.verifyFailures!.length).toBeGreaterThan(0);
  });

  // Scenario C: tool args missing → uses defaults from config
  it("Scenario C: no stage arg → defaults to current stage from meta", async () => {
    const config = makeConfigWithVerify("tool");

    // Create verify.md that will pass
    const verifyDir = join(TMP, "references", "develop_spec");
    await mkdir(verifyDir, { recursive: true });
    await writeFile(
      join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n---\nBody\n",
    );
    await writeFile(join(TMP, "output.md"), "content");

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    const tool = createPipelineVerify(config);
    // No stage arg provided — should default to current stage (develop)
    const result = await tool.execute({}, ctx as any) as Record<string, unknown>;

    expect(result.success).toBe(true);
  });

  it("returns error for stage without verification enabled", async () => {
    const config = makeConfigWithVerify("tool");
    // clarify stage has no verify config
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = createCtx(meta);

    const tool = createPipelineVerify(config);
    const result = await tool.execute({ stage: "clarify" }, ctx as any) as Record<string, unknown>;

    expect(result.error).toContain("does not have verification enabled");
  });

  // ── Phase 0: verifyFile override without config pollution ──

  it("verifyFile arg resolves to override path without polluting stageConfig", async () => {
    // Config where develop stage has verify.require=true but NO verifyFile
    const overrideTmp = join(tmpdir(), "pi-pipeline-verify-override-" + Date.now());
    await mkdir(overrideTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: overrideTmp }));

    // Create a custom verify.md at a non-default location
    const customVerifyDir = join(overrideTmp, "custom-verify");
    await mkdir(customVerifyDir, { recursive: true });
    await writeFile(
      join(customVerifyDir, "my-verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n---\nBody\n",
    );
    // Create the required file so verification passes
    await writeFile(join(overrideTmp, "output.md"), "content");

    const config = makeTestConfig({
      projectRoot: overrideTmp,
      stages: Object.fromEntries(
        ["clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentFile: "a.md",
              skillPath: `${s}/SKILL.md`,
              allowedTools: ["read", "bash"],
              allowedBashPrefixes: ["ls", "bun"],
              nextStage: (a[i + 1] ?? null) as PipelineStage | null,
              requireDomain: false,
              // develop stage: verify.require=true, but NO verifyFile set
              verify: s === "develop" ? { require: true } : undefined,
            },
          ],
        ),
      ) as any,
    });

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createCtx(meta);

    // Verify stageConfig.verify.verifyFile is undefined BEFORE the call
    expect(config.stages.develop.verify!.verifyFile).toBeUndefined();

    const tool = createPipelineVerify(config);
    const result = await tool.execute(
      { verifyFile: "custom-verify/my-verify.md" },
      ctx as any,
    ) as Record<string, unknown>;

    // Should have passed (found output.md via the override verify file)
    expect(result.success).toBe(true);
    expect(result.passed).toBe(true);

    // stageConfig.verify.verifyFile must remain undefined — NOT polluted
    expect(config.stages.develop.verify!.verifyFile).toBeUndefined();
  });
});
