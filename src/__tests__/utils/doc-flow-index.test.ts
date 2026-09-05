import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { scanAuditFlows } from "../../utils/doc-flow-index";
import { makeTestMeta } from "../helpers";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("scanAuditFlows", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = join(tmpdir(), "pi-dfi-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    await mkdir(TMP, { recursive: true });
  });

  it("returns empty when auditDir does not exist", async () => {
    const result = await scanAuditFlows(TMP, ".pi/audit", "docs/spec.md");
    expect(result).toEqual([]);
  });

  it("returns empty when no pipe-* directories exist", async () => {
    await mkdir(join(TMP, ".pi", "audit"), { recursive: true });
    const result = await scanAuditFlows(TMP, ".pi/audit", "docs/spec.md");
    expect(result).toEqual([]);
  });

  it("returns aborted flow matching same doc", async () => {
    const auditDir = join(TMP, ".pi", "audit", "pipe-test-1");
    await mkdir(auditDir, { recursive: true });
    const meta = makeTestMeta({
      currentStage: "plan",
      pipelineId: "pipe-test-1",
      flowState: "aborted",
      requirementDoc: "docs/design/82_Feat.md",
      stageStartTime: 1000,
    });
    await writeFile(join(auditDir, "meta.json"), JSON.stringify(meta));

    const result = await scanAuditFlows(TMP, ".pi/audit", "docs/design/82_Feat.md");
    expect(result.length).toBe(1);
    expect(result[0].pipelineId).toBe("pipe-test-1");
    expect(result[0].stage).toBe("plan");
    expect(result[0].flowState).toBe("aborted");
  });

  it("excludes completed and awaiting_human flows", async () => {
    // Completed
    const dir1 = join(TMP, ".pi", "audit", "pipe-completed");
    await mkdir(dir1, { recursive: true });
    await writeFile(join(dir1, "meta.json"), JSON.stringify(makeTestMeta({
      currentStage: "completed",
      pipelineId: "pipe-completed",
      flowState: "running",
      requirementDoc: "docs/spec.md",
    })));

    // awaiting_human
    const dir2 = join(TMP, ".pi", "audit", "pipe-awaiting");
    await mkdir(dir2, { recursive: true });
    await writeFile(join(dir2, "meta.json"), JSON.stringify(makeTestMeta({
      currentStage: "awaiting_human",
      pipelineId: "pipe-awaiting",
      flowState: "running",
      requirementDoc: "docs/spec.md",
    })));

    const result = await scanAuditFlows(TMP, ".pi/audit", "docs/spec.md");
    expect(result.length).toBe(0);
  });

  it("excludes flows with different requirementDoc", async () => {
    const dir = join(TMP, ".pi", "audit", "pipe-other-doc");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), JSON.stringify(makeTestMeta({
      currentStage: "plan",
      pipelineId: "pipe-other-doc",
      flowState: "aborted",
      requirementDoc: "docs/other.md",
    })));

    const result = await scanAuditFlows(TMP, ".pi/audit", "docs/spec.md");
    expect(result.length).toBe(0);
  });

  it("sorts by stageStartTime descending (newest first)", async () => {
    const dir1 = join(TMP, ".pi", "audit", "pipe-old");
    await mkdir(dir1, { recursive: true });
    await writeFile(join(dir1, "meta.json"), JSON.stringify(makeTestMeta({
      currentStage: "clarify",
      pipelineId: "pipe-old",
      flowState: "aborted",
      requirementDoc: "docs/spec.md",
      stageStartTime: 1000,
    })));

    const dir2 = join(TMP, ".pi", "audit", "pipe-new");
    await mkdir(dir2, { recursive: true });
    await writeFile(join(dir2, "meta.json"), JSON.stringify(makeTestMeta({
      currentStage: "plan",
      pipelineId: "pipe-new",
      flowState: "aborted",
      requirementDoc: "docs/spec.md",
      stageStartTime: 5000,
    })));

    const result = await scanAuditFlows(TMP, ".pi/audit", "docs/spec.md");
    expect(result.length).toBe(2);
    expect(result[0].pipelineId).toBe("pipe-new");
    expect(result[1].pipelineId).toBe("pipe-old");
  });

  it("fail-open: corrupted meta.json is skipped", async () => {
    const dir = join(TMP, ".pi", "audit", "pipe-corrupt");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), "not json{{{");

    const result = await scanAuditFlows(TMP, ".pi/audit", "docs/spec.md");
    expect(result).toEqual([]);
  });

  it("returns empty when docRelPath is empty", async () => {
    const result = await scanAuditFlows(TMP, ".pi/audit", "");
    expect(result).toEqual([]);
  });

  // Cleanup
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });
});
