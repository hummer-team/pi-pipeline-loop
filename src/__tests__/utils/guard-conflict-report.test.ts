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
      const report = describeEmptyWriteScopeConflict("develop", "nothing (blocked by design-review)");
      expect(report).toContain("stage 'develop'");
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

    test("detects readonly-write conflict when deliverable path blocked", async () => {
      const meta = {
        currentStage: "develop",
        requirementDoc: "plan.md",
      } as SessionMeta;
      // resolveCommitDocPath("plan") returns "docs/design/plan_commit.md"
      // readOnlyPaths matches it via glob pattern
      const result = await checkDispatchConflicts(
        "develop",
        meta,
        ["docs/design/*.md"],
        ["docs/design/plan_commit.md"],
        () => ({ mode: "ordinary" }),
        (_p) => _p.mode === "ordinary" ? "full write" : "nothing",
      );
      expect(result).not.toBeNull();
      expect(result?.conflictType).toBe("readonly_write");
      expect(result?.report).toContain("Configuration conflict");
    });

    test("detects empty-write-scope conflict", async () => {
      const meta = {
        currentStage: "develop",
        requirementDoc: "plan.md",
      } as SessionMeta;
      const result = await checkDispatchConflicts(
        "develop",
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

    test("no conflict when requirementDoc missing", async () => {
      const meta = {
        currentStage: "develop",
      } as SessionMeta;
      const result = await checkDispatchConflicts(
        "develop",
        meta,
        ["docs/design/*.md"],
        ["docs/design/plan_commit.md"],
        () => ({ mode: "blocked" }),
        () => "nothing",
      );
      expect(result).toBeNull();
    });
  });
});
