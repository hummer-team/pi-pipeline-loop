/**
 * @module auto-pipeline/clarify-prompt-markers
 * 221 Phase 1 (INV-4): the clarify marker PRIMARIES and ALIASES shown to the agent.
 *
 * Facts:
 * - One resolver for every prompt channel (executor segment, deliverables,
 *   clarify instructions, verify generation, `/pipeline-init` template
 *   substitution) so no two surfaces can ask for different markers.
 * - Precedence for the completion marker mirrors the frozen protocol:
 *   job JSON `modelConfirm` → stage `completionMarker` → code defaults.
 * - `completionAliases` is the set the `agent_settled` precheck ACTUALLY
 *   accepts (`mergeCompletionMarkers`: stage marker ∪ job aliases). The
 *   bilingual defaults are only listed when nothing is configured — otherwise
 *   the agent would be told a marker the precheck rejects is "accepted".
 * - This module is PROMPT-ONLY: it never enables the `agent_settled` precheck
 *   (that switch is `completionMarker` alone, see `mergeCompletionMarkers`).
 * - Kept out of `clarify-anchors.ts` to respect the module line budget and to
 *   stay a dependency-leaf usable by `core/prompt-injector`,
 *   `core/verify-generator` and `commands/pipeline-init`.
 */

import type { PipelineConfig } from "../../types";
import { DEFAULT_COMPLETION_MARKERS } from "../../constants";
import { DEFAULT_CLARIFY_PROTOCOL, normalizeMarkers } from "./clarify-anchors";

/** Marker primaries + accepted aliases used by the clarify PROMPTS. */
export interface ClarifyPromptMarkers {
  /** Answer-field literal the agent is asked to write (`答：` by default). */
  answerMarker: string;
  /** Every answer-field literal the parser accepts (primary first). */
  answerAliases: string[];
  /** Completion-marker heading the finalisation round asks for. */
  completionMarker: string;
  /** Every completion marker the precheck accepts (primary first). */
  completionAliases: string[];
}

/** Bilingual code defaults (used when a caller has no resolved config). */
export const DEFAULT_CLARIFY_PROMPT_MARKERS: ClarifyPromptMarkers = {
  answerMarker: DEFAULT_CLARIFY_PROTOCOL.answerMarkers[0]!,
  answerAliases: [...DEFAULT_CLARIFY_PROTOCOL.answerMarkers],
  completionMarker: DEFAULT_COMPLETION_MARKERS[0]!,
  completionAliases: [...DEFAULT_CLARIFY_PROTOCOL.modelConfirm],
};

/** Resolve the marker primaries/aliases shown to the agent for this project. */
export function resolveClarifyPromptMarkers(config: PipelineConfig): ClarifyPromptMarkers {
  // Completion side: the precheck acceptance set is the stage marker (the
  // switch) UNION the job aliases — exactly `mergeCompletionMarkers`.
  const configured = normalizeMarkers(config.stages.clarify?.verify?.completionMarker);
  const jobAliases = normalizeMarkers(config.clarifyProtocol?.modelConfirm);
  const completionMarker =
    jobAliases[0] ?? configured[0] ?? DEFAULT_COMPLETION_MARKERS[0]!;
  // Explicit acceptance set only; the bilingual defaults below are used when
  // NOTHING is configured (verify.md still accepts them by default).
  const acceptedCompletion = normalizeMarkers([...jobAliases, ...configured]);
  const completionAliases =
    acceptedCompletion.length > 0
      ? normalizeMarkers([completionMarker, ...acceptedCompletion])
      : [...DEFAULT_CLARIFY_PROTOCOL.modelConfirm];

  // Answer side: the job markers are the prompt source; the bilingual defaults
  // apply only when the job declares nothing.
  const configuredAnswer = normalizeMarkers(config.clarifyProtocol?.answerMarkers);
  const answerAliases =
    configuredAnswer.length > 0
      ? configuredAnswer
      : [...DEFAULT_CLARIFY_PROTOCOL.answerMarkers];

  return {
    answerMarker: answerAliases[0]!,
    answerAliases,
    completionMarker,
    completionAliases,
  };
}

/** Render an alias list as the copy-pasteable `\`a\` / \`b\`` prompt fragment. */
export function renderMarkerAliases(markers: readonly string[]): string {
  return markers.map((marker) => `\`${marker}\``).join(" / ");
}

/** Static alias lists shipped by the 221-era template (pre-placeholder). */
const LEGACY_COMPLETION_ALIAS_LIST =
  "(accepted aliases: `## 模型确认` / `## Model Confirmation`)";
const LEGACY_ANSWER_ALIAS_LIST = "(accepted aliases: `答：`/`答:`/`**答**`/`Answer:`)";

/**
 * Fill the `{completionMarker}` / `{completionAliases}` / `{answerMarker}` /
 * `{answerAliases}` placeholders of a prompt or deliverable template with the
 * resolved markers.
 *
 * A template installed BEFORE 221 has no placeholders and still spells the
 * default completion marker literally; rewrite that literal so an upgraded
 * install never asks the agent for a mark the verifier no longer accepts. A
 * 221-era template carries the placeholders but a STATIC alias list; that list
 * is rewritten too so a custom primary is never paired with default aliases.
 */
export function substituteClarifyMarkerPlaceholders(
  text: string,
  markers: ClarifyPromptMarkers,
): string {
  let rendered = text
    .replaceAll("{completionMarker}", markers.completionMarker)
    .replaceAll("{completionAliases}", renderMarkerAliases(markers.completionAliases))
    .replaceAll("{answerMarker}", markers.answerMarker)
    .replaceAll("{answerAliases}", renderMarkerAliases(markers.answerAliases));

  if (!text.includes("{completionAliases}")) {
    rendered = rendered.replaceAll(
      LEGACY_COMPLETION_ALIAS_LIST,
      `(accepted aliases: ${renderMarkerAliases(markers.completionAliases)})`,
    );
  }
  if (!text.includes("{answerAliases}")) {
    rendered = rendered.replaceAll(
      LEGACY_ANSWER_ALIAS_LIST,
      `(accepted aliases: ${renderMarkerAliases(markers.answerAliases)})`,
    );
  }
  if (
    !text.includes("{completionMarker}") &&
    markers.completionMarker !== DEFAULT_COMPLETION_MARKERS[0]
  ) {
    rendered = rendered.replaceAll(DEFAULT_COMPLETION_MARKERS[0], markers.completionMarker);
  }
  return rendered;
}
