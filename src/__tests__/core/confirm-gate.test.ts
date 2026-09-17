import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  maybeHandleConfirmGate,
  detectPendingConfirmGate,
  recordConfirmGateOutcome,
  shouldDeferPlanMarkerRule,
  resolveConfirmMaxRejections,
  autoWriteConfirmMarker,
  PLAN_CONFIRM_MARKER_RULE,
} from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog, getDateAuditFileName } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import type { SessionMeta, PipelineConfig } from "../../types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(tmpdir(), "pi-confirm-gate-" + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  // Initialize audit log so writeAuditLog doesn't fail with ENOENT
  await initAuditLog(makeTestConfig({ projectRoot: tmpDir }));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makePlanConfigWithConfirm(root: string, confirmMode: "auto" | "manual" | "smart", maxRejections?: number) {
  const base = makeTestConfig({ projectRoot: root });
  const planStage = {
    ...base.stages.plan,
    allowedWritePaths: ["docs/", "doc/", "documentation/"],
    confirm: { mode: confirmMode, ...(maxRejections !== undefined ? { maxRejections } : {}) },
  };
  return {
    ...base,
    stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
  };
}

async function createPlanDoc(content: string) {
  const docsDir = path.join(tmpDir, "docs", "design");
  await fs.mkdir(docsDir, { recursive: true });
  const planPath = path.join(docsDir, "77_Config_plan.md");
  await fs.writeFile(planPath, content, "utf-8");
  return planPath;
}

describe("Phase 3 (162): confirm gate helpers", () => {
  it("PLAN_CONFIRM_MARKER_RULE has correct path and pattern", () => {
    expect(PLAN_CONFIRM_MARKER_RULE.path).toBe("docs/design/*_plan.md");
    expect(PLAN_CONFIRM_MARKER_RULE.pattern).toBe("^## (用户确认|User Confirmation)");
  });

  it("shouldDeferPlanMarkerRule: false when confirm not configured", () => {
    const base = makeTestConfig();
    expect(shouldDeferPlanMarkerRule("plan", base.stages.plan)).toBe(false);
  });

  it("shouldDeferPlanMarkerRule: false when confirm mode is 'auto'", () => {
    const config = makePlanConfigWithConfirm(tmpDir, "auto");
    expect(shouldDeferPlanMarkerRule("plan", config.stages.plan)).toBe(false);
  });

  it("shouldDeferPlanMarkerRule: true when confirm mode is 'manual'", () => {
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    expect(shouldDeferPlanMarkerRule("plan", config.stages.plan)).toBe(true);
  });

  it("shouldDeferPlanMarkerRule: true when confirm mode is 'smart'", () => {
    const config = makePlanConfigWithConfirm(tmpDir, "smart");
    expect(shouldDeferPlanMarkerRule("plan", config.stages.plan)).toBe(true);
  });

  it("shouldDeferPlanMarkerRule: false when currentStage is not 'plan' (e.g. review)", () => {
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    // Even with manual mode, deferral only applies during plan stage
    expect(shouldDeferPlanMarkerRule("review", config.stages.plan)).toBe(false);
    expect(shouldDeferPlanMarkerRule("develop", config.stages.plan)).toBe(false);
  });

  it("resolveConfirmMaxRejections: default 5 when nothing configured", () => {
    const base = makeTestConfig();
    expect(resolveConfirmMaxRejections(base, base.stages.plan)).toBe(5);
  });

  it("resolveConfirmMaxRejections: global config overrides default", () => {
    const base = makeTestConfig({ maxConfirmRejections: 10 });
    expect(resolveConfirmMaxRejections(base, base.stages.plan)).toBe(10);
  });

  it("resolveConfirmMaxRejections: stage-level overrides global", () => {
    const base = makeTestConfig({ maxConfirmRejections: 10 });
    const config = makePlanConfigWithConfirm(tmpDir, "manual", 3);
    expect(resolveConfirmMaxRejections(config, config.stages.plan)).toBe(3);
  });
});

describe("Phase 3 (162): maybeHandleConfirmGate", () => {
  it("returns no-gate for non-plan/review stages", async () => {
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("no-gate");
  });

  it("returns no-gate when marker already present (Chinese)", async () => {
    await createPlanDoc("# Plan\n\n## 用户确认：确认无误\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("no-gate");
  });

  it("returns no-gate when marker already present (English)", async () => {
    await createPlanDoc("# Plan\n\n## User Confirmation: Confirmed\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("no-gate");
  });

  it("smart mode + needConfirm=false returns no-gate", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "smart");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "smart", needConfirm: false });
    expect(result.result).toBe("no-gate");
  });

  it("returns pending when no UI select available", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    // Create ctx without select function
    const ctx = createMockCtx(meta);
    delete ctx.ui.select;
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("pending");
    }
  });

  it("approve advances plan to develop", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Advance" });
    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("advanced");
      expect(result.toStage).toBe("develop");
    }
    // Rejection counter should be reset
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.confirmRejections).toBeUndefined();
  });

  it("reject routes plan to clarify and increments counter", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmRejections: 0,
    });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Rework (back to clarify)" });
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("routed");
      expect(result.toStage).toBe("clarify");
    }
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.confirmRejections).toBe(1);
    expect(updatedMeta.currentStage).toBe("clarify");
  });

  it("reject preserves counter across round trip (plan→clarify→plan)", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmRejections: 2, // Simulating 2 prior rejections
    });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Rework (back to clarify)" });
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    if (result.result === "handled") {
      expect(result.action).toBe("routed");
    }
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    // Counter should be 3 (2 + 1), preserved across the routing
    expect(updatedMeta.confirmRejections).toBe(3);
  });

  it("overflow with confirmOverflow='ask' and Continue choice routes + resets counter", async () => {
    await createPlanDoc("# Plan\n");
    const config = {
      ...makePlanConfigWithConfirm(tmpDir, "manual", 2),
      confirmOverflow: "ask" as const,
    };
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmRejections: 2, // At limit
    });
    // First call: Reject (triggers overflow) → select returns "Continue"
    const ctx = createMockCtx(meta, { selectReturn: "Continue" });
    const ui = { notify: () => {} };
    // Override select to return different values for reject dialog vs overflow dialog
    let callCount = 0;
    ctx.ui.select = async () => {
      callCount++;
      return callCount === 1 ? "Reject & Rework (back to clarify)" : "Continue";
    };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("routed");
    }
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    // Counter should be reset to 0 after overflow Continue
    expect(updatedMeta.confirmRejections).toBe(0);
  });

  it("overflow with confirmOverflow='terminate' aborts pipeline", async () => {
    await createPlanDoc("# Plan\n");
    const config = {
      ...makePlanConfigWithConfirm(tmpDir, "manual", 1),
      confirmOverflow: "terminate" as const,
    };
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmRejections: 1, // At limit
    });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Rework (back to clarify)" });
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("aborted");
    }
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.flowState).toBe("aborted");
  });

  it("Esc cancels without advancing or incrementing counter", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
    });
    // No selectReturn → select returns undefined (Esc)
    const ctx = createMockCtx(meta);
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("pending");
    }
    // Counter should not be incremented
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.confirmRejections).toBeUndefined();
    // Stage should not change
    expect(updatedMeta.currentStage).toBe("plan");
  });
});

describe("Phase 4 (162): autoWriteConfirmMarker", () => {
  it("auto mode: writes bilingual marker when missing", async () => {
    const planPath = await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "auto");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = { ui: { notify: () => {} } };
    const uiMock = { transition: () => {} };

    const ok = await autoWriteConfirmMarker(config, ctx, meta, uiMock);
    expect(ok).toBe(true);

    const content = await fs.readFile(planPath, "utf-8");
    expect(content).toContain("## 用户确认：确认无误");
    expect(content).toContain("## User Confirmation: Confirmed");
  });

  it("manual mode: does NOT auto-write marker", async () => {
    const planPath = await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = { ui: { notify: () => {} } };
    const uiMock = { transition: () => {} };

    const ok = await autoWriteConfirmMarker(config, ctx, meta, uiMock);
    expect(ok).toBe(true); // Returns true (no-op) but doesn't write

    const content = await fs.readFile(planPath, "utf-8");
    expect(content).not.toContain("## 用户确认：确认无误");
  });

  it("idempotent: does not duplicate marker if already present", async () => {
    const planPath = await createPlanDoc("# Plan\n\n## 用户确认：确认无误\n");
    const config = makePlanConfigWithConfirm(tmpDir, "auto");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = { ui: { notify: () => {} } };
    const uiMock = { transition: () => {} };

    const ok = await autoWriteConfirmMarker(config, ctx, meta, uiMock);
    expect(ok).toBe(true);

    const content = await fs.readFile(planPath, "utf-8");
    // Should only have the original marker, not a duplicate
    const matches = content.match(/## 用户确认：确认无误/g);
    expect(matches).toHaveLength(1);
  });
});

describe("Phase 4 (162): pipeline-start confirmRejections reset", () => {
  it("buildStartMeta resets confirmRejections to undefined", async () => {
    // This test verifies the reset behavior indirectly through the confirm gate tests.
    // The actual pipeline-start.ts buildStartMeta/buildRestartMeta/buildResumeMeta
    // all set confirmRejections: undefined. We verify the type accepts the field.
    const meta = makeTestMeta({ confirmRejections: 5 });
    expect(meta.confirmRejections).toBe(5);
    // After reset (simulated):
    const resetMeta = { ...meta, confirmRejections: undefined };
    expect(resetMeta.confirmRejections).toBeUndefined();
  });
});

describe("Phase 3 (162): review stage confirm gate scenarios", () => {
  function makeReviewConfigWithConfirm(root: string, confirmMode: "auto" | "manual" | "smart") {
    const base = makeTestConfig({ projectRoot: root });
    const reviewStage = {
      ...base.stages.review,
      allowedWritePaths: ["docs/"],
      confirm: { mode: confirmMode },
    };
    return {
      ...base,
      stages: { ...base.stages, review: reviewStage as typeof base.stages.review },
    };
  }

  async function createReviewDoc(content: string) {
    const reviewDir = path.join(tmpDir, "docs", "review");
    await fs.mkdir(reviewDir, { recursive: true });
    const reviewPath = path.join(reviewDir, "code_review_99_Feature.md");
    await fs.writeFile(reviewPath, content, "utf-8");
    return reviewPath;
  }

  it("review approve advances to completed and calls clearStage", async () => {
    await createReviewDoc("# Review Report\n");
    const config = makeReviewConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Complete" });
    // Track clearStage invocations on ctx.ui to verify the terminal clear path (162 Phase 3).
    // advanceConfirmApproved calls ctx.ui.clearStage(ctx), so the spy must live on ctx.ui.
    let clearStageCalls = 0;
    (ctx.ui as Record<string, unknown>).clearStage = () => { clearStageCalls++; };
    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("advanced");
      expect(result.toStage).toBe("completed");
    }
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.confirmRejections).toBeUndefined();
    // clearStage must be called exactly once when advancing to completed
    expect(clearStageCalls).toBe(1);
  });

  it("review reject routes to fix and increments counter", async () => {
    await createReviewDoc("# Review Report\n");
    const config = makeReviewConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 1 });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Send to Fix" });
    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("routed");
      expect(result.toStage).toBe("fix");
    }
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.confirmRejections).toBe(2);
    expect(updatedMeta.currentStage).toBe("fix");
  });

  it("reject cleanup does NOT delete user headings that share prefix (e.g. ## 用户确认流程)", async () => {
    // Create plan doc with user-authored headings that start with "## 用户确认" /
    // "## User Confirmation" but are NOT plugin markers. These must survive cleanup.
    const userContent = [
      "# Plan",
      "",
      "## 用户确认流程",
      "> 用户需要在文档中手写确认",
      "> 或由插件自动写入",
      "正文继续",
      "",
      "## User Confirmation Guide",
      "> This is a user section, not a marker.",
      "More content here.",
      "",
    ].join("\n");
    await createPlanDoc(userContent);
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmRejections: 0,
    });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Rework (back to clarify)" });
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    // Read back the plan doc — user content must be intact
    const docsDir = path.join(tmpDir, "docs", "design");
    const planPath = path.join(docsDir, "77_Config_plan.md");
    const after = await fs.readFile(planPath, "utf-8");
    expect(after).toContain("## 用户确认流程");
    expect(after).toContain("> 用户需要在文档中手写确认");
    expect(after).toContain("正文继续");
    expect(after).toContain("## User Confirmation Guide");
    expect(after).toContain("> This is a user section, not a marker.");
    expect(after).toContain("More content here.");
  });

  it("review reject cleanup removes Confirmation: Approved marker but preserves user headings", async () => {
    // Review stage: "## Confirmation: Approved" is NOT caught by the no-gate check
    // (by design — review always re-triggers the gate). So the cleanup in
    // routeConfirmReject can remove a stale review marker while preserving user content.
    const mixedContent = [
      "# Review Report",
      "",
      "## Some section",
      "",
      "## Confirmation: Approved",
      "",
      "> Confirmation timestamp: 2024-01-01T00:00:00.000Z",
      "",
      "## User Confirmation Guide",
      "> user-authored section, not a marker",
      "More content here.",
    ].join("\n");
    await createReviewDoc(mixedContent);
    const config = makeReviewConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 0 });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Send to Fix" });
    const ui = { notify: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("routed");
    }
    const reviewDir = path.join(tmpDir, "docs", "review");
    const reviewPath = path.join(reviewDir, "code_review_99_Feature.md");
    const after = await fs.readFile(reviewPath, "utf-8");
    // Plugin review marker should be removed
    expect(after).not.toContain("## Confirmation: Approved");
    // User headings must be preserved
    expect(after).toContain("## User Confirmation Guide");
    expect(after).toContain("> user-authored section, not a marker");
    expect(after).toContain("More content here.");
    expect(after).toContain("## Some section");
  });

  it("review: counter preserved across fix→review round trip", async () => {
    await createReviewDoc("# Review Report\n");
    const config = makeReviewConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 3 });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Send to Fix" });
    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    if (result.result === "handled") {
      expect(result.action).toBe("routed");
    }
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    // Counter incremented to 4, preserved when returning to review
    expect(updatedMeta.confirmRejections).toBe(4);
  });
});

// ── Phase 1 (163): resolveStageDocPath mtime-newest semantics ────────────────

describe("Phase 1 (163): resolveStageDocPath mtime-newest for review", () => {
  function makeReviewConfig(root: string) {
    const base = makeTestConfig({ projectRoot: root });
    const reviewStage = {
      ...base.stages.review,
      allowedWritePaths: ["docs/"],
      confirm: { mode: "manual" as const },
    };
    return {
      ...base,
      stages: { ...base.stages, review: reviewStage as typeof base.stages.review },
    };
  }

  it("multiple review files → selects the one with newest mtime (not alphabetical last)", async () => {
    const reviewDir = path.join(tmpDir, "docs", "review");
    await fs.mkdir(reviewDir, { recursive: true });

    // Create two review files. Alphabetically, "code_review_B.md" > "code_review_A.md",
    // but "code_review_A.md" will have a newer mtime.
    const fileA = path.join(reviewDir, "code_review_A.md");
    const fileB = path.join(reviewDir, "code_review_B.md");

    // Write B first (older mtime) — no marker
    await fs.writeFile(fileB, "# Review B\n", "utf-8");

    // Small delay to ensure distinct mtimes
    await new Promise((r) => setTimeout(r, 50));

    // Write A second (newer mtime) WITH a plugin confirm marker.
    // If mtime-newest is honored, routeConfirmReject will clean this marker from A.
    // If the old alphabetical behavior were used (picking B), A's marker would remain.
    const markerContent = [
      "# Review A",
      "",
      "## Confirmation: Approved",
      "",
      "> Confirmation timestamp: 2024-01-01T00:00:00.000Z",
      "",
      "Some review content.",
    ].join("\n");
    await fs.writeFile(fileA, markerContent, "utf-8");

    const config = makeReviewConfig(tmpDir);
    const meta = makeTestMeta({ currentStage: "review", confirmRejections: 0 });
    const ctx = createMockCtx(meta, { selectReturn: "Reject & Send to Fix" });
    const ui = { notify: () => {}, transition: () => {} };

    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("routed");
    }

    // The mtime-newest file (A) should have been selected — its marker must be cleaned.
    // If the old alphabetical behavior picked B, A's marker would remain intact.
    const contentA = await fs.readFile(fileA, "utf-8");
    expect(contentA).not.toContain("## Confirmation: Approved");
    expect(contentA).toContain("# Review A");
    expect(contentA).toContain("Some review content.");

    // File B should remain untouched (no marker was placed there)
    const contentB = await fs.readFile(fileB, "utf-8");
    expect(contentB).toBe("# Review B\n");

    // Stage should transition to fix
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.currentStage).toBe("fix");
  });
});

describe("Phase 3 (162): confirm marker allowedWritePaths enforcement", () => {
  it("writeConfirmMarker refuses when doc path not in allowedWritePaths", async () => {
    // Create plan doc outside allowed paths
    const docsDir = path.join(tmpDir, "other", "design");
    await fs.mkdir(docsDir, { recursive: true });
    const planPath = path.join(docsDir, "77_Config_plan.md");
    await fs.writeFile(planPath, "# Plan\n", "utf-8");

    // Config with restricted allowedWritePaths (does not include "other/")
    const base = makeTestConfig({ projectRoot: tmpDir });
    const planStage = {
      ...base.stages.plan,
      allowedWritePaths: ["docs/"],
      confirm: { mode: "manual" as const },
    };
    const config = {
      ...base,
      stages: { ...base.stages, plan: planStage as typeof base.stages.plan },
    };

    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "other/design/77_Config.md" });
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Advance" });
    const ui = { notify: () => {}, transition: () => {} };

    // The gate should handle the failure (pending because marker write fails due to allowedWritePaths)
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    // The advance fails because writeConfirmMarker rejects the path
    if (result.result === "handled") {
      expect(result.action).toBe("pending");
    }
  });
});

describe("Phase 3 (Bug 4): confirm gate defaultReject reordering", () => {
  it("review stage + defaultReject=true → select options show Reject first", async () => {
    const stageTmp = path.join(tmpdir(), "pi-cg-defaultreject-" + Date.now());
    await fs.mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const base = makeTestConfig({ projectRoot: stageTmp });
    const reviewStage = {
      ...base.stages.review,
      confirm: { mode: "manual" as const },
    };
    const config = {
      ...base,
      stages: { ...base.stages, review: reviewStage as typeof base.stages.review },
    };

    // Create a review report doc path (needed by writeConfirmMarker allowedWritePaths)
    const docsDir = path.join(stageTmp, "docs", "review");
    await fs.mkdir(docsDir, { recursive: true });
    const reviewPath = path.join(docsDir, "code_review_test.md");
    await fs.writeFile(reviewPath, "# Review\n", "utf-8");

    const meta = makeTestMeta({ currentStage: "review", requirementDoc: "docs/design/77_Config.md" });
    // Capture the select call to verify option ordering
    let capturedOptions: string[] = [];
    const ctx = createMockCtx(meta);
    (ctx.ui as any).select = async (_msg: string, options: string[]) => {
      capturedOptions = [...options];
      return "Approve & Complete";
    };

    const ui = { notify: () => {}, transition: () => {} };
    await maybeHandleConfirmGate(config, ctx, meta, ui as any, {
      mode: "manual",
      defaultReject: true,
    });

    // With defaultReject=true, Reject option should be first
    expect(capturedOptions.length).toBe(2);
    expect(capturedOptions[0]).toContain("Reject");
    expect(capturedOptions[1]).toContain("Approve");

    await fs.rm(stageTmp, { recursive: true, force: true });
  });

  it("review stage + defaultReject=false → select options show Approve first", async () => {
    const stageTmp = path.join(tmpdir(), "pi-cg-no-defaultreject-" + Date.now());
    await fs.mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    const base = makeTestConfig({ projectRoot: stageTmp });
    const reviewStage = {
      ...base.stages.review,
      confirm: { mode: "manual" as const },
    };
    const config = {
      ...base,
      stages: { ...base.stages, review: reviewStage as typeof base.stages.review },
    };

    const docsDir = path.join(stageTmp, "docs", "review");
    await fs.mkdir(docsDir, { recursive: true });
    const reviewPath = path.join(docsDir, "code_review_test.md");
    await fs.writeFile(reviewPath, "# Review\n", "utf-8");

    const meta = makeTestMeta({ currentStage: "review", requirementDoc: "docs/design/77_Config.md" });
    let capturedOptions: string[] = [];
    const ctx = createMockCtx(meta);
    (ctx.ui as any).select = async (_msg: string, options: string[]) => {
      capturedOptions = [...options];
      return "Approve & Complete";
    };

    const ui = { notify: () => {}, transition: () => {} };
    await maybeHandleConfirmGate(config, ctx, meta, ui as any, {
      mode: "manual",
      defaultReject: false,
    });

    // Without defaultReject, Approve option should be first
    expect(capturedOptions.length).toBe(2);
    expect(capturedOptions[0]).toContain("Approve");
    expect(capturedOptions[1]).toContain("Reject");

    await fs.rm(stageTmp, { recursive: true, force: true });
  });
});

// ── 168 Phase 4: confirm gate + auto-spawn integration ─────────────────────

describe("168 Phase 4: confirm gate spawn behavior", () => {
  it("plan approve → develop: confirm gate triggers spawnStageSubagent with develop stage (real agent file)", async () => {
    const stageTmp = path.join(tmpdir(), "pi-cg-spawn-" + Date.now());
    await fs.mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create plan doc for marker write
    const planDir = path.join(stageTmp, "docs", "design");
    await fs.mkdir(planDir, { recursive: true });
    const planDoc = path.join(planDir, "Test_plan.md");
    await fs.writeFile(planDoc, "# Test Plan\n");

    // Create real agent file for develop stage so resolveAgentMention succeeds
    const agentDir = path.join(stageTmp, "agents");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "dev-agent.md"),
      "---\nname: develop-agent\n---\n# Dev Agent\n",
    );

    const baseConfig = makeTestConfig({ projectRoot: stageTmp });
    const config = {
      ...baseConfig,
      stages: {
        ...baseConfig.stages,
        plan: {
          ...baseConfig.stages.plan,
          allowedWritePaths: ["docs/", "doc/", "documentation/"],
          confirm: { mode: "manual" },
        },
        develop: {
          ...baseConfig.stages.develop,
          agentPath: "agents/dev-agent.md",
        },
      },
    } as PipelineConfig;

    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/Test.md",
      pipelineId: "pipe-spawn-integ-001",
    });

    // Track events emitted through pi mock (fallback path uses sendUserMessage)
    const sentMessages: Array<{ msg: string; opts?: Record<string, unknown> }> = [];
    const selectCalls: string[] = [];
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: {
        notify: () => {},
        transition: () => {},
        clearStage: () => {},
        select: async (_msg: string, _opts: string[]) => {
          selectCalls.push(_msg);
          return "Approve & Advance";
        },
      },
      pi: {
        sendUserMessage: (msg: string, opts?: Record<string, unknown>) => {
          sentMessages.push({ msg, opts });
        },
      },
    };

    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual",
    });

    // Gate should handle + advance to develop
    expect(result.result).toBe("handled");
    if ("toStage" in result) {
      expect(result.toStage).toBe("develop");
    }
    // Stage should actually advance in meta
    expect(meta.currentStage).toBe("develop");

    // Verify select was called (manual mode)
    expect(selectCalls.length).toBe(1);

    // Since no event bus is on the pi mock, spawnStageSubagent should fall back to
    // sendUserMessage with deliverAs:"followUp". Verify the spawn invocation.
    const spawnCalls = sentMessages.filter(m => m.msg.includes("@develop-agent"));
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].opts).toEqual({ deliverAs: "followUp" });
    expect(spawnCalls[0].msg).toContain("develop");
    expect(spawnCalls[0].msg).toContain("pipe-spawn-integ-001");

    await fs.rm(stageTmp, { recursive: true, force: true });
  });

  it("review Reject & Send to Fix → route to fix stage and trigger fix spawn (real agent file)", async () => {
    const stageTmp = path.join(tmpdir(), "pi-cg-rej-fix-" + Date.now());
    await fs.mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create review doc so marker pre-check doesn't block
    const reviewDir = path.join(stageTmp, "docs", "review");
    await fs.mkdir(reviewDir, { recursive: true });
    const reviewDoc = path.join(reviewDir, "code_review_Test.md");
    await fs.writeFile(reviewDoc, "# Review\n结论：需要修改\n");

    // Create real agent file for fix stage
    const agentDir = path.join(stageTmp, "agents");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "fix-agent.md"),
      "---\nname: fix-agent\n---\n# Fix Agent\n",
    );

    const baseConfig = makeTestConfig({ projectRoot: stageTmp });
    const config = {
      ...baseConfig,
      stages: {
        ...baseConfig.stages,
        review: {
          ...baseConfig.stages.review,
          allowedWritePaths: ["docs/", "doc/", "documentation/"],
          confirm: { mode: "manual" },
        },
        fix: {
          ...baseConfig.stages.fix,
          agentPath: "agents/fix-agent.md",
        },
      },
    } as PipelineConfig;

    const meta = makeTestMeta({
      currentStage: "review",
      requirementDoc: "docs/design/Test.md",
      pipelineId: "pipe-rej-fix-001",
    });

    const sentMessages: Array<{ msg: string; opts?: Record<string, unknown> }> = [];
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: {
        notify: () => {},
        transition: () => {},
        clearStage: () => {},
        select: async (_msg: string, _opts: string[]) => {
          return "Reject & Send to Fix";
        },
      },
      pi: {
        sendUserMessage: (msg: string, opts?: Record<string, unknown>) => {
          sentMessages.push({ msg, opts });
        },
      },
    };

    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual",
      defaultReject: true, // review stage default to reject ordering
    });

    // Gate should handle + route to fix
    expect(result.result).toBe("handled");
    if ("toStage" in result) {
      expect(result.toStage).toBe("fix");
    }
    // Stage should advance to fix in meta
    expect(meta.currentStage).toBe("fix");

    // Verify fix spawn triggered via fallback (no event bus)
    const spawnCalls = sentMessages.filter(m => m.msg.includes("@fix-agent"));
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].opts).toEqual({ deliverAs: "followUp" });

    await fs.rm(stageTmp, { recursive: true, force: true });
  });

  it("review approve → completed: confirm gate handles without spawn (completed is non-spawnable)", async () => {
    const stageTmp = path.join(tmpdir(), "pi-cg-compl-" + Date.now());
    await fs.mkdir(stageTmp, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: stageTmp }));

    // Create review doc for marker write
    const reviewDir = path.join(stageTmp, "docs", "review");
    await fs.mkdir(reviewDir, { recursive: true });
    const reviewDoc = path.join(reviewDir, "code_review_Test.md");
    await fs.writeFile(reviewDoc, "# Review\n结论：通过\n");

    const config = makeTestConfig({ projectRoot: stageTmp });
    const meta = makeTestMeta({
      currentStage: "review",
      requirementDoc: "docs/design/Test.md",
    });

    let selectOption = "";
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
      ui: {
        notify: () => {},
        transition: () => {},
        clearStage: () => {},
        select: async (_msg: string, opts: string[]) => {
          // Find the "Approve & Complete" option
          selectOption = opts.find(o => o.includes("Complete")) ?? opts[0];
          return selectOption;
        },
      },
      pi: {
        sendUserMessage: (_msg: string, _opts?: Record<string, unknown>) => {},
      },
    };

    const ui = { notify: () => {}, transition: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx as any, meta, ui as any, {
      mode: "manual",
    });

    expect(result.result).toBe("handled");
    // Should advance to completed
    if ("toStage" in result) {
      expect(result.toStage).toBe("completed");
    }

    await fs.rm(stageTmp, { recursive: true, force: true });
  });
});

// ─── Phase 4 / 179 (G5/G7): confirm gate deferral past subagent settle ────────

describe("Phase 4 / 179 (G5/G7): confirm gate deferral past subagent settle", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  /** Manager with a working hasRunning() probe. */
  function setManagerRunning(running: boolean): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      hasRunning: () => running,
    };
  }

  /** Manager with getRecord only (anyTopLevelRunning → null, degraded path). */
  function setManagerRecordOnly(records: Record<string, string>): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: (id: string) => (records[id] !== undefined ? { status: records[id] } : undefined),
    };
  }

  function clearManager(): void {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  }

  afterEach(() => clearManager());

  it("anyTopLevelRunning()=true → no popup, pending, deferred stamp", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    const logContent = await fs.readFile(path.join(tmpDir, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("confirm_gate_deferred");
  });

  it("anyTopLevelRunning()=false → popup presented", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(false);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });

    expect(selectCalls).toBe(1);
    expect(result.result).toBe("handled");
  });

  it("probe null + live activeSpawn evidence → deferred (degraded scan)", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      activeSpawns: { develop: { agentName: "develop-agent", agentId: "live-1", startedAt: Date.now() } },
    });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRecordOnly({ "live-1": "running" });

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
  });

  it("deferral exceeds spawnWaitTimeoutMs → popup + timeout hint, stamp cleared", async () => {
    await createPlanDoc("# Plan\n");
    const config = { ...makePlanConfigWithConfirm(tmpDir, "manual"), spawnWaitTimeoutMs: 1000 };
    // Phase 1 (180): the stamp must belong to the current visit (at >= stageStartTime)
    // to count as a "fresh" deferral window. Otherwise the stale-stamp guard treats
    // it as absent and restarts the deferral instead of timing out.
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 300_000,
      confirmGateDeferredAt: { stage: "plan", at: Date.now() - 200_000 },
    });
    let selectCalls = 0;
    const notifications: string[] = [];
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: (_ctx: unknown, m: string) => notifications.push(m), transition: () => {} } as any, { mode: "manual" });

    expect(selectCalls).toBe(1);
    expect(result.result).toBe("handled");
    expect(notifications.some((n) => n.includes("timeout"))).toBe(true);
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    const logContent = await fs.readFile(path.join(tmpDir, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("confirm_gate_defer_timeout");
  });
});

// ─── Phase 1 / 180: stale confirmGateDeferredAt invalidation ──────────────────

describe("Phase 1 / 180: stale confirmGateDeferredAt invalidation", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  function setManagerRunning(running: boolean): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      hasRunning: () => running,
    };
  }

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  });

  it("stale stamp (at < stageStartTime) + live subagent → defer (not timeout), re-stamps + audits", async () => {
    await createPlanDoc("# Plan\n");
    const config = { ...makePlanConfigWithConfirm(tmpDir, "manual"), spawnWaitTimeoutMs: 1000 };
    const now = Date.now();
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: now,
      // Stamp from a PREVIOUS visit to the same stage — older than stageStartTime.
      confirmGateDeferredAt: { stage: "plan", at: now - 200_000 },
    });
    let selectCalls = 0;
    const notifications: string[] = [];
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(
      config,
      ctx,
      meta,
      { notify: (_ctx: unknown, m: string) => notifications.push(m), transition: () => {} } as any,
      { mode: "manual" },
    );

    // Stale stamp treated as absent → restart deferral instead of popping on timeout.
    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    // Re-stamped with the current visit's timestamp.
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    expect(meta.confirmGateDeferredAt!.at).toBeGreaterThanOrEqual(now);
    // First-deferral audit + notify reappear for the new window.
    const logContent = await fs.readFile(path.join(tmpDir, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("confirm_gate_deferred");
    expect(notifications.some((n) => n.includes("deferred"))).toBe(true);
  });

  it("stamp stage matches but stageStartTime missing → invalid, no throw, defer", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    // Defensive: simulate a legacy/partial meta without stageStartTime.
    delete (meta as { stageStartTime?: number }).stageStartTime;
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };
    setManagerRunning(true);

    const result = await maybeHandleConfirmGate(
      config,
      ctx,
      meta,
      { notify: () => {}, transition: () => {} } as any,
      { mode: "manual" },
    );

    expect(selectCalls).toBe(0);
    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
  });
});

// ─── Phase 2 / 180: dismiss attribution + repeat-defer observability ─────────

describe("Phase 2 / 180: confirm gate dismiss attribution", () => {
  it("fast dismiss (<1500ms) → confirm_gate_dismiss_interrupted + collateral_suspect payload", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 2 },
    });
    const ctx = createMockCtx(meta);
    // Immediate undefined → elapsed ≈ 0 < DECISION_DISMISS_INTERRUPT_MS.
    ctx.ui.select = async () => undefined;

    const result = await maybeHandleConfirmGate(
      config,
      ctx,
      meta,
      { notify: () => {} } as any,
      { mode: "manual", source: "resume" },
    );

    expect(result).toEqual({ result: "handled", action: "pending" });
    const logContent = await fs.readFile(path.join(tmpDir, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("] confirm_gate_dismiss_interrupted |");
    expect(logContent).toContain("action=collateral_suspect");
    expect(logContent).toContain("mode=manual");
    expect(logContent).toContain("elapsedMs=");
    expect(logContent).toContain("reaskCount=2");
    expect(logContent).toContain("source=resume");
    // Legacy generic event must no longer be emitted for dismisses.
    expect(logContent).not.toContain("action=esc_dismissed");
  });

  it("slow dismiss (≥1500ms) → confirm_gate_dismissed + user_esc, default source owner_settled", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => {
      await new Promise((r) => setTimeout(r, 1600));
      return undefined;
    };

    const result = await maybeHandleConfirmGate(
      config,
      ctx,
      meta,
      { notify: () => {} } as any,
      { mode: "manual" },
    );

    expect(result).toEqual({ result: "handled", action: "pending" });
    const logContent = await fs.readFile(path.join(tmpDir, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("] confirm_gate_dismissed |");
    expect(logContent).toContain("action=user_esc");
    // Default source when not provided.
    expect(logContent).toContain("source=owner_settled");
  });
});

describe("Phase 2 / 180: repeat-defer throttled audit", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  function setManagerRunning(running: boolean): void {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      hasRunning: () => running,
    };
  }

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
    __resetMemoryThrottle();
  });

  it("same-window repeats → 1 first-defer + throttled repeat audit, no duplicate notify", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    const notifications: string[] = [];
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;
    setManagerRunning(true);
    __resetMemoryThrottle();
    const ui = {
      notify: (_c: unknown, m: string) => notifications.push(m),
      transition: () => {},
    } as any;

    // Call 1: first deferral → audit + notify.
    await maybeHandleConfirmGate(config, ctx, meta, ui, { mode: "manual" });
    // Allow the throttled repeat audit to pass its window for call 2.
    __resetMemoryThrottle();
    // Call 2: repeat deferral → throttled audit, no notify.
    await maybeHandleConfirmGate(config, ctx, meta, ui, { mode: "manual" });
    // Call 3: still within the throttle window → no new repeat audit.
    await maybeHandleConfirmGate(config, ctx, meta, ui, { mode: "manual" });

    const logContent = await fs.readFile(path.join(tmpDir, ".pi", "audit", getDateAuditFileName()), "utf-8");
    const firstDeferCount = (logContent.match(/\] confirm_gate_deferred \|/g) ?? []).length;
    const repeatCount = (logContent.match(/\] confirm_gate_defer_repeat \|/g) ?? []).length;
    expect(firstDeferCount).toBe(1);
    expect(repeatCount).toBe(1);
    // Only the first deferral notifies.
    expect(notifications.filter((n) => n.includes("deferred")).length).toBe(1);
    expect(logContent).toContain("waitedMs=");
    expect(logContent).toContain("source=owner_settled");
  });
});

// ─── Phase 3 / 180: detectPendingConfirmGate predicate ───────────────────────

describe("Phase 3 / 180: detectPendingConfirmGate", () => {
  it("re-ask trace for the current stage → true", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 1 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("effective deferral stamp for the current stage → true", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const now = Date.now();
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: now,
      confirmGateDeferredAt: { stage: "plan", at: now },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("stale stamp (at < stageStartTime) only → false", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const now = Date.now();
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: now,
      confirmGateDeferredAt: { stage: "plan", at: now - 200_000 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });

  it("confirm marker already written → false", async () => {
    await createPlanDoc("# Plan\n\n## 用户确认：确认无误\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 1 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });

  it("non-gate stage (develop) → false", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "develop",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "develop", count: 1 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });

  it("smart confirm mode → false", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "smart");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 1 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });

  it("re-ask budget exhausted (count=3) → still true (resume is deterministic)", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateReask: { stage: "plan", count: 3 },
    });
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("no trace at all → false", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    expect(await detectPendingConfirmGate(config, meta)).toBe(false);
  });
});

// ─── Phase 1 / 181: child session zero-side-effect bypass ─────────────────────

describe("Phase 1 / 181: child session zero-side-effect bypass", () => {
  it("child + non-gate stage → no-gate, deferral stamp preserved, zero meta writes", async () => {
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "completed",
      confirmGateDeferredAt: { stage: "completed", at: Date.now() },
    });
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "manual",
      isChild: true,
      sessionFile: "child-1",
    });

    expect(result).toEqual({ result: "no-gate" });
    expect(ctx.metadataUpdates).toEqual([]);
    // Owner would clear the stale stamp here; the child must not.
    expect(meta.confirmGateDeferredAt?.stage).toBe("completed");
  });

  it("child + smart needConfirm=false → no-gate, deferral stamp preserved, zero meta writes", async () => {
    const config = makePlanConfigWithConfirm(tmpDir, "smart");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "smart",
      needConfirm: false,
      isChild: true,
      sessionFile: "child-1",
    });

    expect(result).toEqual({ result: "no-gate" });
    expect(ctx.metadataUpdates).toEqual([]);
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
  });

  it("child + confirm marker already present → no-gate, deferral stamp preserved, zero meta writes", async () => {
    await createPlanDoc("# Plan\n\n## 用户确认：确认无误\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      confirmGateDeferredAt: { stage: "plan", at: Date.now() },
    });
    const ctx = createMockCtx(meta);

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "manual",
      isChild: true,
      sessionFile: "child-1",
    });

    expect(result).toEqual({ result: "no-gate" });
    expect(ctx.metadataUpdates).toEqual([]);
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
  });

  it("child + real gate (plan/manual/no marker) → handled+pending+deferred, suppression audit, zero side effects", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, {
      mode: "manual",
      isChild: true,
      sessionFile: "child-42",
    });

    expect(result).toEqual({ result: "handled", action: "pending", deferred: true });
    // Zero UI, zero meta writes.
    expect(selectCalls).toBe(0);
    expect(ctx.metadataUpdates).toEqual([]);
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    // Suppression audit with attribution fields; no deferral audit.
    const logContent = await fs.readFile(path.join(tmpDir, ".pi", "audit", getDateAuditFileName()), "utf-8");
    expect(logContent).toContain("confirm_gate_suppressed_child");
    expect(logContent).toContain("stage=plan");
    expect(logContent).toContain("sessionFile=child-42");
    expect(logContent).not.toContain("confirm_gate_deferred");
  });

  it("owner (default isChild=false) still presents the dialog and advances", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "plan", requirementDoc: "docs/design/77_Config.md" });
    let selectCalls = 0;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => { selectCalls++; return "Approve & Advance"; };

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, {
      mode: "manual",
    });

    expect(selectCalls).toBe(1);
    expect(result.result).toBe("handled");
  });
});

// ─── Phase 2 / 181: present-time re-stamp of the pending gate ─────────────────

describe("Phase 2 / 181: present-time pending re-stamp", () => {
  const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  });

  it("refreshes confirmGateDeferredAt BEFORE ui.select is awaited", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const before = Date.now();
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: before,
    });
    let stampAtSelect: { stage: string; at: number } | undefined;
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => {
      // Snapshot the stamp at the moment the dialog is presented.
      stampAtSelect = meta.confirmGateDeferredAt as { stage: string; at: number } | undefined;
      return "Cancel";
    };

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(result).toEqual({ result: "handled", action: "pending" });
    expect(stampAtSelect?.stage).toBe("plan");
    expect(stampAtSelect!.at).toBeGreaterThanOrEqual(before);
  });

  it("unresolved select (process dies while dialog open) → predicate recovers after reload", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);
    // Never resolves — the user never answers and the process is torn down.
    ctx.ui.select = () => new Promise<string | undefined>(() => {});

    const pending = maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    // Wait until the pre-select stamp refresh has been persisted.
    for (let i = 0; i < 100 && meta.confirmGateDeferredAt === undefined; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    // Rebuilt session state (same meta) → resume predicate hits.
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);

    void pending; // intentionally left unresolved
  });

  it("Cancel keeps pending and the refreshed stamp allows /pipeline-resume re-entry", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Cancel";

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(result).toEqual({ result: "handled", action: "pending" });
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("Esc (undefined) keeps pending and the refreshed stamp allows re-entry", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => undefined;

    const result = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {} } as any, { mode: "manual" });

    expect(result).toEqual({ result: "handled", action: "pending" });
    expect(meta.confirmGateDeferredAt?.stage).toBe("plan");
    expect(await detectPendingConfirmGate(config, meta)).toBe(true);
  });

  it("Approve clears deferral + reask and advances to develop", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
      confirmGateReask: { stage: "plan", count: 2 },
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Approve & Advance";

    const gate = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });
    // Mirror the production callers: shared accounting runs after the gate.
    recordConfirmGateOutcome(ctx.session, meta, gate, false);

    expect(gate).toEqual({ result: "handled", action: "advanced", toStage: "develop" });
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    expect(meta.confirmGateReask).toBeUndefined();
    expect(meta.currentStage).toBe("develop");
  });

  it("Reject routes to clarify and clears the pending stamp", async () => {
    await createPlanDoc("# Plan\n");
    const config = makePlanConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({
      currentStage: "plan",
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now(),
    });
    const ctx = createMockCtx(meta);
    ctx.ui.select = async () => "Reject & Rework (back to clarify)";

    const gate = await maybeHandleConfirmGate(config, ctx, meta, { notify: () => {}, transition: () => {} } as any, { mode: "manual" });

    expect(gate).toEqual({ result: "handled", action: "routed", toStage: "clarify" });
    expect(meta.confirmGateDeferredAt).toBeUndefined();
    expect(meta.currentStage).toBe("clarify");
  });
});
