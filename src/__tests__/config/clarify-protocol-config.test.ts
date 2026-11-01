/**
 * 221 Phase 0: optional `.pi/pipeline_loop_job.json` loading + clarify anchor
 * resolution.
 *
 * Key behaviors:
 * - Missing/empty config stays `undefined` (human path untouched).
 * - Unknown/invalid keys warn and are dropped without blocking the rest.
 * - `mergeCompletionMarkers` never enables the precheck on its own.
 * - `resolveClarifyAnchors` resolves job → verify.md → defaults and validates
 *   the JOINED round pattern set (duplicate named groups must not pass).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClarifyProtocolConfig } from "../../types";
import { PIPELINE_LOOP_JOB_CONFIG_FILE } from "../../constants";
import {
  loadClarifyProtocolConfig,
  parseClarifyProtocolJson,
} from "../../core/auto-pipeline/clarify-protocol-config";
import {
  COMPAT_ROUND_PATTERN,
  DEFAULT_CLARIFY_PROTOCOL,
  mergeCompletionMarkers,
  normalizeMarkerConfig,
  resolveClarifyAnchors,
} from "../../core/auto-pipeline/clarify-anchors";

let TMP: string;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-clarify-protocol-"));
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Capture console.warn output produced by one call. */
function captureWarnings<T>(run: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = original;
  }
}

function writeJobConfig(value: unknown): void {
  const file = path.join(TMP, PIPELINE_LOOP_JOB_CONFIG_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

const BILINGUAL_JOB = {
  version: 1,
  clarify: {
    assessment: { heading: ["## 需求评估", "## Requirement Assessment"] },
    sections: {
      goal: ["## 目标", "## Goal"],
      scope: ["## 范围", "## Scope"],
      acceptance: ["## 验收标准", "## Acceptance Criteria"],
    },
    ledger: {
      heading: ["## 组合决策台账", "## Decision Ledger"],
      eliminationMarkers: ["淘汰理由", "elimination reason"],
      conflictMarkers: ["冲突矩阵", "conflict matrix"],
    },
    questions: { patterns: ["^##\\s*问题\\s+(\\d+)", "^##\\s*Question\\s+(\\d+)"] },
    verdicts: { ready: ["ready", "已明确"], needsClarify: ["needs-clarify", "需澄清"] },
  },
};

describe("loadClarifyProtocolConfig", () => {
  it("returns undefined when the file is absent", () => {
    expect(loadClarifyProtocolConfig(TMP)).toBeUndefined();
  });

  it("returns undefined for an empty object", () => {
    writeJobConfig({});
    expect(loadClarifyProtocolConfig(TMP)).toBeUndefined();
  });

  it("maps the nested JSON shape onto the flat config", () => {
    writeJobConfig(BILINGUAL_JOB);
    const config = loadClarifyProtocolConfig(TMP);
    expect(config).toEqual({
      assessmentHeading: ["## 需求评估", "## Requirement Assessment"],
      goalHeading: ["## 目标", "## Goal"],
      scopeHeading: ["## 范围", "## Scope"],
      acceptanceHeading: ["## 验收标准", "## Acceptance Criteria"],
      ledgerHeading: ["## 组合决策台账", "## Decision Ledger"],
      eliminationMarkers: ["淘汰理由", "elimination reason"],
      conflictMarkers: ["冲突矩阵", "conflict matrix"],
      questionPatterns: ["^##\\s*问题\\s+(\\d+)", "^##\\s*Question\\s+(\\d+)"],
      verdictReady: ["ready", "已明确"],
      verdictNeedsClarify: ["needs-clarify", "需澄清"],
    });
    // rounds / answers / modelConfirm are intentionally absent in the template.
    expect(config?.roundPatterns).toBeUndefined();
    expect(config?.answerMarkers).toBeUndefined();
    expect(config?.modelConfirm).toBeUndefined();
  });

  it("warns on an invalid JSON file and returns undefined", () => {
    fs.mkdirSync(path.join(TMP, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(TMP, PIPELINE_LOOP_JOB_CONFIG_FILE), "{ nope", "utf8");
    const { result, warnings } = captureWarnings(() => loadClarifyProtocolConfig(TMP));
    expect(result).toBeUndefined();
    expect(warnings.join("\n")).toContain("not valid JSON");
  });
});

describe("parseClarifyProtocolJson", () => {
  it("trims and dedupes entries, dropping invalid ones with issues", () => {
    const { config, issues } = parseClarifyProtocolJson({
      clarify: { assessment: { heading: ["  ## X  ", "## X", "", 7] } },
    });
    expect(config?.assessmentHeading).toEqual(["## X"]);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("warns on unknown top-level and nested keys but keeps the known ones", () => {
    const { config, issues } = parseClarifyProtocolJson({
      version: 1,
      unknownTop: true,
      clarify: {
        ledger: { heading: ["## Ledger"], mystery: 1 },
      },
    });
    expect(config?.ledgerHeading).toEqual(["## Ledger"]);
    expect(issues.some((i) => i.includes("unknownTop"))).toBe(true);
    expect(issues.some((i) => i.includes("clarify.ledger.mystery"))).toBe(true);
  });

  it("warns on an unsupported version but continues parsing", () => {
    const { config, issues } = parseClarifyProtocolJson({
      version: 2,
      clarify: { ledger: { heading: ["## Ledger"] } },
    });
    expect(config?.ledgerHeading).toEqual(["## Ledger"]);
    expect(issues.some((i) => i.includes("unsupported version"))).toBe(true);
  });

  it("drops a non-array heading with an issue", () => {
    const { config, issues } = parseClarifyProtocolJson({
      clarify: { assessment: { heading: "## 需求评估" } },
    });
    expect(config).toBeUndefined();
    expect(issues.some((i) => i.includes("must be an array"))).toBe(true);
  });
});

describe("normalizeMarkerConfig / mergeCompletionMarkers", () => {
  it("normalizes an empty array to undefined (frozen no-precheck path)", () => {
    expect(normalizeMarkerConfig([])).toBeUndefined();
    expect(normalizeMarkerConfig(["", "  "])).toBeUndefined();
    expect(normalizeMarkerConfig(undefined)).toBeUndefined();
  });

  it("keeps a configured string as a string", () => {
    expect(normalizeMarkerConfig("## 模型确认")).toBe("## 模型确认");
  });

  it("never enables the precheck from job aliases alone", () => {
    expect(mergeCompletionMarkers(undefined, ["## Model Confirmation"])).toBeUndefined();
    expect(mergeCompletionMarkers([], ["## Model Confirmation"])).toBeUndefined();
  });

  it("merges aliases into a configured string and dedupes", () => {
    expect(mergeCompletionMarkers("## 模型确认", ["## Model Confirmation"])).toEqual([
      "## 模型确认",
      "## Model Confirmation",
    ]);
    expect(mergeCompletionMarkers("## 模型确认", ["## 模型确认"])).toBe("## 模型确认");
  });

  it("returns the configured value unchanged when there are no aliases", () => {
    expect(mergeCompletionMarkers(["## 模型确认"], undefined)).toEqual(["## 模型确认"]);
  });
});

describe("resolveClarifyAnchors", () => {
  it("falls back to the bilingual defaults without any config", () => {
    const anchors = resolveClarifyAnchors({});
    expect(anchors.assessmentHeading).toEqual(DEFAULT_CLARIFY_PROTOCOL.assessmentHeading);
    expect(anchors.answerPrimary).toBe("答：");
    expect(anchors.completionPrimary).toBe("## 模型确认");
    expect(anchors.roundPatterns.map((p) => p.source)).toContain(COMPAT_ROUND_PATTERN);
  });

  it("prefers job-declared anchors over defaults", () => {
    const job: ClarifyProtocolConfig = {
      assessmentHeading: ["## Requirement Assessment"],
      answerMarkers: ["Answer:"],
      verdictReady: ["ready"],
    };
    const anchors = resolveClarifyAnchors({ job });
    expect(anchors.assessmentHeading[0]).toBe("## Requirement Assessment");
    expect(anchors.answerPrimary).toBe("Answer:");
    expect(anchors.answerPatterns[0]!.source).toBe("^\\s*Answer:");
  });

  it("uses verify.md round patterns when the job declares none", () => {
    const anchors = resolveClarifyAnchors({
      verify: { roundHeading: { patterns: ["^## Round (?<roundEn>\\d+)"], mode: "and" } },
    });
    expect(anchors.roundPatterns[0]!.source).toBe("^## Round (?<roundEn>\\d+)");
    expect(anchors.roundPatterns.map((p) => p.source)).toContain(COMPAT_ROUND_PATTERN);
  });

  it("drops an invalid round pattern group and falls back to verify", () => {
    const { result, warnings } = captureWarnings(() =>
      resolveClarifyAnchors({
        job: { roundPatterns: ["([unclosed"] },
        verify: { roundHeading: { patterns: ["^## Round (?<roundEn>\\d+)"], mode: "and" } },
      }),
    );
    expect(result.roundPatterns[0]!.source).toBe("^## Round (?<roundEn>\\d+)");
    expect(warnings.join("\n")).toContain("invalid pattern");
  });

  // NOTE: current engines ACCEPT duplicate named groups split across
  // alternatives, so the joined-regex guard is defensive (F5). The behavior it
  // protects — never handing a HALF-valid round set to `deriveClarifyForwardArgs`
  // (which would silently fall back to `fresh`) — is asserted here through an
  // invalid member of the group.
  it("drops the WHOLE round group when one pattern is invalid (no partial set)", () => {
    const { result, warnings } = captureWarnings(() =>
      resolveClarifyAnchors({
        job: {
          roundPatterns: [
            "^## 第\\s*(?<roundZh>\\d+)\\s*轮",
            "^## Round\\s+(?<roundEn>\\d+",
          ],
        },
      }),
    );
    expect(result.roundPatterns[0]!.source).toBe(DEFAULT_CLARIFY_PROTOCOL.roundPatterns[0]!);
    expect(warnings.join("\n")).toContain("invalid pattern");
  });

  it("absorbs job modelConfirm aliases into the primary marker", () => {
    const anchors = resolveClarifyAnchors({
      job: { modelConfirm: ["## 自定义确认"] },
      completionMarker: ["## 模型确认"],
    });
    expect(anchors.modelConfirm[0]).toBe("## 自定义确认");
    expect(anchors.modelConfirm).toContain("## 模型确认");
    expect(anchors.modelConfirm).toContain("## Model Confirmation");
    expect(anchors.completionPrimary).toBe("## 自定义确认");
  });
});
