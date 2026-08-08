import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import { createPipelineInitVerifyCommand } from "../../commands/pipeline-init-verify";
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
      session: { getMetadata: () => meta, updateMetadata: () => {} },
    };

    const startCmd = createPipelineStartCommand(config);
    const result: any = await startCmd.execute({ file: "req.md" }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("verify.md missing");
    expect(result.missingStages).toContain("develop");
    expect(result.suggestion).toContain("/pipeline_init_verify");
  });

  // Scenario B: pipeline_init_verify → generate verify.md → start succeeds
  it("Scenario B: pipeline_init_verify generates verify.md, then pipeline_start succeeds", async () => {
    const config = makeConfigWithVerify(["develop"]);

    // Create a skill file with delivery markers
    const skillDir = path.join(TMP, ".pi", "skills", "develop");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "- **Must** run bun run build\n- **Must** create output.md\n",
    );

    // Run pipeline_init_verify
    const initCmd = createPipelineInitVerifyCommand(config);
    const initResult: any = await initCmd.execute({ stage: "develop" });
    expect(initResult.success).toBe(true);

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
        getMetadata: () => meta,
        updateMetadata: (m: any) => Object.assign(meta, m),
      },
    };

    const startCmd = createPipelineStartCommand(config);
    const startResult: any = await startCmd.execute({ file: "req.md" }, ctx);
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
      session: { getMetadata: () => lastMeta },
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

  // ── Phase 3 regression: callLLM stub + LLM fail-closed ─────────────────────

  // Scenario H: callLLM stub injected → agent_settled can execute LLM verification path
  it("Scenario H: callLLM stub throws → LLM verification path degrades gracefully", async () => {
    const config = makeConfigWithVerify(["develop"]);

    // Create a verify.md with only Markdown body (no structured rules)
    const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  keywords:\n    - \"done\"\n  mode: or\n---\nCheck that the build output is valid and all tests pass.\n",
    );

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);

    // callLLM stub that throws (simulates pi SDK stub behavior)
    const callLLMStub = async (_prompt: string): Promise<string> => {
      throw new Error("LLM not available (pi SDK stub)");
    };

    const hook = createAgentSettled(config, { callLLM: callLLMStub });
    await hook.handler(ctx as any);

    // Should NOT crash — degrades gracefully
    const lastUpdate = ctx.metadataUpdates[ctx.metadataUpdates.length - 1];
    expect(lastUpdate).toBeDefined();
    // Since callLLM throws → parseVerifyIntent returns [] → fail-closed
    // + keywords "done" not in any assistant message → structured fails
    expect(lastUpdate.verifyFailures).toBeDefined();
  });

  // Scenario I: LLM parse returns empty instructions → overallPassed = false
  it("Scenario I: LLM returns unparseable output → LLM verification fails (fail-closed)", async () => {
    const config = makeConfigWithVerify(["develop"]);

    const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"existing-file.md\"\n---\nVague description that LLM cannot parse into instructions\n",
    );
    // Create the required file so structured rules pass
    await fs.writeFile(path.join(TMP, "existing-file.md"), "content");

    const meta = makeTestMeta({ currentStage: "develop" });

    // LLM returns garbage → parseVerifyIntent returns [] → fail-closed
    const badLLM = async (_prompt: string): Promise<string> => "not valid json at all";

    const result = await runVerification(config, meta, [], { callLLM: badLLM });

    // Structured rules pass (file exists), but LLM verification fails (fail-closed)
    expect(result.verifyResult).toBeDefined();
    expect(result.verifyResult!.llm).toBeDefined();
    expect(result.verifyResult!.llm!.passed).toBe(false);
    expect(result.verifyResult!.overallPassed).toBe(false);
  });

  // Scenario J: custom verify_prompt.md → pipeline_init_verify uses custom extraction
  it("Scenario J: custom verify_prompt.md is used for LLM extraction", async () => {
    const config = makeConfigWithVerify(["develop"]);

    // Create skill file
    const skillDir = path.join(TMP, ".pi", "skills", "develop");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Develop Skill\n\nSome content without markers.\n",
    );

    // Create custom verify_prompt.md
    const refsDir = path.join(TMP, ".pi", "references");
    await fs.mkdir(refsDir, { recursive: true });
    await fs.writeFile(
      path.join(refsDir, "verify_prompt.md"),
      "Extract API endpoint deliverables from the skill content.",
      "utf-8",
    );

    let receivedPrompt = "";
    const mockLLM = async (prompt: string): Promise<string> => {
      receivedPrompt = prompt;
      return JSON.stringify([{ type: "file", target: "api-routes.md" }]);
    };

    const cmd = createPipelineInitVerifyCommand(config, mockLLM);
    const result: any = await cmd.execute({ stage: "develop" });

    expect(result.success).toBe(true);
    expect(receivedPrompt).toContain("API endpoint deliverables");
  });

  // Scenario L: structured rules pass + LLM unavailable (callLLM throws) → overallPassed = true
  it("Scenario L: callLLM stub throws + structured rules pass → LLM layer skipped, structured result stands", async () => {
    const config = makeConfigWithVerify(["develop"]);

    // Create verify.md with structured rules that WILL pass + Markdown body (triggers LLM path)
    const verifyDir = path.join(TMP, ".pi", "references", "develop_spec");
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(
      path.join(verifyDir, "verify.md"),
      "---\nrules:\n  requiredFiles:\n    - \"output.md\"\n---\nCheck that the build output is valid and all tests pass.\n",
    );
    // Create the required file so structured rules pass
    await fs.writeFile(path.join(TMP, "output.md"), "content");

    const meta = makeTestMeta({ currentStage: "develop" });

    // callLLM stub that throws (simulates pi SDK stub behavior)
    const callLLMStub = async (_prompt: string): Promise<string> => {
      throw new Error("LLM not available (pi SDK stub)");
    };

    const result = await runVerification(config, meta, [], { callLLM: callLLMStub });

    // Structured rules pass (file exists), LLM unavailable (stub throws)
    // Fix: LLM layer is skipped when callLLM throws → structured result stands alone
    expect(result.verifyResult).toBeDefined();
    expect(result.verifyResult!.structured.passed).toBe(true);
    expect(result.verifyResult!.llm).toBeNull(); // LLM unavailable → not included
    expect(result.verifyResult!.overallPassed).toBe(true);
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
});
