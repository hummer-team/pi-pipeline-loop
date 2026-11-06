/**
 * 225 Phase 2 (T4): the single `stage → target document` resolver.
 *
 * Contract points:
 * - the D4 mapping table (plan/develop → plan doc; review → commit doc;
 *   fix → THIS round's review report; others → requirement doc);
 * - fix reads the round from `meta.reviewRound` even when the caller passes
 *   NO argument (the original incident's fix point);
 * - the requirement fallback fires ONLY when the ledger entry is truly absent,
 *   with a `stage_target_doc_fallback` audit (reason=no-review-round);
 * - with a ledger entry the fix path NEVER silently degrades to the requirement;
 * - configured `docs.designDir` / `docs.reviewDir` are honoured;
 * - no requirementDoc → null path, no throw.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolveStageTargetDoc } from "../../utils/stage-target-doc";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { ReviewRoundState, SessionMeta, PipelineConfig } from "../../types";

const audits: { event: string; fields: Record<string, string | boolean> }[] = [];

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  audits.length = 0;
});

function installAuditCapture(): void {
  audits.length = 0;
  __setSafeWriteAuditLogOverride((stage: string, payload?: Record<string, string | boolean>) => {
    audits.push({ event: stage, fields: (payload ?? {}) as Record<string, string | boolean> });
    return Promise.resolve();
  });
}

const ROUND2: ReviewRoundState = {
  index: 2,
  stageStartTime: 9000,
  enteredAt: 8800,
  pipelineId: "pipe-test-001",
};

function metaFor(stage: SessionMeta["currentStage"], overrides?: Partial<SessionMeta>): SessionMeta {
  return makeTestMeta({
    currentStage: stage,
    requirementDoc: "docs/design/225_Bug.md",
    ...overrides,
  });
}

describe("resolveStageTargetDoc — D4 mapping", () => {
  it("plan → requirement-dir's `{reqBase}_Plan.md` (source plan-doc)", async () => {
    const target = await resolveStageTargetDoc(makeTestConfig(), metaFor("plan"));
    expect(target).toEqual({ path: "docs/design/225_Bug_Plan.md", source: "plan-doc" });
  });

  it("develop → the same plan doc (the loop stage edits the plan's implementation)", async () => {
    const target = await resolveStageTargetDoc(makeTestConfig(), metaFor("develop"));
    expect(target.source).toBe("plan-doc");
    expect(target.path).toBe("docs/design/225_Bug_Plan.md");
  });

  it("review → the design-dir commit doc (source commit-doc)", async () => {
    const target = await resolveStageTargetDoc(makeTestConfig(), metaFor("review"));
    expect(target.path).toBe("docs/design/225_Bug_Develop_Commit.md");
    expect(target.source).toBe("commit-doc");
  });

  it("fix reads `meta.reviewRound` even when the caller passes NO argument", async () => {
    const meta = metaFor("fix", { reviewRound: ROUND2 });
    const target = await resolveStageTargetDoc(makeTestConfig(), meta);
    expect(target).toEqual({
      path: "docs/review/Code_Review_225_Bug_Develop_Commit_2.md",
      source: "review-report",
      round: 2,
    });
  });

  it("fix with an explicit reviewRound still trusts meta when opts are absent (no recap requirement)", async () => {
    // caller forwards the just-allocated round for REVIEW; the FIX path relies on meta.
    const meta = metaFor("fix", { reviewRound: ROUND2 });
    const target = await resolveStageTargetDoc(makeTestConfig(), meta, { reviewRound: ROUND2 });
    expect(target.path).toBe("docs/review/Code_Review_225_Bug_Develop_Commit_2.md");
  });

  it("fix without a ledger entry → requirement fallback + stage_target_doc_fallback audit", async () => {
    installAuditCapture();
    const target = await resolveStageTargetDoc(makeTestConfig(), metaFor("fix"));
    expect(target).toEqual({
      path: "docs/design/225_Bug.md",
      source: "requirement",
    });
    const audit = audits.find((a) => a.event === "stage_target_doc_fallback");
    expect(audit?.fields.reason).toBe("no-review-round");
    expect(audit?.fields.stage).toBe("fix");
  });

  it("a ledger entry exists but for ANOTHER stage visit → still used by fix (no requirement fallback)", async () => {
    installAuditCapture();
    // The fix visit has its own stageStartTime; the fixture mirrors production
    // (round.stageStartTime points AT the review visit, fix never checks that).
    const meta = metaFor("fix", { stageStartTime: 12000, reviewRound: ROUND2 });
    const target = await resolveStageTargetDoc(makeTestConfig(), meta);
    expect(target.source).toBe("review-report");
    expect(audits).toHaveLength(0);
  });

  it("non-target stages (clarify / awaiting_human) keep the requirement doc", async () => {
    for (const stage of ["clarify", "awaiting_human", "completed"] as const) {
      const target = await resolveStageTargetDoc(makeTestConfig(), metaFor(stage));
      expect(target).toEqual({ path: "docs/design/225_Bug.md", source: "requirement" });
    }
  });

  it("no requirementDoc → null path (no throw, no audit)", async () => {
    installAuditCapture();
    for (const stage of ["plan", "review", "fix"] as const) {
      const target = await resolveStageTargetDoc(makeTestConfig(), metaFor(stage, { requirementDoc: undefined }));
      expect(target.source).toBe("requirement");
      expect(target.path).toBeNull();
    }
    // Missing requirementDoc is an ABSENCE, not a fallback — audited nowhere.
    expect(audits.filter((a) => a.event === "stage_target_doc_fallback").length).toBe(0);
  });

  it("configured docs.designDir / docs.reviewDir are honoured", async () => {
    const config: PipelineConfig = makeTestConfig();
    (config as unknown as Record<string, unknown>).docsDirs = { designDir: "spec/design", reviewDir: "spec/rev" };
    const reviewTarget = await resolveStageTargetDoc(config, metaFor("review"));
    expect(reviewTarget.path).toBe("spec/design/225_Bug_Develop_Commit.md");
    const fixTarget = await resolveStageTargetDoc(config, metaFor("fix", { reviewRound: ROUND2 }));
    expect(fixTarget.path).toBe("spec/rev/Code_Review_225_Bug_Develop_Commit_2.md");
  });
});
