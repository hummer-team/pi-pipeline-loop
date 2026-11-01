/**
 * @module auto-pipeline/design-review-ledger-inject
 * 220 Phase 4 (D4): the auto-only ledger traceability guidance handed to the
 * design-review agent.
 *
 * Facts:
 * - The guidance is PROSE appended to the already composed dispatch prompt; no
 *   verify contract, no report format and no verdict rule changes (D4 red line).
 * - It is derived ONLY from an ACTIVE auto job: without one the dispatcher gets
 *   `null` and the prompt stays byte-identical to the pre-220 text (INV-1).
 * - Facts come from the same parsers the clarify side uses (`parseDecisionLedger`)
 *   and the reference count behind `buildLedgerTraceabilityDirective`
 *   (`countLedgerReferences`), so both stages agree on what "the ledger covers
 *   the plan" means.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
import { loadVerifyContractAnchors } from "../../utils/contract-loader";
import { readActiveJobContext } from "./config-overlay";
import { resolveClarifyAnchors } from "./clarify-anchors";
import { parseDecisionLedger } from "./clarify-protocol";
import { buildLedgerTraceabilityDirective } from "./design-review-ledger-check";

/** Read a project-relative text file; `null` when it cannot be read. */
async function readText(projectRoot: string, relPath: string): Promise<string | null> {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Build the ledger traceability checklist for one design-review dispatch.
 *
 * @returns the checklist text, or `null` when this process does not own a
 *   running auto job / the document has no decision ledger / the plan already
 *   references every label.
 */
export async function resolveAutoLedgerGuidance(input: {
  config: PipelineConfig;
  planDoc: string;
}): Promise<string | null> {
  const active = readActiveJobContext(input.config.projectRoot);
  if (!active || active.state.status !== "running") return null;
  const doc = active.state.docs[active.state.docIndex]?.doc;
  if (!doc) return null;
  const requirementText = await readText(input.config.projectRoot, doc);
  if (requirementText === null) return null;
  // 221 Phase 1: the ledger anchors come from the SAME resolution as clarify
  // (job JSON → verify.md → defaults), so both stages read one protocol.
  const { anchors: verifyAnchors } = await loadVerifyContractAnchors(input.config, "clarify");
  const anchors = resolveClarifyAnchors({
    ...(input.config.clarifyProtocol ? { job: input.config.clarifyProtocol } : {}),
    ...(verifyAnchors ? { verify: verifyAnchors } : {}),
    ...(input.config.stages.clarify?.verify?.completionMarker !== undefined
      ? { completionMarker: input.config.stages.clarify.verify.completionMarker }
      : {}),
  });
  const ledger = parseDecisionLedger(requirementText, anchors);
  if (!ledger.present) return null;
  const planText = (await readText(input.config.projectRoot, input.planDoc)) ?? "";
  return buildLedgerTraceabilityDirective({
    labels: ledger.labels,
    planText,
    tier: active.job.tier,
    ledger,
  });
}
