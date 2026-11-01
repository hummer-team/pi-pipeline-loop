/**
 * @module auto-pipeline/clarify-prompt-markers
 * 221 Phase 1 (INV-4): the clarify marker PRIMARIES shown to the agent.
 *
 * Facts:
 * - One resolver for every prompt channel (executor segment, deliverables,
 *   clarify instructions, verify generation) so no two surfaces can ask for
 *   different markers.
 * - Precedence for the completion marker mirrors the frozen protocol:
 *   job JSON `modelConfirm` → stage `completionMarker` → code defaults.
 * - This module is PROMPT-ONLY: it never enables the `agent_settled` precheck
 *   (that switch is `completionMarker` alone, see `mergeCompletionMarkers`).
 * - Kept out of `clarify-anchors.ts` to respect the module line budget and to
 *   stay a dependency-leaf usable by `core/prompt-injector` and
 *   `core/verify-generator`.
 */

import type { PipelineConfig } from "../../types";
import { DEFAULT_COMPLETION_MARKERS } from "../../constants";
import { DEFAULT_CLARIFY_PROTOCOL, primaryMarker } from "./clarify-anchors";

/** Marker primaries used by the clarify PROMPTS (never by the precheck switch). */
export interface ClarifyPromptMarkers {
  /** Answer-field literal the agent is asked to write (`答：` by default). */
  answerMarker: string;
  /** Completion-marker heading the finalisation round asks for. */
  completionMarker: string;
}

/** Bilingual code defaults (used when a caller has no resolved config). */
export const DEFAULT_CLARIFY_PROMPT_MARKERS: ClarifyPromptMarkers = {
  answerMarker: DEFAULT_CLARIFY_PROTOCOL.answerMarkers[0]!,
  completionMarker: DEFAULT_COMPLETION_MARKERS[0]!,
};

/** Resolve the marker primaries shown to the agent for this project. */
export function resolveClarifyPromptMarkers(config: PipelineConfig): ClarifyPromptMarkers {
  const completionPrimary = primaryMarker(
    config.clarifyProtocol?.modelConfirm
      ?? config.stages.clarify?.verify?.completionMarker
      ?? DEFAULT_COMPLETION_MARKERS,
  );
  return {
    answerMarker:
      primaryMarker(
        config.clarifyProtocol?.answerMarkers ?? DEFAULT_CLARIFY_PROTOCOL.answerMarkers,
      ) || DEFAULT_CLARIFY_PROTOCOL.answerMarkers[0]!,
    completionMarker: completionPrimary || DEFAULT_COMPLETION_MARKERS[0]!,
  };
}

/**
 * Fill the `{completionMarker}` / `{answerMarker}` placeholders of a prompt or
 * deliverable template with the resolved primaries.
 *
 * A template installed BEFORE 221 has no placeholders and still spells the
 * default completion marker literally; rewrite that literal so an upgraded
 * install never asks the agent for a mark the verifier no longer accepts. The
 * alias list of the CURRENT template is left untouched (it contains the
 * placeholder, so the literal fallback is skipped).
 */
export function substituteClarifyMarkerPlaceholders(
  text: string,
  markers: ClarifyPromptMarkers,
): string {
  const rendered = text
    .replaceAll("{completionMarker}", markers.completionMarker)
    .replaceAll("{answerMarker}", markers.answerMarker);
  if (
    !text.includes("{completionMarker}") &&
    markers.completionMarker !== DEFAULT_COMPLETION_MARKERS[0]
  ) {
    return rendered.replaceAll(DEFAULT_COMPLETION_MARKERS[0], markers.completionMarker);
  }
  return rendered;
}
