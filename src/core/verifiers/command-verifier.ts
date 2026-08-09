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
 * @param rules - Array of command rules with cmd, expectExit, expectOutput
 * @param projectRoot - Working directory for command execution
 * @param execFn - Injected shell execution function
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

  const failures: string[] = [];

  for (const rule of rules) {
    const expectedExit = rule.expectExit ?? 0;
    let stdout = "";
    let actualExit = 0;

    try {
      if (execFn) {
        // Parse cmd string into command + args for execFn
        const parts = rule.cmd.split(/\s+/);
        const cmd = parts[0];
        const args = parts.slice(1);
        const result = await execFn(cmd, args, projectRoot);
        stdout = result.stdout;
        actualExit = result.code;
      } else {
        // Fallback: should not happen in production (execFn always injected via index.ts)
        // Kept for backward compatibility during migration
        const { execSync } = await import("node:child_process");
        stdout = execSync(rule.cmd, {
          cwd: projectRoot,
          encoding: "utf-8",
          timeout: 30_000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        actualExit = 0;
      }
    } catch (err: unknown) {
      // execFn or execSync throws on non-zero exit code
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
