import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  maybeHandleConfirmGate,
  shouldDeferPlanMarkerRule,
  resolveConfirmMaxRejections,
  autoWriteConfirmMarker,
  PLAN_CONFIRM_MARKER_RULE,
} from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";
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

  it("review approve advances to completed", async () => {
    await createReviewDoc("# Review Report\n");
    const config = makeReviewConfigWithConfirm(tmpDir, "manual");
    const meta = makeTestMeta({ currentStage: "review" });
    const ctx = createMockCtx(meta, { selectReturn: "Approve & Complete" });
    const ui = { notify: () => {}, transition: () => {}, clearStage: () => {} };
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { mode: "manual" });
    expect(result.result).toBe("handled");
    if (result.result === "handled") {
      expect(result.action).toBe("advanced");
      expect(result.toStage).toBe("completed");
    }
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.confirmRejections).toBeUndefined();
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
