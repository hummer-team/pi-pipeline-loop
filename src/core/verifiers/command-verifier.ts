/**
 * @module command-verifier
 * Verifies shell command execution results (exit code, stdout content).
 */

import { execSync } from "node:child_process";
import type { VerifierResult } from "./file-verifier";

/**
 * Verifies that required commands execute with expected exit codes and output.
 *
 * @param rules - Array of command rules with cmd, expectExit, expectOutput
 * @param projectRoot - Working directory for command execution
 * @returns Verification result with command failure details
 */
export function verifyRequiredCommands(
  rules: { cmd: string; expectExit?: number; expectOutput?: string }[] | undefined,
  projectRoot: string,
): VerifierResult {
  if (!rules || rules.length === 0) {
    return { passed: true, detail: "No required commands to check" };
  }

  const failures: string[] = [];

  for (const rule of rules) {
    const expectedExit = rule.expectExit ?? 0;
    let stdout = "";
    let actualExit = 0;

    try {
      stdout = execSync(rule.cmd, {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      actualExit = 0;
    } catch (err: unknown) {
      // execSync throws on non-zero exit code
      const execErr = err as { status?: number; stderr?: string };
      actualExit = execErr.status ?? 1;
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
