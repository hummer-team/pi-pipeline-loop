/**
 * @module git-env-classify
 * 203_Bug Phase 2 (RC3): Classifies working-tree dirtiness as "environmental"
 * when ALL changes live under pipeline-managed / git-ignored paths.
 *
 * Problem: `requiredGit.cleanWorkingTree` is structurally unsatisfiable for a
 * stage whose outputs are docs/ or .pi/ (pipeline-managed, often gitignored)
 * — the counter climbs until verify_attempt_overflow freezes the pipeline
 * although the developer did nothing wrong.
 *
 * Outcome: caller records a warn + guidance and does NOT count the failure
 * (see verify-advance isEnvironmentalOnly).
 *
 * Fail-closed: any git invocation failure → environmental:false, preserving
 * the original counting semantics for genuinely dirty trees.
 */

import type { ExecFn } from "../types";
import { DEFAULT_READONLY_WRITE_PATHS } from "../constants";

/** Result of the working-tree environmental classification. */
export interface EnvClassifyResult {
  /** true ONLY when all changes are managed/ignored and at least one exists */
  environmental: boolean;
  /** paths still dirtying the tree (empty when fully managed) */
  changedPaths: string[];
  /** owner-facing guidance text (populated when environmental) */
  guidance: string;
}

/** Default managed matchers: plan-readonly write paths + the .pi audit dir. */
export const DEFAULT_MANAGED_MATCHERS = [
  ...DEFAULT_READONLY_WRITE_PATHS,
  ".pi/",
];

/**
 * Classifies the working tree dirty state.
 *
 * @param projectRoot - Git working directory
 * @param execFn - Injected shell exec function (undefined → not environmental)
 * @param managedMatchers - Path prefixes considered pipeline-managed
 * @returns Classification result (never throws)
 */
export async function classifyWorkingTree(
  projectRoot: string,
  execFn: ExecFn | undefined,
  managedMatchers: string[] = DEFAULT_MANAGED_MATCHERS,
): Promise<EnvClassifyResult> {
  const notEnvironmental = (
    changedPaths: string[] = [],
  ): EnvClassifyResult => ({
    environmental: false,
    changedPaths,
    guidance: "",
  });

  // Fail-closed parity with verifyRequiredGit: no sandbox exec → original
  // counting semantics (cannot safely claim "environmental only").
  if (!execFn) return notEnvironmental();

  let statusOutput: string;
  try {
    const result = await execFn(
      "git",
      ["status", "--porcelain", "--ignored"],
      projectRoot,
    );
    statusOutput = result.stdout ?? "";
  } catch {
    // Fail-safe: git failure → original counting semantics
    return notEnvironmental();
  }

  const changedPaths = parsePorcelainPaths(statusOutput);
  if (changedPaths.length === 0) {
    // Nothing dirty at all — caller would not have failed; keep original path.
    return notEnvironmental();
  }

  const unmanaged: string[] = [];
  for (const path of changedPaths) {
    try {
      // git check-ignore -q <path>: exit 0 = ignored (managed).
      // Exit code 1 means NOT ignored (no rule matched) — that is a normal,
      // non-ignored path and must continue through prefix matching below.
      const ignore = await execFn("git", ["check-ignore", "-q", path], projectRoot);
      if (ignore.code === 0) continue;
    } catch {
      // Fail-closed: a throwing exec (including wrappers that surface a
      // NON-ZERO EXIT as a throw) must never be interpreted as "ignored".
      // Treating exit 1 (rule not matched) as managed would silently
      // downgrade a genuinely dirty working tree to environmental.
      return notEnvironmental(changedPaths);
    }
    const matchedByPrefix = managedMatchers.some((m) => path.startsWith(m));
    if (matchedByPrefix) continue;
    unmanaged.push(path);
  }

  if (unmanaged.length > 0) {
    return {
      environmental: false,
      changedPaths: unmanaged,
      guidance: "",
    };
  }

  return {
    environmental: true,
    changedPaths,
    guidance: buildGuidance(changedPaths),
  };
}

/**
 * Parses `git status --porcelain --ignored` output into path list.
 * Handles the rename form "XY old -> new" (uses the NEW path) and quoted paths.
 * Fail-safe: malformed lines are skipped (never throws).
 */
export function parsePorcelainPaths(statusOutput: string): string[] {
  if (!statusOutput) return [];
  const paths: string[] = [];
  for (const rawLine of statusOutput.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length < 4) continue;
    const body = line.slice(3); // XY + space
    if (!body) continue;
    // Rename form: "old -> new" → keep the NEW path
    const arrow = body.indexOf(" -> ");
    const path = arrow >= 0 ? body.slice(arrow + 4) : body;
    // Unquote C-quoted paths defensively (git quotes non-ASCII)
    const unquoted = path.startsWith('"') && path.endsWith('"')
      ? path.slice(1, -1)
      : path;
    if (unquoted) paths.push(unquoted);
  }
  return paths;
}

/** Builds the owner-facing guidance for environmental-only dirtiness. */
function buildGuidance(changedPaths: string[]): string {
  const sample = changedPaths.slice(0, 3).join(", ");
  const more = changedPaths.length > 3 ? ` (+${changedPaths.length - 3} more)` : "";
  return (
    `Working tree changes live only under pipeline-managed/ignored paths (${sample}${more}). ` +
    "A clean working tree is unattainable for this stage — do NOT re-commit pipeline-managed outputs. " +
    "See .pi/references/develop_spec/verify.md for stage output placement rules."
  );
}
