/**
 * @module group-verifier
 * Groups evaluation engine (Phase 1 / 176).
 *
 * Three-layer boolean evaluation:
 *   cross-group AND → group `ruleMode` (across rule nodes) → node `mode` (across patterns).
 *
 * Group-level conditionals (R2Q2A / R5Q1A):
 * - `when` not matching → the group always passes (empty-match pass-through).
 * - `when` matching with `scope: section` → split the document by round headings
 *   and evaluate the group independently in each section (per-section strict).
 * - Absent `scope` → whole-document evaluation.
 *
 * Failures carry the owning group name (`VerifyFailure.group`) for the wake loop.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExecFn, AuditLogFn } from "../../types";
import type { VerifyGroup, VerifyGroupRuleNode, VerifyRules } from "../verify-frontmatter";
import type { VerifyFailure } from "../auto-verifier";
import { verifyRequiredFiles, verifyFileContentPattern, globMatchFiles } from "./file-verifier";
import { verifyRequiredCommands } from "./command-verifier";
import { verifyRequiredGit } from "./git-verifier";
import { verifyModelRuntimeResult } from "./keyword-verifier";
import { splitRoundSections } from "../../utils/round-sections";

/** Tool-call / self-verify context forwarded to command nodes. */
export interface GroupEvalOptions {
  /** Dependency-injected shell execution function. */
  execFn?: ExecFn;
  /** Optional audit log callback for recording errors. */
  logError?: AuditLogFn;
  /** Tool call records for selfVerifySkip matching. */
  toolCallRecords?: Array<{ name: string; command?: string; exitCode?: number; success?: boolean; ts: number }>;
  /** Whether selfVerifySkip is enabled for this stage. */
  selfVerifySkip?: boolean;
  /** Stage start time for file-change invalidation. */
  stageStartTime?: number;
  /** Stage name for audit logging. */
  stageName?: string;
}

/** Result of groups evaluation. */
export interface GroupEvalResult {
  passed: boolean;
  failures: VerifyFailure[];
}

/**
 * Evaluates all groups in `rules`. Cross-group combination is always AND.
 *
 * @param rules - Resolved verification rules (placeholders + concrete globs applied)
 * @param projectRoot - Absolute project root
 * @param assistantMessages - Aggregated assistant messages for modelRuntimeResult
 * @param options - Execution/audit/self-verify context
 */
export async function evaluateGroups(
  rules: VerifyRules,
  projectRoot: string,
  assistantMessages: string[],
  options?: GroupEvalOptions,
): Promise<GroupEvalResult> {
  const groups = rules.groups ?? [];
  if (groups.length === 0) {
    return { passed: true, failures: [] };
  }

  const failures: VerifyFailure[] = [];
  for (const group of groups) {
    failures.push(...(await evaluateGroup(group, rules, projectRoot, assistantMessages, options)));
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Evaluates a single group, applying its `when` gate and `scope`.
 * Returns failures tagged with the group name.
 */
async function evaluateGroup(
  group: VerifyGroup,
  rules: VerifyRules,
  projectRoot: string,
  assistantMessages: string[],
  options?: GroupEvalOptions,
): Promise<VerifyFailure[]> {
  const groupPath = rules.path;
  const rawFailures: VerifyFailure[] = [];

  if (group.when) {
    const gate = await resolveGate(group, groupPath, projectRoot, options?.logError);
    // No gate match → the group always passes (empty-match pass-through).
    if (!gate.matched) return [];

    if (group.scope === "section") {
      const sections = splitRoundSections(gate.content, gate.re);
      if (sections.length === 0) return [];
      for (const section of sections) {
        const sectionFailures = await evaluateGroupRules(
          group, rules, projectRoot, assistantMessages, options, section.text,
        );
        for (const failure of sectionFailures) {
          rawFailures.push({ ...failure, detail: `round ${section.round}: ${failure.detail}` });
        }
      }
      return rawFailures.map((f) => ({ ...f, group: group.name }));
    }
  }

  rawFailures.push(
    ...(await evaluateGroupRules(group, rules, projectRoot, assistantMessages, options, undefined)),
  );
  return rawFailures.map((f) => ({ ...f, group: group.name }));
}

/**
 * Evaluates a group's rule nodes under `ruleMode`.
 * - "and" (default): evaluate all nodes, report every failure (no short-circuit).
 * - "or": any passing node passes the group; all failed → report all failures.
 */
async function evaluateGroupRules(
  group: VerifyGroup,
  rules: VerifyRules,
  projectRoot: string,
  assistantMessages: string[],
  options: GroupEvalOptions | undefined,
  sectionText: string | undefined,
): Promise<VerifyFailure[]> {
  const ruleMode = group.ruleMode ?? "and";
  const nodeResults: VerifyFailure[][] = [];

  for (const node of group.rules) {
    nodeResults.push(await evaluateNode(node, rules, projectRoot, assistantMessages, options, sectionText));
  }

  if (ruleMode === "or" && nodeResults.some((failures) => failures.length === 0)) {
    return [];
  }
  return nodeResults.flat();
}

/** Dispatches a single rule node to the matching verifier. */
async function evaluateNode(
  node: VerifyGroupRuleNode,
  rules: VerifyRules,
  projectRoot: string,
  assistantMessages: string[],
  options: GroupEvalOptions | undefined,
  sectionText: string | undefined,
): Promise<VerifyFailure[]> {
  const effectivePath = node.path ?? rules.path;

  switch (node.type) {
    case "requiredFile": {
      if (!effectivePath) return [];
      const result = await verifyRequiredFiles([effectivePath], projectRoot);
      return result.passed ? [] : [{ ruleType: "requiredFile", detail: result.detail }];
    }
    case "fileContentPattern": {
      if (!effectivePath) return [];
      return evaluateFileContentNode(node, effectivePath, projectRoot, options?.logError, sectionText);
    }
    case "requiredCommand": {
      if (!node.cmd) return [];
      const selfVerifyOpts = options?.selfVerifySkip === true
        ? {
            toolCallRecords: options.toolCallRecords,
            stageStartTime: options.stageStartTime,
            stageName: options.stageName,
          }
        : undefined;
      const result = await verifyRequiredCommands(
        [{ cmd: node.cmd, expectExit: node.expectExit, expectOutput: node.expectOutput }],
        projectRoot,
        options?.execFn,
        options?.logError,
        selfVerifyOpts,
      );
      return result.passed ? [] : [{ ruleType: "requiredCommand", detail: result.detail }];
    }
    case "requiredGit": {
      const result = await verifyRequiredGit(
        {
          lastCommitWithin: node.lastCommitWithin,
          branch: node.branch,
          cleanWorkingTree: node.cleanWorkingTree,
        },
        projectRoot,
        options?.execFn,
        options?.logError,
      );
      return result.passed ? [] : [{ ruleType: "requiredGit", detail: result.detail }];
    }
    case "modelRuntimeResult": {
      const result = verifyModelRuntimeResult(
        node.patterns,
        node.mode ?? "and",
        assistantMessages,
        options?.logError,
      );
      return result.passed ? [] : [{ ruleType: "modelRuntimeResult", detail: result.detail }];
    }
    default:
      return [];
  }
}

/**
 * Evaluates a fileContentPattern node against its patterns using node `mode`.
 * Each pattern is checked independently so OR semantics can be honored.
 */
async function evaluateFileContentNode(
  node: VerifyGroupRuleNode,
  effectivePath: string,
  projectRoot: string,
  logError: AuditLogFn | undefined,
  sectionText: string | undefined,
): Promise<VerifyFailure[]> {
  const patterns = node.patterns ?? [];
  if (patterns.length === 0) return [];

  const override = sectionText !== undefined ? { textOverride: sectionText } : undefined;
  const results = await Promise.all(
    patterns.map((pattern) =>
      verifyFileContentPattern([{ path: effectivePath, pattern }], projectRoot, logError, override),
    ),
  );

  if ((node.mode ?? "and") === "and") {
    return results
      .filter((result) => !result.passed)
      .map((result) => ({ ruleType: "fileContentPattern", detail: result.detail }));
  }
  // OR: any passing pattern passes the node; otherwise report all failures.
  if (results.some((result) => result.passed)) return [];
  return results.map((result) => ({ ruleType: "fileContentPattern", detail: result.detail }));
}

/**
 * Resolves the group `when` gate against the group's target document.
 * Returns `matched=false` on regex/read errors (fail-open).
 */
async function resolveGate(
  group: VerifyGroup,
  groupPath: string | undefined,
  projectRoot: string,
  logError: AuditLogFn | undefined,
): Promise<{ matched: boolean; content: string; re: RegExp }> {
  const fallback = { matched: false, content: "", re: /(?:)/ };

  let re: RegExp;
  try {
    re = new RegExp(group.when!, "m");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logError?.("verify_error", {
      ruleType: "verifyGroup",
      group: group.name,
      error: `invalid when pattern: ${errMsg}`,
    });
    return fallback;
  }

  if (!groupPath) return fallback;

  let content: string;
  try {
    content = await readGroupDoc(groupPath, projectRoot);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logError?.("verify_error", {
      ruleType: "verifyGroup",
      group: group.name,
      path: groupPath,
      error: `group document unreadable: ${errMsg}`,
    });
    return fallback;
  }

  return { matched: re.test(content), content, re };
}

/**
 * Reads the group's target document. Supports glob paths by selecting the
 * most recently modified match (mirrors fileContentPattern glob behavior).
 */
async function readGroupDoc(docPath: string, projectRoot: string): Promise<string> {
  if (docPath.includes("*") || docPath.includes("?")) {
    const matches = await globMatchFiles(docPath, projectRoot);
    if (matches.length === 0) {
      throw new Error(`no files matched glob "${docPath}"`);
    }
    let latestRel = matches[0];
    let latestMtime = -1;
    for (const rel of matches) {
      const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
      try {
        const stat = await fs.stat(abs);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestRel = rel;
        }
      } catch {
        // skip unreadable candidate
      }
    }
    const abs = path.isAbsolute(latestRel) ? latestRel : path.join(projectRoot, latestRel);
    return fs.readFile(abs, "utf-8");
  }

  const abs = path.isAbsolute(docPath) ? docPath : path.join(projectRoot, docPath);
  return fs.readFile(abs, "utf-8");
}
