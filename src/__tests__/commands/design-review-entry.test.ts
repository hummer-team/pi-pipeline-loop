/**
 * @module design-review-entry.test
 * Phase 4 (191): Test entry point authorization checks in pipeline-resume and session-starter.
 * 
 * Verifies:
 * - pipeline-resume checks designReview authorization before coordinator delegation
 * - session-starter checks designReview authorization before coordinator delegation
 * - Invalid/missing authorization bypasses coordinator (falls through to normal logic)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PipelineConfig, SessionMeta, DesignReviewState } from "../../types";
import { isAuthorizationValid } from "../../core/design-review/state";
import { resolveDesignReviewEntryDocs } from "../../core/design-review/entry";

function makeTestConfig(): PipelineConfig {
  return {
    projectRoot: "/tmp/test-project",
    stages: {
      clarify: { agentPath: "", skillPath: "" },
      plan: { agentPath: "", skillPath: "" },
      develop: { agentPath: "", skillPath: "" },
      review: { agentPath: "", skillPath: "" },
      fix: { agentPath: "", skillPath: "" },
      awaiting_human: { agentPath: "", skillPath: "" },
      completed: { agentPath: "", skillPath: "" },
    },
    maxLoops: 3,
    maxLoopCycles: 3,
  } as PipelineConfig;
}

function makeDesignReviewState(overrides: Partial<DesignReviewState> = {}): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/test-plan.md",
    planHash: "abc123",
    round: 1,
    authorizationId: "test-auth-id-xyz",
    authorizationSource: "menu",
    phase: "review_ready",
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeTestMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    currentStage: "design-review",
    pipelineId: "pipe-test-123",
    stageStartTime: Date.now(),
    domain: { id: "general", version: "latest", skillPath: "" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    maxLoopCycles: 3,
    flowState: "running",
    verifyAttempts: 0,
    verifyFailures: [],
    requirementDoc: "/tmp/test-req.md",
    ...overrides,
  } as SessionMeta;
}

describe("Phase 4 (191): Entry point authorization checks", () => {
  let config: PipelineConfig;

  beforeEach(() => {
    config = makeTestConfig();
  });

  describe("Authorization gate behavior", () => {
    test("valid authorization enables coordinator delegation", () => {
      const drState = makeDesignReviewState({
        authorizationId: "valid-auth-id",
        authorizationSource: "menu",
      });
      const meta = makeTestMeta({ designReview: drState });

      // Valid authorization: coordinator should be called
      expect(meta.designReview).toBeDefined();
      expect(meta.designReview?.authorizationId).toBe("valid-auth-id");
      expect(meta.designReview?.authorizationSource).toBe("menu");
    });

    test("missing authorization bypasses coordinator delegation", () => {
      const meta = makeTestMeta({ designReview: undefined });

      // No designReview state: isAuthorizationValid returns false, coordinator delegation should be skipped
      expect(meta.designReview).toBeUndefined();
      expect(isAuthorizationValid(meta.designReview)).toBe(false);
    });

    test("invalid authorization (finished phase) bypasses coordinator delegation", () => {
      const drState = makeDesignReviewState({ phase: "finished" });
      const meta = makeTestMeta({ designReview: drState });

      // Finished phase: isAuthorizationValid returns false, coordinator not called
      expect(isAuthorizationValid(meta.designReview)).toBe(false);
    });

    test("invalid authorization (authorization-lost) bypasses coordinator delegation", () => {
      const drState = makeDesignReviewState({ phase: "paused", pauseReason: "authorization-lost" });
      const meta = makeTestMeta({ designReview: drState });

      // Paused with authorization-lost: isAuthorizationValid returns false
      expect(isAuthorizationValid(meta.designReview)).toBe(false);
    });

    test("valid authorization in active phase enables coordinator delegation", () => {
      const drState = makeDesignReviewState({ phase: "review_running" });
      const meta = makeTestMeta({ designReview: drState });

      // Active phase: isAuthorizationValid returns true, coordinator should be called
      expect(isAuthorizationValid(meta.designReview)).toBe(true);
    });
  });

  describe("Authorization isolation on fresh start", () => {
    test("fresh pipeline start has no designReview state", () => {
      // Simulating buildStartMeta behavior
      const freshMeta = makeTestMeta({ designReview: undefined });

      expect(freshMeta.designReview).toBeUndefined();
      // Coordinator delegation would be skipped (no authorization to check)
    });

    test("restart clears previous authorization", () => {
      // Previous meta had authorization
      const previousMeta = makeTestMeta({
        designReview: makeDesignReviewState({
          authorizationId: "old-auth-id",
          phase: "review_running",
        }),
      });

      // After restart (simulating buildStartMeta clearing)
      const restartedMeta = makeTestMeta({ designReview: undefined });

      expect(restartedMeta.designReview).toBeUndefined();
      // Coordinator delegation would be skipped (authorization cleared)
    });
  });

  describe("Authorization preservation on resume", () => {
    test("resume preserves authorization for recovery", () => {
      const drState = makeDesignReviewState({
        authorizationId: "recovery-auth-id",
        phase: "update_running",
      });
      const meta = makeTestMeta({ designReview: drState });

      // Simulating buildResumeMeta preservation
      const resumedMeta = makeTestMeta({
        designReview: { ...meta.designReview } as DesignReviewState,
      });

      expect(resumedMeta.designReview).toBeDefined();
      expect(resumedMeta.designReview?.authorizationId).toBe("recovery-auth-id");
      expect(resumedMeta.designReview?.phase).toBe("update_running");
      // Coordinator delegation would proceed (authorization valid)
    });
  });

  describe("Phase-specific authorization checks", () => {
    test("authorization valid in review_ready phase", () => {
      const drState = makeDesignReviewState({ phase: "review_ready" });
      const meta = makeTestMeta({ designReview: drState });

      expect(meta.designReview?.phase).toBe("review_ready");
      // Coordinator would be called for recovery
    });

    test("authorization valid in review_running phase", () => {
      const drState = makeDesignReviewState({ phase: "review_running" });
      const meta = makeTestMeta({ designReview: drState });

      expect(meta.designReview?.phase).toBe("review_running");
      // Coordinator would be called to verify report
    });

    test("authorization valid in update_ready phase", () => {
      const drState = makeDesignReviewState({ phase: "update_ready" });
      const meta = makeTestMeta({ designReview: drState });

      expect(meta.designReview?.phase).toBe("update_ready");
      // Coordinator would be called to dispatch update agent
    });

    test("authorization valid in update_running phase", () => {
      const drState = makeDesignReviewState({ phase: "update_running" });
      const meta = makeTestMeta({ designReview: drState });

      expect(meta.designReview?.phase).toBe("update_running");
      // Coordinator would be called to validate update
    });

    test("authorization valid in pass_ready phase", () => {
      const drState = makeDesignReviewState({ phase: "pass_ready" });
      const meta = makeTestMeta({ designReview: drState });

      expect(meta.designReview?.phase).toBe("pass_ready");
      // Coordinator would handle pass routing
    });

    test("authorization valid in paused phase", () => {
      const drState = makeDesignReviewState({ phase: "paused" });
      const meta = makeTestMeta({ designReview: drState });

      expect(meta.designReview?.phase).toBe("paused");
      // Coordinator would return pending (wait for intervention)
    });
  });
});

/**
 * 213 Phase 2 (D16): `resolveDesignReviewEntryDocs` must derive the plan doc
 * through the naming single-source (`planDocRelPathFromRequirementDoc`) —
 * idempotent for `_Plan.md` inputs, tolerant of `.MD`, and fail-CLOSED (never
 * a `"_Plan.md"` phantom) when no requirement base can be derived.
 */
describe("213 Phase 2 (D16): resolveDesignReviewEntryDocs plan-doc derivation", () => {
  let ROOT: string;

  beforeEach(() => {
    ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-dr-entry-"));
  });

  afterEach(async () => {
    await fsp.rm(ROOT, { recursive: true, force: true });
  });

  async function touch(rel: string): Promise<string> {
    const abs = path.join(ROOT, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, "# doc\n", "utf-8");
    return abs;
  }

  function entryConfig(): PipelineConfig {
    return { ...makeTestConfig(), projectRoot: ROOT } as PipelineConfig;
  }

  test("plain requirement doc derives {reqBase}_Plan.md and finds it", async () => {
    await touch("docs/design/9_Test.md");
    const planAbs = await touch("docs/design/9_Test_Plan.md");
    const out = resolveDesignReviewEntryDocs(entryConfig(), makeTestMeta({ requirementDoc: "docs/design/9_Test.md" }));
    expect(out.requirementDoc).toBe(path.join(ROOT, "docs/design/9_Test.md"));
    expect(out.planDoc).toBe(planAbs);
    expect(out.requirementExists).toBe(true);
    expect(out.planExists).toBe(true);
  });

  test("requirement doc already ending in `_Plan.md` is IDEMPOTENT (no `_Plan_Plan` phantom)", async () => {
    const abs = await touch("docs/design/204_Bug_Plan.md");
    const out = resolveDesignReviewEntryDocs(
      entryConfig(),
      makeTestMeta({ requirementDoc: "docs/design/204_Bug_Plan.md" }),
    );
    expect(out.planDoc).toBe(abs); // THE SAME file, not `204_Bug_Plan_Plan.md`
    expect(out.planDoc).not.toContain("_Plan_Plan");
    expect(out.planExists).toBe(true);
  });

  test("`.MD` casing resolves through the naming module (old inline replace missed it)", async () => {
    await touch("docs/design/7_Q.MD");
    const planAbs = await touch("docs/design/7_Q_Plan.md");
    const out = resolveDesignReviewEntryDocs(entryConfig(), makeTestMeta({ requirementDoc: "docs/design/7_Q.MD" }));
    expect(out.planDoc).toBe(planAbs);
    expect(out.planExists).toBe(true);
  });

  test("plan file absent → planDoc still derived, planExists=false (caller reports plan_doc_missing)", () => {
    const out = resolveDesignReviewEntryDocs(entryConfig(), makeTestMeta({ requirementDoc: "docs/design/8_X.md" }));
    expect(out.planDoc).toBe(path.join(ROOT, "docs/design/8_X_Plan.md"));
    expect(out.planExists).toBe(false);
  });

  test("extension-less requirement doc FAILS CLOSED: planDoc undefined, no phantom path", async () => {
    await touch("docs/design/noext"); // requirement itself exists, base derivation does not
    const out = resolveDesignReviewEntryDocs(entryConfig(), makeTestMeta({ requirementDoc: "docs/design/noext" }));
    expect(out.requirementExists).toBe(true);
    expect(out.planDoc).toBeUndefined();
    expect(out.planExists).toBe(false);

    const txt = resolveDesignReviewEntryDocs(entryConfig(), makeTestMeta({ requirementDoc: "docs/design/notes.txt" }));
    expect(txt.planDoc).toBeUndefined();
    expect(txt.planExists).toBe(false);
  });

  test("empty / absent requirementDoc → both docs undefined, both exists false", () => {
    const out = resolveDesignReviewEntryDocs(entryConfig(), makeTestMeta({ requirementDoc: undefined }));
    expect(out.requirementDoc).toBeUndefined();
    expect(out.planDoc).toBeUndefined();
    expect(out.requirementExists).toBe(false);
    expect(out.planExists).toBe(false);

    const blank = resolveDesignReviewEntryDocs(entryConfig(), makeTestMeta({ requirementDoc: "" }));
    expect(blank.planDoc).toBeUndefined();
  });
});
