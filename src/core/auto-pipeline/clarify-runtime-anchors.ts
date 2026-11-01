/**
 * @module auto-pipeline/clarify-runtime-anchors
 * 221 Phase 1/4 (INV-4): the ONE place that turns a project configuration into
 * the clarify anchor set used by BOTH chains.
 *
 * Facts:
 * - The AUTO chain (`clarify-state`), the HUMAN settle precheck
 *   (`auto-verifier.precheckClarifyAwaitAnswer`) and the human `/pipeline-start`
 *   derivation all need identical anchors. Duplicating the resolution is how a
 *   job JSON that only declares custom rounds/answers used to be ignored by the
 *   human chain (prompt asked for A, derivation parsed B).
 * - `forward` is the `VerifyContractAnchors` shape consumed by
 *   `deriveClarifyForwardArgs` / `decideClarifyDispatch`; it is built from the
 *   EFFECTIVE `ResolvedClarifyAnchors` (compatibility aliases included) so the
 *   parser and the injector can never disagree.
 * - Fail-open (INV-5): a missing/broken verify.md only warns; nothing throws.
 */

import type { PipelineConfig } from "../../types";
import type {
  VerifyContractAnchors,
  VerifyContractPatternSet,
} from "../../utils/contract-loader";
import { loadVerifyContractAnchors } from "../../utils/contract-loader";
import {
  DEFAULT_CLARIFY_PROTOCOL,
  resolveClarifyAnchors,
  type ResolvedClarifyAnchors,
} from "./clarify-anchors";
import { markerHeadingPattern } from "./clarify-anchor-patterns";

/** Resolved anchors plus the forward-arg view of the same set. */
export interface ClarifyRuntimeAnchors {
  anchors: ResolvedClarifyAnchors;
  /** Anchors loaded from the deployed verify.md (undefined when absent). */
  verify: VerifyContractAnchors | undefined;
  /** Non-fatal resolution issues (invalid patterns, unusable groups). */
  issues: string[];
  /** Effective anchors in the shape required by `deriveClarifyForwardArgs`. */
  forward: VerifyContractAnchors;
  /**
   * TRUE when the project declares clarify anchors (job JSON present or a
   * deployed verify.md `roundHeading`). Callers that used to fail-open on a
   * missing verify.md keep that behavior when this is FALSE; once the project
   * configures the protocol, the resolved (job → verify → default) set is
   * authoritative for BOTH chains.
   */
  anchorsConfigured: boolean;
}

/**
 * Build the effective round-heading set: the resolved (job → verify → default
 * + compatibility alias) patterns. The joined regex is compiled once because
 * consumers join the sources with `|`; a half-valid set would silently return
 * `fresh`.
 */
function buildRoundHeading(
  anchors: ResolvedClarifyAnchors,
  verify: VerifyContractAnchors | undefined,
): VerifyContractPatternSet {
  const roundSources = anchors.roundPatterns.map((pattern) => pattern.source);
  try {
    new RegExp(roundSources.join("|"), "gm");
    return { patterns: roundSources, mode: "or" };
  } catch (err) {
    console.warn(`[pi-pipeline] clarify round anchors unusable (${String(err)}); falling back to verify.md`);
    return verify?.roundHeading ?? { patterns: [...DEFAULT_CLARIFY_PROTOCOL.roundPatterns], mode: "or" };
  }
}

/** Literal completion markers compiled into heading-tolerant regex sources. */
function buildModelConfirm(anchors: ResolvedClarifyAnchors): VerifyContractPatternSet {
  return {
    patterns: anchors.modelConfirm.map((marker) => markerHeadingPattern(marker)),
    mode: "or",
  };
}

/**
 * Resolve the clarify anchors for a project (pure; the verify anchors are
 * supplied by the caller, e.g. `loadVerifyContractAnchors`).
 */
export function resolveClarifyRuntimeAnchors(input: {
  config: PipelineConfig;
  verify?: VerifyContractAnchors;
  issues?: string[];
}): ClarifyRuntimeAnchors {
  const { config, verify } = input;
  const anchors = resolveClarifyAnchors({
    ...(config.clarifyProtocol ? { job: config.clarifyProtocol } : {}),
    ...(verify ? { verify } : {}),
    ...(config.stages.clarify?.verify?.completionMarker !== undefined
      ? { completionMarker: config.stages.clarify.verify.completionMarker }
      : {}),
  });

  // 221 Phase 1 (INV-4): an anchor the JOB declares explicitly (or the stage
  // `completionMarker` that carries the job aliases) must win over the deployed
  // verify.md, otherwise the hints and the forward-arg derivation disagree in
  // a custom-primary project. Deployed verify.md stays authoritative when the
  // job declares nothing.
  const job = config.clarifyProtocol;
  const jobDeclaresAnswer =
    (job?.answerPatterns?.length ?? 0) > 0 || (job?.answerMarkers?.length ?? 0) > 0;
  const jobDeclaresConfirm =
    (job?.modelConfirm?.length ?? 0) > 0 || config.stages.clarify?.verify?.completionMarker !== undefined;

  const answerField: VerifyContractPatternSet = jobDeclaresAnswer
    ? { patterns: anchors.answerPatterns.map((pattern) => pattern.source), mode: "or" }
    : verify?.answerField ?? {
        patterns: anchors.answerPatterns.map((pattern) => pattern.source),
        mode: "or",
      };

  return {
    anchors,
    verify,
    issues: input.issues ?? [],
    forward: {
      ...(verify?.verdict ? { verdict: verify.verdict } : {}),
      roundHeading: buildRoundHeading(anchors, verify),
      answerField,
      modelConfirm: jobDeclaresConfirm ? buildModelConfirm(anchors) : verify?.modelConfirm ?? buildModelConfirm(anchors),
    },
    anchorsConfigured: job !== undefined || verify?.roundHeading !== undefined,
  };
}

/**
 * Load the deployed verify.md and resolve the clarify runtime anchors.
 * Never throws: an unreadable verify.md only removes that source.
 */
export async function loadClarifyRuntimeAnchors(
  config: PipelineConfig,
): Promise<ClarifyRuntimeAnchors> {
  const { anchors, issues } = await loadVerifyContractAnchors(config, "clarify");
  return resolveClarifyRuntimeAnchors({
    config,
    ...(anchors ? { verify: anchors } : {}),
    issues,
  });
}
