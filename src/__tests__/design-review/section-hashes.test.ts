/**
 * 229 Phase 3 (F3/B15): PURE section-hash baseline + diff.
 *
 * Boundaries covered (plan Phase 3 "单元测试目标，边界"):
 * - coverage: `## Phase 0..7` AND `## 验收`/`## 风险`/`## 用户确认` all get
 *   keys (Phase sections keyed `phase:<n>`, others `section:<title>`);
 *   duplicate headings get stable suffixes in document order;
 * - diff: only `## 验收` changed ⇒ `changed = ["section:验收"]`; only
 *   Phase 5 changed ⇒ `phase:5`; added/removed sections are reported.
 */

import { describe, expect, it } from "bun:test";
import { computeSectionHashes, diffSectionHashes } from "../../core/design-review/section-hashes";

const FULL_PLAN = [
  "# 229 Feat Plan",
  "",
  "## Phase 0 — 契约基座",
  "content-0",
  "",
  "## Phase 1 — verdict",
  "content-1",
  "",
  "## 验收",
  "acceptance content",
  "",
  "## 风险",
  "risk content",
  "",
  "## 用户确认",
  "user confirmation",
  "",
].join("\n");

describe("229 Phase 3: computeSectionHashes (B15 full top-level coverage)", () => {
  it("hashes ALL top-level ## sections: Phase keys + non-Phase sections", () => {
    const hashes = computeSectionHashes(FULL_PLAN);
    expect(Object.keys(hashes)).toEqual([
      "phase:0",
      "phase:1",
      "section:验收",
      "section:风险",
      "section:用户确认",
    ]);
  });

  it("the title line itself never influences the hash; body edits do", () => {
    const a = computeSectionHashes(FULL_PLAN);
    const retitled = FULL_PLAN.replace("## Phase 0 — 契约基座", "## Phase 0 — 契约基座与类型");
    const b = computeSectionHashes(retitled);
    expect(b["phase:0"]).toBe(a["phase:0"]);
    const edited = FULL_PLAN.replace("content-0", "content-0 (revised)");
    const c = computeSectionHashes(edited);
    expect(c["phase:0"]).not.toBe(a["phase:0"]);
  });

  it("duplicate headings get stable #k suffixes in first-seen order", () => {
    const hashes = computeSectionHashes(["## 备注", "one", "## 备注", "two"].join("\n"));

    expect(Object.keys(hashes)).toEqual(["section:备注", "section:备注#2"]);
    expect(hashes["section:备注"]).not.toBe(hashes["section:备注#2"]);
  });

  it("`phase:<n>` extracts the number regardless of trailing dash prose", () => {
    const hashes = computeSectionHashes("## Phase 3 Update — incremental scope\nbody\n");
    expect(Object.keys(hashes)).toEqual(["phase:3"]);
  });
});

describe("229 Phase 3: diffSectionHashes", () => {
  const baseline = computeSectionHashes(FULL_PLAN);

  it("only ## 验收 changed ⇒ changed == [section:验收] (B15 越界无处隐藏)", () => {
    const moved = FULL_PLAN.replace("acceptance content", "acceptance content (edited)");
    const current = computeSectionHashes(moved);
    expect(diffSectionHashes(baseline, current)).toEqual({
      changed: ["section:验收"],
      added: [],
      removed: [],
    });
  });

  it("only Phase 5 changed ⇒ changed == [phase:5]", () => {
    const plan = FULL_PLAN.replace("## Phase 1 — verdict", "## Phase 5 — verdict");
    const current = computeSectionHashes(plan.replace("content-1", "content-5"));
    expect(diffSectionHashes(baseline, current)).toEqual({
      changed: [],
      added: ["phase:5"],
      removed: ["phase:1"],
    });
  });

  it("identical content ⇒ zero diff", () => {
    expect(diffSectionHashes(baseline, computeSectionHashes(FULL_PLAN))).toEqual({
      changed: [],
      added: [],
      removed: [],
    });
  });
});
