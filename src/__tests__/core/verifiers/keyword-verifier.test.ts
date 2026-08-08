import { describe, it, expect } from "bun:test";
import { verifyRequiredKeywords } from "../../../core/verifiers/keyword-verifier";

describe("verifyRequiredKeywords", () => {
  it("AND mode: all keywords found → pass", () => {
    const result = verifyRequiredKeywords(
      ["hello", "world"],
      "and",
      ["hello world"],
    );
    expect(result.passed).toBe(true);
  });

  it("AND mode: partial keywords → fail", () => {
    const result = verifyRequiredKeywords(
      ["hello", "world", "missing"],
      "and",
      ["hello world"],
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("missing");
  });

  it("OR mode: any keyword found → pass", () => {
    const result = verifyRequiredKeywords(
      ["hello", "world"],
      "or",
      ["just hello"],
    );
    expect(result.passed).toBe(true);
  });

  it("OR mode: no keyword found → fail", () => {
    const result = verifyRequiredKeywords(
      ["hello", "world"],
      "or",
      ["nothing here"],
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("No keywords found");
  });

  it("passes with undefined or empty keywords", () => {
    expect(verifyRequiredKeywords(undefined, "and", ["test"]).passed).toBe(true);
    expect(verifyRequiredKeywords([], "and", ["test"]).passed).toBe(true);
  });

  it("aggregates multiple messages", () => {
    const result = verifyRequiredKeywords(
      ["start"],
      "or",
      ["msg1", "msg2 start msg3"],
    );
    expect(result.passed).toBe(true);
  });
});
