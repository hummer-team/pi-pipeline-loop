import { describe, test, expect } from "bun:test";
import {
  describeReadOnlyWriteConflict,
  describeEmptyWriteScopeConflict,
  describeFrozenBlocked,
  describeInvalidNextStage,
  checkDispatchConflicts,
} from "../../utils/guard-conflict-report";
import type { SessionMeta } from "../../types";

describe("guard-conflict-report", () => {
  describe("describeReadOnlyWriteConflict", () => {
    test("produces conflict description with paths", () => {
      const report = describeReadOnlyWriteConflict(
        "develop",
        ["docs/design/*.md"],
        ["docs/design/plan.md"],
      );
      expect(report).toContain("Configuration conflict");
      expect(report).toContain("stage 'develop'");
      expect(report).toContain("docs/design/*.md");
      expect(report).toContain("docs/design/plan.md");
      expect(report).toContain("read-only takes priority");
      expect(report).toContain("Next step");
    });

    test("includes violation threshold fact", () => {
      const report = describeReadOnlyWriteConflict("fix", ["src/**"], ["src/core.ts"]);
      expect(report).toContain("DEFAULT_MAX_VIOLATIONS (3)");
    });
  });

  describe("describeEmptyWriteScopeConflict", () => {
    test("describes empty write scope", () => {
      const report = describeEmptyWriteScopeConflict("design-review", "nothing (blocked by design-review)");
      expect(report).toContain("stage 'design-review'");
      expect(report).toContain("write scope is empty");
      expect(report).toContain("nothing (blocked by design-review)");
      expect(report).toContain("Next step");
    });
  });

  describe("describeFrozenBlocked", () => {
    test("blocked state produces freeze message", () => {
      const meta: SessionMeta = {
        currentStage: "develop",
        stageStartTime: Date.now(),
        flowState: "blocked",
        blockedReason: "violation_overflow",
      } as any;
      const report = describeFrozenBlocked(meta);
      expect(report).toContain("Pipeline frozen");
      expect(report).toContain("violation_overflow");
      expect(report).toContain("Next step");
    });

    test("aborted state produces abort message", () => {
      const meta: SessionMeta = {
        currentStage: "fix",
        stageStartTime: Date.now(),
        flowState: "aborted",
        terminateReason: "session_quit",
        requirementDoc: "plan.md",
      } as any;
      const report = describeFrozenBlocked(meta);
      expect(report).toContain("Pipeline");
      expect(report).toContain("aborted");
    });
  });

  describe("describeInvalidNextStage", () => {
    test("echoes legal chain", () => {
      const report = describeInvalidNextStage(["plan", "develop", "review", "completed"]);
      expect(report).toContain("Invalid nextStage");
      expect(report).toContain("plan → develop → review → completed");
      expect(report).toContain("Next step");
    });
  });

  describe("checkDispatchConflicts", () => {
    test("returns null when no conflicts", async () => {
      const meta = {
        currentStage: "develop",
        requirementDoc: "plan.md",
      } as SessionMeta;
      // readOnlyPaths does NOT match the deliverable path (docs/design/plan_commit.md)
      const result = await checkDispatchConflicts(
        "develop",
        meta,
        ["src/*.md"],
        ["docs/design/plan_commit.md"],
        () => ({ mode: "ordinary" }),
        (_p) => _p.mode === "ordinary" ? "full write" : "nothing",
      );
      expect(result).toBeNull();
    });

    test("no conflict when deliverable path is exempted (Phase 1)", async () => {
      const meta = {
        currentStage: "develop",
        requirementDoc: "plan.md",
      } as SessionMeta;
      // resolveCommitDocPath("plan") returns "docs/design/plan_commit.md"
      // readOnlyPaths matches it via glob pattern
      // BUT Phase 1 exemption applies because requirementDoc exists
      const result = await checkDispatchConflicts(
        "develop",
        meta,
        ["docs/design/*.md"],
        ["docs/design/plan_commit.md"],
        () => ({ mode: "ordinary" }),
        (_p) => _p.mode === "ordinary" ? "full write" : "nothing",
      );
      // Exemption applies, so no conflict should be detected
      expect(result).toBeNull();
    });

    test("detects empty-write-scope conflict for design-review stage", async () => {
      const meta = {
        currentStage: "design-review",
        requirementDoc: "plan.md",
      } as SessionMeta;
      const result = await checkDispatchConflicts(
        "design-review",
        meta,
        undefined,
        ["docs/design/plan_commit.md"],
        () => ({ mode: "blocked", reason: "design-review active" }),
        (_p) => _p.mode === "blocked" ? "nothing (blocked)" : "full write",
      );
      expect(result).not.toBeNull();
      expect(result?.conflictType).toBe("empty_write_scope");
      expect(result?.report).toContain("write scope is empty");
    });

    test("conflict i: requirementDoc missing + read-only hits contract pattern ⇒ block (195 Phase 2 G1)", async () => {
      const meta = {
        currentStage: "develop",
      } as SessionMeta;
      // allowedReadOnlyPaths covers docs/design/*.md — intersects contract pattern docs/design/*_plan_commit.md.
      // Exemption does NOT apply (requirementDoc missing ⇒ getStageDeliverableExemptions returns []).
      const result = await checkDispatchConflicts(
        "develop",
        meta,
        ["docs/design/*.md"],
        ["docs/design/plan_commit.md"],
        () => ({ mode: "blocked" }),
        () => "nothing",
      );
      expect(result).not.toBeNull();
      expect(result?.blocked).toBe(true);
      expect(result?.conflictType).toBe("readonly_write");
      expect(result?.report).toContain("Configuration conflict");
      expect(result?.report).toContain("stage 'develop'");
      expect(result?.report).toContain("Next step");
    });

    test("conflict i: requirementDoc missing + read-only does NOT hit contract pattern ⇒ pass", async () => {
      const meta = {
        currentStage: "fix",
      } as SessionMeta;
      // allowedReadOnlyPaths only covers src/** — no intersection with docs/design/*_plan_commit.md.
      const result = await checkDispatchConflicts(
        "fix",
        meta,
        ["src/**/*.ts"],
        ["docs/design/plan_commit.md"],
        () => ({ mode: "ordinary" }),
        () => "full write",
      );
      expect(result).toBeNull();
    });
  });
});
