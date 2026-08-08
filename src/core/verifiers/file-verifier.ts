/**
 * @module file-verifier
 * Verifies file existence and file content regex patterns.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Result of a single verification check */
export interface VerifierResult {
  passed: boolean;
  detail: string;
}

/**
 * Verifies that all required files exist relative to projectRoot.
 *
 * @param requiredFiles - Array of file paths (relative to projectRoot)
 * @param projectRoot - Absolute path to the project root directory
 * @returns Verification result with list of missing files on failure
 */
export async function verifyRequiredFiles(
  requiredFiles: string[] | undefined,
  projectRoot: string,
): Promise<VerifierResult> {
  if (!requiredFiles || requiredFiles.length === 0) {
    return { passed: true, detail: "No required files to check" };
  }

  const missing: string[] = [];

  for (const filePath of requiredFiles) {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(projectRoot, filePath);

    try {
      await fs.access(absolutePath);
    } catch {
      missing.push(filePath);
    }
  }

  if (missing.length > 0) {
    return {
      passed: false,
      detail: `Missing files: ${missing.join(", ")}`,
    };
  }

  return { passed: true, detail: `All ${requiredFiles.length} required files exist` };
}

/**
 * Verifies that file contents match specified regex patterns.
 *
 * @param rules - Array of { path, pattern } rules
 * @param projectRoot - Absolute path to the project root directory
 * @returns Verification result with pattern mismatch details on failure
 */
export async function verifyFileContentPattern(
  rules: { path: string; pattern: string }[] | undefined,
  projectRoot: string,
): Promise<VerifierResult> {
  if (!rules || rules.length === 0) {
    return { passed: true, detail: "No file content patterns to check" };
  }

  const failures: string[] = [];

  for (const rule of rules) {
    const absolutePath = path.isAbsolute(rule.path)
      ? rule.path
      : path.join(projectRoot, rule.path);

    try {
      const content = await fs.readFile(absolutePath, "utf-8");
      const regex = new RegExp(rule.pattern, "m");
      if (!regex.test(content)) {
        failures.push(`${rule.path}: pattern "${rule.pattern}" not found`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failures.push(`${rule.path}: file read error (${errMsg})`);
    }
  }

  if (failures.length > 0) {
    return {
      passed: false,
      detail: failures.join("; "),
    };
  }

  return { passed: true, detail: `All ${rules.length} content patterns matched` };
}
