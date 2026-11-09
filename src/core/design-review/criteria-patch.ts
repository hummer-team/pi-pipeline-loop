/**
 * @module design-review/criteria-patch
 * 229 Phase 7 (F7/阶段 3/task 3): the runtime LEGACY-CRITERIA patch for the
 * design-review reviewer — compatibility for UNMIGRATED projects.
 *
 * Facts:
 * - Sources = the reachable criterion texts: the stage agent file (when
 *   readable), the deployed `stage_deliverable_design-review` yml block and
 *   the dispatched task prompt. Any hit of the pre-229 verdict texts
 *   (`ANY valid entry` / `ISSUES TAKE PRECEDENCE` /
 *   `severity labels are informational` / `regardless of severity` /
 *   `issues take precedence`) appends the blocking-set patch AFTER the
 *   findings directive (fixed order, plan Phase 7 task 3).
 * - Fail-open on unreadable sources: they still receive the patch when any
 *   other source matches, and the inability is audited once
 *   (`prompt_legacy_criteria`, warn).
 * - Idepotence: the patch text itself never contains the legacy tokens (so
 *   a second pass over the composed prompt does not re-detect).
 */

import * as fs from "node:fs";
import type { PipelineConfig, SessionMeta } from "../../types";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { docsDirsOf } from "../../docs-paths";

/** Legacy verdict-criterion tokens the 229 verifier no longer enforces. */
const LEGACY_CRITERIA_TOKENS: readonly RegExp[] = [
  /ANY\s+valid\s+entry/i,
  /ISSUES\s+TAKE\s+PRECEDENCE/i,
  /severity\s+labels\s+are\s+informational/i,
  /regardless\s+of\s+severity/i,
  /issues\s+take\s+precedence/i,
];

/** The blocking-set patch (own text is token-free ⇒ idempotent). */
  /** The blocking-set patch (own text is token-free ⇒ idempotent). */
export const CRITERIA_PATCH_TEXT = `[auto-pipeline] 229 verdict-criteria correction (the assets above still describe the PRE-229 rule): the verdict is gated on the BLOCKING SET — the verdict is FAIL only when \`## Issues\` carries at least one BLOCKING issue (severity Blocker or High WITH Evidence); \`None\` or only Medium/Low entries means PASS. Every issue row requires a stable ID (\`DR-<round>-n\`) and a required severity; a Blocker/High without Evidence or a missing severity makes the report INVALID (never routed). Previous-round open ids must be restated in \`## Issue Ledger\` with a legal status or the report is invalid.`;

/** True when one of the legacy texts appears in the source. */
export function detectLegacyCriteria(content: string): boolean {
  return LEGACY_CRITERIA_TOKENS.some((re) => re.test(content));
}

/** One reachable criterion source (origin for audit honesty). */
export interface CriterionSource {
  origin: "agent-file" | "stage-yml" | "task-prompt";
  content: string | null;
}

/** The stage yml's design-review deliverable block (read-only, raw regex on
 *  the loaded yml value — PromptConfig is a flat string map). */
async function readStageYml(config: PipelineConfig): Promise<string | null> {
  try {
    const { loadPromptConfig } = await import("../prompt-config");
    const cfg = await loadPromptConfig(config.projectRoot);
    const block = Object.entries(cfg)
      .filter(([k]) => k.startsWith("stage_deliverable_design-review"))
      .map(([, v]) => v)
      .join("\n");
    return block !== "" ? block : null;
  } catch {
    return null;
  }
}

/** Unreadable-source audit is emitted ONCE per composed dispatch. */
async function auditUnreadable(reason: string): Promise<void> {
  await safeWriteAuditLog("prompt_legacy_criteria", { reason: `unreadable-source: ${reason}` }, "warn");
}

/**
 * Render the criteria patch for the CURRENT review dispatch. `null` when all
 * sources already teach the blocking set (migrated project ⇒ no extra bytes).
 */
export async function renderCriteriaPatch(input: {
  config: PipelineConfig;
  meta: SessionMeta;
  taskPrompt: string;
  sources?: readonly CriterionSource[];
}): Promise<string | null> {
  const { config } = input;
  let hits = detectLegacyCriteria(input.taskPrompt);
  const unreachable: string[] = [];

  const agentPathCandidate = config.stages["design-review"]?.agentPath;
  let agentContent: string | null = null;
  if (agentPathCandidate !== undefined) {
    const abs = agentPathCandidate.startsWith("/") ? agentPathCandidate : `${config.projectRoot}/${agentPathCandidate}`;
    try {
      agentContent = fs.readFileSync(abs, "utf-8");
      hits = hits || detectLegacyCriteria(agentContent);
    } catch {
      unreachable.push("agent-file");
    }
  }
  const yml = await readStageYml(config);
  if (yml === null) {
    unreachable.push("stage-yml");
  } else {
    hits = hits || detectLegacyCriteria(yml);
  }
  for (const reason of unreachable) {
    await auditUnreadable(reason);
  }
  if (!hits) return null;
  void input.meta;
  return CRITERIA_PATCH_TEXT;
}
