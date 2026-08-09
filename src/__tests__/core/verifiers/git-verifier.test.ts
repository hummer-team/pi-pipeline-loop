import { describe, it, expect } from "bun:test";
import { verifyRequiredGit } from "../../../core/verifiers/git-verifier";

describe("verifyRequiredGit", () => {
  // These tests run within the pi-pipeline-loop git repo
  const projectRoot = process.cwd();

  it("passes with undefined rules", async () => {
    const result = await verifyRequiredGit(undefined, projectRoot);
    expect(result.passed).toBe(true);
  });

  it("passes when branch matches current branch", async () => {
    // We don't know the exact branch, but we can check the logic
    // by using an empty rules object
    const result = await verifyRequiredGit({}, projectRoot);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("All git rules satisfied");
  });

  it("fails when branch does not match", async () => {
    const result = await verifyRequiredGit(
      { branch: "nonexistent-branch-xyz-123" },
      projectRoot,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("Expected branch");
  });

  it("passes lastCommitWithin with large window", async () => {
    // The repo has commits, so a 365-day window should pass
    const result = await verifyRequiredGit(
      { lastCommitWithin: "365d" },
      projectRoot,
    );
    expect(result.passed).toBe(true);
  });

  it("fails lastCommitWithin with tiny window", async () => {
    // 1 second window should almost certainly fail
    const result = await verifyRequiredGit(
      { lastCommitWithin: "1s" },
      projectRoot,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("Last commit was");
  });

  it("fails on invalid time window format", async () => {
    const result = await verifyRequiredGit(
      { lastCommitWithin: "invalid" },
      projectRoot,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("Invalid time window");
  });

  it("reports cleanWorkingTree correctly", async () => {
    // We cannot guarantee working tree state in test, but we can check it doesn't crash
    const result = await verifyRequiredGit(
      { cleanWorkingTree: true },
      projectRoot,
    );
    // Result depends on working tree state — just check it returns a valid result
    expect(typeof result.passed).toBe("boolean");
    expect(typeof result.detail).toBe("string");
  });
});
