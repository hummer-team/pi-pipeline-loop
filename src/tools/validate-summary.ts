/**
 * @module validate-summary
 * Factory for the `validate_summary` tool.
 * Enables human validation of stage summary artifacts,
 * updating their status and writing audit log entries.
 */

import fs from "node:fs/promises";
import type { PipelineConfig, Tool, SessionMeta } from "../types";
import { writeAuditLog } from "../utils/auditLog";

/**
 * Creates the `validate_summary` tool.
 *
 * Called by a human reviewer to approve or reject a stage's summary artifact.
 * Updates the summary file's frontmatter with validation_status ("valid" or "invalid"),
 * validation_comment, and validated_at timestamp. Also updates SessionMeta and
 * writes a "summary_validated" audit log entry.
 *
 * A summary must be "valid" before `pipeline_handoff` will allow stage transition.
 *
 * @param config - The pipeline configuration
 * @returns A Tool object for the "validate_summary" tool
 */
export function createValidateSummary(config: PipelineConfig): Tool {
  return {
    name: "validate_summary",
    description:
      "Validate a stage summary (human gate). " +
      "Approve or reject the summary for the given stage. " +
      'Summary must be "valid" before pipeline handoff is allowed.',
    parameters: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          description: "The pipeline stage whose summary to validate",
        },
        isApproved: {
          type: "boolean",
          description: "Whether the summary is approved",
        },
        comment: {
          type: "string",
          description: "Optional validation comment",
        },
      },
      required: ["stage", "isApproved"],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMetadata() as SessionMeta;
      const stage = args.stage as string;
      const isApproved = args.isApproved as boolean;
      const comment = (args.comment as string) ?? "";

      const summary = meta.summaries[stage];
      if (!summary) {
        return {
          error: `No summary found for stage "${stage}". Generate one first.`,
        };
      }

      // Read and update the summary file's frontmatter
      const content = await fs.readFile(summary.path, "utf-8");
      const parts = content.split("---\n");

      if (parts.length >= 3) {
        const fm = JSON.parse(parts[1]);
        fm.validation_status = isApproved ? "valid" : "invalid";
        fm.validation_comment = comment;
        fm.validated_at = new Date().toISOString();

        const newContent =
          `---\n${JSON.stringify(fm, null, 2)}\n---\n` +
          parts.slice(2).join("---\n");
        await fs.writeFile(summary.path, newContent);
      }

      // Update session metadata
      ctx.session.updateMetadata({
        ...meta,
        summaries: {
          ...meta.summaries,
          [stage]: {
            ...summary,
            status: isApproved ? "valid" : "invalid",
          },
        },
      });

      // Write audit log
      await writeAuditLog("summary_validated", {
        pipelineId: meta.pipelineId,
        stage,
        approved: String(isApproved),
        comment,
      });

      return {
        success: true,
        message: `Summary for "${stage}" marked as ${isApproved ? "valid" : "invalid"}.`,
      };
    },
  };
}
