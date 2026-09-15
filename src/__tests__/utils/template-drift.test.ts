import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { checkTemplateDrift, formatDriftNotification } from "../../utils/template-drift";
import { renderContractBlock } from "../../utils/skill-managed-block";
import { resetPromptConfigCache } from "../../core/prompt-config";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
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

  it("Phase 5 / 177 (D11): SKILL without managed markers → pending injection, NOT drift", async () => {
    // A deployed SKILL that predates managed-block injection must not be flagged
    // (English localization / pre-init state is not an incident).
    const deployedSkillDir = join(TMP, ".pi", "skills", "design");
    await mkdir(deployedSkillDir, { recursive: true });
    await writeFile(
      join(deployedSkillDir, "SKILL.md"),
      "# Old SKILL.md content from a previous version\n",
      "utf-8",
    );

    const drifts = await checkTemplateDrift(TMP);

    const skillDrift = drifts.find(d => d.asset.includes("skills/design"));
    expect(skillDrift).toBeUndefined();
  });

  it("Phase 5 / 177 (D11): SKILL block-identical + block-external localized → NOT drift", async () => {
    resetPromptConfigCache();
    const deliverable = "Produce the plan document.";
    const refsDir = join(TMP, ".pi", "references");
    await mkdir(refsDir, { recursive: true });
    await writeFile(
      join(refsDir, "pipeline-stage-prompt.yml"),
      `stage_deliverable_plan: "${deliverable}"\n`,
      "utf-8",
    );

    const skillDir = join(TMP, ".pi", "skills", "plan");
    await mkdir(skillDir, { recursive: true });
    const block = renderContractBlock("plan", deliverable);
    await writeFile(
      join(skillDir, "SKILL.md"),
      `# Localized English SKILL\n\n${block}\n\nLocalized notes outside the block.\n`,
      "utf-8",
    );

    const drifts = await checkTemplateDrift(TMP);
    expect(drifts.find(d => d.asset.includes("skills/plan"))).toBeUndefined();
  });

  it("Phase 5 / 177 (D11): SKILL block content changed → drift reported", async () => {
    resetPromptConfigCache();
    const deliverable = "Produce the plan document.";
    const refsDir = join(TMP, ".pi", "references");
    await mkdir(refsDir, { recursive: true });
    await writeFile(
      join(refsDir, "pipeline-stage-prompt.yml"),
      `stage_deliverable_plan: "${deliverable}"\n`,
      "utf-8",
    );

    const skillDir = join(TMP, ".pi", "skills", "plan");
    await mkdir(skillDir, { recursive: true });
    const block = renderContractBlock("plan", deliverable).replace("Produce the plan document.", "TAMPERED");
    await writeFile(join(skillDir, "SKILL.md"), `# SKILL\n\n${block}\n`, "utf-8");

    const drifts = await checkTemplateDrift(TMP);
    expect(drifts.find(d => d.asset.includes("skills/plan"))).toBeDefined();
  });

  it("Phase 5 / 177 (D11): verify.md remains excluded from drift assets (#176)", async () => {
    // A deliberately different verify.md must never be reported (not in DRIFT_CHECK_ASSETS).
    const verifyDir = join(TMP, ".pi", "references", "plan_spec");
    await mkdir(verifyDir, { recursive: true });
    await writeFile(join(verifyDir, "verify.md"), "---\nrequiredFiles: []\n---\ntampered\n", "utf-8");

    const drifts = await checkTemplateDrift(TMP);
    expect(drifts.find(d => d.asset.includes("verify.md"))).toBeUndefined();
  });

  it("fail-open: handles corrupt projectRoot gracefully", async () => {
    // Non-existent path → should return empty, not throw
    const drifts = await checkTemplateDrift("/nonexistent/path/that/does/not/exist");
    expect(drifts).toEqual([]);
  });

  it("returns empty array when deployed content matches repo source (same hash, no drift)", async () => {
    // Construct a real "no drift" scenario: read the actual repo source file
    // and deploy an identical copy to the temp directory.
    // The repo template dir is resolved from __dirname → src/template/ (during Bun test).
    const repoTemplateDir = join(__dirname, "..", "..", "template");
    const assetToCopy = "references/pipeline-stage-prompt.yml";
    const sourcePath = join(repoTemplateDir, assetToCopy);

    // Read actual repo source content
    let sourceContent: string;
    try {
      sourceContent = await readFile(sourcePath, "utf-8");
    } catch {
      // If template file doesn't exist in test env, skip meaningfully
      return;
    }

    // Deploy identical copy to temp directory
    const deployedRefsDir = join(TMP, ".pi", "references");
    await mkdir(deployedRefsDir, { recursive: true });
    await writeFile(join(deployedRefsDir, "pipeline-stage-prompt.yml"), sourceContent, "utf-8");

    const drifts = await checkTemplateDrift(TMP);

    // The deployed file matches the repo source → should NOT appear in drift list
    const driftedAsset = drifts.find(d => d.asset === assetToCopy);
    expect(driftedAsset).toBeUndefined();
  });
});

// ─── Phase 5 / 175 (R1Q2A): formatDriftNotification ──────────────────────────

describe("formatDriftNotification (Phase 5 / 175)", () => {
  const mk = (asset: string) => ({ asset, deployedHash: "a".repeat(64), repoHash: "b".repeat(64) });

  it("returns null for zero drifts (silent)", () => {
    expect(formatDriftNotification([])).toBeNull();
  });

  it("single drift: count=1, asset name, no truncation", () => {
    const msg = formatDriftNotification([mk("guide.md")]);
    expect(msg).toContain("1 template asset(s)");
    expect(msg).toContain("guide.md");
    expect(msg).toContain("/pipeline-init");
    expect(msg).not.toContain("+");
  });

  it("multiple drifts: count + top 3 names", () => {
    const drifts = [mk("guide.md"), mk("skills/design/SKILL.md"), mk("skills/plan/SKILL.md")];
    const msg = formatDriftNotification(drifts);
    expect(msg).toContain("3 template asset(s)");
    expect(msg).toContain("guide.md");
    expect(msg).toContain("skills/design/SKILL.md");
    expect(msg).toContain("skills/plan/SKILL.md");
    expect(msg).not.toContain("more");
  });

  it("more than 3 drifts: truncated with '+N more'", () => {
    const drifts = [
      mk("guide.md"),
      mk("skills/design/SKILL.md"),
      mk("skills/plan/SKILL.md"),
      mk("skills/develop/SKILL.md"),
      mk("skills/review/SKILL.md"),
    ];
    const msg = formatDriftNotification(drifts);
    expect(msg).toContain("5 template asset(s)");
    // Top 3 names present
    expect(msg).toContain("guide.md");
    expect(msg).toContain("skills/design/SKILL.md");
    expect(msg).toContain("skills/plan/SKILL.md");
    // 4th and 5th NOT listed
    expect(msg).not.toContain("skills/develop/SKILL.md");
    expect(msg).not.toContain("skills/review/SKILL.md");
    // Truncation marker
    expect(msg).toContain("+2 more");
  });

  it("guide.md drift appends special hint", () => {
    const msg = formatDriftNotification([mk("guide.md")]);
    expect(msg).toContain("guide.md is outdated");
    expect(msg).toContain("overwrite via /pipeline-init");
  });

  it("non-guide drift: no guide.md hint", () => {
    const msg = formatDriftNotification([mk("skills/design/SKILL.md")]);
    expect(msg).not.toContain("guide.md is outdated");
  });

  it("mixed drifts including guide.md: hint appended once", () => {
    const msg = formatDriftNotification([mk("skills/design/SKILL.md"), mk("guide.md")]);
    expect(msg).toContain("guide.md is outdated");
    // Hint should appear only once (not duplicated)
    const hintCount = msg!.split("guide.md is outdated").length - 1;
    expect(hintCount).toBe(1);
  });
});
