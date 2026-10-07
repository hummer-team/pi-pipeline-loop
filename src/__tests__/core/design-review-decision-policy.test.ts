/**
 * 193 Phase 2 (Unit Tests Core): the PURE FAIL/PASS routing policy.
 *
 * Locked semantics verified here (NO I/O, NO state):
 * - trusted complete PASS auto-advances in ALL modes;
 * - valid FAIL in auto mode routes to the authorized plan revision;
 * - valid FAIL in manual mode requires the human decision;
 * - valid FAIL in smart mode follows ONLY the binary report decision
 *   (revise-plan | request-human) — smart never releases development;
 * - invalid verdicts and a smart FAIL WITHOUT a usable decision field are
 *   correction-only (`invalid` route) — never develop, never silent revise.
 */

import { describe, it, expect } from "bun:test";
import {
  DESIGN_REVIEW_ROUTE_ACTIONS,
  decideDesignReviewRoute,
} from "../../core/design-review/decision-policy";

describe("193 Phase 2: decideDesignReviewRoute (pure policy)", () => {
  it("exposes the exhaustive route vocabulary", () => {
    expect([...DESIGN_REVIEW_ROUTE_ACTIONS]).toEqual([
      "pass-develop",
      "revise-plan",
      "request-human",
      "invalid",
    ]);
  });

  describe("trusted PASS — auto-develop in every mode", () => {
    for (const mode of ["auto", "manual", "smart"] as const) {
      it(`${mode} mode PASS routes to pass-develop`, () => {
        expect(decideDesignReviewRoute({ mode, verdict: "pass" })).toBe("pass-develop");
      });
    }

    it("a stray smart decision field cannot downgrade a PASS", () => {
      expect(
        decideDesignReviewRoute({ mode: "smart", verdict: "pass", smartAction: "request-human" }),
      ).toBe("pass-develop");
    });
  });

  describe("valid FAIL — mode decides who may act", () => {
    it("auto FAIL routes to the authorized plan revision", () => {
      expect(decideDesignReviewRoute({ mode: "auto", verdict: "fail" })).toBe("revise-plan");
    });

    it("manual FAIL requires the human decision menu", () => {
      expect(decideDesignReviewRoute({ mode: "manual", verdict: "fail" })).toBe("request-human");
    });

    it("smart FAIL with revise-plan self-revises (no human needed)", () => {
      expect(
        decideDesignReviewRoute({ mode: "smart", verdict: "fail", smartAction: "revise-plan" }),
      ).toBe("revise-plan");
    });

    it("smart FAIL with request-human asks the human", () => {
      expect(
        decideDesignReviewRoute({ mode: "smart", verdict: "fail", smartAction: "request-human" }),
      ).toBe("request-human");
    });

    it("smart FAIL WITHOUT the binary decision degrades to correction-only", () => {
      // The Phase-1 contract gate rejects such reports as invalid already;
      // the policy stays defensive: NEVER auto-revise and NEVER release.
      expect(decideDesignReviewRoute({ mode: "smart", verdict: "fail" })).toBe("invalid");
    });
  });

  describe("invalid verdicts never route", () => {
    for (const mode of ["auto", "manual", "smart"] as const) {
      it(`${mode} mode invalid is correction-only`, () => {
        expect(decideDesignReviewRoute({ mode, verdict: "invalid" })).toBe("invalid");
      });
    }

    it("an unknown verdict value is correction-only too (defensive default)", () => {
      expect(
        decideDesignReviewRoute({ mode: "auto", verdict: "unknown-as-verdict" as never }),
      ).toBe("invalid");
    });

    it("an unknown mode with FAIL is correction-only (no implicit auto-revise)", () => {
      expect(
        decideDesignReviewRoute({ mode: "yolo" as never, verdict: "fail", smartAction: "revise-plan" }),
      ).toBe("invalid");
    });
  });
});
