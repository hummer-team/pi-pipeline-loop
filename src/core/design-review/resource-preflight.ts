/**
 * @module design-review/resource-preflight
 * 194 Phase 2 (tasks 2–3): resolve the CLOSED-LOOP dispatch's read/write
 * resources to ABSOLUTE paths BEFORE any stage visit or RPC, and verify the
 * executor's REAL tool surface from its deployed agent definition.
 *
 * Defects removed:
 * - A review agent without bash could not find the report template and fell
 *   back to scanning the user's whole directory tree. Now the preflight pins
 *   the absolute template path, and the dispatch prompt lists the agent's
 *   actually-declared tools so the executor never reaches for `bash`.
 * - A missing asset used to surface as a failed dispatch (RPC sent, visit
 *   consumed, retry storm). `preflightDesignReviewDispatchResources` runs in
 *   the preparation phase shared by the first round, R2 and recovery: any
 *   missing resource blocks with ZERO RPCs and ZERO stage visits.
 * - Write/read-only collisions (e.g. the output document resolving onto a
 *   read-only input) are caught here instead of mid-run.
 *
 * All paths are built from plugin configuration only — never from a tool
 * argument, a model-supplied filename or a directory search.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DesignReviewOperationKind, PipelineConfig } from "../../types";
import { resolvePiWorkDir } from "../../utils/work-dir";

/** Deployed name of the design-review report template asset. */
export const DESIGN_REVIEW_REPORT_TEMPLATE_FILE = "design_review_report_template.md";

/** Stage each closed-loop operation kind dispatches into. */
const KIND_STAGE: Record<DesignReviewOperationKind, "design-review" | "plan" | "develop"> = {
  review: "design-review",
  update: "plan",
  "develop-handoff": "develop",
};

/** Capabilities every closed-loop executor must have in its declared tools. */
const REQUIRED_CAPABILITY = ["read", "write"] as const;

/** One blocking resource finding: what is unusable and why. */
export interface DesignReviewResourceIssue {
  /** Stable machine name ("agent", "skill", "template", "tools", "conflict"). */
  readonly resource: string;
  /** Path the resource resolves to ("" when the config itself is absent). */
  readonly path: string;
  /** Human/AUDIT-readable explanation. */
  readonly reason: string;
}

/** Successful preflight: every resource the dispatch may rely on. */
export interface DesignReviewResourcePreflightOk {
  readonly ok: true;
  /** Absolute deployed agent definition the executor runs from. */
  readonly agentDoc: string;
  /** Absolute deployed stage skill file. */
  readonly skillDoc: string;
  /** Absolute report template (review only; null for other kinds). */
  readonly templateDoc: string | null;
  /** Tools DECLARED in the agent frontmatter (empty = undeclared/SDK default). */
  readonly tools: readonly string[];
}

/** Preflight outcome: dispatchable with resources, or blocked with issues. */
export type DesignReviewResourcePreflight =
  | DesignReviewResourcePreflightOk
  | { ok: false; issues: readonly DesignReviewResourceIssue[] };

/**
 * Absolute path of the deployed design-review report template for this project,
 * or `null` when the asset is not present under `{projectRoot}/{piWorkDir}`.
 */
export async function resolveDesignReviewReportTemplate(
  config: PipelineConfig,
): Promise<string | null> {
  const absPath = await templatePath(config);
  return (await isFile(absPath)) ? absPath : null;
}

/** Config-derived absolute template path (existence not checked). */
async function templatePath(config: PipelineConfig): Promise<string> {
  return path.resolve(
    config.projectRoot,
    resolvePiWorkDir(config),
    "references",
    DESIGN_REVIEW_REPORT_TEMPLATE_FILE,
  );
}

/** True when `p` exists as a regular file. */
async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Extract the `tools:` list from a deployed agent definition's frontmatter.
 *
 * An undeclared/absent list yields `[]`: the SDK default tool surface is then
 * unknown to the plugin, which must NOT block on a guess — only an EXPLICIT
 * declaration missing a required capability is a mismatch.
 */
export function parseAgentDeclaredTools(content: string): string[] {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (frontmatter === null) {
    return [];
  }
  const line = frontmatter[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^tools\s*:/.test(l));
  if (line === undefined) {
    return [];
  }
  return line
    .slice(line.indexOf(":") + 1)
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Preflight every resource a closed-loop dispatch of `kind` needs.
 *
 * Checks (shared by first round, R2 and recovery — run BEFORE any visit or
 * send intent so a blocked dispatch consumes nothing):
 * 1. the target stage's agent definition is configured AND deployed;
 * 2. the stage skill file is deployed;
 * 3. review additionally requires the report template asset;
 * 4. the agent's declared tools provide read/write when it declares anything
 *    (task 3: no prompt may assume `bash` the executor does not have);
 * 5. the documents the dispatch WRITES do not resolve onto the documents it
 *    must treat as read-only inputs.
 */
export async function preflightDesignReviewDispatchResources(opts: {
  config: PipelineConfig;
  kind: DesignReviewOperationKind;
  /** Absolute plugin-derived documents this dispatch will write. */
  writeDocs: readonly string[];
  /** Absolute plugin-derived documents this dispatch must only read. */
  readOnlyDocs: readonly string[];
}): Promise<DesignReviewResourcePreflight> {
  const { config, kind } = opts;
  const stage = KIND_STAGE[kind];
  const issues: DesignReviewResourceIssue[] = [];

  const stageConfig = config.stages?.[stage];
  const agentRel = stageConfig?.agentPath;
  const skillRel = stageConfig?.skillPath;

  // 1. Agent definition.
  let agentAbs = "";
  if (typeof agentRel !== "string" || agentRel.length === 0) {
    issues.push({
      resource: "agent",
      path: "",
      reason: `stages["${stage}"].agentPath is not configured`,
    });
  } else {
    agentAbs = path.resolve(config.projectRoot, agentRel);
    if (!(await isFile(agentAbs))) {
      issues.push({
        resource: "agent",
        path: agentAbs,
        reason: "agent definition is not deployed (run /pipeline-init)",
      });
    }
  }

  // 2. Stage skill.
  let skillAbs = "";
  if (typeof skillRel !== "string" || skillRel.length === 0) {
    issues.push({
      resource: "skill",
      path: "",
      reason: `stages["${stage}"].skillPath is not configured`,
    });
  } else {
    skillAbs = path.resolve(config.projectRoot, resolvePiWorkDir(config), "skills", skillRel);
    if (!(await isFile(skillAbs))) {
      issues.push({ resource: "skill", path: skillAbs, reason: "stage skill file is not deployed" });
    }
  }

  // 3. Review reads the report template; other kinds do not.
  let templateAbs: string | null = null;
  if (kind === "review") {
    templateAbs = await templatePath(config);
    if (!(await isFile(templateAbs))) {
      issues.push({
        resource: "template",
        path: templateAbs,
        reason: "design-review report template is not deployed",
      });
      templateAbs = null;
    }
  }

  // 4. Declared tools vs required capabilities (only when declared).
  let declaredTools: string[] = [];
  if (agentAbs.length > 0) {
    try {
      declaredTools = parseAgentDeclaredTools(await fs.readFile(agentAbs, "utf8"));
    } catch {
      // Unreadable agent file already surfaced through the existence check;
      // keep tools undeclared rather than inventing a mismatch.
      declaredTools = [];
    }
    if (declaredTools.length > 0) {
      for (const capability of REQUIRED_CAPABILITY) {
        if (!declaredTools.includes(capability)) {
          issues.push({
            resource: "tools",
            path: agentAbs,
            reason: `agent declares tools [${declaredTools.join(", ")}] without required "${capability}"`,
          });
        }
      }
    }
  }

  // 5. Write targets must not land on read-only inputs.
  const readOnlyAbs = opts.readOnlyDocs.map((d) => path.resolve(config.projectRoot, d));
  for (const writeDoc of opts.writeDocs) {
    const writeAbs = path.resolve(config.projectRoot, writeDoc);
    const collide = readOnlyAbs.find((r) => r === writeAbs);
    if (collide !== undefined) {
      issues.push({
        resource: "conflict",
        path: writeAbs,
        reason: `dispatch writes ${writeAbs} but must treat the same path as read-only input`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    agentDoc: agentAbs,
    skillDoc: skillAbs,
    templateDoc: templateAbs,
    tools: declaredTools,
  };
}
