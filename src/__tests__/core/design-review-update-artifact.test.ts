/**
 * 194 Phase 0 (C1): standalone update-receipt descriptor tests.
 *
 * Covers: plugin-derived path identity (spaces/CJK), rejection of illegal
 * round / operation-id / format, descriptor narrowing matrix (legacy read vs
 * standalone vs invalid — NEVER a silent downgrade), baseline digest of the
 * legacy section set (including the EMPTY set), fence-aware extraction.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import {
  STANDALONE_UPDATE_FORMAT,
  computeBaselineSectionsHash,
  createStandaloneUpdateArtifact,
  deriveStandaloneReceiptPath,
  extractLegacyUpdateSections,
  narrowUpdateArtifact,
} from "../../core/design-review/update-artifact";

const UUID_A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const UUID_B = "11111111-2222-3333-4444-555555555555";
const HASH_A = "a".repeat(64);

describe("194 Phase 0 C1: deriveStandaloneReceiptPath", () => {
  it("pins the receipt beside the original plan with round+operation+planBase", () => {
    const planDoc = path.join("/tmp", "proj", "docs", "design", "10_Feat_fn_ecom_plan.md");
    const receipt = deriveStandaloneReceiptPath(planDoc, 2, UUID_A);
    expect(receipt).toBe(path.join("/tmp/proj/docs/design", `Design_Review_Update_2_${UUID_A}_10_Feat_fn_ecom_Design.md`));
  });

  it("supports spaces and CJK in the plan name without shell/path tricks", () => {
    const planDoc = "/tmp/我的 项目/docs design/194_Bug 计划.md";
    const receipt = deriveStandaloneReceiptPath(planDoc, 1, UUID_B);
    expect(receipt).not.toBeNull();
    expect(receipt!.startsWith(path.dirname(planDoc) + path.sep)).toBe(true);
    expect(path.basename(receipt!)).toContain("194_Bug 计划");
    // Exactly one derived file name — no wildcard / "latest file" semantics.
    expect(path.basename(receipt!)).toBe(`Design_Review_Update_1_${UUID_B}_194_Bug 计划_Design.md`);
  });

  it("same operation retries on the same path, a new operation changes it", () => {
    const planDoc = "/tmp/docs/plan.md";
    const a1 = deriveStandaloneReceiptPath(planDoc, 3, UUID_A);
    const a2 = deriveStandaloneReceiptPath(planDoc, 3, UUID_A);
    const b1 = deriveStandaloneReceiptPath(planDoc, 3, UUID_B);
    expect(a1).toBe(a2);
    expect(b1).not.toBe(a1);
  });

  it("refuses non-positive / non-integer rounds, relative plan paths and non-UUID ids", () => {
    const planDoc = "/tmp/docs/plan.md";
    expect(deriveStandaloneReceiptPath(planDoc, 0, UUID_A)).toBeNull();
    expect(deriveStandaloneReceiptPath(planDoc, -1, UUID_A)).toBeNull();
    expect(deriveStandaloneReceiptPath(planDoc, 1.5, UUID_A)).toBeNull();
    expect(deriveStandaloneReceiptPath(planDoc, Number.NaN, UUID_A)).toBeNull();
    expect(deriveStandaloneReceiptPath("docs/plan.md", 1, UUID_A)).toBeNull();
    expect(deriveStandaloneReceiptPath("", 1, UUID_A)).toBeNull();
    // Path-injection attempts never reach join(): the UUID shape is the guard.
    expect(deriveStandaloneReceiptPath(planDoc, 1, "../../etc/passwd")).toBeNull();
    expect(deriveStandaloneReceiptPath(planDoc, 1, "*")).toBeNull();
    expect(deriveStandaloneReceiptPath(planDoc, 1, `${UUID_A}\n## x`)).toBeNull();
  });
});

describe("194 Phase 0 C1: narrowUpdateArtifact", () => {
  const planDoc = "/tmp/docs/plan.md";
  const round = 2;

  it("an ABSENT descriptor is the only legacy-read compatibility signal", () => {
    expect(narrowUpdateArtifact(undefined, planDoc, round, UUID_A)).toEqual({ ok: true, kind: "legacy" });
  });

  it("a valid descriptor narrows to the pinned standalone path", () => {
    const artifact = createStandaloneUpdateArtifact(planDoc, round, UUID_A, ["## Design Review Update\nold"])!;
    const narrowed = narrowUpdateArtifact(artifact, planDoc, round, UUID_A);
    expect(narrowed.ok).toBe(true);
    if (narrowed.ok && narrowed.kind === "standalone") {
      expect(narrowed.receiptDoc).toBe(deriveStandaloneReceiptPath(planDoc, round, UUID_A)!);
      expect(narrowed.baselineSectionsHash).toBe(artifact.baselineSectionsHash);
    }
  });

  it("never downgrades: malformed payloads are invalid", () => {
    const valid = createStandaloneUpdateArtifact(planDoc, round, UUID_A, [])!;
    const cases: Array<[unknown, string]> = [
      [null, "update_artifact_not_object"],
      ["standalone-v1", "update_artifact_not_object"],
      [[], "update_artifact_not_object"],
      [{ format: "standalone-v2", receiptDoc: valid.receiptDoc, baselineSectionsHash: HASH_A }, "update_artifact_unknown_format"],
      [{ format: "standalone-v1", baselineSectionsHash: HASH_A }, "update_artifact_missing_receipt_doc"],
      [{ format: "standalone-v1", receiptDoc: valid.receiptDoc }, "update_artifact_missing_baseline_hash"],
      [{ format: "standalone-v1", receiptDoc: valid.receiptDoc, baselineSectionsHash: "zz" }, "update_artifact_baseline_hash_malformed"],
      [{ format: "standalone-v1", receiptDoc: "docs/relative.md", baselineSectionsHash: HASH_A }, "update_artifact_receipt_not_absolute"],
      // Receipt pointing at a DIFFERENT round/operation (path drift) is rejected.
      [{ format: "standalone-v1", receiptDoc: deriveStandaloneReceiptPath(planDoc, 1, UUID_A), baselineSectionsHash: HASH_A }, "update_artifact_receipt_path_drift"],
      [{ format: "standalone-v1", receiptDoc: `${deriveStandaloneReceiptPath(planDoc, round, UUID_A)}.bak`, baselineSectionsHash: HASH_A }, "update_artifact_receipt_path_drift"],
      // "The latest file" style wildcards never resolve to an expected path.
      [{ format: "standalone-v1", receiptDoc: "/tmp/docs/plan-update-*", baselineSectionsHash: HASH_A }, "update_artifact_receipt_path_drift"],
    ];
    for (const [input, reason] of cases) {
      const res = narrowUpdateArtifact(input, planDoc, round, UUID_A);
      expect(res).toEqual({ ok: false, reason });
    }
  });

  it("rejects descriptors whose own identity components are invalid", () => {
    const res = narrowUpdateArtifact(
      { format: STANDALONE_UPDATE_FORMAT, receiptDoc: "/tmp/docs/plan-update-2-x.md", baselineSectionsHash: HASH_A },
      planDoc,
      0,
      UUID_A,
    );
    expect(res).toEqual({ ok: false, reason: "update_artifact_identity_invalid" });
  });
});

describe("194 Phase 0 C1: baseline sections hash", () => {
  it("hashes the EMPTY set positively and stably (no content stored)", () => {
    const empty = computeBaselineSectionsHash([]);
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(computeBaselineSectionsHash([])).toBe(empty);
    expect(computeBaselineSectionsHash(["x"])).not.toBe(empty);
  });

  it("is order-sensitive", () => {
    const a = computeBaselineSectionsHash(["one", "two"]);
    const b = computeBaselineSectionsHash(["two", "one"]);
    expect(a).not.toBe(b);
  });
});

describe("194 Phase 0 C1: fence-aware legacy section extraction", () => {
  it("extracts every real section and ignores headings inside fences", () => {
    const plan = [
      "# Plan",
      "",
      "## Design Review Update",
      "round 1 text",
      "",
      "### Sub note",
      "still inside the section",
      "",
      "```md",
      "## Design Review Update",
      "example inside a fence is NOT a section",
      "```",
      "",
      "## Phase 1",
      "real phase content",
      "",
      "~~~",
      "## Design Review Update",
      "tilde fence example",
      "~~~",
      "",
      "## Design Review Update",
      "round 2 text",
      "trailing line",
    ].join("\n");

    const sections = extractLegacyUpdateSections(plan);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("round 1 text");
    expect(sections[0]).toContain("### Sub note");
    expect(sections[0]).toContain("```md");
    expect(sections[0]).toContain("example inside a fence is NOT a section");
    expect(sections[1]).toContain("round 2 text");
    expect(sections[1]).not.toContain("tilde fence example");
    // A higher-level heading terminated the first section at "## Phase 1".
    expect(sections[0]).not.toContain("real phase content");
  });

  it("returns the empty set for a plan with no legacy receipt", () => {
    expect(extractLegacyUpdateSections("# Plan\n\n## Phase 0\ncontent\n")).toEqual([]);
  });

  it("a section running to end of file is still captured", () => {
    const sections = extractLegacyUpdateSections("intro\n## Design Review Update\ntail\n");
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("tail");
  });
});
