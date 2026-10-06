/**
 * Unit tests for design-review-authorisation module
 * Tests the authorization gate for direct entry to design-review stage
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { designReviewAuthorisationGate } from "../../core/design-review/authorization";
import type { RuntimeCtx } from "../../core/runtime-ctx";
import type { PipelineConfig, SessionMeta } from "../../types";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("designReviewAuthorisationGate", () => {
  let tempDir: string;
  let projectRoot: string;
  let requirementDoc: string;
  let planDoc: string;
  let mockCtx: RuntimeCtx;
  let mockConfig: PipelineConfig;
  let mockMeta: SessionMeta;

  beforeEach(async () => {
    // Create temporary directory for test files
    tempDir = await mkdtemp(join(tmpdir(), "design-review-auth-test-"));
    projectRoot = tempDir;

    // Create requirement document
    requirementDoc = join(projectRoot, "requirements.md");
    await writeFile(requirementDoc, "# Requirements\n\nTest requirements");

    // Create plan document (derived from requirement doc)
    planDoc = join(projectRoot, "requirements_plan.md");
    await writeFile(planDoc, "# Plan\n\nTest plan content");

    // Mock RuntimeCtx
    mockCtx = {
      session: {
        getMeta: () => mockMeta,
        updateMeta: () => {},
        getBranch: () => [],
        getEntries: () => [],
        getHeader: () => ({}),
        getSessionName: () => "owner-session",
      },
      ui: {
        confirm: async (title: string, message: string) => true,
        select: async (title: string, options: string[]) => options[0],
      },
      _ctx: {
        sessionManager: {
          getBranch: () => [],
          getEntries: () => [],
          getHeader: () => ({}),
          getSessionName: () => "owner-session",
        },
      },
    } as any;

    // Mock PipelineConfig
    mockConfig = {
      projectRoot,
      stages: {
        "design-review": {
          agentPath: "./agents/design-review-agent.md",
          skillPath: "./skills/design-review/SKILL.md",
          nextStage: "develop",
        },
      },
    } as any;

    // Mock SessionMeta
    mockMeta = {
      requirementDoc: "requirements.md",
      pipelineId: "test-pipeline-123",
    } as any;
  });

  afterEach(async () => {
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("prerequisite validation", () => {
    it("should reject child sessions", async () => {
      // Mock child session (detected by presence of parentSession field)
      mockCtx._ctx.sessionManager.getHeader = () => ({
        type: "session" as const,
        id: "session-123",
        timestamp: new Date().toISOString(),
        cwd: "/tmp/test",
        parentSession: "parent-123",
      });

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("child_session_cannot_authorise");
      }
    });

    it("should reject when requirement doc is missing", async () => {
      mockMeta.requirementDoc = undefined;

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("requirement_doc_missing");
      }
    });

    it("should reject when requirement doc file does not exist", async () => {
      mockMeta.requirementDoc = "nonexistent.md";

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("requirement_doc_missing");
      }
    });

    it("should reject when plan doc is missing", async () => {
      // Remove plan doc
      await rm(planDoc);

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("plan_doc_missing");
      }
    });

    it("should reject when design-review stage is disabled", async () => {
      mockConfig.stages["design-review"].disabled = true;

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("design_review_disabled");
      }
    });

    it("should reject when design-review config is invalid (missing agentPath)", async () => {
      mockConfig.stages["design-review"].agentPath = undefined;

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("design_review_config_invalid");
      }
    });

    it("should reject when design-review config is invalid (missing skillPath)", async () => {
      // Intentionally set to undefined to test error handling for invalid config
      (mockConfig.stages["design-review"] as any).skillPath = undefined;

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("design_review_config_invalid");
      }
    });
  });

  describe("TUI availability", () => {
    it("should reject when TUI is unavailable (no confirm)", async () => {
      // Intentionally set to undefined to test error handling when TUI is unavailable
      (mockCtx.ui as any).confirm = undefined;

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tui_unavailable");
      }
    });

    it("should reject when TUI is unavailable (no select)", async () => {
      // Intentionally set to undefined to test error handling when TUI is unavailable
      (mockCtx.ui as any).select = undefined;

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("tui_unavailable");
      }
    });
  });

  describe("user confirmation flow", () => {
    it("should reject when user cancels confirmation", async () => {
      mockCtx.ui.confirm = async () => false;

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("user_cancelled");
      }
    });
  });

  describe("successful authorization", () => {
    it("should create new authorization state after confirmation", async () => {
      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state).toBeDefined();
        expect(result.state.planDoc).toContain("requirements_plan.md");
        expect(result.state.authorizationSource).toBe("direct-entry");
        expect(result.state.round).toBe(1);
        expect(result.state.planHash).toBeDefined();
        expect(result.state.planHash!.length).toBe(64); // SHA-256 hash length
      }
    });

    it("should handle absolute requirement doc path", async () => {
      mockMeta.requirementDoc = requirementDoc;

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.planDoc).toContain("requirements_plan.md");
      }
    });

    it("should handle relative requirement doc path", async () => {
      mockMeta.requirementDoc = "requirements.md";

      const result = await designReviewAuthorisationGate(mockCtx, mockConfig, mockMeta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.planDoc).toContain("requirements_plan.md");
      }
    });
  });
});
