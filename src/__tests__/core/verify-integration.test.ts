import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { generateVerifyFiles } from "../../core/verify-generator";
import { createAgentSettled } from "../../core/agent-settled";
import { createPromptInjector } from "../../core/prompt-injector";
import { createLoopBreaker } from "../../core/loop-breaker";
import { runVerification } from "../../core/auto-verifier";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-verify-integration-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: TMP }));
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** Helper: create a config with verify.require on develop stage */
function makeConfigWithVerify(stages: string[] = ["develop"]) {
  return makeTestConfig({
    projectRoot: TMP,
    stages: Object.fromEntries(
      ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
        (s, i, a) => [
          s,
          {
            agentFile: "a.md",
            skillPath: `${s}/SKILL.md`,
            allowedTools: ["read", "bash", "write", "edit"],
            allowedBashPrefixes: ["ls", "bun", "git", "echo"],
            nextStage: a[i + 1] ?? null,
            requireDomain: false,
            verify: stages.includes(s) ? { require: true } : undefined,
          },
        ],
      ),
    ) as any,
  });
}

describe("verify-integration", () => {
  // Scenario A: pipeline_start → verify.md missing → error
  it("Scenario A: pipeline_start fails when verify.md is missing", async () => {
    const config = makeConfigWithVerify(["develop"]);
    const reqPath = path.join(TMP, "req.md");
    await fs.writeFile(reqPath, "# Requirements\nDo something", "utf-8");

    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = {
      session: { getMeta: () => meta, updateMeta: (_p: any) => meta },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
      ui: { notify: () => {}, setStatus: () => {} },
    };

    const startCmd = createPipelineStartCommand(config);
    const result: any = await startCmd.execute({ file: "req.md" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("verify.md missing");
    expect(result.missingStages).toContain("develop");
    expect(result.suggestion).toContain("/pipeline-init 1");
  });

  // Scenario B: pipeline-init 1 → generate verify.md → start succeeds
  it("Scenario B: pipeline-init 1 generates verify.md, then pipeline_start succeeds", async () => {
    const config = makeConfigWithVerify(["develop"]);

    // Create a skill file with delivery markers
    const skillDir = path.join(TMP, ".pi", "skills", "develop");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "- **Must** run bun run build\n- **Must** create output.md\n",
    );

    // Run generateVerifyFiles (shared module)
    const results = await generateVerifyFiles(config, { stage: "develop" });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("generated");

    // Verify the file was created
    const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
    const verifyContent = await fs.readFile(verifyPath, "utf-8");
    expect(verifyContent).toContain("rules:");

    // Now pipeline_start should succeed
    const reqPath = path.join(TMP, "req.md");
    await fs.writeFile(reqPath, "# Requirements\n", "utf-8");
    const meta = makeTestMeta({ currentStage: "", pipelineId: "" } as any);
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (m: any) => Object.assign(meta, m),
      },
      _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
    };

    const startCmd = createPipelineStartCommand(config);
    const startResult: any = await startCmd.execute({ file: "req.md" }, ctx as any);
    expect(startResult.success).toBe(true);
  });

  // Scenario C: agent_settled + structured rules pass → advance
  it("Scenario C: agent_settled auto-advances when structured rules pass", async () => {
    const config = makeConfigWithVerify(["develop"]);

    // Create verify.md with a file that EXISTS
    const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n---\nBody\n",
    );
    // Create the required file
    await fs.writeFile(path.join(TMP, "output.md"), "content");

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);

    const hook = createAgentSettled(config);
    await hook.handler(ctx as any);

    // Should advance to next stage
    const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastUpdate.currentStage).toBe("review"); // next after develop
  });

  // Scenario D: agent_settled + structured rules fail → verifyFailures in meta → prompt injection
  it("Scenario D: agent_settled writes verifyFailures, prompt-injector shows them", async () => {
    const config = makeConfigWithVerify(["develop"]);

    // Create verify.md with a file that DOESN'T exist
    const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"missing-file.md\"\n---\nBody\n",
    );

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);

    // Run agent_settled — should fail verification
    const settledHook = createAgentSettled(config);
    await settledHook.handler(ctx as any);

    // Meta should have verifyFailures
    const lastMeta = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastMeta.currentStage).toBe("develop"); // NOT advanced
    expect(lastMeta.verifyFailures).toBeDefined();
    expect(lastMeta.verifyFailures!.length).toBeGreaterThan(0);
    expect(lastMeta.verifyFailures![0].ruleType).toBe("requiredFiles");

    // Now run prompt-injector — should include failures
    const injectorHook = createPromptInjector(config);
    const promptResult = await injectorHook.handler({
      session: { getMeta: () => lastMeta },
    } as any);

    expect(promptResult.systemPrompt).toContain("PREVIOUS VERIFICATION FAILURES");
    expect(promptResult.systemPrompt).toContain("[requiredFiles]");
    expect(promptResult.systemPrompt).toContain("missing-file.md");
  });

  // Scenario E: loop-breaker detects verifyFailures → loopCount increments → freeze on overflow
  it("Scenario E: loop-breaker freezes pipeline on verifyFailure loop overflow", async () => {
    const config = makeConfigWithVerify(["develop"]);
    config.maxLoops = 2;

    const meta = makeTestMeta({
      currentStage: "develop",
      loopCount: 1,
      maxLoops: 2,
      verifyFailures: [{ ruleType: "requiredFiles", detail: "Missing", timestamp: Date.now() }],
    });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "bash", arguments: { command: "npm test" } };
    ctx.result = { exitCode: 1 };

    const hook = createLoopBreaker(config);
    await hook.handler(ctx as any);

    // Should terminate due to loop overflow
    const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastUpdate.terminated).toBe(true);
    expect(lastUpdate.terminateReason).toContain("loop_overflow");
  });

  // Scenario F: backward compatibility — old format verify.md (keywords only) still works
  it("Scenario F: backward compatibility — keyword-only verify.md works", async () => {
    const config = makeConfigWithVerify(["develop"]);

    const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  keywords:\n    - \"done\"\n  mode: or\n---\nBody\n",
    );

    const meta = makeTestMeta({ currentStage: "develop" });

    // Keywords match → should pass
    const result1 = await runVerification(config, meta, ["task is done"]);
    expect(result1.rulePassed).toBe(true);

    // Keywords don't match → should fail
    const result2 = await runVerification(config, meta, ["nothing relevant"]);
    expect(result2.rulePassed).toBe(false);
    expect(result2.needsModelVerify).toBe(true);
  });

  // Scenario G: no verify.md file → needsModelVerify
  it("Scenario G: missing verify.md file returns needsModelVerify", async () => {
    const config = makeConfigWithVerify(["develop"]);
    // No verify.md file created

    const meta = makeTestMeta({ currentStage: "develop" });
    const result = await runVerification(config, meta, []);

    expect(result.rulePassed).toBe(false);
    expect(result.needsModelVerify).toBe(true);
  });

  // ── Phase 4: LLM verification layer removed (Q6-B) ─────────────────────
  // LLM-related scenarios (H, I, J, L) removed — verification is now structured-only.

  // ── Phase 117-2: LLM extraction restored with audit ─────────────────────

  it("Scenario LLM-1: llmExtract=true + callLLM merges items into verify.md", async () => {
    const config = makeConfigWithVerify(["develop"]);
    (config as any).llmExtract = true;

    // Create a skill file with one hardcoded marker
    const skillDir = path.join(TMP, ".pi", "skills", "develop");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "- **Must** hardcoded-file.md\n",
    );

    // Mock callLLM returns one LLM item
    const callLLM = async (_prompt: string): Promise<string> => {
      return JSON.stringify([{ type: "file", target: "llm-extracted-file.md" }]);
    };

    const results = await generateVerifyFiles(config, { stage: "develop", callLLM });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("generated");
    expect(results[0].hardcodedCount).toBe(1);
    expect(results[0].llmCount).toBe(1);
    expect(results[0].llmStatus).toBe("ok");

    // Verify both items appear in verify.md
    const verifyPath = path.join(TMP, ".pi", "references", "develop_spec", "verify.md");
    const content = await fs.readFile(verifyPath, "utf-8");
    expect(content).toContain("hardcoded-file.md");
    expect(content).toContain("llm-extracted-file.md");
  });

  it("Scenario LLM-2: llmExtract=true + callLLM failure → fallback to hardcoded only", async () => {
    const config = makeConfigWithVerify(["develop"]);
    (config as any).llmExtract = true;

    const skillDir = path.join(TMP, ".pi", "skills", "develop");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "- **Must** fallback-file.md\n",
    );

    const callLLM = async (): Promise<string> => {
      throw new Error("LLM connection failed");
    };

    const results = await generateVerifyFiles(config, { stage: "develop", callLLM });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("generated");
    expect(results[0].hardcodedCount).toBe(1);
    expect(results[0].llmCount).toBe(0);
    expect(results[0].llmStatus).toBe("fail");
  });

  it("Scenario LLM-3: llmExtract=false ignores callLLM even if provided", async () => {
    const config = makeConfigWithVerify(["develop"]);
    // llmExtract defaults to undefined/false

    const skillDir = path.join(TMP, ".pi", "skills", "develop");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "- **Must** only-hardcoded.md\n",
    );

    let callCount = 0;
    const callLLM = async (): Promise<string> => {
      callCount++;
      return JSON.stringify([{ type: "file", target: "should-not-appear.md" }]);
    };

    const results = await generateVerifyFiles(config, { stage: "develop", callLLM });
    expect(callCount).toBe(0);
    expect(results[0].llmStatus).toBe("off");
    expect(results[0].llmCount).toBe(0);
  });

  // Scenario K: verifyFailures + write/edit loop → loopCount increments → freeze
  it("Scenario K: verifyFailures + write/edit cycle → loopCount throttled increment → freeze", async () => {
    const config = makeConfigWithVerify(["develop"]);
    config.maxLoops = 3;

    const meta = makeTestMeta({
      currentStage: "develop",
      loopCount: 0,
      maxLoops: 3,
      verifyAttempts: 1,
      verifyFailures: [{ ruleType: "requiredFiles", detail: "Missing file", timestamp: Date.now() }],
    });
    const ctx = createMockCtx(meta);

    const hook = createLoopBreaker(config);

    // Write #1 at verifyAttempts=1 → loopCount becomes 1
    ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/a.ts" } };
    ctx.result = { success: true };
    await hook.handler(ctx as any);
    expect(ctx.metadataUpdates[ctx.metadataUpdates.length - 1].loopCount).toBe(1);

    // Write #2 at same verifyAttempts=1 → throttled, loopCount stays 1
    ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/b.ts" } };
    ctx.result = { success: true };
    await hook.handler(ctx as any);
    expect(ctx.metadataUpdates[ctx.metadataUpdates.length - 1].loopCount).toBe(1);

    // Simulate new verification cycle: verifyAttempts becomes 2
    Object.assign(meta, { verifyAttempts: 2 });

    // Write #3 at verifyAttempts=2 → loopCount becomes 2
    ctx.toolCall = { name: "edit", arguments: { file_path: "/tmp/c.ts" } };
    ctx.result = { success: true };
    await hook.handler(ctx as any);
    expect(ctx.metadataUpdates[ctx.metadataUpdates.length - 1].loopCount).toBe(2);

    // Simulate another verification cycle: verifyAttempts becomes 3
    Object.assign(meta, { verifyAttempts: 3 });

    // Write #4 at verifyAttempts=3 → loopCount becomes 3 → freeze (maxLoops=3)
    ctx.toolCall = { name: "write", arguments: { file_path: "/tmp/d.ts" } };
    ctx.result = { success: true };
    await hook.handler(ctx as any);

    const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastUpdate.loopCount).toBe(3);
    expect(lastUpdate.terminated).toBe(true);
    expect(lastUpdate.terminateReason).toBe("verify_failure_loop_overflow");
  });

  // ── Phase 2: Template default config → 6 stages all generated ────────────

  it("template default: 6 active stages with skillPath config all generate verify.md", async () => {
    // Resolve template directory (src/template/ in dev/test)
    const templateDir = path.resolve(__dirname, "..", "..", "template");

    // Copy template skill files into .pi/skills/ in the temp directory
    const templateSkillsDir = path.join(templateDir, "skills");
    const piSkillsDir = path.join(TMP, ".pi", "skills");

    for (const stageDir of ["design", "plan", "develop", "review", "fix"]) {
      const srcDir = path.join(templateSkillsDir, stageDir);
      const destDir = path.join(piSkillsDir, stageDir);
      await fs.mkdir(destDir, { recursive: true });
      const content = await fs.readFile(path.join(srcDir, "SKILL.md"), "utf-8");
      await fs.writeFile(path.join(destDir, "SKILL.md"), content, "utf-8");
    }

    // Build config matching template pipeline_loop.json with skillPath
    const config = makeTestConfig({
      projectRoot: TMP,
      stages: Object.fromEntries(
        ["clarify", "design", "plan", "develop", "review", "fix", "awaiting_human", "completed"].map(
          (s, i, a) => [
            s,
            {
              agentFile: "a.md",
              skillPath: s === "clarify"
                ? "design/SKILL.md"  // clarify shares design skill
                : `${s}/SKILL.md`,
              allowedTools: ["read", "bash", "write", "edit"],
              allowedBashPrefixes: ["ls", "bun", "git"],
              nextStage: a[i + 1] ?? null,
              requireDomain: false,
              verify: ["clarify", "design", "plan"].includes(s)
                ? { require: true }
                : undefined,
            },
          ],
        ),
      ) as any,
    });

    const results = await generateVerifyFiles(config);
    const generated = results.filter(r => r.status === "generated");
    const skipped = results.filter(r => r.status === "skipped");

    // All 6 active stages should generate verify.md (template skills have **必须** markers)
    expect(generated.length).toBe(6);
    expect(skipped.length).toBe(0);

    // Verify no keyword-only items leaked through (phrase-bold filtering works)
    for (const r of generated) {
      expect(r.hardcodedCount).toBeGreaterThan(0);
    }
  });
});
