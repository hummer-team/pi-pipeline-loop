/**
 * @module doc-flow-index
 * Pure-function scanner for existing non-terminal pipeline flows in the audit directory.
 *
 * Phase 3 (171) Q4-A: enables /pipeline-start to adopt (resume) an existing aborted
 * pipeline that shares the same requirementDoc, avoiding duplicate pipeline creation
 * when the main session meta has no bound requirementDoc (e.g. JOIN bind miss).
 *
 * Fail-open: any read/parse failure for a single pipe-* directory is silently skipped.
 * The function never throws and never blocks the caller.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SessionMeta, PipelineStage } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";

/** A candidate flow discovered by scanning the audit directory. */
export interface FlowCandidate {
  pipelineId: string;
  stage: PipelineStage;
  flowState: string;
  stageStartTime: number;
  requirementDoc: string | undefined;
}

/** Terminal flow states that should NOT be adopted (pipeline is done or waiting). */
const TERMINAL_FLOW_STATES = new Set(["completed", "awaiting_human"]);

/**
 * Scans the audit directory for pipeline flows matching the given requirementDoc
 * that are not in a terminal state (completed / awaiting_human).
 *
 * Resolution:
 * 1. Enumerate `{auditDir}/pipe-*` directories
 * 2. Read each `meta.json` (fail-open per directory)
 * 3. Filter: requirementDoc matches AND flowState is not terminal
 * 4. Sort: stageStartTime descending (newest first)
 *
 * @param projectRoot - Absolute path to the project root
 * @param auditDir - Audit directory (relative to projectRoot, e.g. ".pi/audit")
 * @param docRelPath - Requirement doc path to match (e.g. "docs/design/82_Feat.md")
 * @returns Array of FlowCandidate sorted by stageStartTime descending
 */
export async function scanAuditFlows(
  projectRoot: string,
  auditDir: string,
  docRelPath: string,
): Promise<FlowCandidate[]> {
  if (!docRelPath) return [];

  const absAuditDir = path.resolve(projectRoot, auditDir);
  let entries: string[];
  try {
    entries = await fs.readdir(absAuditDir);
  } catch {
    // Audit dir does not exist or is unreadable → no candidates
    return [];
  }

  const candidates: FlowCandidate[] = [];

  for (const entry of entries) {
    if (!entry.startsWith("pipe-")) continue;

    const metaPath = path.join(absAuditDir, entry, "meta.json");
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw) as SessionMeta;

      // Filter: same doc + non-terminal
      if (meta.requirementDoc !== docRelPath) continue;
      const flowState = meta.flowState ?? (meta.terminated ? "blocked" : "running");
      if (TERMINAL_FLOW_STATES.has(flowState) || meta.currentStage === "completed" || meta.currentStage === "awaiting_human") continue;

      candidates.push({
        pipelineId: meta.pipelineId ?? entry,
        stage: meta.currentStage,
        flowState,
        stageStartTime: meta.stageStartTime ?? 0,
        requirementDoc: meta.requirementDoc,
      });
    } catch (err) {
      // Fail-open: log warn but continue scanning
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("scan_audit_flows_read_error", {
        pipelineDir: entry,
        error: errMsg,
      }, "warn");
    }
  }

  // Sort by stageStartTime descending (newest first)
  candidates.sort((a, b) => b.stageStartTime - a.stageStartTime);
  return candidates;
}
