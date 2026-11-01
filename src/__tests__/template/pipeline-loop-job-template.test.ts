/**
 * 221 Phase 0: the optional clarify protocol template ships as a template asset.
 *
 * Key behaviors:
 * - The file is valid JSON with `version: 1`.
 * - It declares ONLY the new anchor keys (rounds / answers / modelConfirm stay
 *   owned by verify.md and `completionMarker`, avoiding double sources).
 * - Every declared array is non-empty, so the loader can never resolve an
 *   empty (meaningless) anchor.
 */

import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  parseClarifyProtocolJson,
} from "../../core/auto-pipeline/clarify-protocol-config";

const TEMPLATE_PATH = path.join(__dirname, "../../template/pipeline_loop_job.json");

function readTemplate(): Record<string, any> {
  return JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf-8"));
}

describe("pipeline_loop_job.json template", () => {
  it("is valid JSON with version 1", () => {
    const template = readTemplate();
    expect(template.version).toBe(1);
    expect(typeof template.clarify).toBe("object");
  });

  it("declares only the new anchor keys", () => {
    const clarify = readTemplate().clarify as Record<string, unknown>;
    expect(Object.keys(clarify).sort()).toEqual(
      ["assessment", "ledger", "questions", "sections", "verdicts"].sort(),
    );
    expect(clarify.rounds).toBeUndefined();
    expect(clarify.answers).toBeUndefined();
    expect(clarify.modelConfirm).toBeUndefined();
  });

  it("declares only non-empty string arrays", () => {
    const template = readTemplate();
    const arrays: unknown[] = [
      template.clarify.assessment.heading,
      template.clarify.sections.goal,
      template.clarify.sections.scope,
      template.clarify.sections.acceptance,
      template.clarify.ledger.heading,
      template.clarify.ledger.eliminationMarkers,
      template.clarify.ledger.conflictMarkers,
      template.clarify.questions.patterns,
      template.clarify.verdicts.ready,
      template.clarify.verdicts.needsClarify,
    ];
    for (const value of arrays) {
      expect(Array.isArray(value)).toBe(true);
      expect((value as unknown[]).length).toBeGreaterThan(0);
      for (const entry of value as unknown[]) {
        expect(typeof entry).toBe("string");
        expect((entry as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("parses without issues and is bilingual", () => {
    const { config, issues } = parseClarifyProtocolJson(readTemplate());
    expect(issues).toEqual([]);
    expect(config?.assessmentHeading).toEqual(["## 需求评估", "## Requirement Assessment"]);
    expect(config?.questionPatterns, "question aliases").toBeDefined();
  });
});
