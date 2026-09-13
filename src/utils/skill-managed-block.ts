/**
 * @module skill-managed-block
 * Phase 5 / 175: Managed block rendering and idempotent merging for SKILL.md files.
 *
 * The plugin injects a machine-readable contract block into SKILL.md files during
 * /pipeline-init. This block is delimited by HTML comment markers and contains
 * the stage_deliverable_* MUST text from the yml config.
 *
 * Key behaviors:
 * - Block markers: `<!-- BEGIN pi-pipeline:managed-contract -->` / `<!-- END pi-pipeline:managed-contract -->`
 * - Idempotent: if block exists, replace in-place; if markers lost, append at end
 * - User content outside the block is preserved verbatim
 * - CRLF and missing trailing newline are handled gracefully
 */

/** Block delimiter markers */
export const MANAGED_BLOCK_BEGIN = "<!-- BEGIN pi-pipeline:managed-contract -->";
export const MANAGED_BLOCK_END = "<!-- END pi-pipeline:managed-contract -->";

/**
 * Renders the managed contract block for a given stage.
 *
 * @param stage - The pipeline stage name
 * @param deliverableText - The deliverable MUST text from yml stage_deliverable_{stage}
 * @returns The full block content including markers
 */
export function renderContractBlock(stage: string, deliverableText: string): string {
  const header = `# Plugin-Managed Contract (${stage})`;
  const note = `> This section is auto-managed by pi-pipeline plugin. Do not edit manually.`;
  const content = deliverableText.trim();

  return [
    MANAGED_BLOCK_BEGIN,
    "",
    header,
    "",
    note,
    "",
    content,
    "",
    MANAGED_BLOCK_END,
  ].join("\n");
}

/**
 * Merges the managed contract block into existing file content.
 *
 * - If block markers exist: replace the block in-place (preserves user content outside)
 * - If markers are lost: append block at end (idempotent — does not duplicate)
 * - CRLF line endings are normalized to LF before processing
 * - Missing trailing newline is handled gracefully
 *
 * @param fileContent - The existing SKILL.md content
 * @param block - The rendered contract block (from renderContractBlock)
 * @returns The merged content with the managed block updated/appended
 */
export function mergeManagedBlock(fileContent: string, block: string): string {
  // Normalize CRLF to LF for consistent processing
  const normalized = fileContent.replace(/\r\n/g, "\n");

  // Check if block markers exist
  const beginIdx = normalized.indexOf(MANAGED_BLOCK_BEGIN);
  const endIdx = normalized.indexOf(MANAGED_BLOCK_END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Block exists — replace in-place
    const endOfEndMarker = endIdx + MANAGED_BLOCK_END.length;
    const before = normalized.substring(0, beginIdx);
    const after = normalized.substring(endOfEndMarker);
    return before + block + after;
  }

  // Block markers not found — check if content already has the block text (idempotent)
  if (normalized.includes(MANAGED_BLOCK_BEGIN)) {
    // Partial marker found but no matching end — append at end (best effort)
    const separator = normalized.endsWith("\n") ? "" : "\n";
    return normalized + separator + "\n" + block + "\n";
  }

  // No block at all — append at end
  const separator = normalized.endsWith("\n") ? "" : "\n";
  return normalized + separator + "\n" + block + "\n";
}
