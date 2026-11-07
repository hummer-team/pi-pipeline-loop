/**
 * 220 Phase 1 (D1/D6): the clarify round stamp.
 *
 * Key behaviors:
 * - `maxRounds` is the TOTAL allowance (`maxRounds: 1` still allows one round).
 * - 226 Phase 2: EVERY finite round counts — a repeated or rewound round is a
 *   REAL re-dispatch and consumes budget (`lastRound` keeps the max).
 */
import { describe, it, expect } from "bun:test";
import {
  isClarifyRoundBudgetExhausted,
  noteClarifyRoundDispatch,
  type ClarifyRoundStamp,
} from "../../core/auto-pipeline/clarify-round-budget";

const EMPTY: ClarifyRoundStamp = { usedRounds: 0, lastRound: undefined, lastDispatchedAt: undefined };

describe("isClarifyRoundBudgetExhausted", () => {
  it("maxRounds 0 / negative → never exhausted", () => {
    expect(isClarifyRoundBudgetExhausted(9, 0)).toBe(false);
    expect(isClarifyRoundBudgetExhausted(9, -1)).toBe(false);
  });

  it("first round of maxRounds=1 is still allowed", () => {
    expect(isClarifyRoundBudgetExhausted(0, 1)).toBe(false);
    expect(isClarifyRoundBudgetExhausted(1, 1)).toBe(true);
  });

  it("maxRounds=5 is exhausted at 5", () => {
    expect(isClarifyRoundBudgetExhausted(4, 5)).toBe(false);
    expect(isClarifyRoundBudgetExhausted(5, 5)).toBe(true);
  });
});

describe("noteClarifyRoundDispatch", () => {
  it("first dispatch increments and records round + time", () => {
    expect(noteClarifyRoundDispatch(EMPTY, 1, 500)).toEqual({
      usedRounds: 1,
      lastRound: 1,
      lastDispatchedAt: 500,
    });
  });

  it("the same round twice counts TWICE (226: dispatch-charge semantics)", () => {
    const stamp = noteClarifyRoundDispatch(EMPTY, 1, 500);
    expect(noteClarifyRoundDispatch(stamp, 1, 900)).toEqual({
      usedRounds: 2,
      lastRound: 1,
      lastDispatchedAt: 900,
    });
  });

  it("a rewound round consumes budget; the highest round number is kept", () => {
    const stamp = noteClarifyRoundDispatch(noteClarifyRoundDispatch(EMPTY, 3, 500), 2, 900);
    expect(stamp.usedRounds).toBe(2);
    expect(stamp.lastRound).toBe(3);
    expect(stamp.lastDispatchedAt).toBe(900);
  });

  it("a higher round increments and moves the timestamp", () => {
    const stamp = noteClarifyRoundDispatch(noteClarifyRoundDispatch(EMPTY, 1, 500), 2, 900);
    expect(stamp).toEqual({ usedRounds: 2, lastRound: 2, lastDispatchedAt: 900 });
  });

  it("non-finite rounds are ignored", () => {
    expect(noteClarifyRoundDispatch(EMPTY, Number.NaN, 500)).toBe(EMPTY);
  });
});
