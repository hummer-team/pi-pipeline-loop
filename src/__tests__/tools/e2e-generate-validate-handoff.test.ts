/**
 * Integration test: generate_stage_summary → validate_summary → pipeline_handoff
 *
 * This E2E test verifies that the normal pipeline flow works end-to-end:
 * 1. generate_stage_summary creates a summary with correct hash
 * 2. validate_summary rewrites frontmatter and syncs hash
 * 3. pipeline_handoff succeeds because hash matches disk
 *
 * Also verifies that manual tampering IS detected (hash mismatch blocks handoff).
 *
 * This test was added to prevent the Blocker from recurring:
 * validate_summary rewriting frontmatter without syncing meta.hash
 * caused normal flows to be falsely flagged as "manually modified".
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createGenerateSummary } from "../../tools/generate-summary";
import { createValidateSummary } from "../../tools/validate-summary";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetSharedStateDir } from "../../core/session-state";

let E2E_TMP: string;

function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (m: any) => {
        const merged = { ...meta, ...m };
        updates.push(merged);
        Object.assign(meta, merged);
        return merged;
      },
      setModel: async (_model: string) => {},
    },
    updates,
  };
}

describe("E2E: generate → validate → handoff (143 Phase 2/4 integration)", () => {
  beforeEach(async () => {
    E2E_TMP = join(tmpdir(), `pi-e2e-gvh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(E2E_TMP, { recursive: true });
    __resetAuditDirPath();
    __resetSharedStateDir();
  });

  afterEach(async () => {
    __resetAuditDirPath();
    __resetSharedStateDir();
    await rm(E2E_TMP, { recursive: true, force: true });
  });

  it("normal flow: generate → validate → handoff succeeds", async () => {
    const config = makeTestConfig({ projectRoot: E2E_TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-e2e-001",
    });
    const ctx = createCtx(meta);

    // Step 1: Generate summary
    const generateTool = createGenerateSummary(config);
    const genResult = (await generateTool.execute({
      coreContent: "Develop stage completed successfully",
      constraints: ["All tests pass"],
      pendingItems: [],
      referenceFiles: ["src/index.ts"],
    }, ctx as any)) as any;

    expect(genResult.success).toBe(true);
    expect(genResult.hash).toMatch(/^[a-f0-9]{64}$/);

    // Step 2: Validate summary
    const validateTool = createValidateSummary(config);
    const valResult = (await validateTool.execute({
      stage: "develop",
      isApproved: true,
      comment: "LGTM",
    }, ctx as any)) as any;

    expect(valResult.success).toBe(true);

    // Step 3: Handoff — should succeed because validate synced the hash
    const handoffTool = createPipelineHandoff(config);
    const handoffResult = (await handoffTool.execute({
      nextStage: "review",
    }, ctx as any)) as any;

    expect(handoffResult.success).toBe(true);
    expect(handoffResult.message).toContain("Switched to");
  });

  it("manual tampering after validate: handoff is blocked", async () => {
    const config = makeTestConfig({ projectRoot: E2E_TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-e2e-002",
    });
    const ctx = createCtx(meta);

    // Step 1: Generate
    const generateTool = createGenerateSummary(config);
    const genResult = (await generateTool.execute({
      coreContent: "Develop work",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any)) as any;

    // Step 2: Validate
    const validateTool = createValidateSummary(config);
    await validateTool.execute({
      stage: "develop",
      isApproved: true,
    }, ctx as any);

    // Step 3: Tamper with the summary file (simulate manual edit)
    const currentMeta = ctx.session.getMeta() as any;
    const summaryPath = currentMeta.summaries.develop.path;
    await writeFile(summaryPath, "# TAMPERED\nHuman changed the content", "utf-8");

    // Step 4: Handoff — should be blocked by hash mismatch
    const handoffTool = createPipelineHandoff(config);
    const handoffResult = (await handoffTool.execute({
      nextStage: "review",
    }, ctx as any)) as any;

    expect(handoffResult.success).toBe(false);
    expect(handoffResult.error).toContain("modified manually");
    expect(handoffResult.error).toContain("hash mismatch");
    expect(handoffResult.mismatchedStage).toBe("develop");
  });

  it("generate produces hash that matches disk content", async () => {
    const config = makeTestConfig({ projectRoot: E2E_TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: "pipe-e2e-003",
    });
    const ctx = createCtx(meta);

    const generateTool = createGenerateSummary(config);
    const genResult = (await generateTool.execute({
      coreContent: "Plan output",
      constraints: ["c1"],
      pendingItems: ["p1"],
      referenceFiles: ["f1"],
    }, ctx as any)) as any;

    // Verify recorded hash matches actual file hash
    const fileContent = await readFile(genResult.summaryPath, "utf-8");
    const actualHash = crypto.createHash("sha256").update(fileContent).digest("hex");

    expect(genResult.hash).toBe(actualHash);

    // Verify meta hash matches file hash
    const currentMeta = ctx.session.getMeta() as any;
    expect(currentMeta.summaries.plan.hash).toBe(actualHash);
  });

  it("validate updates hash to match new file content", async () => {
    const config = makeTestConfig({ projectRoot: E2E_TMP });
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "review",
      pipelineId: "pipe-e2e-004",
    });
    const ctx = createCtx(meta);

    // Generate
    const generateTool = createGenerateSummary(config);
    const genResult = (await generateTool.execute({
      coreContent: "Review output",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any)) as any;

    const hashBeforeValidate = genResult.hash;

    // Validate (rewrites frontmatter)
    const validateTool = createValidateSummary(config);
    await validateTool.execute({
      stage: "review",
      isApproved: true,
      comment: "Approved with changes",
    }, ctx as any);

    // Hash should have changed because frontmatter was rewritten
    const currentMeta = ctx.session.getMeta() as any;
    const hashAfterValidate = currentMeta.summaries.review.hash;
    expect(hashAfterValidate).not.toBe(hashBeforeValidate);

    // New hash should match the actual file content
    const fileContent = await readFile(genResult.summaryPath, "utf-8");
    const actualHash = crypto.createHash("sha256").update(fileContent).digest("hex");
    expect(hashAfterValidate).toBe(actualHash);
  });
});
