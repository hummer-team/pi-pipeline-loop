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

  it("returns empty array when deployed copies are all missing (graceful empty)", async () => {
    // .pi/ exists but no deployed copies → empty (not crash)
    await mkdir(join(TMP, ".pi"), { recursive: true });
    const drifts = await checkTemplateDrift(TMP);
    expect(Array.isArray(drifts)).toBe(true);
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

  it("includes skills in drift check assets (incident root cause)", async () => {
    // Phase 6 (170) fix: .pi/skills/*/SKILL.md must be included in drift detection
    // Create a drifted deployed skill file
    const deployedSkillDir = join(TMP, ".pi", "skills", "design");
    await mkdir(deployedSkillDir, { recursive: true });
    await writeFile(
      join(deployedSkillDir, "SKILL.md"),
      "# Old SKILL.md content from a previous version\n",
      "utf-8",
    );

    const drifts = await checkTemplateDrift(TMP);

    // Should detect drift for the skill file
    const skillDrift = drifts.find(d => d.asset.includes("skills"));
    expect(skillDrift).toBeDefined();
    expect(skillDrift!.asset).toContain("design/SKILL.md");
    expect(skillDrift!.deployedHash).not.toBe(skillDrift!.repoHash);
  });

  it("fail-open: handles corrupt projectRoot gracefully", async () => {
    // Non-existent path → should return empty, not throw
    const drifts = await checkTemplateDrift("/nonexistent/path/that/does/not/exist");
    expect(drifts).toEqual([]);
  });
});
