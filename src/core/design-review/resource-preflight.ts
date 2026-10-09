/**
 * @module design-review/resource-preflight
 * 194 Phase 2 (task 2, first slice): resolve the CLOSED-LOOP review's read
 * resources to ABSOLUTE paths before dispatch, so the review executor can read
 * the exact file instead of scanning the user's directory tree.
 *
 * Scope of this slice: the design-review report template. The dispatch prompt
 * embeds the resolved absolute path (`read this ABSOLUTE path directly, no
 * directory search`), which is what lets a review agent WITHOUT bash still read
 * the template with plain `read`/`grep` tools (plan Phase 2 acceptance).
 *
 * A resource that is not deployed resolves to `null`: the prompt then simply
 * omits that line. Blocking dispatch on missing resources, checking the agent
 * and skill assets, and bounding the executor's search scope to projectRoot are
 * the remaining parts of task 2 (see the plan's Phase 2 acceptance) and are
 * tracked as open work rather than silently approximated here.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
import { resolvePiWorkDir } from "../../utils/work-dir";

/** Deployed name of the design-review report template asset. */
export const DESIGN_REVIEW_REPORT_TEMPLATE_FILE = "design_review_report_template.md";

/**
 * Absolute path of the deployed design-review report template for this project,
 * or `null` when the asset is not present under `{projectRoot}/{piWorkDir}`.
 *
 * The path is built from config only (never from a tool argument or a filename
 * search), so a dispatch can point the executor at one exact file.
 */
export async function resolveDesignReviewReportTemplate(
  config: PipelineConfig,
): Promise<string | null> {
  const absPath = path.resolve(
    config.projectRoot,
    resolvePiWorkDir(config),
    "references",
    DESIGN_REVIEW_REPORT_TEMPLATE_FILE,
  );
  try {
    const stat = await fs.stat(absPath);
    return stat.isFile() ? absPath : null;
  } catch {
    return null;
  }
}
