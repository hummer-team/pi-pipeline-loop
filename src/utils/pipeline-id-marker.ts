/**
 * @module pipeline-id-marker
 * 204_Bug Phase 0: pure helpers for the `Pipeline: {pipelineId}` prompt marker.
 *
 * Subagent sessions are often in-memory (`sessionFile === ""`, no
 * `parentSession` header). The spawn prompt marker is the L2 fallback evidence
 * source for JOIN identity resolution — so it must be parseable and
 * strictly validated before it is trusted as a path component.
 *
 * Zero I/O by design.
 */

/** Canonical pipelineId format (`pipe-{epochMillis}-{6 base36 chars}`). */
export const PIPELINE_ID_PATTERN = /^pipe-\d+-[a-z0-9]{6}$/;

const MARKER_REGEX = /Pipeline:\s*(pipe-[A-Za-z0-9-]+)/;

/**
 * Extracts the FIRST `Pipeline: {id}` marker from `text` and validates it
 * against {@link PIPELINE_ID_PATTERN}. Invalid candidates (path traversal,
 * legacy formats, look-alikes) yield `null` — never an exception.
 */
export function parsePipelineIdMarker(text: string): string | null {
  if (typeof text !== "string" || text === "") return null;
  const m = MARKER_REGEX.exec(text);
  if (!m) return null;
  const candidate = m[1];
  return PIPELINE_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Appends `Pipeline: {id}` to `prompt`.
 * Empty `pipelineId` → prompt unchanged (no trailing space); already present → unchanged.
 */
export function appendPipelineIdMarker(prompt: string, pipelineId?: string): string {
  if (!pipelineId) return prompt;
  if (prompt.includes(`Pipeline: ${pipelineId}`)) return prompt;
  return `${prompt} Pipeline: ${pipelineId}`;
}
