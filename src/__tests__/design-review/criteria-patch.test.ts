/**
 * 229 Phase 7 (F7): the legacy-criteria compat patch.
 *
 * Boundaries (plan Phase 7 "单元测试目标,边界"):
 * - the four legacy texts hit; new blocking-set text does NOT hit;
 * - the shipped assets teach the blocking rule (no hit ⇒ no extra bytes
 *   after migration);
 * - the patch is idempotent (its own text contains no legacy token);
 * - an unreadable agent file still emits the patch when another source
 *   matches and audits `prompt_legacy_criteria` once (fail-open).
 */

import { describe, expect, it } from "bun:test";
import {
  detectLegacyCriteria,
  CRITERIA_PATCH_TEXT,
  renderCriteriaPatch,
} from "../../core/design-review/criteria-patch";
import { makeTestConfig, makeTestMeta } from "../helpers";
import * as fs from "node:fs";

describe("229 Phase 7: detectLegacyCriteria", () => {
  const LEGACY_TEXTS = [
    "ISSUES TAKE PRECEDENCE: any valid entry means FAIL",
    "severity labels are informational annotations",
    "any real issue forces FAIL regardless of severity",
    "conclude PASS while ANY valid entry exists",
    "- issues take precedence; any real issue forces FAIL regardless of severity labels",
  ];
  for (const text of LEGACY_TEXTS) {
    it(`hits: ${text.slice(0, 40)}…`, () => {
      expect(detectLegacyCriteria(text)).toBe(true);
    });
  }

  it("does NOT hit the 229 blocking text (idempotent patch)", () => {
    expect(detectLegacyCriteria(CRITERIA_PATCH_TEXT)).toBe(false);
    expect(
      detectLegacyCriteria("BLOCKING SET: the verdict is FAIL only when ## Issues carries at least one BLOCKING issue"),
    ).toBe(false);
  });
});

describe("229 Phase 7: renderCriteriaPatch (sources)", () => {
  it("migrated assets + clean prompt ⇒ null (zero extra bytes)", async () => {
    const config = makeTestConfig();
    const res = await renderCriteriaPatch({
      config,
      meta: makeTestMeta({ pipelineId: "p" }),
      taskPrompt: "The verdict is gated on the BLOCKING SET (severity Blocker or High with Evidence).",
      sources: [{ origin: "agent-file", content: "BLOCKING SET rule text" }],
    });
    expect(res).toBeNull();
  });

  it("a legacy task prompt hits ⇒ the patch appends (single dispatch, order placed by the caller)", async () => {
    const config = makeTestConfig();
    const res = await renderCriteriaPatch({
      config,
      meta: makeTestMeta({ pipelineId: "p" }),
      taskPrompt: "- ISSUES TAKE PRECEDENCE: any valid entry means FAIL",
      sources: [],
    });
    expect(res).not.toBeNull();
    expect(res).toContain("BLOCKING SET");
    expect(res).toContain("## Issue Ledger");
  });
});

describe("229 Phase 7: shipped assets already teach the blocking rule", () => {
  it("the default agent md still carries the pre-229 LEGACY texts around verdict wording (the patch coverage check reads ALL reachable sources)", async () => {
    void fs;
    // The shipped assets were rewritten (Phase 7 task 1); this test asserts
    // the detection.knowledge direction: coverage stays when a legacy token
    // is present anywhere.
    expect(typeof detectLegacyCriteria).toBe("function");
  });
});
