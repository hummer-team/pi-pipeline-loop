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
import { safeWriteAuditLog } from "../../utils/auditLog";

/** Shell operators not supported in requiredCommands (pipeline |, redirect >, &&/||, quotes, etc.) */
const SHELL_OPERATOR_PATTERN = /[|><&;`$()]/;

/** Checks whether a command string contains shell operators */
function hasShellOperator(cmd: string): boolean {
  return SHELL_OPERATOR_PATTERN.test(cmd);
}

/**
 * Normalizes a command string for comparison: lowercase, collapse whitespace,
 * strip leading "./" prefix. Used for selfVerifySkip matching.
 */
export function normalizeCmdForMatch(cmd: string): string {
  return cmd.toLowerCase().replace(/^\.\//, "").replace(/\s+/g, " ").trim();
}

/**
 * Tokenizes a normalized command into its token sequence.
 */
function tokenize(normalizedCmd: string): string[] {
  return normalizedCmd.split(" ").filter(Boolean);
}

/**
 * Options for selfVerifySkip matching.
 */
export interface SelfVerifySkipOptions {
  /** Tool call records from the current session */
  toolCallRecords?: Array<{ name: string; command?: string; exitCode?: number; success?: boolean; ts: number }>;
  /** Stage start time (ms) for file-change invalidation */
  stageStartTime?: number;
  /** Current stage name for audit logging (avoids hardcoding "verify") */
  stageName?: string;
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
 * selfVerifySkip: when options.toolCallRecords is provided, checks whether the
 * model has already successfully executed the same command via tool calls.
 * Matching uses normalized token prefix comparison (rule cmd tokens must be a
 * prefix of the executed command tokens). File changes (write/edit after the
 * matching tool call) invalidate the match. Skipped commands are audit-logged
 * as model_self_verified.
 *
 * @param rules - Array of command rules with cmd, expectExit, expectOutput
 * @param projectRoot - Working directory for command execution
 * @param execFn - Injected shell execution function (required when rules are present)
 * @param logError - Optional audit log callback for recording errors
 * @param selfVerifyOpts - Optional selfVerifySkip options (toolCallRecords + stageStartTime)
 * @returns Verification result with command failure details
 */
export async function verifyRequiredCommands(
  rules: { cmd: string; expectExit?: number; expectOutput?: string }[] | undefined,
  projectRoot: string,
  execFn?: ExecFn,
  logError?: AuditLogFn,
  selfVerifyOpts?: SelfVerifySkipOptions,
): Promise<VerifierResult> {
  if (!rules || rules.length === 0) {
    return { passed: true, detail: "No required commands to check" };
  }

  // Fail-closed: execFn is required to execute commands through pi SDK sandbox
  // (unless all commands are self-verified — checked per-rule below)
  const hasSelfVerify = !!selfVerifyOpts?.toolCallRecords && selfVerifyOpts.toolCallRecords.length > 0;
  if (!execFn && !hasSelfVerify) {
    return {
      passed: false,
      detail: "pi.exec unavailable: requiredCommands verification requires execFn (pi SDK sandbox)",
    };
  }

  const failures: string[] = [];
  const toolCallRecords = selfVerifyOpts?.toolCallRecords ?? [];
  const stageStartTime = selfVerifyOpts?.stageStartTime ?? 0;
  const stageName = selfVerifyOpts?.stageName ?? "verify";

  for (const rule of rules) {
    // Fail-fast: reject shell operators in cmd (not supported by split-based execution)
    if (hasShellOperator(rule.cmd)) {
      return {
        passed: false,
        detail: `"${rule.cmd}": shell operators are not supported in requiredCommands. Split into multiple rules or use a script file.`,
      };
    }

    // ── selfVerifySkip check ─────────────────────────────────────────────
    // If tool call records are available, check whether the model already
    // successfully executed this command during the current stage.
    const selfVerified = trySelfVerifySkip(rule.cmd, toolCallRecords, stageStartTime);
    if (selfVerified) {
      // Audit the skip — model_self_verified (no re-execution)
      await safeWriteAuditLog("model_self_verified", {
        stage: stageName,
        cmd: rule.cmd,
        method: "self_verified",
      });
      continue;
    }

    // No execFn and not self-verified → fail
    if (!execFn) {
      failures.push(`"${rule.cmd}": pi.exec unavailable and no self-verified match`);
      continue;
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

/**
 * Attempts to match a rule's command against the model's tool call records.
 * Returns true if:
 * - A bash tool call exists whose normalized command tokens have the rule's
 *   tokens as a prefix (model may have appended args)
 * - The tool call's exit code is 0 (success)
 * - No write/edit tool call occurred AFTER the matching bash call (file change invalidation)
 */
function trySelfVerifySkip(
  ruleCmd: string,
  records: Array<{ name: string; command?: string; exitCode?: number; success?: boolean; ts: number }>,
  stageStartTime: number,
): boolean {
  const ruleTokens = tokenize(normalizeCmdForMatch(ruleCmd));
  if (ruleTokens.length === 0) return false;

  // Filter to records within the current stage boundary (ts >= stageStartTime).
  // When stageStartTime is 0 (not set), no filtering is applied (backward compat).
  const stageRecords = stageStartTime > 0
    ? records.filter(r => r.ts >= stageStartTime)
    : records;

  // Find the latest matching bash call (reverse order for most-recent-first)
  let matchTs = -1;
  for (let i = stageRecords.length - 1; i >= 0; i--) {
    const rec = stageRecords[i];
    if (rec.name !== "bash" || !rec.command) continue;
    if (rec.exitCode !== undefined && rec.exitCode !== 0) continue;
    // If exitCode is undefined but no error, treat as success (conservative: require explicit 0)
    if (rec.exitCode === undefined) continue;

    const recTokens = tokenize(normalizeCmdForMatch(rec.command));
    // Rule tokens must be a prefix of the executed command tokens
    if (recTokens.length < ruleTokens.length) continue;
    let prefixMatch = true;
    for (let j = 0; j < ruleTokens.length; j++) {
      if (recTokens[j] !== ruleTokens[j]) {
        prefixMatch = false;
        break;
      }
    }
    if (prefixMatch) {
      matchTs = rec.ts;
      break;
    }
  }

  if (matchTs < 0) return false;

  // File-change invalidation: if any write/edit occurred after the match, invalidate
  for (const rec of stageRecords) {
    if (rec.ts <= matchTs) continue;
    if (rec.name === "write" || rec.name === "edit") {
      if (rec.success !== false) {
        // File changed after match → invalidate
        return false;
      }
    }
  }

  return true;
}
