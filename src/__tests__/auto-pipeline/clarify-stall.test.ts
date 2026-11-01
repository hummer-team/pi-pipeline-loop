/**
 * 220 Phase 1 (D2): the clarify stall counter.
 *
 * Key behaviors:
 * - Only "same signature AND no growth" counts as a stall.
 * - Document growth always resets (progress is the only proof).
 * - The predicate is disabled by a 0 limit.
 */
import { describe, it, expect } from "bun:test";
import {
  DEFAULT_CLARIFY_STALL_LIMIT,
  isClarifyStalled,
  nextClarifyStallState,
} from "../../core/auto-pipeline/clarify-stall";

describe("nextClarifyStallState", () => {
  it("first observation never counts as a stall", () => {
    expect(nextClarifyStallState(undefined, { signature: "await-answer:1", docLength: 100 })).toEqual({
      stalls: 0,
      signature: "await-answer:1",
      docLength: 100,
    });
  });

  it("two consecutive no-growth observations → stalls 2", () => {
    const first = nextClarifyStallState(undefined, { signature: "s", docLength: 100 });
    const second = nextClarifyStallState(first, { signature: "s", docLength: 100 });
    const third = nextClarifyStallState(second, { signature: "s", docLength: 100 });
    expect(second.stalls).toBe(1);
    expect(third.stalls).toBe(2);
  });

  it("document growth resets the counter", () => {
    const stalled = { stalls: 2, signature: "s", docLength: 100 };
    expect(nextClarifyStallState(stalled, { signature: "s", docLength: 140 }).stalls).toBe(0);
  });

  it("a changed signature resets the counter", () => {
    const stalled = { stalls: 2, signature: "s", docLength: 100 };
    expect(nextClarifyStallState(stalled, { signature: "other", docLength: 90 }).stalls).toBe(0);
  });

  it("a shrinking document is still no progress", () => {
    const stalled = { stalls: 1, signature: "s", docLength: 100 };
    expect(nextClarifyStallState(stalled, { signature: "s", docLength: 80 }).stalls).toBe(2);
  });
});

describe("isClarifyStalled", () => {
  it("default limit is 3", () => {
    expect(DEFAULT_CLARIFY_STALL_LIMIT).toBe(3);
  });

  it("limit reached → stalled", () => {
    expect(isClarifyStalled({ stalls: 2 }, 3)).toBe(false);
    expect(isClarifyStalled({ stalls: 3 }, 3)).toBe(true);
  });

  it("limit 0 disables the judgement", () => {
    expect(isClarifyStalled({ stalls: 99 }, 0)).toBe(false);
  });
});
