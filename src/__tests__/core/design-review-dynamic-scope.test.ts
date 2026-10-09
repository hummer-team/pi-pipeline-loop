/**
 * @module design-review-dynamic-scope.test
 * Phase 4 (191): Test dynamic write scope enforcement for design-review operations.
 * 
 * Verifies:
 * - isWithinDesignReviewScope correctly restricts paths based on operation type
 * - resolveSymlinkPath resolves symbolic links to actual paths
 * - Review operation can only write to report document
 * - Update operation can only write to plan document and allowed artifacts
 * - develop-handoff operation blocks all writes
 */

import { describe, it, expect } from "bun:test";
import { isWithinDesignReviewScope, resolveSymlinkPath } from "../../utils/protect";
import type { DesignReviewOperation } from "../../types";

function createOperation(kind: "review" | "update" | "develop-handoff"): DesignReviewOperation {
  return {
    operationId: "op-1",
    kind,
    stageVisitId: 1,
    attempt: 1,
    dispatchState: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("Phase 4 (191): Dynamic write scope (isWithinDesignReviewScope)", () => {
  const projectRoot = "/project";
  const planDoc = "/project/docs/plan.md";
  const reportDoc = "/project/docs/report.md";

  describe("review operation", () => {
    const operation = createOperation("review");

    it("allows writing to report document", () => {
      const result = isWithinDesignReviewScope(
        "docs/report.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot
      );
      expect(result).toBe(true);
    });

    it("blocks writing to plan document", () => {
      const result = isWithinDesignReviewScope(
        "docs/plan.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot
      );
      expect(result).toBe(false);
    });

    it("blocks writing to other paths", () => {
      const result = isWithinDesignReviewScope(
        "src/index.ts",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot
      );
      expect(result).toBe(false);
    });

    it("blocks when reportDoc is undefined", () => {
      const result = isWithinDesignReviewScope(
        "docs/report.md",
        operation.kind,
        planDoc,
        undefined,
        projectRoot
      );
      expect(result).toBe(false);
    });
  });

  describe("update operation", () => {
    const operation = createOperation("update");
    // 194 Phase 1 (C4): the extra list carries EXACT absolute artifact paths
    // (the standalone receipt document). No prefixes, no globs, no directory
    // grants — a listed file can never smuggle in its siblings.
    const exactPaths = ["/project/docs/plan.md", "/project/docs/plan/plan-update-1-op-1-plan.md"];

    it("allows writing to plan document", () => {
      const result = isWithinDesignReviewScope(
        "docs/plan.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot,
        exactPaths
      );
      expect(result).toBe(true);
    });

    it("allows writing to an EXACT listed artifact path", () => {
      const result = isWithinDesignReviewScope(
        "docs/plan/plan-update-1-op-1-plan.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot,
        exactPaths
      );
      expect(result).toBe(true);
    });

    it("blocks a sibling inside a listed artifact's directory (no prefix grants)", () => {
      const result = isWithinDesignReviewScope(
        "docs/plan/architecture.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot,
        exactPaths
      );
      expect(result).toBe(false);
    });

    it("blocks writing to report document", () => {
      const result = isWithinDesignReviewScope(
        "docs/report.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot,
        exactPaths
      );
      expect(result).toBe(false);
    });

    it("blocks writing to non-allowed paths", () => {
      const result = isWithinDesignReviewScope(
        "src/index.ts",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot,
        exactPaths
      );
      expect(result).toBe(false);
    });

    it("allows plan document even when the exact list is empty", () => {
      const result = isWithinDesignReviewScope(
        "docs/plan.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot,
        []
      );
      expect(result).toBe(true);
    });
  });

  describe("develop-handoff operation", () => {
    const operation = createOperation("develop-handoff");

    it("blocks all writes", () => {
      const result = isWithinDesignReviewScope(
        "docs/plan.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot
      );
      expect(result).toBe(false);
    });

    it("blocks report writes", () => {
      const result = isWithinDesignReviewScope(
        "docs/report.md",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot
      );
      expect(result).toBe(false);
    });

    it("blocks any other paths", () => {
      const result = isWithinDesignReviewScope(
        "src/index.ts",
        operation.kind,
        planDoc,
        reportDoc,
        projectRoot
      );
      expect(result).toBe(false);
    });
  });
});

describe("Phase 4 (191): Symlink resolution (resolveSymlinkPath)", () => {
  it("resolves absolute symlink to target path (canonical, 192 Phase 4)", async () => {
    // 192 Phase 4 (F07): resolution is CANONICAL — ancestors that are real
    // symlinks (e.g. macOS /tmp → /private/tmp) are followed even when the
    // leaf does not exist yet.
    const fs = await import("node:fs");
    const result = await resolveSymlinkPath("/tmp/nonexistent");
    expect(typeof result).toBe("string");
    expect(result).toBe(fs.realpathSync("/tmp") + "/nonexistent");
  });

  it("returns lexical path when no existing ancestor can be found or errors", async () => {
    // /project does not exist anywhere: the nearest existing ancestor is "/"
    // itself → canonicalized to "/" + remainder (same lexical path).
    const result = await resolveSymlinkPath("/project/regular/file.txt");
    expect(typeof result).toBe("string");
    expect(result).toBe("/project/regular/file.txt");
  });
});
