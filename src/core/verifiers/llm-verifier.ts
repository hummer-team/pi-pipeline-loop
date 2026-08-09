/**
 * @module llm-verifier
 * LLM-driven flexible verification layer.
 * Three-stage pipeline: parse (LLM → instructions) → execute (verifiers) → judge (LLM → result).
 */

import type { VerificationInstruction, LLMVerifyResult } from "../auto-verifier";
import type { ExecFn } from "../../types";
import { verifyRequiredFiles, verifyFileContentPattern } from "./file-verifier";
import { verifyRequiredCommands } from "./command-verifier";
import { verifyRequiredGit } from "./git-verifier";

/**
 * Configuration for the LLM verifier, abstracting the LLM call capability.
 */
export interface LLMVerifyConfig {
  /** Function to call the LLM with a prompt and get a text response */
  callLLM: (prompt: string) => Promise<string>;
}

/** Result of executing a single verification instruction */
interface InstructionExecutionResult {
  instruction: VerificationInstruction;
  passed: boolean;
  detail: string;
}

/**
 * Parses the Markdown body of verify.md using an LLM to extract structured
 * verification instructions.
 *
 * @param markdownBody - The Markdown body text from verify.md
 * @param systemPrompt - System prompt instructing the LLM on output format
 * @param callLLM - Function to invoke the LLM
 * @returns Array of VerificationInstruction parsed from the LLM response
 */
export async function parseVerifyIntent(
  markdownBody: string,
  systemPrompt: string,
  callLLM: (prompt: string) => Promise<string>,
): Promise<VerificationInstruction[] | null> {
  const userPrompt = `${systemPrompt}\n\n---\n\nVerify description to parse:\n\n${markdownBody}`;

  try {
    const response = await callLLM(userPrompt);
    return extractInstructionsFromJSON(response);
  } catch {
    // LLM call failed (unavailable) — return null to signal LLM layer should be skipped
    return null;
  }
}

/**
 * Extracts VerificationInstruction array from a JSON response string.
 * Handles both raw JSON arrays and JSON wrapped in markdown code blocks.
 */
function extractInstructionsFromJSON(response: string): VerificationInstruction[] {
  // Strip markdown code blocks if present
  let cleaned = response.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item: Record<string, unknown>) =>
          typeof item.checkType === "string" &&
          typeof item.target === "string" &&
          ["fileExists", "fileContent", "command", "gitStatus"].includes(item.checkType as string),
      ) as VerificationInstruction[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Executes an array of verification instructions by dispatching each
 * to the appropriate verifier based on checkType.
 *
 * @param instructions - Parsed verification instructions
 * @param projectRoot - Absolute path to the project root
 * @param execFn - Injected shell execution function
 * @returns Array of execution results with pass/fail and detail
 */
export async function executeLLMInstructions(
  instructions: VerificationInstruction[],
  projectRoot: string,
  execFn?: ExecFn,
): Promise<InstructionExecutionResult[]> {
  const results: InstructionExecutionResult[] = [];

  for (const instruction of instructions) {
    let passed = false;
    let detail = "";

    switch (instruction.checkType) {
      case "fileExists": {
        const result = await verifyRequiredFiles([instruction.target], projectRoot);
        passed = result.passed;
        detail = result.detail;
        break;
      }
      case "fileContent": {
        const result = await verifyFileContentPattern(
          [{ path: instruction.target, pattern: instruction.expected || ".*" }],
          projectRoot,
        );
        passed = result.passed;
        detail = result.detail;
        break;
      }
      case "command": {
        const result = await verifyRequiredCommands(
          [{ cmd: instruction.target, expectExit: 0 }],
          projectRoot,
          execFn,
        );
        passed = result.passed;
        detail = result.detail;
        break;
      }
      case "gitStatus": {
        // Map target to git check type
        const gitRules: { lastCommitWithin?: string; branch?: string; cleanWorkingTree?: boolean } = {};
        if (instruction.target === "cleanWorkingTree") {
          gitRules.cleanWorkingTree = true;
        } else if (instruction.target.startsWith("branch:")) {
          gitRules.branch = instruction.target.slice(7);
        } else {
          gitRules.lastCommitWithin = instruction.expected || "10min";
        }
        const result = await verifyRequiredGit(gitRules, projectRoot, execFn);
        passed = result.passed;
        detail = result.detail;
        break;
      }
      default:
        detail = `Unknown checkType: ${instruction.checkType}`;
    }

    results.push({ instruction, passed, detail });
  }

  return results;
}

/**
 * Sends execution results back to the LLM for an overall judgment.
 *
 * @param instructions - The instructions that were executed
 * @param executionResults - Results of each instruction execution
 * @param systemPrompt - System prompt for the judge LLM call
 * @param callLLM - Function to invoke the LLM
 * @returns LLMVerifyResult with passed/reasoning
 */
export async function judgeLLMResult(
  instructions: VerificationInstruction[],
  executionResults: InstructionExecutionResult[],
  systemPrompt: string,
  callLLM: (prompt: string) => Promise<string>,
): Promise<{ passed: boolean; reasoning: string }> {
  const resultsSummary = executionResults
    .map((r) => `- [${r.instruction.checkType}] ${r.instruction.target}: ${r.passed ? "PASS" : "FAIL"} — ${r.detail}`)
    .join("\n");

  const userPrompt = `${systemPrompt}\n\n---\n\nInstructions executed:\n${JSON.stringify(instructions, null, 2)}\n\n---\n\nExecution results:\n${resultsSummary}\n\n---\n\nPlease judge the overall verification result. Respond with JSON: {"passed": true/false, "reasoning": "..."}`;

  try {
    const response = await callLLM(userPrompt);
    let cleaned = response.trim();
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }
    const parsed = JSON.parse(cleaned);
    return {
      passed: !!parsed.passed,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
    };
  } catch {
    // Fallback: if LLM judge fails, pass only if all instructions passed
    const allPassed = executionResults.every(r => r.passed);
    return {
      passed: allPassed,
      reasoning: allPassed
        ? "All instructions passed (LLM judge unavailable)"
        : "LLM judge unavailable; some instructions failed",
    };
  }
}

/**
 * Main entry point for the LLM flexible verification pipeline.
 * Runs the three-stage pipeline: parse → execute → judge.
 *
 * @param markdownBody - The Markdown body from verify.md
 * @param projectRoot - Absolute path to the project root
 * @param callLLM - Function to invoke the LLM
 * @param parsePrompt - System prompt for the parse stage
 * @param judgePrompt - System prompt for the judge stage
 * @param execFn - Injected shell execution function
 * @returns LLMVerifyResult with overall pass/fail, reasoning, and instructions
 */
export async function runLLMVerification(
  markdownBody: string,
  projectRoot: string,
  callLLM: (prompt: string) => Promise<string>,
  parsePrompt: string,
  judgePrompt: string,
  execFn?: ExecFn,
): Promise<LLMVerifyResult | null> {
  // Stage 1: Parse — LLM extracts instructions from Markdown
  const instructions = await parseVerifyIntent(markdownBody, parsePrompt, callLLM);

  // LLM call threw → instructions is null → signal LLM unavailable
  // Caller should skip LLM layer and fall back to structured-only verification
  if (instructions === null) {
    return null;
  }

  if (instructions.length === 0) {
    return {
      passed: false,
      reasoning: "LLM parsing failed: could not extract verification instructions from Markdown body. The LLM may be unavailable or returned unparseable output.",
      instructions: [],
    };
  }

  // Stage 2: Execute — dispatch to verifiers
  const executionResults = await executeLLMInstructions(instructions, projectRoot, execFn);

  // Stage 3: Judge — LLM evaluates execution results
  const judgment = await judgeLLMResult(instructions, executionResults, judgePrompt, callLLM);

  return {
    passed: judgment.passed,
    reasoning: judgment.reasoning,
    instructions,
  };
}
