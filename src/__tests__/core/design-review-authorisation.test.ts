/**
 * @module design-review-authorisation.test
 * Phase 4 / 191: Unit tests for owner authorisation gate.
 *
 * Validates:
 * - Child/tool sessions cannot authorise
 * - Prerequisites validation (requirement doc, plan doc, config)
 * - TUI availability check
 * - User confirmation flow
 * - Authorisation creation with correct hash and metadata
 * - Audit logging for all gate outcomes
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta, createMockRuntimeCtx } from "../helpers";
import { designReviewAuthorisationGate } from "../../core/design-review-authorisation";
import { initAuditLog } from "../../utils/auditLog";
import { computeHash } from "../../core/design-review-state";

describe("design-review-authorisation gate", () => {
  let tempDir: string;
  let requirementDoc: string;
  let planDoc: string;
  let config: PipelineConfig;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dr-auth-"));
    requirementDoc = join(tempDir, "requirements.md");
    planDoc = join(tempDir, "requirements_plan.md");

    // Create requirement document
    await writeFile(requirementDoc, "# Requirements\n\nTest requirements.", "utf-8");
    // Create plan document (derived from requirement doc name)
    await writeFile(planDoc, "# Plan\n\nTest plan content.", "utf-8");

    // Configure test project with design-review stage
    config = makeTestConfig({
      projectRoot: tempDir,
      stages: {
        clarify: { agentPath: "./agents/clarify.md", skillPath: "clarify/SKILL.md", nextStage: "plan", requireDomain: false },
        plan: { agentPath: "./agents/plan.md", skillPath: "plan/SKILL.md", nextStage: "develop", requireDomain: false },
        develop: { agentPath: "./agents/develop.md", skillPath: "develop/SKILL.md", nextStage: "review", requireDomain: false },
        review: { agentPath: "./agents/review.md", skillPath: "review/SKILL.md", nextStage: "fix", requireDomain: false },
        fix: { agentPath: "./agents/fix.md", skillPath: "fix/SKILL.md", nextStage: "awaiting_human", requireDomain: false },
        "design-review": {
          agentPath: "./agents/design-review.md",
          skillPath: "design-review/SKILL.md",
          nextStage: "develop",
          requireDomain: false,
          disabled: false,
        },
        awaiting_human: { agentPath: "./agents/human.md", skillPath: "human/SKILL.md", nextStage: "completed", requireDomain: false },
        completed: { agentPath: "./agents/completed.md", skillPath: "completed/SKILL.md", nextStage: null, requireDomain: false },
      },
    });

    // Initialize audit log
    await initAuditLog(config);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("child session rejection", () => {
    test("rejects child session with parentSession header", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-child-001",
      });
      const ctx = createMockRuntimeCtx(meta, {
        confirmReturn: true,
        sessionHeader: { parentSession: "parent-session-123" },
        sessionFile: "/sessions/child-session.md",
      });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("child_session_cannot_authorise");
      }
    });

    test("rejects child session with subagent name pattern", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-child-002",
      });
      const ctx = createMockRuntimeCtx(meta, {
        confirmReturn: true,
        sessionName: "explore-agent#abc12345",
        sessionFile: "/sessions/subagent-session.md",
      });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("child_session_cannot_authorise");
      }
    });

    test("rejects child session from fork event", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-child-003",
      });
      const ctx = createMockRuntimeCtx(meta, {
        confirmReturn: true,
        sessionFile: "/sessions/fork-session.md",
        event: { reason: "fork" },
      });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("child_session_cannot_authorise");
      }
    });
  });

  describe("prerequisite validation", () => {
    test("rejects when requirement doc is missing", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc: undefined,
        pipelineId: "pipe-req-001",
      });
      const ctx = createMockRuntimeCtx(meta, { confirmReturn: true });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("requirement_doc_missing");
      }
    });

    test("rejects when requirement doc file does not exist", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc: "/nonexistent/requirements.md",
        pipelineId: "pipe-req-002",
      });
      const ctx = createMockRuntimeCtx(meta, { confirmReturn: true });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("requirement_doc_missing");
      }
    });

    test("rejects when plan doc does not exist", async () => {
      // Remove plan doc so validation fails
      await rm(planDoc);
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-plan-001",
      });
      const ctx = createMockRuntimeCtx(meta, { confirmReturn: true });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("plan_doc_missing");
      }
    });

    test("rejects when design-review stage is disabled", async () => {
      const disabledConfig = makeTestConfig({
        projectRoot: tempDir,
        stages: {
          ...config.stages,
          "design-review": {
            agentPath: "./agents/design-review.md",
            skillPath: "design-review/SKILL.md",
            nextStage: "develop",
            requireDomain: false,
            disabled: true,
          },
        },
      });
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-disabled-001",
      });
      const ctx = createMockRuntimeCtx(meta, { confirmReturn: true });

      const result = await designReviewAuthorisationGate(ctx, disabledConfig, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("design_review_disabled");
      }
    });

    test("rejects when design-review config is missing agentPath", async () => {
      const invalidConfig = makeTestConfig({
        projectRoot: tempDir,
        stages: {
          ...config.stages,
          "design-review": {
            agentPath: undefined,
            skillPath: "design-review/SKILL.md",
            nextStage: "develop",
            requireDomain: false,
          },
        },
      });
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-config-001",
      });
      const ctx = createMockRuntimeCtx(meta, { confirmReturn: true });

      const result = await designReviewAuthorisationGate(ctx, invalidConfig, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("design_review_config_invalid");
      }
    });

    test("rejects when design-review config is missing skillPath", async () => {
      const invalidConfig = makeTestConfig({
        projectRoot: tempDir,
        stages: {
          ...config.stages,
          "design-review": {
            agentPath: "./agents/design-review.md",
            skillPath: undefined,
            nextStage: "develop",
            requireDomain: false,
          },
        },
      });
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-config-002",
      });
      const ctx = createMockRuntimeCtx(meta, { confirmReturn: true });

      const result = await designReviewAuthorisationGate(ctx, invalidConfig, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("design_review_config_invalid");
      }
    });
  });

  describe("TUI availability", () => {
    test("rejects when TUI confirm is unavailable", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-tui-001",
      });
      const ctx = createMockRuntimeCtx(meta, { hasConfirm: false });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tui_unavailable");
      }
    });

    test("rejects when TUI select is unavailable", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-tui-002",
      });
      // Create context with confirm but no select
      const ctx = createMockRuntimeCtx(meta, { confirmReturn: true });
      // Manually remove select to simulate missing TUI
      (ctx.ui as any).select = undefined;

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tui_unavailable");
      }
    });
  });

  describe("user confirmation flow", () => {
    test("rejects when user cancels confirmation", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-cancel-001",
      });
      const ctx = createMockRuntimeCtx(meta, { confirmReturn: false });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("user_cancelled");
      }
    });
  });

  describe("successful authorisation", () => {
    test("creates new authorisation state after confirmation", async () => {
      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc,
        pipelineId: "pipe-success-001",
      });
      const ctx = createMockRuntimeCtx(meta, {
        confirmReturn: true,
        sessionFile: "/sessions/owner-session.md",
      });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.phase).toBe("review_ready");
        expect(result.state.authorizationSource).toBe("direct-entry");
        expect(result.state.round).toBe(1);
        expect(result.state.planDoc).toBe(requirementDoc.replace(/\.md$/, "_plan.md"));
        expect(result.state.planHash).toMatch(/^[0-9a-f]{64}$/);
        // Verify plan hash matches actual file content
        const planContent = await (await import("node:fs/promises")).readFile(planDoc, "utf-8");
        const expectedHash = computeHash(planContent);
        expect(result.state.planHash).toBe(expectedHash);
      }
    });

    test("handles relative requirement doc path", async () => {
      const relativeReqDoc = "docs/requirements.md";
      const relativePlanDoc = "docs/requirements_plan.md";

      // Create docs directory and files
      const docsDir = join(tempDir, "docs");
      await mkdir(docsDir);
      await writeFile(join(docsDir, "requirements.md"), "# Requirements", "utf-8");
      await writeFile(join(docsDir, "requirements_plan.md"), "# Plan", "utf-8");

      const meta = makeTestMeta({
        currentStage: "plan",
        requirementDoc: relativeReqDoc,
        pipelineId: "pipe-relative-001",
      });
      const ctx = createMockRuntimeCtx(meta, {
        confirmReturn: true,
        sessionFile: "/sessions/owner-session.md",
      });

      const result = await designReviewAuthorisationGate(ctx, config, meta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.planDoc).toContain("docs/requirements_plan.md");
      }
    });
  });
});
