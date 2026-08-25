import { describe, it, expect } from "bun:test";
import { createValidateSummary } from "../../tools/validate-summary";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";

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

const SAMPLE_FM = {
  stage: "develop",
  pipeline_id: "pipe-test-001",
  generated_at: "2024-01-01T00:00:00.000Z",
  validation_status: "pending",
  hash: "abc",
};

describe("createValidateSummary", () => {
  it("creates a tool named 'validate_summary'", () => {
    const tool = createValidateSummary(makeTestConfig());
    expect(tool.name).toBe("validate_summary");
  });

  it("returns error when no session context", async () => {
    const tool = createValidateSummary(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("returns error when summary not found for stage", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ summaries: {} });
    const ctx = createCtx(meta);

    const tool = createValidateSummary(config);
    const result = (await tool.execute({ stage: "clarify", isApproved: true }, ctx as any)) as any;

    expect(result.error).toContain("No summary found");
  });

  it("approves summary and updates frontmatter", async () => {
    const TMP = join(tmpdir(), "pi-validate-approve-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const summaryPath = join(TMP, "develop-summary.md");
    await writeFile(summaryPath, `---\n${JSON.stringify(SAMPLE_FM)}\n---\n# Body\nContent`);

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      summaries: { develop: { path: summaryPath, hash: "abc", status: "pending" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createValidateSummary(config);
    const result = (await tool.execute({
      stage: "develop", isApproved: true, comment: "Looks good",
    }, ctx as any)) as any;

    expect(result.success).toBe(true);

    const updated = await readFile(summaryPath, "utf-8");
    expect(updated).toContain('"validation_status": "valid"');
  });

  it("rejects summary and updates frontmatter", async () => {
    const TMP = join(tmpdir(), "pi-validate-reject-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const summaryPath = join(TMP, "develop-reject.md");
    await writeFile(summaryPath, `---\n${JSON.stringify(SAMPLE_FM)}\n---\n# Body\nContent`);

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      summaries: { develop: { path: summaryPath, hash: "abc", status: "pending" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createValidateSummary(config);
    await tool.execute({ stage: "develop", isApproved: false }, ctx as any);

    const updated = await readFile(summaryPath, "utf-8");
    expect(updated).toContain('"validation_status": "invalid"');
  });

  it("updates session metadata with validation status", async () => {
    const TMP = join(tmpdir(), "pi-validate-meta-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const summaryPath = join(TMP, "develop-meta.md");
    await writeFile(summaryPath, `---\n${JSON.stringify(SAMPLE_FM)}\n---\n# Body`);

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      summaries: { develop: { path: summaryPath, hash: "abc", status: "pending" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createValidateSummary(config);
    await tool.execute({ stage: "develop", isApproved: true }, ctx as any);

    expect(ctx.updates[ctx.updates.length - 1].summaries.develop.status).toBe("valid");
  });

  it("writes audit log entry for validation", async () => {
    const TMP = join(tmpdir(), "pi-validate-audit-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const summaryPath = join(TMP, "develop-audit.md");
    await writeFile(summaryPath, `---\n${JSON.stringify(SAMPLE_FM)}\n---\n# Body`);

    const config = makeTestConfig({ projectRoot: TMP });
    await initAuditLog(config);
    const meta = makeTestMeta({
      summaries: { develop: { path: summaryPath, hash: "abc", status: "pending" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createValidateSummary(config);
    await tool.execute({ stage: "develop", isApproved: true, comment: "ok" }, ctx as any);

    const logPath = join(TMP, ".pi", "audit", getDateAuditFileName());
    const logContent = await readFile(logPath, "utf-8");
    const line = logContent.trim().split("\n")[0];

    expect(line).toContain(" - [INFO] summary_validated");
    expect(line).toContain("stage=develop");
    expect(line).toContain("approved=true");
    expect(line).toContain("comment=ok");
  });
});

// ─── Phase 2 (143): Versioned summary validation ─────────────────────────────

describe("validate_summary — versioned file (143)", () => {
  it("validates a versioned summary file (review-2.md) and updates frontmatter", async () => {
    const TMP = join(tmpdir(), "pi-validate-versioned-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const summaryPath = join(TMP, "review-2.md");
    const fm = {
      ...SAMPLE_FM,
      stage: "review",
      version: 2,
    };
    await writeFile(summaryPath, `---\n${JSON.stringify(fm)}\n---\n# Review\nBody`);

    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({
      summaries: { review: { path: summaryPath, hash: "abc", status: "pending" as const, version: 2 } },
    });
    const ctx = createCtx(meta);

    const tool = createValidateSummary(config);
    const result = (await tool.execute({
      stage: "review", isApproved: true, comment: "v2 looks good",
    }, ctx as any)) as any;

    expect(result.success).toBe(true);

    const updated = await readFile(summaryPath, "utf-8");
    expect(updated).toContain('"validation_status": "valid"');
    expect(updated).toContain('"version": 2');
  });
});
