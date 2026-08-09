import { describe, it, expect } from "bun:test";
import {
  parseVerifyIntent,
  executeLLMInstructions,
  judgeLLMResult,
  runLLMVerification,
} from "../../../core/verifiers/llm-verifier";
import type { VerificationInstruction } from "../../../core/auto-verifier";
import type { ExecFn } from "../../../types";
import { DEFAULT_VERIFY_PARSE_PROMPT, DEFAULT_VERIFY_JUDGE_PROMPT } from "../../../constants";

/** Mock LLM that returns predefined responses */
function createMockLLM(responses: string[]): (prompt: string) => Promise<string> {
  let callIndex = 0;
  return async (_prompt: string): Promise<string> => {
    const response = responses[callIndex] ?? "[]";
    callIndex++;
    return response;
  };
}

describe("parseVerifyIntent", () => {
  it("parses JSON array of instructions from LLM response", async () => {
    const mockLLM = createMockLLM([
      JSON.stringify([
        { checkType: "fileExists", target: "docs/commit.md" },
        { checkType: "command", target: "bun run build" },
      ]),
    ]);

    const instructions = await parseVerifyIntent(
      "Check that docs/commit.md exists and bun run build succeeds",
      DEFAULT_VERIFY_PARSE_PROMPT,
      mockLLM,
    );

    expect(instructions).toHaveLength(2);
    expect(instructions[0].checkType).toBe("fileExists");
    expect(instructions[0].target).toBe("docs/commit.md");
    expect(instructions[1].checkType).toBe("command");
  });

  it("handles JSON wrapped in markdown code blocks", async () => {
    const mockLLM = createMockLLM([
      '```json\n[{"checkType": "fileExists", "target": "test.md"}]\n```',
    ]);

    const instructions = await parseVerifyIntent("check", "prompt", mockLLM);
    expect(instructions).toHaveLength(1);
  });

  it("returns empty array on invalid JSON", async () => {
    const mockLLM = createMockLLM(["not json at all"]);
    const instructions = await parseVerifyIntent("check", "prompt", mockLLM);
    expect(instructions).toHaveLength(0);
  });

  it("filters out invalid checkType values", async () => {
    const mockLLM = createMockLLM([
      JSON.stringify([
        { checkType: "fileExists", target: "ok.md" },
        { checkType: "invalidType", target: "bad" },
      ]),
    ]);

    const instructions = await parseVerifyIntent("check", "prompt", mockLLM);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].checkType).toBe("fileExists");
  });

  it("returns null on LLM error (signals LLM unavailable)", async () => {
    const mockLLM = async (): Promise<string> => { throw new Error("LLM unavailable"); };
    const instructions = await parseVerifyIntent("check", "prompt", mockLLM);
    expect(instructions).toBeNull();
  });
});

describe("executeLLMInstructions", () => {
  it("dispatches fileExists to file verifier", async () => {
    const results = await executeLLMInstructions(
      [{ checkType: "fileExists", target: "/nonexistent/file.md" }],
      process.cwd(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].instruction.checkType).toBe("fileExists");
  });

  it("dispatches command to command verifier", async () => {
    const mockExecFn: ExecFn = async (cmd, args) => {
      if (cmd === "echo") {
        return { stdout: "hello\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unknown", code: 1 };
    };

    const results = await executeLLMInstructions(
      [{ checkType: "command", target: "echo hello" }],
      process.cwd(),
      mockExecFn,
    );

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it("handles unknown checkType gracefully", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "",
      code: 0,
    });

    const results = await executeLLMInstructions(
      [{ checkType: "gitStatus" as any, target: "unknown" }],
      process.cwd(),
      mockExecFn,
    );

    expect(results).toHaveLength(1);
    // Should not crash
    expect(typeof results[0].passed).toBe("boolean");
  });
});

describe("judgeLLMResult", () => {
  it("returns LLM judgment when available", async () => {
    const mockLLM = createMockLLM([
      JSON.stringify({ passed: true, reasoning: "All checks passed" }),
    ]);

    const instructions: VerificationInstruction[] = [
      { checkType: "command", target: "echo ok" },
    ];
    const executionResults = [
      { instruction: instructions[0], passed: true, detail: "ok" },
    ];

    const judgment = await judgeLLMResult(
      instructions,
      executionResults,
      DEFAULT_VERIFY_JUDGE_PROMPT,
      mockLLM,
    );

    expect(judgment.passed).toBe(true);
    expect(judgment.reasoning).toBe("All checks passed");
  });

  it("falls back to all-passed when LLM judge fails", async () => {
    const mockLLM = async (): Promise<string> => { throw new Error("fail"); };

    const instructions: VerificationInstruction[] = [
      { checkType: "command", target: "echo ok" },
    ];
    const executionResults = [
      { instruction: instructions[0], passed: true, detail: "ok" },
    ];

    const judgment = await judgeLLMResult(instructions, executionResults, "prompt", mockLLM);
    expect(judgment.passed).toBe(true);
    expect(judgment.reasoning).toContain("LLM judge unavailable");
  });

  it("falls back to not-passed when some fail and LLM is unavailable", async () => {
    const mockLLM = async (): Promise<string> => { throw new Error("fail"); };

    const instructions: VerificationInstruction[] = [
      { checkType: "fileExists", target: "missing.md" },
    ];
    const executionResults = [
      { instruction: instructions[0], passed: false, detail: "missing" },
    ];

    const judgment = await judgeLLMResult(instructions, executionResults, "prompt", mockLLM);
    expect(judgment.passed).toBe(false);
  });
});

describe("runLLMVerification", () => {
  it("runs full pipeline: parse → execute → judge", async () => {
    const mockLLM = createMockLLM([
      // Parse response
      JSON.stringify([{ checkType: "command", target: "echo pass" }]),
      // Judge response
      JSON.stringify({ passed: true, reasoning: "Command succeeded" }),
    ]);

    const result = await runLLMVerification(
      "Check that echo pass succeeds",
      process.cwd(),
      mockLLM,
      DEFAULT_VERIFY_PARSE_PROMPT,
      DEFAULT_VERIFY_JUDGE_PROMPT,
    );

    expect(result.passed).toBe(true);
    expect(result.instructions).toHaveLength(1);
    expect(result.reasoning).toBe("Command succeeded");
  });

  it("returns passed: false (fail-closed) when no instructions can be parsed", async () => {
    const mockLLM = createMockLLM(["not valid json"]);

    const result = await runLLMVerification(
      "vague description",
      process.cwd(),
      mockLLM,
      "parse",
      "judge",
    );

    expect(result.passed).toBe(false);
    expect(result.instructions).toHaveLength(0);
    expect(result.reasoning).toContain("LLM parsing failed");
  });

  it("returns null when callLLM throws (LLM unavailable — caller skips LLM layer)", async () => {
    const mockLLM = async (): Promise<string> => { throw new Error("LLM not available (pi SDK stub)"); };

    const result = await runLLMVerification(
      "some verify body",
      process.cwd(),
      mockLLM,
      "parse",
      "judge",
    );

    // callLLM throws → parseVerifyIntent returns null → runLLMVerification returns null
    // This signals to the caller (auto-verifier) to skip the LLM layer entirely
    expect(result).toBeNull();
  });
});
