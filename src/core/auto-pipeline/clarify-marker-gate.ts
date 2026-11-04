import type { PipelineConfig, SessionMeta } from "../../types";
import { DEFAULT_CLARIFY_PROTOCOL, normalizeMarkers } from "./clarify-anchors";
import { precheckCompletionMarker } from "../auto-verifier";

/** 223: acceptance set for the clarify completion gate — EMPTY means "no gate". */
export function resolveClarifyGateMarkers(config: PipelineConfig): string[] {
  const configured = normalizeMarkers(config.stages.clarify?.verify?.completionMarker);
  if (configured.length === 0) {
    return [];
  }
  return normalizeMarkers([
    ...normalizeMarkers(config.clarifyProtocol?.modelConfirm),
    ...configured,
    ...DEFAULT_CLARIFY_PROTOCOL.modelConfirm,
  ]);
}

/** TRUE when the requirement document carries an accepted confirmation marker. */
export async function passesClarifyMarkerGate(
  config: PipelineConfig,
  meta: Pick<SessionMeta, "requirementDoc">,
  projectRoot: string,
): Promise<boolean> {
  const markers = resolveClarifyGateMarkers(config);
  if (markers.length === 0) {
    return true;
  }
  return precheckCompletionMarker(meta, markers, projectRoot);
}
