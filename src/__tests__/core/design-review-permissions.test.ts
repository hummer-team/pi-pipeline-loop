/**
 * @module design-review-permissions.test
 * Phase 4 (191): Test authorization validation permissions.
 * 
 * Verifies:
 * - isAuthorizationValid returns false for undefined state
 * - isAuthorizationValid returns false for "finished" phase
 * - isAuthorizationValid returns false for "paused" phase with "authorization-lost" reason
 * - isAuthorizationValid returns true for all other valid phases
 */

import { describe, it, expect } from "bun:test";
import { isAuthorizationValid } from "../../core/design-review/state";
import type { DesignReviewState, DesignReviewPhase, DesignReviewPauseReason } from "../../types";

function makeValidState(phase: DesignReviewPhase = "review_ready"): DesignReviewState {
  return {
    schemaVersion: 1,
    phase,
    planHash: "abc123",
    planDoc: "/tmp/plan.md",
    round: 1,
    authorizationId: "auth-token-xyz",
    authorizationSource: "menu",
    authorizedAt: Date.now(),
    operation: undefined,
    updatedAt: Date.now(),
  };
}

describe("Phase 4 (191): Authorization validation (isAuthorizationValid)", () => {
  it("returns false for undefined state", () => {
    expect(isAuthorizationValid(undefined)).toBe(false);
  });

  it("returns false when phase is 'finished'", () => {
    const state = makeValidState("finished");
    expect(isAuthorizationValid(state)).toBe(false);
  });

  it("returns false when phase is 'paused' with pauseReason 'authorization-lost'", () => {
    const state = makeValidState("paused");
    state.pauseReason = "authorization-lost";
    expect(isAuthorizationValid(state)).toBe(false);
  });

  it("returns true when phase is 'paused' with other pauseReason", () => {
    const state = makeValidState("paused");
    state.pauseReason = "no-change";
    expect(isAuthorizationValid(state)).toBe(true);
  });

  it("returns true for phase 'review_ready'", () => {
    const state = makeValidState("review_ready");
    expect(isAuthorizationValid(state)).toBe(true);
  });

  it("returns true for phase 'review_running'", () => {
    const state = makeValidState("review_running");
    expect(isAuthorizationValid(state)).toBe(true);
  });

  it("returns true for phase 'update_ready'", () => {
    const state = makeValidState("update_ready");
    expect(isAuthorizationValid(state)).toBe(true);
  });

  it("returns true for phase 'update_running'", () => {
    const state = makeValidState("update_running");
    expect(isAuthorizationValid(state)).toBe(true);
  });

  it("returns true for phase 'pass_ready'", () => {
    const state = makeValidState("pass_ready");
    expect(isAuthorizationValid(state)).toBe(true);
  });

  it("returns true for phase 'paused' with undefined pauseReason", () => {
    const state = makeValidState("paused");
    state.pauseReason = undefined;
    expect(isAuthorizationValid(state)).toBe(true);
  });

  it("returns true for phase 'paused' with undefined pauseReason", () => {
    const state = makeValidState("paused");
    state.pauseReason = undefined;
    expect(isAuthorizationValid(state)).toBe(true);
  });
});
