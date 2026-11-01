/**
 * 221 review round 2 (issue 3/4): the clarify runtime anchors are the SINGLE
 * source for the auto chain's dispatch derivation AND the human chain (settle
 * precheck / `pipeline-start` derivation).
 *
 * Sealed behaviors:
 * - a job that only declares `answers.markers` still parses the marker it asks
 *   the agent to write (prompt ↔ parser same source, INV-4);
 * - a configured completion marker is compiled with the same tolerance as the
 *   deployed verify.md heading rules (`##  模型确认` must match);
 * - job-declared round patterns drive the forward-arg round derivation;
 * - `anchorsConfigured` keeps the legacy fail-open for projects with NO
 *   clarify configuration at all.
 */

import { describe, it, expect } from "bun:test";
import { makeTestConfig } from "../helpers";
import { deriveClarifyForwardArgs } from "../../utils/clarify-args";
import {
  resolveClarifyRuntimeAnchors,
  type ClarifyRuntimeAnchors,
} from "../../core/auto-pipeline/clarify-runtime-anchors";
import type { VerifyContractAnchors } from "../../utils/contract-loader";

function withCompletionMarker(
  config = makeTestConfig(),
  completionMarker: string | string[] = ["## Custom Confirm"],
) {
  config.stages.clarify = {
    ...config.stages.clarify!,
    verify: { require: true, verifyFile: "verify.md", completionMarker },
  };
  return config;
}

describe("clarify runtime anchors: answers", () => {
  it("accepts a job marker the prompt asks for even when verify.md declares other patterns", () => {
    const config = makeTestConfig({
      clarifyProtocol: { answerMarkers: ["Confirm:"] },
    });
    const verify: VerifyContractAnchors = {
      answerField: { patterns: ["^\\s*Answer\\s*:"], mode: "or" },
    };
    const runtime: ClarifyRuntimeAnchors = resolveClarifyRuntimeAnchors({ config, verify });

    // Prompt asks for `Confirm:` — the parser MUST accept it (INV-4).
    expect(runtime.anchors.answerPrimary).toBe("Confirm:");
    expect(runtime.forward.answerField!.patterns[0]).toBe("^\\s*Confirm:");
    expect(runtime.forward.answerField!.patterns).toContain("^\\s*Answer\\s*:");

    const result = deriveClarifyForwardArgs(
      "# 第 1 轮澄清\n问题：xxx\nConfirm: yes\n",
      runtime.forward,
    );
    expect(result.kind).toBe("full-und?");
  });
});

describe("clarify runtime anchors: confirmation tolerance", () => {
  it("matches the same heading variants as the deployed verify.md rules", () => {
    const config = withCompletionMarker();
    // No verify.modelConfirm: the configured marker is the literal source.
    // The old `^\s*## Custom Confirm` required EXACTLY one space.
    const runtime = resolveClarifyRuntimeAnchors({ config });

    expect(
      deriveClarifyForwardArgs("# 第 1 轮澄清\n问题\n答：yes\n##   Custom Confirm\n", runtime.forward)
        .kind,
    ).toBe("confirmed");
    expect(
      deriveClarifyForwardArgs("# 第 1 轮澄清\n问题\n答：yes\n### Custom   Confirm\n", runtime.forward)
        .kind,
    ).toBe("confirmed");
  });
});

describe("clarify runtime anchors: rounds", () => {
  it("uses job-declared round patterns for the forward derivation", () => {
    const config = makeTestConfig({
      clarifyProtocol: { roundPatterns: ["^#{1,2}\\s*Round\\s+(\\d+)"] },
    });
    const runtime = resolveClarifyRuntimeAnchors({ config });

    expect(runtime.forward.roundHeading!.patterns[0]).toBe("^#{1,2}\\s*Round\\s+(\\d+)");
    const result = deriveClarifyForwardArgs(
      "## Round 1\n问题\nAnswer: yes\n## Round 2\n新问题\n",
      runtime.forward,
    );
    expect(result).toEqual({ kind: "await-answer", round: 2 });
  });
});

describe("clarify runtime anchors: configuration detection", () => {
  it("stays unconfigured without job JSON or verify.md anchors", () => {
    const runtime = resolveClarifyRuntimeAnchors({ config: makeTestConfig() });
    expect(runtime.anchorsConfigured).toBe(false);
  });

  it("is configured by the job JSON alone (defaults become authoritative)", () => {
    const runtime = resolveClarifyRuntimeAnchors({
      config: makeTestConfig({ clarifyProtocol: { answerMarkers: ["Confirm:"] } }),
    });
    expect(runtime.anchorsConfigured).toBe(true);
  });
});
