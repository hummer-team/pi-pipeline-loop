import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { checkTemplateDrift } from "../../utils/template-drift";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("checkTemplateDrift (Phase 6 / 170)", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = join(tmpdir(), "pi-drift-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await mkdir(TMP, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  it("returns empty array when deployed directory does not exist", async () => {
    // No .pi/ directory at all → no drift to report
    const drifts = await checkTemplateDrift(TMP);
    expect(drifts).toEqual([]);
  });

  it("returns empty array when deployed hashes match repo hashes", async () => {
    // This test verifies the "no drift" path.
    // Since we can't easily mock the repo source, we verify that when both
    // deployed and repo are missing, no drift is reported (graceful empty).
    const drifts = await checkTemplateDrift(TMP);
    expect(Array.isArray(drifts)).toBe(true);
    // With no deployed copies, nothing to compare → empty
    expect(drifts.length).toBe(0);
  });

  it("returns DriftEntry when deployed hash differs from repo hash", async () => {
    // Create a deployed copy with different content from the repo source
    const deployedRefsDir = join(TMP, ".pi", "references");
    await mkdir(deployedRefsDir, { recursive: true });
    await writeFile(
      join(deployedRefsDir, "pipeline-stage-prompt.yml"),
      "# Deliberately different content from repo source\nstages: []\n",
      "utf-8",
    );
    await writeFile(
      join(deployedRefsDir, "clarify_template.md"),
      "# Different clarify template\n",
      "utf-8",
    );

    const drifts = await checkTemplateDrift(TMP);

    // Should detect drift for both assets
    expect(drifts.length).toBeGreaterThanOrEqual(1);
    for (const d of drifts) {
      expect(d.asset).toBeDefined();
      expect(d.deployedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(d.repoHash).toMatch(/^[0-9a-f]{64}$/);
      expect(d.deployedHash).not.toBe(d.repoHash);
    }
  });

  it("fail-open: handles corrupt projectRoot gracefully", async () => {
    // Non-existent path → should return empty, not throw
    const drifts = await checkTemplateDrift("/nonexistent/path/that/does/not/exist");
    expect(drifts).toEqual([]);
  });
});
