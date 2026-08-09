/**
 * @module command-verifier
 * Verifies shell command execution results (exit code, stdout content).
 *
 * Limitations: requiredCommands only supports simple commands (command name +
 * space-separated arguments). Shell operators such as pipes (|), redirects (>/>>),
 * logical operators (&&/||), quotes, subshells, and environment variable expansion
 * are NOT supported. To verify complex shell pipelines, split them into multiple
 * rules or use a script file invoked as a single command.
 */

import type { ExecFn, AuditLogFn } from "../../types";
import type { VerifierResult } from "./file-verifier";

/** Shell operators not supported in requiredCommands (pipeline |, redirect >, &&/||, quotes, etc.) */
const SHELL_OPERATOR_PATTERN = /[|><&;`$()]/;

/** Checks whether a command string contains shell operators */
function hasShellOperator(cmd: string): boolean {
  return SHELL_OPERATOR_PATTERN.test(cmd);
}

/**
 * Verifies that required commands execute with expected exit codes and output.
 * Uses dependency-injected execFn to route commands through pi SDK sandbox.
 *
 * Fail-closed: when rules exist but execFn is not provided, verification
 * immediately fails with an error indicating pi.exec is unavailable.
 * This prevents silent bypass of the SDK sandbox via child_process fallback.
 *
 * Shell operator fail-fast: if a rule's cmd contains shell operators (|, >, <,
 * &&, ||, ;, `, $, (), etc.), verification immediately fails with a descriptive
 * error. requiredCommands only supports simple commands (name + space-separated args).
 *
 * @param rules - Array of command rules with cmd, expectExit, expectOutput
 * @param projectRoot - Working directory for command execution
 * @param execFn - Injected shell execution function (required when rules are present)
 * @param logError - Optional audit log callback for recording errors
 * @returns Verification result with command failure details
 */
export async function verifyRequiredCommands(
  rules: { cmd: string; expectExit?: number; expectOutput?: string }[] | undefined,
  projectRoot: string,
  execFn?: ExecFn,
  logError?: AuditLogFn,
): Promise<VerifierResult> {
  if (!rules || rules.length === 0) {
    return { passed: true, detail: "No required commands to check" };
  }

  // Fail-closed: execFn is required to execute commands through pi SDK sandbox
  if (!execFn) {
    return {
      passed: false,
      detail: "pi.exec unavailable: requiredCommands verification requires execFn (pi SDK sandbox)",
    };
  }

  const failures: string[] = [];

  for (const rule of rules) {
    // Fail-fast: reject shell operators in cmd (not supported by split-based execution)
    if (hasShellOperator(rule.cmd)) {
      return {
        passed: false,
        detail: `"${rule.cmd}": shell operators are not supported in requiredCommands. Split into multiple rules or use a script file.`,
      };
    }

    const expectedExit = rule.expectExit ?? 0;
    let stdout = "";
    let actualExit = 0;

    try {
      // Parse cmd string into command + args for execFn
      const parts = rule.cmd.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);
      const result = await execFn(cmd, args, projectRoot);
      stdout = result.stdout;
      actualExit = result.code;
    } catch (err: unknown) {
      // execFn throws on non-zero exit code
      const execErr = err as { status?: number; code?: number; stderr?: string };
      actualExit = execErr.code ?? execErr.status ?? 1;
      stdout = "";
      await logError?.("verify_error", { ruleType: "requiredCommands", cmd: rule.cmd, error: String(err) });
    }

    // Check exit code
    if (actualExit !== expectedExit) {
      failures.push(
        `"${rule.cmd}": expected exit code ${expectedExit}, got ${actualExit}`,
      );
      continue;
    }

    // Check output substring
    if (rule.expectOutput !== undefined && !stdout.includes(rule.expectOutput)) {
      failures.push(
        `"${rule.cmd}": expected output containing "${rule.expectOutput}" not found`,
      );
    }
  }

  if (failures.length > 0) {
    return {
      passed: false,
      detail: failures.join("; "),
    };
  }

  return { passed: true, detail: `All ${rules.length} required commands passed` };
}
