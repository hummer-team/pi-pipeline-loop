/**
 * @module destructive-command
 * Detects destructive bash commands that should trigger user confirmation.
 * Uses a pattern blacklist + path-based heuristic for destructive file operations.
 */

import { extractBashFileTargets } from "./bash-parse";

/**
 * Destructive command patterns — commands that are inherently dangerous
 * and should always require user confirmation.
 * Each pattern matches a category of dangerous operations.
 */
export const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  // rm -rf on root or home directory
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+(\/\s*$|\/\s|~|\$HOME)/,
  /\brm\s+-rf\s+\/\b/,
  /\brm\s+-rf\s+~/,
  // sudo (privilege escalation)
  /\bsudo\b/,
  // Disk formatting
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  // System shutdown/reboot
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[0-6]\b/,
  // Dangerous permission changes on system directories
  /\bchmod\s+-R\s+.*\s+(\/|\/\.|\.git|\/etc|\/usr|\/var|\/bin|\/sbin|\/lib|\/boot|\/proc|\/sys|\/dev)(\s|$)/,
  /\bchown\s+-R\s+.*\s+(\/|\/\.|\.git|\/etc|\/usr|\/var|\/bin|\/sbin|\/lib|\/boot|\/proc|\/sys|\/dev)(\s|$)/,
  // Writing directly to devices
  />\s*\/dev\/sd/,
  />\s*\/dev\/hd/,
  // Fork bomb patterns
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/,
];

/**
 * Commands that are destructive when targeting paths outside the project.
 * Used in combination with path extraction for heuristic detection.
 */
const DESTRUCTIVE_FILE_COMMANDS = new Set(["rm", "mv", "chmod", "chown"]);

/**
 * System-level paths that indicate destructive intent when targeted
 * by file-modifying commands.
 */
const SYSTEM_PATH_PATTERNS: RegExp[] = [
  /^\/etc\//,
  /^\/usr\//,
  /^\/var\//,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/lib\//,
  /^\/boot\//,
  /^\/proc\//,
  /^\/sys\//,
  /^\/dev\//,
];

/**
 * Checks if a path looks like a system-level path (outside typical project scope).
 */
function isSystemPath(targetPath: string): boolean {
  // Absolute paths starting with system directories
  if (path.isAbsolute(targetPath)) {
    return SYSTEM_PATH_PATTERNS.some(p => p.test(targetPath));
  }
  // Paths that clearly escape project root
  if (targetPath.startsWith("../") || targetPath.startsWith("/")) {
    return true;
  }
  return false;
}

import * as path from "node:path";

/**
 * Checks if a bash command is potentially destructive.
 *
 * Two-tier detection:
 * 1. Pattern matching — checks against DESTRUCTIVE_COMMAND_PATTERNS
 * 2. Path heuristic — checks if destructive file commands target system paths
 *
 * @param command - The bash command to check
 * @returns true if the command appears destructive
 */
export function isDestructiveCommand(command: string): boolean {
  // Tier 1: Pattern matching
  for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return true;
    }
  }

  // Tier 2: Path-based heuristic for file-modifying commands
  const targets = extractBashFileTargets(command);
  if (targets.length > 0) {
    // Extract the base command (first token)
    const baseCommand = command.trim().split(/\s+/)[0];
    
    if (DESTRUCTIVE_FILE_COMMANDS.has(baseCommand)) {
      // Check if any target is a system-level path
      for (const target of targets) {
        if (isSystemPath(target.target)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Returns a human-readable description of why a command was flagged as destructive.
 * Used in violation messages and audit logs.
 *
 * @param command - The destructive command
 * @returns Description of the destructive pattern matched
 */
export function getDestructiveReason(command: string): string {
  // Check specific patterns for more precise messages
  if (/\bsudo\b/.test(command)) {
    return "Command uses sudo (privilege escalation)";
  }
  if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|(-[a-zA-Z]*f[a-zA-Z]*r))\s+(\/|~)/.test(command)) {
    return "Command recursively removes root or home directory";
  }
  if (/\bmkfs\b/.test(command) || /\bdd\s+.*\bof=\/dev\//.test(command)) {
    return "Command may format or overwrite disk partitions";
  }
  if (/\b(shutdown|reboot)\b/.test(command)) {
    return "Command shuts down or reboots the system";
  }
  
  // Generic message for path-based detection
  const targets = extractBashFileTargets(command);
  for (const target of targets) {
    if (isSystemPath(target.target)) {
      return `Command modifies system path: ${target.target}`;
    }
  }

  return "Command matches destructive pattern";
}
