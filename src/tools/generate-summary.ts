/**
 * @module generate-summary
 * Factory for the `generate_stage_summary` tool.
 * Generates a structured markdown summary artifact for the current
 * pipeline stage, with YAML frontmatter and content hash.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { PipelineConfig, Tool, SessionMeta, SummaryMeta } from "../types";

/**
 * Creates the `generate_stage_summary` tool.
 *
 * Called once at the end of each stage to produce a summary artifact.
 * The artifact contains:
 * - JSON frontmatter (stage, pipelineId, domain, validation_status, hash)
 * - Markdown body (core content, constraints, pending items, reference files)
 *
 * The summary is written to `.pi/audit/{pipelineId}/{stage}.md` and
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
      "that must be validated before pipeline handoff.",
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
      },
      required: ["coreContent", "constraints", "pendingItems", "referenceFiles"],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMetadata() as SessionMeta;
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";
      const stage = meta.currentStage;

      // Build frontmatter (machine-readable)
      const frontmatter: Record<string, unknown> = {
        stage,
        pipeline_id: meta.pipelineId,
        generated_at: new Date().toISOString(),
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

      const body =
        `# ${stage.toUpperCase()} Stage Summary\n\n` +
        `## Core Content\n${coreContent}\n\n` +
        `## Constraints\n${constraints.map((c) => `- ${c}`).join("\n")}\n\n` +
        `## Pending Items\n${pendingItems.map((p) => `- ${p}`).join("\n")}\n\n` +
        `## Reference Files\n${referenceFiles.map((f) => `- ${f}`).join("\n")}\n`;

      // Generate file content and compute hash
      const summaryDir = path.join(projectRoot, auditDir, meta.pipelineId);
      await fs.mkdir(summaryDir, { recursive: true });
      const summaryPath = path.join(summaryDir, `${stage}.md`);

      // Placeholder approach: hash covers the full structure including the hash field length
      const HASH_PLACEHOLDER = "__PLACEHOLDER_HASH__";
      frontmatter.hash = HASH_PLACEHOLDER;
      const contentWithPlaceholder = `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
      const hash = crypto.createHash("sha256").update(contentWithPlaceholder).digest("hex");
      const finalContent = contentWithPlaceholder.replace(HASH_PLACEHOLDER, hash);
      frontmatter.hash = hash;
      await fs.writeFile(summaryPath, finalContent);

      // Update session metadata with summary reference
      const summaryMeta: SummaryMeta = {
        path: summaryPath,
        hash: frontmatter.hash as string,
        status: "pending",
      };

      ctx.session.updateMetadata({
        ...meta,
        summaries: {
          ...meta.summaries,
          [stage]: summaryMeta,
        },
      });

      return {
        success: true,
        summaryPath,
        hash: summaryMeta.hash,
        message: "Summary saved. Human validation required before handoff.",
      };
    },
  };
}
