/**
 * 225 Phase 2 (T2): review round allocation rules.
 *
 * The four priority rules of `allocateReviewRound` plus `ensureReviewRound`
 * persistence semantics: retry/same-visit no-op, /pipeline-start resume
 * continuation (`periodResumedAt` boundaries), cross-pipeline reset, and the
 * same-millisecond identity edge (`stageStartTime` equality wins).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { allocateReviewRound, ensureReviewRound } from "../../utils/review-round";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestMeta } from "../helpers";
import type { ReviewRoundState, SessionMeta } from "../../types";

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

function round1(stageStartTime: number, enteredAt: number): ReviewRoundState {
  return { index: 1, stageStartTime, enteredAt, pipelineId: "pipe-test-001" };
}

function metaWith(overrides: Partial<SessionMeta> & { stageStartTime: number }): SessionMeta {
  return makeTestMeta({ pipelineId: "pipe-test-001", ...overrides });
}

describe("allocateReviewRound — four rules", () => {
  it("rule 1: no ledger entry → round 1 for the current visit", () => {
    const meta = metaWith({ stageStartTime: 1000 });
    expect(allocateReviewRound(meta, 2000)).toEqual({
      index: 1,
      stageStartTime: 1000,
      enteredAt: 2000,
      pipelineId: "pipe-test-001",
    });
  });

  it("rule 2: same stageStartTime → reuse verbatim (retry / decision-menu resume)", () => {
    const meta = metaWith({ stageStartTime: 1000, reviewRound: round1(1000, 900) });
    expect(allocateReviewRound(meta, 3000)).toEqual(round1(1000, 900));
  });

  it("rule 2 (same-ms boundary): an older entry with the SAME clock is reused on the millisecond", () => {
    const meta = metaWith({ stageStartTime: 5000, reviewRound: round1(5000, 4000) });
    expect(allocateReviewRound(meta, 5000).index).toBe(1);
  });

  it("rule 3: /pipeline-start resume (round predates periodResumedAt) → same round continues", () => {
    const meta = metaWith({
      stageStartTime: 9000,
      periodResumedAt: 8000,
      reviewRound: round1(7000, 6000),
    });
    const next = allocateReviewRound(meta, 9500);
    expect(next.index).toBe(1); // same logical round
    expect(next.enteredAt).toBe(6000); // freshness baseline preserved
    expect(next.stageStartTime).toBe(9000); // re-pointed to the new visit clock
  });

  it("rule 3 boundary: entry clock EQUAL to periodResumedAt also continues the round", () => {
    const meta = metaWith({
      stageStartTime: 9000,
      periodResumedAt: 8000,
      reviewRound: round1(8000, 6000),
    });
    expect(allocateReviewRound(meta, 9500).index).toBe(1);
  });

  it("rule 3 boundary: entry clock strictly AFTER periodResumedAt → NEW round (not a resume of it)", () => {
    const meta = metaWith({
      stageStartTime: 9000,
      periodResumedAt: 8000,
      reviewRound: round1(8500, 8600),
    });
    const next = allocateReviewRound(meta, 9500);
    expect(next.index).toBe(2);
    expect(next.enteredAt).toBe(9500);
  });

  it("rule 4: fresh visit with no resume marker → advance to index + 1", () => {
    const meta = metaWith({ stageStartTime: 9000, reviewRound: round1(5000, 4000) });
    const next = allocateReviewRound(meta, 9500);
    expect(next.index).toBe(2);
    expect(next.enteredAt).toBe(9500);
    expect(next.stageStartTime).toBe(9000);
  });

  it("cross-pipeline: a foreign pipelineId resets to round 1", () => {
    const meta = metaWith({ stageStartTime: 9000 });
    meta.reviewRound = { index: 3, stageStartTime: 5000, enteredAt: 4000, pipelineId: "other-pipe" };
    const next = allocateReviewRound(meta, 9500);
    expect(next.index).toBe(1);
    expect(next.pipelineId).toBe("pipe-test-001");
  });
});

describe("allocateReviewRound — explicit re-entry reason (227 review round 4 issue 1)", () => {
  it("reenter inside a /pipeline-start resumed period still advances the round and refreshes enteredAt", () => {
    const meta = metaWith({
      stageStartTime: 9000,
      periodResumedAt: 8000,
      reviewRound: round1(7000, 6000),
    });
    // Rule 3 would continue the round (index 1 / enteredAt 6000) for a normal
    // dispatch; an explicit re-entry must NOT inherit that continuity.
    expect(allocateReviewRound(meta, 9500).index).toBe(1);
    const reentered = allocateReviewRound(meta, 9500, "reenter");
    expect(reentered.index).toBe(2);
    expect(reentered.enteredAt).toBe(9500); // every earlier report is stale now
    expect(reentered.stageStartTime).toBe(9000);
  });

  it("reenter on a same-millisecond clock collision still advances (never reuses verbatim)", () => {
    const meta = metaWith({ stageStartTime: 5000, reviewRound: round1(5000, 4000) });
    expect(allocateReviewRound(meta, 5000).enteredAt).toBe(4000); // rule 2 reuse
    const reentered = allocateReviewRound(meta, 5000, "reenter");
    expect(reentered.index).toBe(2);
    expect(reentered.enteredAt).toBe(5000);
    expect(reentered.stageStartTime).toBe(5000);
  });

  it("reenter keeps the foreign-pipeline reset (round 1)", () => {
    const meta = metaWith({ stageStartTime: 9000 });
    meta.reviewRound = { index: 3, stageStartTime: 5000, enteredAt: 4000, pipelineId: "other-pipe" };
    const reentered = allocateReviewRound(meta, 9500, "reenter");
    expect(reentered.index).toBe(1);
    expect(reentered.pipelineId).toBe("pipe-test-001");
  });
});

describe("ensureReviewRound — persistence semantics", () => {
  it("persists the first allocation and audits review_round_allocated with isNew=true", () => {
    installAuditCapture();
    const meta = metaWith({ stageStartTime: 1000 });
    const session = { updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return true; } };
    const round = ensureReviewRound(meta, session, 2000);
    expect(round.index).toBe(1);
    expect(meta.reviewRound?.index).toBe(1);
    const audit = audits.find((a) => a.event === "review_round_allocated");
    expect(audit?.fields.isNew).toBe("true");
    expect(audit?.fields.index).toBe("1");
  });

  it("a retry (unchanged round) persists nothing and audits nothing", () => {
    installAuditCapture();
    const meta = metaWith({ stageStartTime: 1000, reviewRound: round1(1000, 900) });
    const session = { updateMeta: () => { throw new Error("must not persist an unchanged round"); } };
    const round = ensureReviewRound(meta, session, 3000);
    expect(round.index).toBe(1);
    expect(audits).toHaveLength(0);
  });

  it("advance to the next round persists and audits isNew=true (a new index was born)", () => {
    installAuditCapture();
    const meta = metaWith({ stageStartTime: 9000, reviewRound: round1(5000, 4000) });
    const session = { updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return true; } };
    const priorIndex = meta.reviewRound!.index;
    const next = ensureReviewRound(meta, session, 9500);
    expect(next.index).toBe(2);
    expect(meta.reviewRound?.index).toBe(2);
    expect(priorIndex).toBe(1);
    const audit = audits.find((a) => a.event === "review_round_allocated");
    // isNew = "this allocation born a NEW round index" — true on advance too
    // (false only for same-index continuations, e.g. the resume re-pointing).
    expect(audit?.fields.isNew).toBe("true");
  });

  it("resume continuation (rule 3) re-points the visit clock with isNew=false", () => {
    installAuditCapture();
    const meta = metaWith({
      stageStartTime: 9000,
      periodResumedAt: 8000,
      reviewRound: round1(7000, 6000),
    });
    const session = { updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return true; } };
    const next = ensureReviewRound(meta, session, 9500);
    expect(next.index).toBe(1);
    const audit = audits.find((a) => a.event === "review_round_allocated");
    expect(audit?.fields.isNew).toBe("false");
    expect(audit?.fields.index).toBe("1");
  });

  it("no session → allocates in memory only", () => {
    installAuditCapture();
    const meta = metaWith({ stageStartTime: 1000 });
    const round = ensureReviewRound(meta, undefined, 2000);
    expect(round.index).toBe(1);
    expect(meta.reviewRound).toBeUndefined();
  });

  it("reason `reenter` persists the advanced round and audits isNew=true", () => {
    installAuditCapture();
    const meta = metaWith({
      stageStartTime: 9000,
      periodResumedAt: 8000,
      reviewRound: round1(7000, 6000),
    });
    const session = { updateMeta: (patch: Partial<SessionMeta>) => { Object.assign(meta, patch); return true; } };
    const next = ensureReviewRound(meta, session, 9500, "reenter");
    expect(next.index).toBe(2);
    expect(meta.reviewRound?.index).toBe(2);
    expect(meta.reviewRound?.enteredAt).toBe(9500);
    const audit = audits.find((a) => a.event === "review_round_allocated");
    expect(audit?.fields.isNew).toBe("true");
    expect(audit?.fields.index).toBe("2");
  });
});
