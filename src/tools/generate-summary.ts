/**
 * @module generate-summary
 * Factory for the `generate_stage_summary` tool.
 * Generates a structured markdown summary artifact for the current
 * pipeline stage, with YAML frontmatter and content hash.
 *
 * Phase 2 (143) enhancements:
 * - Versioned naming: `{stage}.md` (first round) or `{stage}-{n}.md` (subsequent loops)
 * - Optional commit_ids: frontmatter `commit_ids` + body `## Commit IDs` section
 * - Token estimation via `estimateTokens` from pi-coding-agent SDK
 * - Audit log entry `summary_generated` on successful write
 * - SummaryMeta.version tracked in session metadata
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { PipelineConfig, Tool, SessionMeta, SummaryMeta } from "../types";
import { safeWriteStageAudit } from "../utils/auditLog";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

/**
 * Resolve the next versioned summary filename.
 *
 * If `{stage}.md` does not exist in the directory, returns `{stage}.md` with version 1.
 * Otherwise, scans for `{stage}-{n}.md` and returns `{stage}-{maxN+1}.md`.
 *
 * @param dir - Target directory
 * @param stage - Pipeline stage name
 * @returns Tuple of [filename, version]
 */
function resolveVersionedFilename(dir: string, stage: string): [string, number] {
  const basePath = path.join(dir, `${stage}.md`);
  if (!fsSync.existsSync(basePath)) {
    return [`${stage}.md`, 1];
  }

  // Scan for existing versioned files: {stage}-{n}.md
  let maxN = 1;
  try {
    const files = fsSync.readdirSync(dir);
    const versionedPattern = new RegExp(`^${stage}-(\\d+)\\.md$`);
    for (const f of files) {
      const match = f.match(versionedPattern);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxN) maxN = n;
      }
    }
  } catch {
    // If readdir fails, assume no versioned files exist beyond base
  }

  const nextN = maxN + 1;
  return [`${stage}-${nextN}.md`, nextN];
}

/**
 * Creates the `generate_stage_summary` tool.
 *
 * Called once at the end of each stage to produce a summary artifact.
 * The artifact contains:
 * - JSON frontmatter (stage, pipelineId, domain, validation_status, hash,
 *   estimated_tokens, optional commit_ids, optional version)
 * - Markdown body (core content, constraints, pending items, reference files,
 *   optional commit IDs section)
 *
 * The summary is written to `.pi/audit/{pipelineId}/{versioned-name}.md` and
 * registered in SessionMeta.summaries with status "pending" (awaiting
 * human validation before handoff).
 *
 * @param config - The pipeline configuration
 * @returns A Tool object for the "generate_stage_summary" tool
 */
export function createGenerateSummary(config: PipelineConfig): Tool {
  return {
    name: "generate_stage_summary",
    description:
      "Generate authoritative summary for current stage. " +
      "Call ONCE at stage end. Produces a markdown artifact with frontmatter " +
      "that must be validated before pipeline handoff. " +
      "In develop/fix stages, commitIds (list of git commit ids produced in this stage) " +
      "MUST be provided.",
    parameters: {
      type: "object",
      properties: {
        coreContent: {
          type: "string",
          description: "Core output content (concise summary)",
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Stage constraints and rules applied",
        },
        pendingItems: {
          type: "array",
          items: { type: "string" },
          description: "Items pending confirmation or resolution",
        },
        referenceFiles: {
          type: "array",
          items: { type: "string" },
          description: "Key files referenced during this stage",
        },
        commitIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Git commit ids produced during this stage (required for develop/fix stages). " +
            "List all commits created as part of this stage's work.",
        },
      },
      required: ["coreContent", "constraints", "pendingItems", "referenceFiles"],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMeta() as SessionMeta;
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";
      const stage = meta.currentStage;

      // Build frontmatter (machine-readable)
      const frontmatter: Record<string, unknown> = {
        stage,
        pipeline_id: meta.pipelineId,
        generated_at: new Date().toISOString(),
        generated_by_model: true,
        domain: `${meta.domain.id}@${meta.domain.version}`,
        parent_stage: meta.previousStage || null,
        child_stages: config.stages[stage].nextStage
          ? [config.stages[stage].nextStage]
          : [],
        validation_status: "pending",
        hash: "",
      };

      // Build body (human-readable)
      const coreContent = args.coreContent as string;
      const constraints = args.constraints as string[];
      const pendingItems = args.pendingItems as string[];
      const referenceFiles = args.referenceFiles as string[];
      const commitIds = (args.commitIds as string[]) || [];

      let body =
        `# ${stage.toUpperCase()} Stage Summary\n\n` +
        `## Core Content\n${coreContent}\n\n` +
        `## Constraints\n${constraints.map((c) => `- ${c}`).join("\n")}\n\n` +
        `## Pending Items\n${pendingItems.map((p) => `- ${p}`).join("\n")}\n\n` +
        `## Reference Files\n${referenceFiles.map((f) => `- ${f}`).join("\n")}\n`;

      // Conditionally include Commit IDs section (only when commitIds provided)
      // Keeping it absent when empty ensures hash stability across calls
      if (commitIds.length > 0) {
        body += `\n## Commit IDs\n${commitIds.map((id) => `- ${id}`).join("\n")}\n`;
        frontmatter.commit_ids = commitIds;
      }

      // Resolve versioned filename
      const summaryDir = path.join(projectRoot, auditDir, meta.pipelineId);
      await fs.mkdir(summaryDir, { recursive: true });
      const [versionedFilename, version] = resolveVersionedFilename(summaryDir, stage);
      const summaryPath = path.join(summaryDir, versionedFilename);

      // Record version in frontmatter
      if (version > 1) {
        frontmatter.version = version;
      }

      // Placeholder approach: hash covers the full structure including the hash field length
      const HASH_PLACEHOLDER = "__PLACEHOLDER_HASH__";
      frontmatter.hash = HASH_PLACEHOLDER;
      const contentWithPlaceholder = `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
      const hash = crypto.createHash("sha256").update(contentWithPlaceholder).digest("hex");
      const finalContent = contentWithPlaceholder.replace(HASH_PLACEHOLDER, hash);
      frontmatter.hash = hash;
      await fs.writeFile(summaryPath, finalContent);

      // Token estimation via pi-coding-agent SDK
      let estimatedTokens = 0;
      try {
        // estimateTokens accepts an AgentMessage-shaped object with role and content
        const messageForEstimate = { role: "user" as const, content: finalContent };
        estimatedTokens = estimateTokens(messageForEstimate as any);
      } catch {
        // Fail-open: estimation failure should not block summary generation
      }

      // Update frontmatter with estimated_tokens (re-write file)
      if (estimatedTokens > 0) {
        frontmatter.estimated_tokens = estimatedTokens;
        // Re-hash since frontmatter changed
        const contentWithPlaceholder2 = `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
        const hash2 = crypto.createHash("sha256").update(contentWithPlaceholder2).digest("hex");
        const finalContent2 = contentWithPlaceholder2.replace(HASH_PLACEHOLDER, hash2);
        frontmatter.hash = hash2;
        await fs.writeFile(summaryPath, finalContent2);
      }

      // Update session metadata with summary reference
      const summaryMeta: SummaryMeta = {
        path: summaryPath,
        hash: frontmatter.hash as string,
        status: "pending",
        version,
      };

      ctx.session.updateMeta({
        ...meta,
        summaries: {
          ...meta.summaries,
          [stage]: summaryMeta,
        },
      });

      // Write audit log entry for summary generation
      await safeWriteStageAudit(config, "summary_generated", meta, {
        stage,
        version: String(version),
        estimatedTokens: String(estimatedTokens),
        hash: summaryMeta.hash,
        summaryPath,
      });

      return {
        success: true,
        summaryPath,
        hash: summaryMeta.hash,
        version,
        estimatedTokens,
        message: "Summary saved. Human validation required before handoff.",
      };
    },
  };
}
