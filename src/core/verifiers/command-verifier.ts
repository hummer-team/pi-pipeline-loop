/**
 * @module command-verifier
 * Verifies shell command execution results (exit code, stdout content).
 */

import type { ExecFn } from "../../types";
import type { VerifierResult } from "./file-verifier";

/**
 * Verifies that required commands execute with expected exit codes and output.
 * Uses dependency-injected execFn to route commands through pi SDK sandbox.
 *
 * Fail-closed: when rules exist but execFn is not provided, verification
 * immediately fails with an error indicating pi.exec is unavailable.
 * This prevents silent bypass of the SDK sandbox via child_process fallback.
 *
 * @param rules - Array of command rules with cmd, expectExit, expectOutput
 * @param projectRoot - Working directory for command execution
 * @param execFn - Injected shell execution function (required when rules are present)
 * @returns Verification result with command failure details
 */
export async function verifyRequiredCommands(
  rules: { cmd: string; expectExit?: number; expectOutput?: string }[] | undefined,
  projectRoot: string,
  execFn?: ExecFn,
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
