/**
 * @module design-review-confirm.test
 * Phase 3 / 191: Tests for design-review confirm-mode compatibility.
 * Validates that when designReview is absent/invalid, the coordinator
 * returns not-applicable and entry points fall through to original flow,
 * preserving existing approve/reject/cancel/auto/smart confirm gate behavior.
 * 
 * No mock.module() used — writeAuditLog is safe (returns early without auditDir).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta, ConfirmMode } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { computeHash, createInitialState } from "../../core/design-review-state";
import type { CoordinatorContext } from "../../core/design-review-coordinator";
import { coordinateDesignReview } from "../../core/design-review-coordinator";
import { initAuditLog } from "../../utils/auditLog";

// All trigger types supported by the coordinator
const TRIGGERS: Array<"settle" | "advance" | "verify" | "handoff"> = ["settle", "advance", "verify", "handoff"];

describe("design-review-coordinator confirm-mode compatibility", () => {
  let tempDir: string;
  let planDoc: string;
  let planHash: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dr-confirm-"));
    planDoc = join(tempDir, "plan.md");
    const planContent = "# Test Plan\n\nContent here.";
    await writeFile(planDoc, planContent, "utf-8");
    planHash = computeHash(planContent);
    
    // Initialize audit log to ensure writeAuditLog doesn't fail
    const config = makeTestConfig({ projectRoot: tempDir });
    await initAuditLog(config);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createMockSession(meta: SessionMeta) {
    let currentMeta = { ...meta };
    return {
      getMeta: () => currentMeta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        currentMeta = { ...currentMeta, ...patch };
        return currentMeta;
      },
    };
  }

  function createCoordinatorCtx(meta: SessionMeta): CoordinatorContext {
    return {
      config: makeTestConfig(),
      session: createMockSession(meta),
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
    };
  }

  describe("no design-review state (confirm gate fallthrough)", () => {
    for (const trigger of TRIGGERS) {
      test(`trigger "${trigger}" with no designReview → not-applicable`, async () => {
        const meta = makeTestMeta({ currentStage: "plan" });
        const ctx = createCoordinatorCtx(meta);

        const result = await coordinateDesignReview(ctx, meta, trigger);
        expect(result).toEqual({ status: "not-applicable" });
      });
    }

    test("meta with designReview=undefined → not-applicable for all stages", async () => {
      const stages = ["clarify", "plan", "design-review", "develop", "review", "fix", "completed"] as const;
      for (const stage of stages) {
        const meta = makeTestMeta({
          currentStage: stage,
          designReview: undefined,
        });
        const ctx = createCoordinatorCtx(meta);

        const result = await coordinateDesignReview(ctx, meta, "settle");
        expect(result).toEqual({ status: "not-applicable" });
      }
    });
  });

  describe("finished design-review → not-applicable", () => {
    test("finished phase returns not-applicable regardless of trigger", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "finished" },
      });
      const ctx = createCoordinatorCtx(meta);

      for (const trigger of TRIGGERS) {
        const result = await coordinateDesignReview(ctx, meta, trigger);
        expect(result).toEqual({ status: "not-applicable" });
      }
    });
  });

  describe("invalid authorization → not-applicable", () => {
    test("paused with authorization-lost returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: {
          ...drState,
          phase: "paused",
          pauseReason: "authorization-lost",
        },
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("undefined designReview returns not-applicable", async () => {
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: undefined,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });
  });

  describe("confirm mode independence", () => {
    const confirmModes: ConfirmMode[] = ["auto", "manual", "smart"];

    for (const mode of confirmModes) {
      test(`confirm mode "${mode}" with no designReview → not-applicable`, async () => {
        const config = makeTestConfig({
          stages: {
            ...makeTestConfig().stages,
            plan: {
              agentPath: "./agents/plan.md",
              skillPath: "plan/SKILL.md",
              nextStage: "develop",
              requireDomain: false,
              confirm: { mode },
            },
          },
        });

        const meta = makeTestMeta({ currentStage: "plan" });
        const ctx: CoordinatorContext = {
          config,
          session: createMockSession(meta),
          ui: { notify: () => {} },
          pi: { sendUserMessage: () => {} },
        };

        const result = await coordinateDesignReview(ctx, meta, "settle");
        expect(result).toEqual({ status: "not-applicable" });
      });
    }
  });

  describe("entry point fallthrough semantics", () => {
    test("not-applicable allows entry points to use original flow", async () => {
      // Simulate: meta has no designReview, all triggers should return not-applicable
      const meta = makeTestMeta({
        currentStage: "plan",
        summaries: {
          plan: { path: "/tmp/plan-summary.md", hash: "abc", status: "valid" },
        },
      });
      const ctx = createCoordinatorCtx(meta);

      // All four entry points should return not-applicable
      // allowing the original stage_advance/pipeline_verify/pipeline_handoff logic to proceed
      const settleResult = await coordinateDesignReview(ctx, meta, "settle");
      const advanceResult = await coordinateDesignReview(ctx, meta, "advance");
      const verifyResult = await coordinateDesignReview(ctx, meta, "verify");
      const handoffResult = await coordinateDesignReview(ctx, meta, "handoff");

      expect(settleResult.status).toBe("not-applicable");
      expect(advanceResult.status).toBe("not-applicable");
      expect(verifyResult.status).toBe("not-applicable");
      expect(handoffResult.status).toBe("not-applicable");
    });

    test("designReview present but authorization-lost does not block original flow", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "plan",
        designReview: {
          ...drState,
          phase: "paused",
          pauseReason: "authorization-lost",
        },
      });
      const ctx = createCoordinatorCtx(meta);

      // All triggers should return not-applicable, allowing original flow
      for (const trigger of TRIGGERS) {
        const result = await coordinateDesignReview(ctx, meta, trigger);
        expect(result.status).toBe("not-applicable");
      }
    });
  });

  describe("backward compatibility with existing stages", () => {
    test("review stage without designReview → not-applicable", async () => {
      const meta = makeTestMeta({
        currentStage: "review",
        previousStage: "develop",
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("develop stage without designReview → not-applicable", async () => {
      const meta = makeTestMeta({
        currentStage: "develop",
        previousStage: "plan",
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("fix stage without designReview → not-applicable", async () => {
      const meta = makeTestMeta({
        currentStage: "fix",
        previousStage: "review",
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("completed stage without designReview → not-applicable", async () => {
      const meta = makeTestMeta({
        currentStage: "completed",
        previousStage: "review",
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });
  });
});
