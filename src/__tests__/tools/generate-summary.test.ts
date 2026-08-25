import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { createGenerateSummary } from "../../tools/generate-summary";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fsSync from "node:fs";
import { initAuditLog, __resetAuditDirPath, getDateAuditFileName } from "../../utils/auditLog";
import { __resetSharedStateDir } from "../../core/session-state";

const TMP = join(tmpdir(), "pi-pipeline-gen-summary-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
});

function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (m: any) => {
        updates.push(m);
        Object.assign(meta, m);
      },
    },
    updates,
  };
}

describe("createGenerateSummary", () => {
  it("creates a tool named 'generate_stage_summary'", () => {
    const tool = createGenerateSummary(makeTestConfig());
    expect(tool.name).toBe("generate_stage_summary");
  });

  it("returns error when no session context", async () => {
    const tool = createGenerateSummary(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("generates summary with frontmatter and body", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "plan", pipelineId: "pipe-gen-1" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    const result = (await tool.execute({
      coreContent: "Core output",
      constraints: ["constraint 1"],
      pendingItems: ["pending 1"],
      referenceFiles: ["file1.ts"],
    }, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(result.summaryPath).toContain("plan.md");
    expect(typeof result.hash).toBe("string");
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes generated_by_model: true in frontmatter", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ pipelineId: "pipe-gbm-1" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    await tool.execute({
      coreContent: "test",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any);

    const summaryPath = join(TMP, ".pi", "audit", "pipe-gbm-1", "develop.md");
    const content = await readFile(summaryPath, "utf-8");
    const fmMatch = content.match(/---\n([\s\S]*?)\n---/);
    const fm = JSON.parse(fmMatch![1]);
    expect(fm.generated_by_model).toBe(true);
  });

  it("updates session metadata with summary reference", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ pipelineId: "pipe-meta-1" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    await tool.execute({
      coreContent: "test",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any);

    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.summaries.develop).toBeDefined();
    expect(lastUpdate.summaries.develop.status).toBe("pending");
  });

  it("writes output to {auditDir}/{pipelineId}/{stage}.md", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ pipelineId: "pipe-path-1", currentStage: "review" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    const result = (await tool.execute({
      coreContent: "test",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any)) as any;

    expect(result.summaryPath).toContain(".pi/audit/pipe-path-1/review.md");
  });
});

// ─── Phase 2 (143): Versioning, commit_ids, token estimation ─────────────────

let VERSIONED_TMP: string;

describe("generate_stage_summary — Phase 2 (143)", () => {
  beforeEach(async () => {
    VERSIONED_TMP = join(tmpdir(), `pi-gen-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(VERSIONED_TMP, { recursive: true });
    __resetAuditDirPath();
    __resetSharedStateDir();
  });

  afterEach(async () => {
    __resetAuditDirPath();
    __resetSharedStateDir();
    await rm(VERSIONED_TMP, { recursive: true, force: true });
  });

  it("first generation writes {stage}.md with version 1", async () => {
    const config = makeTestConfig({ projectRoot: VERSIONED_TMP });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "plan", pipelineId: "pipe-v1-001" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    const result = (await tool.execute({
      coreContent: "first",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(result.version).toBe(1);
    expect(result.summaryPath).toContain("plan.md");
    expect(result.summaryPath).not.toContain("plan-");
    expect(fsSync.existsSync(result.summaryPath)).toBe(true);

    // Frontmatter should NOT contain version field for version 1 (backward compat)
    const content = await readFile(result.summaryPath, "utf-8");
    const fm = JSON.parse(content.match(/---\n([\s\S]*?)\n---/)?.[1] ?? "{}");
    expect(fm.version).toBeUndefined();
  });

  it("second generation writes {stage}-2.md with version 2", async () => {
    const config = makeTestConfig({ projectRoot: VERSIONED_TMP });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "review", pipelineId: "pipe-v2-001" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);

    // First generation
    const r1 = (await tool.execute({
      coreContent: "first review",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any)) as any;
    expect(r1.summaryPath).toContain("review.md");

    // Second generation (loop)
    const r2 = (await tool.execute({
      coreContent: "second review",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any)) as any;

    expect(r2.success).toBe(true);
    expect(r2.version).toBe(2);
    expect(r2.summaryPath).toContain("review-2.md");
    expect(fsSync.existsSync(r2.summaryPath)).toBe(true);

    // Frontmatter should contain version: 2
    const content = await readFile(r2.summaryPath, "utf-8");
    const fm = JSON.parse(content.match(/---\n([\s\S]*?)\n---/)?.[1] ?? "{}");
    expect(fm.version).toBe(2);
  });

  it("third generation writes {stage}-3.md with version 3", async () => {
    const config = makeTestConfig({ projectRoot: VERSIONED_TMP });
    const meta = makeTestMeta({ currentStage: "fix", pipelineId: "pipe-v3-001" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    await tool.execute({ coreContent: "v1", constraints: [], pendingItems: [], referenceFiles: [] }, ctx as any);
    await tool.execute({ coreContent: "v2", constraints: [], pendingItems: [], referenceFiles: [] }, ctx as any);
    const r3 = (await tool.execute({ coreContent: "v3", constraints: [], pendingItems: [], referenceFiles: [] }, ctx as any)) as any;

    expect(r3.version).toBe(3);
    expect(r3.summaryPath).toContain("fix-3.md");
  });

  it("includes commit_ids in frontmatter and body when commitIds provided", async () => {
    const config = makeTestConfig({ projectRoot: VERSIONED_TMP });
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-cid-001" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    const result = (await tool.execute({
      coreContent: "develop work",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
      commitIds: ["abc1234", "def5678"],
    }, ctx as any)) as any;

    const content = await readFile(result.summaryPath, "utf-8");
    expect(content).toContain("commit_ids");
    expect(content).toContain("abc1234");
    expect(content).toContain("def5678");
    expect(content).toContain("## Commit IDs");

    const fm = JSON.parse(content.match(/---\n([\s\S]*?)\n---/)?.[1] ?? "{}");
    expect(fm.commit_ids).toEqual(["abc1234", "def5678"]);
  });

  it("omits Commit IDs section when commitIds not provided", async () => {
    const config = makeTestConfig({ projectRoot: VERSIONED_TMP });
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-noid-001" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    const result = (await tool.execute({
      coreContent: "develop work",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any)) as any;

    const content = await readFile(result.summaryPath, "utf-8");
    expect(content).not.toContain("## Commit IDs");

    const fm = JSON.parse(content.match(/---\n([\s\S]*?)\n---/)?.[1] ?? "{}");
    expect(fm.commit_ids).toBeUndefined();
  });

  it("includes estimated_tokens in frontmatter (>0)", async () => {
    const config = makeTestConfig({ projectRoot: VERSIONED_TMP });
    const meta = makeTestMeta({ currentStage: "plan", pipelineId: "pipe-tok-001" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    const result = (await tool.execute({
      coreContent: "Some content for token estimation that is long enough",
      constraints: ["c1"],
      pendingItems: ["p1"],
      referenceFiles: ["f1"],
    }, ctx as any)) as any;

    expect(result.estimatedTokens).toBeGreaterThan(0);

    const content = await readFile(result.summaryPath, "utf-8");
    const fm = JSON.parse(content.match(/---\n([\s\S]*?)\n---/)?.[1] ?? "{}");
    expect(typeof fm.estimated_tokens).toBe("number");
    expect(fm.estimated_tokens).toBeGreaterThan(0);
  });

  it("writes summary_generated audit log entry", async () => {
    const config = makeTestConfig({ projectRoot: VERSIONED_TMP });
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "plan", pipelineId: "pipe-audit-001" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    await tool.execute({
      coreContent: "test",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any);

    // Wait for async audit log
    await new Promise(r => setTimeout(r, 50));

    const logPath = join(VERSIONED_TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("summary_generated");
    expect(logContent).toContain("stage=plan");
    expect(logContent).toContain("version=1");
    expect(logContent).toContain("estimatedTokens=");
  });

  it("stores version in SummaryMeta via updateMeta", async () => {
    const config = makeTestConfig({ projectRoot: VERSIONED_TMP });
    const meta = makeTestMeta({ currentStage: "review", pipelineId: "pipe-smv-001" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    await tool.execute({ coreContent: "v1", constraints: [], pendingItems: [], referenceFiles: [] }, ctx as any);
    await tool.execute({ coreContent: "v2", constraints: [], pendingItems: [], referenceFiles: [] }, ctx as any);

    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.summaries.review.version).toBe(2);
  });
});
