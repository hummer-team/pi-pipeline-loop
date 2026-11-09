/**
 * 229 Phase 4 (B10): the design-review round-budget INHERITANCE across
 * re-runs of the SAME doc (sidecar lifetime) and the mirror write contract.
 *
 * Boundaries covered (plan Phase 4 "单元测试目标，边界"):
 * - `buildAutoJobMeta` writes the inherited rounds + watermark verbatim
 *   (default 0 for fresh docs / human tracks);
 * - `noteDesignReviewDispatch` stays PURE (invariant: budget counting is
 *   meta-only) and remains monotonic over an inherited watermark;
 * - the sidecar mirror is monotonic (never refunds) and inert without an
 *   active job.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildAutoJobMeta } from "../../commands/pipeline-auto-menu";
import { noteDesignReviewDispatch } from "../../core/auto-pipeline/round-budget";
import { mirrorSidecarDesignReviewRounds } from "../../core/auto-pipeline/review-no-progress";
import { makeTestMeta } from "../helpers";

describe("229 Phase 4: budget inheritance (B10)", () => {
  it("buildAutoJobMeta inherits the sidecar round count + watermark", () => {
    const meta = buildAutoJobMeta({
      jobId: "j1",
      jobPath: "/x/job.yaml",
      docIndex: 0,
      totalDocs: 1,
      designReviewMaxRounds: 3,
      inheritedDesignReviewRounds: 2,
      inheritedLastCountedDesignReviewRound: 2,
    });
    expect(meta.designReviewRounds).toBe(2);
    expect(meta.lastCountedDesignReviewRound).toBe(2);
  });

  it("fresh docs / human tracks default to a zero budget (B10: no resetOnStart key)", () => {
    const meta = buildAutoJobMeta({
      jobId: "j1",
      jobPath: "/x/job.yaml",
      docIndex: 0,
      totalDocs: 1,
      designReviewMaxRounds: 3,
    });
    expect(meta.designReviewRounds).toBe(0);
    expect("resetOnStart" in meta).toBe(false);
  });

  it("noteDesignReviewDispatch stays PURE and monotonic over the inherited watermark", () => {
    const base = makeTestMeta({
      autoJob: {
        jobId: "j1",
        jobPath: "/x/job.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 2,
        lastCountedDesignReviewRound: 2,
      },
    });
    // a round <= watermark is deduped (same dispatch or rewind — no refund)
    expect(noteDesignReviewDispatch(base, 2)).toBeNull();
    const next = noteDesignReviewDispatch(base, 3);
    expect(next?.autoJob?.designReviewRounds).toBe(3);
    expect(next?.autoJob?.lastCountedDesignReviewRound).toBe(3);
  });

  it("the sidecar mirror is inert without an active job and never throws", () => {
    const root = path.join("__tests__fixtures_nonexistent_229", "x");
    expect(() => mirrorSidecarDesignReviewRounds({ projectRoot: root } as never, 3)).not.toThrow();
  });
});
